import { writeFileSync } from 'fs';
import { relative, resolve } from 'path';
import { resolveArtifactPath, timestamp, workspaceArtifactRoot, writeTextArtifact } from '../artifacts.mjs';
import { formatSessions } from '../sessions.mjs';
import { checkDomain } from '../security.mjs';
import { snapshotStr } from './snapshot.mjs';

export async function showStr(cdp, records, livePages = [], annotate = false, config = null) {
  const rows = records.map((record) => {
    const page = livePages.find(item => item.targetId === record.targetId);
    return {
      name: record.name,
      state: page ? 'alive' : 'stale',
      targetId: record.targetId || '',
      title: page?.title || record.title || '',
      url: page?.url || record.url || '',
      workspace: record.workspace || '',
    };
  });
  const evidence = await collectEvidence(cdp, rows, annotate, config);
  for (const item of evidence) {
    const row = rows.find(candidate => candidate.targetId === item.targetId);
    if (row) Object.assign(row, item);
  }
  const html = renderDashboard(rows, annotate);
  const dashboard = writeTextArtifact(null, html, 'dashboard', 'index.html');
  const artifacts = [dashboard, ...evidence.flatMap(item => item.artifacts || [])];
  let text = `Dashboard saved to ${dashboard.path}\n\n${formatSessions(records, livePages)}`;
  if (annotate) {
    const annotation = writeTextArtifact(
      null,
      JSON.stringify({
        schemaVersion: 1,
        notes: '',
        annotations: [],
        sessions: rows,
        dashboard: dashboard.path,
        evidence: evidence.map(item => ({
          session: item.name,
          targetId: item.targetId,
          screenshot: item.screenshot || null,
          snapshot: item.snapshot || null,
          error: item.error || null,
        })),
      }, null, 2),
      'annotations',
      `annotation-${timestamp()}.json`
    );
    artifacts.push(annotation);
    text += `\nAnnotation pack saved to ${annotation.path}`;
  }
  return { text, data: { sessions: rows }, artifacts };
}

async function collectEvidence(cdp, rows, annotate, config) {
  if (!cdp) return [];
  const out = [];
  for (const row of rows.filter(item => item.state === 'alive' && item.targetId)) {
    const blocked = config ? checkDomain(row.url, config) : null;
    if (blocked) {
      out.push({ targetId: row.targetId, name: row.name, error: blocked, artifacts: [] });
      continue;
    }
    const item = { targetId: row.targetId, name: row.name, artifacts: [] };
    let sessionId = null;
    try {
      const attached = await cdp.send('Target.attachToTarget', { targetId: row.targetId, flatten: true });
      sessionId = attached.sessionId;
      await cdp.send('Page.enable', {}, sessionId).catch(() => {});
      const screenshot = await capturePreview(cdp, sessionId, row);
      if (screenshot) {
        item.screenshot = screenshot.path;
        item.screenshotRelative = screenshot.relativePath;
        item.artifacts.push(screenshot);
      }
      if (annotate) {
        const snapshot = await captureSnapshot(cdp, sessionId, row);
        if (snapshot) {
          item.snapshot = snapshot.path;
          item.snapshotRelative = snapshot.relativePath;
          item.artifacts.push(snapshot);
        }
      }
    } catch (error) {
      item.error = error.message;
    } finally {
      if (sessionId) {
        await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
      }
    }
    out.push(item);
  }
  return out;
}

async function capturePreview(cdp, sessionId, row) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
  const filePath = resolveArtifactPath(null, 'dashboard', `${artifactName(row)}.png`);
  writeFileSync(filePath, Buffer.from(data, 'base64'), { mode: 0o600 });
  return { type: 'dashboard', path: filePath, relativePath: dashboardRelativePath(filePath) };
}

async function captureSnapshot(cdp, sessionId, row) {
  const result = await snapshotStr(cdp, sessionId, true, true, null, 0, null, { boxes: true });
  const filePath = resolveArtifactPath(null, 'snapshots', `${artifactName(row)}.yml`);
  writeFileSync(filePath, result.text, { mode: 0o600 });
  return { type: 'snapshots', path: filePath, relativePath: dashboardRelativePath(filePath) };
}

function dashboardRelativePath(filePath) {
  return relative(resolve(workspaceArtifactRoot(), 'dashboard'), filePath) || '.';
}

function artifactName(row) {
  const name = String(row.name || 'session').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'session';
  const target = String(row.targetId || '').slice(0, 8) || 'unknown';
  return `${name}-${target}-${timestamp()}`;
}

function renderDashboard(rows, annotate) {
  const payload = {
    schemaVersion: 1,
    annotate,
    generatedAt: new Date().toISOString(),
    sessions: rows.map(row => ({
      name: row.name || '',
      state: row.state || '',
      targetId: row.targetId || '',
      title: row.title || '',
      url: row.url || '',
      workspace: row.workspace || '',
      screenshot: row.screenshot || '',
      snapshot: row.snapshot || '',
      error: row.error || '',
    })),
  };
  const items = rows.map(row => `
      <article>
        <h2>${escapeHtml(row.name || 'unnamed')}</h2>
        <p><strong>${escapeHtml(row.state)}</strong> ${escapeHtml(row.targetId.slice(0, 8))}</p>
        ${row.screenshotRelative ? `<div class="stage" data-session="${escapeHtml(row.name || '')}" data-target="${escapeHtml(row.targetId || '')}" data-screenshot="${escapeHtml(row.screenshot || '')}" data-snapshot="${escapeHtml(row.snapshot || '')}"><img src="${escapeHtml(row.screenshotRelative)}" alt="${escapeHtml(row.name || 'session')} preview"><svg viewBox="0 0 100 100" preserveAspectRatio="none"></svg></div>` : ''}
        <p>${escapeHtml(row.title)}</p>
        <a href="${escapeHtml(row.url)}">${escapeHtml(row.url)}</a>
        ${row.snapshotRelative ? `<p><a href="${escapeHtml(row.snapshotRelative)}">Snapshot</a></p>` : ''}
        ${row.error ? `<p class="error">${escapeHtml(row.error)}</p>` : ''}
        ${annotate ? `<div class="marks" data-session="${escapeHtml(row.name || '')}"></div>` : ''}
        <small>${escapeHtml(row.workspace)}</small>
      </article>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Chromex Sessions</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font: 14px system-ui, sans-serif; background: #f5f5f2; color: #191918; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 20px; border-bottom: 1px solid #d8d8d2; background: #ffffff; position: sticky; top: 0; z-index: 2; }
    main { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; padding: 16px; }
    article { background: #ffffff; border: 1px solid #d8d8d2; border-radius: 8px; padding: 14px; min-height: 150px; }
    button { border: 1px solid #191918; background: #191918; color: #ffffff; border-radius: 6px; padding: 8px 11px; font: inherit; cursor: pointer; }
    button:disabled { opacity: .45; cursor: default; }
    .actions { display: flex; align-items: center; gap: 8px; }
    .stage { position: relative; width: 100%; aspect-ratio: 16 / 10; border: 1px solid #d8d8d2; border-radius: 6px; margin: 10px 0; overflow: hidden; background: #eeeeea; touch-action: none; }
    .stage img { display: block; width: 100%; height: 100%; object-fit: cover; user-select: none; pointer-events: none; }
    .stage svg { position: absolute; inset: 0; width: 100%; height: 100%; }
    .stage rect { fill: rgba(7, 89, 133, .14); stroke: #075985; stroke-width: .8; vector-effect: non-scaling-stroke; }
    .stage circle { fill: #be123c; stroke: #ffffff; stroke-width: .6; vector-effect: non-scaling-stroke; }
    .marks { display: grid; gap: 8px; margin: 8px 0 10px; }
    .mark { border: 1px solid #d8d8d2; border-radius: 6px; padding: 8px; background: #fbfbf9; }
    .mark textarea { width: 100%; min-height: 54px; margin: 6px 0 0; resize: vertical; }
    h1, h2, p { margin: 0 0 8px; }
    a { color: #075985; word-break: break-all; }
    .error { color: #9f1239; }
    small { display: block; margin-top: 12px; color: #686863; }
    textarea { padding: 8px; font: inherit; border: 1px solid #b9b9b0; border-radius: 6px; }
    #global-notes { width: calc(100% - 32px); min-height: 120px; margin: 0 16px 16px; resize: vertical; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Chromex Sessions</h1>
      <p>${annotate ? 'Annotation Pack' : 'Local Dashboard'}</p>
    </div>
    ${annotate ? '<div class="actions"><button id="export-json">Export JSON</button><button id="clear-marks" disabled>Clear</button></div>' : ''}
  </header>
  <main>${items || '<p>No sessions.</p>'}</main>
  ${annotate ? '<textarea id="global-notes" placeholder="Notes"></textarea>' : ''}
  <script type="application/json" id="chromex-dashboard-data">${escapeScriptJson(JSON.stringify(payload))}</script>
  ${annotate ? `<script>
(() => {
  const payload = JSON.parse(document.getElementById('chromex-dashboard-data').textContent);
  const marks = [];
  const exportButton = document.getElementById('export-json');
  const clearButton = document.getElementById('clear-marks');
  const globalNotes = document.getElementById('global-notes');
  const point = (stage, event) => {
    const rect = stage.getBoundingClientRect();
    const x = Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((event.clientY - rect.top) / rect.height) * 100));
    return { x, y };
  };
  const render = () => {
    document.querySelectorAll('.stage svg').forEach(svg => svg.replaceChildren());
    document.querySelectorAll('.marks').forEach(box => box.replaceChildren());
    for (const mark of marks) {
      const stage = document.querySelector('.stage[data-session="' + CSS.escape(mark.session) + '"]');
      if (!stage) continue;
      const svg = stage.querySelector('svg');
      const node = document.createElementNS('http://www.w3.org/2000/svg', mark.kind === 'point' ? 'circle' : 'rect');
      if (mark.kind === 'point') {
        node.setAttribute('cx', mark.x);
        node.setAttribute('cy', mark.y);
        node.setAttribute('r', 1.3);
      } else {
        node.setAttribute('x', mark.x);
        node.setAttribute('y', mark.y);
        node.setAttribute('width', mark.width);
        node.setAttribute('height', mark.height);
      }
      svg.appendChild(node);
      const list = document.querySelector('.marks[data-session="' + CSS.escape(mark.session) + '"]');
      if (!list) continue;
      const item = document.createElement('section');
      item.className = 'mark';
      const title = document.createElement('strong');
      title.textContent = mark.kind === 'point' ? 'Point' : 'Region';
      const note = document.createElement('textarea');
      note.value = mark.note || '';
      note.placeholder = 'Note';
      note.addEventListener('input', () => { mark.note = note.value; });
      item.append(title, note);
      list.appendChild(item);
    }
    clearButton.disabled = marks.length === 0;
  };
  document.querySelectorAll('.stage').forEach(stage => {
    let start = null;
    stage.addEventListener('pointerdown', event => {
      start = point(stage, event);
      stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener('pointerup', event => {
      if (!start) return;
      const end = point(stage, event);
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const width = Math.abs(start.x - end.x);
      const height = Math.abs(start.y - end.y);
      const session = stage.dataset.session || '';
      const targetId = stage.dataset.target || '';
      const screenshot = stage.dataset.screenshot || '';
      const snapshot = stage.dataset.snapshot || '';
      const mark = width < 1.5 && height < 1.5
        ? { kind: 'point', session, targetId, screenshot, snapshot, x: end.x, y: end.y, note: '' }
        : { kind: 'region', session, targetId, screenshot, snapshot, x, y, width, height, note: '' };
      marks.push(mark);
      start = null;
      render();
    });
  });
  clearButton.addEventListener('click', () => {
    marks.length = 0;
    render();
  });
  exportButton.addEventListener('click', async () => {
    const pack = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      notes: globalNotes.value,
      sessions: payload.sessions,
      annotations: marks,
    };
    const blob = new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' });
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({ suggestedName: 'chromex-annotations.json', types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }] });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'chromex-annotations.json';
    link.click();
    URL.revokeObjectURL(url);
  });
})();
</script>` : ''}
</body>
</html>`;
}

function escapeScriptJson(value) {
  return String(value).replace(/</g, '\\u003c');
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
