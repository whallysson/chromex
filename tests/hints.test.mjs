// Unit tests for lib/hints.mjs
// Pure function -- no browser, no CDP.

import { describe, it, expect } from 'vitest';
import {
  generateHints,
  renderHints,
  isRefMapFresh,
  MAX_HINTS,
} from '../plugins/chromex/skills/chromex/scripts/lib/hints.mjs';

/** Build a refMap from a list of [num, role, name] tuples. */
function mkRefMap(entries) {
  const m = new Map();
  for (const [num, role, name] of entries) {
    m.set(num, { role, name, backendNodeId: `b${num}` });
  }
  return m;
}

describe('generateHints -- bootstrap states', () => {
  it('returns list+launch hints when no page is active', () => {
    const hints = generateHints({ cmd: 'snap', refMap: new Map(), hasPage: false });
    expect(hints).toHaveLength(2);
    expect(hints[0].cmd).toBe('chromex list');
    expect(hints[1].cmd).toBe('chromex launch');
  });

  it('returns snap --refs hint when page exists but refMap is empty', () => {
    const hints = generateHints({ cmd: 'nav', refMap: new Map(), hasPage: true });
    expect(hints).toHaveLength(1);
    expect(hints[0].cmd).toBe('chromex snap <t> --refs');
  });

  it('handles missing refMap gracefully', () => {
    const hints = generateHints({ cmd: 'nav', refMap: null, hasPage: true });
    expect(hints).toHaveLength(1);
    expect(hints[0].cmd).toContain('--refs');
  });
});

describe('generateHints -- after fill', () => {
  it('prioritizes submit button after fill', () => {
    const refMap = mkRefMap([
      [1, 'textbox', 'Email'],
      [2, 'textbox', 'Password'],
      [3, 'button', 'Sign in'],
    ]);
    const hints = generateHints({ cmd: 'fill', refMap, lastFilledRef: 1 });
    expect(hints[0].cmd).toBe('chromex click <t> @e3');
    expect(hints[0].comment).toContain('Sign in');
  });

  it('falls back to key Enter when no submit button is visible', () => {
    const refMap = mkRefMap([
      [1, 'searchbox', 'Search'],
    ]);
    const hints = generateHints({ cmd: 'fill', refMap, lastFilledRef: 1 });
    expect(hints[0].cmd).toBe('chromex key <t> Enter');
  });

  it('suggests next unfilled input after submit hint', () => {
    const refMap = mkRefMap([
      [1, 'textbox', 'Email'],
      [2, 'textbox', 'Password'],
      [3, 'button', 'Log in'],
    ]);
    const hints = generateHints({ cmd: 'fill', refMap, lastFilledRef: 1 });
    expect(hints).toHaveLength(2);
    expect(hints[0].cmd).toBe('chromex click <t> @e3');
    expect(hints[1].cmd).toBe('chromex fill <t> @e2 "<value>"');
  });

  it('does not re-suggest the input that was just filled', () => {
    const refMap = mkRefMap([
      [3, 'textbox', 'Email'],
    ]);
    const hints = generateHints({ cmd: 'fill', refMap, lastFilledRef: 3 });
    // Only the "key Enter" fallback, no re-fill of @e3
    expect(hints.some((h) => h.cmd.includes('@e3'))).toBe(false);
  });
});

describe('generateHints -- after nav', () => {
  it('suggests fill first input when inputs are present', () => {
    const refMap = mkRefMap([
      [1, 'textbox', 'Username'],
      [2, 'button', 'Submit'],
    ]);
    const hints = generateHints({ cmd: 'nav', refMap });
    expect(hints[0].cmd).toBe('chromex fill <t> @e1 "<value>"');
    expect(hints[1].cmd).toBe('chromex click <t> @e2');
  });

  it('suggests click first link when no inputs/buttons', () => {
    const refMap = mkRefMap([
      [1, 'link', 'Read more'],
      [2, 'link', 'Contact us'],
    ]);
    const hints = generateHints({ cmd: 'nav', refMap });
    expect(hints[0].cmd).toBe('chromex click <t> @e1');
    expect(hints[0].comment).toContain('Read more');
  });

  it('accepts both nav and navigate as the same command', () => {
    const refMap = mkRefMap([[1, 'textbox', 'Query']]);
    const a = generateHints({ cmd: 'nav', refMap });
    const b = generateHints({ cmd: 'navigate', refMap });
    expect(a).toEqual(b);
  });
});

describe('generateHints -- default (snap, click, etc)', () => {
  it('returns top interactives with non-empty labels', () => {
    const refMap = mkRefMap([
      [1, 'textbox', 'Email'],
      [2, 'button', 'Sign in'],
      [3, 'link', 'Forgot password'],
    ]);
    const hints = generateHints({ cmd: 'snap', refMap });
    expect(hints).toHaveLength(3);
    expect(hints[0].cmd).toContain('fill');
    expect(hints[0].cmd).toContain('@e1');
  });

  it('caps at MAX_HINTS', () => {
    const refMap = mkRefMap([
      [1, 'button', 'A'],
      [2, 'button', 'B'],
      [3, 'button', 'C'],
      [4, 'button', 'D'],
      [5, 'button', 'E'],
    ]);
    const hints = generateHints({ cmd: 'snap', refMap });
    expect(hints).toHaveLength(MAX_HINTS);
  });

  it('skips refs with empty labels', () => {
    const refMap = mkRefMap([
      [1, 'button', ''],
      [2, 'button', 'Real button'],
    ]);
    const hints = generateHints({ cmd: 'snap', refMap });
    expect(hints).toHaveLength(1);
    expect(hints[0].cmd).toContain('@e2');
  });
});

describe('generateHints -- submit detection', () => {
  it.each([
    'Login',
    'Log in',
    'Sign In',
    'Sign in',
    'Submit',
    'Search',
    'Send',
    'Continue',
    'Apply',
    'Save',
    'OK',
    'Create account',
    'Next step',
  ])('treats %s as submit button', (label) => {
    const refMap = mkRefMap([
      [1, 'textbox', 'Field'],
      [2, 'button', label],
    ]);
    const hints = generateHints({ cmd: 'fill', refMap, lastFilledRef: 1 });
    expect(hints[0].cmd).toBe('chromex click <t> @e2');
  });

  it('does not treat generic button labels as submit', () => {
    const refMap = mkRefMap([
      [1, 'textbox', 'Email'],
      [2, 'button', 'Cancel'],
    ]);
    const hints = generateHints({ cmd: 'fill', refMap, lastFilledRef: 1 });
    // No submit detected -> Enter fallback
    expect(hints[0].cmd).toBe('chromex key <t> Enter');
  });
});

describe('isRefMapFresh -- staleness guard for hints', () => {
  // Auto-snap commands with default (noSnap=false) => fresh
  it('treats click with auto-snap as fresh', () => {
    expect(isRefMapFresh({ cmd: 'click', shouldSnap: true, noSnap: false, args: ['@e1'] })).toBe(true);
  });

  it('treats fill with auto-snap as fresh', () => {
    expect(isRefMapFresh({ cmd: 'fill', shouldSnap: true, noSnap: false, args: ['@e1', 'text'] })).toBe(true);
  });

  it('treats nav with auto-snap as fresh', () => {
    expect(isRefMapFresh({ cmd: 'nav', shouldSnap: true, noSnap: false, args: ['https://x'] })).toBe(true);
  });

  // Auto-snap commands with --no-snap => NOT fresh (this is the P1 bug the guard fixes)
  it('treats click+noSnap as NOT fresh (refs may be stale)', () => {
    expect(isRefMapFresh({ cmd: 'click', shouldSnap: true, noSnap: true, args: ['@e1'] })).toBe(false);
  });

  it('treats fill+noSnap as NOT fresh', () => {
    expect(isRefMapFresh({ cmd: 'fill', shouldSnap: true, noSnap: true, args: ['@e1', 'text'] })).toBe(false);
  });

  it('treats nav+noSnap as NOT fresh (refs from prior page still in map)', () => {
    expect(isRefMapFresh({ cmd: 'nav', shouldSnap: true, noSnap: true, args: ['https://x'] })).toBe(false);
  });

  // Explicit snap with --refs => fresh
  it('treats snap --refs as fresh', () => {
    expect(isRefMapFresh({ cmd: 'snap', shouldSnap: false, noSnap: false, args: ['--refs'] })).toBe(true);
  });

  it('treats snap -i (alias) as fresh', () => {
    expect(isRefMapFresh({ cmd: 'snap', shouldSnap: false, noSnap: false, args: ['-i'] })).toBe(true);
  });

  it('treats snapshot --refs as fresh', () => {
    expect(isRefMapFresh({ cmd: 'snapshot', shouldSnap: false, noSnap: false, args: ['--refs'] })).toBe(true);
  });

  // Bare snap without --refs => NOT fresh
  it('treats bare snap (no --refs) as NOT fresh', () => {
    expect(isRefMapFresh({ cmd: 'snap', shouldSnap: false, noSnap: false, args: [] })).toBe(false);
  });

  it('treats snap --full (no --refs) as NOT fresh', () => {
    expect(isRefMapFresh({ cmd: 'snap', shouldSnap: false, noSnap: false, args: ['--full'] })).toBe(false);
  });

  it('treats snap --query=x (no --refs) as NOT fresh', () => {
    expect(isRefMapFresh({ cmd: 'snap', shouldSnap: false, noSnap: false, args: ['--query=login'] })).toBe(false);
  });

  // Non-auto-snap commands => NOT fresh
  it('treats eval as NOT fresh (does not modify DOM, does not snap)', () => {
    expect(isRefMapFresh({ cmd: 'eval', shouldSnap: false, noSnap: false, args: ['1+1'] })).toBe(false);
  });

  it('treats html as NOT fresh', () => {
    expect(isRefMapFresh({ cmd: 'html', shouldSnap: false, noSnap: false, args: [] })).toBe(false);
  });

  it('handles missing args gracefully', () => {
    expect(isRefMapFresh({ cmd: 'snap', shouldSnap: false, noSnap: false, args: undefined })).toBe(false);
    expect(isRefMapFresh({ cmd: 'snap', shouldSnap: false, noSnap: false, args: null })).toBe(false);
  });
});

describe('renderHints', () => {
  it('returns empty string for empty hints', () => {
    expect(renderHints([])).toBe('');
    expect(renderHints(null)).toBe('');
    expect(renderHints(undefined)).toBe('');
  });

  it('renders single hint with comment', () => {
    const out = renderHints([
      { cmd: 'chromex click <t> @e3', comment: 'button "Login"' },
    ]);
    expect(out).toBe('help[1]:\n  chromex click <t> @e3  # button "Login"');
  });

  it('renders multiple hints', () => {
    const out = renderHints([
      { cmd: 'chromex fill <t> @e1 "<value>"', comment: 'textbox "Email"' },
      { cmd: 'chromex click <t> @e3', comment: 'button "Login"' },
    ]);
    expect(out).toBe(
      'help[2]:\n' +
      '  chromex fill <t> @e1 "<value>"  # textbox "Email"\n' +
      '  chromex click <t> @e3  # button "Login"'
    );
  });

  it('omits comment suffix when comment is missing', () => {
    const out = renderHints([{ cmd: 'chromex list', comment: '' }]);
    expect(out).toBe('help[1]:\n  chromex list');
  });

  it('help[N] count matches hints length', () => {
    const hints = [
      { cmd: 'a', comment: 'x' },
      { cmd: 'b', comment: 'y' },
      { cmd: 'c', comment: 'z' },
    ];
    expect(renderHints(hints)).toMatch(/^help\[3\]:/);
  });
});
