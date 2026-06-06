import { readFileSync } from 'fs';
import { resolveChromexPath, timestamp, writeTextArtifact } from '../artifacts.mjs';
import { evalStr } from './evaluate.mjs';

export async function stateStr(cdp, sid, action, filePath) {
  if (action === 'save') return saveState(cdp, sid, filePath);
  if (action === 'load') return loadState(cdp, sid, filePath);
  throw new Error('Usage: state <target> save [file] | load <file>');
}

async function saveState(cdp, sid, filePath) {
  const url = await evalStr(cdp, sid, 'window.location.href');
  const origin = await evalStr(cdp, sid, 'window.location.origin');
  await cdp.send('Network.enable', {}, sid);
  const { cookies = [] } = await cdp.send('Network.getCookies', { urls: [url] }, sid);
  const localStorage = JSON.parse(await evalStr(cdp, sid, `
    JSON.stringify(Object.keys(localStorage).map(name => ({ name, value: localStorage.getItem(name) })))
  `));
  const state = {
    cookies: cookies.map(normalizeCookie),
    origins: [{ origin, localStorage }],
  };
  const artifact = writeTextArtifact(
    filePath || null,
    JSON.stringify(state, null, 2),
    'storage',
    `storage-state-${timestamp()}.json`
  );
  return {
    text: `Storage state saved to ${artifact.path} (${state.cookies.length} cookies, ${localStorage.length} localStorage entries).`,
    data: { cookies: state.cookies.length, origins: state.origins.length, localStorage: localStorage.length },
    artifacts: [artifact],
  };
}

async function loadState(cdp, sid, filePath) {
  if (!filePath) throw new Error('State file required.');
  const statePath = resolveChromexPath(filePath);
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const currentOrigin = await evalStr(cdp, sid, 'window.location.origin');
  await cdp.send('Network.enable', {}, sid);
  let cookiesSet = 0;
  for (const cookie of state.cookies || []) {
    const result = await cdp.send('Network.setCookie', normalizeCookieForSet(cookie), sid);
    if (result.success !== false) cookiesSet++;
  }
  let localStorageSet = 0;
  let ignoredOrigins = 0;
  for (const originState of state.origins || []) {
    if (originState.origin !== currentOrigin) {
      ignoredOrigins++;
      continue;
    }
    const entries = Array.isArray(originState.localStorage) ? originState.localStorage : [];
    await evalStr(cdp, sid, `
      (function(entries) {
        for (const item of entries) localStorage.setItem(item.name, item.value);
      })(${JSON.stringify(entries)})
    `);
    localStorageSet += entries.length;
  }
  return {
    text: `Storage state loaded from ${statePath} (${cookiesSet} cookies, ${localStorageSet} localStorage entries, ${ignoredOrigins} ignored origins).`,
    data: { cookies: cookiesSet, localStorage: localStorageSet, ignoredOrigins },
    artifacts: [],
  };
}

function normalizeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path || '/',
    expires: cookie.expires ?? -1,
    httpOnly: !!cookie.httpOnly,
    secure: !!cookie.secure,
    sameSite: cookie.sameSite || 'Lax',
  };
}

function normalizeCookieForSet(cookie) {
  const normalized = normalizeCookie(cookie);
  if (normalized.expires === -1 || normalized.expires == null) delete normalized.expires;
  return normalized;
}
