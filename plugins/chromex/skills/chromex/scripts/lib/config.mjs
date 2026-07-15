// Configuração centralizada -- paths, defaults, load/save
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, chmodSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

const CONFIG_DIR_NEW = resolve(homedir(), '.chromex');
const CONFIG_DIR_LEGACY = resolve(homedir(), '.config/cdp-skill');

export function getConfigDir() {
  // Preferir novo path; fallback para legado se existir
  if (existsSync(resolve(CONFIG_DIR_NEW, 'config.json'))) return CONFIG_DIR_NEW;
  if (existsSync(resolve(CONFIG_DIR_LEGACY, 'config.json'))) return CONFIG_DIR_LEGACY;
  return CONFIG_DIR_NEW;
}

export function getAuditLogPath(configDir) {
  return resolve(configDir, 'audit.log');
}

export function getSocketDir(configDir) {
  const dir = process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'chromex')
    : resolve(configDir, 'run');
  ensureDir(dir);
  return dir;
}

export function getTokenPath(socketDir) {
  return resolve(socketDir, '.token');
}

export function getPagesCachePath(socketDir) {
  return resolve(socketDir, 'pages.json');
}

export function getSessionsPath(configDir) {
  return resolve(configDir, 'sessions.json');
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else {
    try { chmodSync(dir, 0o700); } catch {}
  }
}

const DEFAULTS = {
  commandTimeout: 15000,
  navigationTimeout: 30000,
  idleTimeout: 20 * 60 * 1000,
  allowedDomains: [],
  blockedDomains: [],
  blockedCdpMethods: [
    'Network.enable',
    'Network.setRequestInterception',
    'Network.setCacheDisabled',
    'Page.setDocumentContent',
    'Security.disable',
    'Security.setIgnoreCertificateErrors',
    'Fetch.enable',
    'Fetch.fulfillRequest',
    'Fetch.continueRequest',
    'Browser.close',
    'Browser.crashGpuProcess',
    'Target.disposeBrowserContext',
    'SystemInfo.getProcessInfo',
    'Storage.clearDataForOrigin',
    'Storage.getCookies',
    'IndexedDB.requestData',
  ],
  auditLog: true,
  socketAuth: true,
  defaultScreenshotPath: null,
  cdpUrl: null,
  cdpEndpoint: null,
  cdpEndpoints: {},
  cdpHeaders: {},
  cdpHeadersFile: null,
};

export function loadConfig() {
  const configDir = getConfigDir();
  ensureDir(configDir);
  const configPath = resolve(configDir, 'config.json');

  let userConfig = {};
  if (existsSync(configPath)) {
    try {
      userConfig = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch { /* config corrompida, usar defaults */ }
  } else {
    // Migrar config legada se existir
    const legacyPath = resolve(CONFIG_DIR_LEGACY, 'config.json');
    if (configDir === CONFIG_DIR_NEW && existsSync(legacyPath)) {
      try {
        copyFileSync(legacyPath, configPath);
        chmodSync(configPath, 0o600);
        userConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      } catch { /* falha na migração, usar defaults */ }
    } else {
      // Primeira execução: gerar config default
      writeFileSync(configPath, JSON.stringify(DEFAULTS, null, 2), { mode: 0o600 });
    }
  }

  const config = { ...DEFAULTS, ...userConfig };
  if (existsSync(configPath)) {
    try { chmodSync(configPath, 0o600); } catch {}
  }
  config._configDir = configDir;
  config._socketDir = getSocketDir(configDir);
  config._tokenPath = getTokenPath(config._socketDir);
  config._pagesCachePath = getPagesCachePath(config._socketDir);
  config._sessionsPath = getSessionsPath(configDir);
  config._auditLogPath = getAuditLogPath(configDir);
  return config;
}
