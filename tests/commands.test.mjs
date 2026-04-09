// Unit tests for new command modules: keyboard, stats, audit, network, console
// No real browser -- tests pure logic and error handling

import { describe, it, expect } from 'vitest';
import { readFileSync, unlinkSync } from 'fs';
import { parseKeyCombo, pressKeyStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/keyboard.mjs';
import { SessionStats, statsStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/stats.mjs';
import { netListStr, netDetailStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/network.mjs';
import { consoleListStr, consoleDetailStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/console.mjs';

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

  it('maintains timeline with truncated args', () => {
    const stats = new SessionStats();
    stats.record('fill', ['#email', 'user@test.com', 'extra', 'more'], 1000, 1100, true, null);

    expect(stats.timeline).toHaveLength(1);
    expect(stats.timeline[0].cmd).toBe('fill');
    expect(stats.timeline[0].args).toHaveLength(3); // truncated to 3
    expect(stats.timeline[0].duration).toBe(100);
    expect(stats.timeline[0].ok).toBe(true);
  });

  it('truncates error messages', () => {
    const stats = new SessionStats();
    const longError = 'x'.repeat(200);
    stats.record('eval', ['...'], 1000, 1100, false, longError);

    expect(stats.timeline[0].error.length).toBe(100);
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
    expect(result).toContain('Authorization: Bearer xxx');
    expect(result).toContain('Response Headers:');
    expect(result).toContain('X-Request-Id: abc123');
    expect(result).toContain('DNS: 5.0ms');
    expect(result).toContain('Connect: 15.0ms');
    expect(result).toContain('SSL: 10.0ms');
    expect(result).toContain('TTFB: 28.0ms');
    expect(result).toContain('Body: (unavailable)');
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
