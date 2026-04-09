// Standardized output helpers: empty states, aggregates, indentation.
// Pure functions, zero deps. Shared by commands and hints.

/**
 * Render a standardized empty state for a given domain.
 * Used to distinguish "no results" from "silent failure" so agents
 * do not retry commands hoping for different output.
 *
 * @param {string} domain - command or data domain (e.g. 'network', 'console')
 * @param {string} [msg='empty'] - human-readable reason
 * @returns {string}
 *
 * @example
 *   emptyState('network', '0 requests captured')
 *   // => 'network: 0 requests captured'
 */
export function emptyState(domain, msg = 'empty') {
  return `${domain}: ${msg}`;
}

/**
 * Render an aggregate header with count and optional key:value metadata.
 * Embeds totals/counters into the first line of output so agents do not
 * need a follow-up command just to ask "how many?".
 *
 * @param {string} domain
 * @param {number} count
 * @param {Object<string, string|number>} [meta]
 * @returns {string}
 *
 * @example
 *   aggregate('network', 47, { errors: 3, pending: 0 })
 *   // => 'network[47] errors:3 pending:0'
 */
export function aggregate(domain, count, meta) {
  const header = `${domain}[${count}]`;
  if (!meta) return header;
  const parts = Object.entries(meta).map(([k, v]) => `${k}:${v}`);
  if (parts.length === 0) return header;
  return `${header} ${parts.join(' ')}`;
}

/**
 * Format a byte count into a human-readable string (B / KB / MB / GB).
 * Keeps one decimal place above 1KB. Returns '?' for null/undefined.
 *
 * @param {number|null|undefined} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes == null) return '?';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

/**
 * Indent every non-empty line of a block by `level` (2 spaces per level).
 * Empty lines are preserved as empty (no trailing whitespace).
 *
 * @param {string} text
 * @param {number} [level=1]
 * @returns {string}
 */
export function indent(text, level = 1) {
  if (!text) return '';
  if (level <= 0) return text;
  const pad = '  '.repeat(level);
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : pad + line))
    .join('\n');
}
