import { validateJsonInput } from '../json-schema.mjs';
import { redactObject } from '../redaction.mjs';

export function createWebMcpState(cdp, sid) {
  const state = { enabled: false, tools: new Map(), pending: new Map(), responses: new Map(), off: [] };
  state.off.push(cdp.onEvent('WebMCP.toolsAdded', (params, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
    for (const tool of params.tools || []) state.tools.set(toolKey(tool.frameId, tool.name), tool);
  }));
  state.off.push(cdp.onEvent('WebMCP.toolsRemoved', (params, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
    for (const tool of params.tools || []) state.tools.delete(toolKey(tool.frameId, tool.name));
  }));
  state.off.push(cdp.onEvent('WebMCP.toolResponded', (params, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
    const pending = state.pending.get(params.invocationId);
    if (pending) {
      state.pending.delete(params.invocationId);
      clearTimeout(pending.timer);
      pending.resolve(params);
      return;
    }
    state.responses.set(params.invocationId, params);
    while (state.responses.size > 100) state.responses.delete(state.responses.keys().next().value);
  }));
  return state;
}

export async function webMcpStr(cdp, sid, state, action = 'list', ...args) {
  const normalized = String(action || 'list').toLowerCase();
  try {
    if (normalized === 'list') return listTools(cdp, sid, state);
    if (normalized === 'execute') {
      const positional = args.filter(arg => !String(arg).startsWith('--'));
      const frameId = optionValue(args, 'frame') || positional[2];
      const timeout = optionValue(args, 'timeout') || positional[3];
      return executeTool(cdp, sid, state, positional[0], positional[1], frameId, timeout, args.includes('--include-sensitive'));
    }
    if (normalized === 'cancel') return cancelInvocation(cdp, sid, state, args[0]);
    if (normalized === 'disable') return disableWebMcp(cdp, sid, state);
    if (normalized === 'status') return statusWebMcp(state);
    throw new Error('Usage: webmcp <target> list | execute <toolName> [input-json] [frameId] [timeout-ms] | cancel <invocationId> | disable | status');
  } catch (error) {
    if (/WebMCP\.|method.*not found|wasn't found|not supported/i.test(error.message)) {
      throw new Error(`WebMCP is unavailable in this browser. Launch Chromex with --webmcp and use a compatible Chrome build. ${error.message}`);
    }
    throw error;
  }
}

async function listTools(cdp, sid, state) {
  await ensureEnabled(cdp, sid, state);
  const tools = [...state.tools.values()];
  const lines = [`WebMCP tools: ${tools.length}`];
  for (const tool of tools) lines.push(`  ${tool.name} frame=${tool.frameId} - ${tool.description || ''}`.trimEnd());
  return { text: lines.join('\n'), data: { enabled: true, tools, untrustedContent: true } };
}

async function executeTool(cdp, sid, state, toolName, inputJson, frameId, timeoutArg, includeSensitive) {
  if (!toolName) throw new Error('WebMCP tool name required.');
  await ensureEnabled(cdp, sid, state);
  const input = parseInput(inputJson);
  const tool = resolveTool(state, toolName, frameId === '--include-sensitive' ? null : frameId);
  const validationErrors = validateJsonInput(tool.inputSchema || { type: 'object' }, input);
  if (validationErrors.length) throw new Error(`Invalid WebMCP input for ${toolName}: ${validationErrors.join('; ')}`);
  const { invocationId } = await cdp.send('WebMCP.invokeTool', { frameId: tool.frameId, toolName: tool.name, input }, sid);
  const response = await waitForInvocation(state, invocationId, timeoutArg);
  if (response.status !== 'Completed') throw new Error(`WebMCP tool ${tool.name} ${response.status || 'failed'}: ${response.errorText || response.exception?.description || 'no error detail'}`);
  const output = redactObject(response.output, { includeSensitive });
  return {
    text: `[UNTRUSTED WEBMCP OUTPUT]\n${stringify(output)}`,
    data: { invocationId, status: response.status, output, untrustedContent: true, sensitiveIncluded: includeSensitive },
  };
}

async function cancelInvocation(cdp, sid, state, invocationId) {
  if (!invocationId) throw new Error('WebMCP invocation id required.');
  await cdp.send('WebMCP.cancelInvocation', { invocationId }, sid);
  const pending = state.pending.get(invocationId);
  if (pending) {
    state.pending.delete(invocationId);
    clearTimeout(pending.timer);
    pending.reject(new Error(`WebMCP invocation canceled: ${invocationId}`));
  }
  return { text: `WebMCP invocation canceled: ${invocationId}`, data: { invocationId, canceled: true } };
}

async function disableWebMcp(cdp, sid, state) {
  if (state.enabled) await cdp.send('WebMCP.disable', {}, sid);
  state.enabled = false;
  state.tools.clear();
  return { text: 'WebMCP disabled.', data: { enabled: false } };
}

function statusWebMcp(state) {
  return { text: `WebMCP: ${state.enabled ? 'enabled' : 'disabled'}, ${state.tools.size} tool(s)`, data: { enabled: state.enabled, tools: [...state.tools.values()] } };
}

async function ensureEnabled(cdp, sid, state) {
  if (state.enabled) return;
  await cdp.send('WebMCP.enable', {}, sid);
  state.enabled = true;
}

function resolveTool(state, name, frameId) {
  const tools = [...state.tools.values()].filter(tool => tool.name === name && (!frameId || tool.frameId === frameId || tool.frameId.startsWith(frameId)));
  if (!tools.length) throw new Error(`WebMCP tool not found: ${name}. Run webmcp list first.`);
  if (tools.length > 1) throw new Error(`WebMCP tool is registered in multiple frames: ${name}. Provide frameId: ${tools.map(tool => tool.frameId).join(', ')}`);
  return tools[0];
}

function waitForInvocation(state, invocationId, timeoutArg) {
  const completed = state.responses.get(invocationId);
  if (completed) {
    state.responses.delete(invocationId);
    return Promise.resolve(completed);
  }
  const timeout = Math.max(100, Math.min(300000, Number(timeoutArg) || 30000));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(invocationId);
      reject(new Error(`Timeout waiting for WebMCP invocation: ${invocationId}`));
    }, timeout);
    state.pending.set(invocationId, { resolve, reject, timer });
  });
}

function parseInput(value) {
  if (!value || value === '--include-sensitive') return {};
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error('WebMCP input must be a JSON object.');
  }
}

function toolKey(frameId, name) {
  return `${frameId}\u0000${name}`;
}

function stringify(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function optionValue(args, name) {
  return args.find(arg => String(arg).startsWith(`--${name}=`))?.slice(name.length + 3);
}
