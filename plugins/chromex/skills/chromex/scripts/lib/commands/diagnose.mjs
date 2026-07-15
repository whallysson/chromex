import { redactObject, redactUrl } from '../redaction.mjs';

export async function diagnoseStr(cdp, sid, context, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const page = await currentPage(cdp, sid);
  const consoleErrors = context.consoleMessages.filter(item => ['error', 'exception'].includes(item.type));
  const consoleWarnings = context.consoleMessages.filter(item => ['warn', 'warning', 'violation'].includes(item.type));
  const networkErrors = [...context.networkRequests.entries()].filter(([, request]) => request.failed || request.status >= 400);
  const issues = context.issues.items;
  const metrics = await performanceSignals(cdp, sid);
  const score = issues.length * 3 + networkErrors.length * 3 + consoleErrors.length * 2 + consoleWarnings.length;
  const lines = [
    `Diagnosis: ${score === 0 ? 'healthy' : score < 5 ? 'attention' : 'degraded'}`,
    `Page: ${page.title || '(untitled)'} ${redactUrl(page.url)}`,
    `Signals: issues=${issues.length} networkErrors=${networkErrors.length} consoleErrors=${consoleErrors.length} warnings=${consoleWarnings.length}`,
  ];
  if (metrics.length) lines.push(`Runtime: ${metrics.map(item => `${item.name}=${formatMetric(item.value)}`).join(' ')}`);
  appendIssues(lines, issues, safeLimit);
  appendNetwork(lines, networkErrors, safeLimit);
  appendConsole(lines, consoleErrors, consoleWarnings, safeLimit);
  if (score === 0) lines.push('No actionable runtime failures were observed in the current daemon window.');
  return {
    text: lines.join('\n'),
    data: redactObject({ page, score, issues: issues.slice(-safeLimit), networkErrors: networkErrors.slice(-safeLimit), consoleErrors: consoleErrors.slice(-safeLimit), consoleWarnings: consoleWarnings.slice(-safeLimit), metrics }),
  };
}

async function currentPage(cdp, sid) {
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: '({url: location.href, title: document.title})',
    returnByValue: true,
  }, sid);
  return result?.value || { url: '', title: '' };
}

async function performanceSignals(cdp, sid) {
  try {
    await cdp.send('Performance.enable', {}, sid);
    const { metrics = [] } = await cdp.send('Performance.getMetrics', {}, sid);
    const selected = new Set(['JSHeapUsedSize', 'JSHeapTotalSize', 'Nodes', 'Documents', 'Frames', 'LayoutCount', 'RecalcStyleCount', 'TaskDuration']);
    return metrics.filter(item => selected.has(item.name));
  } catch {
    return [];
  }
}

function appendIssues(lines, issues, limit) {
  if (!issues.length) return;
  lines.push('', 'Browser Issues:');
  for (const issue of issues.slice(-limit)) lines.push(`  ${issue.code || 'Unknown'}`);
}

function appendNetwork(lines, entries, limit) {
  if (!entries.length) return;
  lines.push('', 'Network Failures:');
  for (const [, request] of entries.slice(-limit)) {
    const status = request.failed ? request.failure?.errorText || 'failed' : request.status;
    lines.push(`  ${status} ${request.method || 'GET'} ${redactUrl(request.url)}`);
  }
}

function appendConsole(lines, errors, warnings, limit) {
  const entries = [...errors, ...warnings].sort((a, b) => a.ts - b.ts).slice(-limit);
  if (!entries.length) return;
  lines.push('', 'Console Signals:');
  for (const entry of entries) lines.push(`  ${entry.type.toUpperCase()} ${entry.args.join(' ').slice(0, 240)}`);
}

function formatMetric(value) {
  if (value > 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)}MB`;
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(3);
}
