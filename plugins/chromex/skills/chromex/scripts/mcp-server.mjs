#!/usr/bin/env node
// chromex MCP server -- zero dependencies, stdio JSON-RPC 2.0
// Reuses existing daemon infrastructure via IPC (same as CLI)

import { createInterface } from 'readline';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { loadConfig } from './lib/config.mjs';
import { CDP } from './lib/client.mjs';
import { getWsUrl, getPages, formatPageList } from './lib/browser.mjs';
import { audit } from './lib/security.mjs';
import { resolvePrefix, listDaemonSockets } from './lib/utils.mjs';
import { getOrStartTabDaemon, sendCommand, stopDaemons, checkTargetDomain } from './lib/ipc.mjs';
import { launchBrowser, incognitoContext } from './lib/launcher.mjs';
import { openTabStr, closeTabStr, focusTabStr } from './lib/commands/tab.mjs';

const config = loadConfig();
const SERVER_INFO = { name: 'chromex', version: '1.0.0' };

// ---- JSON-RPC helpers ----

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function ok(text) {
  return { content: [{ type: 'text', text: text ?? '' }] };
}

function okWithImage(text, base64Data, mimeType = 'image/png') {
  return {
    content: [
      { type: 'image', data: base64Data, mimeType },
      { type: 'text', text },
    ],
  };
}

function fail(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

// ---- Schema helpers ----

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function tool(name, description, properties, required, annotations) {
  return {
    name, description,
    inputSchema: { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, ...annotations },
  };
}

const P_TARGET = { type: 'string', description: 'Target ID prefix from chromex_list' };
const P_NO_SNAP = { type: 'boolean', description: 'Skip auto-snapshot after action' };

// ---- Tool definitions (52 tools) ----

const TOOLS = [
  // == PAGES (no daemon) ==
  tool('chromex_list',
    'List open browser pages with unique target ID prefixes. Run this first to get target IDs.',
    {}, [], RO),

  tool('chromex_launch',
    'Launch browser with remote debugging enabled. Recommended over manual chrome://inspect setup.',
    {
      incognito: { type: 'boolean', description: 'Launch in incognito mode' },
      browser: { type: 'string', enum: ['chrome', 'brave', 'edge', 'chromium', 'chrome-canary', 'vivaldi'], description: 'Browser to launch' },
      profile: { type: 'string', description: 'Named profile directory' },
      url: { type: 'string', description: 'URL to open on launch' },
    }, [], RW),

  tool('chromex_open',
    'Open a new browser tab.',
    { url: { type: 'string', description: 'URL to open' } },
    ['url'], RW),

  tool('chromex_close',
    'Close a browser tab.',
    { target: P_TARGET }, ['target'], DESTRUCTIVE),

  tool('chromex_focus',
    'Activate/focus a browser tab.',
    { target: P_TARGET }, ['target'], RW),

  tool('chromex_incognito',
    'Create isolated incognito context with separate cookies/storage. No browser relaunch needed.',
    { url: { type: 'string', description: 'URL to open in the incognito context' } },
    [], RW),

  tool('chromex_stop',
    'Stop per-tab daemon(s). Without target, stops all.',
    { target: { type: 'string', description: 'Target ID prefix. Omit to stop all.' } },
    [], DESTRUCTIVE),

  // == INSPECT (readOnly) ==
  tool('chromex_snapshot',
    'Accessibility tree snapshot. Returns incremental diff after first call (only changed nodes). Use refs=true to get @eN references for click/fill/hover.',
    {
      target: P_TARGET,
      refs: { type: 'boolean', description: 'Assign @eN refs to interactive elements', default: false },
      full: { type: 'boolean', description: 'Force full snapshot (skip incremental diff)', default: false },
      depth: { type: 'number', description: 'Max tree depth (0 = unlimited)' },
    }, ['target'], RO),

  tool('chromex_html',
    'Get page HTML, optionally filtered by CSS selector.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector (omit for full page)' },
    }, ['target'], RO),

  tool('chromex_screenshot',
    'Take PNG screenshot. Returns inline image + file path. Image px = CSS px * DPR.',
    {
      target: P_TARGET,
      filePath: { type: 'string', description: 'Output path (default: /tmp/screenshot.png)' },
      fullPage: { type: 'boolean', description: 'Capture full page', default: false },
    }, ['target'], RO),

  tool('chromex_network',
    'Get resource timing / network performance entries.',
    { target: P_TARGET }, ['target'], RO),

  tool('chromex_perf',
    'Core Web Vitals (LCP, FCP, CLS, TTFB), navigation timing, memory, DOM metrics.',
    { target: P_TARGET }, ['target'], RO),

  tool('chromex_console',
    'Capture console output (log/error/warn) for a duration.',
    {
      target: P_TARGET,
      duration: { type: 'number', description: 'Capture duration in ms (default: 5000)' },
    }, ['target'], RO),

  tool('chromex_domsnapshot',
    'Structured DOM snapshot with bounding rects and optional computed styles.',
    {
      target: P_TARGET,
      styles: { type: 'boolean', description: 'Include computed styles', default: false },
    }, ['target'], RO),

  tool('chromex_highlight',
    'Highlight DOM element with visual overlay, or clear highlight.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: "CSS selector to highlight, or 'clear'" },
    }, ['target', 'selector'], RW),

  // == EVALUATE ==
  tool('chromex_eval',
    'Evaluate JavaScript expression in page context. Returns serialized result.',
    {
      target: P_TARGET,
      expression: { type: 'string', description: 'JS expression' },
    }, ['target', 'expression'], RW),

  tool('chromex_evalraw',
    'Execute raw CDP command. Some methods blocked by security config.',
    {
      target: P_TARGET,
      method: { type: 'string', description: 'CDP method (e.g. DOM.getDocument)' },
      params: { type: 'string', description: 'JSON string of method parameters' },
    }, ['target', 'method'], RW),

  // == NAVIGATE ==
  tool('chromex_navigate',
    'Navigate to URL and wait for page load. Returns full snapshot with refs of the new page.',
    {
      target: P_TARGET,
      url: { type: 'string', description: 'URL to navigate to' },
      noSnap: P_NO_SNAP,
    }, ['target', 'url'], RW),

  tool('chromex_waitfor',
    'Wait for CSS selector to appear in DOM.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector' },
      timeout: { type: 'number', description: 'Timeout in ms' },
    }, ['target', 'selector'], RO),

  tool('chromex_wait',
    'Wait for lifecycle event.',
    {
      target: P_TARGET,
      event: { type: 'string', enum: ['networkidle', 'load', 'domready', 'fcp'], description: 'Event to wait for' },
      timeout: { type: 'number', description: 'Timeout in ms' },
    }, ['target', 'event'], RO),

  tool('chromex_scroll',
    'Scroll page. Direction "to" accepts CSS selector as amount.',
    {
      target: P_TARGET,
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom', 'to'], description: 'Scroll direction' },
      amount: { type: 'string', description: 'Pixels (up/down) or CSS selector (for "to")' },
    }, ['target', 'direction'], RW),

  // == INTERACT ==
  tool('chromex_click',
    'Click element by CSS selector or @eN ref from snapshot. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector or @eN ref' },
      noSnap: P_NO_SNAP,
    }, ['target', 'selector'], RW),

  tool('chromex_clickxy',
    'Click at CSS pixel coordinates. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      x: { type: 'number', description: 'X in CSS pixels' },
      y: { type: 'number', description: 'Y in CSS pixels' },
      noSnap: P_NO_SNAP,
    }, ['target', 'x', 'y'], RW),

  tool('chromex_type',
    'Type text at currently focused element. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      text: { type: 'string', description: 'Text to type' },
      noSnap: P_NO_SNAP,
    }, ['target', 'text'], RW),

  tool('chromex_hover',
    'Hover over element by @eN ref. Requires chromex_snapshot with refs=true first.',
    {
      target: P_TARGET,
      ref: { type: 'string', description: 'Element ref (e.g. @e5)' },
    }, ['target', 'ref'], RW),

  tool('chromex_drag',
    'Drag and drop between selectors or coordinate pairs (x1,y1 x2,y2). Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      from: { type: 'string', description: 'Source selector or x,y' },
      to: { type: 'string', description: 'Destination selector or x,y' },
      noSnap: P_NO_SNAP,
    }, ['target', 'from', 'to'], RW),

  tool('chromex_touch',
    'Touch gesture: tap, swipe, pinch, longpress. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      gesture: { type: 'string', enum: ['tap', 'swipe', 'pinch', 'longpress'], description: 'Gesture type' },
      args: { type: 'array', items: { type: 'string' }, description: 'Gesture args: tap(x,y), swipe(x1,y1,x2,y2), pinch(x,y,scale), longpress(x,y,[ms])' },
      noSnap: P_NO_SNAP,
    }, ['target', 'gesture'], RW),

  tool('chromex_dialog',
    'Handle JS dialogs (alert/confirm/prompt). Use "auto" to auto-accept all. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['accept', 'dismiss', 'auto'], description: 'Dialog action' },
      text: { type: 'string', description: 'Text for prompt (only with accept)' },
      noSnap: P_NO_SNAP,
    }, ['target', 'action'], RW),

  tool('chromex_loadall',
    'Click "load more" button repeatedly until it disappears. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector of load-more button' },
      interval: { type: 'number', description: 'Interval between clicks in ms (default: 1500)' },
      noSnap: P_NO_SNAP,
    }, ['target', 'selector'], RW),

  // == FORMS ==
  tool('chromex_fill',
    'Fill input/textarea. Handles React/Vue/Angular controlled inputs. Accepts @eN ref. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector or @eN ref' },
      value: { type: 'string', description: 'Value to fill' },
      noSnap: P_NO_SNAP,
    }, ['target', 'selector', 'value'], RW),

  tool('chromex_clear',
    'Clear input field. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector' },
      noSnap: P_NO_SNAP,
    }, ['target', 'selector'], RW),

  tool('chromex_select',
    'Select option in dropdown. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector of select element' },
      value: { type: 'string', description: 'Option value or visible text' },
      noSnap: P_NO_SNAP,
    }, ['target', 'selector', 'value'], RW),

  tool('chromex_check',
    'Toggle checkbox or radio button. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector' },
      checked: { type: 'boolean', description: 'Desired state (default: true)', default: true },
      noSnap: P_NO_SNAP,
    }, ['target', 'selector'], RW),

  tool('chromex_form',
    'Batch fill form. JSON maps selectors to values. Booleans toggle checkboxes. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      fields: { type: 'string', description: 'JSON: {"#email":"user@test.com","#terms":true}' },
      noSnap: P_NO_SNAP,
    }, ['target', 'fields'], RW),

  tool('chromex_upload',
    'Upload file(s) to input[type=file]. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector of file input' },
      files: { type: 'array', items: { type: 'string' }, description: 'File path(s)' },
      noSnap: P_NO_SNAP,
    }, ['target', 'selector', 'files'], RW),

  // == DATA ==
  tool('chromex_cookies',
    'Manage cookies: list (default), set (JSON), or clear.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['list', 'set', 'clear'], description: 'Action (default: list)' },
      arg: { type: 'string', description: 'For set: JSON cookie. For clear: domain filter.' },
    }, ['target'], RW),

  tool('chromex_storage',
    'Read localStorage, sessionStorage, or clear both.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['local', 'session', 'clear'], description: 'Storage action' },
    }, ['target', 'action'], RW),

  tool('chromex_pdf',
    'Export page as PDF.',
    {
      target: P_TARGET,
      filePath: { type: 'string', description: 'Output path (default: /tmp/page.pdf)' },
    }, ['target'], RW),

  // == NETWORK ==
  tool('chromex_throttle',
    'Throttle network: 3g, slow-3g, 4g, offline, custom, reset.',
    {
      target: P_TARGET,
      preset: { type: 'string', description: 'Preset or "custom" or "reset"' },
      latency: { type: 'number', description: 'Custom latency ms (only with custom)' },
      download: { type: 'number', description: 'Custom download kbps (only with custom)' },
      upload: { type: 'number', description: 'Custom upload kbps (only with custom)' },
    }, ['target', 'preset'], RW),

  tool('chromex_intercept',
    'Intercept network requests: enable (on), block, mock, disable (off), list rules.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['on', 'block', 'mock', 'off', 'rules'], description: 'Action' },
      pattern: { type: 'string', description: 'URL pattern (glob). Required for block/mock.' },
      body: { type: 'string', description: 'Mock response body (JSON). Required for mock.' },
    }, ['target', 'action'], RW),

  tool('chromex_har',
    'Record HTTP traffic as HAR file.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['start', 'stop'], description: 'Start or stop recording' },
      filePath: { type: 'string', description: 'Output path for stop (default: /tmp/chromex.har)' },
    }, ['target', 'action'], RW),

  // == EMULATE ==
  tool('chromex_emulate',
    'Emulate device viewport and user agent.',
    {
      target: P_TARGET,
      device: { type: 'string', description: 'Device: iphone-14, iphone-15-pro, ipad-pro, pixel-7, galaxy-s23, macbook-air, desktop-1080p, desktop-4k, or "reset"' },
    }, ['target', 'device'], RW),

  tool('chromex_geo',
    'Override geolocation or reset.',
    {
      target: P_TARGET,
      latitude: { type: 'string', description: 'Latitude or "reset"' },
      longitude: { type: 'string', description: 'Longitude' },
      accuracy: { type: 'number', description: 'Accuracy in meters (default: 100)' },
    }, ['target', 'latitude'], RW),

  tool('chromex_timezone',
    'Override timezone or reset.',
    {
      target: P_TARGET,
      timezone: { type: 'string', description: 'IANA timezone (e.g. America/Sao_Paulo) or "reset"' },
    }, ['target', 'timezone'], RW),

  tool('chromex_locale',
    'Override browser locale or reset.',
    {
      target: P_TARGET,
      locale: { type: 'string', description: 'BCP 47 locale (e.g. pt-BR) or "reset"' },
    }, ['target', 'locale'], RW),

  tool('chromex_cpu',
    'CPU throttle (1=normal, 4=4x slower, 6=mobile).',
    {
      target: P_TARGET,
      rate: { type: 'string', description: 'Throttle rate or "reset"' },
    }, ['target', 'rate'], RW),

  // == ADVANCED ==
  tool('chromex_inject',
    'Inject JS on every page navigation. Use --file, --remove, --list, or inline script.',
    {
      target: P_TARGET,
      action: { type: 'string', description: 'Script source, "--file", "--remove", or "--list"' },
      arg: { type: 'string', description: 'File path (--file) or script ID (--remove)' },
    }, ['target', 'action'], RW),

  tool('chromex_download',
    'Control file download behavior.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['allow', 'deny', 'reset'], description: 'Download behavior' },
      path: { type: 'string', description: 'Download directory (only with allow)' },
    }, ['target', 'action'], RW),

  tool('chromex_coverage',
    'CSS/JS code coverage. Start collecting, then stop to get report.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['start', 'stop'], description: 'Start or stop' },
    }, ['target', 'action'], RW),

  tool('chromex_trace',
    'Performance trace in chrome://tracing format.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['start', 'stop'], description: 'Start or stop' },
      arg: { type: 'string', description: 'For start: categories. For stop: output file path.' },
    }, ['target', 'action'], RW),

  tool('chromex_heap',
    'Heap snapshot for memory analysis.',
    {
      target: P_TARGET,
      filePath: { type: 'string', description: 'Output path (default: /tmp/chromex-heap.heapsnapshot)' },
    }, ['target'], RO),

  tool('chromex_webauthn',
    'Virtual WebAuthn authenticator for passkey testing.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['enable', 'creds', 'disable'], description: 'Enable, list credentials, or disable' },
    }, ['target', 'action'], RW),
];

// ---- Tool name -> daemon {cmd, args} mapping ----

function toolToCmd(name, p) {
  switch (name) {
    // Inspect
    case 'chromex_snapshot': {
      const a = [];
      if (p.refs) a.push('--refs');
      if (p.full) a.push('--full');
      if (p.depth) a.push(`--depth=${p.depth}`);
      return { cmd: 'snap', args: a };
    }
    case 'chromex_html':       return { cmd: 'html', args: p.selector ? [p.selector] : [] };
    case 'chromex_screenshot': {
      const a = [];
      if (p.filePath) a.push(p.filePath);
      if (p.fullPage) a.push('--full');
      return { cmd: 'shot', args: a };
    }
    case 'chromex_network':    return { cmd: 'net', args: [] };
    case 'chromex_perf':       return { cmd: 'perf', args: [] };
    case 'chromex_console':    return { cmd: 'console', args: p.duration != null ? [String(p.duration)] : [] };
    case 'chromex_domsnapshot': return { cmd: 'domsnapshot', args: p.styles ? ['--styles'] : [] };
    case 'chromex_highlight':  return { cmd: 'highlight', args: [p.selector] };

    // Evaluate
    case 'chromex_eval':       return { cmd: 'eval', args: [p.expression] };
    case 'chromex_evalraw':    return { cmd: 'evalraw', args: p.params ? [p.method, p.params] : [p.method] };

    // Navigate
    case 'chromex_navigate':   return { cmd: 'nav', args: [p.url] };
    case 'chromex_waitfor':    return { cmd: 'waitfor', args: p.timeout != null ? [p.selector, String(p.timeout)] : [p.selector] };
    case 'chromex_wait':       return { cmd: 'wait', args: p.timeout != null ? [p.event, String(p.timeout)] : [p.event] };
    case 'chromex_scroll':     return { cmd: 'scroll', args: p.amount != null ? [p.direction, p.amount] : [p.direction] };

    // Interact
    case 'chromex_click':      return { cmd: 'click', args: [p.selector] };
    case 'chromex_clickxy':    return { cmd: 'clickxy', args: [String(p.x), String(p.y)] };
    case 'chromex_type':       return { cmd: 'type', args: [p.text] };
    case 'chromex_hover':      return { cmd: 'hover', args: [p.ref] };
    case 'chromex_drag':       return { cmd: 'drag', args: [p.from, p.to] };
    case 'chromex_touch':      return { cmd: 'touch', args: [p.gesture, ...(p.args || [])] };
    case 'chromex_dialog':     return { cmd: 'dialog', args: p.text ? [p.action, p.text] : [p.action] };
    case 'chromex_loadall':    return { cmd: 'loadall', args: p.interval != null ? [p.selector, String(p.interval)] : [p.selector] };

    // Forms
    case 'chromex_fill':       return { cmd: 'fill', args: [p.selector, p.value] };
    case 'chromex_clear':      return { cmd: 'clear', args: [p.selector] };
    case 'chromex_select':     return { cmd: 'select', args: [p.selector, p.value] };
    case 'chromex_check':      return { cmd: 'check', args: p.checked === false ? [p.selector, 'false'] : [p.selector] };
    case 'chromex_form':       return { cmd: 'form', args: [p.fields] };
    case 'chromex_upload':     return { cmd: 'upload', args: [p.selector, ...(p.files || [])] };

    // Data
    case 'chromex_cookies':    return { cmd: 'cookies', args: [p.action || 'list', ...(p.arg ? [p.arg] : [])] };
    case 'chromex_storage':    return { cmd: 'storage', args: [p.action] };
    case 'chromex_pdf':        return { cmd: 'pdf', args: p.filePath ? [p.filePath] : [] };

    // Network
    case 'chromex_throttle': {
      if (p.preset === 'custom') {
        return { cmd: 'throttle', args: ['custom', String(p.latency || 0), String(p.download || 0), String(p.upload || 0)] };
      }
      return { cmd: 'throttle', args: [p.preset] };
    }
    case 'chromex_intercept':  return { cmd: 'intercept', args: [p.action, ...(p.pattern ? [p.pattern] : []), ...(p.body ? [p.body] : [])] };
    case 'chromex_har':        return { cmd: 'har', args: p.filePath ? [p.action, p.filePath] : [p.action] };

    // Emulate
    case 'chromex_emulate':    return { cmd: 'emulate', args: [p.device] };
    case 'chromex_geo':        return { cmd: 'geo', args: p.accuracy != null ? [p.latitude, p.longitude, String(p.accuracy)] : p.longitude ? [p.latitude, p.longitude] : [p.latitude] };
    case 'chromex_timezone':   return { cmd: 'timezone', args: [p.timezone] };
    case 'chromex_locale':     return { cmd: 'locale', args: [p.locale] };
    case 'chromex_cpu':        return { cmd: 'cpu', args: [p.rate] };

    // Advanced
    case 'chromex_inject':     return { cmd: 'inject', args: p.arg ? [p.action, p.arg] : [p.action] };
    case 'chromex_download':   return { cmd: 'download', args: p.path ? [p.action, p.path] : [p.action] };
    case 'chromex_coverage':   return { cmd: 'coverage', args: [p.action] };
    case 'chromex_trace':      return { cmd: 'trace', args: p.arg ? [p.action, p.arg] : [p.action] };
    case 'chromex_heap':       return { cmd: 'heap', args: p.filePath ? ['snapshot', p.filePath] : ['snapshot'] };
    case 'chromex_webauthn':   return { cmd: 'webauthn', args: [p.action] };

    default: return null;
  }
}

// ---- Target resolution (with auto-list) ----

// Auto-populate page cache if missing
async function ensurePageCache() {
  if (existsSync(config._pagesCachePath)) return;
  const cdp = new CDP(config.commandTimeout);
  await cdp.connect(getWsUrl());
  const pages = await getPages(cdp);
  cdp.close();
  writeFileSync(config._pagesCachePath, JSON.stringify(pages));
}

async function resolveTarget(prefix) {
  const daemonTargetIds = listDaemonSockets(config._socketDir).map(d => d.targetId);
  const daemonMatches = daemonTargetIds.filter(id => id.toUpperCase().startsWith(prefix.toUpperCase()));

  if (daemonMatches.length > 0) {
    return resolvePrefix(prefix, daemonTargetIds, 'daemon');
  }

  // Auto-list: fetch pages if no cache exists
  await ensurePageCache();

  const pages = JSON.parse(readFileSync(config._pagesCachePath, 'utf8'));
  return resolvePrefix(prefix, pages.map(p => p.targetId), 'target', 'Call chromex_list first.');
}

// ---- Tool execution ----

// Commands that use direct CDP (no daemon)
const NO_DAEMON = new Set([
  'chromex_list', 'chromex_launch', 'chromex_open', 'chromex_close',
  'chromex_focus', 'chromex_incognito', 'chromex_stop',
]);

// Helper: connect to browser, execute, disconnect
async function withBrowser(fn) {
  const cdp = new CDP(config.commandTimeout);
  await cdp.connect(getWsUrl());
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

async function executeTool(name, params) {
  params = params || {};

  // -- No-daemon commands (direct browser CDP) --

  if (name === 'chromex_list') {
    return withBrowser(async (cdp) => {
      const pages = await getPages(cdp);
      writeFileSync(config._pagesCachePath, JSON.stringify(pages));
      audit('list', null, [], { ok: true }, config);
      return ok(formatPageList(pages, config));
    });
  }

  if (name === 'chromex_launch') {
    const result = await launchBrowser(params);
    return ok(result);
  }

  if (name === 'chromex_open') {
    return withBrowser(async (cdp) => ok(await openTabStr(cdp, params.url)));
  }

  if (name === 'chromex_close') {
    return withBrowser(async (cdp) => ok(await closeTabStr(cdp, params.target)));
  }

  if (name === 'chromex_focus') {
    return withBrowser(async (cdp) => ok(await focusTabStr(cdp, params.target)));
  }

  if (name === 'chromex_incognito') {
    return withBrowser(async (cdp) => {
      const result = await incognitoContext(cdp, params.url);
      return ok(result.message);
    });
  }

  if (name === 'chromex_stop') {
    await stopDaemons(params.target || null, config);
    audit('stop', params.target || 'all', [], { ok: true }, config);
    return ok('Daemon(s) stopped.');
  }

  // -- Daemon commands (via IPC Unix socket) --

  if (!NO_DAEMON.has(name) && !params.target) {
    return fail('Target ID required. Call chromex_list first to get target prefixes.');
  }

  const targetId = await resolveTarget(params.target);
  checkTargetDomain(targetId, config);

  const mapped = toolToCmd(name, params);
  if (!mapped) return fail(`Unknown tool: ${name}`);

  if (params.noSnap) mapped.args.push('--no-snap');

  const conn = await getOrStartTabDaemon(targetId, config);
  const response = await sendCommand(conn, { cmd: mapped.cmd, args: mapped.args });

  if (!response.ok) {
    return fail(response.error || 'Command failed');
  }

  // Screenshot: return inline image (base64) + text metadata
  if (name === 'chromex_screenshot' && response.result) {
    const screenshotPath = (response.result.split('\n')[0] || '').trim();
    if (screenshotPath && existsSync(screenshotPath)) {
      const imageData = readFileSync(screenshotPath).toString('base64');
      return okWithImage(response.result, imageData);
    }
  }

  return ok(response.result || '');
}

// ---- MCP protocol handler (JSON-RPC 2.0 over stdio) ----

async function handleMessage(msg) {
  const { id, method, params } = msg;

  // Notifications (no id) -- ignore
  if (id == null) return null;

  switch (method) {
    case 'initialize':
      return {
        result: {
          protocolVersion: params?.protocolVersion || '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case 'tools/list':
      return { result: { tools: TOOLS } };

    case 'tools/call': {
      const toolName = params?.name;
      if (!toolName || !TOOLS.find(t => t.name === toolName)) {
        return { error: { code: -32602, message: `Unknown tool: ${toolName}` } };
      }
      try {
        const result = await executeTool(toolName, params.arguments);
        return { result };
      } catch (err) {
        return { result: fail(err.message) };
      }
    }

    case 'ping':
      return { result: {} };

    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

// Stdin line reader with proper lifecycle
// (waits for pending async operations before exiting when stdin closes)
const rl = createInterface({ input: process.stdin, terminal: false });
let pending = 0;
let closing = false;

function maybeExit() {
  if (closing && pending === 0) process.exit(0);
}

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }

  pending++;
  try {
    const response = await handleMessage(msg);
    if (response !== null) {
      send({ jsonrpc: '2.0', id: msg.id, ...response });
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: err.message } });
  } finally {
    pending--;
    maybeExit();
  }
});

rl.on('close', () => {
  closing = true;
  maybeExit();
});

process.stderr.write('chromex MCP server started\n');
