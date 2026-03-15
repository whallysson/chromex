// Performance tracing via Tracing domain

import { writeFileSync } from 'fs';

let tracing = false;
const chunks = [];

export async function traceStr(cdp, sid, action, fileOrCategories) {
  if (!action) throw new Error('Usage: trace <target> start [categories] | stop [file]');

  switch (action) {
    case 'start': {
      if (tracing) return 'Tracing already active.';
      chunks.length = 0;
      tracing = true;

      cdp.onEvent('Tracing.dataCollected', (params) => {
        if (params.value) chunks.push(...params.value);
      });

      const categories = fileOrCategories || 'devtools.timeline,v8.execute';
      await cdp.send('Tracing.start', {
        traceConfig: {
          recordMode: 'recordUntilFull',
          includedCategories: categories.split(','),
        },
      }, sid);
      return `Tracing started (categories: ${categories.substring(0, 60)}...). Use "trace <target> stop [file]" to save.`;
    }

    case 'stop': {
      if (!tracing) return 'No trace active.';
      tracing = false;

      await cdp.send('Tracing.end', {}, sid);
      // Aguardar Tracing.tracingComplete
      try {
        await cdp.waitForEvent('Tracing.tracingComplete', 30000).promise;
      } catch { /* timeout ok, já temos os chunks */ }

      const out = fileOrCategories || '/tmp/chromex-trace.json';
      writeFileSync(out, JSON.stringify(chunks));
      const count = chunks.length;
      chunks.length = 0;
      return `Trace saved to ${out} (${count} events). Open in chrome://tracing or Perfetto UI.`;
    }

    default:
      throw new Error('Usage: trace <target> start [categories] | stop [file]');
  }
}
