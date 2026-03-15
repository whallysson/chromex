// Browser launcher -- abre Chrome/Brave/Edge com remote debugging habilitado
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { homedir } from 'os';
import { sleep } from './utils.mjs';
import { getWsUrl } from './browser.mjs';

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

export async function launchBrowser(options = {}) {
  const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
  const paths = BROWSER_PATHS[platform];
  if (!paths) throw new Error(`Unsupported platform: ${process.platform}`);

  // Encontrar browser
  let browserPath;
  if (options.browser) {
    browserPath = paths[options.browser.toLowerCase()];
    if (!browserPath) {
      throw new Error(`Unknown browser: ${options.browser}. Available: ${Object.keys(paths).join(', ')}`);
    }
    if (platform === 'darwin' && !existsSync(browserPath)) {
      throw new Error(`Browser not found: ${browserPath}`);
    }
  } else {
    // Auto-detect: tentar na ordem
    for (const path of Object.values(paths)) {
      if (platform === 'darwin' ? existsSync(path) : true) {
        browserPath = path;
        break;
      }
    }
    if (!browserPath) throw new Error('No supported browser found.');
  }

  const flags = [
    '--remote-debugging-port=0', // Porta aleatória, Chrome escreve no DevToolsActivePort
    '--no-first-run',
    '--no-default-browser-check',
  ];

  if (options.incognito) flags.push('--incognito');

  if (options.profile) {
    const profilePath = resolve(PROFILES_DIR, options.profile);
    flags.push(`--user-data-dir=${profilePath}`);
  }

  if (options.url) flags.push(options.url);

  const child = spawn(browserPath, flags, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Aguardar DevToolsActivePort aparecer
  const maxWait = 10000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const wsUrl = getWsUrl();
      if (wsUrl) {
        const lines = [`Browser launched (PID: ${child.pid})`];
        if (options.incognito) lines.push('Mode: incognito');
        if (options.profile) lines.push(`Profile: ${options.profile}`);
        lines.push(`Remote debugging active`);
        return lines.join('\n');
      }
    } catch { /* aguardando */ }
    await sleep(500);
  }

  return `Browser launched (PID: ${child.pid}) but DevToolsActivePort not found yet. Wait a moment and try "chromex list".`;
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
