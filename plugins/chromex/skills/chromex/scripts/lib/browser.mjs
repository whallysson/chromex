// Detecção de browser e listagem de páginas
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { checkDomain } from './security.mjs';
import { getDisplayPrefixLength } from './utils.mjs';

// Gera candidatos para cada browser: path base + Default/ subfolder
function candidates(base) {
  return [resolve(base, 'DevToolsActivePort'), resolve(base, 'Default/DevToolsActivePort')];
}

const home = homedir();
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

export function getWsUrl() {
  // Override via env var para setups não-padrão
  if (process.env.CDP_PORT_FILE && existsSync(process.env.CDP_PORT_FILE)) {
    const lines = readFileSync(process.env.CDP_PORT_FILE, 'utf8').trim().split('\n');
    return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
  }

  const portFile = DEVTOOLS_CANDIDATES.find(path => existsSync(path));
  if (!portFile) {
    throw new Error(
      'Could not find DevToolsActivePort file.\n' +
      'Enable remote debugging: chrome://inspect/#remote-debugging\n' +
      'Or launch with: chromex launch'
    );
  }
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  return `ws://127.0.0.1:${lines[0]}${lines[1]}`;
}

export async function getPages(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
}

export function formatPageList(pages, config) {
  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));
  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = p.title.substring(0, 54).padEnd(54);
    const blocked = checkDomain(p.url, config) ? ' [BLOCKED]' : '';
    return `${id}  ${title}  ${p.url}${blocked}`;
  }).join('\n');
}
