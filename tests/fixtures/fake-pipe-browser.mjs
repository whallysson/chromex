import { createReadStream, createWriteStream } from 'fs';

const input = createReadStream(null, { fd: 3, autoClose: false });
const output = createWriteStream(null, { fd: 4, autoClose: false });
const sessions = new Map();
const targets = new Set();
let buffer = '';

input.on('data', chunk => {
  buffer += chunk.toString();
  let index;
  while ((index = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (raw.trim()) handle(JSON.parse(raw));
  }
});

function handle(message) {
  if (message.method === 'Browser.getVersion') {
    respond(message.id, { product: 'Chrome/FakePipe' });
    return;
  }
  if (message.method === 'Target.attachToTarget') {
    const sessionId = `session-${message.params.targetId}`;
    targets.add(message.params.targetId);
    sessions.set(sessionId, message.params.targetId);
    respond(message.id, { sessionId });
    return;
  }
  if (message.method === 'Target.detachFromTarget') {
    sessions.delete(message.params.sessionId);
    respond(message.id, {});
    return;
  }
  if (message.method === 'Target.getTargets') {
    respond(message.id, {
      targetInfos: [...targets].map(targetId => ({
        targetId,
        type: 'page',
        url: `https://${targetId}.test`,
        attached: [...sessions.values()].includes(targetId),
      })),
    });
    return;
  }
  if (message.method === 'Runtime.evaluate') {
    emit({
      method: 'Runtime.consoleAPICalled',
      sessionId: message.sessionId,
      params: { type: 'log', args: [{ type: 'string', value: message.params.expression }] },
    });
    respond(message.id, { result: { type: 'string', value: message.params.expression } }, message.sessionId);
    return;
  }
  respond(message.id, {}, message.sessionId);
}

function respond(id, result, sessionId) {
  emit({ id, result, ...(sessionId ? { sessionId } : {}) });
}

function emit(message) {
  output.write(`${JSON.stringify(message)}\0`);
}

process.on('SIGTERM', () => process.exit(0));
