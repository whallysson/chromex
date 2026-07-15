import { redactObject } from '../redaction.mjs';
import { validateJsonInput } from '../json-schema.mjs';

export async function thirdPartyStr(cdp, sid, action = 'list', ...args) {
  const normalized = String(action || 'list').toLowerCase();
  if (normalized === 'list') return listTools(cdp, sid);
  if (normalized === 'execute') return executeTool(cdp, sid, args[0], args[1], args[2], args.includes('--include-sensitive'));
  throw new Error('Usage: third-party <target> list | execute <toolName> [params-json] [groupName] [--include-sensitive]');
}

async function listTools(cdp, sid) {
  const result = await evaluate(cdp, sid, `(${discoverInPage.toString()})()`);
  const groups = Array.isArray(result) ? result : [];
  const lines = [`Third-party developer tool groups: ${groups.length}`];
  for (const group of groups) {
    lines.push(`  ${group.name}: ${group.description || ''}`.trimEnd());
    for (const tool of group.tools || []) lines.push(`    ${tool.name} - ${tool.description}`);
  }
  return { text: lines.join('\n'), data: { groups, untrustedContent: true } };
}

async function executeTool(cdp, sid, toolName, paramsJson, groupName, includeSensitive) {
  if (!toolName) throw new Error('Third-party tool name required.');
  const params = parseParams(paramsJson);
  const groups = await evaluate(cdp, sid, `(${describeCachedTools.toString()})()`);
  const matches = (groups || []).flatMap(group => (group.tools || []).filter(tool => tool.name === toolName).map(tool => ({ group, tool })));
  const selected = groupName && groupName !== '--include-sensitive'
    ? matches.find(match => match.group.name === groupName)
    : matches.length === 1 ? matches[0] : null;
  if (!selected) {
    if (!matches.length) throw new Error(`Third-party tool not found: ${toolName}. Run third-party list first.`);
    throw new Error(`Third-party tool name is ambiguous: ${toolName}. Provide one of these groups: ${matches.map(match => match.group.name).join(', ')}`);
  }
  const validationErrors = validateJsonInput(selected.tool.inputSchema, params);
  if (validationErrors.length) throw new Error(`Invalid parameters for ${toolName}: ${validationErrors.join('; ')}`);
  const expression = `(${executeInPage.toString()})(${JSON.stringify(toolName)},${JSON.stringify(params)},${JSON.stringify(selected.group.name)})`;
  const raw = await evaluate(cdp, sid, expression, true);
  const output = redactObject(raw, { includeSensitive });
  return {
    text: `[UNTRUSTED PAGE TOOL OUTPUT]\n${stringify(output)}`,
    data: { toolName, groupName: selected.group.name, output, untrustedContent: true, sensitiveIncluded: includeSensitive },
  };
}

async function evaluate(cdp, sid, expression, awaitPromise = true) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  }, sid);
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || 'Page evaluation failed.');
  return result?.value;
}

function parseParams(value) {
  if (!value || value === '--include-sensitive') return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('Third-party tool parameters must be a JSON object.');
  }
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

async function discoverInPage() {
  if (window.__dtmcp) window.__dtmcp.toolGroups = [];
  const groups = [];
  const event = new CustomEvent('devtoolstooldiscovery');
  event.respondWith = toolGroup => {
    if (!toolGroup || typeof toolGroup.name !== 'string' || (toolGroup.description && typeof toolGroup.description !== 'string') || !Array.isArray(toolGroup.tools)) return;
    if (toolGroup.tools.some(tool => typeof tool?.name !== 'string' || typeof tool.description !== 'string' || typeof tool.inputSchema !== 'object' || typeof tool.execute !== 'function')) return;
    window.__dtmcp ||= {};
    window.__dtmcp.toolGroups ||= [];
    window.__dtmcp.toolGroups.push(toolGroup);
    groups.push(toolGroup);
  };
  window.dispatchEvent(event);
  if (!groups.length) await new Promise(resolve => setTimeout(resolve, 0));
  window.__dtmcp ||= {};
  window.__dtmcp.executeTool = async (toolName, args, groupName) => {
    const matches = (window.__dtmcp.toolGroups || []).flatMap(group => (group.tools || []).filter(tool => tool.name === toolName && (!groupName || group.name === groupName)).map(tool => ({ group, tool })));
    if (!matches.length) throw new Error(`Tool ${toolName} not found`);
    if (matches.length > 1) throw new Error(`Tool ${toolName} is ambiguous`);
    return matches[0].tool.execute(args);
  };
  return groups.map(group => ({
    name: group.name,
    description: group.description || '',
    tools: group.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  }));
}

function describeCachedTools() {
  return (window.__dtmcp?.toolGroups || []).map(group => ({
    name: group.name,
    description: group.description || '',
    tools: (group.tools || []).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
  }));
}

async function executeInPage(toolName, args, groupName) {
  if (!window.__dtmcp?.executeTool) throw new Error('No third-party tools found on the page.');
  const result = await window.__dtmcp.executeTool(toolName, args, groupName);
  const ancestors = [];
  const serialize = (value, parent) => {
    if (value instanceof Element) return { element: value.tagName.toLowerCase(), id: value.id || null, className: typeof value.className === 'string' ? value.className : null, text: value.textContent?.slice(0, 500) || '' };
    if (Array.isArray(value)) return value.map(item => serialize(item, value));
    if (value !== null && typeof value === 'object') {
      while (ancestors.length && ancestors.at(-1) !== parent) ancestors.pop();
      if (ancestors.includes(value)) return '<Circular reference>';
      ancestors.push(value);
      if (Object.getPrototypeOf(value) !== Object.prototype) return `<${value.constructor?.name || 'Object'} instance>`;
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, serialize(item, value)]));
    }
    if (typeof value === 'function') return '<Function object>';
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'symbol') return value.toString();
    return value;
  };
  return serialize(result);
}
