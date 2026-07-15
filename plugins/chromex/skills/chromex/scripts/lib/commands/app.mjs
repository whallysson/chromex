// Application state inspection: Service Workers, Cache Storage, IndexedDB, manifest, and quota.

import { aggregate, emptyState, formatBytes } from '../output.mjs';
import { sleep } from '../utils.mjs';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PREVIEW = 4000;
const EVENT_SETTLE_MS = 250;

async function pageInfo(cdp, sid) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression: `({
      href: location.href,
      origin: location.origin,
      protocol: location.protocol,
      title: document.title
    })`,
    returnByValue: true,
    awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  const info = result.result.value || {};
  if (!info.origin || info.origin === 'null' || !/^https?:$/.test(info.protocol || '')) {
    throw new Error(`Application state commands require an http(s) page origin. Current URL: ${info.href || 'unknown'}`);
  }
  return info;
}

function truncate(value, max = 120) {
  const str = String(value ?? '');
  return str.length > max ? `${str.slice(0, max)}...` : str;
}

function remoteValue(obj) {
  if (!obj) return '';
  if ('value' in obj) {
    if (typeof obj.value === 'string') return obj.value;
    try { return JSON.stringify(obj.value); } catch { return String(obj.value); }
  }
  return obj.description || obj.unserializableValue || obj.type || '';
}

function keyPathStr(keyPath) {
  if (!keyPath) return 'null';
  if (keyPath.type === 'string') return keyPath.string || '';
  if (keyPath.type === 'array') return `[${(keyPath.array || []).join(',')}]`;
  return keyPath.type || 'null';
}

function parseLimit(value, fallback = DEFAULT_PAGE_SIZE) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, 100);
}

function readOption(args, name) {
  const prefix = `--${name}=`;
  const eq = args.find(arg => arg?.startsWith(prefix));
  if (eq) return eq.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1) return args[idx + 1];
  return null;
}

function positionalArgs(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg?.startsWith('--')) {
      out.push(arg);
      continue;
    }
    if (!arg.includes('=') && args[i + 1] && !args[i + 1].startsWith('--')) i++;
  }
  return out;
}

function plural(count, singular, pluralWord = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralWord}`;
}

function resolveByPrefix(value, candidates, label, getId = x => x) {
  if (!value) throw new Error(`${label} required`);
  const exact = candidates.find(item => getId(item) === value);
  if (exact) return exact;
  const matches = candidates.filter(item => String(getId(item)).startsWith(value));
  if (matches.length === 0) throw new Error(`No ${label} matching "${value}"`);
  if (matches.length > 1) throw new Error(`Ambiguous ${label} prefix "${value}". Use more characters.`);
  return matches[0];
}

async function storageUsage(cdp, sid) {
  const { origin } = await pageInfo(cdp, sid);
  return cdp.send('Storage.getUsageAndQuota', { origin }, sid);
}

function formatUsage(origin, usage) {
  const meta = {
    used: formatBytes(usage.usage),
    quota: formatBytes(usage.quota),
  };
  if (usage.overrideActive) meta.override = 'yes';
  const lines = [aggregate('storage', usage.usageBreakdown?.length || 0, meta)];
  lines.push(`origin: ${origin}`);
  for (const item of usage.usageBreakdown || []) {
    if (!item.usage) continue;
    lines.push(`${String(item.storageType).padEnd(24)} ${formatBytes(item.usage).padStart(10)}`);
  }
  return lines.join('\n');
}

export async function storageUsageStr(cdp, sid) {
  const info = await pageInfo(cdp, sid);
  const usage = await cdp.send('Storage.getUsageAndQuota', { origin: info.origin }, sid);
  return formatUsage(info.origin, usage);
}

export async function clearSiteDataStr(cdp, sid, storageTypes = 'all') {
  const { origin } = await pageInfo(cdp, sid);
  await cdp.send('Storage.clearDataForOrigin', { origin, storageTypes }, sid);
  return `Cleared site data for ${origin} (${storageTypes}).`;
}

async function cacheNames(cdp, sid) {
  const { origin } = await pageInfo(cdp, sid);
  const { caches } = await cdp.send('CacheStorage.requestCacheNames', { securityOrigin: origin }, sid);
  return { origin, caches: caches || [] };
}

async function cacheEntryCount(cdp, sid, cacheId, pathFilter = '') {
  const result = await cdp.send('CacheStorage.requestEntries', {
    cacheId,
    skipCount: 0,
    pageSize: 1,
    pathFilter,
  }, sid);
  return result.returnCount ?? result.cacheDataEntries?.length ?? 0;
}

async function cacheSummary(cdp, sid) {
  const { origin, caches } = await cacheNames(cdp, sid);
  let entries = 0;
  for (const cache of caches) {
    try { entries += await cacheEntryCount(cdp, sid, cache.cacheId); }
    catch { /* Some opaque caches may not expose entries. */ }
  }
  return { origin, caches, entries };
}

export async function cacheStr(cdp, sid, action = 'list', ...args) {
  const normalized = action || 'list';
  if (normalized === 'list') {
    const { origin, caches } = await cacheNames(cdp, sid);
    if (caches.length === 0) return emptyState('cache', `0 caches for ${origin}`);
    const lines = [aggregate('cache', caches.length, { origin })];
    for (const cache of caches) {
      lines.push(`${cache.cacheId}  ${cache.cacheName || '(unnamed)'}`);
    }
    return lines.join('\n');
  }

  const { caches } = await cacheNames(cdp, sid);
  const positionals = positionalArgs(args);
  const cacheArg = positionals[0];
  const cache = resolveByPrefix(cacheArg, caches, 'cacheId', c => c.cacheId);

  if (normalized === 'entries') {
    const query = readOption(args, 'query');
    const limitOption = readOption(args, 'limit');
    const firstAfterCache = positionals[1];
    const secondAfterCache = positionals[2];
    const limit = parseLimit(limitOption || (Number.isFinite(Number.parseInt(firstAfterCache, 10)) ? firstAfterCache : null));
    const pathFilter = query || (Number.isFinite(Number.parseInt(firstAfterCache, 10)) ? secondAfterCache : firstAfterCache) || '';
    const result = await cdp.send('CacheStorage.requestEntries', {
      cacheId: cache.cacheId,
      skipCount: 0,
      pageSize: limit,
      pathFilter,
    }, sid);
    const entries = result.cacheDataEntries || [];
    if (entries.length === 0) return emptyState('cache', `0 entries in ${cache.cacheName || cache.cacheId}`);
    const lines = [aggregate('cache.entries', result.returnCount ?? entries.length, {
      shown: entries.length,
      cache: cache.cacheName || cache.cacheId,
    })];
    for (const entry of entries) {
      const status = entry.responseStatus ? `${entry.responseStatus}` : '...';
      const method = entry.requestMethod || 'GET';
      lines.push(`${status.padStart(3)} ${method.padEnd(7)} ${entry.requestURL}`);
    }
    return lines.join('\n');
  }

  if (normalized === 'body') {
    const requestArg = positionals[1];
    if (!requestArg) throw new Error('requestURL required');
    const { response } = await cdp.send('CacheStorage.requestCachedResponse', {
      cacheId: cache.cacheId,
      requestURL: requestArg,
      requestHeaders: [],
    }, sid);
    const buf = Buffer.from(response?.body || '', 'base64');
    const text = buf.toString('utf8');
    const preview = text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n... [truncated ${text.length - MAX_PREVIEW} chars]` : text;
    return `cache body ${formatBytes(buf.length)}\n${preview}`;
  }

  if (normalized === 'delete-entry') {
    const requestArg = positionals[1];
    if (!requestArg) throw new Error('requestURL required');
    await cdp.send('CacheStorage.deleteEntry', { cacheId: cache.cacheId, request: requestArg }, sid);
    return `Deleted cache entry from ${cache.cacheName || cache.cacheId}: ${requestArg}`;
  }

  if (normalized === 'delete') {
    await cdp.send('CacheStorage.deleteCache', { cacheId: cache.cacheId }, sid);
    return `Deleted cache: ${cache.cacheName || cache.cacheId}`;
  }

  throw new Error('Unknown cache action. Use: list, entries, body, delete-entry, delete');
}

async function getDatabaseNames(cdp, sid) {
  const { origin } = await pageInfo(cdp, sid);
  await cdp.send('IndexedDB.enable', {}, sid);
  const { databaseNames: names } = await cdp.send('IndexedDB.requestDatabaseNames', { securityOrigin: origin }, sid);
  return { origin, databaseNames: names || [] };
}

export async function idbStr(cdp, sid, action = 'list', ...args) {
  const normalized = action || 'list';
  const positionals = positionalArgs(args);
  const databaseName = positionals[0];

  if (normalized === 'list') {
    const { origin, databaseNames } = await getDatabaseNames(cdp, sid);
    if (databaseNames.length === 0) return emptyState('idb', `0 databases for ${origin}`);
    return [aggregate('idb', databaseNames.length, { origin }), ...databaseNames].join('\n');
  }

  if (!databaseName) throw new Error('databaseName required');
  const { origin } = await pageInfo(cdp, sid);
  await cdp.send('IndexedDB.enable', {}, sid);

  if (normalized === 'schema') {
    const { databaseWithObjectStores } = await cdp.send('IndexedDB.requestDatabase', {
      securityOrigin: origin,
      databaseName,
    }, sid);
    const db = databaseWithObjectStores;
    if (!db) return emptyState('idb.schema', `database not found: ${databaseName}`);
    const stores = db.objectStores || [];
    const lines = [aggregate('idb.schema', stores.length, { database: db.name, version: db.version })];
    for (const store of stores) {
      const indexes = store.indexes || [];
      lines.push(`${store.name}  keyPath:${keyPathStr(store.keyPath)}  autoIncrement:${store.autoIncrement ? 'yes' : 'no'}  indexes:${indexes.length}`);
      for (const index of indexes) {
        lines.push(`  index ${index.name}  keyPath:${keyPathStr(index.keyPath)}  unique:${index.unique ? 'yes' : 'no'}  multiEntry:${index.multiEntry ? 'yes' : 'no'}`);
      }
    }
    return lines.join('\n');
  }

  const objectStoreName = positionals[1];
  if (!objectStoreName) throw new Error('objectStoreName required');

  if (normalized === 'rows') {
    const pageSize = parseLimit(readOption(args, 'limit') || positionals[2]);
    const result = await cdp.send('IndexedDB.requestData', {
      securityOrigin: origin,
      databaseName,
      objectStoreName,
      skipCount: 0,
      pageSize,
    }, sid);
    const entries = result.objectStoreDataEntries || [];
    if (entries.length === 0) return emptyState('idb.rows', `0 rows in ${databaseName}.${objectStoreName}`);
    const lines = [aggregate('idb.rows', entries.length, {
      database: databaseName,
      store: objectStoreName,
      more: result.hasMore ? 'yes' : 'no',
    })];
    for (const entry of entries) {
      const key = truncate(remoteValue(entry.key), 60);
      const value = truncate(remoteValue(entry.value), 180);
      lines.push(`${String(key).padEnd(62)} ${value}`);
    }
    return lines.join('\n');
  }

  if (normalized === 'clear-store' || normalized === 'clear') {
    await cdp.send('IndexedDB.clearObjectStore', {
      securityOrigin: origin,
      databaseName,
      objectStoreName,
    }, sid);
    return `Cleared IndexedDB store: ${databaseName}.${objectStoreName}`;
  }

  throw new Error('Unknown idb action. Use: list, schema, rows, clear, clear-store');
}

async function collectServiceWorkers(cdp, sid, origin) {
  try { await cdp.send('ServiceWorker.disable', {}, sid); }
  catch { /* Some targets may not have the domain enabled yet. */ }

  const registrations = new Map();
  const versions = [];
  const offRegistrations = cdp.onEvent('ServiceWorker.workerRegistrationUpdated', (params, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
    for (const registration of params.registrations || []) {
      registrations.set(registration.registrationId, registration);
    }
  });
  const offVersions = cdp.onEvent('ServiceWorker.workerVersionUpdated', (params, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
    for (const version of params.versions || []) versions.push(version);
  });

  try {
    await cdp.send('ServiceWorker.enable', {}, sid);
    await sleep(EVENT_SETTLE_MS);
  } finally {
    offRegistrations();
    offVersions();
  }

  const regs = [...registrations.values()].filter(r => !r.isDeleted && r.scopeURL?.startsWith(`${origin}/`));
  const originVersions = versions.filter(v => v.scriptURL?.startsWith(`${origin}/`));
  return { registrations: regs, versions: originVersions };
}

function serviceWorkerCounts(versions) {
  return {
    active: versions.filter(v => v.status === 'activated').length,
    waiting: versions.filter(v => v.status === 'installed').length,
    installing: versions.filter(v => ['new', 'installing', 'activating'].includes(v.status)).length,
    redundant: versions.filter(v => v.status === 'redundant').length,
  };
}

function formatServiceWorkerSummary(state) {
  const counts = serviceWorkerCounts(state.versions);
  const parts = [
    `${counts.active} active`,
    `${counts.waiting} waiting`,
  ];
  if (counts.installing) parts.push(`${counts.installing} installing`);
  if (counts.redundant) parts.push(`${counts.redundant} redundant`);
  return `${parts.join(', ')} (${plural(state.registrations.length, 'registration')}, ${plural(state.versions.length, 'version')})`;
}

export async function serviceWorkersStr(cdp, sid, action = 'list', scopeURL) {
  const normalized = action || 'list';
  const { origin } = await pageInfo(cdp, sid);

  function assertCurrentOriginScope(url) {
    let parsed;
    try { parsed = new URL(url); }
    catch { throw new Error(`Invalid scopeURL: ${url}`); }
    if (parsed.origin !== origin) {
      throw new Error(`scopeURL must match current origin ${origin}`);
    }
  }

  if (normalized === 'update') {
    if (!scopeURL) throw new Error('scopeURL required');
    assertCurrentOriginScope(scopeURL);
    await cdp.send('ServiceWorker.updateRegistration', { scopeURL }, sid);
    return `Service worker update requested: ${scopeURL}`;
  }

  if (normalized === 'skip-waiting') {
    if (!scopeURL) throw new Error('scopeURL required');
    assertCurrentOriginScope(scopeURL);
    await cdp.send('ServiceWorker.skipWaiting', { scopeURL }, sid);
    return `Service worker skipWaiting requested: ${scopeURL}`;
  }

  if (normalized === 'unregister') {
    if (!scopeURL) throw new Error('scopeURL required');
    assertCurrentOriginScope(scopeURL);
    await cdp.send('ServiceWorker.unregister', { scopeURL }, sid);
    return `Service worker unregistered: ${scopeURL}`;
  }

  if (normalized !== 'list') {
    throw new Error('Unknown service worker action. Use: list, update, skip-waiting, unregister');
  }

  const { registrations: regs, versions: originVersions } = await collectServiceWorkers(cdp, sid, origin);
  if (regs.length === 0 && originVersions.length === 0) return emptyState('sw', `0 service workers observed for ${origin}`);

  const lines = [aggregate('sw', regs.length, { versions: originVersions.length })];
  for (const reg of regs) {
    lines.push(`${reg.scopeURL}  id:${reg.registrationId}`);
    const related = originVersions.filter(v => v.registrationId === reg.registrationId);
    for (const version of related) {
      const clients = version.controlledClients?.length ?? 0;
      lines.push(`  ${version.status}/${version.runningStatus} clients:${clients} ${version.scriptURL}`);
    }
  }
  const registrationIds = new Set(regs.map(r => r.registrationId));
  for (const version of originVersions.filter(v => !registrationIds.has(v.registrationId))) {
    const clients = version.controlledClients?.length ?? 0;
    lines.push(`${version.status}/${version.runningStatus} clients:${clients} ${version.scriptURL}`);
  }
  return lines.join('\n');
}

async function storageKeyInfo(cdp, sid) {
  const { storageKey } = await cdp.send('Storage.getStorageKey', {}, sid);
  return storageKey;
}

async function storageBuckets(cdp, sid) {
  const storageKey = await storageKeyInfo(cdp, sid);
  const buckets = new Map();
  const offBucket = cdp.onEvent('Storage.storageBucketCreatedOrUpdated', (params, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
    const info = params.bucketInfo;
    if (!info?.bucket || info.bucket.storageKey !== storageKey) return;
    buckets.set(info.id || `${info.bucket.storageKey}:${info.bucket.name || 'default'}`, info);
  });

  try {
    await cdp.send('Storage.setStorageBucketTracking', { storageKey, enable: true }, sid);
    await sleep(EVENT_SETTLE_MS);
  } finally {
    offBucket();
    try { await cdp.send('Storage.setStorageBucketTracking', { storageKey, enable: false }, sid); }
    catch { /* Older Chromium builds may not support bucket tracking. */ }
  }

  return { storageKey, buckets: [...buckets.values()] };
}

async function storageKeyCounts(cdp, sid) {
  await cdp.send('Runtime.enable', {}, sid);
  const result = await cdp.send('Runtime.evaluate', {
    expression: `({
      localStorage: localStorage.length,
      sessionStorage: sessionStorage.length
    })`,
    returnByValue: true,
    awaitPromise: true,
  }, sid);
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || result.exceptionDetails.exception?.description);
  }
  return result.result.value || {};
}

async function cookieCount(cdp, sid, url) {
  await cdp.send('Network.enable', {}, sid);
  try {
    const { cookies } = await cdp.send('Network.getCookies', { urls: [url] }, sid);
    return cookies?.length || 0;
  } finally {
    try { await cdp.send('Network.disable', {}, sid); } catch { /* Network may be shared with other daemon features. */ }
  }
}

async function manifestSummary(cdp, sid) {
  await cdp.send('Page.enable', {}, sid);
  const result = await cdp.send('Page.getAppManifest', {}, sid);
  const hasData = Boolean(result.data && result.data.trim());
  if (!hasData && !result.url) return { present: false, errors: result.errors || [] };
  let parsedData = null;
  if (hasData) {
    try { parsedData = JSON.parse(result.data); } catch { parsedData = null; }
  }
  const name = result.manifest?.name || result.manifest?.shortName || parsedData?.name || parsedData?.short_name || '';
  return {
    present: true,
    url: result.url || '',
    name,
    errors: result.errors || [],
  };
}

function appLine(label, value) {
  return `  ${label}: ${value}`;
}

export async function appStr(cdp, sid, action = 'summary') {
  const normalized = action || 'summary';
  if (normalized !== 'summary') throw new Error('Unknown app action. Use: summary');

  const info = await pageInfo(cdp, sid);
  const lines = ['app:', appLine('origin', info.origin), appLine('url', info.href)];

  try {
    const usage = await storageUsage(cdp, sid);
    const available = Math.max(0, (usage.quota || 0) - (usage.usage || 0));
    lines.push(appLine('quota', `${formatBytes(usage.usage)} used / ${formatBytes(available)} available (${formatBytes(usage.quota)} quota)`));
  } catch (e) {
    lines.push(appLine('quota', `unavailable (${e.message})`));
  }

  try {
    const counts = await storageKeyCounts(cdp, sid);
    lines.push(appLine('localStorage', `${counts.localStorage || 0} keys`));
    lines.push(appLine('sessionStorage', `${counts.sessionStorage || 0} keys`));
  } catch (e) {
    lines.push(appLine('localStorage', `unavailable (${e.message})`));
    lines.push(appLine('sessionStorage', `unavailable (${e.message})`));
  }

  try {
    lines.push(appLine('cookies', String(await cookieCount(cdp, sid, info.href))));
  } catch (e) {
    lines.push(appLine('cookies', `unavailable (${e.message})`));
  }

  try {
    const summary = await cacheSummary(cdp, sid);
    lines.push(appLine('caches', `${plural(summary.caches.length, 'cache')}, ${plural(summary.entries, 'entry', 'entries')}`));
  } catch (e) {
    lines.push(appLine('caches', `unavailable (${e.message})`));
  }

  try {
    const { databaseNames } = await getDatabaseNames(cdp, sid);
    lines.push(appLine('indexedDB', plural(databaseNames.length, 'database')));
  } catch (e) {
    lines.push(appLine('indexedDB', `unavailable (${e.message})`));
  }

  try {
    const state = await collectServiceWorkers(cdp, sid, info.origin);
    lines.push(appLine('serviceWorkers', formatServiceWorkerSummary(state)));
  } catch (e) {
    lines.push(appLine('serviceWorkers', `unavailable (${e.message})`));
  }

  try {
    const { buckets } = await storageBuckets(cdp, sid);
    lines.push(appLine('storageBuckets', plural(buckets.length, 'bucket')));
  } catch (e) {
    lines.push(appLine('storageBuckets', `unavailable (${e.message})`));
  }

  try {
    const manifest = await manifestSummary(cdp, sid);
    if (!manifest.present) {
      lines.push(appLine('manifest', 'absent'));
    } else {
      const errors = manifest.errors.length ? `, ${plural(manifest.errors.length, 'error')}` : '';
      const name = manifest.name ? ` (${manifest.name})` : '';
      lines.push(appLine('manifest', `present${name}${errors}`));
    }
  } catch (e) {
    lines.push(appLine('manifest', `unavailable (${e.message})`));
  }

  return lines.join('\n');
}
