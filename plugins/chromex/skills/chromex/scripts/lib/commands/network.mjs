// Network: resource timing + CDP request detail

import { evalStr } from './evaluate.mjs';
import { emptyState, aggregate, formatBytes } from '../output.mjs';

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

export function netListStr(networkRequests) {
  if (networkRequests.size === 0) return emptyState('network', '0 requests captured since daemon started');

  // Pre-computed aggregates: breakdown by status class.
  // Agents commonly ask "are there any errors?" -- embedding the count eliminates a round-trip.
  let errors = 0;
  let pending = 0;
  let ok = 0;
  for (const [, r] of networkRequests.entries()) {
    if (r.status == null) pending++;
    else if (r.status >= 400) errors++;
    else ok++;
  }
  const meta = {};
  if (errors) meta.errors = errors;
  if (pending) meta.pending = pending;
  if (ok) meta.ok = ok;
  const header = aggregate('network', networkRequests.size, meta);

  const entries = [...networkRequests.entries()].slice(-50);
  const tableHeader = `${'STATUS'.padStart(3)}  ${'METHOD'.padEnd(6)}  ${'ID'.padEnd(14)}  URL`;
  const rows = entries.map(([id, r]) => {
    const status = r.status != null ? String(r.status).padStart(3) : '...';
    const method = (r.method || 'GET').padEnd(6);
    return `  ${status}  ${method}  ${id.substring(0, 14).padEnd(14)}  ${r.url?.substring(0, 100) || '?'}`;
  });
  const truncNote = networkRequests.size > 50
    ? `\n(showing last 50 of ${networkRequests.size})`
    : '';
  return `${header}\n${tableHeader}\n${rows.join('\n')}${truncNote}\n\nUse "net <target> <requestId>" for detail.`;
}

export async function netDetailStr(cdp, sid, requestId, networkRequests) {
  let req = networkRequests.get(requestId);
  if (!req) {
    const matches = [...networkRequests.keys()].filter(k => k.startsWith(requestId));
    if (matches.length === 0) return `Request not found: ${requestId}. Run "net" to see all requests.`;
    if (matches.length > 1) {
      const list = matches.slice(0, 10).map(k => `  ${k}  ${networkRequests.get(k).url?.substring(0, 80)}`).join('\n');
      return `Ambiguous ID "${requestId}". Matches:\n${list}`;
    }
    requestId = matches[0];
    req = networkRequests.get(requestId);
  }

  const lines = [];
  lines.push(`${req.method || 'GET'} ${req.url}`);
  lines.push(`Status: ${req.status ?? 'pending'}${req.statusText ? ' ' + req.statusText : ''}`);
  if (req.mimeType) lines.push(`Type: ${req.mimeType}`);

  if (req.requestHeaders && Object.keys(req.requestHeaders).length) {
    lines.push('\nRequest Headers:');
    for (const [k, v] of Object.entries(req.requestHeaders)) lines.push(`  ${k}: ${v}`);
  }

  if (req.responseHeaders && Object.keys(req.responseHeaders).length) {
    lines.push('\nResponse Headers:');
    for (const [k, v] of Object.entries(req.responseHeaders)) lines.push(`  ${k}: ${v}`);
  }

  if (req.timing) {
    lines.push('\nTiming:');
    const t = req.timing;
    if (t.dnsStart >= 0) lines.push(`  DNS: ${(t.dnsEnd - t.dnsStart).toFixed(1)}ms`);
    if (t.connectStart >= 0) lines.push(`  Connect: ${(t.connectEnd - t.connectStart).toFixed(1)}ms`);
    if (t.sslStart >= 0) lines.push(`  SSL: ${(t.sslEnd - t.sslStart).toFixed(1)}ms`);
    if (t.sendStart >= 0) lines.push(`  TTFB: ${(t.receiveHeadersEnd - t.sendEnd).toFixed(1)}ms`);
  }

  try {
    const body = await cdp.send('Network.getResponseBody', { requestId }, sid);
    if (body.body) {
      const preview = body.base64Encoded
        ? `[binary, ~${Math.round(body.body.length * 3 / 4)} bytes]`
        : body.body.substring(0, 2000);
      lines.push(`\nBody${body.base64Encoded ? ' (binary)' : ''}:`);
      lines.push(preview);
      if (!body.base64Encoded && body.body.length > 2000) lines.push(`... (${body.body.length} chars total)`);
    }
  } catch {
    lines.push('\nBody: (unavailable)');
  }

  return lines.join('\n');
}
