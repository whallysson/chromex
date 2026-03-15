// Wait for lifecycle events (networkidle, load, domready)

import { sleep } from '../utils.mjs';
import { evalStr } from './evaluate.mjs';

export async function waitLifecycleStr(cdp, sid, event, timeoutMs, config) {
  const timeout = parseInt(timeoutMs) || config?.navigationTimeout || 30000;
  const eventMap = {
    'networkidle': 'networkIdle',
    'network-idle': 'networkIdle',
    'load': 'load',
    'domready': 'DOMContentLoaded',
    'dom-ready': 'DOMContentLoaded',
    'domcontentloaded': 'DOMContentLoaded',
    'fcp': 'firstContentfulPaint',
    'firstcontentfulpaint': 'firstContentfulPaint',
  };

  if (!event) throw new Error('Event required: networkidle, load, domready, fcp');

  const cdpEvent = eventMap[event.toLowerCase()];
  if (!cdpEvent) {
    throw new Error(`Unknown event: ${event}. Available: ${Object.keys(eventMap).join(', ')}`);
  }

  // Checar se o estado já foi atingido (para load/domready)
  if (cdpEvent === 'load' || cdpEvent === 'DOMContentLoaded') {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      if (cdpEvent === 'DOMContentLoaded' && (state === 'interactive' || state === 'complete')) {
        return `${event} already reached (readyState: ${state})`;
      }
      if (cdpEvent === 'load' && state === 'complete') {
        return `${event} already reached (readyState: complete)`;
      }
    } catch { /* pagina pode estar navegando */ }
  }

  // Para networkIdle: poll baseado em performance API
  if (cdpEvent === 'networkIdle') {
    const start = Date.now();
    const deadline = start + timeout;
    let idleCount = 0;
    while (Date.now() < deadline) {
      try {
        const pending = await evalStr(cdp, sid,
          'performance.getEntriesByType("resource").filter(e => e.responseEnd === 0).length'
        );
        if (pending === '0') {
          idleCount++;
          if (idleCount >= 3) return `networkidle reached (waited ${Date.now() - start}ms)`;
        } else {
          idleCount = 0;
        }
      } catch { /* pagina pode estar navegando */ }
      await sleep(500);
    }
    throw new Error(`Timeout (${timeout}ms) waiting for networkidle`);
  }

  // Para outros eventos: usar Page.lifecycleEvent
  await cdp.send('Page.enable', {}, sid);
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sid);

  const start = Date.now();
  return new Promise((resolve, reject) => {
    let settled = false;
    const off = cdp.onEvent('Page.lifecycleEvent', (params) => {
      if (params.name === cdpEvent && !settled) {
        settled = true;
        off();
        resolve(`${event} reached (waited ${Date.now() - start}ms)`);
      }
    });

    setTimeout(() => {
      if (!settled) {
        settled = true;
        off();
        reject(new Error(`Timeout (${timeout}ms) waiting for ${event}`));
      }
    }, timeout);
  });
}
