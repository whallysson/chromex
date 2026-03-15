// CSS/JS coverage reporting via Profiler and CSS domains

let active = false;

export async function coverageStr(cdp, sid, action) {
  if (!action) throw new Error('Usage: coverage <target> start | stop');

  switch (action) {
    case 'start': {
      if (active) return 'Coverage collection already active.';
      await cdp.send('DOM.enable', {}, sid);
      await cdp.send('Profiler.enable', {}, sid);
      await cdp.send('Debugger.enable', {}, sid);
      await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true }, sid);
      await cdp.send('CSS.enable', {}, sid);
      await cdp.send('CSS.startRuleUsageTracking', {}, sid);
      active = true;
      return 'Coverage collection started. Navigate/interact, then "coverage <target> stop" for report.';
    }

    case 'stop': {
      if (!active) return 'No coverage collection active.';
      active = false;

      // JS Coverage
      const { result: jsCoverage } = await cdp.send('Profiler.takePreciseCoverage', {}, sid);
      await cdp.send('Profiler.stopPreciseCoverage', {}, sid);
      await cdp.send('Profiler.disable', {}, sid);
      await cdp.send('Debugger.disable', {}, sid);

      // CSS Coverage
      const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking', {}, sid);
      await cdp.send('CSS.disable', {}, sid);

      // JS report
      const jsFiles = [];
      let jsTotalBytes = 0;
      let jsUsedBytes = 0;
      for (const script of jsCoverage) {
        if (!script.url || script.url.startsWith('extensions://')) continue;
        let scriptTotal = 0;
        let scriptUsed = 0;
        for (const fn of script.functions) {
          for (const range of fn.ranges) {
            const size = range.endOffset - range.startOffset;
            scriptTotal += size;
            if (range.count > 0) scriptUsed += size;
          }
        }
        jsTotalBytes += scriptTotal;
        jsUsedBytes += scriptUsed;
        if (scriptTotal > 0) {
          jsFiles.push({
            url: script.url.substring(0, 80),
            total: scriptTotal,
            used: scriptUsed,
            pct: Math.round((scriptUsed / scriptTotal) * 100),
          });
        }
      }

      // CSS report
      const cssUsed = ruleUsage ? ruleUsage.filter(r => r.used).length : 0;
      const cssTotal = ruleUsage ? ruleUsage.length : 0;

      const lines = ['## JavaScript Coverage'];
      lines.push(`Total: ${formatBytes(jsTotalBytes)}, Used: ${formatBytes(jsUsedBytes)} (${jsTotalBytes > 0 ? Math.round((jsUsedBytes / jsTotalBytes) * 100) : 0}%)`);
      lines.push('');

      // Top unused files
      const unused = jsFiles.filter(f => f.pct < 50).sort((a, b) => (a.pct - b.pct));
      if (unused.length > 0) {
        lines.push('Files with <50% usage:');
        for (const f of unused.slice(0, 10)) {
          lines.push(`  ${String(f.pct).padStart(3)}%  ${formatBytes(f.total).padStart(8)}  ${f.url}`);
        }
        lines.push('');
      }

      lines.push('## CSS Coverage');
      lines.push(`Rules: ${cssTotal} total, ${cssUsed} used (${cssTotal > 0 ? Math.round((cssUsed / cssTotal) * 100) : 0}%)`);

      return lines.join('\n');
    }

    default:
      throw new Error('Usage: coverage <target> start | stop');
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
