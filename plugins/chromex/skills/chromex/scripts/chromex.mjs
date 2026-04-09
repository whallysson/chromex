#!/usr/bin/env node
// chromex -- Chrome DevTools Protocol CLI for AI agents
// Zero dependencies. Node 22+ (built-in WebSocket).

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { loadConfig } from './lib/config.mjs';
import { CDP } from './lib/client.mjs';
import { getWsUrl, getPages, formatPageList } from './lib/browser.mjs';
import { audit } from './lib/security.mjs';
import { resolvePrefix, listDaemonSockets } from './lib/utils.mjs';
import { runDaemon } from './lib/daemon.mjs';
import { getOrStartTabDaemon, sendCommand, stopDaemons, findAnyDaemonSocket, checkTargetDomain } from './lib/ipc.mjs';
import { launchBrowser, incognitoContext } from './lib/launcher.mjs';

const config = loadConfig();

// Comandos que precisam de target (tab)
const NEEDS_TARGET = new Set([
  'snap', 'snapshot', 'eval', 'shot', 'screenshot', 'html', 'nav', 'navigate',
  'net', 'network', 'click', 'clickxy', 'type', 'loadall', 'evalraw', 'waitfor',
  'fill', 'clear', 'select', 'check', 'form',
  'scroll', 'cookies', 'pdf', 'console', 'storage', 'emulate', 'perf',
  // Tier 1
  'wait', 'dialog', 'upload',
  'geo', 'timezone', 'locale', 'throttle', 'cpu', 'inject', 'download',
  // Tier 2
  'intercept', 'har', 'coverage',
  // Tier 3
  'trace', 'heap', 'webauthn', 'drag', 'touch', 'domsnapshot', 'highlight',
  'hover', 'key', 'resize', 'audit', 'stats',
]);

const USAGE = `chromex - Chrome DevTools Protocol CLI for AI agents

Usage: chromex <command> [args]

  PAGES
    list                                List open pages (shows unique target prefixes)
    open    <url>                       Open new tab
    close   <target>                    Close tab
    focus   <target>                    Activate/focus tab
    launch  [options]                   Launch browser with remote debugging
      --incognito                       Launch in incognito mode
      --browser chrome|brave|edge       Choose browser
      --profile NAME                    Use named profile
      --url URL                         Open URL on launch
      --headless                        Launch in headless mode (no UI)
      --proxy PROXY                     Proxy server (e.g. socks5://localhost:1080)
      --insecure                        Ignore certificate errors
      --chrome-arg FLAG                 Pass custom Chrome flag (e.g. --chrome-arg --disable-web-security)
    incognito [url]                     Create isolated browser context (no relaunch)

  INSPECT
    snap    <target> [options]          Accessibility tree snapshot (compact)
      --refs                            Assign @eN refs to interactive elements
      --full                            Force full snapshot (skip incremental diff)
      --depth=N                         Limit tree depth (nodes at limit render as leaves)
      --query=TEXT                      Filter to nodes matching substring + ancestors
    html    <target> [selector]         Get HTML (full page or CSS selector)
    shot    <target> [file] [options]   Screenshot (viewport, full page, or element)
      --full                            Full page capture
      --format=jpeg|webp|png            Image format (default: png)
      --quality=N                       Compression quality 0-100 (JPEG/WebP)
      @eN                               Capture specific element by ref
    net     <target> [requestId]        Network requests list, or detail by request ID
    perf    <target>                    Core Web Vitals + performance metrics
    console <target> [duration_ms]      Capture console output (default 5000ms)
    console <target> list               Show stored messages since daemon start
    console <target> detail <id>        Message detail with stack trace
    domsnapshot <target> [--styles]     Structured DOM snapshot with bounding rects
    highlight <target> <sel|clear>      Highlight element with overlay

  EVALUATE
    eval    <target> <expr>             Evaluate JS expression
    evalraw <target> <method> [json]    Raw CDP command (some methods blocked)

  NAVIGATE
    nav     <target> <url|action>        Navigate: URL, back, forward, reload, reload-hard
    waitfor <target> <selector> [ms]    Wait for CSS selector to appear
    wait    <target> <event> [ms]       Wait for: networkidle, load, domready, fcp
    scroll  <target> <dir> [amount]     Scroll: up, down, top, bottom, to <selector>

  INTERACT
    click   <target> <selector> [--dbl]  Click element (supports double-click)
    clickxy <target> <x> <y> [--dbl]   Click at coordinates (supports double-click)
    key     <target> <combo>            Press key: Enter, Tab, Escape, Control+A, Meta+C
    type    <target> <text>             Type text at current focus
    drag    <target> <from> <to>        Drag & drop (selectors or x1,y1 x2,y2)
    touch   <target> <gesture> [args]   Touch: tap, swipe, pinch, longpress
    dialog  <target> <action> [text]    Handle dialogs: accept, dismiss, auto

  FORMS
    fill    <target> <selector> <value> Fill input/textarea
    clear   <target> <selector>         Clear input field
    select  <target> <selector> <value> Select option in <select>
    check   <target> <selector> [bool]  Toggle checkbox/radio (default: true)
    form    <target> <json>             Batch fill: {"#email":"x","#terms":true}
    upload  <target> <selector> <files> Upload file(s) to input[type=file]
    loadall <target> <selector> [ms]    Click "load more" until gone

  DATA
    cookies <target> [action] [arg]     Cookies: list, set <json>, clear [domain]
    storage <target> <type>             Storage: local, session, clear
    pdf     <target> [file]             Save page as PDF

  NETWORK
    throttle <target> <preset|reset>    Throttle: 3g, slow-3g, 4g, offline, custom, reset
    intercept <target> <action> [args]  Intercept: on, block, mock, off, rules
    har     <target> start|stop [file]  Record HTTP traffic as HAR file

  EMULATE
    emulate <target> <device|reset>     Emulate device (iphone-14, pixel-7, etc.)
    geo     <target> <lat> <lon>|reset  Set geolocation override
    timezone <target> <tz|reset>        Set timezone (e.g. America/Sao_Paulo)
    locale  <target> <locale|reset>     Set locale (e.g. pt-BR)
    cpu     <target> <rate|reset>       CPU throttle (1=normal, 4=4x slower, 6=mobile)
    resize  <target> <w> <h> [dpr]     Resize viewport to custom dimensions

  ADVANCED
    inject  <target> <script|flags>     Inject JS on every page load (--file, --remove, --list)
    download <target> allow|deny|reset  Control download behavior
    coverage <target> start|stop        CSS/JS code coverage report
    trace   <target> start|stop [file]  Performance trace (chrome://tracing format)
    heap    <target> snapshot [file]     Heap snapshot for memory analysis
    webauthn <target> enable|creds|dis  Virtual authenticator for passkey testing

  AUDIT
    audit   <target> [categories] [device]  Lighthouse audit (performance, accessibility, SEO)
      categories: performance,accessibility,seo,best-practices
      device: mobile (default) or desktop
    stats   <target> [--full] [--reset] Session analytics (command counts, timing, errors)
      --export=/path/to/stats.json      Export as JSON

  DAEMON
    stop    [target]                    Stop daemon(s)

<target> is a unique targetId prefix from "chromex list". Ambiguous prefixes are rejected.

SECURITY
  Config: ~/.chromex/config.json
  - blockedDomains / allowedDomains: domain filtering
  - blockedCdpMethods: CDP methods blocked in evalraw
  - socketAuth / auditLog: daemon security

COORDINATES
  shot captures at native resolution: image px = CSS px * DPR.
  clickxy takes CSS pixels. CSS px = screenshot px / DPR.
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  // Daemon mode (internal)
  if (cmd === '_daemon') {
    await runDaemon(args[0], config);
    return;
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  // --- Comandos sem target ---

  // List
  if (cmd === 'list' || cmd === 'ls') {
    let pages;
    const existingSock = findAnyDaemonSocket(config);
    if (existingSock) {
      try {
        const conn = await connectAndAuthFromSocket(existingSock);
        const resp = await sendCommand(conn, { cmd: 'list_raw' });
        if (resp.ok) pages = JSON.parse(resp.result);
      } catch { /* fallback para conexão direta */ }
    }
    if (!pages) {
      const cdp = new CDP(config.commandTimeout);
      await cdp.connect(getWsUrl());
      pages = await getPages(cdp);
      cdp.close();
    }
    writeFileSync(config._pagesCachePath, JSON.stringify(pages));
    audit('list', null, [], { ok: true }, config);
    console.log(formatPageList(pages, config));
    setTimeout(() => process.exit(0), 100);
    return;
  }

  // Launch
  if (cmd === 'launch') {
    const options = parseFlags(args, ['incognito', 'headless', 'insecure'], ['browser', 'profile', 'url', 'proxy', 'chrome-arg']);
    if (options['chrome-arg']) { options.chromeArgs = [options['chrome-arg']]; delete options['chrome-arg']; }
    const result = await launchBrowser(options);
    console.log(result);
    return;
  }

  // Incognito (sem target -- cria novo context)
  if (cmd === 'incognito') {
    const cdp = new CDP(config.commandTimeout);
    await cdp.connect(getWsUrl());
    const result = await incognitoContext(cdp, args[0]);
    console.log(result.message);
    cdp.close();
    return;
  }

  // Tab management (no daemon needed -- direct browser WebSocket)
  if (cmd === 'open' || cmd === 'close' || cmd === 'focus') {
    const { openTabStr, closeTabStr, focusTabStr } = await import('./lib/commands/tab.mjs');
    const cdp = new CDP(config.commandTimeout);
    await cdp.connect(getWsUrl());
    let result;
    if (cmd === 'open') {
      if (!args[0]) { console.error('Error: URL required'); process.exit(1); }
      result = await openTabStr(cdp, args[0]);
    } else if (cmd === 'close') {
      if (!args[0]) { console.error('Error: target prefix required'); process.exit(1); }
      result = await closeTabStr(cdp, args[0]);
    } else {
      if (!args[0]) { console.error('Error: target prefix required'); process.exit(1); }
      result = await focusTabStr(cdp, args[0]);
    }
    console.log(result);
    cdp.close();
    return;
  }

  // Stop
  if (cmd === 'stop') {
    await stopDaemons(args[0], config);
    audit('stop', args[0] || 'all', [], { ok: true }, config);
    return;
  }

  // --- Comandos com target ---
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const targetPrefix = args[0];
  if (!targetPrefix) {
    console.error('Error: target ID required. Run "chromex list" first.');
    process.exit(1);
  }

  // Resolver prefix -> targetId
  let targetId;
  const daemonTargetIds = listDaemonSockets(config._socketDir).map(d => d.targetId);
  const daemonMatches = daemonTargetIds.filter(id => id.toUpperCase().startsWith(targetPrefix.toUpperCase()));

  if (daemonMatches.length > 0) {
    targetId = resolvePrefix(targetPrefix, daemonTargetIds, 'daemon');
  } else {
    if (!existsSync(config._pagesCachePath)) {
      console.error('No page list cached. Run "chromex list" first.');
      process.exit(1);
    }
    const pages = JSON.parse(readFileSync(config._pagesCachePath, 'utf8'));
    targetId = resolvePrefix(targetPrefix, pages.map(p => p.targetId), 'target', 'Run "chromex list".');
  }

  // Checar domínio da tab
  checkTargetDomain(targetId, config);

  const conn = await getOrStartTabDaemon(targetId, config);

  const noSnap = args.includes('--no-snap');
  const noHints = args.includes('--no-hints');
  const cmdArgs = args.slice(1).filter(a => a !== '--no-snap' && a !== '--no-hints');

  // Juntar argumentos para comandos que aceitam texto livre
  if (cmd === 'eval') {
    const expr = cmdArgs.join(' ');
    if (!expr) { console.error('Error: expression required'); process.exit(1); }
    cmdArgs[0] = expr;
    cmdArgs.length = 1;
  } else if (cmd === 'type') {
    const text = cmdArgs.join(' ');
    if (!text) { console.error('Error: text required'); process.exit(1); }
    cmdArgs[0] = text;
    cmdArgs.length = 1;
  } else if (cmd === 'fill') {
    // fill <selector> <value...>
    if (cmdArgs.length < 2) { console.error('Error: selector and value required'); process.exit(1); }
    const selector = cmdArgs[0];
    const value = cmdArgs.slice(1).join(' ');
    cmdArgs[0] = selector;
    cmdArgs[1] = value;
    cmdArgs.length = 2;
  } else if (cmd === 'evalraw') {
    if (!cmdArgs[0]) { console.error('Error: CDP method required'); process.exit(1); }
    if (cmdArgs.length > 2) {
      cmdArgs[1] = cmdArgs.slice(1).join(' ');
      cmdArgs.length = 2;
    }
  }

  if ((cmd === 'nav' || cmd === 'navigate') && !cmdArgs[0]) {
    console.error('Error: URL required');
    process.exit(1);
  }

  if (noSnap) cmdArgs.push('--no-snap');
  if (noHints) cmdArgs.push('--no-hints');
  const response = await sendCommand(conn, { cmd, args: cmdArgs });

  if (response.ok) {
    if (response.result) console.log(response.result);
  } else {
    console.error('Error:', response.error);
    process.exitCode = 1;
  }
}

// Parser de flags simples: --flag (boolean) e --key value
function parseFlags(args, booleanFlags, valueFlags) {
  const result = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (booleanFlags.includes(key)) {
        result[key] = true;
        i++;
      } else if (valueFlags.includes(key)) {
        result[key] = args[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else {
      // Argumento posicional -> assume URL
      if (!result.url) result.url = arg;
      i++;
    }
  }
  return result;
}

// Helper para list -- conectar via socket existente
async function connectAndAuthFromSocket(socketPath) {
  const { getOrCreateToken } = await import('./lib/daemon.mjs');
  const authToken = getOrCreateToken(config);
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    conn.on('connect', () => {
      if (!authToken) { resolve(conn); return; }
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        try {
          const resp = JSON.parse(buf.slice(0, idx));
          if (resp.ok) resolve(conn);
          else reject(new Error('Auth failed'));
        } catch { reject(new Error('Invalid response')); }
      });
      conn.write(JSON.stringify({ auth: authToken, id: 0 }) + '\n');
    });
    conn.on('error', reject);
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
