import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { redactCommandArgs, redactHeaders, redactObject, redactUrl } from '../plugins/chromex/skills/chromex/scripts/lib/redaction.mjs';
import { redactPages } from '../plugins/chromex/skills/chromex/scripts/lib/browser.mjs';
import { auditStr } from '../plugins/chromex/skills/chromex/scripts/lib/commands/audit.mjs';

function auditCdp(url, wsUrl) {
  return {
    wsUrl,
    send(method) {
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: url } });
      return Promise.resolve({});
    },
  };
}

async function captureAuditInvocation(url, reportPath, wsUrl) {
  const directory = mkdtempSync(join(tmpdir(), 'chromex-audit-security-'));
  const capturePath = join(directory, 'args.json');
  const resolverCapturePath = join(directory, 'resolver-args.json');
  const markerPath = join(directory, 'injected');
  const executablePath = join(directory, 'npx');
  const curlPath = join(directory, 'curl');
  const lighthouseDirectory = join(directory, 'node_modules', 'lighthouse', 'cli');
  const lighthouseCliPath = join(lighthouseDirectory, 'index.js');
  const previousPath = process.env.PATH;
  const previousCapturePath = process.env.CHROMEX_AUDIT_CAPTURE;
  const previousResolverCapturePath = process.env.CHROMEX_AUDIT_RESOLVER_CAPTURE;
  const previousLighthouseCliPath = process.env.CHROMEX_AUDIT_LIGHTHOUSE_CLI;
  const previousMarkerPath = process.env.CHROMEX_AUDIT_MARKER;
  const previousArtifactRoot = process.env.CHROMEX_ARTIFACT_ROOT;
  const resolvedReportPath = reportPath ? join(directory, reportPath) : undefined;

  mkdirSync(lighthouseDirectory, { recursive: true });
  writeFileSync(executablePath, `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.CHROMEX_AUDIT_RESOLVER_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.CHROMEX_AUDIT_LIGHTHOUSE_CLI);
`, { mode: 0o700 });
  writeFileSync(lighthouseCliPath, `
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.CHROMEX_AUDIT_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({ categories: { performance: { title: 'Performance', score: 1 } }, audits: {} }));
`);
  writeFileSync(curlPath, '#!/usr/bin/env node\nprocess.stdout.write(\'{}\');\n', { mode: 0o700 });

  process.env.PATH = `${directory}${delimiter}${previousPath || ''}`;
  process.env.CHROMEX_AUDIT_CAPTURE = capturePath;
  process.env.CHROMEX_AUDIT_RESOLVER_CAPTURE = resolverCapturePath;
  process.env.CHROMEX_AUDIT_LIGHTHOUSE_CLI = lighthouseCliPath;
  process.env.CHROMEX_AUDIT_MARKER = markerPath;
  process.env.CHROMEX_ARTIFACT_ROOT = join(directory, 'artifacts');

  try {
    const output = await auditStr(auditCdp(url, wsUrl), 'session', 'performance', 'desktop', resolvedReportPath);
    return {
      args: JSON.parse(readFileSync(capturePath, 'utf8')),
      resolverArgs: JSON.parse(readFileSync(resolverCapturePath, 'utf8')),
      markerCreated: existsSync(markerPath),
      output,
      reportPath: resolvedReportPath,
    };
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousCapturePath === undefined) delete process.env.CHROMEX_AUDIT_CAPTURE;
    else process.env.CHROMEX_AUDIT_CAPTURE = previousCapturePath;
    if (previousResolverCapturePath === undefined) delete process.env.CHROMEX_AUDIT_RESOLVER_CAPTURE;
    else process.env.CHROMEX_AUDIT_RESOLVER_CAPTURE = previousResolverCapturePath;
    if (previousLighthouseCliPath === undefined) delete process.env.CHROMEX_AUDIT_LIGHTHOUSE_CLI;
    else process.env.CHROMEX_AUDIT_LIGHTHOUSE_CLI = previousLighthouseCliPath;
    if (previousMarkerPath === undefined) delete process.env.CHROMEX_AUDIT_MARKER;
    else process.env.CHROMEX_AUDIT_MARKER = previousMarkerPath;
    if (previousArtifactRoot === undefined) delete process.env.CHROMEX_ARTIFACT_ROOT;
    else process.env.CHROMEX_ARTIFACT_ROOT = previousArtifactRoot;
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('sensitive data redaction', () => {
  it('redacts values from form and input commands', () => {
    expect(redactCommandArgs('fill', ['#password', 'super-secret'])).toEqual(['#password', '<redacted>']);
    expect(redactCommandArgs('type', ['super-secret'])).toEqual(['<redacted>']);
    expect(redactCommandArgs('form', ['{"password":"super-secret"}'])).toEqual(['<redacted>']);
  });

  it('redacts authentication headers and sensitive URL values', () => {
    expect(redactHeaders({ Authorization: 'Bearer abc', Accept: 'application/json', Cookie: 'sid=abc' })).toEqual({
      Authorization: '<redacted>',
      Accept: 'application/json',
      Cookie: '<redacted>',
    });
    expect(redactUrl('https://example.test/callback?token=abc&mode=safe')).toContain('token=%3Credacted%3E');
    expect(redactUrl('https://example.test/callback?token=abc&mode=safe')).toContain('mode=safe');
  });

  it('redacts sensitive keys recursively', () => {
    expect(redactObject({ user: 'alice', nested: { accessToken: 'abc', enabled: true } })).toEqual({
      user: 'alice',
      nested: { accessToken: '<redacted>', enabled: true },
    });
  });

  it('preserves complete non-sensitive values while redacting secrets', () => {
    const description = 'a'.repeat(500);

    expect(redactObject({ description, accessToken: 'secret' })).toEqual({
      description,
      accessToken: '<redacted>',
    });
    expect(redactHeaders({ 'X-Debug-Context': description })['X-Debug-Context']).toBe(description);
  });

  it('redacts page URLs by default and reveals them only on explicit live output', () => {
    const pages = [{ targetId: 'target-1', title: 'Authorization: Bearer title-secret', url: 'https://example.test/callback?token=page-secret' }];

    expect(redactPages(pages)[0].url).not.toContain('page-secret');
    expect(redactPages(pages)[0].title).not.toContain('title-secret');
    expect(redactPages(pages, { includeSensitive: true })[0].url).toContain('page-secret');
    expect(redactPages(pages, { includeSensitive: true })[0].title).toContain('title-secret');
  });
});

describe('Lighthouse audit process boundary', () => {
  it('passes page URLs without shell interpretation', async () => {
    const url = 'https://example.test/#$(touch$IFS$CHROMEX_AUDIT_MARKER)';
    const result = await captureAuditInvocation(url);

    expect(result.markerCreated).toBe(false);
    expect(result.args).toContain(url);
    expect(result.resolverArgs).not.toContain(url);
  });

  it('passes report paths without shell interpretation', async () => {
    const reportPath = 'audit.html; touch$IFS$CHROMEX_AUDIT_MARKER #';
    const result = await captureAuditInvocation('https://example.test/', reportPath);

    expect(result.markerCreated).toBe(false);
    expect(result.args).toContain(`--output-path=${result.reportPath}`);
    expect(result.resolverArgs).not.toContain(result.reportPath);
  });

  it('preserves ordinary Lighthouse arguments and output', async () => {
    const url = 'https://example.test/dashboard?view=weekly';
    const reportPath = 'reports/audit result.html';
    const result = await captureAuditInvocation(url, reportPath);

    expect(result.args).toEqual([
      url,
      '--output=json',
      '--only-categories=performance',
      '--quiet',
      '--preset=desktop',
      `--output-path=${result.reportPath}`,
      '--output=html',
      '--output=json',
      '--chrome-flags=--headless=new',
    ]);
    expect(result.resolverArgs.slice(0, 5)).toEqual([
      '--yes',
      '--package=lighthouse',
      '--',
      process.execPath,
      '-e',
    ]);
    expect(result.resolverArgs).toHaveLength(6);
    expect(result.output).toContain('Lighthouse Audit: Performance: 100');
  });

  it('preserves audits connected to an existing Chrome debug port', async () => {
    const result = await captureAuditInvocation(
      'https://example.test/',
      undefined,
      'ws://127.0.0.1:9222/devtools/browser/session',
    );

    expect(result.args).toContain('--port=9222');
    expect(result.args).not.toContain('--chrome-flags=--headless=new');
    expect(result.output).toContain('Mode: connected (existing browser)');
  });
});
