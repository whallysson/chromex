// Session analytics: local telemetry for developers
// Tracks command counts, timing, errors, and session timeline

import { writeFileSync } from 'fs';
import { emptyState } from '../output.mjs';

export class SessionStats {
  constructor() {
    this.commands = new Map(); // cmd -> { count, totalMs, errors }
    this.timeline = []; // { cmd, args, startMs, endMs, ok, error }
    this.startTime = Date.now();
  }

  record(cmd, args, startMs, endMs, ok, error) {
    const entry = this.commands.get(cmd) || { count: 0, totalMs: 0, errors: 0 };
    entry.count++;
    entry.totalMs += (endMs - startMs);
    if (!ok) entry.errors++;
    this.commands.set(cmd, entry);

    this.timeline.push({
      cmd, args: args.slice(0, 3), // Truncate args for privacy
      startMs, endMs, duration: endMs - startMs,
      ok, error: error?.substring(0, 100),
    });
  }
}

export function statsStr(stats, full = false, exportPath = null) {
  if (!stats) return emptyState('stats', 'no stats available');

  const lines = [];
  const uptime = ((Date.now() - stats.startTime) / 1000).toFixed(0);
  const totalCmds = [...stats.commands.values()].reduce((s, e) => s + e.count, 0);
  const totalErrors = [...stats.commands.values()].reduce((s, e) => s + e.errors, 0);

  if (totalCmds === 0) return emptyState('stats', `no commands executed yet (uptime: ${uptime}s)`);

  lines.push(`Session Stats (uptime: ${uptime}s, commands: ${totalCmds}, errors: ${totalErrors})`);
  lines.push('');

  // Command breakdown table
  if (stats.commands.size > 0) {
    lines.push('Command Breakdown:');
    const sorted = [...stats.commands.entries()].sort((a, b) => b[1].count - a[1].count);
    for (const [cmd, data] of sorted) {
      const avg = data.count > 0 ? Math.round(data.totalMs / data.count) : 0;
      const errStr = data.errors > 0 ? ` (${data.errors} errors)` : '';
      lines.push(`  ${cmd.padEnd(15)} ${String(data.count).padStart(4)}x  avg: ${String(avg).padStart(5)}ms${errStr}`);
    }
    lines.push('');
  }

  // Timeline (last 20 or all if --full)
  const entries = full ? stats.timeline : stats.timeline.slice(-20);
  if (entries.length > 0) {
    const label = full ? 'Full Timeline' : `Recent Actions (last ${entries.length} of ${stats.timeline.length})`;
    lines.push(`${label}:`);
    for (const e of entries) {
      const ts = new Date(e.startMs).toISOString().substring(11, 19);
      const status = e.ok ? 'OK' : 'ERR';
      const dur = `${e.duration}ms`.padStart(7);
      lines.push(`  [${ts}] ${status} ${dur} ${e.cmd} ${e.args.join(' ').substring(0, 40)}`);
    }
  }

  // Export to file
  if (exportPath) {
    const data = {
      sessionStart: new Date(stats.startTime).toISOString(),
      uptime: parseInt(uptime),
      totalCommands: totalCmds,
      totalErrors,
      commands: Object.fromEntries(stats.commands),
      timeline: stats.timeline,
    };
    writeFileSync(exportPath, JSON.stringify(data, null, 2));
    lines.push('');
    lines.push(`Exported to: ${exportPath}`);
  }

  return lines.join('\n');
}
