// Browser detection and page listing
import { chmodSync, readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import net from 'net';
import { checkDomain } from './security.mjs';
import { redactText, redactUrl } from './redaction.mjs';
import { getDisplayPrefixLength } from './utils.mjs';

// Generate candidates for each browser: base path plus Default/ subfolder
function candidates(base) {
  return [resolve(base, 'DevToolsActivePort'), resolve(base, 'Default/DevToolsActivePort')];
}

const home = homedir();
const CHROMEX_PROFILES_DIR = resolve(home, '.chromex/profiles');
const PIPE_MARKER = 'ChromexPipeActive.json';
const DEVTOOLS_CANDIDATES = [
  // Brave
  ...candidates(resolve(home, 'Library/Application Support/BraveSoftware/Brave-Browser')),
  ...candidates(resolve(home, '.config/BraveSoftware/Brave-Browser')),
  // Chrome
  ...candidates(resolve(home, 'Library/Application Support/Google/Chrome')),
  ...candidates(resolve(home, '.config/google-chrome')),
  // Chrome Canary
  ...candidates(resolve(home, 'Library/Application Support/Google/Chrome Canary')),
  // Chromium
  ...candidates(resolve(home, 'Library/Application Support/Chromium')),
  ...candidates(resolve(home, '.config/chromium')),
  // Edge
  ...candidates(resolve(home, 'Library/Application Support/Microsoft Edge')),
  ...candidates(resolve(home, '.config/microsoft-edge')),
  // Vivaldi
  ...candidates(resolve(home, 'Library/Application Support/Vivaldi')),
  ...candidates(resolve(home, '.config/vivaldi')),
];

function chromexProfileCandidates() {
  if (!existsSync(CHROMEX_PROFILES_DIR)) return [];
  try {
    return readdirSync(CHROMEX_PROFILES_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .flatMap(entry => candidates(resolve(CHROMEX_PROFILES_DIR, entry.name)));
  } catch {
    return [];
  }
}

function availablePortFiles() {
  const explicit = process.env.CDP_PORT_FILE;
  if (explicit) return existsSync(explicit) ? [explicit] : [];
  return [...chromexProfileCandidates(), ...DEVTOOLS_CANDIDATES]
    .filter(path => existsSync(path))
    .sort((a, b) => {
      try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
    });
}

function availablePipeMarkers() {
  if (process.env.CDP_PORT_FILE || !existsSync(CHROMEX_PROFILES_DIR)) return [];
  try {
    return readdirSync(CHROMEX_PROFILES_DIR, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => resolve(CHROMEX_PROFILES_DIR, entry.name, PIPE_MARKER))
      .filter(path => existsSync(path));
  } catch {
    return [];
  }
}

export function findDevToolsPortFile() {
  return availablePortFiles()[0] || null;
}

export function findPipeMarker() {
  return availablePipeMarkers().sort((a, b) => {
    try { return statSync(b).mtimeMs - statSync(a).mtimeMs; } catch { return 0; }
  })[0] || null;
}

export function getWsUrlFromPortFile(portFile) {
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (!lines[0] || !lines[1]) throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

export async function resolveWsUrl(config = {}) {
  const endpoint = configuredEndpoint(config);
  if (endpoint) {
    if (/^unix:\/\//i.test(endpoint)) return endpoint;
    if (/^wss?:\/\//i.test(endpoint)) return endpoint;
    if (/^https?:\/\//i.test(endpoint)) return resolveHttpEndpoint(endpoint, config);
    throw new Error('CDP URL must use http://, https://, ws://, wss://, or unix://.');
  }

  const candidates = [
    ...availablePipeMarkers().map(path => ({ type: 'pipe', path })),
    ...availablePortFiles().map(path => ({ type: 'port', path })),
  ].sort((a, b) => {
    try { return statSync(b.path).mtimeMs - statSync(a.path).mtimeMs; } catch { return 0; }
  });
  for (const candidate of candidates) {
    try {
      if (candidate.type === 'pipe') {
        const marker = JSON.parse(readFileSync(candidate.path, 'utf8'));
        if (marker.socketPath && await canConnectPath(marker.socketPath)) return `unix://${marker.socketPath}`;
      } else {
        const wsUrl = getWsUrlFromPortFile(candidate.path);
        const url = new URL(wsUrl);
        if (await canConnect(url.hostname, Number(url.port))) return wsUrl;
      }
    } catch {}
  }

  throw new Error(
    'Could not find a live DevTools endpoint.\n' +
    'Run: chromex launch\n' +
    'Or configure --cdp-url / CHROMEX_CDP_URL.'
  );
}

export async function getPagesHttp(config = {}) {
  const endpoint = await resolveHttpBase(config).catch(() => null);
  if (!endpoint) return null;
  try {
    const response = await fetch(new URL('/json/list', endpoint), { headers: loadCdpHeaders(config) });
    if (!response.ok) return null;
    const pages = await response.json();
    return pages.filter(page => page.type === 'page' && !page.url.startsWith('chrome://')).map(page => ({
      targetId: page.id,
      type: page.type,
      title: page.title,
      url: page.url,
      attached: page.attached,
      browserContextId: page.browserContextId,
    }));
  } catch {
    return null;
  }
}

export async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

function configuredEndpoint(config) {
  const name = config.cdpEndpoint || process.env.CHROMEX_CDP_ENDPOINT;
  if (name) {
    const endpoint = config.cdpEndpoints?.[name];
    if (!endpoint) throw new Error(`Unknown CDP endpoint: ${name}`);
    return typeof endpoint === 'string' ? endpoint : endpoint.url;
  }
  return config.cdpUrl || process.env.CHROMEX_CDP_URL || null;
}

async function resolveHttpEndpoint(endpoint, config) {
  const base = endpoint.endsWith('/json/version') ? endpoint : new URL('/json/version', ensureTrailingSlash(endpoint)).toString();
  const response = await fetch(base, { headers: loadCdpHeaders(config) });
  if (!response.ok) throw new Error(`CDP endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload.webSocketDebuggerUrl) throw new Error('CDP endpoint did not return webSocketDebuggerUrl.');
  return payload.webSocketDebuggerUrl;
}

async function resolveHttpBase(config) {
  const endpoint = configuredEndpoint(config);
  if (endpoint && /^unix:\/\//i.test(endpoint)) return null;
  if (endpoint && /^https?:\/\//i.test(endpoint)) return ensureTrailingSlash(endpoint.replace(/\/json\/version\/?$/i, '/'));
  if (endpoint && /^wss?:\/\//i.test(endpoint)) {
    const url = new URL(endpoint);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '/';
    url.search = '';
    url.hash = '';
    return url.toString();
  }
  const wsUrl = await resolveWsUrl(config);
  if (/^unix:\/\//i.test(wsUrl)) return null;
  const url = new URL(wsUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function loadCdpHeaders(config) {
  const headers = { ...(config.cdpHeaders || {}) };
  const inline = process.env.CHROMEX_CDP_HEADERS;
  if (inline) Object.assign(headers, parseHeaders(inline, 'CHROMEX_CDP_HEADERS'));
  const file = config.cdpHeadersFile || process.env.CHROMEX_CDP_HEADERS_FILE;
  if (file) Object.assign(headers, parseHeaders(readFileSync(resolve(file), 'utf8'), file));
  return headers;
}

function parseHeaders(value, source) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`Invalid CDP headers JSON: ${source}`);
  }
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}

function canConnect(host, port, timeout = 250) {
  return new Promise(resolveProbe => {
    const socket = net.connect({ host, port });
    const finish = value => {
      socket.destroy();
      resolveProbe(value);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function canConnectPath(path, timeout = 250) {
  return new Promise(resolveProbe => {
    const socket = net.connect(path);
    const finish = value => {
      socket.destroy();
      resolveProbe(value);
    };
    socket.setTimeout(timeout, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

export function redactPages(pages, options = {}) {
  return pages.map(page => ({
    ...page,
    title: redactText(page.title || '', options),
    url: redactUrl(page.url || '', options),
  }));
}

export function writePagesCache(path, pages) {
  writeFileSync(path, JSON.stringify(redactPages(pages)), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

export function formatPageList(pages, config, options = {}) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = redactText(p.title || '', options).substring(0, 54).padEnd(54);
    const blocked = checkDomain(p.url, config) ? ' [BLOCKED]' : '';
    return `${id}  ${title}  ${redactUrl(p.url, options)}${blocked}`;
  }).join('\n');
}
