// HAR (HTTP Archive) recording via Network domain

import { writeFileSync } from 'fs';

let recording = false;
const entries = [];
const requestMap = new Map();
let cleanupFns = [];

export async function harStr(cdp, sid, action, filePath) {
  if (!action) throw new Error('Usage: har <target> start | stop [file]');

  switch (action) {
    case 'start': {
      if (recording) return 'HAR recording already active.';
      entries.length = 0;
      requestMap.clear();

      await cdp.send('Network.enable', {}, sid);
      recording = true;

      const off1 = cdp.onEvent('Network.requestWillBeSent', (params) => {
        requestMap.set(params.requestId, {
          requestId: params.requestId,
          url: params.request.url,
          method: params.request.method,
          headers: params.request.headers,
          postData: params.request.postData,
          startTime: params.timestamp,
          wallTime: params.wallTime,
        });
      });

      const off2 = cdp.onEvent('Network.responseReceived', (params) => {
        const req = requestMap.get(params.requestId);
        if (req) {
          req.status = params.response.status;
          req.statusText = params.response.statusText;
          req.responseHeaders = params.response.headers;
          req.mimeType = params.response.mimeType;
          req.protocol = params.response.protocol;
        }
      });

      const off3 = cdp.onEvent('Network.loadingFinished', (params) => {
        const req = requestMap.get(params.requestId);
        if (req) {
          req.endTime = params.timestamp;
          req.encodedDataLength = params.encodedDataLength;
          entries.push(req);
          requestMap.delete(params.requestId);
        }
      });

      cleanupFns = [off1, off2, off3];
      return `HAR recording started. Use "har <target> stop [file]" to save.`;
    }

    case 'stop': {
      if (!recording) return 'No HAR recording active.';
      recording = false;
      cleanupFns.forEach(fn => fn());
      cleanupFns = [];

      const har = {
        log: {
          version: '1.2',
          creator: { name: 'chromex', version: '1.0.0' },
          entries: entries.map(e => ({
            startedDateTime: e.wallTime ? new Date(e.wallTime * 1000).toISOString() : new Date().toISOString(),
            time: e.endTime && e.startTime ? Math.round((e.endTime - e.startTime) * 1000) : 0,
            request: {
              method: e.method,
              url: e.url,
              headers: Object.entries(e.headers || {}).map(([n, v]) => ({ name: n, value: v })),
              postData: e.postData ? { mimeType: 'application/x-www-form-urlencoded', text: e.postData } : undefined,
            },
            response: {
              status: e.status || 0,
              statusText: e.statusText || '',
              headers: Object.entries(e.responseHeaders || {}).map(([n, v]) => ({ name: n, value: v })),
              content: { size: e.encodedDataLength || 0, mimeType: e.mimeType || '' },
            },
            cache: {},
            timings: {
              send: 0, wait: 0,
              receive: e.endTime && e.startTime ? Math.round((e.endTime - e.startTime) * 1000) : 0,
            },
          })),
        },
      };

      const out = filePath || '/tmp/chromex.har';
      writeFileSync(out, JSON.stringify(har, null, 2));
      return `HAR saved to ${out} (${entries.length} entries).`;
    }

    default:
      throw new Error('Usage: har <target> start | stop [file]');
  }
}
