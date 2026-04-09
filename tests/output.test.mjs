// Unit tests for lib/output.mjs helpers.
// Pure functions -- no browser, no CDP, no async.

import { describe, it, expect } from 'vitest';
import {
  emptyState,
  aggregate,
  formatBytes,
  indent,
} from '../plugins/chromex/skills/chromex/scripts/lib/output.mjs';

describe('emptyState', () => {
  it('renders domain with default msg', () => {
    expect(emptyState('network')).toBe('network: empty');
  });

  it('renders domain with custom msg', () => {
    expect(emptyState('network', '0 requests captured')).toBe(
      'network: 0 requests captured'
    );
  });

  it('handles explicit empty msg', () => {
    expect(emptyState('console', '')).toBe('console: ');
  });

  it('renders multi-word domain', () => {
    expect(emptyState('har', 'no traffic recorded')).toBe(
      'har: no traffic recorded'
    );
  });
});

describe('aggregate', () => {
  it('renders header without meta', () => {
    expect(aggregate('network', 47)).toBe('network[47]');
  });

  it('renders header with undefined meta', () => {
    expect(aggregate('network', 47, undefined)).toBe('network[47]');
  });

  it('renders header with empty meta object', () => {
    expect(aggregate('network', 47, {})).toBe('network[47]');
  });

  it('renders header with single meta key', () => {
    expect(aggregate('console', 12, { errors: 2 })).toBe('console[12] errors:2');
  });

  it('renders header with multiple meta keys', () => {
    expect(
      aggregate('network', 47, { errors: 3, pending: 0, total: 47 })
    ).toBe('network[47] errors:3 pending:0 total:47');
  });

  it('preserves insertion order of meta', () => {
    expect(aggregate('net', 5, { b: 1, a: 2 })).toBe('net[5] b:1 a:2');
  });

  it('handles zero count', () => {
    expect(aggregate('stats', 0)).toBe('stats[0]');
  });

  it('handles string meta values', () => {
    expect(aggregate('console', 3, { level: 'error' })).toBe(
      'console[3] level:error'
    );
  });
});

describe('formatBytes', () => {
  it('returns ? for null/undefined', () => {
    expect(formatBytes(null)).toBe('?');
    expect(formatBytes(undefined)).toBe('?');
  });

  it('renders raw bytes under 1KB', () => {
    expect(formatBytes(0)).toBe('0B');
    expect(formatBytes(512)).toBe('512B');
    expect(formatBytes(1023)).toBe('1023B');
  });

  it('renders KB with one decimal', () => {
    expect(formatBytes(1024)).toBe('1.0KB');
    expect(formatBytes(1536)).toBe('1.5KB');
    expect(formatBytes(100 * 1024)).toBe('100.0KB');
  });

  it('renders MB with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0MB');
    expect(formatBytes(2.5 * 1024 * 1024)).toBe('2.5MB');
  });

  it('renders GB with one decimal', () => {
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0GB');
    expect(formatBytes(3.7 * 1024 * 1024 * 1024)).toBe('3.7GB');
  });
});

describe('indent', () => {
  it('indents single line at default level', () => {
    expect(indent('hello')).toBe('  hello');
  });

  it('indents single line at level 2', () => {
    expect(indent('hello', 2)).toBe('    hello');
  });

  it('indents multiline', () => {
    expect(indent('a\nb\nc')).toBe('  a\n  b\n  c');
  });

  it('preserves empty lines without trailing whitespace', () => {
    expect(indent('a\n\nb')).toBe('  a\n\n  b');
  });

  it('level 0 returns text unchanged', () => {
    expect(indent('hello', 0)).toBe('hello');
  });

  it('negative level returns text unchanged', () => {
    expect(indent('hello', -1)).toBe('hello');
  });

  it('empty string returns empty', () => {
    expect(indent('')).toBe('');
  });

  it('null-ish returns empty string', () => {
    expect(indent(null)).toBe('');
    expect(indent(undefined)).toBe('');
  });
});
