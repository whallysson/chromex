// Per-tab daemon: mantém sessão CDP aberta, recebe comandos via Unix socket
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'fs';
import { randomBytes } from 'crypto';
import net from 'net';
import { CDP } from './client.mjs';
import { getWsUrl, getPages, formatPageList } from './browser.mjs';
import { audit } from './security.mjs';
import { sockPath } from './utils.mjs';

// Importar todos os comandos
import { snapshotStr } from './commands/snapshot.mjs';
import { evalStr, evalRawStr } from './commands/evaluate.mjs';
import { shotStr } from './commands/screenshot.mjs';
import { navStr } from './commands/navigate.mjs';
import { htmlStr } from './commands/html.mjs';
import { netStr, netListStr, netDetailStr } from './commands/network.mjs';
import { clickStr, clickXyStr, typeStr, loadAllStr, waitForStr } from './commands/interact.mjs';
import { fillStr, clearStr, selectStr, checkStr, formStr } from './commands/form.mjs';
import { scrollStr } from './commands/scroll.mjs';
import { cookiesStr } from './commands/cookies.mjs';
import { pdfStr } from './commands/pdf.mjs';
import { consoleStr, consoleListStr, consoleDetailStr } from './commands/console.mjs';
import { storageStr } from './commands/storage.mjs';
import { emulateStr, resizeStr } from './commands/emulate.mjs';
import { pressKeyStr } from './commands/keyboard.mjs';
import { perfStr } from './commands/perf.mjs';
// Tier 1
import { waitLifecycleStr } from './commands/wait.mjs';
import { openTabStr, closeTabStr, focusTabStr } from './commands/tab.mjs';
import { dialogStr, setupAutoDialog } from './commands/dialog.mjs';
import { uploadStr } from './commands/upload.mjs';
import { geoStr, timezoneStr, localeStr } from './commands/geo.mjs';
import { throttleStr } from './commands/throttle.mjs';
import { cpuStr } from './commands/cpu.mjs';
import { injectStr } from './commands/inject.mjs';
import { downloadStr } from './commands/download.mjs';
// Tier 2
import { interceptStr } from './commands/intercept.mjs';
import { harStr } from './commands/har.mjs';
import { coverageStr } from './commands/coverage.mjs';
// Tier 3
import { traceStr } from './commands/trace.mjs';
import { heapStr } from './commands/heap.mjs';
import { webauthnStr } from './commands/webauthn.mjs';
import { dragStr } from './commands/drag.mjs';
import { touchStr } from './commands/touch.mjs';
import { domsnapshotStr } from './commands/domsnapshot.mjs';
import { parseRef, clickRefStr, hoverRefStr, fillRefStr } from './commands/refs.mjs';
import { highlightStr } from './commands/highlight.mjs';
import { auditStr } from './commands/audit.mjs';
import { SessionStats, statsStr } from './commands/stats.mjs';
import { generateHints, renderHints, isRefMapFresh } from './hints.mjs';
import { sleep } from './utils.mjs';

// Commands that modify visible DOM and should trigger automatic post-action snapshot.
// After these commands, an incremental snapshot with refs is appended to the result,
// so the AI agent sees the page state without needing a separate snapshot call.
const AUTO_SNAP_CMDS = new Set([
  'click', 'clickxy', 'type', 'fill', 'clear', 'select', 'check', 'form',
  'nav', 'navigate', 'dialog', 'loadall', 'drag', 'touch', 'upload', 'key',
]);

export function getOrCreateToken(config) {
  if (!config.socketAuth) return null;
  const tokenPath = config._tokenPath;
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf8').trim();
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(tokenPath, token, { mode: 0o600 });
  return token;
}

export async function runDaemon(targetId, config) {
  const sp = sockPath(config._socketDir, targetId);
  const authToken = getOrCreateToken(config);

  const cdp = new CDP(config.commandTimeout);
  try {
    await cdp.connect(getWsUrl());
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    try { unlinkSync(sp); } catch { /* socket já removido */ }
    cdp.close();
    process.exit(0);
  }

  cdp.onEvent('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.onEvent('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  let idleTimer = setTimeout(shutdown, config.idleTimeout);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, config.idleTimeout);
  }

  // Per-tab state: ref map for @eN resolution + fingerprints for incremental diff
  let currentRefMap = new Map();
  let previousFingerprints = null;
  // Track the last @eN that was filled so hints can prioritize the NEXT input
  // in a multi-field form instead of re-suggesting the one we just touched.
  let lastFilledRef = null;
  const sessionStats = new SessionStats();

  // Network request tracking (CDP Network domain) for detail drill-down
  const networkRequests = new Map();
  try {
    await cdp.send('Network.enable', {}, sessionId);
    cdp.onEvent('Network.requestWillBeSent', (params) => {
      networkRequests.set(params.requestId, {
        url: params.request.url,
        method: params.request.method,
        requestHeaders: params.request.headers,
        type: params.type,
        ts: params.timestamp,
      });
      if (networkRequests.size > 500) networkRequests.delete(networkRequests.keys().next().value);
    });
    cdp.onEvent('Network.responseReceived', (params) => {
      const r = networkRequests.get(params.requestId);
      if (r) {
        r.status = params.response.status;
        r.statusText = params.response.statusText;
        r.responseHeaders = params.response.headers;
        r.timing = params.response.timing;
        r.mimeType = params.response.mimeType;
      }
    });
  } catch { /* Network domain unavailable */ }

  // Console message tracking for list/detail drill-down
  const consoleMessages = [];
  try {
    await cdp.send('Runtime.enable', {}, sessionId);
    cdp.onEvent('Runtime.consoleAPICalled', (params) => {
      consoleMessages.push({
        id: consoleMessages.length,
        ts: Date.now(),
        type: params.type,
        args: (params.args || []).map(a => {
          if (a.type === 'string') return a.value;
          if (a.type === 'number') return String(a.value);
          if (a.type === 'boolean') return String(a.value);
          if (a.type === 'undefined') return 'undefined';
          if (a.subtype === 'null') return 'null';
          return a.description || JSON.stringify(a.value) || `[${a.type}]`;
        }),
        stackTrace: params.stackTrace,
      });
      if (consoleMessages.length > 1000) consoleMessages.splice(0, 500);
    });
  } catch { /* Runtime domain unavailable */ }

  async function handleCommand({ cmd, args }) {
    resetIdle();
    const startMs = Date.now();
    const auditResult = { ok: true };
    try {
      // Strip --no-snap / --no-hints before dispatch so they don't contaminate
      // command args (e.g. fill would type "--no-snap" into the input field).
      const noSnap = args.includes('--no-snap');
      const noHints = args.includes('--no-hints');
      if (noSnap || noHints) args = args.filter(a => a !== '--no-snap' && a !== '--no-hints');

      let result;
      let isRefCmd = false;

      // Ref-based dispatch: click @e5, fill @e3 "value", hover @e12
      if (args[0] && parseRef(args[0]) !== null) {
        isRefCmd = true;
        const refNum = parseRef(args[0]);
        const dbl = args.includes('--dbl');
        if (cmd === 'click') {
          result = await clickRefStr(cdp, sessionId, currentRefMap, refNum, dbl);
        } else if (cmd === 'fill') {
          result = await fillRefStr(cdp, sessionId, currentRefMap, refNum, args.slice(1).join(' '));
          lastFilledRef = refNum;
        } else if (cmd === 'hover') {
          result = await hoverRefStr(cdp, sessionId, currentRefMap, refNum);
        } else {
          throw new Error(`Ref @e${refNum} not supported for command "${cmd}". Use with: click, fill, hover.`);
        }
      }

      if (!isRefCmd) switch (cmd) {
        // --- Comandos originais ---
        case 'list': {
          const pages = await getPages(cdp);
          result = formatPageList(pages, config);
          break;
        }
        case 'list_raw': {
          const pages = await getPages(cdp);
          result = JSON.stringify(pages);
          break;
        }
        case 'snap': case 'snapshot': {
          const useRefs = args.includes('--refs') || args.includes('-i');
          const forceFull = args.includes('--full');
          const depthArg = args.find(a => a.startsWith('--depth='));
          const maxDepth = depthArg ? parseInt(depthArg.split('=')[1]) || 0 : 0;
          const queryArg = args.find(a => a.startsWith('--query='));
          const query = queryArg ? queryArg.slice('--query='.length) : null;
          const prevFp = forceFull ? null : previousFingerprints;
          const snapResult = await snapshotStr(cdp, sessionId, true, useRefs, prevFp, maxDepth, query);
          result = snapResult.text;
          // Always track fingerprints on the full tree -- this survives query filtering
          // because snapshotStr computes them before applying the filter.
          previousFingerprints = snapResult.fingerprints;
          // Replace the ref map even when it is empty: a fresh snapshot that found
          // zero interactive refs must clear any stale @eN left from an older page.
          if (useRefs) {
            currentRefMap = snapResult.refMap;
          }
          break;
        }
        case 'eval':
          result = await evalStr(cdp, sessionId, args[0]);
          break;
        case 'shot': case 'screenshot': {
          const full = args.includes('--full');
          const formatArg = args.find(a => a.startsWith('--format='));
          const qualityArg = args.find(a => a.startsWith('--quality='));
          const refArg = args.find(a => a && a.startsWith('@e'));
          const file = args.find(a => a && !a.startsWith('--') && !a.startsWith('@e'));
          const options = {};
          if (formatArg) options.format = formatArg.split('=')[1];
          if (qualityArg) options.quality = parseInt(qualityArg.split('=')[1]);
          if (refArg) {
            const refNum = parseInt(refArg.slice(2));
            if (!isNaN(refNum)) {
              options.refMap = currentRefMap;
              options.refNum = refNum;
            }
          }
          result = await shotStr(cdp, sessionId, file, full, config, options);
          break;
        }
        case 'html':
          result = await htmlStr(cdp, sessionId, args[0]);
          break;
        case 'nav': case 'navigate': {
          result = await navStr(cdp, sessionId, args[0], config);
          // Any navigation changes page identity and can restore DOM via
          // BFCache/hydration. Reset the diff baseline unconditionally so the
          // first post-navigation snapshot is always a trustworthy full view.
          previousFingerprints = null;
          // ANY navigation (including back/forward) invalidates the ref map:
          // the @eN numbers were assigned against a specific DOM render,
          // and even back/forward can restore the page with different hydration.
          // Auto-snap (if not --no-snap) will repopulate the refMap immediately below.
          currentRefMap = new Map();
          lastFilledRef = null;
          break;
        }
        case 'net': case 'network':
          if (args[0]) {
            result = await netDetailStr(cdp, sessionId, args[0], networkRequests);
          } else if (networkRequests.size > 0) {
            result = netListStr(networkRequests);
          } else {
            result = await netStr(cdp, sessionId);
          }
          break;
        case 'click': {
          const dbl = args.includes('--dbl');
          const sel = args.filter(a => a !== '--dbl')[0];
          result = await clickStr(cdp, sessionId, sel, dbl);
          break;
        }
        case 'clickxy': {
          const dbl = args.includes('--dbl');
          const xyArgs = args.filter(a => a !== '--dbl');
          result = await clickXyStr(cdp, sessionId, xyArgs[0], xyArgs[1], dbl);
          break;
        }
        case 'type':
          result = await typeStr(cdp, sessionId, args[0]);
          break;
        case 'loadall':
          result = await loadAllStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : 1500);
          break;
        case 'evalraw':
          result = await evalRawStr(cdp, sessionId, args[0], args[1], config);
          break;
        case 'waitfor':
          result = await waitForStr(cdp, sessionId, args[0], args[1] ? parseInt(args[1]) : undefined, config);
          break;
        // --- Novos comandos ---
        case 'fill':
          result = await fillStr(cdp, sessionId, args[0], args.slice(1).join(' '));
          break;
        case 'clear':
          result = await clearStr(cdp, sessionId, args[0]);
          break;
        case 'select':
          result = await selectStr(cdp, sessionId, args[0], args.slice(1).join(' '));
          break;
        case 'check':
          result = await checkStr(cdp, sessionId, args[0], args[1] !== 'false');
          break;
        case 'form':
          result = await formStr(cdp, sessionId, args[0]);
          break;
        case 'scroll':
          result = await scrollStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'cookies':
          result = await cookiesStr(cdp, sessionId, args[0], args.slice(1).join(' ') || undefined);
          break;
        case 'pdf':
          result = await pdfStr(cdp, sessionId, args[0]);
          break;
        case 'console': {
          const sub = args[0]?.toLowerCase();
          if (sub === 'list') {
            result = consoleListStr(consoleMessages);
          } else if (sub === 'detail' && args[1]) {
            result = consoleDetailStr(consoleMessages, args[1]);
          } else {
            result = await consoleStr(cdp, sessionId, args[0]);
          }
          break;
        }
        case 'storage':
          result = await storageStr(cdp, sessionId, args[0]);
          break;
        case 'emulate':
          result = await emulateStr(cdp, sessionId, args[0]);
          break;
        case 'perf':
          result = await perfStr(cdp, sessionId);
          break;
        // --- Tier 1: Quick Wins ---
        case 'wait':
          result = await waitLifecycleStr(cdp, sessionId, args[0], args[1], config);
          break;
        case 'open':
          result = await openTabStr(cdp, args[0]);
          break;
        case 'close':
          result = await closeTabStr(cdp, args[0]);
          break;
        case 'focus':
          result = await focusTabStr(cdp, args[0]);
          break;
        case 'dialog': {
          const dialogResult = await dialogStr(cdp, sessionId, args[0], args.slice(1).join(' ') || undefined);
          if (dialogResult === '__AUTO_DIALOG__') {
            result = setupAutoDialog(cdp, sessionId);
          } else {
            result = dialogResult;
          }
          break;
        }
        case 'upload':
          result = await uploadStr(cdp, sessionId, args[0], ...args.slice(1));
          break;
        case 'geo':
          result = await geoStr(cdp, sessionId, args[0], args[1], args[2]);
          break;
        case 'timezone':
          result = await timezoneStr(cdp, sessionId, args[0]);
          break;
        case 'locale':
          result = await localeStr(cdp, sessionId, args[0]);
          break;
        case 'throttle':
          result = await throttleStr(cdp, sessionId, args[0], ...args.slice(1));
          break;
        case 'cpu':
          result = await cpuStr(cdp, sessionId, args[0]);
          break;
        case 'inject':
          result = await injectStr(cdp, sessionId, args[0], args.slice(1).join(' ') || undefined);
          break;
        case 'download':
          result = await downloadStr(cdp, sessionId, args[0], args[1]);
          break;
        // --- Tier 2: Game Changers ---
        case 'intercept':
          result = await interceptStr(cdp, sessionId, args[0], args[1], args.slice(2).join(' ') || undefined);
          break;
        case 'har':
          result = await harStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'coverage':
          result = await coverageStr(cdp, sessionId, args[0]);
          break;
        // --- Tier 3: Pro Features ---
        case 'trace':
          result = await traceStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'heap':
          result = await heapStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'webauthn':
          result = await webauthnStr(cdp, sessionId, args[0]);
          break;
        case 'drag':
          result = await dragStr(cdp, sessionId, args[0], args[1]);
          break;
        case 'touch':
          result = await touchStr(cdp, sessionId, args[0], ...args.slice(1));
          break;
        case 'domsnapshot':
          result = await domsnapshotStr(cdp, sessionId, args.includes('--styles'));
          break;
        case 'highlight':
          result = await highlightStr(cdp, sessionId, args[0]);
          break;
        case 'key':
          result = await pressKeyStr(cdp, sessionId, args[0]);
          break;
        case 'resize':
          result = await resizeStr(cdp, sessionId, args[0], args[1], args[2]);
          break;
        case 'audit':
          result = await auditStr(cdp, sessionId, args[0], args[1], args[2]);
          break;
        case 'stats': {
          const isFull = args.includes('--full');
          const exportArg = args.find(a => a.startsWith('--export='));
          const exportPath = exportArg ? exportArg.split('=')[1] : null;
          if (args.includes('--reset')) {
            sessionStats.commands.clear();
            sessionStats.timeline.length = 0;
            sessionStats.startTime = Date.now();
            result = 'Session stats reset.';
          } else {
            result = statsStr(sessionStats, isFull, exportPath);
          }
          break;
        }
        case 'hover':
          throw new Error('hover requires a ref (@eN). Run "snap --refs" first, then "hover @e5".');
        case 'stop': {
          audit(cmd, targetId, args, auditResult, config);
          return { ok: true, result: '', stopAfter: true };
        }
        default: {
          auditResult.ok = false;
          audit(cmd, targetId, args, auditResult, config);
          return { ok: false, error: `Unknown command: ${cmd}` };
        }
      }
      audit(cmd, targetId, args, auditResult, config);

      // Auto-snapshot: append incremental snapshot with refs after DOM-modifying actions.
      // This lets the AI agent see the resulting page state in a single round-trip.
      // Opt-out with --no-snap for scripts doing rapid sequential actions.
      const shouldSnap = isRefCmd
        ? (cmd === 'click' || cmd === 'fill') // hover doesn't change DOM
        : AUTO_SNAP_CMDS.has(cmd);

      if (shouldSnap && !noSnap) {
        try {
          // Navigate already waits for load+readyState; shorter settle for it.
          // Other actions (click, fill) need more time for SPA re-renders.
          const settleMs = (cmd === 'nav' || cmd === 'navigate') ? 100 : 300;
          await sleep(settleMs);
          const snapResult = await snapshotStr(cdp, sessionId, true, true, previousFingerprints);
          previousFingerprints = snapResult.fingerprints;
          // Same rule as explicit snap --refs: fresh empty ref maps must replace
          // stale state, otherwise hints can suggest dead @eN from a prior screen.
          currentRefMap = snapResult.refMap;
          result = (result ?? '') + '\n\n' + snapResult.text;
        } catch (e) { process.stderr.write(`[auto-snap] ${e.message}\n`); }
      }

      // Contextual hints: append next-step suggestions to help the agent
      // pick the next action without guessing. Opt-out via --no-hints.
      // Only emit hints when the refMap is guaranteed FRESH for this command
      // (either auto-snap ran, or the user explicitly asked for `snap --refs`).
      // Without this guard, --no-snap or bare `snap` would emit hints pointing
      // to @eN from a prior page -- stale and dangerous.
      const shouldHint = !noHints && isRefMapFresh({ cmd, shouldSnap, noSnap, args });
      if (shouldHint) {
        try {
          const hints = generateHints({
            cmd,
            refMap: currentRefMap,
            lastFilledRef,
            hasPage: true,
          });
          const hintsText = renderHints(hints);
          if (hintsText) result = (result ?? '') + '\n\n' + hintsText;
        } catch (e) { process.stderr.write(`[hints] ${e.message}\n`); }
      }

      sessionStats.record(cmd, args, startMs, Date.now(), true, null);
      return { ok: true, result: result ?? '' };
    } catch (e) {
      auditResult.ok = false;
      audit(cmd, targetId, args, auditResult, config);
      sessionStats.record(cmd, args, startMs, Date.now(), false, e.message);
      return { ok: false, error: e.message };
    }
  }

  // Unix socket server com autenticação
  const server = net.createServer((conn) => {
    let buf = '';
    let authenticated = !config.socketAuth;

    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }

        if (!authenticated) {
          if (req.auth === authToken) {
            authenticated = true;
            conn.write(JSON.stringify({ ok: true, id: req.id || 0 }) + '\n');
          } else {
            conn.write(JSON.stringify({ ok: false, error: 'Authentication failed', id: req.id || 0 }) + '\n');
            conn.end();
          }
          continue;
        }

        handleCommand(req).then((res) => {
          const payload = JSON.stringify({ ...res, id: req.id }) + '\n';
          if (res.stopAfter) conn.end(payload, shutdown);
          else conn.write(payload);
        });
      }
    });
  });

  try { unlinkSync(sp); } catch { /* socket não existe */ }
  server.listen(sp);
}
