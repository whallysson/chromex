import { parentPort } from 'worker_threads';
import { HeapAnalysisStore } from './heap-analysis.mjs';

const store = new HeapAnalysisStore();

parentPort.on('message', ({ id, action, args }) => {
  try {
    parentPort.postMessage({ id, ok: true, result: store.execute(action, args) });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: error.message });
  }
});
