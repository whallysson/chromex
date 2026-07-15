import { writeFileSync } from 'fs';
import { evalStr } from './evaluate.mjs';
import { emptyState } from '../output.mjs';
import { resolveArtifactPath, timestamp } from '../artifacts.mjs';

let cpuProfiling = false;
let heapSampling = false;

export async function perfStr(cdp, sid, action = 'summary', filePath) {
  const normalized = String(action || 'summary').toLowerCase();
  if (normalized === 'start') {
    await installCollector(cdp, sid, true);
    return { text: 'Performance collection started.', data: { collecting: true } };
  }
  if (normalized === 'stop') {
    const result = await performanceSummary(cdp, sid);
    await evalStr(cdp, sid, 'window.__chromexPerf?.disconnect()').catch(() => {});
    return result;
  }
  if (normalized === 'summary') return performanceSummary(cdp, sid);
  if (normalized === 'cpu-start') return startCpuProfile(cdp, sid);
  if (normalized === 'cpu-stop') return stopCpuProfile(cdp, sid, filePath);
  if (normalized === 'heap-sampling-start') return startHeapSampling(cdp, sid);
  if (normalized === 'heap-sampling-stop') return stopHeapSampling(cdp, sid, filePath);
  throw new Error('Usage: perf <target> summary|start|stop|cpu-start|cpu-stop|heap-sampling-start|heap-sampling-stop [file]');
}

async function performanceSummary(cdp, sid) {
  await installCollector(cdp, sid, false);
  await cdp.send('Performance.enable', {}, sid);
  const { metrics = [] } = await cdp.send('Performance.getMetrics', {}, sid);
  const raw = await evalStr(cdp, sid, `JSON.stringify((() => {
    const state = window.__chromexPerf;
    const nav = performance.getEntriesByType('navigation')[0];
    const paints = performance.getEntriesByType('paint');
    const lcpEntries = performance.getEntriesByType('largest-contentful-paint');
    const lcp = state.lcp.at(-1) || lcpEntries.at(-1);
    const shifts = state.layoutShifts.length ? state.layoutShifts : performance.getEntriesByType('layout-shift').filter(entry => !entry.hadRecentInput);
    const cls = shifts.reduce((sum, entry) => sum + (entry.value || 0), 0);
    const interactions = new Map();
    for (const entry of state.events) {
      if (!entry.interactionId) continue;
      interactions.set(entry.interactionId, Math.max(interactions.get(entry.interactionId) || 0, entry.duration || 0));
    }
    const durations = [...interactions.values()].sort((a, b) => b - a);
    const inp = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length / 50))] : null;
    return {
      navigation: nav ? {
        ttfb: Math.round(nav.responseStart - nav.requestStart),
        domInteractive: Math.round(nav.domInteractive - nav.fetchStart),
        domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.fetchStart),
        load: Math.round(nav.loadEventEnd - nav.fetchStart),
      } : {},
      vitals: {
        lcp: lcp ? Math.round(lcp.startTime || lcp.renderTime || lcp.loadTime || 0) : null,
        lcpElement: lcp?.element?.tagName || null,
        fcp: Math.round(paints.find(entry => entry.name === 'first-contentful-paint')?.startTime || 0) || null,
        cls: Math.round(cls * 1000) / 1000,
        inp: inp == null ? null : Math.round(inp),
      },
      longTasks: state.longTasks.slice(-100),
      longAnimationFrames: state.longAnimationFrames.slice(-100),
      layoutShifts: shifts.slice(-100),
      eventCount: state.events.length,
      resources: performance.getEntriesByType('resource').length,
      transferSize: performance.getEntriesByType('resource').reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      supported: state.supported,
    };
  })())`);
  const observed = JSON.parse(raw);
  const cdpMetrics = Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
  if (!hasPerformanceData(observed, cdpMetrics)) return { text: emptyState('perf', 'no metrics available (page not loaded?)'), data: { observed, metrics: cdpMetrics } };
  return { text: renderPerformance(observed, cdpMetrics), data: { ...observed, metrics: cdpMetrics } };
}

async function installCollector(cdp, sid, reset) {
  await evalStr(cdp, sid, `(() => {
    if (window.__chromexPerf && !${reset}) return true;
    window.__chromexPerf?.disconnect?.();
    const state = {
      longTasks: [], longAnimationFrames: [], layoutShifts: [], events: [], lcp: [], observers: [], supported: {},
      disconnect() { for (const observer of this.observers) observer.disconnect(); this.observers.length = 0; },
    };
    const observe = (type, target, options = {}) => {
      try {
        const observer = new PerformanceObserver(list => {
          for (const entry of list.getEntries()) {
            const value = entry.toJSON ? entry.toJSON() : { name: entry.name, entryType: entry.entryType, startTime: entry.startTime, duration: entry.duration };
            target.push(value);
            if (target.length > 1000) target.splice(0, 500);
          }
        });
        observer.observe({ type, buffered: true, ...options });
        state.observers.push(observer);
        state.supported[type] = true;
      } catch { state.supported[type] = false; }
    };
    observe('longtask', state.longTasks);
    observe('long-animation-frame', state.longAnimationFrames);
    observe('layout-shift', state.layoutShifts);
    observe('event', state.events, { durationThreshold: 16 });
    observe('largest-contentful-paint', state.lcp);
    window.__chromexPerf = state;
    return true;
  })()`);
}

async function startCpuProfile(cdp, sid) {
  if (cpuProfiling) return { text: 'CPU profiling already active.', data: { active: true } };
  await cdp.send('Profiler.enable', {}, sid);
  await cdp.send('Profiler.start', {}, sid);
  cpuProfiling = true;
  return { text: 'CPU profiling started.', data: { active: true } };
}

async function stopCpuProfile(cdp, sid, filePath) {
  if (!cpuProfiling) return { text: 'No CPU profile active.', data: { active: false } };
  const { profile } = await cdp.send('Profiler.stop', {}, sid);
  await cdp.send('Profiler.disable', {}, sid).catch(() => {});
  cpuProfiling = false;
  const path = resolveArtifactPath(filePath || null, 'profiles', `cpu-${timestamp()}.cpuprofile`);
  writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
  return { text: `CPU profile saved to ${path} (${profile.nodes?.length || 0} nodes).`, data: { active: false, nodes: profile.nodes?.length || 0 }, artifacts: [{ type: 'cpu-profile', path }] };
}

async function startHeapSampling(cdp, sid) {
  if (heapSampling) return { text: 'Heap allocation sampling already active.', data: { active: true } };
  await cdp.send('HeapProfiler.enable', {}, sid);
  await cdp.send('HeapProfiler.startSampling', {}, sid);
  heapSampling = true;
  return { text: 'Heap allocation sampling started.', data: { active: true } };
}

async function stopHeapSampling(cdp, sid, filePath) {
  if (!heapSampling) return { text: 'No heap allocation sampling active.', data: { active: false } };
  const { profile } = await cdp.send('HeapProfiler.stopSampling', {}, sid);
  heapSampling = false;
  const path = resolveArtifactPath(filePath || null, 'profiles', `heap-sampling-${timestamp()}.heapprofile`);
  writeFileSync(path, JSON.stringify(profile), { mode: 0o600 });
  return { text: `Heap allocation profile saved to ${path}.`, data: { active: false }, artifacts: [{ type: 'heap-sampling-profile', path }] };
}

function hasPerformanceData(observed, metrics) {
  return observed.vitals.lcp != null || observed.vitals.fcp != null || observed.navigation.ttfb != null || observed.resources > 0 || metrics.Nodes > 0;
}

function renderPerformance(observed, metrics) {
  const { vitals, navigation } = observed;
  const lines = ['## Core Web Vitals'];
  if (vitals.lcp != null) lines.push(`LCP:  ${vitals.lcp}ms${grade(vitals.lcp, 2500, 4000)}`);
  if (vitals.inp != null) lines.push(`INP:  ${vitals.inp}ms${grade(vitals.inp, 200, 500)}`);
  if (vitals.fcp != null) lines.push(`FCP:  ${vitals.fcp}ms${grade(vitals.fcp, 1800, 3000)}`);
  if (vitals.cls != null) lines.push(`CLS:  ${vitals.cls}${grade(vitals.cls, 0.1, 0.25)}`);
  if (navigation.ttfb != null) lines.push(`TTFB: ${navigation.ttfb}ms${grade(navigation.ttfb, 800, 1800)}`);
  lines.push('', '## Responsiveness');
  lines.push(`Long tasks:             ${observed.longTasks.length}`);
  lines.push(`Long animation frames:  ${observed.longAnimationFrames.length}`);
  lines.push(`Layout shifts:          ${observed.layoutShifts.length}`);
  lines.push(`Event timings:          ${observed.eventCount}`);
  lines.push('', '## Navigation Timing');
  if (navigation.domInteractive != null) lines.push(`DOM Interactive:       ${navigation.domInteractive}ms`);
  if (navigation.domContentLoaded != null) lines.push(`DOMContentLoaded:      ${navigation.domContentLoaded}ms`);
  if (navigation.load != null) lines.push(`Load:                  ${navigation.load}ms`);
  lines.push('', '## Resources', `Total requests:  ${observed.resources}`, `Transfer size:   ${formatBytes(observed.transferSize)}`);
  if (metrics.JSHeapUsedSize) lines.push('', '## Memory', `JS Heap Used:  ${formatBytes(metrics.JSHeapUsedSize)}`, `JS Heap Total: ${formatBytes(metrics.JSHeapTotalSize)}`);
  if (metrics.Nodes) lines.push('', '## DOM', `DOM Nodes:     ${metrics.Nodes}`, `Documents:     ${metrics.Documents}`, `Frames:        ${metrics.Frames}`, `Listeners:     ${metrics.JSEventListeners}`);
  return lines.join('\n');
}

function grade(value, good, poor) {
  return value <= good ? ' [GOOD]' : value <= poor ? ' [NEEDS IMPROVEMENT]' : ' [POOR]';
}

function formatBytes(bytes) {
  if (bytes == null) return '?';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
