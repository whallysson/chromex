import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { basename, dirname, isAbsolute, resolve } from 'path';

export function workspaceArtifactRoot() {
  if (process.env.CHROMEX_ARTIFACT_ROOT) {
    return expandHome(process.env.CHROMEX_ARTIFACT_ROOT);
  }
  return resolve(homedir(), '.chromex', 'artifacts', workspaceKey());
}

export function resolveArtifactPath(filePath, category = 'artifacts', fileName = null) {
  const path = filePath
    ? resolveExplicitPath(filePath)
    : resolve(workspaceArtifactRoot(), category, fileName || `${category}-${timestamp()}.txt`);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path;
}

export function writeTextArtifact(filePath, text, category = 'artifacts', fileName = null) {
  const path = resolveArtifactPath(filePath, category, fileName);
  writeFileSync(path, text);
  return { type: category, path };
}

export function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function resolveExplicitPath(filePath) {
  const expanded = expandHome(filePath);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

function workspaceKey() {
  const cwd = process.cwd();
  const slug = basename(cwd).replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 10);
  return `${slug}-${hash}`;
}
