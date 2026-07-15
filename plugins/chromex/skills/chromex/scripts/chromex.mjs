#!/usr/bin/env node
// chromex -- Chrome DevTools Protocol CLI for AI agents
// Zero dependencies. Node 22+ (built-in WebSocket).

import { existsSync, readFileSync } from 'fs';
import { spawn } from 'child_process';
import { loadConfig } from './lib/config.mjs';
import { CDP } from './lib/client.mjs';
import { resolveWsUrl, getPages, getPagesHttp, formatPageList, redactPages, writePagesCache } from './lib/browser.mjs';
import { audit } from './lib/security.mjs';
import { resolvePrefix, listDaemonSockets } from './lib/utils.mjs';
import { runDaemon } from './lib/daemon.mjs';
import { getOrStartTabDaemon, sendCommand, stopDaemons, checkTargetDomain } from './lib/ipc.mjs';
import { launchBrowser, incognitoContext } from './lib/launcher.mjs';
import { openTab, openTabStr, closeTabStr, focusTabStr } from './lib/commands/tab.mjs';
import { deleteSessionData, formatSessions, getSession, listSessions, removeSession, sessionStatePath, setSession } from './lib/sessions.mjs';
import { showStr } from './lib/commands/show.mjs';

const PACKAGE_INFO = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'));
let config;
let activeOutputOptions = { json: false };

// Commands that require a target tab
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
  'issues', 'inspect', 'diagnose',
  'screencast',
  'extensions',
  'third-party',
  'webmcp',
  // Application state
  'app', 'sw', 'cache', 'idb', 'state', 'locator', 'evidence',
]);

const SESSION_PERSIST_COMMANDS = new Set([
  'nav', 'navigate', 'click', 'clickxy', 'type', 'loadall', 'eval', 'evalraw',
  'fill', 'clear', 'select', 'check', 'form', 'cookies', 'storage', 'state',
  'wait', 'dialog', 'upload', 'inject', 'download', 'drag', 'touch', 'key',
]);

const USAGE = `chromex - Chrome DevTools Protocol CLI for AI agents

Usage: chromex [--raw] [--json] [-s name] <command> [args]

  GENERAL
    version                             Print the installed Chromex version

  CONNECTION
    --cdp-url URL                       Connect through HTTP(S) discovery or WS(S)
    --cdp-endpoint NAME                 Use a named endpoint from config
    --cdp-headers-file FILE             JSON headers for HTTP endpoint discovery

  PAGES
    list [--include-sensitive]          List open pages (shows unique target prefixes)
    sessions                            List named Chromex sessions
    show [--annotate]                   Open local session dashboard artifact
    open    <url>                       Open new tab
    close   <target>                    Close tab
    focus   <target>                    Activate/focus tab
    launch  [options]                   Launch browser with remote debugging
      --incognito                       Launch in incognito mode
      --browser chrome|brave|edge       Choose browser
      --profile NAME                    Use named profile
      --url URL                         Open URL on launch
      --browser-path PATH               Use an explicit Chromium executable
      --headless                        Launch in headless mode (no UI)
      --proxy PROXY                     Proxy server (e.g. socks5://localhost:1080)
      --insecure                        Ignore certificate errors
      --pipe                            Use modal-free shared remote debugging pipe
      --extension-tools                 Enable Chrome's unsafe extension debugging domain
      --webmcp                          Enable the experimental WebMCP browser feature
      --chrome-arg FLAG                 Pass custom Chrome flag (e.g. --chrome-arg --disable-web-security)
    incognito [url]                     Create isolated browser context (no relaunch)
    close-all                           Close named Chromex sessions
    delete-data <session>               Delete Chromex-managed session data

  INSPECT
    snap    <target> [options]          Accessibility tree snapshot (compact)
      --refs                            Assign @eN refs to interactive elements
      --full                            Force full snapshot (skip incremental diff)
      --depth=N                         Limit tree depth (nodes at limit render as leaves)
      --query=TEXT                      Filter to nodes matching substring + ancestors
      --filename=FILE                   Save snapshot as artifact
      --boxes                           Include bounding boxes when available
    locator <target> <sel|@eN>          Generate locator for tests
      --format=chromex-test|css|testing-library
    html    <target> [selector]         Get HTML (full page or CSS selector)
    shot    <target> [file] [options]   Screenshot (viewport, full page, or element)
      --full                            Full page capture
      --format=jpeg|webp|png            Image format (default: png)
      --quality=N                       Compression quality 0-100 (JPEG/WebP)
      @eN                               Capture specific element by ref
    net     <target> [requestId]        Network requests list, or detail by request ID
      --include-sensitive              Reveal secrets only in this live response
      --url=TEXT --method=GET           Filter request list
      --status=4xx --type=XHR --failed Filter failures, status, or resource type
      --limit=N --cursor=N              Page through captured requests
      --body-limit=N                    Expand detail bodies up to 1,000,000 characters
    perf    <target> [action] [file]    Vitals, INP, long tasks, CPU/heap sampling profiles
    console <target> [duration_ms]      Capture console output (default 5000ms)
    console <target> list               Show stored messages since daemon start
    console <target> detail <id>        Message detail with stack trace
      --type=error --query=TEXT         Filter stored messages
      --limit=N --cursor=N              Page through stored messages
      --include-sensitive              Reveal secrets only in this live response
    domsnapshot <target> [--styles]     Structured DOM snapshot with bounding rects
    highlight <target> <sel|clear>      Highlight element with overlay
    evidence <target> <action> [label]  Evidence pack: start, mark, stop, status, replay, capture
    issues  <target> <action>          Browser issues: enable, list, clear, check-forms, disable
    inspect <target> <action> <sel>    CSS/listeners/box: computed, matched, listeners, box, all
    diagnose <target> [limit]          Prioritized issues, network, console and runtime diagnosis

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
    storage <target> <type>             Storage: local, session, clear, usage, clear-site-data
    state   <target> save|load [file]   Save/load cookies + localStorage state
    app     <target> [summary]          Application state summary
    sw      <target> [action] [scope]   Service Workers: list, update, skip-waiting, unregister
    cache   <target> [action] [args]    Cache Storage: list, entries <cacheId> --query=/api, body, delete-entry, delete
    idb     <target> [action] [args]    IndexedDB: list, schema, rows --limit=20, clear
    pdf     <target> [file]             Save page as PDF

  NETWORK
    throttle <target> <preset|reset>    Throttle: 3g, slow-3g, 4g, offline, custom, reset
    intercept <target> <action> [args]  Intercept: on, block, mock, off, rules
      mock supports --status --content-type --header --body --delay
      block supports --abort; on supports --remove-header
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
    trace   <target> <action> [arg]     Trace: start, stop, insights, insight <type>
    heap    <target> <action> [args]     Heap capture and analysis
      actions: snapshot, close, summary, details, class-nodes, dominators,
               duplicate-strings, edges, retainers, retaining-paths, compare
    screencast <target> <action> [args]  Frame capture: start, stop, status, replay
      start [directory] [--format=jpeg|png] [--quality=N] [--max-frames=N]
    extensions <target> <action> [args]  Extension lifecycle, targets, actions, and storage
    third-party <target> <action> [args] Discover and execute page-exposed developer tools
    webmcp <target> <action> [args]      List, execute, cancel, or disable page WebMCP tools
    webauthn <target> enable|creds|dis  Virtual authenticator for passkey testing

  AUDIT
    audit   <target> [categories] [device]  Lighthouse audit (performance, accessibility, SEO)
      categories: performance,accessibility,seo,best-practices
      device: mobile (default) or desktop
    stats   <target> [--full] [--reset] Session analytics (command counts, timing, errors)
      --export=/path/to/stats.json      Export as JSON

  DAEMON
    doctor                              Diagnose browser/CDP connectivity
    stop    [target]                    Stop daemon(s)

<target> is a unique targetId prefix from "chromex list". Ambiguous prefixes are rejected.

OUTPUT FLAGS
  --raw       Print only primary command output and suppress hints/auto-snapshot
  --json      Print stable JSON envelope: ok, command, target, text, data, artifacts, error
  -s NAME     Use a named Chromex session. Can also use CHROMEX_SESSION
  --no-snap   Skip auto-snapshot after interactive commands
  --no-hints  Suppress contextual help[] suggestions

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
  const parsed = parseGlobalArgs(process.argv.slice(2));
  activeOutputOptions = parsed.options;
  const [cmd, ...args] = parsed.args;
  const sessionName = parsed.options.sessionName;

  if (cmd === 'version' || cmd === '--version' || cmd === '-v') {
    printEnvelope({ ok: true, command: 'version', text: PACKAGE_INFO.version, data: { version: PACKAGE_INFO.version } }, parsed.options);
    return;
  }

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printEnvelope({ ok: true, command: cmd || 'help', text: USAGE }, parsed.options);
    return;
  }

  config = loadConfig();
  if (parsed.options.cdpUrl) config.cdpUrl = parsed.options.cdpUrl;
  if (parsed.options.cdpEndpoint) config.cdpEndpoint = parsed.options.cdpEndpoint;
  if (parsed.options.cdpHeadersFile) config.cdpHeadersFile = parsed.options.cdpHeadersFile;

  // Daemon mode (internal)
  if (cmd === '_daemon') {
    await runDaemon(args[0], config);
    return;
  }

  // --- Commands without target ---

  // List
  if (cmd === 'list' || cmd === 'ls') {
    const includeSensitive = args.includes('--include-sensitive');
    let pages = await pagesFromMatchingDaemon(config);
    if (!pages) pages = await getPagesHttp(config);
    if (!pages) {
      const cdp = new CDP(config.commandTimeout);
      await cdp.connect(await resolveWsUrl(config));
      pages = await getPages(cdp);
      cdp.close();
    }
    const outputPages = redactPages(pages, { includeSensitive });
    writePagesCache(config._pagesCachePath, pages);
    audit('list', null, [], { ok: true }, config);
    printEnvelope({
      ok: true,
      command: cmd,
      text: formatPageList(pages, config, { includeSensitive }),
      data: outputPages,
    }, parsed.options);
    setTimeout(() => process.exit(0), 100);
    return;
  }

  if (cmd === 'sessions') {
    const records = listSessions(config);
    const pages = await getLivePages().catch(() => []);
    printEnvelope({
      ok: true,
      command: cmd,
      text: formatSessions(records, pages),
      data: records,
    }, parsed.options);
    return;
  }

  if (cmd === 'show') {
    const records = listSessions(config);
    const result = await getShowResult(records, args.includes('--annotate'));
    const dashboard = result.artifacts?.find(item => item.type === 'dashboard' && item.path.endsWith('/index.html'));
    if (!parsed.options.json && !parsed.options.raw && dashboard && openDashboard(dashboard.path)) {
      result.text += '\nDashboard opened in the default browser.';
    }
    printEnvelope({ ok: true, command: cmd, text: result.text, data: result.data, artifacts: result.artifacts }, parsed.options);
    return;
  }

  if (cmd === 'close-all') {
    const records = listSessions(config);
    let stale = false;
    try {
      await closeSessionRecords(records);
    } catch {
      stale = true;
      clearSessionRecords(records);
    }
    const text = stale
      ? `Cleared ${records.length} stale session record(s). Browser was unavailable.`
      : `Closed ${records.length} session(s).`;
    printEnvelope({ ok: true, command: cmd, text, data: { closed: stale ? 0 : records.length, staleCleared: stale ? records.length : 0 } }, parsed.options);
    return;
  }

  if (cmd === 'delete-data') {
    const name = args[0] || sessionName;
    if (!name) throw new Error('Session name required.');
    const record = removeSession(config, name);
    const dataPath = deleteSessionData(name);
    if (record) await closeSessionRecords([record], { persist: false }).catch(() => {});
    printEnvelope({ ok: true, command: cmd, text: `Deleted session data for ${name}: ${dataPath}`, data: { session: name, path: dataPath } }, parsed.options);
    return;
  }

  // Launch
  if (cmd === 'launch') {
    const options = parseFlags(args, ['incognito', 'headless', 'insecure', 'pipe', 'extension-tools', 'webmcp'], ['browser', 'browser-path', 'profile', 'url', 'proxy', 'chrome-arg']);
    const chromeArgs = collectFlagValues(args, 'chrome-arg');
    if (chromeArgs.length) options.chromeArgs = chromeArgs;
    delete options['chrome-arg'];
    if (options['browser-path']) { options.browserPath = options['browser-path']; delete options['browser-path']; }
    if (options['extension-tools']) { options.extensionTools = true; delete options['extension-tools']; }
    if (options.webmcp) { options.webMcp = true; delete options.webmcp; }
    const result = await launchBrowser(options);
    printEnvelope({ ok: true, command: cmd, text: result }, parsed.options);
    return;
  }

  // Doctor
  if (cmd === 'doctor') {
    const { doctorStr } = await import('./lib/commands/doctor.mjs');
    printEnvelope({ ok: true, command: cmd, text: await doctorStr(config) }, parsed.options);
    return;
  }

  // Incognito (no target -- creates a new context)
  if (cmd === 'incognito') {
    const cdp = new CDP(config.commandTimeout);
    await cdp.connect(await resolveWsUrl(config));
    const result = await incognitoContext(cdp, args[0]);
    if (sessionName) {
      setSession(config, sessionName, {
        targetId: result.targetId,
        browserContextId: result.browserContextId,
        url: args[0] || 'about:blank',
      });
    }
    printEnvelope({ ok: true, command: cmd, target: result.targetId, text: result.message, data: result }, parsed.options);
    cdp.close();
    return;
  }

  // Tab management (no daemon needed -- direct browser WebSocket)
  if (cmd === 'open' || cmd === 'close' || cmd === 'focus') {
    const cdp = new CDP(config.commandTimeout);
    await cdp.connect(await resolveWsUrl(config));
    let result;
    if (cmd === 'open') {
      if (!args[0]) { console.error('Error: URL required'); process.exit(1); }
      if (sessionName) {
        const previousSession = getSession(config, sessionName);
        const statePath = previousSession?.statePath || sessionStatePath(sessionName);
        const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: false });
        const { targetId } = await cdp.send('Target.createTarget', { url: args[0], browserContextId });
        setSession(config, sessionName, { targetId, browserContextId, url: args[0], statePath });
        const pages = await getPages(cdp);
        writePagesCache(config._pagesCachePath, pages);
        result = `Session "${sessionName}" opened (targetId: ${targetId.slice(0, 8)}). URL: ${args[0]}`;
        if (await restoreSessionState(targetId, statePath).catch(() => false)) {
          result += `\nSession state restored from ${statePath}`;
        }
      } else {
        result = await openTabStr(cdp, args[0]);
      }
    } else if (cmd === 'close') {
      const closeTarget = args[0] || (sessionName ? getSession(config, sessionName)?.targetId : null);
      if (!closeTarget) { console.error('Error: target prefix required'); process.exit(1); }
      if (sessionName) await persistSessionState(closeTarget, sessionName).catch(() => {});
      result = await closeTabStr(cdp, closeTarget);
      if (sessionName) removeSession(config, sessionName);
    } else {
      const focusTarget = args[0] || (sessionName ? getSession(config, sessionName)?.targetId : null);
      if (!focusTarget) { console.error('Error: target prefix required'); process.exit(1); }
      result = await focusTabStr(cdp, focusTarget);
    }
    printEnvelope({ ok: true, command: cmd, text: result }, parsed.options);
    cdp.close();
    return;
  }

  // Stop
  if (cmd === 'stop') {
    const stopTarget = args[0] || (sessionName ? getSession(config, sessionName)?.targetId : null);
    await stopDaemons(stopTarget, config);
    audit('stop', stopTarget || 'all', [], { ok: true }, config);
    printEnvelope({ ok: true, command: cmd, target: stopTarget, text: stopTarget ? `Stopped daemon ${stopTarget.slice(0, 8)}.` : 'Stopped all daemons.' }, parsed.options);
    return;
  }

  // --- Commands with target ---
  if (!NEEDS_TARGET.has(cmd)) {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(USAGE);
    process.exit(1);
  }

  const session = sessionName ? getSession(config, sessionName) : null;
  const targetPrefix = session ? session.targetId : args[0];
  if (!targetPrefix) {
    throw new Error(sessionName ? `Session "${sessionName}" has no active target. Run "chromex -s ${sessionName} open <url>" first.` : 'Target ID required. Run "chromex list" first.');
  }

  // Resolve prefix -> targetId
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

  // Check tab domain
  checkTargetDomain(targetId, config);

  const conn = await getOrStartTabDaemon(targetId, config);

  const effectiveArgs = session ? args : args.slice(1);
  const noSnap = parsed.options.raw || effectiveArgs.includes('--no-snap');
  const noHints = parsed.options.raw || effectiveArgs.includes('--no-hints');
  const cmdArgs = effectiveArgs.filter(a => a !== '--no-snap' && a !== '--no-hints');

  // Join arguments for commands that accept free-form text
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
    if (sessionName && SESSION_PERSIST_COMMANDS.has(cmd)) {
      await persistSessionState(targetId, sessionName).catch(() => {});
    }
    printEnvelope({
      ok: true,
      command: cmd,
      target: targetId,
      text: response.result || '',
      data: response.data ?? null,
      artifacts: response.artifacts || [],
    }, parsed.options);
  } else {
    printEnvelope({
      ok: false,
      command: cmd,
      target: targetId,
      text: '',
      error: response.error,
    }, parsed.options);
    process.exitCode = 1;
  }
}

// Simple flag parser: --flag (boolean) and --key value
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
      // Positional argument -> assume URL
      if (!result.url) result.url = arg;
      i++;
    }
  }
  return result;
}

function collectFlagValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === `--${name}` && args[index + 1]) values.push(args[++index]);
    else if (args[index].startsWith(`--${name}=`)) values.push(args[index].slice(name.length + 3));
  }
  return values;
}

function parseGlobalArgs(argv) {
  const args = [];
  const options = {
    raw: false,
    json: false,
    sessionName: process.env.CHROMEX_SESSION || '',
    cdpUrl: '',
    cdpEndpoint: '',
    cdpHeadersFile: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--raw') {
      options.raw = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '-s' || arg === '--session') {
      options.sessionName = argv[++i] || '';
      continue;
    }
    if (arg.startsWith('-s=')) {
      options.sessionName = arg.slice(3);
      continue;
    }
    if (arg.startsWith('--session=')) {
      options.sessionName = arg.slice('--session='.length);
      continue;
    }
    if (arg === '--cdp-url') {
      options.cdpUrl = argv[++i] || '';
      continue;
    }
    if (arg.startsWith('--cdp-url=')) {
      options.cdpUrl = arg.slice('--cdp-url='.length);
      continue;
    }
    if (arg === '--cdp-endpoint') {
      options.cdpEndpoint = argv[++i] || '';
      continue;
    }
    if (arg.startsWith('--cdp-endpoint=')) {
      options.cdpEndpoint = arg.slice('--cdp-endpoint='.length);
      continue;
    }
    if (arg === '--cdp-headers-file') {
      options.cdpHeadersFile = argv[++i] || '';
      continue;
    }
    if (arg.startsWith('--cdp-headers-file=')) {
      options.cdpHeadersFile = arg.slice('--cdp-headers-file='.length);
      continue;
    }
    args.push(arg);
  }
  return { args, options };
}

function printEnvelope(envelope, options = {}) {
  const normalized = {
    ok: !!envelope.ok,
    command: envelope.command || null,
    target: envelope.target || null,
    text: envelope.text ?? '',
    data: envelope.data ?? null,
    artifacts: envelope.artifacts || [],
    error: envelope.error || null,
  };
  if (options.json) {
    console.log(JSON.stringify(normalized));
    return;
  }
  if (normalized.ok) {
    if (normalized.text) console.log(normalized.text);
    return;
  }
  console.error('Error:', normalized.error || normalized.text || 'unknown error');
}

async function getLivePages() {
  const cdp = new CDP(config.commandTimeout);
  await cdp.connect(await resolveWsUrl(config));
  const pages = await getPages(cdp);
  cdp.close();
  writePagesCache(config._pagesCachePath, pages);
  return pages;
}

async function getShowResult(records, annotate) {
  let cdp = null;
  let connected = false;
  try {
    cdp = new CDP(config.commandTimeout);
    await cdp.connect(await resolveWsUrl(config));
    connected = true;
    const pages = await getPages(cdp);
    return await showStr(cdp, records, pages, annotate, config);
  } catch {
    return await showStr(null, records, [], annotate, config);
  } finally {
    if (connected) cdp?.close();
  }
}

function openDashboard(path) {
  if (process.env.CI || process.env.CHROMEX_NO_OPEN) return false;
  const opener = process.platform === 'darwin' ? ['open', [path]]
    : process.platform === 'linux' ? ['xdg-open', [path]]
      : null;
  if (!opener) return false;
  try {
    const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function closeSessionRecords(records, options = {}) {
  if (records.length === 0) return;
  const persist = options.persist !== false;
  const cdp = new CDP(config.commandTimeout);
  await cdp.connect(await resolveWsUrl(config));
  for (const record of records) {
    if (!record?.targetId) continue;
    if (persist && record.name) await persistSessionState(record.targetId, record.name).catch(() => {});
    await stopDaemons(record.targetId, config).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: record.targetId }).catch(() => {});
    if (record.browserContextId) {
      await cdp.send('Target.disposeBrowserContext', { browserContextId: record.browserContextId }).catch(() => {});
    }
    if (record.name) removeSession(config, record.name);
  }
  cdp.close();
}

function clearSessionRecords(records) {
  for (const record of records) {
    if (record?.name) removeSession(config, record.name);
  }
}

async function restoreSessionState(targetId, statePath) {
  if (!statePath || !existsSync(statePath)) return false;
  const conn = await getOrStartTabDaemon(targetId, config);
  const response = await sendCommand(conn, { cmd: 'state', args: ['load', statePath] });
  if (!response.ok) return false;
  const reloadConn = await getOrStartTabDaemon(targetId, config);
  await sendCommand(reloadConn, { cmd: 'nav', args: ['reload', '--no-snap', '--no-hints'] }).catch(() => {});
  return true;
}

async function persistSessionState(targetId, name) {
  const statePath = sessionStatePath(name);
  const conn = await getOrStartTabDaemon(targetId, config);
  const response = await sendCommand(conn, { cmd: 'state', args: ['save', statePath] });
  if (!response.ok) return false;
  setSession(config, name, { targetId, statePath });
  return true;
}

// Helper for list -- connect through an existing socket
async function connectAndAuthFromSocket(socketPath) {
  const { getOrCreateToken } = await import('./lib/daemon.mjs');
  const authToken = getOrCreateToken(config);
  const net = await import('net');
  return new Promise((resolve, reject) => {
    const conn = net.connect(socketPath);
    conn.on('connect', () => {
      if (!authToken) { resolve(conn); return; }
      let buf = '';
      const onData = chunk => {
        buf += chunk.toString();
        const idx = buf.indexOf('\n');
        if (idx === -1) return;
        conn.off('data', onData);
        try {
          const resp = JSON.parse(buf.slice(0, idx));
          if (resp.ok) resolve(conn);
          else reject(new Error('Auth failed'));
        } catch { reject(new Error('Invalid response')); }
      };
      conn.on('data', onData);
      conn.write(JSON.stringify({ auth: authToken, id: 0 }) + '\n');
    });
    conn.on('error', reject);
  });
}

async function pagesFromMatchingDaemon(activeConfig) {
  const expectedEndpoint = await resolveWsUrl(activeConfig).catch(() => null);
  if (!expectedEndpoint) return null;
  for (const daemon of listDaemonSockets(activeConfig._socketDir)) {
    try {
      const conn = await connectAndAuthFromSocket(daemon.socketPath);
      const response = await sendCommand(conn, { cmd: 'list_raw' });
      if (response.ok && response.data?.endpoint === expectedEndpoint) return JSON.parse(response.result);
    } catch {}
  }
  return null;
}

main().catch(e => {
  printEnvelope({ ok: false, command: null, text: '', error: e.message }, activeOutputOptions);
  process.exit(1);
});
