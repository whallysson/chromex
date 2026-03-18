// MCP server tests: protocol handler + tool definitions + dispatch
// No real browser -- tests the protocol layer and error handling

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const SERVER_PATH = resolve(__dirname, '../plugins/chromex/skills/chromex/scripts/mcp-server.mjs');

// Helper: send JSON-RPC messages to MCP server and collect responses
function mcpSession(messages, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let buf = '';
    const responses = [];

    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.trim()) responses.push(JSON.parse(line));
      }
    });

    const timer = setTimeout(() => {
      proc.kill();
      resolve(responses);
    }, timeoutMs);

    proc.on('close', () => {
      clearTimeout(timer);
      if (buf.trim()) {
        try { responses.push(JSON.parse(buf)); } catch { /* partial */ }
      }
      resolve(responses);
    });

    proc.on('error', reject);

    const input = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// Standard initialize handshake
const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } } };
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

function findById(responses, id) {
  return responses.find(r => r.id === id);
}

// ---- Protocol tests ----

describe('MCP Protocol', () => {
  it('initialize returns capabilities and serverInfo', async () => {
    const responses = await mcpSession([INIT]);
    const r = findById(responses, 0);
    expect(r).toBeDefined();
    expect(r.result.protocolVersion).toBe('2025-03-26');
    expect(r.result.capabilities).toEqual({ tools: {} });
    expect(r.result.serverInfo.name).toBe('chromex');
    expect(r.result.serverInfo.version).toBe('1.0.0');
  });

  it('tools/list returns 52 tools', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);
    const r = findById(responses, 1);
    expect(r).toBeDefined();
    expect(r.result.tools).toHaveLength(52);
  });

  it('ping returns empty object', async () => {
    const responses = await mcpSession([
      INIT,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
    ]);
    const r = findById(responses, 1);
    expect(r.result).toEqual({});
  });

  it('unknown method returns -32601', async () => {
    const responses = await mcpSession([
      INIT,
      { jsonrpc: '2.0', id: 1, method: 'nonexistent/method' },
    ]);
    const r = findById(responses, 1);
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe(-32601);
  });

  it('invalid JSON returns -32700', async () => {
    const proc = spawn(process.execPath, [SERVER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    return new Promise((resolve) => {
      let buf = '';
      proc.stdout.on('data', (chunk) => { buf += chunk.toString(); });
      proc.on('close', () => {
        const lines = buf.split('\n').filter(l => l.trim());
        const parsed = lines.map(l => JSON.parse(l));
        const errResponse = parsed.find(r => r.error?.code === -32700);
        expect(errResponse).toBeDefined();
        resolve();
      });
      proc.stdin.write('not valid json\n');
      proc.stdin.end();
    });
  });

  it('notification (no id) does not generate a response', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
    ]);
    // Should have exactly 2 responses: initialize + ping (initialized has no response)
    expect(responses.filter(r => r.id != null)).toHaveLength(2);
  });
});

// ---- Tool definition tests ----

describe('Tool Definitions', () => {
  let tools;

  it('loads tools', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);
    tools = findById(responses, 1).result.tools;
    expect(tools.length).toBeGreaterThan(0);
  });

  it('all tools have name, description, inputSchema, annotations', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);
    tools = findById(responses, 1).result.tools;

    for (const t of tools) {
      expect(t.name).toBeDefined();
      expect(t.name).toMatch(/^chromex_/);
      expect(t.description).toBeDefined();
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema).toBeDefined();
      expect(t.inputSchema.type).toBe('object');
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.annotations).toBeDefined();
      expect(typeof t.annotations.readOnlyHint).toBe('boolean');
      expect(typeof t.annotations.destructiveHint).toBe('boolean');
    }
  });

  it('read-only tools have readOnlyHint: true', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);
    tools = findById(responses, 1).result.tools;

    const readOnlyTools = ['chromex_list', 'chromex_snapshot', 'chromex_html',
      'chromex_screenshot', 'chromex_network', 'chromex_perf', 'chromex_console',
      'chromex_domsnapshot', 'chromex_waitfor', 'chromex_wait', 'chromex_heap'];

    for (const name of readOnlyTools) {
      const t = tools.find(x => x.name === name);
      expect(t, `${name} should exist`).toBeDefined();
      expect(t.annotations.readOnlyHint, `${name} should be readOnly`).toBe(true);
    }
  });

  it('destructive tools have destructiveHint: true', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);
    tools = findById(responses, 1).result.tools;

    const destructiveTools = ['chromex_close', 'chromex_stop'];

    for (const name of destructiveTools) {
      const t = tools.find(x => x.name === name);
      expect(t, `${name} should exist`).toBeDefined();
      expect(t.annotations.destructiveHint, `${name} should be destructive`).toBe(true);
    }
  });

  it('target-dependent tools require target in schema', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);
    tools = findById(responses, 1).result.tools;

    const noTarget = ['chromex_list', 'chromex_launch', 'chromex_incognito', 'chromex_stop'];

    for (const t of tools) {
      if (noTarget.includes(t.name)) {
        expect(t.inputSchema.required, `${t.name} should not require target`).not.toContain('target');
      } else if (t.name === 'chromex_open') {
        // open requires url, not target
        expect(t.inputSchema.required).toContain('url');
      } else {
        expect(t.inputSchema.required, `${t.name} should require target`).toContain('target');
      }
    }
  });
});

// ---- Tool execution tests (no browser) ----

describe('Tool Execution (no browser)', () => {
  it('unknown tool returns -32602 error', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chromex_nonexistent', arguments: {} } },
    ]);
    const r = findById(responses, 1);
    expect(r.error).toBeDefined();
    expect(r.error.code).toBe(-32602);
  });

  it('daemon tool without target returns isError', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chromex_click', arguments: {} } },
    ]);
    const r = findById(responses, 1);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('Target ID required');
  });

  it('daemon tool with fake target returns descriptive isError', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'chromex_snapshot', arguments: { target: 'ZZZZNONEXISTENT' } } },
    ]);
    const r = findById(responses, 1);
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain('No target matching prefix');
  });
});

// ---- Tool inventory tests ----

describe('Tool Names', () => {
  const EXPECTED_TOOLS = [
    'chromex_list', 'chromex_launch', 'chromex_open', 'chromex_close',
    'chromex_focus', 'chromex_incognito', 'chromex_stop',
    'chromex_snapshot', 'chromex_html', 'chromex_screenshot',
    'chromex_network', 'chromex_perf', 'chromex_console',
    'chromex_domsnapshot', 'chromex_highlight',
    'chromex_eval', 'chromex_evalraw',
    'chromex_navigate', 'chromex_waitfor', 'chromex_wait', 'chromex_scroll',
    'chromex_click', 'chromex_clickxy', 'chromex_type', 'chromex_hover',
    'chromex_drag', 'chromex_touch', 'chromex_dialog', 'chromex_loadall',
    'chromex_fill', 'chromex_clear', 'chromex_select', 'chromex_check',
    'chromex_form', 'chromex_upload',
    'chromex_cookies', 'chromex_storage', 'chromex_pdf',
    'chromex_throttle', 'chromex_intercept', 'chromex_har',
    'chromex_emulate', 'chromex_geo', 'chromex_timezone',
    'chromex_locale', 'chromex_cpu',
    'chromex_inject', 'chromex_download', 'chromex_coverage',
    'chromex_trace', 'chromex_heap', 'chromex_webauthn',
  ];

  it('all expected tools exist', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);
    const toolNames = findById(responses, 1).result.tools.map(t => t.name);

    for (const name of EXPECTED_TOOLS) {
      expect(toolNames, `${name} should be in tools list`).toContain(name);
    }
  });

  it('no unexpected tools exist', async () => {
    const responses = await mcpSession([
      INIT,
      INITIALIZED,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ]);
    const toolNames = findById(responses, 1).result.tools.map(t => t.name);

    for (const name of toolNames) {
      expect(EXPECTED_TOOLS, `${name} is unexpected`).toContain(name);
    }
  });
});
