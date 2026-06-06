import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { homedir } from 'os';

const SESSION_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export function validateSessionName(name) {
  if (!name || !SESSION_NAME_RE.test(name)) {
    throw new Error('Session name must be 1-64 chars: letters, numbers, dot, underscore, or dash.');
  }
}

export function loadSessions(config) {
  if (!existsSync(config._sessionsPath)) return { version: 1, sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(config._sessionsPath, 'utf8'));
    return {
      version: 1,
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
    };
  } catch {
    return { version: 1, sessions: {} };
  }
}

export function saveSessions(config, data) {
  const dir = dirname(config._sessionsPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(config._sessionsPath, JSON.stringify(data, null, 2));
}

export function getSession(config, name) {
  validateSessionName(name);
  return loadSessions(config).sessions[name] || null;
}

export function setSession(config, name, record) {
  validateSessionName(name);
  const data = loadSessions(config);
  const now = new Date().toISOString();
  data.sessions[name] = {
    ...data.sessions[name],
    ...record,
    name,
    workspace: record.workspace || process.cwd(),
    createdAt: data.sessions[name]?.createdAt || now,
    updatedAt: now,
    managed: true,
  };
  saveSessions(config, data);
  return data.sessions[name];
}

export function removeSession(config, name) {
  validateSessionName(name);
  const data = loadSessions(config);
  const record = data.sessions[name] || null;
  delete data.sessions[name];
  saveSessions(config, data);
  return record;
}

export function listSessions(config) {
  return Object.values(loadSessions(config).sessions);
}

export function sessionDataPath(name) {
  validateSessionName(name);
  return resolve(homedir(), '.chromex', 'session-data', name);
}

export function sessionStatePath(name) {
  return resolve(sessionDataPath(name), 'storage-state.json');
}

export function deleteSessionData(name) {
  const path = sessionDataPath(name);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
  return path;
}

export function formatSessions(records, livePages = []) {
  if (records.length === 0) return 'sessions: empty';
  const pagesByTarget = new Map(livePages.map(page => [page.targetId, page]));
  return records.map((record) => {
    const page = pagesByTarget.get(record.targetId);
    const state = page ? 'alive' : 'stale';
    const title = (page?.title || record.title || '').substring(0, 44).padEnd(44);
    const url = page?.url || record.url || '';
    return `${record.name.padEnd(20)} ${state.padEnd(5)} ${record.targetId?.slice(0, 8) || '-'.repeat(8)}  ${title}  ${url}`;
  }).join('\n');
}
