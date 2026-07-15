// Network: resource timing + CDP request detail

import { evalStr } from './evaluate.mjs';
import { emptyState, aggregate, formatBytes } from '../output.mjs';
import { redactHeaders, redactObject, redactText, redactUrl } from '../redaction.mjs';

export async function netStr(cdp, sid) {
  const raw = await evalStr(cdp, sid, `JSON.stringify(performance.getEntriesByType('resource').map(e => ({
    name: e.name.substring(0, 120), type: e.initiatorType,
    duration: Math.round(e.duration), size: e.transferSize
  })))`);
  const resources = JSON.parse(raw);
  if (resources.length === 0) return emptyState('network', '0 resources timed (page not loaded or resources cached)');

  // Pre-computed aggregates: total transfer size so agent doesn't need a follow-up sum.
  const totalSize = resources.reduce((s, e) => s + (e.size || 0), 0);
  const header = aggregate('network', resources.length, { size: formatBytes(totalSize) });

  const rows = resources.map(e =>
    `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
  );
  return `${header}\n${rows.join('\n')}`;
}

export function netListStr(networkRequests, options = {}) {
  return netListResult(networkRequests, options).text;
}

export function netListResult(networkRequests, options = {}) {
  const filters = normalizeListOptions(options);
  if (networkRequests.size === 0) return { text: emptyState('network', '0 requests captured since daemon started'), data: { requests: [], total: 0, nextCursor: null, filters } };
  const allEntries = [...networkRequests.entries()].filter(([, request]) => matchesRequest(request, filters));
  if (!allEntries.length) return { text: emptyState('network', '0 requests match the active filters'), data: { requests: [], total: 0, capturedTotal: networkRequests.size, nextCursor: null, filters } };
  let errors = 0;
  let pending = 0;
  let ok = 0;
  for (const [, r] of allEntries) {
    if (r.status == null) pending++;
    else if (r.status >= 400 || r.failed) errors++;
    else ok++;
  }
  const meta = {};
  if (errors) meta.errors = errors;
  if (pending) meta.pending = pending;
  if (ok) meta.ok = ok;
  const header = aggregate('network', allEntries.length, meta);
  const end = Math.max(0, allEntries.length - filters.cursor);
  const start = Math.max(0, end - filters.limit);
  const entries = allEntries.slice(start, end);
  const nextCursor = start > 0 ? String(filters.cursor + entries.length) : null;
  const tableHeader = `${'STATUS'.padStart(3)}  ${'METHOD'.padEnd(6)}  ${'ID'.padEnd(14)}  URL`;
  const rows = entries.map(([id, r]) => {
    const status = r.status != null ? String(r.status).padStart(3) : '...';
    const method = (r.method || 'GET').padEnd(6);
    return `  ${status}  ${method}  ${id.substring(0, 14).padEnd(14)}  ${redactUrl(r.url || '?', options).substring(0, 100)}`;
  });
  const truncNote = entries.length < allEntries.length
    ? `\n(${filters.cursor === 0 ? `showing last ${entries.length}` : `showing ${start + 1}-${end}`} of ${allEntries.length}${nextCursor ? `; next cursor ${nextCursor}` : ''})`
    : '';
  const requests = entries.map(([id, request]) => ({
    id,
    url: redactUrl(request.url || '', options),
    method: request.method || 'GET',
    status: request.status ?? null,
    statusText: request.statusText || null,
    type: request.type || null,
    mimeType: request.mimeType || null,
    completed: !!request.completed,
    failed: !!request.failed,
    encodedDataLength: request.encodedDataLength ?? null,
  }));
  return {
    text: `${header}\n${tableHeader}\n${rows.join('\n')}${truncNote}\n\nUse "net <target> <requestId>" for detail.`,
    data: { requests, total: allEntries.length, capturedTotal: networkRequests.size, nextCursor, filters },
  };
}

export async function netDetailStr(cdp, sid, requestId, networkRequests, options = {}) {
  return (await netDetailResult(cdp, sid, requestId, networkRequests, options)).text;
}

export async function netDetailResult(cdp, sid, requestId, networkRequests, options = {}) {
  const bodyLimit = Math.max(1, Math.min(1_000_000, Number(options.bodyLimit) || 2000));
  let req = networkRequests.get(requestId);
  if (!req) {
    const matches = [...networkRequests.keys()].filter(k => k.startsWith(requestId));
    if (matches.length === 0) return { text: `Request not found: ${requestId}. Run "net" to see all requests.`, data: { found: false, requestId } };
    if (matches.length > 1) {
      const list = matches.slice(0, 10).map(k => `  ${k}  ${redactUrl(networkRequests.get(k).url || '', options).substring(0, 80)}`).join('\n');
      return { text: `Ambiguous ID "${requestId}". Matches:\n${list}`, data: { found: false, ambiguous: true, matches } };
    }
    requestId = matches[0];
    req = networkRequests.get(requestId);
  }

  const lines = [];
  lines.push(`${req.method || 'GET'} ${redactUrl(req.url, options)}`);
  lines.push(`Status: ${req.status ?? 'pending'}${req.statusText ? ' ' + req.statusText : ''}`);
  if (req.mimeType) lines.push(`Type: ${req.mimeType}`);
  const safePostData = req.postData ? redactText(req.postData, { ...options, maxLength: bodyLimit }) : null;
  if (safePostData) {
    lines.push('\nRequest Body:');
    lines.push(safePostData);
  }

  if (req.requestHeaders && Object.keys(req.requestHeaders).length) {
    lines.push('\nRequest Headers:');
    for (const [k, v] of Object.entries(redactHeaders(req.requestHeaders, options))) lines.push(`  ${k}: ${v}`);
  }

  if (req.responseHeaders && Object.keys(req.responseHeaders).length) {
    lines.push('\nResponse Headers:');
    for (const [k, v] of Object.entries(redactHeaders(req.responseHeaders, options))) lines.push(`  ${k}: ${v}`);
  }

  if (req.timing) {
    lines.push('\nTiming:');
    const t = req.timing;
    if (t.dnsStart >= 0) lines.push(`  DNS: ${(t.dnsEnd - t.dnsStart).toFixed(1)}ms`);
    if (t.connectStart >= 0) lines.push(`  Connect: ${(t.connectEnd - t.connectStart).toFixed(1)}ms`);
    if (t.sslStart >= 0) lines.push(`  SSL: ${(t.sslEnd - t.sslStart).toFixed(1)}ms`);
    if (t.sendStart >= 0) lines.push(`  TTFB: ${(t.receiveHeadersEnd - t.sendEnd).toFixed(1)}ms`);
  }

  let responseBody = null;
  let responseBodyBase64 = false;
  try {
    const body = await cdp.send('Network.getResponseBody', { requestId }, sid);
    if (body.body) {
      responseBodyBase64 = !!body.base64Encoded;
      responseBody = body.base64Encoded
        ? `[binary, ~${Math.round(body.body.length * 3 / 4)} bytes]`
        : redactText(body.body, { ...options, maxLength: bodyLimit });
      lines.push(`\nBody${body.base64Encoded ? ' (binary)' : ''}:`);
      lines.push(responseBody);
      if (!body.base64Encoded && body.body.length > bodyLimit) lines.push(`... (${body.body.length} chars total; use --body-limit=${Math.min(1_000_000, body.body.length)} to expand)`);
    }
  } catch {
    lines.push('\nBody: (unavailable)');
  }

  const request = {
    id: requestId,
    url: redactUrl(req.url || '', options),
    method: req.method || 'GET',
    status: req.status ?? null,
    statusText: req.statusText || null,
    type: req.type || null,
    mimeType: req.mimeType || null,
    requestHeaders: redactHeaders(req.requestHeaders || {}, options),
    responseHeaders: redactHeaders(req.responseHeaders || {}, options),
    postData: safePostData,
    timing: req.timing || null,
    initiator: redactObject(req.initiator || null, options),
    protocol: req.protocol || null,
    remoteIPAddress: req.remoteIPAddress || null,
    fromDiskCache: !!req.fromDiskCache,
    completed: !!req.completed,
    failed: !!req.failed,
    failure: redactObject(req.failure || null, options),
    encodedDataLength: req.encodedDataLength ?? null,
    responseBody,
    responseBodyBase64,
  };
  return { text: lines.join('\n'), data: { found: true, request, bodyLimit, sensitiveIncluded: !!options.includeSensitive } };
}

function normalizeListOptions(options) {
  return {
    url: String(options.url || '').toLowerCase(),
    method: String(options.method || '').toUpperCase(),
    status: String(options.status || '').toLowerCase(),
    type: String(options.type || '').toLowerCase(),
    failed: !!options.failed,
    limit: Math.max(1, Math.min(200, Number(options.limit) || 50)),
    cursor: Math.max(0, Number(options.cursor) || 0),
  };
}

function matchesRequest(request, filters) {
  if (filters.url && !String(request.url || '').toLowerCase().includes(filters.url)) return false;
  if (filters.method && String(request.method || 'GET').toUpperCase() !== filters.method) return false;
  if (filters.type && String(request.type || '').toLowerCase() !== filters.type) return false;
  if (filters.failed && !request.failed && !(request.status >= 400)) return false;
  return matchesStatus(request.status, filters.status);
}

function matchesStatus(status, filter) {
  if (!filter) return true;
  if (filter === 'pending') return status == null;
  if (filter === 'error' || filter === 'failed') return Number(status) >= 400;
  if (filter === 'success') return Number(status) >= 200 && Number(status) < 400;
  const bucket = filter.match(/^([1-5])xx$/);
  if (bucket) return Math.floor(Number(status) / 100) === Number(bucket[1]);
  const comparison = filter.match(/^(>=|<=|>|<)(\d{3})$/);
  if (comparison) {
    const value = Number(status);
    const threshold = Number(comparison[2]);
    if (comparison[1] === '>=') return value >= threshold;
    if (comparison[1] === '<=') return value <= threshold;
    if (comparison[1] === '>') return value > threshold;
    return value < threshold;
  }
  return Number(status) === Number(filter);
}
