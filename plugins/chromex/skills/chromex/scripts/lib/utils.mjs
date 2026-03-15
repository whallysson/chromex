// Utilitários compartilhados
import { readdirSync } from 'fs';
import { resolve } from 'path';

const MIN_TARGET_PREFIX_LEN = 8;

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function resolvePrefix(prefix, candidates, noun = 'target', missingHint = '') {
  const upper = prefix.toUpperCase();
  const matches = candidates.filter(c => c.toUpperCase().startsWith(upper));
  if (matches.length === 0) {
    const hint = missingHint ? ` ${missingHint}` : '';
    throw new Error(`No ${noun} matching prefix "${prefix}".${hint}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} ${noun}s. Use more characters.`);
  }
  return matches[0];
}

export function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return MIN_TARGET_PREFIX_LEN;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = MIN_TARGET_PREFIX_LEN; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}

export function listDaemonSockets(socketDir) {
  try {
    return readdirSync(socketDir)
      .filter(f => f.endsWith('.sock') && f !== '.token')
      .map(f => ({
        targetId: f.slice(0, -5),
        socketPath: resolve(socketDir, f),
      }));
  } catch {
    return [];
  }
}

export function sockPath(socketDir, targetId) {
  return resolve(socketDir, `${targetId}.sock`);
}
