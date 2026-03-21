// Unit tests for snapshot optimizations: incremental diff, visibility, collapsing, depth, truncation
// Tests pure functions with mock AX tree data -- no browser needed

import { describe, it, expect, vi } from 'vitest';

// Mock CDP client that returns predefined AX tree nodes
function mockCdp(nodes) {
  return {
    send: vi.fn(async (method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes };
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 2 };
      if (method === 'DOM.describeNode') return { backendNodeId: 100 };
      return {};
    }),
  };
}

// Helper: build a minimal AX node
function axNode(nodeId, role, name, opts = {}) {
  return {
    nodeId,
    role: { value: role },
    name: { value: name },
    value: opts.value != null ? { value: opts.value } : undefined,
    parentId: opts.parentId,
    childIds: opts.childIds || [],
    backendDOMNodeId: opts.backendNodeId || `backend_${nodeId}`,
    ignored: opts.ignored || false,
    properties: opts.properties || [],
  };
}

// Dynamic import to get snapshotStr
async function getSnapshotStr() {
  const mod = await import('../plugins/chromex/skills/chromex/scripts/lib/commands/snapshot.mjs');
  return mod.snapshotStr;
}

// ---- Incremental diff tests ----

describe('Incremental Diff', () => {
  it('first snapshot returns full tree (no diff header)', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['h1', 'btn'] }),
      axNode('h1', 'heading', 'Title', { parentId: 'root' }),
      axNode('btn', 'button', 'Click me', { parentId: 'root' }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid', true, false, null);

    expect(result.text).not.toContain('[incremental');
    expect(result.text).toContain('[heading] Title');
    expect(result.text).toContain('[button] Click me');
    expect(result.fingerprints).toBeInstanceOf(Map);
    expect(result.fingerprints.size).toBeGreaterThan(0);
  });

  it('second snapshot with no changes shows incremental header and reduced output', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['h1', 'btn'] }),
      axNode('h1', 'heading', 'Title', { parentId: 'root' }),
      axNode('btn', 'button', 'Click me', { parentId: 'root' }),
    ];
    const cdp = mockCdp(nodes);

    // First snapshot
    const first = await snapshotStr(cdp, 'sid', true, false, null);

    // Second snapshot with same data, passing previous fingerprints
    const second = await snapshotStr(cdp, 'sid', true, false, first.fingerprints);

    expect(second.text).toContain('[incremental');
    expect(second.text).toContain('unchanged');
    // The changed count should be 0 or very low
    expect(second.text).toContain('0 changed');
  });

  it('second snapshot with changes shows only changed nodes', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodesV1 = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['h1', 'btn'] }),
      axNode('h1', 'heading', 'Title', { parentId: 'root' }),
      axNode('btn', 'button', 'Click me', { parentId: 'root' }),
    ];
    const nodesV2 = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['h1', 'btn'] }),
      axNode('h1', 'heading', 'Title', { parentId: 'root' }),
      axNode('btn', 'button', 'Clicked!', { parentId: 'root' }),
    ];

    const cdpV1 = mockCdp(nodesV1);
    const first = await snapshotStr(cdpV1, 'sid', true, false, null);

    const cdpV2 = mockCdp(nodesV2);
    const second = await snapshotStr(cdpV2, 'sid', true, false, first.fingerprints);

    expect(second.text).toContain('[incremental');
    // Changed button should appear
    expect(second.text).toContain('[button] Clicked!');
  });

  it('refs stay stable across incremental snapshots', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['btn1', 'btn2'] }),
      axNode('btn1', 'button', 'First', { parentId: 'root' }),
      axNode('btn2', 'button', 'Second', { parentId: 'root' }),
    ];
    const cdp = mockCdp(nodes);

    const first = await snapshotStr(cdp, 'sid', true, true, null);
    expect(first.refMap.size).toBe(2);
    const firstRef1BackendId = first.refMap.get(1)?.backendNodeId;
    const firstRef2BackendId = first.refMap.get(2)?.backendNodeId;

    // Same data, incremental
    const second = await snapshotStr(cdp, 'sid', true, true, first.fingerprints);
    // Refs should map to same backend nodes
    expect(second.refMap.get(1)?.backendNodeId).toBe(firstRef1BackendId);
    expect(second.refMap.get(2)?.backendNodeId).toBe(firstRef2BackendId);
  });
});

// ---- Visibility filtering tests ----

describe('Visibility Filtering', () => {
  it('ignored nodes are excluded', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['vis', 'hid'] }),
      axNode('vis', 'heading', 'Visible', { parentId: 'root' }),
      axNode('hid', 'heading', 'Hidden', { parentId: 'root', ignored: true }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid');

    expect(result.text).toContain('[heading] Visible');
    expect(result.text).not.toContain('Hidden');
  });

  it('nodes with hidden property are excluded', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['vis', 'hid'] }),
      axNode('vis', 'button', 'Show', { parentId: 'root' }),
      axNode('hid', 'button', 'Secret', {
        parentId: 'root',
        properties: [{ name: 'hidden', value: { value: true } }],
      }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid', true, true);

    expect(result.text).toContain('[button] Show');
    expect(result.text).not.toContain('Secret');
  });

  it('disabled elements do not get refs', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['active', 'disabled'] }),
      axNode('active', 'button', 'Active', { parentId: 'root' }),
      axNode('disabled', 'button', 'Disabled', {
        parentId: 'root',
        properties: [{ name: 'disabled', value: { value: true } }],
      }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid', true, true);

    // Active button gets ref, disabled does not
    expect(result.text).toContain('@e1 [button] Active');
    expect(result.text).toContain('[button] Disabled');
    expect(result.text).not.toContain('@e2');
    expect(result.refMap.size).toBe(1);
  });
});

// ---- Generic node collapsing tests ----

describe('Generic Node Collapsing', () => {
  it('generic wrapper nodes are collapsed (children inherit parent depth)', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['wrap1'] }),
      axNode('wrap1', 'generic', '', { parentId: 'root', childIds: ['wrap2'] }),
      axNode('wrap2', 'generic', '', { parentId: 'wrap1', childIds: ['btn'] }),
      axNode('btn', 'button', 'Deep Button', { parentId: 'wrap2' }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid');

    // Button should be at depth 1 (under root), not depth 3
    const lines = result.text.split('\n');
    const btnLine = lines.find(l => l.includes('[button] Deep Button'));
    expect(btnLine).toBeDefined();
    // Count leading spaces: depth 1 = 2 spaces
    const indent = btnLine.match(/^(\s*)/)[1].length;
    expect(indent).toBe(2); // depth 1, not depth 3 (which would be 6)
  });
});

// ---- Depth limit tests ----

describe('Depth Limit', () => {
  it('depth=1 shows only direct children of root', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['h1'] }),
      axNode('h1', 'heading', 'Title', { parentId: 'root', childIds: ['link'] }),
      axNode('link', 'link', 'Deep Link', { parentId: 'h1' }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid', true, false, null, 1);

    expect(result.text).toContain('[RootWebArea] Page');
    expect(result.text).toContain('[heading] Title');
    // Deep link should NOT appear (depth 2, limit is 1)
    expect(result.text).not.toContain('Deep Link');
  });

  it('depth=0 means unlimited', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['h1'] }),
      axNode('h1', 'heading', 'Title', { parentId: 'root', childIds: ['link'] }),
      axNode('link', 'link', 'Deep Link', { parentId: 'h1' }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid', true, false, null, 0);

    expect(result.text).toContain('Deep Link');
  });
});

// ---- Name truncation tests ----

describe('Name Truncation', () => {
  it('long names are truncated to 200 chars', async () => {
    const snapshotStr = await getSnapshotStr();
    const longName = 'A'.repeat(500);
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['p'] }),
      axNode('p', 'paragraph', longName, { parentId: 'root' }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid');

    expect(result.text).not.toContain('A'.repeat(500));
    expect(result.text).toContain('A'.repeat(200) + '...');
  });

  it('short names are not truncated', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['btn'] }),
      axNode('btn', 'button', 'Submit', { parentId: 'root' }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid');

    expect(result.text).toContain('[button] Submit');
    expect(result.text).not.toContain('...');
  });

  it('long values are truncated', async () => {
    const snapshotStr = await getSnapshotStr();
    const longValue = 'V'.repeat(500);
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['input'] }),
      axNode('input', 'textbox', 'Email', { parentId: 'root', value: longValue }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid');

    expect(result.text).not.toContain('V'.repeat(500));
    expect(result.text).toContain('V'.repeat(200) + '...');
  });
});

// ---- New element marker tests ----

describe('New Element Markers', () => {
  it('new elements in incremental snapshot are prefixed with *', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodesV1 = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['btn1'] }),
      axNode('btn1', 'button', 'Original', { parentId: 'root' }),
    ];
    const nodesV2 = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['btn1', 'btn2'] }),
      axNode('btn1', 'button', 'Original', { parentId: 'root' }),
      axNode('btn2', 'button', 'New Button', { parentId: 'root' }),
    ];

    const cdpV1 = mockCdp(nodesV1);
    const first = await snapshotStr(cdpV1, 'sid', true, false, null);

    const cdpV2 = mockCdp(nodesV2);
    const second = await snapshotStr(cdpV2, 'sid', true, false, first.fingerprints);

    // New button should be prefixed with *
    expect(second.text).toContain('*[button] New Button');
    // Original button should NOT have * (it existed before, but changed because childIds changed on root)
    expect(second.text).not.toMatch(/\*\[button\] Original/);
  });

  it('first snapshot has no * markers', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['btn'] }),
      axNode('btn', 'button', 'Click', { parentId: 'root' }),
    ];
    const cdp = mockCdp(nodes);
    const result = await snapshotStr(cdp, 'sid', true, false, null);

    expect(result.text).not.toContain('*');
  });

  it('new elements with refs show * before @eN', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodesV1 = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['btn1'] }),
      axNode('btn1', 'button', 'First', { parentId: 'root' }),
    ];
    const nodesV2 = [
      axNode('root', 'RootWebArea', 'Page', { childIds: ['btn1', 'btn2'] }),
      axNode('btn1', 'button', 'First', { parentId: 'root' }),
      axNode('btn2', 'button', 'Second', { parentId: 'root' }),
    ];

    const cdpV1 = mockCdp(nodesV1);
    const first = await snapshotStr(cdpV1, 'sid', true, true, null);

    const cdpV2 = mockCdp(nodesV2);
    const second = await snapshotStr(cdpV2, 'sid', true, true, first.fingerprints);

    // New element should have * before the ref tag
    expect(second.text).toMatch(/\*@e\d+ \[button\] Second/);
  });
});
