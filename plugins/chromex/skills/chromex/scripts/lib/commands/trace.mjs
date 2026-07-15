import { closeSync, existsSync, openSync, readFileSync, writeSync } from 'fs';
import { resolveArtifactPath, resolveChromexPath, timestamp } from '../artifacts.mjs';

let tracing = false;
let collectedEvents = [];
let stopCollecting = null;
let lastTracePath = null;

export async function traceStr(cdp, sid, action, arg, detail) {
  const normalized = String(action || '').toLowerCase();
  if (normalized === 'start') return startTrace(cdp, sid, arg);
  if (normalized === 'stop') return stopTrace(cdp, sid, arg);
  if (normalized === 'insights') return traceInsights(arg || lastTracePath);
  if (normalized === 'insight') return traceInsights(detail || lastTracePath, arg);
  throw new Error('Usage: trace <target> start [categories] | stop [file] | insights [file] | insight <type> [file]');
}

async function startTrace(cdp, sid, categoriesArg) {
  if (tracing) return { text: 'Tracing already active.', data: { active: true } };
  collectedEvents = [];
  stopCollecting = cdp.onEvent('Tracing.dataCollected', (params, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
    if (params.value) collectedEvents.push(...params.value);
  });
  const categories = categoriesArg || 'devtools.timeline,v8.execute,disabled-by-default-devtools.timeline';
  await cdp.send('Tracing.start', {
    transferMode: 'ReturnAsStream',
    traceConfig: {
      recordMode: 'recordContinuously',
      includedCategories: categories.split(','),
    },
  }, sid);
  tracing = true;
  return { text: `Tracing started (categories: ${categories.substring(0, 80)}).`, data: { active: true, categories: categories.split(',') } };
}

async function stopTrace(cdp, sid, filePath) {
  if (!tracing) return { text: 'No trace active.', data: { active: false } };
  const completion = cdp.waitForEvent('Tracing.tracingComplete', 30000);
  await cdp.send('Tracing.end', {}, sid);
  let completed = {};
  try { completed = await completion.promise; } catch {}
  tracing = false;
  stopCollecting?.();
  stopCollecting = null;
  const path = resolveArtifactPath(filePath || null, 'traces', `trace-${timestamp()}.json`);
  const bytes = completed.stream
    ? await writeTraceStream(cdp, sid, completed.stream, path)
    : writeCollectedEvents(path);
  lastTracePath = path;
  collectedEvents = [];
  return { text: `Trace saved to ${path} (${formatBytes(bytes)}). Open in Perfetto UI or run trace insights.`, data: { active: false, bytes }, artifacts: [{ type: 'trace', path }] };
}

async function writeTraceStream(cdp, sid, handle, path) {
  const fd = openSync(path, 'w', 0o600);
  let bytes = 0;
  try {
    let eof = false;
    while (!eof) {
      const chunk = await cdp.send('IO.read', { handle, size: 1024 * 1024 }, sid);
      const data = chunk.base64Encoded ? Buffer.from(chunk.data || '', 'base64') : Buffer.from(chunk.data || '');
      if (data.length) {
        writeSync(fd, data);
        bytes += data.length;
      }
      eof = !!chunk.eof;
    }
  } finally {
    closeSync(fd);
    await cdp.send('IO.close', { handle }, sid).catch(() => {});
  }
  return bytes;
}

function writeCollectedEvents(path) {
  const payload = Buffer.from(JSON.stringify(collectedEvents));
  const fd = openSync(path, 'w', 0o600);
  try { writeSync(fd, payload); } finally { closeSync(fd); }
  return payload.length;
}

function traceInsights(filePath, type) {
  if (!filePath) throw new Error('Trace file required. Run trace start/stop first or provide a file.');
  const path = resolveChromexPath(filePath);
  if (!existsSync(path)) throw new Error(`Trace file not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const events = Array.isArray(parsed) ? parsed : parsed.traceEvents || [];
  const insights = buildInsights(events);
  const selected = type ? insights.filter(item => item.type === type) : insights;
  if (type && !selected.length) throw new Error(`Insight type not found: ${type}. Available: ${[...new Set(insights.map(item => item.type))].join(', ') || 'none'}`);
  const lines = [`Trace insights: ${selected.length} findings`];
  for (const item of selected.slice(0, 100)) lines.push(`  ${item.severity.toUpperCase()} ${item.type} ${item.summary}`);
  return { text: lines.join('\n'), data: { path, insights: selected, totalEvents: events.length }, artifacts: [{ type: 'trace', path }] };
}

function buildInsights(events) {
  const findings = [];
  const longTasks = events.filter(event => event.name === 'RunTask' && Number(event.dur) >= 50000).sort((a, b) => b.dur - a.dur);
  for (const event of longTasks.slice(0, 20)) findings.push({ type: 'long-task', severity: event.dur >= 200000 ? 'high' : 'medium', summary: `${(event.dur / 1000).toFixed(1)}ms at ${(event.ts / 1000).toFixed(1)}ms`, event });
  const layouts = events.filter(event => ['Layout', 'UpdateLayoutTree'].includes(event.name) && Number(event.dur) >= 16000).sort((a, b) => b.dur - a.dur);
  for (const event of layouts.slice(0, 20)) findings.push({ type: 'expensive-layout', severity: event.dur >= 50000 ? 'high' : 'medium', summary: `${event.name} ${(event.dur / 1000).toFixed(1)}ms`, event });
  const gcEvents = events.filter(event => /GC$|GarbageCollection/i.test(event.name) && Number(event.dur) >= 10000).sort((a, b) => b.dur - a.dur);
  for (const event of gcEvents.slice(0, 20)) findings.push({ type: 'gc-pause', severity: event.dur >= 50000 ? 'high' : 'low', summary: `${event.name} ${(event.dur / 1000).toFixed(1)}ms`, event });
  const shifts = events.filter(event => /LayoutShift/i.test(event.name));
  if (shifts.length) findings.push({ type: 'layout-shifts', severity: shifts.length >= 5 ? 'medium' : 'low', summary: `${shifts.length} layout shift events`, count: shifts.length });
  if (!findings.length) findings.push({ type: 'overview', severity: 'low', summary: `No long tasks, expensive layouts, or material GC pauses in ${events.length} events.` });
  return findings;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
