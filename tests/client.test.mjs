import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { spawn } from 'child_process';
import net from 'net';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { CDP } from '../plugins/chromex/skills/chromex/scripts/lib/client.mjs';

const TEST_DIR = resolve(fileURLToPath(import.meta.url), '..');
const BROKER_PATH = resolve(TEST_DIR, '../plugins/chromex/skills/chromex/scripts/lib/browser-pipe-broker.mjs');
const FAKE_BROWSER_PATH = resolve(TEST_DIR, 'fixtures/fake-pipe-browser.mjs');

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];

  constructor() {
    this.readyState = FakeWebSocket.CONNECTING;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(payload) {
    this.lastPayload = JSON.parse(payload);
  }

  respond(result = {}) {
    this.onmessage?.({ data: JSON.stringify({ id: this.lastPayload.id, result }) });
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('CDP lifecycle', () => {
  const nativeWebSocket = globalThis.WebSocket;

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = nativeWebSocket;
    FakeWebSocket.instances.length = 0;
  });

  it('clears command timers after a successful response', async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket;
    const cdp = new CDP(15000);
    await cdp.connect('ws://test');
    const ws = FakeWebSocket.instances[0];
    const response = cdp.send('Target.getTargets');
    ws.respond({ targetInfos: [] });

    await expect(response).resolves.toEqual({ targetInfos: [] });
    expect(vi.getTimerCount()).toBe(0);
    cdp.close();
  });

  it('rejects pending commands and clears timers when closed', async () => {
    vi.useFakeTimers();
    globalThis.WebSocket = FakeWebSocket;
    const cdp = new CDP(15000);
    await cdp.connect('ws://test');
    const pending = cdp.send('Runtime.evaluate');

    cdp.close();

    await expect(pending).rejects.toThrow('CDP connection closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses the local Unix broker transport for shared pipe sessions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chromex-client-'));
    const socketPath = join(dir, 'browser.sock');
    const server = net.createServer(socket => {
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString();
        const index = buffer.indexOf('\n');
        if (index < 0) return;
        const request = JSON.parse(buffer.slice(0, index));
        socket.write(`${JSON.stringify({ id: request.id, result: { product: 'Chrome/150' } })}\n`);
      });
    });
    await new Promise(resolve => server.listen(socketPath, resolve));
    const cdp = new CDP(1000);

    try {
      await cdp.connect(`unix://${socketPath}`);
      await expect(cdp.send('Browser.getVersion')).resolves.toEqual({ product: 'Chrome/150' });
    } finally {
      cdp.close();
      await new Promise(resolve => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('routes session events to their owner and detaches sessions on disconnect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chromex-broker-'));
    const socketPath = join(dir, 'browser.sock');
    const markerPath = join(dir, 'active.json');
    const broker = spawn(process.execPath, [BROKER_PATH], { stdio: ['pipe', 'ignore', 'pipe'] });
    broker.stdin.end(JSON.stringify({ browserPath: process.execPath, flags: [FAKE_BROWSER_PATH], socketPath, markerPath }));
    const cdpA = new CDP(2000);
    const cdpB = new CDP(2000);

    try {
      await waitUntil(() => existsSync(markerPath));
      await Promise.all([cdpA.connect(`unix://${socketPath}`), cdpB.connect(`unix://${socketPath}`)]);
      const [{ sessionId: sessionA }, { sessionId: sessionB }] = await Promise.all([
        cdpA.send('Target.attachToTarget', { targetId: 'target-a', flatten: true }),
        cdpB.send('Target.attachToTarget', { targetId: 'target-b', flatten: true }),
      ]);
      const eventsA = [];
      const eventsB = [];
      cdpA.onEvent('Runtime.consoleAPICalled', params => eventsA.push(params));
      cdpB.onEvent('Runtime.consoleAPICalled', params => eventsB.push(params));

      await cdpA.send('Runtime.evaluate', { expression: 'owner-a' }, sessionA);
      expect(eventsA).toHaveLength(1);
      expect(eventsB).toHaveLength(0);

      cdpA.close();
      await waitUntil(async () => {
        const { targetInfos } = await cdpB.send('Target.getTargets');
        return targetInfos.find(target => target.targetId === 'target-a')?.attached === false;
      });
      const { targetInfos } = await cdpB.send('Target.getTargets');
      expect(targetInfos.find(target => target.targetId === 'target-a')?.attached).toBe(false);
      expect(targetInfos.find(target => target.targetId === 'target-b')?.attached).toBe(true);
      expect(sessionB).toBe('session-target-b');
    } finally {
      cdpA.close();
      cdpB.close();
      const closed = new Promise(resolveClose => broker.once('close', resolveClose));
      broker.kill('SIGTERM');
      await closed;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function waitUntil(predicate, timeout = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await predicate()) return;
    await new Promise(resolveWait => setTimeout(resolveWait, 20));
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}
