// Unit tests for snapshotStr --query filter.
// Covers: match preservation of ancestors, empty match state, ref stability,
// and fingerprints still computed on the full tree (for incremental diff).

import { describe, it, expect, vi } from 'vitest';

function mockCdp(nodes) {
  return {
    send: vi.fn(async (method) => {
      if (method === 'Accessibility.getFullAXTree') return { nodes };
      if (method === 'Runtime.evaluate') return { result: { value: [] } };
      return {};
    }),
  };
}

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

async function getSnapshotStr() {
  const mod = await import(
    '../plugins/chromex/skills/chromex/scripts/lib/commands/snapshot.mjs'
  );
  return mod.snapshotStr;
}

// Build a small login-form tree:
//   RootWebArea "Page"
//     form "Login"
//       textbox "Email"
//       textbox "Password"
//       button "Sign in"
//     link "Forgot password"
function buildLoginTree() {
  return [
    axNode(1, 'RootWebArea', 'Page', { childIds: [2, 6] }),
    axNode(2, 'form', 'Login', { parentId: 1, childIds: [3, 4, 5] }),
    axNode(3, 'textbox', 'Email', { parentId: 2 }),
    axNode(4, 'textbox', 'Password', { parentId: 2 }),
    axNode(5, 'button', 'Sign in', { parentId: 2 }),
    axNode(6, 'link', 'Forgot password', { parentId: 1 }),
  ];
}

describe('snapshotStr --query', () => {
  it('filters tree to matches + ancestors, pruning unrelated branches', async () => {
    const snapshotStr = await getSnapshotStr();
    const cdp = mockCdp(buildLoginTree());
    const { text } = await snapshotStr(cdp, 'sid', true, false, null, 0, 'Email');

    expect(text).toContain('RootWebArea'); // ancestor kept
    expect(text).toContain('form'); // ancestor kept
    expect(text).toContain('Email'); // the match itself
    expect(text).not.toContain('Password'); // sibling of match, NOT kept
    expect(text).not.toContain('Sign in'); // sibling of match, NOT kept
    expect(text).not.toContain('Forgot password'); // unrelated subtree, NOT kept
  });

  it('marks matches with > prefix', async () => {
    const snapshotStr = await getSnapshotStr();
    const cdp = mockCdp(buildLoginTree());
    const { text } = await snapshotStr(cdp, 'sid', true, false, null, 0, 'Email');

    // Match line should have the > prefix
    expect(text).toMatch(/>\s*.*\[textbox\].*Email/);
    // Ancestor (non-match) should NOT have the prefix
    expect(text).toMatch(/\[form\] Login/);
    expect(text).not.toMatch(/>\s*.*\[form\]/);
  });

  it('case-insensitive substring match', async () => {
    const snapshotStr = await getSnapshotStr();
    const cdp = mockCdp(buildLoginTree());
    const { text } = await snapshotStr(cdp, 'sid', true, false, null, 0, 'email');

    expect(text).toContain('Email');
  });

  it('returns explicit empty state string when query has no matches', async () => {
    const snapshotStr = await getSnapshotStr();
    const cdp = mockCdp(buildLoginTree());
    const { text, refMap } = await snapshotStr(
      cdp, 'sid', true, true, null, 0, 'xyz-no-such-thing'
    );

    expect(text).toBe('snap: no matches for query "xyz-no-such-thing"');
    // refMap on no-match is still returned (as the caller may update state)
    expect(refMap).toBeInstanceOf(Map);
  });

  it('matches multiple nodes and keeps ancestors of all of them', async () => {
    const snapshotStr = await getSnapshotStr();
    const cdp = mockCdp(buildLoginTree());
    // "textbox" matches both Email and Password
    const { text } = await snapshotStr(cdp, 'sid', true, false, null, 0, 'textbox');

    expect(text).toContain('Email');
    expect(text).toContain('Password');
    expect(text).toContain('form');
    // button is NOT a textbox -> not matched, not ancestor of match other than via form
    // (form IS kept because it's ancestor of Email/Password, and Sign in is its child but not ancestor of any match)
    expect(text).not.toContain('Sign in');
    expect(text).not.toContain('Forgot password');
  });

  it('matches by value field (e.g. input current value)', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = [
      axNode(1, 'RootWebArea', 'Page', { childIds: [2] }),
      axNode(2, 'textbox', 'Email', { parentId: 1, value: 'user@example.com' }),
    ];
    const cdp = mockCdp(nodes);
    const { text } = await snapshotStr(cdp, 'sid', true, false, null, 0, 'user@example');

    expect(text).toContain('Email');
    expect(text).toContain('user@example.com');
  });
});

describe('snapshotStr --query + refs stability', () => {
  it('refMap contains refs for the FULL tree, not just filtered nodes', async () => {
    const snapshotStr = await getSnapshotStr();
    const cdp = mockCdp(buildLoginTree());
    // Filter to "Email" only -- the rendered output excludes Password/Sign in/Forgot password,
    // but refMap must still contain @e for ALL interactive elements in the tree.
    const { refMap } = await snapshotStr(cdp, 'sid', true, true, null, 0, 'Email');

    // Email, Password, Sign in, Forgot password -> 4 interactive refs total
    expect(refMap.size).toBe(4);
    const roles = [...refMap.values()].map((r) => r.role);
    expect(roles.filter((r) => r === 'textbox')).toHaveLength(2); // Email + Password
    expect(roles).toContain('button'); // Sign in
    expect(roles).toContain('link'); // Forgot password -- proves refs live outside the query filter
  });

  it('ref numbers match between query and non-query calls on same tree', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = buildLoginTree();

    const cdp1 = mockCdp(nodes);
    const full = await snapshotStr(cdp1, 'sid', true, true, null, 0, null);

    const cdp2 = mockCdp(nodes);
    const filtered = await snapshotStr(cdp2, 'sid', true, true, null, 0, 'Email');

    // Same refMap numbers point to the same nodes
    const fullByRole = [...full.refMap.entries()].map(([n, r]) => `${n}:${r.role}:${r.name}`);
    const filteredByRole = [...filtered.refMap.entries()].map(([n, r]) => `${n}:${r.role}:${r.name}`);
    expect(filteredByRole).toEqual(fullByRole);
  });
});

describe('snapshotStr --query + fingerprints', () => {
  it('fingerprints are computed on full tree (survive filter)', async () => {
    const snapshotStr = await getSnapshotStr();
    const cdp = mockCdp(buildLoginTree());
    const { fingerprints } = await snapshotStr(cdp, 'sid', true, false, null, 0, 'Email');

    // Fingerprints should include nodes NOT in the filtered output,
    // because the diff engine needs them for the next (non-query) call.
    // Count visible nodes: RootWebArea, form, textbox Email, textbox Password, button, link
    expect(fingerprints.size).toBeGreaterThanOrEqual(5);
  });

  it('disables incremental diff when query is active (user wants the matched content, not a diff)', async () => {
    const snapshotStr = await getSnapshotStr();
    const nodes = buildLoginTree();

    // First call: establish fingerprints
    const cdp1 = mockCdp(nodes);
    const first = await snapshotStr(cdp1, 'sid', true, false, null, 0, null);

    // Second call with same tree + query: would normally produce "all unchanged" diff,
    // but with query active, should render the matched nodes directly.
    const cdp2 = mockCdp(nodes);
    const { text } = await snapshotStr(cdp2, 'sid', true, false, first.fingerprints, 0, 'Email');

    // Should contain the actual matched content, not an "[incremental: ...]" header
    expect(text).not.toMatch(/^\[incremental:/);
    expect(text).toContain('Email');
  });
});
