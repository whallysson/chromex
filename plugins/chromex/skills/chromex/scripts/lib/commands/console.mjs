// Console: live capture, stored message list, and detail with stack traces

import { sleep } from '../utils.mjs';
import { emptyState, aggregate } from '../output.mjs';

// Pre-computed aggregates for a list of console entries.
// Returns { errors, warnings, info } counts; zero keys omitted by callers.
function bucketConsoleByType(entries) {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const e of entries) {
    const type = e.type;
    if (type === 'error') errors++;
    else if (type === 'warning' || type === 'warn') warnings++;
    else info++;
  }
  const meta = {};
  if (errors) meta.errors = errors;
  if (warnings) meta.warnings = warnings;
  if (info) meta.info = info;
  return meta;
}

export async function consoleStr(cdp, sid, durationMs = 5000) {
  const duration = parseInt(durationMs) || 5000;
  const entries = [];

  await cdp.send('Runtime.enable', {}, sid);

  const off = cdp.onEvent('Runtime.consoleAPICalled', (params) => {
    const type = params.type;
    const args = (params.args || []).map(a => {
      if (a.type === 'string') return a.value;
      if (a.type === 'number') return String(a.value);
      if (a.type === 'boolean') return String(a.value);
      if (a.type === 'undefined') return 'undefined';
      if (a.subtype === 'null') return 'null';
      return a.description || JSON.stringify(a.value) || `[${a.type}]`;
    });
    entries.push({
      ts: new Date().toISOString().slice(11, 23),
      type,
      msg: args.join(' '),
    });
  });

  await sleep(duration);
  off();

  if (entries.length === 0) return emptyState('console', `0 messages captured in ${duration}ms`);

  const header = aggregate('console', entries.length, bucketConsoleByType(entries));
  const rows = entries.map(e => {
    const prefix = e.type === 'error' ? 'ERR' : e.type === 'warn' ? 'WRN' : e.type.toUpperCase().slice(0, 3);
    return `[${e.ts}] ${prefix.padEnd(3)}  ${e.msg.substring(0, 200)}`;
  });
  return `${header}\n${rows.join('\n')}`;
}

export function consoleListStr(consoleMessages) {
  if (consoleMessages.length === 0) return emptyState('console', '0 messages captured since daemon started');

  const header = aggregate('console', consoleMessages.length, bucketConsoleByType(consoleMessages));
  const msgs = consoleMessages.slice(-50);
  const rows = msgs.map(e => {
    const ts = new Date(e.ts).toISOString().slice(11, 23);
    const prefix = e.type === 'error' ? 'ERR' : e.type === 'warn' ? 'WRN' : e.type.toUpperCase().slice(0, 3);
    return `[${e.id}] ${ts} ${prefix.padEnd(3)}  ${e.args.join(' ').substring(0, 200)}`;
  });
  const truncNote = consoleMessages.length > 50
    ? `\n(showing last 50 of ${consoleMessages.length})`
    : '';
  return `${header}\n${rows.join('\n')}${truncNote}`;
}

export function consoleDetailStr(consoleMessages, msgId) {
  const id = parseInt(msgId);
  const msg = consoleMessages.find(m => m.id === id);
  if (!msg) return `Message #${msgId} not found. Use "console list" to see stored messages.`;

  const lines = [];
  lines.push(`${msg.type.toUpperCase()} #${msg.id} at ${new Date(msg.ts).toISOString()}`);
  lines.push(msg.args.join(' '));

  if (msg.stackTrace?.callFrames?.length) {
    lines.push('\nStack Trace:');
    for (const f of msg.stackTrace.callFrames) {
      const loc = f.url ? `${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}` : '(native)';
      lines.push(`  at ${f.functionName || '(anonymous)'} (${loc})`);
    }
  }

  return lines.join('\n');
}
