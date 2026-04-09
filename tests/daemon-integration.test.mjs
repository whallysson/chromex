// Integration-style tests for the daemon's per-tab state machine,
// specifically the ref/snap/hint lifecycle that the P1 fix addresses.
//
// These tests mirror daemon.mjs:handleCommand state transitions in a small
// harness so we can simulate a sequence of commands without needing a real
// CDP connection or browser. The harness is intentionally minimal -- it only
// reproduces the parts of the state machine that the P1 regression touches:
//
//   - currentRefMap reset on nav (ALL nav variants, including back/forward)
//   - lastFilledRef reset on nav
//   - refMap update from explicit `snap --refs` / `-i`
//   - refMap update from auto-snap on interactive commands
//   - shouldHint gating via isRefMapFresh
//   - empty fresh refMap must clear stale refs and emit no help[]
//
// If you change any of those rules in daemon.mjs, update this harness too.

import { describe, it, expect } from 'vitest';
import { generateHints, isRefMapFresh } from '../plugins/chromex/skills/chromex/scripts/lib/hints.mjs';

// Must stay in sync with AUTO_SNAP_CMDS in daemon.mjs
const AUTO_SNAP_CMDS = new Set([
  'click', 'clickxy', 'type', 'fill', 'clear', 'select', 'check', 'form',
  'nav', 'navigate', 'dialog', 'loadall', 'drag', 'touch', 'upload', 'key',
]);

/**
 * Mini daemon simulator. Only reproduces the state machine needed to
 * regression-test the P1 stale-refs bug.
 */
function createDaemonHarness() {
  let currentRefMap = new Map();
  let lastFilledRef = null;
  let previousFingerprints = null;

  return {
    getState() {
      return {
        currentRefMap: new Map(currentRefMap),
        lastFilledRef,
        previousFingerprints,
      };
    },

    /**
     * Simulate a command dispatch.
     *
     * @param {Object} input
     * @param {string} input.cmd
     * @param {string[]} [input.args]
     * @param {boolean} [input.noSnap]
     * @param {boolean} [input.noHints]
     * @param {{refMap:Map, fingerprints:Map}|null} [input.mockSnapResult]
     *   If provided, simulates what snapshotStr would return for this call.
     * @returns {{shouldHint: boolean, refMap: Map, lastFilledRef: number|null, hints: Array}}
     */
    execute({ cmd, args = [], noSnap = false, noHints = false, mockSnapResult = null }) {
      // Strip both flags the same way chromex.mjs does before daemon dispatch.
      const cleanArgs = args.filter((a) => a !== '--no-snap' && a !== '--no-hints');
      const shouldSnap = AUTO_SNAP_CMDS.has(cmd);

      // ---- nav: reset ref map + lastFilledRef + diff baseline
      if (cmd === 'nav' || cmd === 'navigate') {
        previousFingerprints = null;
        currentRefMap = new Map();
        lastFilledRef = null;
      }

      // ---- snap case: explicit --refs / -i populates refMap directly
      if (cmd === 'snap' || cmd === 'snapshot') {
        const useRefs = cleanArgs.includes('--refs') || cleanArgs.includes('-i');
        if (useRefs && mockSnapResult) {
          currentRefMap = mockSnapResult.refMap;
          previousFingerprints = mockSnapResult.fingerprints;
        }
      }

      // ---- fill via ref: track lastFilledRef (simulated detection)
      if (cmd === 'fill' && cleanArgs[0]?.startsWith('@e')) {
        const refNum = parseInt(cleanArgs[0].slice(2));
        if (!isNaN(refNum)) lastFilledRef = refNum;
      }

      // ---- Auto-snap: fires for AUTO_SNAP_CMDS unless --no-snap
      if (shouldSnap && !noSnap && mockSnapResult) {
        currentRefMap = mockSnapResult.refMap;
        previousFingerprints = mockSnapResult.fingerprints;
      }

      // ---- Decision: emit hints?
      const shouldHint = !noHints && isRefMapFresh({
        cmd,
        shouldSnap,
        noSnap,
        args: cleanArgs,
      });
      const hints = shouldHint
        ? generateHints({ cmd, refMap: currentRefMap, lastFilledRef, hasPage: true })
        : [];

      return {
        shouldHint,
        refMap: new Map(currentRefMap),
        lastFilledRef,
        hints,
      };
    },
  };
}

// --- fixtures ---

function mkSnap(refs) {
  return {
    refMap: new Map(refs.map(([n, role, name]) => [n, { role, name, backendNodeId: `b${n}` }])),
    fingerprints: new Map([['f', 'v']]),
  };
}

// =============================================================================
// P1 regression suite
// =============================================================================

describe('daemon P1 regression: stale refs cannot leak into hints', () => {
  it('nav --no-snap resets refMap and blocks hints', () => {
    const d = createDaemonHarness();

    // Seed: user is on GitHub login, refs are fresh
    const githubLogin = mkSnap([
      [1, 'textbox', 'Email'],
      [2, 'textbox', 'Password'],
      [3, 'button', 'Sign in'],
    ]);
    const r1 = d.execute({ cmd: 'snap', args: ['--refs'], mockSnapResult: githubLogin });
    expect(r1.shouldHint).toBe(true);
    expect(r1.refMap.size).toBe(3);

    // User navs away with --no-snap -- REFS MUST NOT LEAK
    const r2 = d.execute({ cmd: 'nav', args: ['https://other.com'], noSnap: true });
    expect(r2.refMap.size).toBe(0); // refMap wiped
    expect(r2.shouldHint).toBe(false); // hints suppressed even though auto-snap would be a nav cmd
    expect(r2.lastFilledRef).toBe(null);
  });

  it('nav with auto-snap replaces refs completely (no leakage from old page)', () => {
    const d = createDaemonHarness();

    // Seed with old page refs
    d.execute({
      cmd: 'snap',
      args: ['--refs'],
      mockSnapResult: mkSnap([[1, 'button', 'Old Button']]),
    });

    // Nav to new page, auto-snap brings NEW refs
    const newPage = mkSnap([
      [1, 'textbox', 'Search'],
      [2, 'button', 'Go'],
    ]);
    const r = d.execute({ cmd: 'nav', args: ['https://x'], mockSnapResult: newPage });

    expect(r.shouldHint).toBe(true);
    expect(r.refMap.size).toBe(2);
    expect(r.refMap.get(1).name).toBe('Search'); // NEW, not "Old Button"
  });

  it('bare snap (no --refs) after nav does not emit hints with stale refMap', () => {
    const d = createDaemonHarness();

    // Seed
    d.execute({ cmd: 'snap', args: ['--refs'], mockSnapResult: mkSnap([[1, 'button', 'Pre-nav']]) });

    // Nav (auto-snap fires, populates new refs)
    d.execute({
      cmd: 'nav',
      args: ['https://new'],
      mockSnapResult: mkSnap([[1, 'link', 'Post-nav']]),
    });

    // Agent does a bare snap -- should NOT emit hints regardless of refMap state,
    // because we have no guarantee the refMap matches the tree just rendered.
    const r = d.execute({ cmd: 'snap', args: [] });
    expect(r.shouldHint).toBe(false);
  });

  it('click --no-snap does not emit hints even with fresh refMap at start', () => {
    const d = createDaemonHarness();

    // Seed fresh
    d.execute({ cmd: 'snap', args: ['--refs'], mockSnapResult: mkSnap([[1, 'button', 'OK']]) });

    // Click with --no-snap -- DOM may have changed, no post-snap ran
    const r = d.execute({ cmd: 'click', args: ['@e1'], noSnap: true });
    expect(r.shouldHint).toBe(false);
  });

  it('fill --no-snap does not emit hints', () => {
    const d = createDaemonHarness();
    d.execute({ cmd: 'snap', args: ['--refs'], mockSnapResult: mkSnap([[1, 'textbox', 'Q']]) });

    const r = d.execute({ cmd: 'fill', args: ['@e1', 'hello'], noSnap: true });
    expect(r.shouldHint).toBe(false);
  });

  it('fresh auto-snap with zero refs clears stale state and emits no hints', () => {
    const d = createDaemonHarness();

    d.execute({
      cmd: 'snap',
      args: ['--refs'],
      mockSnapResult: mkSnap([
        [1, 'textbox', 'Email'],
        [2, 'button', 'Sign in'],
      ]),
    });

    const r = d.execute({
      cmd: 'click',
      args: ['@e2'],
      mockSnapResult: mkSnap([]),
    });

    expect(r.shouldHint).toBe(true);
    expect(r.refMap.size).toBe(0);
    expect(r.hints).toEqual([]);
  });
});

// =============================================================================
// Happy path: hints fire when they should
// =============================================================================

describe('daemon hint happy path: fresh refs emit hints', () => {
  it('snap --refs emits hints', () => {
    const d = createDaemonHarness();
    const r = d.execute({
      cmd: 'snap',
      args: ['--refs'],
      mockSnapResult: mkSnap([[1, 'textbox', 'Name']]),
    });
    expect(r.shouldHint).toBe(true);
  });

  it('snap -i (alias) emits hints', () => {
    const d = createDaemonHarness();
    const r = d.execute({
      cmd: 'snap',
      args: ['-i'],
      mockSnapResult: mkSnap([[1, 'button', 'Go']]),
    });
    expect(r.shouldHint).toBe(true);
  });

  it('click with default auto-snap emits hints', () => {
    const d = createDaemonHarness();
    d.execute({ cmd: 'snap', args: ['--refs'], mockSnapResult: mkSnap([[1, 'button', 'A']]) });

    const r = d.execute({
      cmd: 'click',
      args: ['@e1'],
      mockSnapResult: mkSnap([[1, 'button', 'B']]),
    });
    expect(r.shouldHint).toBe(true);
  });

  it('fill tracks lastFilledRef and emits hints', () => {
    const d = createDaemonHarness();
    const r = d.execute({
      cmd: 'fill',
      args: ['@e3', 'text'],
      mockSnapResult: mkSnap([[3, 'textbox', 'Name']]),
    });
    expect(r.shouldHint).toBe(true);
    expect(r.lastFilledRef).toBe(3);
  });

  it('noHints=true suppresses even fresh hints', () => {
    const d = createDaemonHarness();
    const r = d.execute({
      cmd: 'snap',
      args: ['--refs'],
      noHints: true,
      mockSnapResult: mkSnap([[1, 'button', 'X']]),
    });
    expect(r.shouldHint).toBe(false);
  });
});

// =============================================================================
// Sequence tests: multi-step flows
// =============================================================================

describe('daemon state transitions over a realistic flow', () => {
  it('full login flow keeps refs fresh through fill -> fill -> click', () => {
    const d = createDaemonHarness();

    // nav -> auto-snap brings login form refs
    const loginForm = mkSnap([
      [1, 'textbox', 'Email'],
      [2, 'textbox', 'Password'],
      [3, 'button', 'Sign in'],
    ]);
    let r = d.execute({ cmd: 'nav', args: ['https://x/login'], mockSnapResult: loginForm });
    expect(r.shouldHint).toBe(true);

    // fill email -- auto-snap returns same refs (form unchanged)
    r = d.execute({ cmd: 'fill', args: ['@e1', 'a@b.com'], mockSnapResult: loginForm });
    expect(r.shouldHint).toBe(true);
    expect(r.lastFilledRef).toBe(1);

    // fill password -- same refs
    r = d.execute({ cmd: 'fill', args: ['@e2', 'pw'], mockSnapResult: loginForm });
    expect(r.shouldHint).toBe(true);
    expect(r.lastFilledRef).toBe(2);

    // click submit -- post-click snap shows dashboard (refs change)
    const dashboard = mkSnap([[1, 'link', 'Logout']]);
    r = d.execute({ cmd: 'click', args: ['@e3'], mockSnapResult: dashboard });
    expect(r.shouldHint).toBe(true);
    expect(r.refMap.get(1).name).toBe('Logout');
  });

  it('lastFilledRef survives between fills but resets on nav', () => {
    const d = createDaemonHarness();
    d.execute({ cmd: 'snap', args: ['--refs'], mockSnapResult: mkSnap([[5, 'textbox', 'X']]) });

    let r = d.execute({ cmd: 'fill', args: ['@e5', 'foo'], mockSnapResult: mkSnap([[5, 'textbox', 'X']]) });
    expect(r.lastFilledRef).toBe(5);

    r = d.execute({ cmd: 'nav', args: ['https://y'], mockSnapResult: mkSnap([[1, 'button', 'Y']]) });
    expect(r.lastFilledRef).toBe(null); // reset
  });

  it('back/forward nav also resets refMap (prior page may hydrate differently)', () => {
    const d = createDaemonHarness();
    d.execute({ cmd: 'snap', args: ['--refs'], mockSnapResult: mkSnap([[1, 'button', 'Now']]) });

    // back nav without snap result -> refMap should still be cleared
    const r = d.execute({ cmd: 'nav', args: ['back'], noSnap: true });
    expect(r.refMap.size).toBe(0);
    expect(r.shouldHint).toBe(false);
  });

  it('any navigation also resets the diff baseline for the next snapshot', () => {
    const d = createDaemonHarness();
    d.execute({ cmd: 'snap', args: ['--refs'], mockSnapResult: mkSnap([[1, 'button', 'Now']]) });
    expect(d.getState().previousFingerprints).toBeInstanceOf(Map);

    d.execute({ cmd: 'nav', args: ['forward'], noSnap: true });
    expect(d.getState().previousFingerprints).toBe(null);
  });
});
