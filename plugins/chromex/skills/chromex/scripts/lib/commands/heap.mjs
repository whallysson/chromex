import { closeSync, openSync, writeSync } from 'fs';
import { Worker } from 'worker_threads';
import { resolveArtifactPath, timestamp } from '../artifacts.mjs';

let lastSnapshotPath = null;
let worker = null;
let requestId = 0;
const pending = new Map();

export async function heapStr(cdp, sid, action, ...args) {
  const normalized = String(action || '').toLowerCase();
  if (normalized === 'snapshot') return takeSnapshot(cdp, sid, args[0]);
  if (!['close', 'summary', 'details', 'class-nodes', 'dominators', 'duplicate-strings', 'edges', 'retainers', 'retaining-paths', 'compare'].includes(normalized)) {
    throw new Error('Usage: heap <target> snapshot|close|summary|details|class-nodes|dominators|duplicate-strings|edges|retainers|retaining-paths|compare [args]');
  }
  const payload = analysisArgs(normalized, args);
  return analyze(normalized, payload);
}

async function takeSnapshot(cdp, sid, filePath) {
  const path = resolveArtifactPath(filePath || null, 'heap', `heap-${timestamp()}.heapsnapshot`);
  const fd = openSync(path, 'w', 0o600);
  let bytes = 0;
  const off = cdp.onEvent('HeapProfiler.addHeapSnapshotChunk', ({ chunk }, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
    if (!chunk) return;
    const buffer = Buffer.from(chunk);
    writeSync(fd, buffer);
    bytes += buffer.length;
  });
  try {
    await cdp.send('HeapProfiler.enable', {}, sid);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, sid);
  } finally {
    off();
    closeSync(fd);
  }
  lastSnapshotPath = path;
  return { text: `Heap snapshot saved to ${path} (${formatBytes(bytes)}).`, data: { bytes }, artifacts: [{ type: 'heap-snapshot', path }] };
}

function analysisArgs(action, args) {
  if (action === 'close') return { filePath: args[0] };
  if (action === 'compare') return { filePath: args[0] || lastSnapshotPath, otherFilePath: args[1], limit: args[2] };
  const filePath = args[0] || lastSnapshotPath;
  if (action === 'summary' || action === 'duplicate-strings') return { filePath, limit: args[1] };
  if (action === 'class-nodes') return { filePath, className: args[1], limit: args[2] };
  if (action === 'dominators') return { filePath, node: args[1], limit: args[2] };
  if (action === 'retaining-paths') return { filePath, node: args[1], limit: args[2], depth: args[3] };
  return { filePath, node: args[1], limit: args[2] };
}

function analyze(action, args) {
  const activeWorker = getWorker();
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    activeWorker.postMessage({ id, action, args });
  });
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('../heap-worker.mjs', import.meta.url));
  worker.unref();
  worker.on('message', message => {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.ok) request.resolve(message.result);
    else request.reject(new Error(message.error));
  });
  worker.on('error', error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker = null;
  });
  worker.on('exit', () => { worker = null; });
  return worker;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
