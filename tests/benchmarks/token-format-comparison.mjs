#!/usr/bin/env node
// Token-format comparison benchmark.
//
// Question: should chromex v1.6.0 switch its output format from free-form text
// to something more "structured" (TOON / JSON / JSON-pretty) to save LLM tokens?
//
// TOON (a YAML-inline compact format sometimes proposed for agent interfaces)
// is claimed to cut ~40% against JSON. That comparison is against JSON. The
// real question for us is: how does each candidate compare against our CURRENT
// free-form text, which is already fairly dense?
//
// This script:
//   1. Loads real chromex outputs captured earlier (/tmp/chromex-bench/*)
//      plus a few hand-written representative cases (net list, console list,
//      fill+snapshot+hints). These are "ground truth" of what the agent sees.
//   2. For each case, renders the same information in 4 formats:
//        A. text-free    -- baseline (the actual chromex output today)
//        B. json-min     -- JSON.stringify without spaces
//        C. json-pretty  -- JSON.stringify(obj, null, 2)
//        D. toon-compact -- zero-dep TOON-like encoder (below)
//   3. Counts tokens in each using tiktoken cl100k_base (GPT-4 tokenizer).
//      Claude uses a different tokenizer but the RELATIVE differences between
//      formats are what matter, and BPE tokenizers behave similarly on
//      structured text.
//   4. Reports a table + aggregate summary and a verdict.
//
// NOT a unit test -- run directly: `node tests/benchmarks/token-format-comparison.mjs`

import { readFileSync, existsSync } from 'fs';
import { encodingForModel } from 'js-tiktoken';

const enc = encodingForModel('gpt-4');
const count = (s) => enc.encode(s).length;

// =============================================================================
// TOON-style encoder: zero-dep, ~60 lines.
// A minimal best-effort implementation of the compact YAML-inline style:
// no quotes around alphanumeric keys, inline objects when small, block form
// for nested structures, yaml-ish list markers.
// =============================================================================

function toonEncode(value, indent = 0) {
  const pad = '  '.repeat(indent);

  if (value === null || value === undefined) return 'null';

  if (typeof value === 'string') {
    if (value === '') return '""';
    // Unquoted if safe (no special chars, no leading number)
    if (/^[A-Za-z_][A-Za-z0-9_./:\-]*$/.test(value) && value.length < 40) {
      return value;
    }
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    // Inline if all items are simple scalars and total is short
    const allScalar = value.every(
      (x) => x === null || typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean'
    );
    if (allScalar) {
      const inline = `[${value.map((x) => toonEncode(x)).join(', ')}]`;
      if (inline.length < 80) return inline;
    }
    // Block form: one item per line with "- " marker
    return value
      .map((x) => {
        const rendered = toonEncode(x, indent + 1);
        if (rendered.includes('\n')) {
          // Multi-line child: put marker, then indent the block
          const lines = rendered.split('\n');
          return `${pad}- ${lines[0].trimStart()}\n${lines.slice(1).join('\n')}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join('\n');
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    // Inline if all values are scalar and total length is short
    const allScalar = entries.every(
      ([, v]) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
    );
    if (allScalar) {
      const inline = `{${entries.map(([k, v]) => `${k}: ${toonEncode(v)}`).join(', ')}}`;
      if (inline.length < 80) return inline;
    }
    // Block form: key: value per line
    return entries
      .map(([k, v]) => {
        const rendered = toonEncode(v, indent + 1);
        if (rendered.includes('\n')) {
          return `${pad}${k}:\n${rendered}`;
        }
        return `${pad}${k}: ${rendered}`;
      })
      .join('\n');
  }

  return String(value);
}

// =============================================================================
// Format helpers
// =============================================================================

function jsonMin(obj) {
  return JSON.stringify(obj);
}
function jsonPretty(obj) {
  return JSON.stringify(obj, null, 2);
}

// =============================================================================
// Test cases: (name, textFree, structured)
// Each case has both the current chromex text AND the equivalent structured
// object so we can encode it three other ways and compare fairly.
// =============================================================================

const cases = [];

// ---- Case 1: snap --refs of GitHub login (small interactive page) ----
// Hand-written to match what chromex produces today. Structured version is
// the same information but as nested objects.

const case1Text = `Navigated to https://github.com/login

RootWebArea "Sign in to GitHub"
  @e1 [textbox] Username or email address
  @e2 [textbox] Password
  @e3 [button] Sign in
  @e4 [link] Forgot password?
  @e5 [link] Create an account

help[3]:
  chromex fill <t> @e1 "<value>"  # textbox "Username or email address"
  chromex click <t> @e3  # button "Sign in"
  chromex click <t> @e4  # link "Forgot password?"`;

const case1Struct = {
  action: 'nav',
  url: 'https://github.com/login',
  snapshot: {
    root: { role: 'RootWebArea', name: 'Sign in to GitHub' },
    interactive: [
      { ref: 'e1', role: 'textbox', name: 'Username or email address' },
      { ref: 'e2', role: 'textbox', name: 'Password' },
      { ref: 'e3', role: 'button', name: 'Sign in' },
      { ref: 'e4', role: 'link', name: 'Forgot password?' },
      { ref: 'e5', role: 'link', name: 'Create an account' },
    ],
  },
  hints: [
    { cmd: 'chromex fill <t> @e1 "<value>"', comment: 'textbox "Username or email address"' },
    { cmd: 'chromex click <t> @e3', comment: 'button "Sign in"' },
    { cmd: 'chromex click <t> @e4', comment: 'link "Forgot password?"' },
  ],
};

cases.push({ name: 'snap-login-small', text: case1Text, struct: case1Struct });

// ---- Case 2: snap --full from GitHub repo page (LARGE: 65KB of AX tree) ----
// Pulled from a real chromex run captured earlier.

const case2Path = '/tmp/chromex-bench/m1-baseline.txt';
if (existsSync(case2Path)) {
  const case2Text = readFileSync(case2Path, 'utf8');

  // Build a structured approximation: strip indentation, extract each line as
  // { depth, role, name, ref? }. This is NOT lossless but is a realistic
  // "what if we structured the AX tree" experiment.
  const lines = case2Text.split('\n').filter((l) => l.trim());
  const nodes = lines.map((line) => {
    const depth = (line.match(/^( *)/)[1] || '').length / 2;
    const content = line.trim();
    const refMatch = content.match(/^@e(\d+)\s+/);
    const ref = refMatch ? refMatch[1] : null;
    const rest = refMatch ? content.slice(refMatch[0].length) : content;
    const roleMatch = rest.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (roleMatch) {
      return { d: depth, r: roleMatch[1], n: roleMatch[2] || null, ...(ref ? { e: ref } : {}) };
    }
    return { d: depth, raw: content };
  });
  cases.push({
    name: 'snap-repo-large',
    text: case2Text,
    struct: { snapshot: { nodes } },
  });
} else {
  console.warn('SKIP case 2: /tmp/chromex-bench/m1-baseline.txt not found');
}

// ---- Case 3: net list with 50 tracked requests ----

const case3Text = `network[47] errors:3 pending:0 ok:44
STATUS  METHOD  ID              URL
  200  GET     req1.1          https://github.com/api/user
  200  GET     req2.1          https://avatars.githubusercontent.com/u/1
  200  GET     req3.1          https://github.githubassets.com/assets/main.css
  200  GET     req4.1          https://github.githubassets.com/assets/dark.css
  200  GET     req5.1          https://github.githubassets.com/assets/runtime.js
  304  GET     req6.1          https://api.github.com/user/notifications
  200  GET     req7.1          https://github.com/api/graphql
  500  POST    req8.1          https://api.segment.io/v1/track
  200  GET     req9.1          https://collector.github.com/github/collect
  404  GET     req10.1         https://github.com/missing-resource.js
  200  GET     req11.1         https://github.githubassets.com/assets/icons.svg
  200  GET     req12.1         https://avatars.githubusercontent.com/u/2
  200  GET     req13.1         https://github.com/api/user/repos
  200  GET     req14.1         https://github.githubassets.com/assets/forms.js
  200  GET     req15.1         https://api.github.com/repos/whallysson/chromex
  500  POST    req16.1         https://events.github.com/events/track
  200  GET     req17.1         https://avatars.githubusercontent.com/u/3
  200  GET     req18.1         https://github.com/api/user/starred
  200  GET     req19.1         https://github.githubassets.com/assets/codeblock.js
  200  GET     req20.1         https://github.com/api/user/following

(showing last 20 of 47)

Use "net <target> <requestId>" for detail.`;

const case3Requests = [
  { id: 'req1.1', status: 200, method: 'GET', url: 'https://github.com/api/user' },
  { id: 'req2.1', status: 200, method: 'GET', url: 'https://avatars.githubusercontent.com/u/1' },
  { id: 'req3.1', status: 200, method: 'GET', url: 'https://github.githubassets.com/assets/main.css' },
  { id: 'req4.1', status: 200, method: 'GET', url: 'https://github.githubassets.com/assets/dark.css' },
  { id: 'req5.1', status: 200, method: 'GET', url: 'https://github.githubassets.com/assets/runtime.js' },
  { id: 'req6.1', status: 304, method: 'GET', url: 'https://api.github.com/user/notifications' },
  { id: 'req7.1', status: 200, method: 'GET', url: 'https://github.com/api/graphql' },
  { id: 'req8.1', status: 500, method: 'POST', url: 'https://api.segment.io/v1/track' },
  { id: 'req9.1', status: 200, method: 'GET', url: 'https://collector.github.com/github/collect' },
  { id: 'req10.1', status: 404, method: 'GET', url: 'https://github.com/missing-resource.js' },
  { id: 'req11.1', status: 200, method: 'GET', url: 'https://github.githubassets.com/assets/icons.svg' },
  { id: 'req12.1', status: 200, method: 'GET', url: 'https://avatars.githubusercontent.com/u/2' },
  { id: 'req13.1', status: 200, method: 'GET', url: 'https://github.com/api/user/repos' },
  { id: 'req14.1', status: 200, method: 'GET', url: 'https://github.githubassets.com/assets/forms.js' },
  { id: 'req15.1', status: 200, method: 'GET', url: 'https://api.github.com/repos/whallysson/chromex' },
  { id: 'req16.1', status: 500, method: 'POST', url: 'https://events.github.com/events/track' },
  { id: 'req17.1', status: 200, method: 'GET', url: 'https://avatars.githubusercontent.com/u/3' },
  { id: 'req18.1', status: 200, method: 'GET', url: 'https://github.com/api/user/starred' },
  { id: 'req19.1', status: 200, method: 'GET', url: 'https://github.githubassets.com/assets/codeblock.js' },
  { id: 'req20.1', status: 200, method: 'GET', url: 'https://github.com/api/user/following' },
];
const case3Struct = {
  network: { total: 47, errors: 3, pending: 0, ok: 44, showing: 20, requests: case3Requests },
  hint: 'Use "net <target> <requestId>" for detail',
};
cases.push({ name: 'net-list-50', text: case3Text, struct: case3Struct });

// ---- Case 4: console list with mix of types ----

const case4Text = `console[12] errors:2 warnings:4 info:6
[0] 14:01:23.042 LOG  Initialized session storage
[1] 14:01:23.187 LOG  User profile loaded
[2] 14:01:23.442 WRN  Deprecation: use v2 endpoint for /api/user
[3] 14:01:23.891 LOG  Fetched 47 notifications
[4] 14:01:24.012 WRN  React: componentWillMount is deprecated
[5] 14:01:24.156 ERR  ReferenceError: flotsam is not defined at app.js:1042:7
[6] 14:01:24.398 LOG  Analytics event: page_view
[7] 14:01:24.512 WRN  Service worker update available
[8] 14:01:24.703 ERR  Failed to load resource: https://cdn.example.com/missing.svg
[9] 14:01:24.891 LOG  GraphQL query completed in 203ms
[10] 14:01:25.102 LOG  Mutation: updateUserPrefs succeeded
[11] 14:01:25.301 WRN  Network slow: request exceeded 2s timeout`;

const case4Messages = [
  { id: 0, ts: '14:01:23.042', type: 'log', msg: 'Initialized session storage' },
  { id: 1, ts: '14:01:23.187', type: 'log', msg: 'User profile loaded' },
  { id: 2, ts: '14:01:23.442', type: 'warn', msg: 'Deprecation: use v2 endpoint for /api/user' },
  { id: 3, ts: '14:01:23.891', type: 'log', msg: 'Fetched 47 notifications' },
  { id: 4, ts: '14:01:24.012', type: 'warn', msg: 'React: componentWillMount is deprecated' },
  { id: 5, ts: '14:01:24.156', type: 'error', msg: 'ReferenceError: flotsam is not defined at app.js:1042:7' },
  { id: 6, ts: '14:01:24.398', type: 'log', msg: 'Analytics event: page_view' },
  { id: 7, ts: '14:01:24.512', type: 'warn', msg: 'Service worker update available' },
  { id: 8, ts: '14:01:24.703', type: 'error', msg: 'Failed to load resource: https://cdn.example.com/missing.svg' },
  { id: 9, ts: '14:01:24.891', type: 'log', msg: 'GraphQL query completed in 203ms' },
  { id: 10, ts: '14:01:25.102', type: 'log', msg: 'Mutation: updateUserPrefs succeeded' },
  { id: 11, ts: '14:01:25.301', type: 'warn', msg: 'Network slow: request exceeded 2s timeout' },
];
const case4Struct = {
  console: { total: 12, errors: 2, warnings: 4, info: 6, messages: case4Messages },
};
cases.push({ name: 'console-list-12', text: case4Text, struct: case4Struct });

// ---- Case 5: fill action + incremental snapshot + hints ----

const case5Text = `Filled @e1 [textbox] "Email" with "user@example.com"

[incremental: 2 changed, 18 unchanged]
@e1 [textbox] Email = "user@example.com"
  *[StaticText] user@example.com
*@e6 [button] Clear field

help[2]:
  chromex click <t> @e3  # button "Sign in"
  chromex fill <t> @e2 "<value>"  # textbox "Password"`;

const case5Struct = {
  action: 'fill',
  target: { ref: 'e1', role: 'textbox', name: 'Email' },
  value: 'user@example.com',
  snapshot: {
    diff: { changed: 2, unchanged: 18 },
    updated: [
      { ref: 'e1', role: 'textbox', name: 'Email', value: 'user@example.com' },
      { ref: 'e6', role: 'button', name: 'Clear field', new: true },
    ],
  },
  hints: [
    { cmd: 'chromex click <t> @e3', comment: 'button "Sign in"' },
    { cmd: 'chromex fill <t> @e2 "<value>"', comment: 'textbox "Password"' },
  ],
};
cases.push({ name: 'fill-action-small', text: case5Text, struct: case5Struct });

// =============================================================================
// Run comparison
// =============================================================================

console.log('='.repeat(95));
console.log('CHROMEX TOKEN FORMAT COMPARISON');
console.log('='.repeat(95));
console.log();

const totals = { text: 0, jsonMin: 0, jsonPretty: 0, toon: 0 };
const totalBytes = { text: 0, jsonMin: 0, jsonPretty: 0, toon: 0 };

for (const c of cases) {
  const text = c.text;
  const jMin = jsonMin(c.struct);
  const jPretty = jsonPretty(c.struct);
  const toon = toonEncode(c.struct);

  const tText = count(text);
  const tJMin = count(jMin);
  const tJPretty = count(jPretty);
  const tToon = count(toon);

  totals.text += tText;
  totals.jsonMin += tJMin;
  totals.jsonPretty += tJPretty;
  totals.toon += tToon;

  totalBytes.text += text.length;
  totalBytes.jsonMin += jMin.length;
  totalBytes.jsonPretty += jPretty.length;
  totalBytes.toon += toon.length;

  console.log(`CASE: ${c.name}`);
  console.log('-'.repeat(95));
  console.log(`  ${'format'.padEnd(14)} ${'bytes'.padStart(8)}   ${'tokens'.padStart(8)}   ${'vs text'.padStart(12)}`);
  console.log(`  ${'text-free'.padEnd(14)} ${String(text.length).padStart(8)}   ${String(tText).padStart(8)}   ${'(baseline)'.padStart(12)}`);
  const fmt = (n, base) => {
    const delta = ((n - base) / base) * 100;
    const sign = delta >= 0 ? '+' : '';
    return `${sign}${delta.toFixed(1)}%`.padStart(12);
  };
  console.log(`  ${'json-min'.padEnd(14)} ${String(jMin.length).padStart(8)}   ${String(tJMin).padStart(8)}   ${fmt(tJMin, tText)}`);
  console.log(`  ${'json-pretty'.padEnd(14)} ${String(jPretty.length).padStart(8)}   ${String(tJPretty).padStart(8)}   ${fmt(tJPretty, tText)}`);
  console.log(`  ${'toon-compact'.padEnd(14)} ${String(toon.length).padStart(8)}   ${String(tToon).padStart(8)}   ${fmt(tToon, tText)}`);
  console.log();
}

console.log('='.repeat(95));
console.log('AGGREGATE (all cases combined)');
console.log('='.repeat(95));
console.log();
console.log(`  ${'format'.padEnd(14)} ${'bytes'.padStart(10)}   ${'tokens'.padStart(10)}   ${'vs text'.padStart(12)}`);
console.log(`  ${'text-free'.padEnd(14)} ${String(totalBytes.text).padStart(10)}   ${String(totals.text).padStart(10)}   ${'(baseline)'.padStart(12)}`);
const aggFmt = (n, base) => {
  const delta = ((n - base) / base) * 100;
  const sign = delta >= 0 ? '+' : '';
  return `${sign}${delta.toFixed(1)}%`.padStart(12);
};
console.log(`  ${'json-min'.padEnd(14)} ${String(totalBytes.jsonMin).padStart(10)}   ${String(totals.jsonMin).padStart(10)}   ${aggFmt(totals.jsonMin, totals.text)}`);
console.log(`  ${'json-pretty'.padEnd(14)} ${String(totalBytes.jsonPretty).padStart(10)}   ${String(totals.jsonPretty).padStart(10)}   ${aggFmt(totals.jsonPretty, totals.text)}`);
console.log(`  ${'toon-compact'.padEnd(14)} ${String(totalBytes.toon).padStart(10)}   ${String(totals.toon).padStart(10)}   ${aggFmt(totals.toon, totals.text)}`);
console.log();
console.log('Verdict thresholds: <10% win -> not worth, 10-20% -> marginal, >20% -> worth');
console.log();
