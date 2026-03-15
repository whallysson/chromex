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
import { netStr } from './commands/network.mjs';
import { clickStr, clickXyStr, typeStr, loadAllStr, waitForStr } from './commands/interact.mjs';
import { fillStr, clearStr, selectStr, checkStr, formStr } from './commands/form.mjs';
import { scrollStr } from './commands/scroll.mjs';
import { cookiesStr } from './commands/cookies.mjs';
import { pdfStr } from './commands/pdf.mjs';
import { consoleStr } from './commands/console.mjs';
import { storageStr } from './commands/storage.mjs';
import { emulateStr } from './commands/emulate.mjs';
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

  // Ref-based selection state: stores mapping from @eN -> {backendNodeId, role, name}
  let currentRefMap = new Map();

  async function handleCommand({ cmd, args }) {
    resetIdle();
    const auditResult = { ok: true };
    try {
      // Ref-based dispatch: click @e5, fill @e3 "value", hover @e12
      if (args[0] && parseRef(args[0]) !== null) {
        const refNum = parseRef(args[0]);
        let result;
        if (cmd === 'click') {
          result = await clickRefStr(cdp, sessionId, currentRefMap, refNum);
        } else if (cmd === 'fill') {
          result = await fillRefStr(cdp, sessionId, currentRefMap, refNum, args.slice(1).join(' '));
        } else if (cmd === 'hover') {
          result = await hoverRefStr(cdp, sessionId, currentRefMap, refNum);
        } else {
          throw new Error(`Ref @e${refNum} not supported for command "${cmd}". Use with: click, fill, hover.`);
        }
        audit(cmd, targetId, args, auditResult, config);
        return { ok: true, result };
      }

      let result;
      switch (cmd) {
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
          const snapResult = await snapshotStr(cdp, sessionId, true, useRefs);
          result = snapResult.text;
          if (useRefs && snapResult.refMap.size > 0) {
            currentRefMap = snapResult.refMap;
          }
          break;
        }
        case 'eval':
          result = await evalStr(cdp, sessionId, args[0]);
          break;
        case 'shot': case 'screenshot': {
          const full = args.includes('--full');
          const file = args.find(a => a && a !== '--full');
          result = await shotStr(cdp, sessionId, file, full, config);
          break;
        }
        case 'html':
          result = await htmlStr(cdp, sessionId, args[0]);
          break;
        case 'nav': case 'navigate':
          result = await navStr(cdp, sessionId, args[0], config);
          break;
        case 'net': case 'network':
          result = await netStr(cdp, sessionId);
          break;
        case 'click':
          result = await clickStr(cdp, sessionId, args[0]);
          break;
        case 'clickxy':
          result = await clickXyStr(cdp, sessionId, args[0], args[1]);
          break;
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
        case 'console':
          result = await consoleStr(cdp, sessionId, args[0]);
          break;
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
      return { ok: true, result: result ?? '' };
    } catch (e) {
      auditResult.ok = false;
      audit(cmd, targetId, args, auditResult, config);
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
