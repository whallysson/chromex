// Captura de console.log/error/warn

import { sleep } from '../utils.mjs';

export async function consoleStr(cdp, sid, durationMs = 5000) {
  const duration = parseInt(durationMs) || 5000;
  const entries = [];

  await cdp.send('Runtime.enable', {}, sid);

  const off = cdp.onEvent('Runtime.consoleAPICalled', (params) => {
    const type = params.type; // log, error, warn, info, debug
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

  if (entries.length === 0) return `No console output captured in ${duration}ms.`;

  return entries.map(e => {
    const prefix = e.type === 'error' ? 'ERR' : e.type === 'warn' ? 'WRN' : e.type.toUpperCase().slice(0, 3);
    return `[${e.ts}] ${prefix.padEnd(3)}  ${e.msg.substring(0, 200)}`;
  }).join('\n');
}
