const rules = [];
let fetchEnabled = false;
const handlersByClient = new WeakMap();

export async function interceptStr(cdp, sid, action, pattern, ...rest) {
  if (!action) throw new Error('Usage: intercept <target> on [pattern] | block <pattern> | mock <url> <json> | off | rules');
  const options = parseOptions(rest);

  switch (action) {
    case 'on': {
      const patterns = pattern
        ? [{ urlPattern: pattern, requestStage: 'Request' }]
        : [{ urlPattern: '*', requestStage: 'Request' }];
      await cdp.send('Fetch.enable', { patterns }, sid);
      fetchEnabled = true;
      if (!hasHandler(cdp, sid)) {
        registerHandler(cdp, sid);
        markHandler(cdp, sid);
      }
      if (options.removeHeaders.length > 0) {
        rules.push({ type: 'headers', pattern: pattern || '*', removeHeaders: options.removeHeaders });
      }
      return `Interception enabled${pattern ? ` for ${pattern}` : ' for all requests'}.`;
    }

    case 'block': {
      if (!pattern) throw new Error('URL pattern required');
      rules.push({ type: 'block', pattern, abort: options.abort || 'BlockedByClient' });
      await ensureFetch(cdp, sid);
      return `Blocking requests matching: ${pattern} (${rules.length} rule(s) total)`;
    }

    case 'mock': {
      if (!pattern) throw new Error('URL pattern required');
      const body = options.body ?? rest.filter(item => !item.startsWith('--')).join(' ');
      if (!body) throw new Error('Response body (JSON) required');
      rules.push({
        type: 'mock',
        pattern,
        body,
        status: options.status,
        headers: options.headers,
        contentType: options.contentType,
        delay: options.delay,
      });
      await ensureFetch(cdp, sid);
      return `Mocking ${pattern} with custom response (${rules.length} rule(s) total)`;
    }

    case 'off': {
      await cdp.send('Fetch.disable', {}, sid);
      fetchEnabled = false;
      rules.length = 0;
      return 'Interception disabled. All rules cleared.';
    }

    case 'rules': {
      if (rules.length === 0) return 'No interception rules.';
      return rules.map((rule, index) => formatRule(rule, index)).join('\n');
    }

    default:
      throw new Error('Usage: intercept <target> on [pattern] | block <pattern> | mock <url> <json> | off | rules');
  }
}

async function ensureFetch(cdp, sid) {
  if (!fetchEnabled) {
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid);
    fetchEnabled = true;
  }
  if (!hasHandler(cdp, sid)) {
    registerHandler(cdp, sid);
    markHandler(cdp, sid);
  }
}

function hasHandler(cdp, sid) {
  return handlersByClient.get(cdp)?.has(sid);
}

function markHandler(cdp, sid) {
  if (!handlersByClient.has(cdp)) handlersByClient.set(cdp, new Set());
  handlersByClient.get(cdp).add(sid);
}

function registerHandler(cdp, sid) {
  cdp.onEvent('Fetch.requestPaused', async (params) => {
    const { requestId, request } = params;
    const url = request.url;

    for (const rule of rules) {
      if (!urlMatches(url, rule.pattern)) continue;
      if (rule.type === 'block') {
        try { await cdp.send('Fetch.failRequest', { requestId, errorReason: rule.abort || 'BlockedByClient' }, sid); } catch {}
        return;
      }
      if (rule.type === 'mock') {
        try {
          if (rule.delay) await new Promise(resolve => setTimeout(resolve, rule.delay));
          await cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: rule.status || 200,
            responseHeaders: responseHeaders(rule),
            body: Buffer.from(rule.body).toString('base64'),
          }, sid);
        } catch {}
        return;
      }
      if (rule.type === 'headers') {
        try {
          await cdp.send('Fetch.continueRequest', {
            requestId,
            headers: filterHeaders(request.headers || {}, rule.removeHeaders),
          }, sid);
        } catch {}
        return;
      }
    }

    try { await cdp.send('Fetch.continueRequest', { requestId }, sid); } catch {}
  });
}

function parseOptions(items) {
  const options = {
    body: null,
    status: 200,
    headers: [],
    contentType: 'application/json',
    delay: 0,
    abort: '',
    removeHeaders: [],
  };
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.startsWith('--')) continue;
    const raw = item.slice(2);
    const eq = raw.indexOf('=');
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const value = eq >= 0 ? raw.slice(eq + 1) : items[++i];
    if (key === 'body') options.body = value;
    if (key === 'status') options.status = parseInt(value) || 200;
    if (key === 'content-type') options.contentType = value;
    if (key === 'header') options.headers.push(parseHeader(value));
    if (key === 'delay') options.delay = parseInt(value) || 0;
    if (key === 'abort') options.abort = value;
    if (key === 'remove-header') options.removeHeaders.push(...String(value).split(',').map(v => v.trim()).filter(Boolean));
  }
  return options;
}

function parseHeader(value) {
  const idx = String(value).indexOf(':');
  if (idx === -1) return { name: String(value), value: '' };
  return {
    name: String(value).slice(0, idx).trim(),
    value: String(value).slice(idx + 1).trim(),
  };
}

function responseHeaders(rule) {
  const headers = [{ name: 'Content-Type', value: rule.contentType || 'application/json' }];
  for (const header of rule.headers || []) {
    if (header.name.toLowerCase() === 'content-type') headers[0] = header;
    else headers.push(header);
  }
  return headers;
}

function filterHeaders(headers, removeHeaders) {
  const blocked = new Set(removeHeaders.map(name => name.toLowerCase()));
  return Object.entries(headers)
    .filter(([name]) => !blocked.has(name.toLowerCase()))
    .map(([name, value]) => ({ name, value: String(value) }));
}

function formatRule(rule, index) {
  const parts = [`${index + 1}. ${rule.type.toUpperCase()} ${rule.pattern}`];
  if (rule.status) parts.push(`status:${rule.status}`);
  if (rule.contentType) parts.push(`content-type:${rule.contentType}`);
  if (rule.delay) parts.push(`delay:${rule.delay}`);
  if (rule.abort) parts.push(`abort:${rule.abort}`);
  if (rule.removeHeaders?.length) parts.push(`remove-header:${rule.removeHeaders.join(',')}`);
  if (rule.body) parts.push(`-> ${rule.body.substring(0, 50)}`);
  return parts.join(' ');
}

function urlMatches(url, pattern) {
  if (pattern === '*') return true;
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return regex.test(url);
}
