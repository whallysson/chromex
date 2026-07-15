import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimeRoot = resolve(root, 'plugins/chromex/skills/chromex/scripts');
const packageInfo = readJson('package.json');

describe('public CLI surface', () => {
  it('reports the installed package version without browser setup', () => {
    const result = spawnSync(process.execPath, [resolve(root, 'bin/chromex.mjs'), '--version'], {
      cwd: root,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(packageInfo.version);
  });

  it('does not use deprecated legacy Node URL parsing APIs', () => {
    const violations = runtimeFiles(runtimeRoot).flatMap(file => {
      const source = readFileSync(file, 'utf8');
      return /\burl\.(?:parse|resolve)\s*\(|\burl\.format\s*\(\s*(?:['"`]|[a-zA-Z_$][\w$]*\s*\))/m.test(source)
        ? [file.slice(root.length + 1)]
        : [];
    });

    expect(violations).toEqual([]);
  });
});

describe('public documentation surface', () => {
  it('keeps package and plugin release metadata aligned', () => {
    const marketplace = readJson('.claude-plugin/marketplace.json');
    const plugin = readJson('plugins/chromex/.claude-plugin/plugin.json');
    const marketplacePlugin = marketplace.plugins.find(item => item.name === 'chromex');

    expect(plugin.version).toBe(packageInfo.version);
    expect(marketplacePlugin.version).toBe(packageInfo.version);
    expect(plugin.description).toContain('85 typed MCP tools');
    expect(marketplace.description).toContain('85 typed MCP tools');
    expect(packageInfo.files).toContain('docs/');
  });

  it('keeps relative Markdown links resolvable', () => {
    const markdownFiles = [resolve(root, 'README.md'), ...runtimeFiles(resolve(root, 'docs'), '.md')];
    const broken = [];

    for (const file of markdownFiles) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const target = match[1].trim().replace(/^<|>$/g, '');
        if (!target || target.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const path = resolve(dirname(file), target.split('#')[0]);
        if (!existsSync(path)) broken.push(`${file.slice(root.length + 1)} -> ${target}`);
      }
    }

    expect(broken).toEqual([]);
  });

  it('documents the complete advanced capability families', () => {
    const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
    const advanced = readFileSync(resolve(root, 'docs/advanced.md'), 'utf8');
    const troubleshooting = readFileSync(resolve(root, 'docs/troubleshooting.md'), 'utf8');

    for (const command of ['issues', 'inspect', 'diagnose', 'trace', 'heap', 'screencast', 'extensions', 'third-party', 'webmcp']) {
      expect(readme).toContain(`chromex ${command}`);
    }
    for (const heading of ['Performance and Allocation Profiles', 'Heap Snapshots and Graph Analysis', 'Chrome Extension Tooling', 'Page-Exposed Developer Tools', 'WebMCP']) {
      expect(advanced).toContain(`## ${heading}`);
    }
    expect(troubleshooting).toContain('chromex --version');
    expect(readFileSync(resolve(root, 'docs/getting-started.md'), 'utf8')).not.toContain('chmod +x skills/chromex/scripts/chromex.mjs');
  });
});

function readJson(path) {
  return JSON.parse(readFileSync(resolve(root, path), 'utf8'));
}

function runtimeFiles(directory, extension = '.mjs') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return runtimeFiles(path, extension);
    return entry.isFile() && entry.name.endsWith(extension) ? [path] : [];
  });
}
