// Lighthouse audit via subprocess (zero deps -- invokes npx lighthouse externally)
// Chrome: connects to existing browser via --port (reuses session)
// Other browsers (Brave, Edge, etc.): Lighthouse launches its own headless Chrome

import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { evalStr } from './evaluate.mjs';

const VALID_CATEGORIES = ['performance', 'accessibility', 'seo', 'best-practices'];

// Find any Chromium-based browser for CHROME_PATH env var
function findChromiumPath() {
  const paths = process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ] : [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/brave-browser', '/usr/bin/chromium-browser', '/usr/bin/chromium',
    '/usr/bin/microsoft-edge',
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  return null;
}

// Check if Chrome's HTTP debug endpoint is available (Brave/Edge don't expose it)
function isHttpDebugAvailable(port) {
  try {
    const result = execSync(`curl -sf http://127.0.0.1:${port}/json/version`, {
      encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.length > 0;
  } catch {
    return false;
  }
}

export async function auditStr(cdp, sid, categories, device, reportPath) {
  // Get current page URL
  const url = await evalStr(cdp, sid, 'window.location.href');
  if (!url || url === 'about:blank') {
    throw new Error('Navigate to a page first before running audit.');
  }

  // Validate categories
  const cats = categories
    ? categories.split(',').map(c => c.trim().toLowerCase()).filter(c => VALID_CATEGORIES.includes(c))
    : VALID_CATEGORIES;

  if (cats.length === 0) {
    throw new Error(`Invalid categories. Valid: ${VALID_CATEGORIES.join(', ')}`);
  }

  // Build base args
  const args = [
    '--output=json',
    `--only-categories=${cats.join(',')}`,
    '--quiet',
  ];

  if (device === 'desktop') args.push('--preset=desktop');

  if (reportPath) {
    args.push(`--output-path=${reportPath}`);
    args.push('--output=html');
    args.push('--output=json');
  }

  // Detect: Chrome (has /json/version) vs other browsers (Brave, Edge, etc.)
  let port;
  if (cdp.wsUrl) {
    const m = cdp.wsUrl.match(/:(\d+)\//);
    if (m) port = m[1];
  }

  let mode;
  if (port && isHttpDebugAvailable(port)) {
    // Chrome: reuse existing browser session
    args.push(`--port=${port}`);
    mode = 'connected (existing browser)';
  } else {
    // Brave/Edge/other: Lighthouse launches its own headless Chrome
    args.push('--chrome-flags=--headless=new');
    mode = 'standalone (headless Chrome)';
  }

  const cmd = `npx --yes lighthouse ${JSON.stringify(url)} ${args.join(' ')}`;

  // Set CHROME_PATH for standalone mode (Lighthouse uses chrome-launcher which reads it)
  const env = { ...process.env };
  if (mode.startsWith('standalone')) {
    const chromePath = findChromiumPath();
    if (chromePath) env.CHROME_PATH = chromePath;
  }

  let jsonOutput;
  try {
    jsonOutput = execSync(cmd, {
      encoding: 'utf8',
      timeout: 120000,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 50 * 1024 * 1024,
      env,
    });
  } catch (e) {
    const stderr = e.stderr?.toString().trim() || '';
    if (stderr.includes('not found') || stderr.includes('ENOENT')) {
      throw new Error('lighthouse not found. Install: npm i -g lighthouse');
    }
    if (stderr.includes('No Chrome installations found')) {
      throw new Error('Lighthouse needs Chrome installed to run in standalone mode. Install Google Chrome or run against a Chrome instance with debug port.');
    }
    throw new Error(`Lighthouse failed: ${stderr || e.message}`);
  }

  // Parse JSON output
  let report;
  try {
    report = JSON.parse(jsonOutput);
  } catch {
    const jsonStart = jsonOutput.lastIndexOf('{"');
    if (jsonStart > 0) {
      report = JSON.parse(jsonOutput.slice(jsonStart));
    } else {
      throw new Error('Failed to parse Lighthouse output.');
    }
  }

  // Format results
  const lines = [];

  // Scores
  const scores = {};
  for (const cat of cats) {
    const c = report.categories?.[cat];
    if (c) scores[c.title] = Math.round((c.score || 0) * 100);
  }
  const scoreStr = Object.entries(scores).map(([k, v]) => `${k}: ${v}`).join(' | ');
  lines.push(`Lighthouse Audit: ${scoreStr}`);
  lines.push(`URL: ${url}`);
  lines.push(`Device: ${device || 'mobile'} | Mode: ${mode}`);
  lines.push('');

  // Top opportunities
  const audits = report.audits || {};
  const opportunities = Object.values(audits)
    .filter(a => a.details?.type === 'opportunity' && a.details?.overallSavingsMs > 0)
    .sort((a, b) => (b.details.overallSavingsMs || 0) - (a.details.overallSavingsMs || 0))
    .slice(0, 5);

  if (opportunities.length > 0) {
    lines.push('Top Opportunities:');
    for (const opp of opportunities) {
      const savings = (opp.details.overallSavingsMs / 1000).toFixed(1);
      lines.push(`  - ${opp.title} (savings: ${savings}s)`);
    }
    lines.push('');
  }

  // Critical diagnostics
  const diagnostics = Object.values(audits)
    .filter(a => a.score !== null && a.score < 0.5 && a.details?.type !== 'opportunity')
    .sort((a, b) => (a.score || 0) - (b.score || 0))
    .slice(0, 5);

  if (diagnostics.length > 0) {
    lines.push('Critical Issues:');
    for (const diag of diagnostics) {
      lines.push(`  - ${diag.title}: ${diag.displayValue || 'needs improvement'}`);
    }
  }

  if (reportPath) {
    lines.push('');
    lines.push(`Full report saved to: ${reportPath}`);
  }

  return lines.join('\n');
}
