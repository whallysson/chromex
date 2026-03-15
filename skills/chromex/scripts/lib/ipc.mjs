// Comunicação CLI <-> daemon via Unix sockets
import { unlinkSync, readFileSync, existsSync } from 'fs';
import { checkDomain } from './security.mjs';
import { spawn } from 'child_process';
import net from 'net';
import { sleep, resolvePrefix, listDaemonSockets, sockPath } from './utils.mjs';
import { getOrCreateToken } from './daemon.mjs';

const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function authenticateConnection(conn, authToken) {
  if (!authToken) return true;

  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      conn.off('data', onData);
      conn.off('error', onError);
      try {
        const resp = JSON.parse(buf.slice(0, idx));
        resolve(resp.ok === true);
      } catch {
        resolve(false);
      }
    };
    const onError = (e) => {
      conn.off('data', onData);
      reject(e);
    };
    conn.on('data', onData);
    conn.on('error', onError);
    conn.write(JSON.stringify({ auth: authToken, id: 0 }) + '\n');
  });
}

async function connectAndAuth(sp, authToken) {
  const conn = await connectToSocket(sp);
  const ok = await authenticateConnection(conn, authToken);
  if (!ok) {
    conn.end();
    throw new Error('Socket authentication failed');
  }
  return conn;
}

export async function getOrStartTabDaemon(targetId, config) {
  const sp = sockPath(config._socketDir, targetId);
  const authToken = getOrCreateToken(config);

  // Tentar daemon existente
  try { return await connectAndAuth(sp, authToken); } catch { /* daemon não existe */ }

  // Limpar socket stale
  try { unlinkSync(sp); } catch { /* não existe */ }

  // Spawnar daemon -- usa o mesmo script com _daemon como primeiro arg
  const scriptPath = new URL('../chromex.mjs', import.meta.url).pathname;
  const child = spawn(process.execPath, [scriptPath, '_daemon', targetId], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Aguardar socket (inclui tempo do usuário clicar Allow)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectAndAuth(sp, authToken); } catch { /* aguardando */ }
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

export function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;

    const cleanup = () => {
      conn.off('data', onData);
      conn.off('error', onError);
      conn.off('end', onEnd);
      conn.off('close', onClose);
    };

    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true;
      cleanup();
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };

    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Connection closed before response'));
    };

    conn.on('data', onData);
    conn.on('error', onError);
    conn.on('end', onEnd);
    conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

export async function stopDaemons(targetPrefix, config) {
  const authToken = getOrCreateToken(config);
  const daemons = listDaemonSockets(config._socketDir);

  if (targetPrefix) {
    const targetId = resolvePrefix(targetPrefix, daemons.map(d => d.targetId), 'daemon');
    const daemon = daemons.find(d => d.targetId === targetId);
    try {
      const conn = await connectAndAuth(daemon.socketPath, authToken);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      try { unlinkSync(daemon.socketPath); } catch { /* já removido */ }
    }
    return;
  }

  for (const daemon of daemons) {
    try {
      const conn = await connectAndAuth(daemon.socketPath, authToken);
      await sendCommand(conn, { cmd: 'stop' });
    } catch {
      try { unlinkSync(daemon.socketPath); } catch { /* já removido */ }
    }
  }
}

export function findAnyDaemonSocket(config) {
  return listDaemonSockets(config._socketDir)[0]?.socketPath || null;
}

export function checkTargetDomain(targetId, config) {
  if (!existsSync(config._pagesCachePath)) return;
  try {
    const pages = JSON.parse(readFileSync(config._pagesCachePath, 'utf8'));
    const page = pages.find(p => p.targetId === targetId);
    if (page) {
      const error = checkDomain(page.url, config);
      if (error) throw new Error(`${error}\nTab: ${page.title} (${page.url})`);
    }
  } catch (e) {
    if (e.message.includes('blocked') || e.message.includes('allowedDomains')) throw e;
  }
}
