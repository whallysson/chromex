// CDP WebSocket client -- protocolo raw, zero dependencies
// Requer Node 22+ (WebSocket nativo)

import net from 'net';

const DEFAULT_TIMEOUT = 15000;

export class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #eventHandlers = new Map();
  #closeHandlers = [];
  #timeout;
  #transport = 'websocket';
  #unixBuffer = '';
  #closed = false;

  constructor(timeout = DEFAULT_TIMEOUT) {
    this.#timeout = timeout;
  }

  async connect(wsUrl) {
    this.wsUrl = wsUrl;
    this.#closed = false;
    if (/^unix:\/\//i.test(wsUrl)) return this.#connectUnix(wsUrl);
    this.#transport = 'websocket';
    return new Promise((res, rej) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#ws?.close();
        rej(new Error(`Timeout connecting to CDP: ${wsUrl}`));
      }, this.#timeout);
      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        res();
      };
      this.#ws.onerror = (e) => {
        const error = new Error('WebSocket error: ' + (e.message || e.type));
        this.#rejectPending(error);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          rej(error);
        }
      };
      this.#ws.onclose = () => {
        this.#handleClose();
      };
      this.#ws.onmessage = (ev) => {
        this.#handleMessage(JSON.parse(ev.data));
      };
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      if (!this.#isOpen()) {
        reject(new Error('CDP connection is not open'));
        return;
      }
      const timer = setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method}`));
        }
      }, this.#timeout);
      this.#pending.set(id, { resolve, reject, timer });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      try {
        this.#write(JSON.stringify(msg));
      } catch (error) {
        if (this.#pending.has(id)) {
          clearTimeout(timer);
          this.#pending.delete(id);
          reject(error);
        }
      }
    });
  }

  onEvent(method, handler) {
    if (!this.#eventHandlers.has(method)) this.#eventHandlers.set(method, new Set());
    const handlers = this.#eventHandlers.get(method);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.#eventHandlers.delete(method);
    };
  }

  waitForEvent(method, timeout = this.#timeout) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.onEvent(method, (params) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off?.();
      },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }
  close() {
    this.#rejectPending(new Error('CDP connection closed'));
    if (this.#transport === 'unix') {
      this.#ws?.end();
      this.#ws?.destroy();
    } else if (this.#ws && (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING)) {
      this.#ws.close();
    }
  }

  #connectUnix(endpoint) {
    this.#transport = 'unix';
    const path = decodeURIComponent(new URL(endpoint).pathname);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(path);
      this.#ws = socket;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`Timeout connecting to CDP pipe: ${path}`));
      }, this.#timeout);
      socket.once('connect', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
      socket.on('data', chunk => {
        this.#unixBuffer += chunk.toString();
        let index;
        while ((index = this.#unixBuffer.indexOf('\n')) >= 0) {
          const line = this.#unixBuffer.slice(0, index);
          this.#unixBuffer = this.#unixBuffer.slice(index + 1);
          if (line.trim()) this.#handleMessage(JSON.parse(line));
        }
      });
      socket.on('error', error => {
        this.#rejectPending(error);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.on('close', () => this.#handleClose());
    });
  }

  #handleMessage(msg) {
    if (msg.id && this.#pending.has(msg.id)) {
      const { resolve, reject, timer } = this.#pending.get(msg.id);
      this.#pending.delete(msg.id);
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method && this.#eventHandlers.has(msg.method)) {
      for (const handler of [...this.#eventHandlers.get(msg.method)]) handler(msg.params || {}, msg);
    }
  }

  #handleClose() {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(new Error('CDP connection closed'));
    this.#closeHandlers.forEach(handler => handler());
  }

  #isOpen() {
    if (!this.#ws) return false;
    if (this.#transport === 'unix') return !this.#ws.destroyed && this.#ws.writable;
    return this.#ws.readyState === WebSocket.OPEN;
  }

  #write(payload) {
    if (this.#transport === 'unix') this.#ws.write(`${payload}\n`);
    else this.#ws.send(payload);
  }

  #rejectPending(error) {
    for (const { reject, timer } of this.#pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.#pending.clear();
  }
}
