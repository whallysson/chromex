// Script injection via Page domain (runs before page scripts on every navigation)

import { readFileSync, existsSync } from 'fs';

// Mantido em memória no daemon via closure no handleCommand
const injectedScripts = new Map();

export async function injectStr(cdp, sid, action, arg) {
  if (!action) throw new Error('Usage: inject <target> <script> | --file <path> | --remove <id> | --list');

  if (action === '--list') {
    if (injectedScripts.size === 0) return 'No injected scripts.';
    return Array.from(injectedScripts.entries())
      .map(([id, snippet]) => `${id}  ${snippet}`)
      .join('\n');
  }

  if (action === '--remove') {
    if (!arg) throw new Error('Script identifier required');
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: arg }, sid);
    injectedScripts.delete(arg);
    return `Removed injected script ${arg}.`;
  }

  let source;
  if (action === '--file') {
    if (!arg) throw new Error('File path required');
    if (!existsSync(arg)) throw new Error(`File not found: ${arg}`);
    source = readFileSync(arg, 'utf8');
  } else {
    // action é o próprio script (pode ter arg como continuação)
    source = arg ? `${action} ${arg}` : action;
  }

  await cdp.send('Page.enable', {}, sid);
  const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sid);
  injectedScripts.set(identifier, source.substring(0, 60) + (source.length > 60 ? '...' : ''));
  return `Script injected (id: ${identifier}). Runs on every new document load.`;
}
