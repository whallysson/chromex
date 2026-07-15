// Unit tests for new command modules: keyboard, stats, audit, network, console
// No real browser -- tests pure logic and error handling

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve } from 'path';
import { parseKeyCombo, pressKeyStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/keyboard.mjs';
import { SessionStats, statsStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/stats.mjs';
import { netListStr, netDetailStr, netListResult, netDetailResult } from '../plugins/chromex/skills/chromex/scripts/lib/commands/network.mjs';
import { consoleListStr, consoleDetailStr, consoleListResult, consoleDetailResult } from '../plugins/chromex/skills/chromex/scripts/lib/commands/console.mjs';
import { appStr, cacheStr, clearSiteDataStr, idbStr, serviceWorkersStr, storageUsageStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/app.mjs';
import { stateStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/state.mjs';
import { shotStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/screenshot.mjs';
import { pdfStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/pdf.mjs';
import { harStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/har.mjs';
import { traceStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/trace.mjs';
import { heapStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/heap.mjs';
import { HeapAnalysisStore } from '../plugins/chromex/skills/chromex/scripts/lib/heap-analysis.mjs';
import { downloadStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/download.mjs';
import { buildLocator } from '../plugins/chromex/skills/chromex/scripts/lib/commands/locator.mjs';
import { interceptStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/intercept.mjs';
import { showStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/show.mjs';
import { evidenceStr, recordEvidenceAction } from '../plugins/chromex/skills/chromex/scripts/lib/commands/evidence.mjs';
import { sessionStatePath } from '../plugins/chromex/skills/chromex/scripts/lib/sessions.mjs';
import { resolveChromexPath, workspaceArtifactRoot } from '../plugins/chromex/skills/chromex/scripts/lib/artifacts.mjs';
import { formatIssues, issuesStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/issues.mjs';
import { inspectStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/inspect.mjs';
import { diagnoseStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/diagnose.mjs';
import { screencastStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/screencast.mjs';
import { extensionsStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/extensions.mjs';
import { thirdPartyStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/third-party.mjs';
import { createWebMcpState, webMcpStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/webmcp.mjs';
import { evalStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/evaluate.mjs';
import { launchBrowser } from '../plugins/chromex/skills/chromex/scripts/lib/launcher.mjs';

// Mock CDP client that records sent commands
function mockCdp() {
  const sent = [];
  return {
    sent,
    send(method, params, sid) {
      sent.push({ method, params, sid });
      return Promise.resolve({});
    },
  };
}

function artifactCdp() {
  const sent = [];
  const handlers = new Map();
  return {
    sent,
    onEvent(method, handler) {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    },
    waitForEvent() {
      return { promise: Promise.resolve({}) };
    },
    send(method, params, sid) {
      sent.push({ method, params, sid });
      if (method === 'Page.getLayoutMetrics') {
        return Promise.resolve({
          visualViewport: { clientWidth: 1600 },
          cssVisualViewport: { clientWidth: 800 },
        });
      }
      if (method === 'Page.captureScreenshot') return Promise.resolve({ data: Buffer.from('screenshot').toString('base64') });
      if (method === 'Page.printToPDF') return Promise.resolve({ data: Buffer.from('pdf').toString('base64') });
      if (method === 'HeapProfiler.takeHeapSnapshot') {
        handlers.get('HeapProfiler.addHeapSnapshotChunk')?.({ chunk: 'heap' });
        return Promise.resolve({});
      }
      return Promise.resolve({});
    },
  };
}

async function withArtifactRoot(prefix, callback) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const previousArtifactRoot = process.env.CHROMEX_ARTIFACT_ROOT;
  process.env.CHROMEX_ARTIFACT_ROOT = join(dir, 'artifacts');

  try {
    return await callback(dir);
  } finally {
    if (previousArtifactRoot === undefined) delete process.env.CHROMEX_ARTIFACT_ROOT;
    else process.env.CHROMEX_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(dir, { recursive: true, force: true });
  }
}

function heapFixture(windowSize = 100) {
  return {
    snapshot: {
      meta: {
        node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness'],
        node_types: [['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape'], 'string', 'number', 'number', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak'], 'string_or_number', 'node'],
      },
      node_count: 4,
      edge_count: 3,
      trace_function_count: 0,
    },
    nodes: [
      9, 1, 1, 0, 2, 0, 0,
      3, 2, 3, windowSize, 1, 0, 0,
      2, 6, 5, 20, 0, 0, 0,
      2, 6, 7, 25, 0, 0, 0,
    ],
    edges: [
      2, 3, 7,
      2, 4, 21,
      2, 5, 14,
    ],
    strings: ['', '(GC roots)', 'Window', 'window', 'duplicate', 'greeting', 'hello'],
  };
}

describe('Chromex path resolution', () => {
  it('keeps default artifacts under Chromex home', () => {
    const previousArtifactRoot = process.env.CHROMEX_ARTIFACT_ROOT;

    try {
      delete process.env.CHROMEX_ARTIFACT_ROOT;
      expect(workspaceArtifactRoot()).toContain(join(homedir(), '.chromex', 'artifacts'));
    } finally {
      if (previousArtifactRoot === undefined) delete process.env.CHROMEX_ARTIFACT_ROOT;
      else process.env.CHROMEX_ARTIFACT_ROOT = previousArtifactRoot;
    }
  });

  it('maps the Chromex namespace to the user home directory', () => {
    expect(resolveChromexPath('.chromex/storage/auth.json')).toBe(join(homedir(), '.chromex', 'storage', 'auth.json'));
    expect(resolveChromexPath('./.chromex/storage/auth.json')).toBe(join(homedir(), '.chromex', 'storage', 'auth.json'));
    expect(resolveChromexPath('~/.chromex/storage/auth.json')).toBe(join(homedir(), '.chromex', 'storage', 'auth.json'));
  });

  it('keeps normal relative paths relative to the current workspace', () => {
    expect(resolveChromexPath('reports/auth.json')).toBe(resolve(process.cwd(), 'reports', 'auth.json'));
  });
});

describe('Default file artifacts', () => {
  it('writes screenshots under the artifact root by default', async () => {
    await withArtifactRoot('chromex-shot-', async (dir) => {
      const output = await shotStr(artifactCdp(), 'sid1', null, false, { defaultScreenshotPath: null });

      expect(output).toContain(join(dir, 'artifacts', 'screenshots'));
      expect(output).not.toContain('/tmp/screenshot');
    });
  });

  it('writes PDFs under the artifact root by default', async () => {
    await withArtifactRoot('chromex-pdf-', async (dir) => {
      const output = await pdfStr(artifactCdp(), 'sid1');

      expect(output).toContain(join(dir, 'artifacts', 'pdf'));
      expect(output).not.toContain('/tmp/page.pdf');
    });
  });

  it('writes HAR files under the artifact root by default', async () => {
    await withArtifactRoot('chromex-har-', async (dir) => {
      const cdp = artifactCdp();

      await harStr(cdp, 'sid1', 'start');
      const output = await harStr(cdp, 'sid1', 'stop');

      expect(output).toContain(join(dir, 'artifacts', 'har'));
      expect(output).not.toContain('/tmp/chromex.har');
    });
  });

  it('writes trace files under the artifact root by default', async () => {
    await withArtifactRoot('chromex-trace-', async (dir) => {
      const cdp = artifactCdp();

      await traceStr(cdp, 'sid1', 'start');
      const output = await traceStr(cdp, 'sid1', 'stop');

      expect(output.text).toContain(join(dir, 'artifacts', 'traces'));
      expect(output.text).not.toContain('/tmp/chromex-trace.json');
      expect(output.artifacts[0].type).toBe('trace');
    });
  });

  it('writes heap snapshots under the artifact root by default', async () => {
    await withArtifactRoot('chromex-heap-', async (dir) => {
      const output = await heapStr(artifactCdp(), 'sid1', 'snapshot');

      expect(output.text).toContain(join(dir, 'artifacts', 'heap'));
      expect(output.text).not.toContain('/tmp/chromex-heap.heapsnapshot');
      expect(output.artifacts[0].type).toBe('heap-snapshot');
    });
  });

  it('uses the artifact root for downloads by default', async () => {
    await withArtifactRoot('chromex-downloads-', async (dir) => {
      const cdp = artifactCdp();
      const output = await downloadStr(cdp, 'sid1', 'allow');

      expect(output).toContain(join(dir, 'artifacts', 'downloads'));
      expect(cdp.sent.at(-1).params.downloadPath).toBe(join(dir, 'artifacts', 'downloads'));
    });
  });
});

describe('Heap snapshot analysis', () => {
  it('summarizes classes and finds duplicate strings', async () => {
    await withArtifactRoot('chromex-heap-analysis-', async (dir) => {
      const path = join(dir, 'heap.heapsnapshot');
      writeFileSync(path, JSON.stringify(heapFixture()), { mode: 0o600 });
      const store = new HeapAnalysisStore();

      const summary = store.execute('summary', { filePath: path });
      const duplicates = store.execute('duplicate-strings', { filePath: path });

      expect(summary.data.nodes).toBe(4);
      expect(summary.data.classes.some(item => item.name === 'Window')).toBe(true);
      expect(duplicates.data.duplicates[0]).toMatchObject({ value: 'hello', count: 2, selfSize: 45 });
    });
  });

  it('finds retainers, paths, and dominators', async () => {
    await withArtifactRoot('chromex-heap-links-', async (dir) => {
      const path = join(dir, 'heap.heapsnapshot');
      writeFileSync(path, JSON.stringify(heapFixture()), { mode: 0o600 });
      const store = new HeapAnalysisStore();

      const retainers = store.execute('retainers', { filePath: path, node: 2 });
      const paths = store.execute('retaining-paths', { filePath: path, node: 2 });
      const dominators = store.execute('dominators', { filePath: path });

      expect(retainers.data.retainers[0]).toMatchObject({ fromNode: 1, name: 'greeting' });
      expect(paths.data.paths[0].map(node => node.index)).toEqual([2, 1, 0]);
      expect(dominators.data.dominators.some(node => node.index === 1 && node.retainedSize === 120)).toBe(true);
    });
  });

  it('compares class and self-size changes between snapshots', async () => {
    await withArtifactRoot('chromex-heap-compare-', async (dir) => {
      const first = join(dir, 'first.heapsnapshot');
      const second = join(dir, 'second.heapsnapshot');
      writeFileSync(first, JSON.stringify(heapFixture(100)), { mode: 0o600 });
      writeFileSync(second, JSON.stringify(heapFixture(180)), { mode: 0o600 });
      const store = new HeapAnalysisStore();

      const comparison = store.execute('compare', { filePath: first, otherFilePath: second });

      expect(comparison.data.changes.find(item => item.name === 'Window').sizeDelta).toBe(80);
    });
  });
});

describe('Screencast capture', () => {
  it('captures frames and writes manifest and replay artifacts', async () => {
    await withArtifactRoot('chromex-screencast-', async () => {
      const cdp = scriptedCdp();
      const state = { active: null, last: null };
      await screencastStr(cdp, 'sid1', state, 'start', '--format=png', '--max-frames=2');
      cdp.emit('Page.screencastFrame', { sessionId: 7, data: Buffer.from('frame').toString('base64'), metadata: { timestamp: 1 } });

      const output = await screencastStr(cdp, 'sid1', state, 'stop');
      const manifest = JSON.parse(readFileSync(output.artifacts[0].path, 'utf8'));

      expect(manifest.frameCount).toBe(1);
      expect(existsSync(output.artifacts[1].path)).toBe(true);
      expect(cdp.sent.map(item => item.method)).toContain('Page.screencastFrameAck');
    });
  });
});

describe('Chrome extension tooling', () => {
  it('lists extensions and triggers their toolbar action', async () => {
    const cdp = scriptedCdp({
      'Extensions.getExtensions': { extensions: [{ id: 'abcdefghijkl', name: 'Inspector', version: '1.2.3', enabled: true }] },
      'Target.getTargets': {
        targetInfos: [
          { targetId: 'target-1234', type: 'page', url: 'https://example.test', browserContextId: 'context-1' },
          { targetId: 'tab-5678', type: 'tab', url: 'https://example.test', browserContextId: 'context-1' },
        ],
      },
      'Extensions.triggerAction': {},
    });

    const list = await extensionsStr(cdp, 'target-1234', 'list');
    const action = await extensionsStr(cdp, 'target-1234', 'action', 'abcdefghijkl');

    expect(list.data.extensions[0].name).toBe('Inspector');
    expect(action.data.pageTargetId).toBe('target-1234');
    expect(action.data.targetId).toBe('tab-5678');
    expect(cdp.sent.at(-1)).toMatchObject({ method: 'Extensions.triggerAction', params: { id: 'abcdefghijkl', targetId: 'tab-5678' } });
  });

  it('redacts storage secrets unless explicitly included', async () => {
    const cdp = scriptedCdp({
      'Target.getTargets': { targetInfos: [{ targetId: 'worker-1', type: 'service_worker', url: 'chrome-extension://abcdefghijkl/background.js' }] },
      'Target.attachToTarget': { sessionId: 'extension-session' },
      'Target.detachFromTarget': {},
      'Extensions.getStorageItems': { data: { accessToken: 'secret-token', theme: 'dark' } },
    });

    const safe = await extensionsStr(cdp, 'target-1234', 'storage-get', 'abcdefghijkl', 'local');
    const revealed = await extensionsStr(cdp, 'target-1234', 'storage-get', 'abcdefghijkl', 'local', '--include-sensitive');

    expect(safe.data.values.accessToken).toBe('<redacted>');
    expect(revealed.data.values.accessToken).toBe('secret-token');
  });
});

describe('Third-party developer tools', () => {
  const groups = [{
    name: 'Application Tools',
    description: 'Runtime state',
    tools: [{
      name: 'getState',
      description: 'Gets application state',
      inputSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'], additionalProperties: false },
    }],
  }];

  it('discovers tools exposed by the page', async () => {
    const cdp = scriptedCdp({ 'Runtime.evaluate': { result: { value: groups } } });

    const output = await thirdPartyStr(cdp, 'sid1', 'list');

    expect(output.data.groups[0].tools[0].name).toBe('getState');
    expect(output.data.untrustedContent).toBe(true);
  });

  it('validates inputs and redacts untrusted tool output by default', async () => {
    const cdp = scriptedCdp({
      'Runtime.evaluate': params => params.expression.includes('describeCachedTools')
        ? { result: { value: groups } }
        : { result: { value: { accessToken: 'page-secret', status: 'ok' } } },
    });

    await expect(thirdPartyStr(cdp, 'sid1', 'execute', 'getState', '{}')).rejects.toThrow('scope is required');
    const output = await thirdPartyStr(cdp, 'sid1', 'execute', 'getState', '{"scope":"all"}');

    expect(output.data.output.accessToken).toBe('<redacted>');
    expect(output.data.untrustedContent).toBe(true);
  });
});

describe('WebMCP tooling', () => {
  it('discovers and executes registered tools with untrusted output handling', async () => {
    const tool = {
      name: 'lookupOrder',
      description: 'Looks up an order',
      frameId: 'frame-main',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    };
    const cdp = scriptedCdp({
      'WebMCP.enable': (_params, _sid, { emit }) => {
        emit('WebMCP.toolsAdded', { tools: [tool] });
        return {};
      },
      'WebMCP.invokeTool': (_params, _sid, { emit }) => {
        emit('WebMCP.toolResponded', { invocationId: 'invoke-1', status: 'Completed', output: { token: 'web-secret', order: 42 } });
        return { invocationId: 'invoke-1' };
      },
    });
    const state = createWebMcpState(cdp, 'sid1');

    const list = await webMcpStr(cdp, 'sid1', state, 'list');
    const executed = await webMcpStr(cdp, 'sid1', state, 'execute', 'lookupOrder', '{"id":"42"}');

    expect(list.data.tools[0].name).toBe('lookupOrder');
    expect(executed.data.output.token).toBe('<redacted>');
    expect(executed.data.untrustedContent).toBe(true);
  });
});

function scriptedCdp(handlers = {}) {
  const sent = [];
  const eventHandlers = new Map();
  const emit = (method, params) => {
    for (const handler of eventHandlers.get(method) || []) handler(params);
  };
  return {
    sent,
    emit,
    onEvent(method, handler) {
      if (!eventHandlers.has(method)) eventHandlers.set(method, new Set());
      eventHandlers.get(method).add(handler);
      return () => eventHandlers.get(method)?.delete(handler);
    },
    async send(method, params, sid) {
      sent.push({ method, params, sid });
      const handler = handlers[method];
      if (typeof handler === 'function') return handler(params, sid, { emit, sent });
      if (handler instanceof Error) throw handler;
      if (handler !== undefined) return handler;
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('localStorage.length')) {
          return { result: { value: { localStorage: 18, sessionStorage: 2 } } };
        }
        return {
          result: {
            value: {
              href: 'https://app.example.test/dashboard',
              origin: 'https://app.example.test',
              protocol: 'https:',
              title: 'App',
            },
          },
        };
      }
      return {};
    },
  };
}

describe('JavaScript evaluation', () => {
  it('returns the browser exception detail instead of the generic CDP label', async () => {
    const cdp = scriptedCdp({
      'Runtime.evaluate': {
        exceptionDetails: {
          text: 'Uncaught',
          exception: { description: 'ReferenceError: missingValue is not defined' },
        },
      },
    });

    await expect(evalStr(cdp, 'sid1', 'missingValue')).rejects.toThrow('ReferenceError: missingValue is not defined');
  });
});

describe('Browser launch contracts', () => {
  it('rejects WebMCP in headless mode before launching a browser', async () => {
    await expect(launchBrowser({ webMcp: true, headless: true })).rejects.toThrow('cannot run in headless mode');
  });
});

function stateCdp() {
  const sent = [];
  return {
    sent,
    async send(method, params, sid) {
      sent.push({ method, params, sid });
      if (method === 'Runtime.evaluate') {
        if (params.expression === 'window.location.href') return { result: { value: 'https://app.example.test/dashboard' } };
        if (params.expression === 'window.location.origin') return { result: { value: 'https://app.example.test' } };
        if (params.expression.includes('Object.keys(localStorage).map')) {
          return { result: { value: JSON.stringify([{ name: 'theme', value: 'dark' }]) } };
        }
        return { result: { value: undefined } };
      }
      if (method === 'Network.getCookies') {
        return {
          cookies: [{
            name: 'session_id',
            value: 'secret-value',
            domain: 'app.example.test',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          }],
        };
      }
      if (method === 'Network.setCookie') return { success: true };
      return {};
    },
  };
}

function showCdp() {
  const sent = [];
  return {
    sent,
    async send(method, params, sid) {
      sent.push({ method, params, sid });
      if (method === 'Target.attachToTarget') return { sessionId: 'session-preview' };
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('preview').toString('base64') };
      if (method === 'Runtime.evaluate') return { result: { value: [] } };
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Demo' }, childIds: ['2'], backendDOMNodeId: 1, properties: [] },
            { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 2, properties: [] },
          ],
        };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { border: [10, 20, 90, 20, 90, 60, 10, 60] } };
      }
      return {};
    },
  };
}

function evidenceCdp() {
  const sent = [];
  return {
    sent,
    async send(method, params, sid) {
      sent.push({ method, params, sid });
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('evidence').toString('base64') };
      if (method === 'Runtime.evaluate') {
        if (params.expression.includes('document.documentElement.outerHTML')) {
          return { result: { value: '<html><body><button>Save</button></body></html>' } };
        }
        if (params.expression.includes('JSON.stringify({')) {
          return {
            result: {
              value: JSON.stringify({
                url: 'https://app.example.test/checkout?token=evidence-secret',
                title: 'Checkout',
                viewport: { width: 1280, height: 720, devicePixelRatio: 2 },
              }),
            },
          };
        }
        return { result: { value: undefined } };
      }
      if (method === 'Accessibility.getFullAXTree') {
        return {
          nodes: [
            { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Checkout' }, childIds: ['2'], backendDOMNodeId: 1, properties: [] },
            { nodeId: '2', parentId: '1', role: { value: 'button' }, name: { value: 'Save' }, backendDOMNodeId: 2, properties: [] },
          ],
        };
      }
      if (method === 'DOM.getBoxModel') {
        return { model: { border: [0, 0, 100, 0, 100, 50, 0, 50] } };
      }
      return {};
    },
  };
}

describe('DevTools diagnostics', () => {
  it('collects and formats browser issues', async () => {
    const cdp = scriptedCdp({
      'Audits.enable': {},
      'Audits.checkFormsIssues': { formIssues: [{ issueType: 'MissingIdForInput', violatingNodeId: 42 }] },
    });
    const state = { enabled: false, items: [{ code: 'CorsIssue', details: { corsIssueDetails: { requestId: 'req1' } } }] };

    const listed = await issuesStr(cdp, 'sid1', state, 'list');
    const forms = await issuesStr(cdp, 'sid1', state, 'check-forms');

    expect(listed.text).toContain('CorsIssue');
    expect(listed.data.total).toBe(1);
    expect(forms.text).toContain('MissingIdForInput');
    expect(cdp.sent.some(call => call.method === 'Audits.enable')).toBe(true);
  });

  it('formats an empty issue collection', () => {
    expect(formatIssues([]).text).toContain('0 issues');
  });

  it('inspects computed styles, matched rules, listeners, and box model', async () => {
    const cdp = scriptedCdp({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 2 },
      'CSS.getComputedStyleForNode': { computedStyle: [{ name: 'display', value: 'grid' }, { name: 'color', value: 'red' }] },
      'CSS.getMatchedStylesForNode': { matchedCSSRules: [{ rule: { selectorList: { text: '.card' }, origin: 'regular', style: { cssProperties: [{ name: 'display', value: 'grid' }] } } }] },
      'DOM.resolveNode': { object: { objectId: 'object-1' } },
      'DOMDebugger.getEventListeners': { listeners: [{ type: 'click', useCapture: false, passive: true, once: false, scriptId: '7', lineNumber: 4, columnNumber: 1 }] },
      'DOM.getBoxModel': { model: { width: 320, height: 180, content: [], padding: [], border: [], margin: [] } },
    });

    const result = await inspectStr(cdp, 'sid1', 'all', '.card', 'display');

    expect(result.text).toContain('display: grid');
    expect(result.text).toContain('click');
    expect(result.text).toContain('320x180');
    expect(result.data.computed).toHaveLength(1);
  });

  it('prioritizes browser, network, and console failures', async () => {
    const cdp = scriptedCdp({
      'Runtime.evaluate': { result: { value: { url: 'https://example.test/?token=secret', title: 'Example' } } },
      'Performance.getMetrics': { metrics: [{ name: 'Nodes', value: 42 }] },
    });
    const context = {
      issues: { items: [{ code: 'CorsIssue' }] },
      consoleMessages: [{ id: 1, ts: 1, type: 'exception', args: ['boom'] }],
      networkRequests: new Map([['req1', { url: 'https://example.test/api', method: 'GET', status: 500 }]]),
    };

    const result = await diagnoseStr(cdp, 'sid1', context, 10);

    expect(result.text).toContain('Diagnosis: degraded');
    expect(result.text).toContain('CorsIssue');
    expect(result.text).toContain('500 GET');
    expect(result.text).not.toContain('token=secret');
  });
});

// ---- Application state commands ----

describe('Application state commands', () => {
  it('formats storage usage and quota breakdown', async () => {
    const cdp = scriptedCdp({
      'Storage.getUsageAndQuota': {
        usage: 1536,
        quota: 1024 * 1024,
        usageBreakdown: [
          { storageType: 'indexeddb', usage: 1024 },
          { storageType: 'cache_storage', usage: 512 },
        ],
      },
    });

    const output = await storageUsageStr(cdp, 'sid1');

    expect(output).toContain('storage[2] used:1.5KB quota:1.0MB');
    expect(output).toContain('origin: https://app.example.test');
    expect(output).toContain('indexeddb');
    expect(output).toContain('cache_storage');
  });

  it('clears all site data for the current origin', async () => {
    const cdp = scriptedCdp({ 'Storage.clearDataForOrigin': {} });

    const output = await clearSiteDataStr(cdp, 'sid1');

    expect(output).toBe('Cleared site data for https://app.example.test (all).');
    const call = cdp.sent.find(c => c.method === 'Storage.clearDataForOrigin');
    expect(call.params).toEqual({ origin: 'https://app.example.test', storageTypes: 'all' });
  });

  it('lists cache storage entries by cache id prefix', async () => {
    const cdp = scriptedCdp({
      'CacheStorage.requestCacheNames': {
        caches: [{ cacheId: 'cache-abcdef', cacheName: 'runtime-v1' }],
      },
      'CacheStorage.requestEntries': {
        returnCount: 1,
        cacheDataEntries: [{
          requestURL: 'https://app.example.test/api/users',
          requestMethod: 'GET',
          responseStatus: 200,
        }],
      },
    });

    const output = await cacheStr(cdp, 'sid1', 'entries', 'cache-a', '10', '/api');

    expect(output).toContain('cache.entries[1] shown:1 cache:runtime-v1');
    expect(output).toContain('200 GET');
    expect(output).toContain('/api/users');
    const call = cdp.sent.find(c => c.method === 'CacheStorage.requestEntries');
    expect(call.params).toEqual({
      cacheId: 'cache-abcdef',
      skipCount: 0,
      pageSize: 10,
      pathFilter: '/api',
    });
  });

  it('accepts --query and --limit options for cache entries', async () => {
    const cdp = scriptedCdp({
      'CacheStorage.requestCacheNames': {
        caches: [{ cacheId: 'cache-abcdef', cacheName: 'runtime-v1' }],
      },
      'CacheStorage.requestEntries': {
        returnCount: 1,
        cacheDataEntries: [{
          requestURL: 'https://app.example.test/api/users',
          requestMethod: 'GET',
          responseStatus: 200,
        }],
      },
    });

    await cacheStr(cdp, 'sid1', 'entries', 'cache-a', '--query=/api', '--limit=7');

    const call = cdp.sent.find(c => c.method === 'CacheStorage.requestEntries');
    expect(call.params.pageSize).toBe(7);
    expect(call.params.pathFilter).toBe('/api');
  });

  it('formats IndexedDB schema and rows', async () => {
    const cdp = scriptedCdp({
      'IndexedDB.enable': {},
      'IndexedDB.requestDatabase': {
        databaseWithObjectStores: {
          name: 'app-db',
          version: 3,
          objectStores: [{
            name: 'users',
            keyPath: { type: 'string', string: 'id' },
            autoIncrement: false,
            indexes: [{ name: 'by_email', keyPath: { type: 'string', string: 'email' }, unique: true, multiEntry: false }],
          }],
        },
      },
      'IndexedDB.requestData': {
        hasMore: false,
        objectStoreDataEntries: [{
          key: { value: 42 },
          value: { description: 'Object {id: 42, name: "Ana"}' },
        }],
      },
    });

    const schema = await idbStr(cdp, 'sid1', 'schema', 'app-db');
    const rows = await idbStr(cdp, 'sid1', 'rows', 'app-db', 'users', '--limit=5');

    expect(schema).toContain('idb.schema[1] database:app-db version:3');
    expect(schema).toContain('index by_email');
    expect(rows).toContain('idb.rows[1] database:app-db store:users more:no');
    expect(rows).toContain('Object {id: 42, name: "Ana"}');
    const call = cdp.sent.find(c => c.method === 'IndexedDB.requestData');
    expect(call.params.pageSize).toBe(5);
  });

  it('lists IndexedDB databases for the current origin', async () => {
    const cdp = scriptedCdp({
      'IndexedDB.enable': {},
      'IndexedDB.requestDatabaseNames': { databaseNames: ['app-db', 'analytics-db'] },
    });

    const output = await idbStr(cdp, 'sid1', 'list');

    expect(output).toContain('idb[2] origin:https://app.example.test');
    expect(output).toContain('app-db');
    expect(output).toContain('analytics-db');
  });

  it('collects Service Worker registrations from CDP events', async () => {
    const cdp = scriptedCdp({
      'ServiceWorker.enable': (_params, _sid, { emit }) => {
        emit('ServiceWorker.workerRegistrationUpdated', {
          registrations: [
            { registrationId: 'reg1', scopeURL: 'https://app.example.test/' },
            { registrationId: 'reg2', scopeURL: 'https://other.example.test/' },
          ],
        });
        emit('ServiceWorker.workerVersionUpdated', {
          versions: [
            {
              registrationId: 'reg1',
              status: 'activated',
              runningStatus: 'running',
              scriptURL: 'https://app.example.test/sw.js',
              controlledClients: ['target1'],
            },
            {
              registrationId: 'reg2',
              status: 'activated',
              runningStatus: 'running',
              scriptURL: 'https://other.example.test/sw.js',
              controlledClients: [],
            },
          ],
        });
        return {};
      },
    });

    const output = await serviceWorkersStr(cdp, 'sid1');

    expect(output).toContain('sw[1] versions:1');
    expect(output).toContain('https://app.example.test/');
    expect(output).toContain('activated/running clients:1');
    expect(output).not.toContain('other.example.test');
  });

  it('rejects Service Worker mutations outside the current origin', async () => {
    const cdp = scriptedCdp();

    await expect(
      serviceWorkersStr(cdp, 'sid1', 'unregister', 'https://other.example.test/')
    ).rejects.toThrow(/scopeURL must match current origin/);
  });

  it('formats a rich application summary', async () => {
    const cdp = scriptedCdp({
      'Storage.getUsageAndQuota': {
        usage: 42 * 1024 * 1024,
        quota: 2 * 1024 * 1024 * 1024,
        usageBreakdown: [],
      },
      'Network.enable': {},
      'Network.getCookies': { cookies: new Array(7).fill({ name: 'c', value: 'v' }) },
      'Network.disable': {},
      'CacheStorage.requestCacheNames': {
        caches: [
          { cacheId: 'cache-a', cacheName: 'runtime' },
          { cacheId: 'cache-b', cacheName: 'assets' },
        ],
      },
      'CacheStorage.requestEntries': (params) => ({
        returnCount: params.cacheId === 'cache-a' ? 100 : 28,
        cacheDataEntries: [],
      }),
      'IndexedDB.enable': {},
      'IndexedDB.requestDatabaseNames': { databaseNames: ['app-db', 'analytics-db', 'queue-db'] },
      'ServiceWorker.enable': (_params, _sid, { emit }) => {
        emit('ServiceWorker.workerRegistrationUpdated', {
          registrations: [{ registrationId: 'reg1', scopeURL: 'https://app.example.test/' }],
        });
        emit('ServiceWorker.workerVersionUpdated', {
          versions: [
            { registrationId: 'reg1', status: 'activated', runningStatus: 'running', scriptURL: 'https://app.example.test/sw.js', controlledClients: [] },
            { registrationId: 'reg1', status: 'installed', runningStatus: 'stopped', scriptURL: 'https://app.example.test/sw.js', controlledClients: [] },
          ],
        });
        return {};
      },
      'Storage.getStorageKey': { storageKey: 'https://app.example.test/' },
      'Storage.setStorageBucketTracking': (params, _sid, { emit }) => {
        if (params.enable) {
          emit('Storage.storageBucketCreatedOrUpdated', {
            bucketInfo: {
              id: 'bucket1',
              bucket: { storageKey: 'https://app.example.test/', name: 'default' },
            },
          });
        }
        return {};
      },
      'Page.enable': {},
      'Page.getAppManifest': {
        url: 'https://app.example.test/manifest.json',
        data: '{"name":"Demo App"}',
        errors: [],
      },
    });

    const output = await appStr(cdp, 'sid1', 'summary');

    expect(output).toContain('app:');
    expect(output).toContain('origin: https://app.example.test');
    expect(output).toContain('localStorage: 18 keys');
    expect(output).toContain('sessionStorage: 2 keys');
    expect(output).toContain('cookies: 7');
    expect(output).toContain('caches: 2 caches, 128 entries');
    expect(output).toContain('indexedDB: 3 databases');
    expect(output).toContain('serviceWorkers: 1 active, 1 waiting');
    expect(output).toContain('storageBuckets: 1 bucket');
    expect(output).toContain('manifest: present (Demo App)');
  });
});

describe('Storage state command', () => {
  it('saves cookies and localStorage using portable state shape', async () => {
    const file = `/tmp/chromex-state-${Date.now()}.json`;
    const cdp = stateCdp();

    const output = await stateStr(cdp, 'sid1', 'save', file);
    const saved = JSON.parse(readFileSync(file, 'utf8'));

    expect(output.text).toContain('Storage state saved');
    expect(output.artifacts[0].path).toBe(file);
    expect(saved.cookies[0].name).toBe('session_id');
    expect(saved.cookies[0].value).toBe('secret-value');
    expect(saved.origins[0].origin).toBe('https://app.example.test');
    expect(saved.origins[0].localStorage).toEqual([{ name: 'theme', value: 'dark' }]);
    unlinkSync(file);
  });

  it('maps .chromex state files to the user home directory', async () => {
    const file = `.chromex/storage/chromex-state-${Date.now()}.json`;
    const expectedPath = join(homedir(), '.chromex', 'storage', file.split('/').pop());
    const cdp = stateCdp();

    try {
      const saved = await stateStr(cdp, 'sid1', 'save', file);
      const loaded = await stateStr(cdp, 'sid1', 'load', file);

      expect(saved.artifacts[0].path).toBe(expectedPath);
      expect(loaded.text).toContain(`Storage state loaded from ${expectedPath}`);
    } finally {
      if (existsSync(expectedPath)) unlinkSync(expectedPath);
    }
  });

  it('loads matching origin and reports ignored origins', async () => {
    const file = `/tmp/chromex-state-load-${Date.now()}.json`;
    const state = {
      cookies: [{ name: 'session_id', value: 'secret-value', domain: 'app.example.test', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }],
      origins: [
        { origin: 'https://app.example.test', localStorage: [{ name: 'theme', value: 'dark' }] },
        { origin: 'https://other.example.test', localStorage: [{ name: 'skip', value: '1' }] },
      ],
    };
    await import('fs').then(fs => fs.writeFileSync(file, JSON.stringify(state)));
    const cdp = stateCdp();

    const output = await stateStr(cdp, 'sid1', 'load', file);

    expect(output.data).toEqual({ cookies: 1, localStorage: 1, ignoredOrigins: 1 });
    expect(cdp.sent.some(call => call.method === 'Network.setCookie')).toBe(true);
    unlinkSync(file);
  });
});

describe('Locator generation', () => {
  it('prefers test id for chromex-test locators', () => {
    const locator = buildLocator({
      tagName: 'button',
      testId: 'submit-button',
      accessibleName: 'Submit',
      css: 'button:nth-of-type(1)',
    }, 'chromex-test');

    expect(locator.value).toBe('page.getByTestId("submit-button")');
    expect(locator.stable).toBe(true);
  });

  it('returns CSS fallback for css format', () => {
    const locator = buildLocator({
      tagName: 'input',
      nameAttr: 'email',
      css: 'form > input:nth-of-type(1)',
    }, 'css');

    expect(locator.value).toBe('input[name="email"]');
  });
});

describe('Show dashboard command', () => {
  it('writes dashboard previews, snapshots and annotation packs', async () => {
    const cwd = process.cwd();
    const dir = mkdtempSync(join(tmpdir(), 'chromex-show-'));
    const previousArtifactRoot = process.env.CHROMEX_ARTIFACT_ROOT;
    process.env.CHROMEX_ARTIFACT_ROOT = join(dir, 'artifacts');
    const cdp = showCdp();

    try {
      process.chdir(dir);
      const result = await showStr(
        cdp,
        [{ name: 'auth', targetId: 'ABCDEF123456', title: 'Login', url: 'https://app.example.test/login', workspace: dir }],
        [{ targetId: 'ABCDEF123456', title: 'Login', url: 'https://app.example.test/login' }],
        true,
        { allowedDomains: [], blockedDomains: [] }
      );

      const dashboard = result.artifacts.find(item => item.path.endsWith('/index.html'));
      const preview = result.artifacts.find(item => item.path.endsWith('.png'));
      const snapshot = result.artifacts.find(item => item.type === 'snapshots');
      const annotation = result.artifacts.find(item => item.type === 'annotations');
      const annotationData = JSON.parse(readFileSync(annotation.path, 'utf8'));

      expect(existsSync(dashboard.path)).toBe(true);
      expect(existsSync(preview.path)).toBe(true);
      expect(existsSync(snapshot.path)).toBe(true);
      expect(annotationData.evidence[0].screenshot).toBe(preview.path);
      expect(annotationData.evidence[0].snapshot).toBe(snapshot.path);
      expect(readFileSync(dashboard.path, 'utf8')).toContain('<img src="auth-ABCDEF12-');
      expect(readFileSync(dashboard.path, 'utf8')).toContain('id="export-json"');
      expect(readFileSync(dashboard.path, 'utf8')).toContain('showSaveFilePicker');
      expect(annotationData.schemaVersion).toBe(1);
      expect(annotationData.annotations).toEqual([]);
      expect(readFileSync(snapshot.path, 'utf8')).toContain('[box=10,20,80,40]');
      expect(cdp.sent.some(call => call.method === 'Target.detachFromTarget')).toBe(true);
    } finally {
      process.chdir(cwd);
      if (previousArtifactRoot === undefined) delete process.env.CHROMEX_ARTIFACT_ROOT;
      else process.env.CHROMEX_ARTIFACT_ROOT = previousArtifactRoot;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Named session persistence', () => {
  it('uses a stable storage state path under Chromex session data', () => {
    const path = sessionStatePath('auth');

    expect(path).toContain('/.chromex/session-data/auth/storage-state.json');
  });
});

describe('Evidence pack command', () => {
  it('captures screenshots, snapshots, html, timelines and replay artifacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chromex-evidence-'));
    const previousArtifactRoot = process.env.CHROMEX_ARTIFACT_ROOT;
    process.env.CHROMEX_ARTIFACT_ROOT = join(dir, 'artifacts');
    const state = { active: null, last: null };
    const cdp = evidenceCdp();
    const networkRequests = new Map([['req1', { url: 'https://app.example.test/api', method: 'GET', status: 200 }]]);
    const consoleMessages = [{ id: 0, ts: Date.now(), type: 'log', args: ['ready'] }];

    try {
      await evidenceStr(cdp, 'sid1', 'target1', state, 'start', 'checkout flow', { networkRequests, consoleMessages });
      recordEvidenceAction(state, 'fill', ['@e1', 'secret@example.test'], true, 'Authorization: Bearer evidence-secret');
      const output = await evidenceStr(cdp, 'sid1', 'target1', state, 'stop', 'after save', { networkRequests, consoleMessages });
      const evidence = JSON.parse(readFileSync(output.data.evidence, 'utf8'));
      const timeline = JSON.parse(readFileSync(join(output.data.root, 'timeline.json'), 'utf8'));

      expect(output.text).toContain('Evidence pack stopped');
      expect(existsSync(output.data.replay)).toBe(true);
      expect(existsSync(join(output.data.root, 'console.json'))).toBe(true);
      expect(existsSync(join(output.data.root, 'network.json'))).toBe(true);
      expect(evidence.marks).toHaveLength(2);
      expect(evidence.marks[0].url).not.toContain('evidence-secret');
      expect(timeline.some(item => item.type === 'action' && item.args.includes('<redacted>'))).toBe(true);
      expect(JSON.stringify(timeline)).not.toContain('evidence-secret');
      expect(readFileSync(output.data.replay, 'utf8')).toContain('Chromex Evidence');
      expect(output.artifacts.some(item => item.type === 'evidence-replay')).toBe(true);
    } finally {
      if (previousArtifactRoot === undefined) delete process.env.CHROMEX_ARTIFACT_ROOT;
      else process.env.CHROMEX_ARTIFACT_ROOT = previousArtifactRoot;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Advanced intercept command', () => {
  it('mocks response with status, headers and body flag', async () => {
    const cdp = scriptedCdp();

    await interceptStr(cdp, 'sid1', 'mock', '**/api/users', '--status=201', '--content-type=text/plain', '--header=X-Test: yes', '--body=ok');
    cdp.emit('Fetch.requestPaused', { requestId: 'req1', request: { url: 'https://app.example.test/api/users', headers: {} } });
    await new Promise(resolve => setTimeout(resolve, 5));

    const fulfill = cdp.sent.find(call => call.method === 'Fetch.fulfillRequest');
    expect(fulfill.params.responseCode).toBe(201);
    expect(fulfill.params.responseHeaders).toContainEqual({ name: 'Content-Type', value: 'text/plain' });
    expect(fulfill.params.responseHeaders).toContainEqual({ name: 'X-Test', value: 'yes' });
    expect(Buffer.from(fulfill.params.body, 'base64').toString()).toBe('ok');
  });

  it('removes sensitive request headers before continuing', async () => {
    const cdp = scriptedCdp();

    await interceptStr(cdp, 'sid1', 'on', '**/*', '--remove-header=authorization,cookie');
    cdp.emit('Fetch.requestPaused', {
      requestId: 'req2',
      request: {
        url: 'https://app.example.test/api',
        headers: { Authorization: 'Bearer x', Cookie: 'a=b', Accept: 'application/json' },
      },
    });
    await new Promise(resolve => setTimeout(resolve, 5));

    const continued = cdp.sent.find(call => call.method === 'Fetch.continueRequest');
    expect(continued.params.headers).toEqual([{ name: 'Accept', value: 'application/json' }]);
  });
});

// ---- Keyboard: parseKeyCombo ----

describe('parseKeyCombo', () => {
  it('parses simple keys', () => {
    const r = parseKeyCombo('Enter');
    expect(r.modifiers).toBe(0);
    expect(r.modifierNames).toEqual([]);
    expect(r.key.key).toBe('Enter');
    expect(r.key.code).toBe('Enter');
    expect(r.key.keyCode).toBe(13);
  });

  it('parses Tab', () => {
    expect(parseKeyCombo('Tab').key.key).toBe('Tab');
    expect(parseKeyCombo('Tab').key.keyCode).toBe(9);
  });

  it('parses Escape', () => {
    expect(parseKeyCombo('Escape').key.key).toBe('Escape');
    expect(parseKeyCombo('Escape').key.keyCode).toBe(27);
  });

  it('parses arrow keys', () => {
    expect(parseKeyCombo('ArrowUp').key.code).toBe('ArrowUp');
    expect(parseKeyCombo('ArrowDown').key.code).toBe('ArrowDown');
    expect(parseKeyCombo('ArrowLeft').key.code).toBe('ArrowLeft');
    expect(parseKeyCombo('ArrowRight').key.code).toBe('ArrowRight');
  });

  it('parses F1-F12', () => {
    expect(parseKeyCombo('F1').key.key).toBe('F1');
    expect(parseKeyCombo('F12').key.key).toBe('F12');
  });

  it('parses single letters', () => {
    const r = parseKeyCombo('a');
    expect(r.key.key).toBe('a');
    expect(r.key.code).toBe('KeyA');
    expect(r.key.keyCode).toBe(65);
  });

  it('parses single digits', () => {
    const r = parseKeyCombo('5');
    expect(r.key.key).toBe('5');
    expect(r.key.code).toBe('Digit5');
  });

  it('parses Control+A', () => {
    const r = parseKeyCombo('Control+A');
    expect(r.modifiers).toBe(2); // Control = 2
    expect(r.modifierNames).toEqual(['Control']);
    expect(r.key.key).toBe('a');
    expect(r.key.code).toBe('KeyA');
  });

  it('parses Control+Shift+R', () => {
    const r = parseKeyCombo('Control+Shift+R');
    expect(r.modifiers).toBe(10); // Control(2) | Shift(8)
    expect(r.modifierNames).toHaveLength(2);
    expect(r.key.key).toBe('r');
  });

  it('parses Meta+C (Cmd+C on macOS)', () => {
    const r = parseKeyCombo('Meta+C');
    expect(r.modifiers).toBe(4); // Meta = 4
    expect(r.key.key).toBe('c');
  });

  it('accepts Ctrl as alias for Control', () => {
    const r = parseKeyCombo('Ctrl+A');
    expect(r.modifiers).toBe(2);
  });

  it('accepts Cmd as alias for Meta', () => {
    const r = parseKeyCombo('Cmd+V');
    expect(r.modifiers).toBe(4);
  });

  it('is case-insensitive for modifiers and keys', () => {
    const r = parseKeyCombo('control+shift+a');
    expect(r.modifiers).toBe(10);
    expect(r.key.key).toBe('a');
  });

  it('handles + as the key itself (Control++)', () => {
    const r = parseKeyCombo('Control++');
    expect(r.modifiers).toBe(2);
    expect(r.key.key).toBe('+');
  });

  it('throws on empty combo', () => {
    expect(() => parseKeyCombo('')).toThrow();
    expect(() => parseKeyCombo(null)).toThrow();
    expect(() => parseKeyCombo(undefined)).toThrow();
  });

  it('throws on modifier-only combo', () => {
    expect(() => parseKeyCombo('Control')).toThrow(/No key found/);
    expect(() => parseKeyCombo('Control+Shift')).toThrow(/No key found/);
  });

  it('throws on multiple non-modifier keys', () => {
    expect(() => parseKeyCombo('A+B')).toThrow(/Multiple non-modifier/);
  });

  it('throws on unknown key name', () => {
    expect(() => parseKeyCombo('SuperSpecialKey')).toThrow(/Unknown key/);
  });
});

// ---- Keyboard: pressKeyStr (mock CDP) ----

describe('pressKeyStr', () => {
  it('dispatches keyDown+keyUp for simple key', async () => {
    const cdp = mockCdp();
    const result = await pressKeyStr(cdp, 'sid1', 'Enter');

    expect(result).toBe('Pressed Enter');
    expect(cdp.sent).toHaveLength(2); // keyDown + keyUp
    expect(cdp.sent[0].params.type).toBe('keyDown');
    expect(cdp.sent[0].params.key).toBe('Enter');
    expect(cdp.sent[1].params.type).toBe('keyUp');
  });

  it('dispatches modifier keyDown before and keyUp after primary key', async () => {
    const cdp = mockCdp();
    await pressKeyStr(cdp, 'sid1', 'Control+A');

    // Control keyDown, A keyDown, A keyUp, Control keyUp
    expect(cdp.sent).toHaveLength(4);
    expect(cdp.sent[0].params.type).toBe('keyDown');
    expect(cdp.sent[0].params.key).toBe('Control');
    expect(cdp.sent[1].params.type).toBe('keyDown');
    expect(cdp.sent[1].params.key).toBe('a');
    expect(cdp.sent[2].params.type).toBe('keyUp');
    expect(cdp.sent[2].params.key).toBe('a');
    expect(cdp.sent[3].params.type).toBe('keyUp');
    expect(cdp.sent[3].params.key).toBe('Control');
  });

  it('releases modifiers in reverse order', async () => {
    const cdp = mockCdp();
    await pressKeyStr(cdp, 'sid1', 'Control+Shift+R');

    // Ctrl down, Shift down, R down, R up, Shift up, Ctrl up
    expect(cdp.sent).toHaveLength(6);
    expect(cdp.sent[0].params.key).toBe('Control'); // first down
    expect(cdp.sent[1].params.key).toBe('Shift');   // second down
    expect(cdp.sent[4].params.key).toBe('Shift');   // first up (reverse)
    expect(cdp.sent[5].params.key).toBe('Control');  // second up (reverse)
  });

  it('passes correct sessionId to all dispatches', async () => {
    const cdp = mockCdp();
    await pressKeyStr(cdp, 'my-session', 'Enter');

    for (const call of cdp.sent) {
      expect(call.sid).toBe('my-session');
    }
  });
});

// ---- SessionStats ----

describe('SessionStats', () => {
  it('records command counts and timing', () => {
    const stats = new SessionStats();
    stats.record('click', ['@e5'], 1000, 1200, true, null);
    stats.record('click', ['@e8'], 1300, 1400, true, null);
    stats.record('snap', ['--refs'], 1500, 1700, true, null);

    const entry = stats.commands.get('click');
    expect(entry.count).toBe(2);
    expect(entry.totalMs).toBe(300); // 200 + 100
    expect(entry.errors).toBe(0);
  });

  it('records errors separately', () => {
    const stats = new SessionStats();
    stats.record('nav', ['https://x.com'], 1000, 1500, false, 'Timeout');
    stats.record('nav', ['https://y.com'], 2000, 2100, true, null);

    const entry = stats.commands.get('nav');
    expect(entry.count).toBe(2);
    expect(entry.errors).toBe(1);
  });

  it('maintains timeline with redacted args', () => {
    const stats = new SessionStats();
    stats.record('fill', ['#email', 'user@test.com', 'extra', 'more'], 1000, 1100, true, null);

    expect(stats.timeline).toHaveLength(1);
    expect(stats.timeline[0].cmd).toBe('fill');
    expect(stats.timeline[0].args).toEqual(['#email', '<redacted>']);
    expect(stats.timeline[0].duration).toBe(100);
    expect(stats.timeline[0].ok).toBe(true);
  });

  it('truncates error messages', () => {
    const stats = new SessionStats();
    const longError = 'x'.repeat(200);
    stats.record('eval', ['...'], 1000, 1100, false, longError);

    expect(stats.timeline[0].error.length).toBe(100);
  });

  it('redacts secrets from persisted error messages', () => {
    const stats = new SessionStats();
    stats.record('net', [], 1000, 1100, false, 'Authorization: Bearer stats-secret');

    expect(stats.timeline[0].error).not.toContain('stats-secret');
    expect(stats.timeline[0].error).toContain('<redacted>');
  });
});

// ---- statsStr ----

describe('statsStr', () => {
  it('returns standardized empty state for null stats', () => {
    expect(statsStr(null)).toBe('stats: no stats available');
  });

  it('formats command breakdown table', () => {
    const stats = new SessionStats();
    stats.record('click', ['@e1'], 1000, 1200, true, null);
    stats.record('snap', [], 1300, 1500, true, null);

    const output = statsStr(stats);
    expect(output).toContain('Session Stats');
    expect(output).toContain('commands: 2');
    expect(output).toContain('errors: 0');
    expect(output).toContain('click');
    expect(output).toContain('snap');
  });

  it('shows last 20 in timeline by default', () => {
    const stats = new SessionStats();
    for (let i = 0; i < 30; i++) {
      stats.record('click', ['@e1'], 1000 + i * 100, 1050 + i * 100, true, null);
    }

    const output = statsStr(stats, false);
    expect(output).toContain('last 20 of 30');
  });

  it('shows full timeline when requested', () => {
    const stats = new SessionStats();
    for (let i = 0; i < 30; i++) {
      stats.record('click', ['@e1'], 1000 + i * 100, 1050 + i * 100, true, null);
    }

    const output = statsStr(stats, true);
    expect(output).toContain('Full Timeline');
  });

  it('exports JSON to file', () => {
    const stats = new SessionStats();
    stats.record('snap', [], 1000, 1200, true, null);

    const tmpPath = `/tmp/chromex-test-stats-${Date.now()}.json`;
    const output = statsStr(stats, false, tmpPath);
    expect(output).toContain(`Exported to: ${tmpPath}`);

    // Verify exported file
    const data = JSON.parse(readFileSync(tmpPath, 'utf8'));
    expect(data.totalCommands).toBe(1);
    expect(data.commands.snap.count).toBe(1);
    unlinkSync(tmpPath);
  });

  it('exports JSON under Chromex home for .chromex paths', () => {
    const stats = new SessionStats();
    stats.record('snap', [], 1000, 1200, true, null);
    const fileName = `chromex-test-stats-${Date.now()}.json`;
    const expectedPath = join(homedir(), '.chromex', 'stats', fileName);

    try {
      const output = statsStr(stats, false, `.chromex/stats/${fileName}`);
      expect(output).toContain(`Exported to: ${expectedPath}`);
      expect(JSON.parse(readFileSync(expectedPath, 'utf8')).totalCommands).toBe(1);
    } finally {
      if (existsSync(expectedPath)) unlinkSync(expectedPath);
    }
  });
});

// ---- netListStr ----

describe('netListStr', () => {
  it('returns standardized empty state for no requests', () => {
    expect(netListStr(new Map())).toBe('network: 0 requests captured since daemon started');
  });

  it('formats request list with aggregate header', () => {
    const reqs = new Map();
    reqs.set('req1.1', { url: 'https://example.com/api', method: 'GET', status: 200, mimeType: 'application/json' });
    reqs.set('req2.1', { url: 'https://example.com/style.css', method: 'GET', status: 304 });

    const output = netListStr(reqs);
    expect(output).toContain('200');
    expect(output).toContain('304');
    expect(output).toContain('example.com/api');
    expect(output).toContain('example.com/style.css');
    // Pre-computed aggregate header: total + ok count (both are < 400 so ok:2)
    expect(output).toContain('network[2] ok:2');
  });

  it('breaks down requests by status class in aggregate header', () => {
    const reqs = new Map();
    reqs.set('req1.1', { url: 'https://ok.com', method: 'GET', status: 200 });
    reqs.set('req2.1', { url: 'https://err.com', method: 'GET', status: 500 });
    reqs.set('req3.1', { url: 'https://err2.com', method: 'GET', status: 404 });
    reqs.set('req4.1', { url: 'https://pend.com', method: 'POST' });

    const output = netListStr(reqs);
    expect(output).toContain('network[4]');
    expect(output).toContain('errors:2');
    expect(output).toContain('pending:1');
    expect(output).toContain('ok:1');
  });

  it('shows pending status for incomplete requests', () => {
    const reqs = new Map();
    reqs.set('req1.1', { url: 'https://slow.com/data', method: 'POST' });

    const output = netListStr(reqs);
    expect(output).toContain('...');
    expect(output).toContain('POST');
  });

  it('limits to last 50 entries and reports full total in aggregate + trunc note', () => {
    const reqs = new Map();
    for (let i = 0; i < 60; i++) {
      reqs.set(`req${i}.1`, { url: `https://example.com/${i}`, method: 'GET', status: 200 });
    }

    const output = netListStr(reqs);
    // Aggregate reports full total (60), not the 50 shown
    expect(output).toContain('network[60] ok:60');
    // Truncation note tells agent there are more
    expect(output).toContain('showing last 50 of 60');
  });

  it('filters requests and returns a cursor for older matches', () => {
    const reqs = new Map();
    reqs.set('req1', { url: 'https://example.com/api/old', method: 'GET', status: 422, type: 'XHR' });
    reqs.set('req2', { url: 'https://example.com/image.png', method: 'GET', status: 200, type: 'Image' });
    reqs.set('req3', { url: 'https://example.com/api/new', method: 'POST', status: 404, type: 'XHR' });

    const first = netListResult(reqs, { status: '4xx', type: 'xhr', limit: 1 });
    const second = netListResult(reqs, { status: '4xx', type: 'xhr', limit: 1, cursor: first.data.nextCursor });

    expect(first.data.requests.map(request => request.id)).toEqual(['req3']);
    expect(first.data.nextCursor).toBe('1');
    expect(second.data.requests.map(request => request.id)).toEqual(['req1']);
    expect(second.data.nextCursor).toBeNull();
  });
});

// ---- netDetailStr ----

describe('netDetailStr', () => {
  it('returns not found for unknown requestId', async () => {
    const reqs = new Map();
    const result = await netDetailStr({}, 'sid', 'nonexistent', reqs);
    expect(result).toContain('not found');
  });

  it('formats full request detail', async () => {
    const reqs = new Map();
    reqs.set('req1.1', {
      url: 'https://api.example.com/users',
      method: 'POST',
      status: 201,
      statusText: 'Created',
      mimeType: 'application/json',
      requestHeaders: { 'Content-Type': 'application/json', 'Authorization': 'Bearer xxx' },
      responseHeaders: { 'Content-Type': 'application/json', 'X-Request-Id': 'abc123' },
      timing: { dnsStart: 0, dnsEnd: 5, connectStart: 5, connectEnd: 20, sslStart: 10, sslEnd: 20, sendStart: 20, sendEnd: 22, receiveHeadersEnd: 50 },
    });

    const cdp = { send: () => Promise.reject(new Error('no body')) };
    const result = await netDetailStr(cdp, 'sid', 'req1.1', reqs);

    expect(result).toContain('POST https://api.example.com/users');
    expect(result).toContain('201 Created');
    expect(result).toContain('application/json');
    expect(result).toContain('Request Headers:');
    expect(result).toContain('Authorization: <redacted>');
    expect(result).not.toContain('Bearer xxx');
    expect(result).toContain('Response Headers:');
    expect(result).toContain('X-Request-Id: abc123');
    expect(result).toContain('DNS: 5.0ms');
    expect(result).toContain('Connect: 15.0ms');
    expect(result).toContain('SSL: 10.0ms');
    expect(result).toContain('TTFB: 28.0ms');
    expect(result).toContain('Body: (unavailable)');
  });

  it('reveals sensitive request data only when explicitly requested', async () => {
    const reqs = new Map([['req1.1', {
      url: 'https://api.example.com/users?token=secret',
      method: 'GET',
      status: 200,
      requestHeaders: { Authorization: 'Bearer xxx' },
    }]]);
    const cdp = mockCdp();

    const result = await netDetailStr(cdp, 'sid1', 'req1.1', reqs, { includeSensitive: true });

    expect(result).toContain('Authorization: Bearer xxx');
    expect(result).toContain('token=secret');
  });

  it('redacts request and response bodies unless explicitly requested', async () => {
    const reqs = new Map([['req1', {
      url: 'https://api.example.com/login',
      method: 'POST',
      status: 200,
      postData: '{"password":"hunter2"}',
    }]]);
    const cdp = { send: async () => ({ body: '{"accessToken":"response-secret"}', base64Encoded: false }) };

    const safe = await netDetailResult(cdp, 'sid', 'req1', reqs);
    const revealed = await netDetailResult(cdp, 'sid', 'req1', reqs, { includeSensitive: true });

    expect(safe.text).not.toContain('hunter2');
    expect(safe.text).not.toContain('response-secret');
    expect(revealed.text).toContain('hunter2');
    expect(revealed.text).toContain('response-secret');
  });

  it('resolves prefix match', async () => {
    const reqs = new Map();
    reqs.set('req123.456', { url: 'https://example.com', method: 'GET', status: 200 });

    const cdp = { send: () => Promise.reject(new Error('no body')) };
    const result = await netDetailStr(cdp, 'sid', 'req123', reqs);

    expect(result).toContain('GET https://example.com');
  });

  it('reports ambiguous prefix', async () => {
    const reqs = new Map();
    reqs.set('req1.1', { url: 'https://a.com', method: 'GET' });
    reqs.set('req1.2', { url: 'https://b.com', method: 'GET' });

    const result = await netDetailStr({}, 'sid', 'req1', reqs);
    expect(result).toContain('Ambiguous');
  });

  it('includes response body when available', async () => {
    const reqs = new Map();
    reqs.set('req1.1', { url: 'https://api.com/data', method: 'GET', status: 200 });

    const cdp = { send: () => Promise.resolve({ body: '{"users": []}', base64Encoded: false }) };
    const result = await netDetailStr(cdp, 'sid', 'req1.1', reqs);

    expect(result).toContain('{"users": []}');
  });

  it('expands response bodies only up to the requested bounded limit', async () => {
    const reqs = new Map([['req1', { url: 'https://api.com/data', method: 'GET', status: 200 }]]);
    const body = 'x'.repeat(5000);
    const cdp = { send: async () => ({ body, base64Encoded: false }) };

    const compact = await netDetailResult(cdp, 'sid', 'req1', reqs);
    const expanded = await netDetailResult(cdp, 'sid', 'req1', reqs, { bodyLimit: 5000 });

    expect(compact.data.request.responseBody).toHaveLength(2003);
    expect(expanded.data.request.responseBody).toHaveLength(5000);
    expect(expanded.data.bodyLimit).toBe(5000);
  });
});

// ---- consoleListStr ----

describe('consoleListStr', () => {
  it('returns standardized empty state for no messages', () => {
    expect(consoleListStr([])).toBe('console: 0 messages captured since daemon started');
  });

  it('formats message list with type prefix and aggregate header', () => {
    const msgs = [
      { id: 0, ts: Date.now(), type: 'log', args: ['hello world'] },
      { id: 1, ts: Date.now(), type: 'error', args: ['something broke'] },
      { id: 2, ts: Date.now(), type: 'warn', args: ['deprecated API'] },
    ];

    const output = consoleListStr(msgs);
    expect(output).toContain('[0]');
    expect(output).toContain('[1]');
    expect(output).toContain('[2]');
    expect(output).toContain('LOG');
    expect(output).toContain('ERR');
    expect(output).toContain('WRN');
    expect(output).toContain('hello world');
    expect(output).toContain('something broke');
    // Pre-computed aggregate header
    expect(output).toContain('console[3]');
    expect(output).toContain('errors:1');
    expect(output).toContain('warnings:1');
    expect(output).toContain('info:1');
  });

  it('omits zero-count keys from aggregate header', () => {
    const msgs = [
      { id: 0, ts: Date.now(), type: 'log', args: ['a'] },
      { id: 1, ts: Date.now(), type: 'log', args: ['b'] },
    ];
    const output = consoleListStr(msgs);
    // Only "info" should appear -- no errors or warnings
    expect(output).toContain('console[2] info:2');
    expect(output).not.toContain('errors:');
    expect(output).not.toContain('warnings:');
  });

  it('limits to last 50 messages and reports full total + trunc note', () => {
    const msgs = [];
    for (let i = 0; i < 60; i++) {
      msgs.push({ id: i, ts: Date.now(), type: 'log', args: [`msg ${i}`] });
    }

    const output = consoleListStr(msgs);
    // Aggregate reports full total, not the 50 shown
    expect(output).toContain('console[60] info:60');
    // Truncation note
    expect(output).toContain('showing last 50 of 60');
    // Should NOT contain first 10 messages (0-9)
    expect(output).not.toContain('[0] ');
    expect(output).not.toContain('[9] ');
    // Should contain last 50 (10-59)
    expect(output).toContain('[10]');
    expect(output).toContain('[59]');
  });

  it('truncates long messages', () => {
    const msgs = [{ id: 0, ts: Date.now(), type: 'log', args: ['x'.repeat(300)] }];
    const output = consoleListStr(msgs);
    expect(output.length).toBeLessThan(300);
  });

  it('filters messages and pages through older matches', () => {
    const msgs = [
      { id: 0, ts: Date.now(), type: 'error', args: ['API old failure'] },
      { id: 1, ts: Date.now(), type: 'log', args: ['API success'] },
      { id: 2, ts: Date.now(), type: 'error', args: ['API new failure'] },
    ];

    const first = consoleListResult(msgs, { type: 'error', query: 'api', limit: 1 });
    const second = consoleListResult(msgs, { type: 'error', query: 'api', limit: 1, cursor: first.data.nextCursor });

    expect(first.data.messages.map(message => message.id)).toEqual([2]);
    expect(first.data.nextCursor).toBe('1');
    expect(second.data.messages.map(message => message.id)).toEqual([0]);
  });
});

// ---- consoleDetailStr ----

describe('consoleDetailStr', () => {
  it('returns not found for unknown id', () => {
    expect(consoleDetailStr([], '99')).toContain('not found');
  });

  it('formats message with args', () => {
    const msgs = [{ id: 0, ts: 1711100000000, type: 'error', args: ['ReferenceError: x is not defined'] }];
    const output = consoleDetailStr(msgs, '0');

    expect(output).toContain('ERROR #0');
    expect(output).toContain('ReferenceError: x is not defined');
  });

  it('redacts sensitive values unless explicitly requested', () => {
    const msgs = [{ id: 0, ts: Date.now(), type: 'log', args: ['Authorization: Bearer console-secret'] }];

    const safe = consoleDetailResult(msgs, '0');
    const revealed = consoleDetailResult(msgs, '0', { includeSensitive: true });

    expect(safe.text).not.toContain('console-secret');
    expect(revealed.text).toContain('console-secret');
  });

  it('includes stack trace when available', () => {
    const msgs = [{
      id: 0, ts: Date.now(), type: 'error', args: ['fail'],
      stackTrace: {
        callFrames: [
          { functionName: 'handleClick', url: 'https://example.com/app.js', lineNumber: 41, columnNumber: 12 },
          { functionName: '', url: 'https://example.com/app.js', lineNumber: 100, columnNumber: 0 },
        ],
      },
    }];

    const output = consoleDetailStr(msgs, '0');
    expect(output).toContain('Stack Trace:');
    expect(output).toContain('at handleClick (https://example.com/app.js:42:13)');
    expect(output).toContain('at (anonymous) (https://example.com/app.js:101:1)');
  });

  it('handles messages without stack trace', () => {
    const msgs = [{ id: 0, ts: Date.now(), type: 'log', args: ['info msg'] }];
    const output = consoleDetailStr(msgs, '0');

    expect(output).toContain('LOG #0');
    expect(output).toContain('info msg');
    expect(output).not.toContain('Stack Trace');
  });

  it('uses 1-based line/column numbers', () => {
    const msgs = [{
      id: 0, ts: Date.now(), type: 'error', args: ['err'],
      stackTrace: {
        callFrames: [{ functionName: 'fn', url: 'file.js', lineNumber: 0, columnNumber: 0 }],
      },
    }];

    const output = consoleDetailStr(msgs, '0');
    // CDP uses 0-based, we convert to 1-based
    expect(output).toContain('file.js:1:1');
  });
});
