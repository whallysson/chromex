// Browser launcher -- opens Chrome/Brave/Edge with remote debugging enabled
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import net from 'net';
import { fileURLToPath } from 'url';
import { sleep } from './utils.mjs';
import { getWsUrlFromPortFile } from './browser.mjs';
import { CDP } from './client.mjs';

const BROWSER_PATHS = {
  darwin: {
    chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    brave: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    chromium: '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'chrome-canary': '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    vivaldi: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
  },
  linux: {
    chrome: 'google-chrome',
    brave: 'brave-browser',
    edge: 'microsoft-edge',
    chromium: 'chromium-browser',
    vivaldi: 'vivaldi',
  },
};

const PROFILES_DIR = resolve(homedir(), '.chromex/profiles');
const PIPE_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR
  ? resolve(process.env.XDG_RUNTIME_DIR, 'chromex')
  : resolve(homedir(), '.chromex/run');
const PROFILE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export async function launchBrowser(options = {}) {
  if (options.webMcp && options.headless) throw new Error('WebMCP requires a visible supported Chrome build and cannot run in headless mode.');
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const paths = BROWSER_PATHS[platform];
  if (!paths) throw new Error(`Unsupported platform: ${process.platform}`);

  // Resolve browser executable
  let browserPath;
  const explicitBrowserPath = options.browserPath || process.env.CHROMEX_BROWSER_PATH;
  if (explicitBrowserPath) {
    browserPath = explicitBrowserPath;
    if ((platform === 'darwin' || browserPath.includes('/')) && !existsSync(browserPath)) {
      throw new Error(`Browser not found: ${browserPath}`);
    }
  } else if (options.browser) {
    browserPath = paths[options.browser.toLowerCase()];
    if (!browserPath) {
      throw new Error(`Unknown browser: ${options.browser}. Available: ${Object.keys(paths).join(', ')}`);
    }
    if (platform === 'darwin' && !existsSync(browserPath)) {
      throw new Error(`Browser not found: ${browserPath}`);
    }
  } else {
    // Auto-detect in preference order
    for (const path of Object.values(paths)) {
      if (platform === 'darwin' ? existsSync(path) : true) {
        browserPath = path;
        break;
      }
    }
    if (!browserPath) throw new Error('No supported browser found.');
  }

  const usePipe = !!options.pipe || !!options.extensionTools;
  const extraChromeArgs = options.chromeArgs
    ? Array.isArray(options.chromeArgs) ? options.chromeArgs : [options.chromeArgs]
    : [];
  const flags = [
    usePipe ? '--remote-debugging-pipe' : '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (options.headless) flags.push('--headless=new');
  if (options.incognito) flags.push('--incognito');
  if (options.proxy) flags.push(`--proxy-server=${options.proxy}`);
  if (options.insecure) flags.push('--ignore-certificate-errors');
  if (options.extensionTools) flags.push('--enable-unsafe-extension-debugging');

  let userDataDir;
  const customUserDataArg = extraChromeArgs.find(arg => arg.startsWith('--user-data-dir='));
  if (customUserDataArg) {
    userDataDir = customUserDataArg.slice('--user-data-dir='.length);
    flags.push(customUserDataArg);
  } else {
    const profileName = options.profile || (usePipe ? 'pipe' : 'default');
    if (!PROFILE_NAME_RE.test(profileName)) throw new Error('Profile name must be 1-64 chars: letters, numbers, dot, underscore, or dash.');
    userDataDir = resolve(PROFILES_DIR, profileName);
    flags.push(`--user-data-dir=${userDataDir}`);
  }
  mkdirSync(userDataDir, { recursive: true, mode: 0o700 });

  if (extraChromeArgs.length) {
    for (const arg of extraChromeArgs) {
      if (!arg || arg.startsWith('--user-data-dir=')) continue;
      if (usePipe && arg.startsWith('--remote-debugging-')) throw new Error('Custom remote debugging flags cannot be combined with pipe transport.');
      flags.push(arg);
    }
  }

  if (options.webMcp) {
    mergeEnabledFeature(flags, 'WebMCP');
    mergeEnabledFeature(flags, 'WebMCPTesting');
    mergeEnabledFeature(flags, 'DevToolsWebMCPSupport');
  }

  flags.push(options.url || 'about:blank');

  if (usePipe) return launchPipeBrowser(browserPath, flags, userDataDir, options, explicitBrowserPath);

  const child = spawn(browserPath, flags, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Wait for DevToolsActivePort to appear
  const maxWait = 10000;
  const start = Date.now();
  const portFile = resolve(userDataDir, 'DevToolsActivePort');
  while (Date.now() - start < maxWait) {
    try {
      const wsUrl = existsSync(portFile) ? getWsUrlFromPortFile(portFile) : null;
      if (wsUrl) {
        const lines = [`Browser launched (PID: ${child.pid})`];
        if (explicitBrowserPath) lines.push(`Browser path: ${browserPath}`);
        if (options.incognito) lines.push('Mode: incognito');
        lines.push(`Profile: ${options.profile || 'default'} (isolated)`);
        lines.push(`Remote debugging active`);
        return lines.join('\n');
      }
    } catch { /* waiting */ }
    await sleep(500);
  }

  return `Browser launched (PID: ${child.pid}) but DevToolsActivePort not found yet. Wait a moment and try "chromex list".`;
}

async function launchPipeBrowser(browserPath, flags, userDataDir, options, explicitBrowserPath) {
  mkdirSync(PIPE_RUNTIME_DIR, { recursive: true, mode: 0o700 });
  try { chmodSync(PIPE_RUNTIME_DIR, 0o700); } catch {}
  const profileHash = createHash('sha256').update(userDataDir).digest('hex').slice(0, 16);
  const socketPath = resolve(PIPE_RUNTIME_DIR, `pipe-${profileHash}.sock`);
  const markerPath = resolve(userDataDir, 'ChromexPipeActive.json');
  if (await activePipeMarker(markerPath)) {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    if (options.extensionTools && !marker.extensionTools) {
      throw new Error(`Browser pipe for profile ${options.profile || 'pipe'} is already active without extension tools. Use another profile or stop that browser before relaunching with --extension-tools.`);
    }
    if (options.webMcp && !marker.webMcp) {
      throw new Error(`Browser pipe for profile ${options.profile || 'pipe'} is already active without WebMCP. Use another profile or stop that browser before relaunching with --webmcp.`);
    }
    if (options.url) await openPipePage(marker.socketPath, options.url);
    return pipeLaunchText(marker, options, explicitBrowserPath, browserPath, true);
  }
  const brokerPath = fileURLToPath(new URL('./browser-pipe-broker.mjs', import.meta.url));
  const broker = spawn(process.execPath, [brokerPath], {
    detached: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  let brokerFailure = null;
  broker.once('error', error => { brokerFailure = error; });
  broker.once('exit', (code, signal) => {
    if (code && code !== 0) brokerFailure = new Error(`Pipe broker exited with code ${code}${signal ? ` (${signal})` : ''}.`);
  });
  broker.stdin.on('error', () => {});
  broker.stdin.end(JSON.stringify({ browserPath, flags, socketPath, markerPath }));
  broker.unref();
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (brokerFailure) throw brokerFailure;
    if (await activePipeMarker(markerPath)) {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
      return pipeLaunchText(marker, options, explicitBrowserPath, browserPath, false);
    }
    await sleep(250);
  }
  throw new Error('Browser pipe failed to start within 15 seconds.');
}

function pipeLaunchText(marker, options, explicitBrowserPath, browserPath, reused) {
  const lines = [reused ? `Browser pipe already active (PID: ${marker.browserPid})` : `Browser launched through pipe (PID: ${marker.browserPid})`];
  if (explicitBrowserPath) lines.push(`Browser path: ${browserPath}`);
  if (options.incognito) lines.push('Mode: incognito');
  lines.push(`Profile: ${options.profile || 'pipe'} (isolated)`);
  lines.push('Transport: remote debugging pipe');
  if (marker.extensionTools) lines.push('Extension tools: enabled');
  if (marker.webMcp) lines.push('WebMCP: enabled');
  return lines.join('\n');
}

async function activePipeMarker(markerPath) {
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    return marker.socketPath ? await canConnectSocket(marker.socketPath) : false;
  } catch {
    return false;
  }
}

function canConnectSocket(path, timeout = 250) {
  return new Promise(resolveProbe => {
    const socket = net.createConnection(path);
    const finish = value => {
      socket.destroy();
      resolveProbe(value);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function openPipePage(socketPath, url) {
  const cdp = new CDP();
  await cdp.connect(`unix://${socketPath}`);
  try {
    await cdp.send('Target.createTarget', { url });
  } finally {
    cdp.close();
  }
}

function mergeEnabledFeature(flags, feature) {
  const index = flags.findIndex(flag => flag.startsWith('--enable-features='));
  if (index < 0) {
    flags.push(`--enable-features=${feature}`);
    return;
  }
  const values = flags[index].slice('--enable-features='.length).split(',').filter(Boolean);
  if (!values.includes(feature)) values.push(feature);
  flags[index] = `--enable-features=${values.join(',')}`;
}

export async function incognitoContext(cdp, url) {
  const { browserContextId } = await cdp.send('Target.createBrowserContext', {
    disposeOnDetach: true,
  });

  const { targetId } = await cdp.send('Target.createTarget', {
    url: url || 'about:blank',
    browserContextId,
  });

  return {
    targetId,
    browserContextId,
    message: `Incognito context created (targetId: ${targetId.slice(0, 8)}). Isolated cookies/storage.${url ? ` Navigated to ${url}.` : ''}`,
  };
}
