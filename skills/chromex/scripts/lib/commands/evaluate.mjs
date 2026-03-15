// Eval JS + evalraw CDP

import { isCdpMethodBlocked } from '../security.mjs';

export async function evalStr(cdp, sid, expression) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const val = result.result.value;
  return typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? '');
}

export async function evalRawStr(cdp, sid, method, paramsJson, config) {
  if (!method) throw new Error('CDP method required (e.g. "DOM.getDocument")');

  if (isCdpMethodBlocked(method, config)) {
    throw new Error(`CDP method "${method}" is blocked by security config. Edit ~/.chromex/config.json to change.`);
  }

  let params = {};
  if (paramsJson) {
    try { params = JSON.parse(paramsJson); }
    catch { throw new Error(`Invalid JSON params: ${paramsJson}`); }
  }
  const result = await cdp.send(method, params, sid);
  return JSON.stringify(result, null, 2);
}
