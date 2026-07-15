#!/usr/bin/env node
// chromex MCP server -- zero dependencies, stdio JSON-RPC 2.0
// Reuses existing daemon infrastructure via IPC (same as CLI)

import { createInterface } from 'readline';
import { existsSync, readFileSync } from 'fs';
import { loadConfig } from './lib/config.mjs';
import { CDP } from './lib/client.mjs';
import { resolveWsUrl, getPages, getPagesHttp, formatPageList, redactPages, writePagesCache } from './lib/browser.mjs';
import { audit } from './lib/security.mjs';
import { resolvePrefix, listDaemonSockets } from './lib/utils.mjs';
import { getOrStartTabDaemon, sendCommand, stopDaemons, checkTargetDomain } from './lib/ipc.mjs';
import { launchBrowser, incognitoContext } from './lib/launcher.mjs';
import { openTabStr, closeTabStr, focusTabStr } from './lib/commands/tab.mjs';
import { doctorStr } from './lib/commands/doctor.mjs';
import { formatSessions, listSessions } from './lib/sessions.mjs';
import { showStr } from './lib/commands/show.mjs';

const config = loadConfig();
const PACKAGE_INFO = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'));
const SERVER_INFO = { name: 'chromex', version: PACKAGE_INFO.version };
const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', LATEST_PROTOCOL_VERSION]);

// ---- JSON-RPC helpers ----

function send(obj) {
  pendingWrites++;
  process.stdout.write(JSON.stringify(obj) + '\n', () => {
    pendingWrites--;
    maybeExit();
  });
}

function ok(text) {
  return { content: [{ type: 'text', text: text ?? '' }], structuredContent: { text: text ?? '', data: null, artifacts: [] } };
}

function okStructured(text, structuredContent) {
  const result = { content: [{ type: 'text', text: text ?? '' }] };
  result.structuredContent = normalizeStructuredContent(text, structuredContent);
  return result;
}

function okWithImage(text, base64Data, mimeType = 'image/png', structuredContent) {
  const result = {
    content: [
      { type: 'image', data: base64Data, mimeType },
      { type: 'text', text },
    ],
  };
  result.structuredContent = normalizeStructuredContent(text, structuredContent);
  return result;
}

function fail(text) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: normalizeStructuredContent(text, { data: { error: text } }),
    isError: true,
  };
}

function normalizeStructuredContent(text, value) {
  if (value && ('text' in value || 'data' in value || 'artifacts' in value)) {
    return { text: value.text ?? text ?? '', data: value.data ?? null, artifacts: value.artifacts || [] };
  }
  return { text: text ?? '', data: value ?? null, artifacts: [] };
}

// ---- Schema helpers ----

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function tool(name, description, properties, required, annotations) {
  return {
    name, title: name.replace(/^chromex_/, '').replaceAll('_', ' '), description,
    inputSchema: { type: 'object', properties: properties || {}, required: required || [], additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        data: {},
        artifacts: { type: 'array', items: { type: 'object' } },
      },
      required: ['text', 'data', 'artifacts'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true, ...annotations },
  };
}

const P_TARGET = { type: 'string', description: 'Target ID prefix from chromex_list' };
const P_NO_SNAP = { type: 'boolean', description: 'Skip auto-snapshot after action' };
const P_NO_HINTS = { type: 'boolean', description: 'Skip contextual help[] suggestions in output' };

// ---- Tool definitions ----

const TOOLS = [
  // == PAGES (no daemon) ==
  tool('chromex_list',
    'List open browser pages with unique target ID prefixes. Run this first to get target IDs.',
    { includeSensitive: { type: 'boolean', description: 'Reveal sensitive URL values only in this live response' } }, [], RO),

  tool('chromex_launch',
    'Launch browser with remote debugging enabled. Supports headless, proxy, insecure certs, and custom Chrome flags.',
    {
      incognito: { type: 'boolean', description: 'Launch in incognito mode' },
      browser: { type: 'string', enum: ['chrome', 'brave', 'edge', 'chromium', 'chrome-canary', 'vivaldi'], description: 'Browser to launch' },
      browserPath: { type: 'string', description: 'Explicit Chromium executable path. Also supported through CHROMEX_BROWSER_PATH.' },
      profile: { type: 'string', description: 'Named profile directory' },
      url: { type: 'string', description: 'URL to open on launch' },
      headless: { type: 'boolean', description: 'Launch in headless mode (no UI)' },
      proxy: { type: 'string', description: 'Proxy server (e.g. socks5://localhost:1080)' },
      insecure: { type: 'boolean', description: 'Ignore certificate errors' },
      pipe: { type: 'boolean', description: 'Use a shared remote debugging pipe without approval modals' },
      extensionTools: { type: 'boolean', description: 'Enable Chrome unsafe extension debugging for extension tools' },
      webMcp: { type: 'boolean', description: 'Enable the experimental WebMCP browser feature' },
      chromeArgs: { type: 'array', items: { type: 'string' }, description: 'Additional Chrome flags to pass through' },
    }, [], RW),

  tool('chromex_doctor',
    'Diagnose local Chromex browser/CDP connectivity, config paths, DevToolsActivePort discovery, and visible pages.',
    {}, [], RO),

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

  tool('chromex_sessions',
    'List named Chromex sessions managed by the CLI.',
    {}, [], RO),

  tool('chromex_show',
    'Create a local dashboard artifact for named Chromex sessions. Annotation mode also writes an annotation pack.',
    {
      annotate: { type: 'boolean', description: 'Write annotation pack alongside the dashboard', default: false },
    }, [], RO),

  // == INSPECT (readOnly) ==
  tool('chromex_snapshot',
    'Accessibility tree snapshot. Returns incremental diff after first call (only changed nodes). Use refs=true to get @eN references for click/fill/hover. Use query to filter to matching nodes + ancestors (preserves hierarchy, slashes page output for large sites). Hints (help[]) are only emitted when refs=true because they rely on a fresh refMap.',
    {
      target: P_TARGET,
      refs: { type: 'boolean', description: 'Assign @eN refs to interactive elements', default: false },
      full: { type: 'boolean', description: 'Force full snapshot (skip incremental diff)', default: false },
      depth: { type: 'number', description: 'Max tree depth (0 = unlimited)' },
      query: { type: 'string', description: 'Filter tree to nodes matching substring (case-insensitive) in role/name/value. Ancestors preserved so hierarchy is intact. @eN refs stay stable.' },
      noHints: P_NO_HINTS,
    }, ['target'], RO),

  tool('chromex_html',
    'Get page HTML, optionally filtered by CSS selector.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector (omit for full page)' },
    }, ['target'], RO),

  tool('chromex_screenshot',
    'Take screenshot. Supports PNG/JPEG/WebP, full page, and element capture by @eN ref. Returns inline image + file path.',
    {
      target: P_TARGET,
      filePath: { type: 'string', description: 'Output path (default: /tmp/screenshot.png)' },
      fullPage: { type: 'boolean', description: 'Capture full page', default: false },
      format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format (default: png)' },
      quality: { type: 'number', description: 'Compression quality 0-100 (JPEG/WebP only)' },
      ref: { type: 'string', description: 'Element ref @eN to capture (requires snap --refs first)' },
    }, ['target'], RO),

  tool('chromex_network',
    'Network requests. Without requestId: list captured requests (status, method, URL). With requestId: full detail (headers, timing, response body).',
    {
      target: P_TARGET,
      requestId: { type: 'string', description: 'Request ID for detail drill-down (from chromex_network listing)' },
      url: { type: 'string', description: 'Case-insensitive URL substring filter for list' },
      method: { type: 'string', description: 'HTTP method filter for list' },
      status: { type: 'string', description: 'Status filter: exact code, 4xx, >=400, success, error, or pending' },
      resourceType: { type: 'string', description: 'CDP resource type filter for list' },
      failed: { type: 'boolean', description: 'Only failed requests and HTTP errors' },
      limit: { type: 'number', minimum: 1, maximum: 200, description: 'Page size for list (default: 50)' },
      cursor: { type: 'string', description: 'Cursor returned by a previous list response' },
      bodyLimit: { type: 'number', minimum: 1, maximum: 1000000, description: 'Maximum request or response body characters for detail (default: 2000)' },
      includeSensitive: { type: 'boolean', description: 'Reveal sensitive headers and URL values only in this response. Audit, stats, and evidence remain redacted.', default: false },
    }, ['target'], RO),

  tool('chromex_perf',
    'Core Web Vitals including INP, long tasks, long animation frames, layout shifts, navigation timing, CPU profiles, and heap allocation sampling.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['summary', 'start', 'stop', 'cpu-start', 'cpu-stop', 'heap-sampling-start', 'heap-sampling-stop'], description: 'Performance action', default: 'summary' },
      filePath: { type: 'string', description: 'Output path for cpu-stop or heap-sampling-stop' },
    }, ['target'], RO),

  tool('chromex_console',
    'Console messages. Default: live capture for duration. "list": stored messages since daemon start. "detail": full message with stack trace.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['capture', 'list', 'detail'], description: 'Action (default: capture)' },
      duration: { type: 'number', description: 'Capture duration in ms (default: 5000, for capture action)' },
      messageId: { type: 'number', description: 'Message ID for detail action' },
      type: { type: 'string', description: 'Console type filter for list' },
      query: { type: 'string', description: 'Case-insensitive message substring filter for list' },
      limit: { type: 'number', minimum: 1, maximum: 200, description: 'Page size for list (default: 50)' },
      cursor: { type: 'string', description: 'Cursor returned by a previous list response' },
      includeSensitive: { type: 'boolean', description: 'Reveal sensitive values only in this live response' },
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

  tool('chromex_locator',
    'Generate a stable locator for an element ref or CSS selector.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'Element ref @eN or CSS selector' },
      format: { type: 'string', enum: ['chromex-test', 'css', 'testing-library'], description: 'Locator output format', default: 'chromex-test' },
    }, ['target', 'selector'], RO),

  tool('chromex_evidence',
    'Create an evidence pack with screenshots, snapshots, HTML, console, network timeline, and local replay HTML.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['start', 'mark', 'stop', 'status', 'replay', 'capture'], description: 'Evidence action' },
      label: { type: 'string', description: 'Pack name for start/capture or mark label for mark/stop' },
    }, ['target', 'action'], RO),

  tool('chromex_issues',
    'Collect and inspect Chromium Audits issues including CORS, CSP, cookies, deprecations, mixed content, accessibility, and form issues.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['enable', 'list', 'clear', 'check-forms', 'disable'], description: 'Issue collection action', default: 'list' },
    }, ['target'], RO),

  tool('chromex_inspect',
    'Inspect computed CSS, matched rules, event listeners, and box model for an element.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['computed', 'matched', 'listeners', 'box', 'all'], description: 'Inspection action', default: 'all' },
      selector: { type: 'string', description: 'CSS selector' },
      filter: { type: 'string', description: 'Optional CSS property name filter' },
    }, ['target', 'selector'], RO),

  tool('chromex_diagnose',
    'Produce a prioritized runtime diagnosis from browser issues, failed requests, exceptions, console warnings, and performance counters.',
    {
      target: P_TARGET,
      limit: { type: 'number', description: 'Maximum findings per category', default: 20 },
    }, ['target'], RO),

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
    'Navigate to URL, back, forward, or reload. Returns snapshot with refs of the resulting page.',
    {
      target: P_TARGET,
      url: { type: 'string', description: 'URL, or action: "back", "forward", "reload", "reload-hard"' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
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
    'Click element by CSS selector or @eN ref. Supports double-click. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector or @eN ref' },
      dblClick: { type: 'boolean', description: 'Double-click instead of single click', default: false },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'selector'], RW),

  tool('chromex_clickxy',
    'Click at CSS pixel coordinates. Supports double-click. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      x: { type: 'number', description: 'X in CSS pixels' },
      y: { type: 'number', description: 'Y in CSS pixels' },
      dblClick: { type: 'boolean', description: 'Double-click instead of single click', default: false },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'x', 'y'], RW),

  tool('chromex_type',
    'Type text at currently focused element. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      text: { type: 'string', description: 'Text to type' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
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
      noHints: P_NO_HINTS,
    }, ['target', 'from', 'to'], RW),

  tool('chromex_touch',
    'Touch gesture: tap, swipe, pinch, longpress. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      gesture: { type: 'string', enum: ['tap', 'swipe', 'pinch', 'longpress'], description: 'Gesture type' },
      args: { type: 'array', items: { type: 'string' }, description: 'Gesture args: tap(x,y), swipe(x1,y1,x2,y2), pinch(x,y,scale), longpress(x,y,[ms])' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'gesture'], RW),

  tool('chromex_dialog',
    'Handle JS dialogs (alert/confirm/prompt). Use "auto" to auto-accept all. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['accept', 'dismiss', 'auto'], description: 'Dialog action' },
      text: { type: 'string', description: 'Text for prompt (only with accept)' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'action'], RW),

  tool('chromex_press_key',
    'Press key or key combination. For form submission (Enter), closing modals (Escape), keyboard shortcuts (Control+A), tab navigation (Tab). Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      key: { type: 'string', description: 'Key or combination: "Enter", "Tab", "Escape", "Control+A", "Control+Shift+R", "Meta+C"' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'key'], RW),

  tool('chromex_loadall',
    'Click "load more" button repeatedly until it disappears. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector of load-more button' },
      interval: { type: 'number', description: 'Interval between clicks in ms (default: 1500)' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'selector'], RW),

  // == FORMS ==
  tool('chromex_fill',
    'Fill input/textarea. Handles React/Vue/Angular controlled inputs. Accepts @eN ref. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector or @eN ref' },
      value: { type: 'string', description: 'Value to fill' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'selector', 'value'], RW),

  tool('chromex_clear',
    'Clear input field. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'selector'], RW),

  tool('chromex_select',
    'Select option in dropdown. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector of select element' },
      value: { type: 'string', description: 'Option value or visible text' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'selector', 'value'], RW),

  tool('chromex_check',
    'Toggle checkbox or radio button. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector' },
      checked: { type: 'boolean', description: 'Desired state (default: true)', default: true },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'selector'], RW),

  tool('chromex_form',
    'Batch fill form. JSON maps selectors to values. Booleans toggle checkboxes. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      fields: { type: 'string', description: 'JSON: {"#email":"user@test.com","#terms":true}' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
    }, ['target', 'fields'], RW),

  tool('chromex_upload',
    'Upload file(s) to input[type=file]. Returns auto-snapshot with updated refs.',
    {
      target: P_TARGET,
      selector: { type: 'string', description: 'CSS selector of file input' },
      files: { type: 'array', items: { type: 'string' }, description: 'File path(s)' },
      noSnap: P_NO_SNAP,
      noHints: P_NO_HINTS,
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

  tool('chromex_state',
    'Save or load portable storage state for cookies and localStorage.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['save', 'load'], description: 'Save or load state' },
      filePath: { type: 'string', description: 'Storage state file path' },
    }, ['target', 'action'], RW),

  tool('chromex_storage_usage',
    'Show origin storage usage, quota, and per-storage-type breakdown.',
    { target: P_TARGET }, ['target'], RO),

  tool('chromex_storage_clear_site_data',
    'Clear all site data for the current origin through CDP Storage.clearDataForOrigin.',
    { target: P_TARGET }, ['target'], DESTRUCTIVE),

  tool('chromex_app_summary',
    'Summarize Application panel state for the current origin: quota, local/session storage, cookies, Cache Storage entries, IndexedDB, Service Workers, storage buckets, and manifest.',
    { target: P_TARGET }, ['target'], RO),

  tool('chromex_service_workers',
    'List Service Worker registrations and versions observed for the current browser session.',
    { target: P_TARGET }, ['target'], RO),

  tool('chromex_service_worker_update',
    'Request an update check for a Service Worker registration scopeURL.',
    {
      target: P_TARGET,
      scopeURL: { type: 'string', description: 'Service Worker registration scope URL' },
    }, ['target', 'scopeURL'], RW),

  tool('chromex_service_worker_skip_waiting',
    'Ask a waiting Service Worker for scopeURL to activate via skipWaiting.',
    {
      target: P_TARGET,
      scopeURL: { type: 'string', description: 'Service Worker registration scope URL' },
    }, ['target', 'scopeURL'], RW),

  tool('chromex_service_worker_unregister',
    'Unregister a Service Worker registration by scopeURL.',
    {
      target: P_TARGET,
      scopeURL: { type: 'string', description: 'Service Worker registration scope URL' },
    }, ['target', 'scopeURL'], DESTRUCTIVE),

  tool('chromex_cache_list',
    'List Cache Storage caches for the current origin with cache IDs and names.',
    { target: P_TARGET }, ['target'], RO),

  tool('chromex_cache_entries',
    'List entries for a Cache Storage cache. cacheId may be a unique prefix from chromex_cache_list.',
    {
      target: P_TARGET,
      cacheId: { type: 'string', description: 'Cache ID or unique cache ID prefix' },
      limit: { type: 'number', description: 'Maximum entries to return (default 20, max 100)' },
      query: { type: 'string', description: 'Optional substring filter for request path, equivalent to CLI --query=/api' },
      pathFilter: { type: 'string', description: 'Deprecated alias for query' },
    }, ['target', 'cacheId'], RO),

  tool('chromex_cache_body',
    'Read the decoded body preview for one Cache Storage request URL.',
    {
      target: P_TARGET,
      cacheId: { type: 'string', description: 'Cache ID or unique cache ID prefix' },
      requestURL: { type: 'string', description: 'Cached request URL' },
    }, ['target', 'cacheId', 'requestURL'], RO),

  tool('chromex_cache_delete_entry',
    'Delete one Cache Storage entry by cacheId and requestURL.',
    {
      target: P_TARGET,
      cacheId: { type: 'string', description: 'Cache ID or unique cache ID prefix' },
      requestURL: { type: 'string', description: 'Cached request URL to delete' },
    }, ['target', 'cacheId', 'requestURL'], DESTRUCTIVE),

  tool('chromex_cache_delete',
    'Delete an entire Cache Storage cache by cacheId.',
    {
      target: P_TARGET,
      cacheId: { type: 'string', description: 'Cache ID or unique cache ID prefix' },
    }, ['target', 'cacheId'], DESTRUCTIVE),

  tool('chromex_indexeddb_list',
    'List IndexedDB database names for the current origin.',
    { target: P_TARGET }, ['target'], RO),

  tool('chromex_indexeddb_schema',
    'Show object stores, key paths, auto-increment flags, and indexes for an IndexedDB database.',
    {
      target: P_TARGET,
      databaseName: { type: 'string', description: 'IndexedDB database name' },
    }, ['target', 'databaseName'], RO),

  tool('chromex_indexeddb_rows',
    'Read a compact preview of rows from an IndexedDB object store.',
    {
      target: P_TARGET,
      databaseName: { type: 'string', description: 'IndexedDB database name' },
      objectStoreName: { type: 'string', description: 'Object store name' },
      limit: { type: 'number', description: 'Maximum rows to return (default 20, max 100)' },
    }, ['target', 'databaseName', 'objectStoreName'], RO),

  tool('chromex_indexeddb_clear_store',
    'Clear all rows from one IndexedDB object store.',
    {
      target: P_TARGET,
      databaseName: { type: 'string', description: 'IndexedDB database name' },
      objectStoreName: { type: 'string', description: 'Object store name' },
    }, ['target', 'databaseName', 'objectStoreName'], DESTRUCTIVE),

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
      status: { type: 'number', description: 'Mock response status code' },
      contentType: { type: 'string', description: 'Mock response content type' },
      headers: { type: 'array', items: { type: 'string' }, description: 'Response headers as "Name: value"' },
      delay: { type: 'number', description: 'Delay mocked response in ms' },
      abort: { type: 'string', description: 'Fetch error reason for block action' },
      removeHeaders: { type: 'array', items: { type: 'string' }, description: 'Request headers to remove before continuing' },
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

  tool('chromex_resize',
    'Resize viewport to custom dimensions (without device preset emulation).',
    {
      target: P_TARGET,
      width: { type: 'number', description: 'Viewport width in pixels' },
      height: { type: 'number', description: 'Viewport height in pixels' },
      dpr: { type: 'number', description: 'Device pixel ratio (default: 1)' },
    }, ['target', 'width', 'height'], RW),

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
    'Stream a performance trace to disk and derive actionable long-task, layout, GC, and layout-shift insights.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['start', 'stop', 'insights', 'insight'], description: 'Trace action' },
      arg: { type: 'string', description: 'Categories, output path, input trace path, or insight type depending on action' },
      filePath: { type: 'string', description: 'Trace file for a specific insight action' },
    }, ['target', 'action'], RW),

  tool('chromex_heap',
    'Capture, inspect, compare, and trace retaining paths in Chrome heap snapshots.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['snapshot', 'close', 'summary', 'details', 'class-nodes', 'dominators', 'duplicate-strings', 'edges', 'retainers', 'retaining-paths', 'compare'], description: 'Heap action (default: snapshot)' },
      filePath: { type: 'string', description: 'Snapshot path' },
      otherFilePath: { type: 'string', description: 'Second snapshot path for compare' },
      node: { type: ['string', 'number'], description: 'Node index, #index, or id:<id>' },
      className: { type: 'string', description: 'Class name fragment for class-nodes' },
      limit: { type: 'number', minimum: 1, maximum: 500, description: 'Maximum rows or paths' },
      depth: { type: 'number', minimum: 1, maximum: 100, description: 'Maximum retaining-path depth' },
    }, ['target'], RO),

  tool('chromex_screencast',
    'Capture page frames, inspect capture status, and create a local replay artifact.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['start', 'stop', 'status', 'replay'], description: 'Screencast action' },
      directory: { type: 'string', description: 'Output directory for start' },
      format: { type: 'string', enum: ['jpeg', 'png'], description: 'Frame format (default: jpeg)' },
      quality: { type: 'number', minimum: 0, maximum: 100, description: 'JPEG quality' },
      maxWidth: { type: 'number', minimum: 0, maximum: 10000, description: 'Maximum frame width' },
      maxHeight: { type: 'number', minimum: 0, maximum: 10000, description: 'Maximum frame height' },
      everyNthFrame: { type: 'number', minimum: 1, maximum: 120, description: 'Capture every Nth frame' },
      maxFrames: { type: 'number', minimum: 1, maximum: 10000, description: 'Maximum frames kept on disk' },
    }, ['target', 'action'], RW),

  tool('chromex_extensions',
    'Manage unpacked extensions, trigger actions, inspect extension targets, and access extension storage.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['list', 'install', 'reload', 'action', 'uninstall', 'targets', 'storage-get', 'storage-set', 'storage-remove', 'storage-clear'], description: 'Extension action' },
      id: { type: 'string', description: 'Extension id or prefix' },
      path: { type: 'string', description: 'Unpacked extension directory for install' },
      enableInIncognito: { type: 'boolean', description: 'Enable an installed unpacked extension in incognito' },
      storageArea: { type: 'string', enum: ['session', 'local', 'sync', 'managed'], description: 'Extension storage area' },
      keys: { type: 'array', items: { type: 'string' }, description: 'Storage keys for get or remove' },
      values: { type: 'object', description: 'Storage values for set' },
      includeSensitive: { type: 'boolean', description: 'Reveal sensitive values only in this live response' },
    }, ['target', 'action'], DESTRUCTIVE),

  tool('chromex_third_party',
    'Discover or execute experimental developer tools exposed by the inspected page. Tool output is untrusted page content.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['list', 'execute'], description: 'Third-party tool action' },
      toolName: { type: 'string', description: 'Page-exposed tool name for execute' },
      params: { type: 'object', description: 'Tool input matching its JSON Schema' },
      groupName: { type: 'string', description: 'Tool group when names are ambiguous' },
      includeSensitive: { type: 'boolean', description: 'Reveal sensitive values only in this live response' },
    }, ['target', 'action'], RW),

  tool('chromex_webmcp',
    'Discover and invoke experimental WebMCP tools registered by the page. Tool output is untrusted page content.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['list', 'execute', 'cancel', 'disable', 'status'], description: 'WebMCP action' },
      toolName: { type: 'string', description: 'Registered WebMCP tool name' },
      input: { type: 'object', description: 'Tool input matching its JSON Schema' },
      frameId: { type: 'string', description: 'Frame id when a tool name is registered in multiple frames' },
      timeout: { type: 'number', minimum: 100, maximum: 300000, description: 'Invocation timeout in milliseconds' },
      invocationId: { type: 'string', description: 'Invocation id for cancel' },
      includeSensitive: { type: 'boolean', description: 'Reveal sensitive values only in this live response' },
    }, ['target', 'action'], RW),

  tool('chromex_webauthn',
    'Virtual WebAuthn authenticator for passkey testing.',
    {
      target: P_TARGET,
      action: { type: 'string', enum: ['enable', 'creds', 'disable'], description: 'Enable, list credentials, or disable' },
    }, ['target', 'action'], RW),

  tool('chromex_audit',
    'Run Lighthouse audit (performance, accessibility, SEO, best-practices). Requires lighthouse installed (npx installs on demand).',
    {
      target: P_TARGET,
      categories: { type: 'string', description: 'Comma-separated: performance,accessibility,seo,best-practices (default: all)' },
      device: { type: 'string', enum: ['mobile', 'desktop'], description: 'Device preset (default: mobile)' },
      reportPath: { type: 'string', description: 'Path to save full HTML report' },
    }, ['target'], RO),

  tool('chromex_stats',
    'Session analytics: command counts, average timing, error rates, action timeline. All data is local, never sent externally.',
    {
      target: P_TARGET,
      full: { type: 'boolean', description: 'Show full timeline instead of last 20 entries' },
      exportPath: { type: 'string', description: 'Export stats as JSON to file path' },
      reset: { type: 'boolean', description: 'Reset all counters' },
    }, ['target'], RO),
];

const CORE_TOOL_NAMES = new Set([
  'chromex_list', 'chromex_launch', 'chromex_doctor', 'chromex_open', 'chromex_close', 'chromex_focus',
  'chromex_stop', 'chromex_snapshot', 'chromex_screenshot',
  'chromex_network', 'chromex_console', 'chromex_eval', 'chromex_navigate', 'chromex_waitfor', 'chromex_wait',
  'chromex_click', 'chromex_type', 'chromex_hover', 'chromex_press_key', 'chromex_fill', 'chromex_form',
  'chromex_upload', 'chromex_emulate', 'chromex_resize',
]);
const DEVTOOLS_TOOL_NAMES = new Set([
  'chromex_list', 'chromex_launch', 'chromex_doctor', 'chromex_open', 'chromex_close', 'chromex_focus',
  'chromex_stop', 'chromex_snapshot', 'chromex_html', 'chromex_screenshot', 'chromex_network',
  'chromex_console', 'chromex_eval', 'chromex_domsnapshot', 'chromex_highlight', 'chromex_issues',
  'chromex_inspect', 'chromex_diagnose', 'chromex_perf', 'chromex_coverage', 'chromex_trace',
  'chromex_heap', 'chromex_screencast', 'chromex_app_summary', 'chromex_service_workers', 'chromex_audit',
]);

function selectedToolset() {
  const flag = process.argv.find(arg => arg.startsWith('--toolset='));
  const splitIndex = process.argv.indexOf('--toolset');
  const value = flag?.slice('--toolset='.length) || (splitIndex >= 0 ? process.argv[splitIndex + 1] : null) || process.env.CHROMEX_TOOLSET || 'full';
  if (!['core', 'devtools', 'full'].includes(value)) throw new Error(`Unknown toolset: ${value}`);
  return value;
}

function activeTools() {
  const selected = selectedToolset();
  if (selected === 'core') return TOOLS.filter(item => CORE_TOOL_NAMES.has(item.name));
  if (selected === 'devtools') return TOOLS.filter(item => DEVTOOLS_TOOL_NAMES.has(item.name));
  return TOOLS;
}

// ---- Tool name -> daemon {cmd, args} mapping ----

function toolToCmd(name, p) {
  switch (name) {
    // Inspect
    case 'chromex_snapshot': {
      const a = [];
      if (p.refs) a.push('--refs');
      if (p.full) a.push('--full');
      if (p.depth) a.push(`--depth=${p.depth}`);
      if (p.query) a.push(`--query=${p.query}`);
      return { cmd: 'snap', args: a };
    }
    case 'chromex_html':       return { cmd: 'html', args: p.selector ? [p.selector] : [] };
    case 'chromex_screenshot': {
      const a = [];
      if (p.ref) a.push(p.ref);
      if (p.filePath) a.push(p.filePath);
      if (p.fullPage) a.push('--full');
      if (p.format) a.push(`--format=${p.format}`);
      if (p.quality != null) a.push(`--quality=${p.quality}`);
      return { cmd: 'shot', args: a };
    }
    case 'chromex_network': {
      const args = p.requestId ? [p.requestId] : [];
      if (p.url) args.push(`--url=${p.url}`);
      if (p.method) args.push(`--method=${p.method}`);
      if (p.status) args.push(`--status=${p.status}`);
      if (p.resourceType) args.push(`--type=${p.resourceType}`);
      if (p.failed) args.push('--failed');
      if (p.limit != null) args.push(`--limit=${p.limit}`);
      if (p.cursor) args.push(`--cursor=${p.cursor}`);
      if (p.bodyLimit != null) args.push(`--body-limit=${p.bodyLimit}`);
      if (p.includeSensitive) args.push('--include-sensitive');
      return { cmd: 'net', args };
    }
    case 'chromex_perf':       return { cmd: 'perf', args: [p.action || 'summary', ...(p.filePath ? [p.filePath] : [])] };
    case 'chromex_console': {
      const args = p.action === 'list'
        ? ['list']
        : p.action === 'detail'
          ? ['detail', String(p.messageId ?? '')]
          : p.duration != null ? [String(p.duration)] : [];
      if (p.type) args.push(`--type=${p.type}`);
      if (p.query) args.push(`--query=${p.query}`);
      if (p.limit != null) args.push(`--limit=${p.limit}`);
      if (p.cursor) args.push(`--cursor=${p.cursor}`);
      if (p.includeSensitive) args.push('--include-sensitive');
      return { cmd: 'console', args };
    }
    case 'chromex_domsnapshot': return { cmd: 'domsnapshot', args: p.styles ? ['--styles'] : [] };
    case 'chromex_highlight':  return { cmd: 'highlight', args: [p.selector] };
    case 'chromex_locator':    return { cmd: 'locator', args: [p.selector, p.format ? `--format=${p.format}` : '--format=chromex-test'] };
    case 'chromex_evidence':   return { cmd: 'evidence', args: [p.action, ...(p.label ? [p.label] : [])] };
    case 'chromex_issues':     return { cmd: 'issues', args: [p.action || 'list'] };
    case 'chromex_inspect':    return { cmd: 'inspect', args: [p.action || 'all', p.selector, ...(p.filter ? [p.filter] : [])] };
    case 'chromex_diagnose':   return { cmd: 'diagnose', args: p.limit != null ? [String(p.limit)] : [] };

    // Evaluate
    case 'chromex_eval':       return { cmd: 'eval', args: [p.expression] };
    case 'chromex_evalraw':    return { cmd: 'evalraw', args: p.params ? [p.method, p.params] : [p.method] };

    // Navigate
    case 'chromex_navigate':   return { cmd: 'nav', args: [p.url] };
    case 'chromex_waitfor':    return { cmd: 'waitfor', args: p.timeout != null ? [p.selector, String(p.timeout)] : [p.selector] };
    case 'chromex_wait':       return { cmd: 'wait', args: p.timeout != null ? [p.event, String(p.timeout)] : [p.event] };
    case 'chromex_scroll':     return { cmd: 'scroll', args: p.amount != null ? [p.direction, p.amount] : [p.direction] };

    // Interact
    case 'chromex_click':      return { cmd: 'click', args: p.dblClick ? [p.selector, '--dbl'] : [p.selector] };
    case 'chromex_clickxy':    return { cmd: 'clickxy', args: p.dblClick ? [String(p.x), String(p.y), '--dbl'] : [String(p.x), String(p.y)] };
    case 'chromex_press_key':  return { cmd: 'key', args: [p.key] };
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
    case 'chromex_state':      return { cmd: 'state', args: [p.action, ...(p.filePath ? [p.filePath] : [])] };
    case 'chromex_storage_usage': return { cmd: 'storage', args: ['usage'] };
    case 'chromex_storage_clear_site_data': return { cmd: 'storage', args: ['clear-site-data'] };
    case 'chromex_app_summary': return { cmd: 'app', args: ['summary'] };
    case 'chromex_service_workers': return { cmd: 'sw', args: ['list'] };
    case 'chromex_service_worker_update': return { cmd: 'sw', args: ['update', p.scopeURL] };
    case 'chromex_service_worker_skip_waiting': return { cmd: 'sw', args: ['skip-waiting', p.scopeURL] };
    case 'chromex_service_worker_unregister': return { cmd: 'sw', args: ['unregister', p.scopeURL] };
    case 'chromex_cache_list': return { cmd: 'cache', args: ['list'] };
    case 'chromex_cache_entries': {
      const query = p.query || p.pathFilter || '';
      const args = ['entries', p.cacheId];
      if (p.limit != null) args.push(`--limit=${p.limit}`);
      if (query) args.push(`--query=${query}`);
      return { cmd: 'cache', args };
    }
    case 'chromex_cache_body': return { cmd: 'cache', args: ['body', p.cacheId, p.requestURL] };
    case 'chromex_cache_delete_entry': return { cmd: 'cache', args: ['delete-entry', p.cacheId, p.requestURL] };
    case 'chromex_cache_delete': return { cmd: 'cache', args: ['delete', p.cacheId] };
    case 'chromex_indexeddb_list': return { cmd: 'idb', args: ['list'] };
    case 'chromex_indexeddb_schema': return { cmd: 'idb', args: ['schema', p.databaseName] };
    case 'chromex_indexeddb_rows': return { cmd: 'idb', args: ['rows', p.databaseName, p.objectStoreName, p.limit != null ? `--limit=${p.limit}` : ''].filter(Boolean) };
    case 'chromex_indexeddb_clear_store': return { cmd: 'idb', args: ['clear', p.databaseName, p.objectStoreName] };
    case 'chromex_pdf':        return { cmd: 'pdf', args: p.filePath ? [p.filePath] : [] };

    // Network
    case 'chromex_throttle': {
      if (p.preset === 'custom') {
        return { cmd: 'throttle', args: ['custom', String(p.latency || 0), String(p.download || 0), String(p.upload || 0)] };
      }
      return { cmd: 'throttle', args: [p.preset] };
    }
    case 'chromex_intercept': {
      const a = [p.action, ...(p.pattern ? [p.pattern] : [])];
      if (p.status != null) a.push(`--status=${p.status}`);
      if (p.contentType) a.push(`--content-type=${p.contentType}`);
      if (p.headers) for (const header of p.headers) a.push(`--header=${header}`);
      if (p.delay != null) a.push(`--delay=${p.delay}`);
      if (p.abort) a.push(`--abort=${p.abort}`);
      if (p.removeHeaders?.length) a.push(`--remove-header=${p.removeHeaders.join(',')}`);
      if (p.body) a.push(`--body=${p.body}`);
      return { cmd: 'intercept', args: a };
    }
    case 'chromex_har':        return { cmd: 'har', args: p.filePath ? [p.action, p.filePath] : [p.action] };

    // Emulate
    case 'chromex_emulate':    return { cmd: 'emulate', args: [p.device] };
    case 'chromex_geo':        return { cmd: 'geo', args: p.accuracy != null ? [p.latitude, p.longitude, String(p.accuracy)] : p.longitude ? [p.latitude, p.longitude] : [p.latitude] };
    case 'chromex_timezone':   return { cmd: 'timezone', args: [p.timezone] };
    case 'chromex_locale':     return { cmd: 'locale', args: [p.locale] };
    case 'chromex_cpu':        return { cmd: 'cpu', args: [p.rate] };
    case 'chromex_resize':     return { cmd: 'resize', args: p.dpr ? [String(p.width), String(p.height), String(p.dpr)] : [String(p.width), String(p.height)] };

    // Advanced
    case 'chromex_inject':     return { cmd: 'inject', args: p.arg ? [p.action, p.arg] : [p.action] };
    case 'chromex_download':   return { cmd: 'download', args: p.path ? [p.action, p.path] : [p.action] };
    case 'chromex_coverage':   return { cmd: 'coverage', args: [p.action] };
    case 'chromex_trace':      return { cmd: 'trace', args: [p.action, ...(p.arg ? [p.arg] : []), ...(p.filePath ? [p.filePath] : [])] };
    case 'chromex_heap': {
      const action = p.action || 'snapshot';
      const a = [action];
      if (p.filePath) a.push(p.filePath);
      if (action === 'compare' && p.otherFilePath) a.push(p.otherFilePath);
      if (action === 'class-nodes' && p.className != null) a.push(String(p.className));
      if (['details', 'dominators', 'edges', 'retainers', 'retaining-paths'].includes(action) && p.node != null) a.push(String(p.node));
      if (p.limit != null) a.push(String(p.limit));
      if (action === 'retaining-paths' && p.depth != null) a.push(String(p.depth));
      return { cmd: 'heap', args: a };
    }
    case 'chromex_screencast': {
      const a = [p.action];
      if (p.directory) a.push(p.directory);
      if (p.format) a.push(`--format=${p.format}`);
      if (p.quality != null) a.push(`--quality=${p.quality}`);
      if (p.maxWidth != null) a.push(`--max-width=${p.maxWidth}`);
      if (p.maxHeight != null) a.push(`--max-height=${p.maxHeight}`);
      if (p.everyNthFrame != null) a.push(`--every-nth-frame=${p.everyNthFrame}`);
      if (p.maxFrames != null) a.push(`--max-frames=${p.maxFrames}`);
      return { cmd: 'screencast', args: a };
    }
    case 'chromex_extensions': {
      const a = [p.action];
      if (p.action === 'install') {
        if (p.path) a.push(p.path);
        if (p.enableInIncognito) a.push('--incognito');
      } else if (p.action.startsWith('storage-')) {
        if (p.id) a.push(p.id);
        if (p.storageArea) a.push(p.storageArea);
        if (p.action === 'storage-set' && p.values) a.push(JSON.stringify(p.values));
        if (['storage-get', 'storage-remove'].includes(p.action) && p.keys?.length) a.push(JSON.stringify(p.keys));
        if (p.includeSensitive) a.push('--include-sensitive');
      } else if (p.id) {
        a.push(p.id);
      }
      return { cmd: 'extensions', args: a };
    }
    case 'chromex_third_party': {
      const a = [p.action];
      if (p.action === 'execute') {
        if (p.toolName) a.push(p.toolName);
        a.push(JSON.stringify(p.params || {}));
        if (p.groupName) a.push(p.groupName);
        if (p.includeSensitive) a.push('--include-sensitive');
      }
      return { cmd: 'third-party', args: a };
    }
    case 'chromex_webmcp': {
      const a = [p.action];
      if (p.action === 'execute') {
        if (p.toolName) a.push(p.toolName);
        a.push(JSON.stringify(p.input || {}));
        if (p.frameId) a.push(`--frame=${p.frameId}`);
        if (p.timeout != null) a.push(`--timeout=${p.timeout}`);
        if (p.includeSensitive) a.push('--include-sensitive');
      } else if (p.action === 'cancel' && p.invocationId) {
        a.push(p.invocationId);
      }
      return { cmd: 'webmcp', args: a };
    }
    case 'chromex_webauthn':   return { cmd: 'webauthn', args: [p.action] };
    case 'chromex_audit':      return { cmd: 'audit', args: [p.categories || '', p.device || '', p.reportPath || ''].filter(Boolean) };
    case 'chromex_stats': {
      const a = [];
      if (p.full) a.push('--full');
      if (p.reset) a.push('--reset');
      if (p.exportPath) a.push(`--export=${p.exportPath}`);
      return { cmd: 'stats', args: a };
    }

    default: return null;
  }
}

// ---- Target resolution (with auto-list) ----

// Auto-populate page cache if missing
async function ensurePageCache() {
  if (existsSync(config._pagesCachePath)) return;
  const httpPages = await getPagesHttp(config);
  if (httpPages) {
    writePagesCache(config._pagesCachePath, httpPages);
    return;
  }
  const cdp = new CDP(config.commandTimeout);
  await cdp.connect(await resolveWsUrl(config));
  const pages = await getPages(cdp);
  cdp.close();
  writePagesCache(config._pagesCachePath, pages);
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
  'chromex_list', 'chromex_launch', 'chromex_doctor', 'chromex_open', 'chromex_close',
  'chromex_focus', 'chromex_incognito', 'chromex_stop', 'chromex_sessions', 'chromex_show',
]);

// Helper: connect to browser, execute, disconnect
let browserClient = null;
let browserClientPromise = null;

async function getBrowserClient() {
  if (browserClient) return browserClient;
  if (!browserClientPromise) {
    browserClientPromise = (async () => {
      const cdp = new CDP(config.commandTimeout);
      await cdp.connect(await resolveWsUrl(config));
      cdp.onClose(() => {
        if (browserClient === cdp) browserClient = null;
      });
      browserClient = cdp;
      return cdp;
    })().finally(() => { browserClientPromise = null; });
  }
  return browserClientPromise;
}

async function withBrowser(fn) {
  return fn(await getBrowserClient());
}

async function executeTool(name, params) {
  params = params || {};

  // -- No-daemon commands (direct browser CDP) --

  if (name === 'chromex_list') {
    const httpPages = await getPagesHttp(config);
    if (httpPages) {
      const outputPages = redactPages(httpPages, { includeSensitive: !!params.includeSensitive });
      writePagesCache(config._pagesCachePath, httpPages);
      audit('list', null, [], { ok: true }, config);
      return okStructured(formatPageList(httpPages, config, { includeSensitive: !!params.includeSensitive }), { data: outputPages });
    }
    return withBrowser(async (cdp) => {
      const pages = await getPages(cdp);
      const outputPages = redactPages(pages, { includeSensitive: !!params.includeSensitive });
      writePagesCache(config._pagesCachePath, pages);
      audit('list', null, [], { ok: true }, config);
      return okStructured(formatPageList(pages, config, { includeSensitive: !!params.includeSensitive }), { data: outputPages });
    });
  }

  if (name === 'chromex_launch') {
    const result = await launchBrowser(params);
    const connectingClient = browserClientPromise;
    if (connectingClient) await connectingClient.catch(() => {});
    const previousClient = browserClient;
    browserClient = null;
    previousClient?.close();
    return ok(result);
  }

  if (name === 'chromex_doctor') {
    return ok(await doctorStr(config));
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

  if (name === 'chromex_sessions') {
    return withBrowser(async (cdp) => {
      const pages = await getPages(cdp);
      const records = listSessions(config);
      return okStructured(formatSessions(records, pages), { sessions: records, pages });
    }).catch(() => {
      const records = listSessions(config);
      return okStructured(formatSessions(records, []), { sessions: records, pages: [] });
    });
  }

  if (name === 'chromex_show') {
    return withBrowser(async (cdp) => {
      const pages = await getPages(cdp);
      const result = await showStr(cdp, listSessions(config), pages, !!params.annotate, config);
      return okStructured(result.text, { data: result.data, artifacts: result.artifacts });
    }).catch(() => {
      return showStr(null, listSessions(config), [], !!params.annotate, config)
        .then(result => okStructured(result.text, { data: result.data, artifacts: result.artifacts }));
    });
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
  if (params.noHints) mapped.args.push('--no-hints');

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
      const ext = screenshotPath.split('.').pop()?.toLowerCase();
      const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
      return okWithImage(response.result, imageData, mimeMap[ext] || 'image/png', { data: response.data ?? null, artifacts: response.artifacts || [] });
    }
  }

  if (response.data !== undefined || response.artifacts?.length) {
    return okStructured(response.result || '', { data: response.data ?? null, artifacts: response.artifacts || [] });
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
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.has(params?.protocolVersion) ? params.protocolVersion : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        },
      };

    case 'tools/list':
      return { result: { tools: activeTools() } };

    case 'tools/call': {
      const toolName = params?.name;
      if (!toolName || !activeTools().find(t => t.name === toolName)) {
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
let pendingWrites = 0;

function maybeExit() {
  if (closing && pending === 0 && pendingWrites === 0) {
    browserClient?.close();
    process.exit(0);
  }
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
