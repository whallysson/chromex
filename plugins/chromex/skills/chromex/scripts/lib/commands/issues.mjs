import { emptyState, aggregate } from '../output.mjs';

export async function issuesStr(cdp, sid, state, action = 'list') {
  const normalized = String(action || 'list').toLowerCase();
  if (normalized === 'clear') {
    state.items.length = 0;
    return { text: 'Browser issues cleared.', data: { issues: [] } };
  }
  if (normalized === 'disable') {
    await sendAudits(cdp, sid, 'Audits.disable');
    state.enabled = false;
    return { text: 'Browser issue collection disabled.', data: { enabled: false } };
  }

  await ensureEnabled(cdp, sid, state);

  if (normalized === 'check-forms') {
    const result = await sendAudits(cdp, sid, 'Audits.checkFormsIssues');
    return formatFormIssues(result.formIssues || []);
  }
  if (!['enable', 'list'].includes(normalized)) {
    throw new Error('Usage: issues <target> enable|list|clear|check-forms|disable');
  }
  if (normalized === 'enable') {
    return { text: 'Browser issue collection enabled.', data: { enabled: true, count: state.items.length } };
  }
  return formatIssues(state.items);
}

export function formatIssues(issues) {
  if (!issues.length) return { text: emptyState('issues', '0 issues captured since collection started'), data: { issues: [] } };
  const counts = new Map();
  for (const issue of issues) counts.set(issue.code || 'Unknown', (counts.get(issue.code || 'Unknown') || 0) + 1);
  const lines = [aggregate('issues', issues.length, Object.fromEntries([...counts.entries()].slice(0, 6)))];
  for (const [index, issue] of issues.slice(-50).entries()) {
    const detail = summarizeDetails(issue.details);
    lines.push(`[${Math.max(0, issues.length - 50) + index}] ${issue.code || 'Unknown'}${detail ? `  ${detail}` : ''}`);
  }
  return { text: lines.join('\n'), data: { issues: issues.slice(-50), total: issues.length, counts: Object.fromEntries(counts) } };
}

async function ensureEnabled(cdp, sid, state) {
  if (state.enabled) return;
  await sendAudits(cdp, sid, 'Audits.enable');
  state.enabled = true;
}

async function sendAudits(cdp, sid, method) {
  try {
    return await cdp.send(method, {}, sid);
  } catch (error) {
    if (/wasn't found|not found|unknown method/i.test(error.message)) {
      throw new Error('Audits domain is unavailable in this Chromium build.');
    }
    throw error;
  }
}

function formatFormIssues(formIssues) {
  if (!formIssues.length) return { text: emptyState('form-issues', '0 form issues detected'), data: { formIssues: [] } };
  const lines = [aggregate('form-issues', formIssues.length)];
  for (const [index, issue] of formIssues.entries()) lines.push(`[${index}] ${summarizeDetails(issue)}`);
  return { text: lines.join('\n'), data: { formIssues } };
}

function summarizeDetails(details) {
  if (!details || typeof details !== 'object') return '';
  const entries = Object.entries(details).filter(([, value]) => value != null);
  if (!entries.length) return '';
  const [kind, value] = entries[0];
  if (Array.isArray(value)) return `${kind}:${value.length}`;
  if (typeof value !== 'object') return `${kind}:${String(value).slice(0, 100)}`;
  const fields = Object.entries(value)
    .filter(([, item]) => ['string', 'number', 'boolean'].includes(typeof item))
    .slice(0, 4)
    .map(([key, item]) => `${key}=${String(item).slice(0, 80)}`);
  return `${kind}${fields.length ? ` ${fields.join(' ')}` : ''}`;
}
