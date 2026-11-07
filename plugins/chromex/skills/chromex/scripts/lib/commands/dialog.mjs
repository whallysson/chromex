// JavaScript dialogs: per-tab log, auto-accept mode, and answers to the open dialog

import { emptyState, aggregate } from '../output.mjs';
import { redactText, redactUrl } from '../redaction.mjs';

const MAX_DIALOGS = 200;
const REDACTED = '<redacted>';
const USAGE = 'Usage: dialog <target> accept [text] | dismiss | auto [on|off] | log [--limit=N] [--include-sensitive] | clear';
const COMMANDS_FREE_DURING_DIALOG = new Set(['dialog', 'stats', 'open', 'close', 'focus', 'stop', 'list_raw']);
const ACTIONS_FREE_DURING_DIALOG = { console: ['list', 'detail'], evidence: ['', 'status', 'replay'] };

/**
 * Raised on the CDP calls of the running command when a dialog opens and auto mode is off:
 * the page stays paused until the dialog is answered, so the command returns at once instead of timing out.
 */
export class DialogOpenedError extends Error {
  constructor(entry) {
    super(`The page opened ${article(entry.type)} ${entry.type} dialog #${entry.id}: "${shortText(entry.message)}"`);
    this.name = 'DialogOpenedError';
    this.entry = entry;
  }
}

/**
 * @returns {{ auto: boolean, items: object[], nextId: number }} Per-tab dialog state; ids keep growing after clear.
 */
export function createDialogState() {
  return { auto: false, items: [], nextId: 1 };
}

/**
 * Listens for the dialogs of one page session and enables the Page domain right away. Chrome answers
 * through CDP only the dialogs that open while Page is enabled, and Page.enable itself waits behind a
 * dialog that is already open, so it is sent without being awaited.
 */
export function trackDialogs(cdp, sid, state, onChange = () => {}) {
  const ownEvent = message => !message?.sessionId || message.sessionId === sid;
  cdp.onEvent('Page.javascriptDialogOpening', (params, message) => {
    if (ownEvent(message)) onChange(dialogOpened(cdp, sid, state, params));
  });
  cdp.onEvent('Page.javascriptDialogClosed', (params, message) => {
    if (!ownEvent(message)) return;
    const entry = dialogClosed(state, params);
    if (entry) onChange(entry);
  });
  cdp.send('Page.enable', {}, sid).catch(() => {});
}

/**
 * Records a Page.javascriptDialogOpening event, then accepts it in auto mode
 * or frees the commands waiting on the paused page through cdp.rejectSession.
 */
export function dialogOpened(cdp, sid, state, params = {}, now = Date.now()) {
  const type = params.type || 'alert';
  const entry = {
    id: state.nextId++,
    type,
    message: String(params.message ?? ''),
    defaultPrompt: type === 'prompt' ? String(params.defaultPrompt ?? '') : null,
    url: String(params.url ?? ''),
    frameId: params.frameId ?? null,
    openedAt: new Date(now).toISOString(),
    closedAt: null,
    result: 'open',
    handledBy: null,
    userInput: null,
  };
  state.items.push(entry);
  if (state.items.length > MAX_DIALOGS) state.items.splice(0, state.items.length - MAX_DIALOGS);
  if (state.auto) answerDialog(cdp, sid, state, entry, true, entry.defaultPrompt ?? '', 'auto').catch(() => {});
  else cdp.rejectSession?.(sid, new DialogOpenedError(entry));
  return entry;
}

export function dialogClosed(state, params = {}, now = Date.now()) {
  const entry = latestOpenDialog(state, params.frameId);
  if (!entry) return null;
  entry.result = params.result ? 'accepted' : 'dismissed';
  entry.closedAt = new Date(now).toISOString();
  entry.handledBy ??= 'browser';
  if (entry.type === 'prompt' && params.result) entry.userInput = String(params.userInput ?? '');
  return entry;
}

export async function dialogStr(cdp, sid, state, action, args = []) {
  const normalized = String(action || '').toLowerCase();
  if (normalized === 'accept' || normalized === 'dismiss') return answerOpenDialog(cdp, sid, state, normalized === 'accept', args);
  if (normalized === 'auto') return setAutoMode(cdp, sid, state, args[0]);
  if (normalized === 'log') return dialogLog(state, logOptions(args));
  if (normalized === 'clear') {
    const count = state.items.length;
    state.items.length = 0;
    return { text: `Dialog log cleared (${count} ${count === 1 ? 'entry' : 'entries'}).`, data: { cleared: count } };
  }
  throw new Error(USAGE);
}

/**
 * Fails fast when an unanswered dialog pauses the page: commands that need the renderer
 * would otherwise wait for the full CDP timeout. Dialog, browser-level and in-memory commands still run.
 */
export function ensureNoOpenDialog(state, cmd, args = []) {
  const entry = blockingDialog(state);
  if (!entry || COMMANDS_FREE_DURING_DIALOG.has(cmd)) return;
  if (ACTIONS_FREE_DURING_DIALOG[cmd]?.includes(String(args[0] || '').toLowerCase())) return;
  throw new Error(`Dialog #${entry.id} (${entry.type}) is open and pauses the page: "${shortText(entry.message)}". ${answerHint(entry)} Or run "chromex dialog <t> auto" to accept dialogs as they open.`);
}

export function pausedByDialog(cmd, error) {
  const { entry } = error;
  return {
    text: `${cmd} opened ${article(entry.type)} ${entry.type} dialog #${entry.id}: "${shortText(entry.message)}". The page waits until it is answered. ${answerHint(entry)}`,
    data: { paused: true, dialog: publicDialog(entry) },
  };
}

/**
 * @returns {{ text: string, dialogs: object[] } | null} Dialogs opened since firstId, for the command that was running.
 */
export function dialogNotes(state, firstId) {
  const entries = state.items.filter(entry => entry.id >= firstId);
  if (!entries.length) return null;
  const lines = [`${aggregate('dialogs', entries.length)}:`];
  for (const entry of entries) lines.push(`  #${entry.id} ${entry.type} "${shortText(entry.message)}" ${outcome(entry)}`);
  const open = entries.findLast(entry => entry.result === 'open' && !entry.handledBy);
  if (open) lines.push(`Dialog #${open.id} is still open and pauses the page. ${answerHint(open)}`);
  return { text: lines.join('\n'), dialogs: entries.map(entry => publicDialog(entry)) };
}

/**
 * Copy safe for output and evidence: secret-shaped text and URL values are masked,
 * and prompt answers are hidden unless includeSensitive is set.
 */
export function publicDialog(entry, options = {}) {
  const includeSensitive = !!options.includeSensitive;
  const hiddenInput = entry.userInput ? REDACTED : entry.userInput;
  return {
    ...entry,
    message: redactText(entry.message, { includeSensitive, maxLength: 2000 }),
    defaultPrompt: entry.defaultPrompt == null ? null : redactText(entry.defaultPrompt, { includeSensitive, maxLength: 500 }),
    url: entry.url ? redactUrl(entry.url, { includeSensitive }) : '',
    userInput: includeSensitive ? entry.userInput : hiddenInput,
  };
}

async function answerOpenDialog(cdp, sid, state, accept, args) {
  const entry = latestOpenDialog(state);
  const text = args.length ? args.join(' ') : undefined;
  await answerDialog(cdp, sid, state, entry, accept, accept ? text ?? entry?.defaultPrompt ?? '' : undefined, 'command');
  const verb = accept ? 'accepted' : 'dismissed';
  const subject = entry ? `: ${entry.type} #${entry.id} "${shortText(entry.message)}"` : '';
  const answer = accept && text !== undefined ? ` with text "${text}"` : '';
  return { text: `Dialog ${verb}${subject}${answer}.`, data: { action: verb, dialog: entry ? publicDialog(entry) : null } };
}

async function answerDialog(cdp, sid, state, entry, accept, promptText, handledBy) {
  if (entry) entry.handledBy = handledBy;
  try {
    await cdp.send('Page.handleJavaScriptDialog', accept ? { accept: true, promptText } : { accept: false }, sid);
  } catch (error) {
    if (entry?.result === 'open') entry.handledBy = null;
    if (!/no dialog is showing/i.test(error.message)) throw error;
    const closedAt = new Date().toISOString();
    for (const item of state.items) {
      if (item.result !== 'open') continue;
      item.result = 'unknown';
      item.closedAt = closedAt;
      item.handledBy = null;
    }
    throw new Error('No dialog is showing. Run "chromex dialog <t> log" to see the recorded dialogs.');
  }
}

async function setAutoMode(cdp, sid, state, value) {
  const mode = String(value || 'on').toLowerCase();
  if (mode !== 'on' && mode !== 'off') throw new Error(USAGE);
  state.auto = mode === 'on';
  if (!state.auto) {
    return { text: 'Auto-dialog off: new dialogs stay open until "dialog accept" or "dialog dismiss".', data: { auto: false } };
  }
  const pending = blockingDialog(state);
  const accepted = pending
    ? await answerDialog(cdp, sid, state, pending, true, pending.defaultPrompt ?? '', 'auto').then(() => pending, () => null)
    : null;
  const note = accepted ? `\nAccepted the open ${accepted.type} #${accepted.id} "${shortText(accepted.message)}".` : '';
  return {
    text: `Auto-dialog on: dialogs are accepted as they open and recorded in "dialog log".${note}`,
    data: { auto: true, accepted: accepted ? publicDialog(accepted) : null },
  };
}

function dialogLog(state, options) {
  const total = state.items.length;
  const base = { total, auto: state.auto, sensitiveIncluded: options.includeSensitive };
  if (!total) {
    return { text: `${emptyState('dialogs', '0 dialogs captured since daemon started')} (auto:${state.auto ? 'on' : 'off'})`, data: { ...base, dialogs: [], open: null } };
  }
  const counts = {};
  for (const entry of state.items) counts[entry.type] = (counts[entry.type] || 0) + 1;
  const open = blockingDialog(state);
  const entries = state.items.slice(-options.limit);
  const header = aggregate('dialogs', total, { ...counts, ...(open ? { open: 1 } : {}), auto: state.auto ? 'on' : 'off' });
  const rows = entries.map(entry => logRow(entry, options));
  const shown = entries.length < total ? `\n(showing last ${entries.length} of ${total})` : '';
  const hint = open ? `\nDialog #${open.id} is open and pauses the page. ${answerHint(open)}` : '';
  return {
    text: `${header}\n${rows.join('\n')}${shown}${hint}`,
    data: { ...base, dialogs: entries.map(entry => publicDialog(entry, options)), open: open ? publicDialog(open, options) : null },
  };
}

function logRow(entry, options) {
  const view = publicDialog(entry, options);
  const time = entry.openedAt.slice(11, 23);
  const prompt = entry.type === 'prompt'
    ? `${view.defaultPrompt ? ` default "${view.defaultPrompt}"` : ''}${view.userInput != null ? ` -> "${view.userInput}"` : ''}`
    : '';
  return `[${entry.id}] ${time} ${entry.type.toUpperCase().padEnd(7)} ${outcome(entry).padEnd(19)} "${view.message.slice(0, 200)}"${prompt}`;
}

function logOptions(args) {
  const limit = args.find(arg => arg.startsWith('--limit='))?.slice('--limit='.length);
  return {
    includeSensitive: args.includes('--include-sensitive'),
    limit: Math.max(1, Math.min(MAX_DIALOGS, Number(limit) || 50)),
  };
}

function blockingDialog(state) {
  return state.items.findLast(entry => entry.result === 'open' && !entry.handledBy) || null;
}

function latestOpenDialog(state, frameId = null) {
  return state.items.findLast(entry => entry.result === 'open' && (!frameId || !entry.frameId || entry.frameId === frameId)) || null;
}

function outcome(entry) {
  if (entry.result === 'open') return 'open';
  return entry.handledBy ? `${entry.result} (${entry.handledBy})` : entry.result;
}

function answerHint(entry) {
  if (entry.type === 'alert') return 'Close it with "chromex dialog <t> accept".';
  const accept = entry.type === 'prompt' ? 'chromex dialog <t> accept <text>' : 'chromex dialog <t> accept';
  return `Answer it with "${accept}" or "chromex dialog <t> dismiss".`;
}

function shortText(value) {
  return redactText(value, { maxLength: 200 });
}

function article(type) {
  return /^[aeiou]/i.test(type) ? 'an' : 'a';
}
