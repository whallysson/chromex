// Contextual next-step hints generator.
// Pure function, zero deps. Consumes refMap + last action context
// and produces up to MAX_HINTS suggestions of "what to do next".
//
// Design notes:
//   - Hints always use a <t> placeholder for target because the daemon
//     does not know the CLI prefix the agent is using.
//   - Heuristic is deliberately simple: bucket refs by role, then pick
//     based on the last command. More sophisticated ranking can come
//     later if measurement shows it matters.
//   - After `fill`, a submit button is the most likely next step, so
//     it gets priority. We fall back to "key Enter" when no submit is
//     visible (common on search boxes).

const SUBMIT_RX = /submit|login|log\s*in|sign\s*in|signin|send|search|go\b|continue|confirm|\bok\b|apply|save|create|next/i;

export const MAX_HINTS = 3;

const INPUT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'slider']);

/**
 * @typedef {Object} Hint
 * @property {string} cmd     - CLI command with <t> placeholder
 * @property {string} comment - Short human-readable context annotation
 */

/**
 * Classify refMap entries by interaction type.
 * Returns buckets preserving original ref order (stable across calls).
 *
 * @param {Map<number, {role: string, name: string}>} refMap
 */
function bucket(refMap) {
  const submitButtons = [];
  const buttons = [];
  const inputs = [];
  const selects = [];
  const links = [];

  for (const [num, ref] of refMap.entries()) {
    const role = (ref.role || '').toLowerCase();
    const name = ref.name || '';
    const entry = { num, name, role };

    if (role === 'button') {
      if (SUBMIT_RX.test(name)) submitButtons.push(entry);
      else buttons.push(entry);
    } else if (INPUT_ROLES.has(role)) {
      inputs.push(entry);
    } else if (role === 'combobox') {
      selects.push(entry);
    } else if (role === 'link') {
      links.push(entry);
    }
  }

  return { submitButtons, buttons, inputs, selects, links };
}

function truncate(s, max = 40) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max) + '...';
}

function commentFor(entry) {
  if (!entry.name) return entry.role;
  return `${entry.role} "${truncate(entry.name)}"`;
}

function clickHint(entry) {
  return { cmd: `chromex click <t> @e${entry.num}`, comment: commentFor(entry) };
}

function fillHint(entry) {
  return { cmd: `chromex fill <t> @e${entry.num} "<value>"`, comment: commentFor(entry) };
}

/**
 * Generate up to MAX_HINTS next-step suggestions based on command context and refMap.
 *
 * @param {Object} ctx
 * @param {string} ctx.cmd                 - Command just executed
 * @param {Map<number, {role,name,backendNodeId}>} ctx.refMap
 * @param {number|null} [ctx.lastFilledRef] - Ref number just filled (flow awareness)
 * @param {boolean} [ctx.hasPage]           - Whether a page/tab is active
 * @returns {Hint[]}
 */
export function generateHints({ cmd, refMap, lastFilledRef = null, hasPage = true }) {
  // No page/tab -> bootstrap hints
  if (!hasPage) {
    return [
      { cmd: 'chromex list', comment: 'see open tabs' },
      { cmd: 'chromex launch', comment: 'start a browser with remote debugging' },
    ];
  }

  // Page exists but no refs assigned -> tell agent to snap --refs first
  if (!refMap || refMap.size === 0) {
    return [
      { cmd: 'chromex snap <t> --refs', comment: 'assign @eN refs to interactive elements' },
    ];
  }

  const buckets = bucket(refMap);
  const { submitButtons, buttons, inputs, links } = buckets;

  // After fill: submit is most likely next step
  if (cmd === 'fill') {
    const hints = [];
    if (submitButtons.length > 0) {
      hints.push(clickHint(submitButtons[0]));
    } else {
      hints.push({ cmd: 'chromex key <t> Enter', comment: 'submit via Enter key' });
    }
    // Next unfilled input keeps the flow going
    const unfilled = inputs.filter((i) => i.num !== lastFilledRef);
    if (unfilled.length > 0 && hints.length < MAX_HINTS) {
      hints.push(fillHint(unfilled[0]));
    }
    return hints.slice(0, MAX_HINTS);
  }

  // After nav: first input is usually the entry point (search, login, etc)
  if (cmd === 'nav' || cmd === 'navigate') {
    const hints = [];
    if (inputs.length > 0) hints.push(fillHint(inputs[0]));
    if (hints.length < MAX_HINTS && submitButtons.length > 0) hints.push(clickHint(submitButtons[0]));
    else if (hints.length < MAX_HINTS && buttons.length > 0) hints.push(clickHint(buttons[0]));
    if (hints.length < MAX_HINTS && links.length > 0) hints.push(clickHint(links[0]));
    return hints.slice(0, MAX_HINTS);
  }

  // Default (snap, click, hover, others): top interactives with non-empty labels
  return topInteractives(buckets, MAX_HINTS);
}

function topInteractives({ submitButtons, buttons, inputs, selects, links }, max) {
  const ordered = [...inputs, ...submitButtons, ...buttons, ...selects, ...links];
  const hints = [];
  for (const entry of ordered) {
    if (hints.length >= max) break;
    if (!entry.name) continue; // skip nameless nodes -- they rarely help the agent
    hints.push(INPUT_ROLES.has(entry.role) ? fillHint(entry) : clickHint(entry));
  }
  return hints;
}

/**
 * Decide whether the daemon's currentRefMap is "fresh" for this command,
 * i.e. safe to feed into generateHints without producing stale @eN pointers.
 *
 * Fresh means a snapshot with refs=true actually ran in THIS command:
 *   - auto-snap fired (shouldSnap && !noSnap) -- daemon always passes refs=true there
 *   - OR explicit `snap` with --refs/-i flag
 *
 * If neither happened, currentRefMap may still hold refs from a prior page
 * (for example after nav --no-snap, or after a bare `snap` without --refs),
 * so hints would point to coordinates that no longer exist in the DOM.
 *
 * This is a pure function so the daemon logic stays testable.
 *
 * @param {Object} ctx
 * @param {string} ctx.cmd
 * @param {boolean} ctx.shouldSnap  - Whether this cmd is in the AUTO_SNAP_CMDS set
 * @param {boolean} ctx.noSnap      - Whether the caller passed --no-snap
 * @param {string[]} ctx.args       - Command args (to detect --refs / -i on snap)
 * @returns {boolean}
 */
export function isRefMapFresh({ cmd, shouldSnap, noSnap, args }) {
  // Auto-snap always uses refs=true in the daemon -- if it ran, refs are fresh.
  if (shouldSnap && !noSnap) return true;
  // Explicit `snap --refs` (or `snap -i` alias) also populates refMap.
  if ((cmd === 'snap' || cmd === 'snapshot') && Array.isArray(args)) {
    if (args.includes('--refs') || args.includes('-i')) return true;
  }
  return false;
}

/**
 * Render an array of hints into the chromex help[] block format.
 * Format mirrors what Claude can parse unambiguously:
 *   help[N]:
 *     chromex <cmd>  # comment
 *
 * @param {Hint[]} hints
 * @returns {string} Empty string when hints is empty/missing.
 */
export function renderHints(hints) {
  if (!hints || hints.length === 0) return '';
  const header = `help[${hints.length}]:`;
  const lines = hints.map((h) => {
    if (h.comment) return `  ${h.cmd}  # ${h.comment}`;
    return `  ${h.cmd}`;
  });
  return `${header}\n${lines.join('\n')}`;
}
