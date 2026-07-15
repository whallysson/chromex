// Console: live capture, stored message list, and detail with stack traces

import { sleep } from '../utils.mjs';
import { emptyState, aggregate } from '../output.mjs';
import { redactObject, redactUrl } from '../redaction.mjs';

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

export async function consoleStr(cdp, sid, durationMs = 5000, options = {}) {
  const duration = parseInt(durationMs) || 5000;
  const entries = [];

  await cdp.send('Runtime.enable', {}, sid);

  const off = cdp.onEvent('Runtime.consoleAPICalled', (params, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
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
    const message = redactObject(e.msg, options);
    return `[${e.ts}] ${prefix.padEnd(3)}  ${String(message).substring(0, 200)}`;
  });
  return `${header}\n${rows.join('\n')}`;
}

export function consoleListStr(consoleMessages, options = {}) {
  return consoleListResult(consoleMessages, options).text;
}

export function consoleListResult(consoleMessages, options = {}) {
  const filters = normalizeOptions(options);
  if (consoleMessages.length === 0) return { text: emptyState('console', '0 messages captured since daemon started'), data: { messages: [], total: 0, nextCursor: null, filters } };
  const filtered = consoleMessages.filter(message => matchesMessage(message, filters));
  if (!filtered.length) return { text: emptyState('console', '0 messages match the active filters'), data: { messages: [], total: 0, capturedTotal: consoleMessages.length, nextCursor: null, filters } };

  const header = aggregate('console', filtered.length, bucketConsoleByType(filtered));
  const end = Math.max(0, filtered.length - filters.cursor);
  const start = Math.max(0, end - filters.limit);
  const msgs = filtered.slice(start, end);
  const nextCursor = start > 0 ? String(filters.cursor + msgs.length) : null;
  const rows = msgs.map(e => {
    const ts = new Date(e.ts).toISOString().slice(11, 23);
    const prefix = e.type === 'error' ? 'ERR' : e.type === 'warn' ? 'WRN' : e.type.toUpperCase().slice(0, 3);
    const args = redactObject(e.args, options);
    return `[${e.id}] ${ts} ${prefix.padEnd(3)}  ${args.join(' ').substring(0, 200)}`;
  });
  const truncNote = msgs.length < filtered.length
    ? `\n(${filters.cursor === 0 ? `showing last ${msgs.length}` : `showing ${start + 1}-${end}`} of ${filtered.length}${nextCursor ? `; next cursor ${nextCursor}` : ''})`
    : '';
  return {
    text: `${header}\n${rows.join('\n')}${truncNote}`,
    data: {
      messages: msgs.map(message => redactObject(message, options)),
      total: filtered.length,
      capturedTotal: consoleMessages.length,
      nextCursor,
      filters,
      sensitiveIncluded: !!options.includeSensitive,
    },
  };
}

export function consoleDetailStr(consoleMessages, msgId, options = {}) {
  return consoleDetailResult(consoleMessages, msgId, options).text;
}

export function consoleDetailResult(consoleMessages, msgId, options = {}) {
  const id = parseInt(msgId);
  const msg = consoleMessages.find(m => m.id === id);
  if (!msg) return { text: `Message #${msgId} not found. Use "console list" to see stored messages.`, data: { found: false, messageId: msgId } };

  const lines = [];
  lines.push(`${msg.type.toUpperCase()} #${msg.id} at ${new Date(msg.ts).toISOString()}`);
  const safeArgs = redactObject(msg.args, options);
  lines.push(safeArgs.join(' '));

  if (msg.stackTrace?.callFrames?.length) {
    lines.push('\nStack Trace:');
    for (const f of msg.stackTrace.callFrames) {
      const loc = f.url ? `${redactUrl(f.url, options)}:${f.lineNumber + 1}:${f.columnNumber + 1}` : '(native)';
      lines.push(`  at ${f.functionName || '(anonymous)'} (${loc})`);
    }
  }

  return { text: lines.join('\n'), data: { found: true, message: redactObject(msg, options), sensitiveIncluded: !!options.includeSensitive } };
}

function normalizeOptions(options) {
  return {
    type: String(options.type || '').toLowerCase(),
    query: String(options.query || '').toLowerCase(),
    limit: Math.max(1, Math.min(200, Number(options.limit) || 50)),
    cursor: Math.max(0, Number(options.cursor) || 0),
  };
}

function matchesMessage(message, filters) {
  const type = String(message.type || '').toLowerCase();
  if (filters.type && type !== filters.type && !(filters.type === 'warning' && type === 'warn')) return false;
  if (filters.query && !String(message.args?.join(' ') || '').toLowerCase().includes(filters.query)) return false;
  return true;
}
