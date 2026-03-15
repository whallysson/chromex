// Core Web Vitals + performance metrics

import { evalStr } from './evaluate.mjs';

export async function perfStr(cdp, sid) {
  // Métricas do CDP
  await cdp.send('Performance.enable', {}, sid);
  const { metrics } = await cdp.send('Performance.getMetrics', {}, sid);
  await cdp.send('Performance.disable', {}, sid);

  // Core Web Vitals via PerformanceObserver
  const vitals = await evalStr(cdp, sid, `
    (function() {
      const result = {};
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) {
        result.ttfb = Math.round(nav.responseStart - nav.requestStart);
        result.domContentLoaded = Math.round(nav.domContentLoadedEventEnd - nav.fetchStart);
        result.load = Math.round(nav.loadEventEnd - nav.fetchStart);
        result.domInteractive = Math.round(nav.domInteractive - nav.fetchStart);
      }

      // LCP
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
      if (lcpEntries.length > 0) {
        const lcp = lcpEntries[lcpEntries.length - 1];
        result.lcp = Math.round(lcp.startTime);
        result.lcpElement = lcp.element?.tagName || 'unknown';
      }

      // CLS
      let cls = 0;
      for (const entry of performance.getEntriesByType('layout-shift')) {
        if (!entry.hadRecentInput) cls += entry.value;
      }
      result.cls = Math.round(cls * 1000) / 1000;

      // FCP
      const fcpEntries = performance.getEntriesByType('paint');
      const fcp = fcpEntries.find(e => e.name === 'first-contentful-paint');
      if (fcp) result.fcp = Math.round(fcp.startTime);

      // Contadores
      result.resources = performance.getEntriesByType('resource').length;
      result.transferSize = performance.getEntriesByType('resource')
        .reduce((sum, r) => sum + (r.transferSize || 0), 0);

      return JSON.stringify(result);
    })()
  `);

  const v = JSON.parse(vitals);
  const cdpMetrics = {};
  for (const m of metrics) cdpMetrics[m.name] = m.value;

  const lines = ['## Core Web Vitals'];

  if (v.lcp != null) lines.push(`LCP:  ${v.lcp}ms  (${v.lcpElement})${v.lcp <= 2500 ? ' [GOOD]' : v.lcp <= 4000 ? ' [NEEDS IMPROVEMENT]' : ' [POOR]'}`);
  if (v.fcp != null) lines.push(`FCP:  ${v.fcp}ms${v.fcp <= 1800 ? ' [GOOD]' : v.fcp <= 3000 ? ' [NEEDS IMPROVEMENT]' : ' [POOR]'}`);
  if (v.cls != null) lines.push(`CLS:  ${v.cls}${v.cls <= 0.1 ? ' [GOOD]' : v.cls <= 0.25 ? ' [NEEDS IMPROVEMENT]' : ' [POOR]'}`);
  if (v.ttfb != null) lines.push(`TTFB: ${v.ttfb}ms${v.ttfb <= 800 ? ' [GOOD]' : v.ttfb <= 1800 ? ' [NEEDS IMPROVEMENT]' : ' [POOR]'}`);

  lines.push('');
  lines.push('## Navigation Timing');
  if (v.domInteractive != null) lines.push(`DOM Interactive:       ${v.domInteractive}ms`);
  if (v.domContentLoaded != null) lines.push(`DOMContentLoaded:      ${v.domContentLoaded}ms`);
  if (v.load != null) lines.push(`Load:                  ${v.load}ms`);

  lines.push('');
  lines.push('## Resources');
  lines.push(`Total requests:  ${v.resources}`);
  lines.push(`Transfer size:   ${formatBytes(v.transferSize)}`);

  if (cdpMetrics.JSHeapUsedSize) {
    lines.push('');
    lines.push('## Memory');
    lines.push(`JS Heap Used:  ${formatBytes(cdpMetrics.JSHeapUsedSize)}`);
    lines.push(`JS Heap Total: ${formatBytes(cdpMetrics.JSHeapTotalSize)}`);
  }

  if (cdpMetrics.Nodes) {
    lines.push('');
    lines.push('## DOM');
    lines.push(`DOM Nodes:     ${cdpMetrics.Nodes}`);
    lines.push(`Documents:     ${cdpMetrics.Documents}`);
    lines.push(`Frames:        ${cdpMetrics.Frames}`);
    lines.push(`Listeners:     ${cdpMetrics.JSEventListeners}`);
  }

  return lines.join('\n');
}

function formatBytes(bytes) {
  if (bytes == null) return '?';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
