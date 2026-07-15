import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { redactCommandArgs, redactObject, redactText, redactUrl } from '../redaction.mjs';
import { dirname, relative } from 'path';
import { resolveArtifactPath, timestamp } from '../artifacts.mjs';
import { htmlStr } from './html.mjs';
import { snapshotStr } from './snapshot.mjs';

export async function evidenceStr(cdp, sid, targetId, state, action = 'status', label = '', context = {}) {
  const normalized = (action || 'status').toLowerCase();
  if (normalized === 'start') return startEvidence(cdp, sid, targetId, state, label || 'evidence', context);
  if (normalized === 'mark') return markEvidence(cdp, sid, state, label || 'mark', context);
  if (normalized === 'stop') return stopEvidence(cdp, sid, state, label || 'stop', context);
  if (normalized === 'status') return statusEvidence(state);
  if (normalized === 'replay') return replayEvidence(state);
  if (normalized === 'capture') {
    await startEvidence(cdp, sid, targetId, state, label || 'capture', context);
    return stopEvidence(cdp, sid, state, label || 'capture', context);
  }
  throw new Error('Usage: evidence start [name] | mark [label] | stop [label] | status | replay | capture [name]');
}

export function recordEvidenceAction(state, command, args, ok, text) {
  if (!state.active || command === 'evidence') return;
  state.active.timeline.push({
    type: 'action',
    ts: new Date().toISOString(),
    command,
    args: sanitizeArgs(command, args),
    ok: !!ok,
    text: redactText(text, { maxLength: 500 }),
  });
}

async function startEvidence(cdp, sid, targetId, state, name, context) {
  if (state.active) throw new Error(`Evidence pack already active: ${state.active.name}`);
  const safeNameValue = redactText(name, { maxLength: 200 });
  const safe = safeName(safeNameValue);
  const startedAt = new Date().toISOString();
  const rootFile = resolveArtifactPath(null, 'evidence', `${safe}-${timestamp()}/evidence.json`);
  const root = dirname(rootFile);
  for (const dir of ['screenshots', 'snapshots', 'html']) mkdirSync(`${root}/${dir}`, { recursive: true, mode: 0o700 });
  state.active = {
    version: 1,
    name: safeNameValue,
    targetId,
    root,
    startedAt,
    stoppedAt: null,
    timeline: [{ type: 'start', ts: startedAt, name: safeNameValue }],
    marks: [],
    artifacts: [],
  };
  const mark = await captureMark(cdp, sid, state.active, 'start', context);
  await writePack(state.active, context);
  return resultForPack(state.active, `Evidence pack started: ${state.active.name}`, [mark]);
}

async function markEvidence(cdp, sid, state, label, context) {
  if (!state.active) throw new Error('No active evidence pack. Run "evidence start [name]" first.');
  const mark = await captureMark(cdp, sid, state.active, label, context);
  await writePack(state.active, context);
  return resultForPack(state.active, `Evidence mark captured: ${label}`, [mark]);
}

async function stopEvidence(cdp, sid, state, label, context) {
  if (!state.active) throw new Error('No active evidence pack. Run "evidence start [name]" first.');
  const mark = await captureMark(cdp, sid, state.active, label, context);
  state.active.stoppedAt = new Date().toISOString();
  state.active.timeline.push({ type: 'stop', ts: state.active.stoppedAt, label: redactText(label, { maxLength: 200 }) });
  await writePack(state.active, context);
  const pack = state.active;
  state.last = pack;
  state.active = null;
  return resultForPack(pack, `Evidence pack stopped: ${pack.name}`, [mark]);
}

function statusEvidence(state) {
  const pack = state.active || state.last;
  if (!pack) {
    return { text: 'evidence: no active or recent pack', data: { active: false }, artifacts: [] };
  }
  const active = pack === state.active;
  return {
    text: `${active ? 'Evidence active' : 'Last evidence pack'}: ${pack.name}\nRoot: ${pack.root}\nMarks: ${pack.marks.length}`,
    data: packData(pack, active),
    artifacts: packArtifacts(pack),
  };
}

function replayEvidence(state) {
  const pack = state.active || state.last;
  if (!pack) throw new Error('No active or recent evidence pack.');
  return resultForPack(pack, `Evidence replay: ${pack.indexPath || `${pack.root}/index.html`}`);
}

async function captureMark(cdp, sid, pack, label, context) {
  const id = String(pack.marks.length + 1).padStart(3, '0');
  const safeLabel = redactText(label || `mark-${id}`, { maxLength: 200 });
  const safe = safeName(safeLabel);
  const base = `${id}-${safe}`;
  const info = await pageInfo(cdp, sid);
  const screenshotPath = `${pack.root}/screenshots/${base}.png`;
  const snapshotPath = `${pack.root}/snapshots/${base}.yml`;
  const htmlPath = `${pack.root}/html/${base}.html`;
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sid);
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'), { mode: 0o600 });
  const snap = await snapshotStr(cdp, sid, true, true, null, 0, null, { boxes: true });
  writeFileSync(snapshotPath, snap.text, { mode: 0o600 });
  const html = await htmlStr(cdp, sid);
  writeFileSync(htmlPath, html, { mode: 0o600 });
  const mark = {
    id,
    label: safeLabel,
    ts: new Date().toISOString(),
    url: redactUrl(info.url),
    title: redactText(info.title, { maxLength: 500 }),
    viewport: info.viewport,
    artifacts: {
      screenshot: screenshotPath,
      snapshot: snapshotPath,
      html: htmlPath,
    },
  };
  pack.marks.push(mark);
  pack.timeline.push({ type: 'mark', ts: mark.ts, id, label: safeLabel, url: redactUrl(info.url), title: redactText(info.title, { maxLength: 500 }) });
  pack.artifacts.push(
    { type: 'evidence-screenshot', path: screenshotPath },
    { type: 'evidence-snapshot', path: snapshotPath },
    { type: 'evidence-html', path: htmlPath }
  );
  await writeRuntimeFiles(pack, context);
  return mark;
}

async function pageInfo(cdp, sid) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, devicePixelRatio }
    })`,
    returnByValue: true,
  }, sid);
  const value = typeof result?.value === 'string' ? JSON.parse(result.value) : result?.value;
  return value || { url: '', title: '', viewport: null };
}

async function writeRuntimeFiles(pack, context) {
  const consolePath = `${pack.root}/console.json`;
  const networkPath = `${pack.root}/network.json`;
  const timelinePath = `${pack.root}/timeline.json`;
  const networkEntries = context.networkRequests ? [...context.networkRequests.entries()] : [];
  writeFileSync(consolePath, JSON.stringify(redactObject(context.consoleMessages || []), null, 2), { mode: 0o600 });
  writeFileSync(networkPath, JSON.stringify(redactObject(networkEntries.map(([id, request]) => ({ id, ...request }))), null, 2), { mode: 0o600 });
  writeFileSync(timelinePath, JSON.stringify(pack.timeline, null, 2), { mode: 0o600 });
  upsertArtifact(pack, { type: 'evidence-console', path: consolePath });
  upsertArtifact(pack, { type: 'evidence-network', path: networkPath });
  upsertArtifact(pack, { type: 'evidence-timeline', path: timelinePath });
}

async function writePack(pack, context) {
  await writeRuntimeFiles(pack, context);
  const evidencePath = `${pack.root}/evidence.json`;
  const indexPath = `${pack.root}/index.html`;
  writeFileSync(evidencePath, JSON.stringify({
    version: pack.version,
    name: pack.name,
    targetId: pack.targetId,
    startedAt: pack.startedAt,
    stoppedAt: pack.stoppedAt,
    marks: pack.marks,
    timeline: pack.timeline,
    artifacts: pack.artifacts,
  }, null, 2), { mode: 0o600 });
  writeFileSync(indexPath, renderReplay(pack), { mode: 0o600 });
  pack.evidencePath = evidencePath;
  pack.indexPath = indexPath;
  upsertArtifact(pack, { type: 'evidence', path: evidencePath });
  upsertArtifact(pack, { type: 'evidence-replay', path: indexPath });
}

function renderReplay(pack) {
  const rows = pack.marks.map(mark => {
    const screenshot = relative(pack.root, mark.artifacts.screenshot);
    const snapshot = relative(pack.root, mark.artifacts.snapshot);
    const html = relative(pack.root, mark.artifacts.html);
    return `<article>
      <h2>${escapeHtml(mark.id)} ${escapeHtml(mark.label)}</h2>
      <p>${escapeHtml(mark.ts)}</p>
      <p><a href="${escapeHtml(mark.url)}">${escapeHtml(mark.url)}</a></p>
      <img src="${escapeHtml(screenshot)}" alt="${escapeHtml(mark.label)}">
      <p><a href="${escapeHtml(snapshot)}">Snapshot</a> <a href="${escapeHtml(html)}">HTML</a></p>
    </article>`;
  }).join('\n');
  const timeline = pack.timeline.map(item => `<li><strong>${escapeHtml(item.type)}</strong> ${escapeHtml(item.ts)} ${escapeHtml(item.command || item.label || item.name || '')}</li>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chromex Evidence - ${escapeHtml(pack.name)}</title>
  <style>
    body { margin: 0; font: 14px system-ui, sans-serif; background: #f7f7f4; color: #181817; }
    header { padding: 18px 22px; border-bottom: 1px solid #d9d9d2; background: #fff; position: sticky; top: 0; }
    main { display: grid; grid-template-columns: minmax(260px, 360px) 1fr; gap: 16px; padding: 16px; }
    aside, article { background: #fff; border: 1px solid #d9d9d2; border-radius: 8px; padding: 12px; }
    section { display: grid; gap: 12px; }
    img { display: block; width: 100%; border: 1px solid #d9d9d2; border-radius: 6px; background: #eee; }
    h1, h2, p { margin: 0 0 8px; }
    ul { margin: 0; padding-left: 18px; }
    a { color: #075985; word-break: break-all; }
  </style>
</head>
<body>
  <header>
    <h1>Chromex Evidence</h1>
    <p>${escapeHtml(pack.name)} · ${escapeHtml(pack.startedAt)}${pack.stoppedAt ? ` - ${escapeHtml(pack.stoppedAt)}` : ''}</p>
  </header>
  <main>
    <aside>
      <h2>Timeline</h2>
      <ul>${timeline}</ul>
      <p><a href="evidence.json">evidence.json</a></p>
      <p><a href="console.json">console.json</a></p>
      <p><a href="network.json">network.json</a></p>
    </aside>
    <section>${rows || '<p>No marks captured.</p>'}</section>
  </main>
</body>
</html>`;
}

function resultForPack(pack, text, marks = []) {
  return {
    text: `${text}\nRoot: ${pack.root}\nReplay: ${pack.indexPath || `${pack.root}/index.html`}`,
    data: packData(pack, pack.stoppedAt == null, marks),
    artifacts: packArtifacts(pack),
  };
}

function packData(pack, active, marks = []) {
  return {
    active,
    name: pack.name,
    root: pack.root,
    replay: pack.indexPath || `${pack.root}/index.html`,
    evidence: pack.evidencePath || `${pack.root}/evidence.json`,
    marks: marks.length ? marks : pack.marks,
    markCount: pack.marks.length,
  };
}

function packArtifacts(pack) {
  const artifacts = [...pack.artifacts];
  if (pack.evidencePath) upsert(artifacts, { type: 'evidence', path: pack.evidencePath });
  if (pack.indexPath) upsert(artifacts, { type: 'evidence-replay', path: pack.indexPath });
  return artifacts;
}

function upsertArtifact(pack, artifact) {
  upsert(pack.artifacts, artifact);
}

function upsert(artifacts, artifact) {
  const index = artifacts.findIndex(item => item.type === artifact.type && item.path === artifact.path);
  if (index === -1) artifacts.push(artifact);
}

function sanitizeArgs(command, args = []) {
  return redactCommandArgs(command, args);
}

function safeName(value) {
  return String(value || 'evidence').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'evidence';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}
