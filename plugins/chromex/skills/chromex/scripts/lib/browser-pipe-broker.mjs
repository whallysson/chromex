#!/usr/bin/env node

import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';
import net from 'net';
import { dirname } from 'path';
import { StringDecoder } from 'string_decoder';

let browser = null;
let server = null;
let markerPath = null;
let socketPath = null;
let shuttingDown = false;
const clients = new Set();
const clientBuffers = new Map();
const pending = new Map();
const sessionOwners = new Map();
let nextId = 0;
let browserBuffer = '';

process.stdin.setEncoding('utf8');
let configBuffer = '';
process.stdin.on('data', chunk => { configBuffer += chunk; });
process.stdin.on('end', () => {
  try {
    start(JSON.parse(configBuffer));
  } catch {
    process.exit(1);
  }
});

function start(config) {
  socketPath = config.socketPath;
  markerPath = config.markerPath;
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  try { unlinkSync(socketPath); } catch {}
  try { unlinkSync(markerPath); } catch {}

  server = net.createServer(client => {
    clients.add(client);
    clientBuffers.set(client, '');
    client.setEncoding('utf8');
    client.on('data', chunk => receiveClientData(client, chunk));
    client.on('error', () => {});
    client.on('close', () => removeClient(client));
  });
  server.listen(socketPath, () => {
    try { chmodSync(socketPath, 0o600); } catch {}
  });

  browser = spawn(config.browserPath, config.flags, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
  });
  const decoder = new StringDecoder('utf8');
  browser.stdio[4].on('data', chunk => receiveBrowserData(decoder.write(chunk)));
  browser.stdio[4].on('end', () => receiveBrowserData(decoder.end()));
  browser.on('error', () => shutdown(1));
  browser.on('exit', () => shutdown(0, false));
  browser.stdio[3].on('error', () => shutdown(1));

  const id = ++nextId;
  pending.set(id, { internal: true, config });
  writeBrowser({ id, method: 'Browser.getVersion', params: {} });
  setTimeout(() => {
    if (pending.has(id)) shutdown(1);
  }, 15000).unref();
}

function receiveClientData(client, chunk) {
  let buffer = clientBuffers.get(client) + chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const originalId = message.id;
    const id = ++nextId;
    pending.set(id, { client, originalId, method: message.method, params: message.params || {} });
    writeBrowser({ ...message, id });
  }
  clientBuffers.set(client, buffer);
}

function receiveBrowserData(chunk) {
  browserBuffer += chunk;
  let index;
  while ((index = browserBuffer.indexOf('\0')) >= 0) {
    const raw = browserBuffer.slice(0, index);
    browserBuffer = browserBuffer.slice(index + 1);
    if (!raw.trim()) continue;
    let message;
    try { message = JSON.parse(raw); } catch { continue; }
    routeBrowserMessage(message);
  }
}

function routeBrowserMessage(message) {
  if (message.id != null) {
    const route = pending.get(message.id);
    if (!route) return;
    pending.delete(message.id);
    if (route.internal) {
      if (message.error || !message.result) {
        shutdown(1);
        return;
      }
      writeFileSync(markerPath, JSON.stringify({
        version: 1,
        socketPath,
        brokerPid: process.pid,
        browserPid: browser.pid,
        browser: message.result?.product || null,
        extensionTools: route.config.flags.includes('--enable-unsafe-extension-debugging'),
        webMcp: route.config.flags.some(flag => flag.startsWith('--enable-features=') && flag.split('=')[1].split(',').includes('WebMCP')),
        startedAt: new Date().toISOString(),
      }, null, 2), { mode: 0o600 });
      return;
    }
    if (route.cleanupAttach) {
      if (message.result?.sessionId) detachSession(message.result.sessionId);
      return;
    }
    if (route.cleanup) return;
    if (route.method === 'Target.attachToTarget' && message.result?.sessionId) {
      sessionOwners.set(message.result.sessionId, route.client);
    }
    if (route.method === 'Target.detachFromTarget' && route.params.sessionId) {
      sessionOwners.delete(route.params.sessionId);
    }
    if (!route.client.destroyed) route.client.write(`${JSON.stringify({ ...message, id: route.originalId })}\n`);
    return;
  }

  const owner = eventOwner(message);
  if (message.method === 'Target.attachedToTarget' && message.params?.sessionId && owner) {
    sessionOwners.set(message.params.sessionId, owner);
  }
  if (message.method === 'Target.detachedFromTarget' && message.params?.sessionId) {
    sessionOwners.delete(message.params.sessionId);
  }
  const payload = `${JSON.stringify(message)}\n`;
  if (owner) {
    if (!owner.destroyed) owner.write(payload);
    return;
  }
  if (message.sessionId || message.method === 'Target.detachedFromTarget') return;
  for (const client of clients) if (!client.destroyed) client.write(payload);
}

function writeBrowser(message) {
  browser.stdio[3].write(`${JSON.stringify(message)}\0`);
}

function removeClient(client) {
  clients.delete(client);
  clientBuffers.delete(client);
  for (const [id, route] of pending) {
    if (route.client !== client) continue;
    if (route.method === 'Target.attachToTarget') pending.set(id, { cleanupAttach: true });
    else pending.delete(id);
  }
  for (const [sessionId, owner] of [...sessionOwners]) {
    if (owner === client) detachSession(sessionId);
  }
}

function eventOwner(message) {
  if (message.sessionId) return sessionOwners.get(message.sessionId) || null;
  if (message.method === 'Target.attachedToTarget') {
    const targetId = message.params?.targetInfo?.targetId;
    for (const route of pending.values()) {
      if (route.method === 'Target.attachToTarget' && route.params?.targetId === targetId) return route.client;
    }
  }
  if (message.method === 'Target.detachedFromTarget') {
    return sessionOwners.get(message.params?.sessionId) || null;
  }
  return null;
}

function detachSession(sessionId) {
  sessionOwners.delete(sessionId);
  if (!browser?.stdio?.[3]?.writable) return;
  const id = ++nextId;
  pending.set(id, { cleanup: true });
  writeBrowser({ id, method: 'Target.detachFromTarget', params: { sessionId } });
}

function shutdown(code = 0, stopBrowser = true) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const client of clients) client.destroy();
  server?.close();
  if (stopBrowser && browser && !browser.killed) browser.kill('SIGTERM');
  try { unlinkSync(socketPath); } catch {}
  try { unlinkSync(markerPath); } catch {}
  setTimeout(() => process.exit(code), 25).unref();
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
