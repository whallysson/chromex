// Network interception -- mock, block, or modify requests via Fetch domain

const rules = [];
let fetchEnabled = false;
let handlerRegistered = false;

export async function interceptStr(cdp, sid, action, pattern, body) {
  if (!action) throw new Error('Usage: intercept <target> on [pattern] | block <pattern> | mock <url> <json> | off | rules');

  switch (action) {
    case 'on': {
      const patterns = pattern
        ? [{ urlPattern: pattern, requestStage: 'Request' }]
        : [{ urlPattern: '*', requestStage: 'Request' }];
      await cdp.send('Fetch.enable', { patterns }, sid);
      fetchEnabled = true;
      if (!handlerRegistered) {
        registerHandler(cdp, sid);
        handlerRegistered = true;
      }
      return `Interception enabled${pattern ? ` for ${pattern}` : ' for all requests'}.`;
    }

    case 'block': {
      if (!pattern) throw new Error('URL pattern required');
      rules.push({ type: 'block', pattern });
      if (!fetchEnabled) {
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid);
        fetchEnabled = true;
        if (!handlerRegistered) { registerHandler(cdp, sid); handlerRegistered = true; }
      }
      return `Blocking requests matching: ${pattern} (${rules.length} rule(s) total)`;
    }

    case 'mock': {
      if (!pattern) throw new Error('URL pattern required');
      if (!body) throw new Error('Response body (JSON) required');
      rules.push({ type: 'mock', pattern, body });
      if (!fetchEnabled) {
        await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sid);
        fetchEnabled = true;
        if (!handlerRegistered) { registerHandler(cdp, sid); handlerRegistered = true; }
      }
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
      return rules.map((r, i) => `${i + 1}. ${r.type.toUpperCase()} ${r.pattern}${r.body ? ' -> ' + r.body.substring(0, 50) : ''}`).join('\n');
    }

    default:
      throw new Error('Usage: intercept <target> on [pattern] | block <pattern> | mock <url> <json> | off | rules');
  }
}

function registerHandler(cdp, sid) {
  cdp.onEvent('Fetch.requestPaused', async (params) => {
    const { requestId, request } = params;
    const url = request.url;

    for (const rule of rules) {
      if (urlMatches(url, rule.pattern)) {
        if (rule.type === 'block') {
          try { await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sid); } catch {}
          return;
        }
        if (rule.type === 'mock') {
          try {
            await cdp.send('Fetch.fulfillRequest', {
              requestId,
              responseCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
              body: Buffer.from(rule.body).toString('base64'),
            }, sid);
          } catch {}
          return;
        }
      }
    }

    // Sem regra: continuar normalmente
    try { await cdp.send('Fetch.continueRequest', { requestId }, sid); } catch {}
  });
}

function urlMatches(url, pattern) {
  if (pattern === '*') return true;
  // Converter glob simples para regex: * -> .*, ? -> .
  const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
  return regex.test(url);
}
