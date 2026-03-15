// Navegação + wait for document ready

import { sleep } from '../utils.mjs';
import { checkDomain } from '../security.mjs';
import { evalStr } from './evaluate.mjs';

export async function waitForDocumentReady(cdp, sid, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = '';
  let lastError;
  while (Date.now() < deadline) {
    try {
      const state = await evalStr(cdp, sid, 'document.readyState');
      lastState = state;
      if (state === 'complete') return;
    } catch (e) {
      lastError = e;
    }
    await sleep(200);
  }

  if (lastState) throw new Error(`Timed out waiting for navigation (last readyState: ${lastState})`);
  if (lastError) throw new Error(`Timed out waiting for navigation (${lastError.message})`);
  throw new Error('Timed out waiting for navigation');
}

export async function navStr(cdp, sid, url, config) {
  const domainError = checkDomain(url, config);
  if (domainError) throw new Error(domainError);

  await cdp.send('Page.enable', {}, sid);
  const loadEvent = cdp.waitForEvent('Page.loadEventFired', config.navigationTimeout);
  const result = await cdp.send('Page.navigate', { url }, sid);
  if (result.errorText) {
    loadEvent.cancel();
    throw new Error(result.errorText);
  }
  if (result.loaderId) {
    await loadEvent.promise;
  } else {
    loadEvent.cancel();
  }
  await waitForDocumentReady(cdp, sid, 5000);
  return `Navigated to ${url}`;
}
