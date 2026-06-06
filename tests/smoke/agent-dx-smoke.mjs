#!/usr/bin/env node
import { execFile } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import http from 'http';

const root = resolve(new URL('../..', import.meta.url).pathname);
const cli = resolve(root, 'plugins/chromex/skills/chromex/scripts/chromex.mjs');
const workspace = mkdtempSync(join(tmpdir(), 'chromex-agent-dx-'));
const profile = join(workspace, 'profile');
const env = {
  ...process.env,
  CDP_PORT_FILE: join(profile, 'DevToolsActivePort'),
  CHROMEX_NO_OPEN: '1',
  CHROMEX_ARTIFACT_ROOT: join(workspace, 'artifacts'),
};

const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Chromex Smoke</title></head>
<body>
  <main>
    <label>Email <input data-testid="email" name="email" autocomplete="email"></label>
    <button data-testid="save" onclick="localStorage.setItem('savedEmail', document.querySelector('[name=email]').value); document.body.dataset.saved='yes'">Save</button>
    <p id="status"></p>
    <script>document.getElementById('status').textContent = localStorage.getItem('savedEmail') || '';</script>
  </main>
</body>
</html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});

const listen = () => new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const closeServer = () => new Promise(resolveClose => server.close(resolveClose));

function run(args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    execFile(process.execPath, [cli, ...args], { cwd: workspace, env, timeout: options.timeout || 30000 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        rejectRun(error);
        return;
      }
      resolveRun(stdout.trim());
    });
  });
}

async function json(args) {
  return JSON.parse(await run(['--json', ...args]));
}

async function waitForPage(url) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await json(['list']).catch(() => null);
    const pageInfo = result?.data?.find(item => item.url === url);
    if (pageInfo) return pageInfo;
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  throw new Error(`Page not found: ${url}`);
}

let browserPid = null;

try {
  await listen();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const launch = await run(['launch', '--headless', '--url', url, '--chrome-arg', `--user-data-dir=${profile}`]);
  browserPid = Number(launch.match(/PID: (\d+)/)?.[1] || 0) || null;
  await waitForPage(url);

  const session = `smoke-${Date.now()}`;
  await json(['-s', session, 'open', url]);
  const snap = await json(['-s', session, 'snap', '--refs', '--filename=.chromex/snapshots/smoke.yml', '--boxes']);
  if (!snap.ok || !snap.artifacts.length) throw new Error('snapshot artifact missing');

  const locator = await json(['-s', session, 'locator', '@e1', '--format=chromex-test']);
  if (!locator.text.includes('getByTestId')) throw new Error('locator did not use test id');

  const evidenceStart = await json(['-s', session, 'evidence', 'start', 'smoke-flow']);
  if (!evidenceStart.ok || !evidenceStart.artifacts.some(item => item.type === 'evidence-replay')) throw new Error('evidence start artifact missing');

  await json(['-s', session, 'fill', '@e1', 'smoke@example.test']);
  await json(['-s', session, 'click', '@e2']);

  const evidenceMark = await json(['-s', session, 'evidence', 'mark', 'after save']);
  if (!evidenceMark.ok || evidenceMark.data.markCount < 2) throw new Error('evidence mark missing');

  const state = await json(['-s', session, 'state', 'save', '.chromex/storage/smoke.json']);
  if (!state.ok || !state.artifacts.length) throw new Error('state artifact missing');

  const evidenceStop = await json(['-s', session, 'evidence', 'stop']);
  if (!evidenceStop.ok || !evidenceStop.artifacts.some(item => item.type === 'evidence')) throw new Error('evidence pack missing');

  const show = await json(['show', '--annotate']);
  if (!show.structuredContent && !show.artifacts?.length) throw new Error('show artifact missing');

  await json(['close-all']);
  await json(['delete-data', session]);
  console.log('chromex agent DX smoke passed');
} finally {
  await closeServer().catch(() => {});
  if (browserPid) {
    try { process.kill(browserPid); } catch {}
  }
}
