// Heap snapshot via HeapProfiler domain

import { writeFileSync } from 'fs';
import { resolveArtifactPath, timestamp } from '../artifacts.mjs';

export async function heapStr(cdp, sid, action, filePath) {
  if (!action) throw new Error('Usage: heap <target> snapshot [file]');

  if (action === 'snapshot') {
    const chunks = [];
    const off = cdp.onEvent('HeapProfiler.addHeapSnapshotChunk', (params) => {
      chunks.push(params.chunk);
    });

    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false }, sid);
    off();

    const out = resolveArtifactPath(filePath || null, 'heap', `heap-${timestamp()}.heapsnapshot`);
    writeFileSync(out, chunks.join(''));
    const sizeMB = (Buffer.byteLength(chunks.join('')) / (1024 * 1024)).toFixed(1);
    return `Heap snapshot saved to ${out} (${sizeMB}MB). Open in Chrome DevTools > Memory tab.`;
  }

  throw new Error('Usage: heap <target> snapshot [file]');
}
