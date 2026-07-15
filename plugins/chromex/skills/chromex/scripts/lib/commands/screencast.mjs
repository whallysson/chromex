import { mkdirSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { resolveArtifactPath, resolveChromexPath, timestamp } from '../artifacts.mjs';

export async function screencastStr(cdp, sid, state, action = 'status', ...args) {
  const normalized = String(action || 'status').toLowerCase();
  if (normalized === 'start') return startScreencast(cdp, sid, state, parseOptions(args));
  if (normalized === 'stop') return stopScreencast(cdp, sid, state);
  if (normalized === 'status') return screencastStatus(state);
  if (normalized === 'replay') return screencastReplay(state);
  throw new Error('Usage: screencast <target> start [directory] [options] | stop | status | replay');
}

async function startScreencast(cdp, sid, state, options) {
  if (state.active) throw new Error(`Screencast already active: ${state.active.root}`);
  const manifestPath = options.directory
    ? resolve(resolveChromexPath(options.directory), 'manifest.json')
    : resolveArtifactPath(null, 'screencasts', `screencast-${timestamp()}/manifest.json`);
  const root = dirname(manifestPath);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const active = {
    root,
    manifestPath,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    format: options.format,
    frames: [],
    maxFrames: options.maxFrames,
    droppedFrames: 0,
    off: null,
  };
  active.off = cdp.onEvent('Page.screencastFrame', (params, message) => {
    if (message?.sessionId && message.sessionId !== sid) return;
    cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }, sid).catch(() => {});
    if (active.frames.length >= active.maxFrames) {
      active.droppedFrames++;
      return;
    }
    const index = active.frames.length + 1;
    const fileName = `frame-${String(index).padStart(6, '0')}.${active.format === 'jpeg' ? 'jpg' : active.format}`;
    const path = resolve(root, fileName);
    writeFileSync(path, Buffer.from(params.data || '', 'base64'), { mode: 0o600 });
    active.frames.push({ index, path, fileName, metadata: params.metadata || null, capturedAt: new Date().toISOString() });
  });
  state.active = active;
  try {
    const params = {
      format: options.format,
      quality: options.quality,
      everyNthFrame: options.everyNthFrame,
    };
    if (options.maxWidth) params.maxWidth = options.maxWidth;
    if (options.maxHeight) params.maxHeight = options.maxHeight;
    await cdp.send('Page.startScreencast', params, sid);
  } catch (error) {
    active.off?.();
    state.active = null;
    throw error;
  }
  return {
    text: `Screencast started: ${root}`,
    data: { active: true, root, format: options.format, maxFrames: options.maxFrames },
    artifacts: [],
  };
}

async function stopScreencast(cdp, sid, state) {
  if (!state.active) return screencastStatus(state);
  const capture = state.active;
  await cdp.send('Page.stopScreencast', {}, sid).catch(() => {});
  capture.off?.();
  capture.stoppedAt = new Date().toISOString();
  const replayPath = resolve(capture.root, 'index.html');
  const manifest = {
    version: 1,
    startedAt: capture.startedAt,
    stoppedAt: capture.stoppedAt,
    format: capture.format,
    frameCount: capture.frames.length,
    droppedFrames: capture.droppedFrames,
    frames: capture.frames.map(frame => ({
      index: frame.index,
      file: frame.fileName,
      capturedAt: frame.capturedAt,
      metadata: frame.metadata,
    })),
  };
  writeFileSync(capture.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  writeFileSync(replayPath, renderReplay(manifest), { mode: 0o600 });
  capture.replayPath = replayPath;
  state.last = capture;
  state.active = null;
  return screencastResult(capture, false);
}

function screencastStatus(state) {
  const capture = state.active || state.last;
  if (!capture) return { text: 'Screencast: no active or recent capture.', data: { active: false }, artifacts: [] };
  return screencastResult(capture, capture === state.active);
}

function screencastReplay(state) {
  const capture = state.active || state.last;
  if (!capture) throw new Error('No active or recent screencast.');
  if (state.active) throw new Error('Stop the active screencast before opening its replay.');
  return screencastResult(capture, false);
}

function screencastResult(capture, active) {
  const lines = [
    `${active ? 'Screencast active' : 'Screencast stopped'}: ${capture.frames.length} frame(s)`,
    `Root: ${capture.root}`,
  ];
  if (capture.droppedFrames) lines.push(`Dropped after limit: ${capture.droppedFrames}`);
  if (capture.replayPath) lines.push(`Replay: ${capture.replayPath}`);
  const artifacts = capture.replayPath ? [
    { type: 'screencast-manifest', path: capture.manifestPath },
    { type: 'screencast-replay', path: capture.replayPath },
  ] : [];
  return {
    text: lines.join('\n'),
    data: { active, root: capture.root, frames: capture.frames.length, droppedFrames: capture.droppedFrames, replayPath: capture.replayPath || null },
    artifacts,
  };
}

function parseOptions(args) {
  const value = name => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const directory = args.find(arg => arg && !arg.startsWith('--')) || null;
  const format = value('format') || 'jpeg';
  if (!['jpeg', 'png'].includes(format)) throw new Error('Screencast format must be jpeg or png.');
  return {
    directory,
    format,
    quality: clamp(value('quality'), 0, 100, 80),
    maxWidth: clamp(value('max-width'), 0, 10000, 0),
    maxHeight: clamp(value('max-height'), 0, 10000, 0),
    everyNthFrame: clamp(value('every-nth-frame'), 1, 120, 1),
    maxFrames: clamp(value('max-frames'), 1, 10000, 1000),
  };
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function renderReplay(manifest) {
  const frames = manifest.frames.map(frame => `<img src="${escapeHtml(frame.file)}" alt="Frame ${frame.index}" loading="lazy">`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chromex Screencast</title>
  <style>body{margin:0;background:#111;color:#eee;font:14px system-ui,sans-serif}header{position:sticky;top:0;padding:12px 16px;background:#181818;border-bottom:1px solid #333}main{display:grid;gap:8px;padding:8px}img{display:block;max-width:100%;margin:auto;background:#222}</style>
</head>
<body>
  <header>${manifest.frameCount} frames · ${escapeHtml(manifest.startedAt)} · ${escapeHtml(manifest.stoppedAt)}</header>
  <main>${frames}</main>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
