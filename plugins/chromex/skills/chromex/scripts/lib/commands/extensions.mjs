import { existsSync, statSync } from 'fs';
import { resolveChromexPath } from '../artifacts.mjs';
import { redactObject } from '../redaction.mjs';

const STORAGE_AREAS = new Set(['session', 'local', 'sync', 'managed']);

export async function extensionsStr(cdp, targetId, action = 'list', ...args) {
  const normalized = String(action || 'list').toLowerCase();
  try {
    if (normalized === 'list') return listExtensions(cdp);
    if (normalized === 'install') return installExtension(cdp, args[0], args.includes('--incognito'));
    if (normalized === 'reload') return reloadExtension(cdp, args[0]);
    if (normalized === 'action') return triggerAction(cdp, targetId, args[0]);
    if (normalized === 'uninstall') return uninstallExtension(cdp, args[0]);
    if (normalized === 'targets') return extensionTargets(cdp, args[0]);
    if (normalized.startsWith('storage-')) return extensionStorage(cdp, normalized.slice(8), args);
    throw new Error('Usage: extensions <target> list|install|reload|action|uninstall|targets|storage-get|storage-set|storage-remove|storage-clear [args]');
  } catch (error) {
    if (/Extensions\.|method.*not found|wasn't found|not supported|method not available/i.test(error.message)) {
      throw new Error(`Chrome Extensions CDP operation is unavailable: ${error.message}. Runtime install and uninstall require "chromex launch --extension-tools", which uses trusted pipe transport.`);
    }
    throw error;
  }
}

async function listExtensions(cdp) {
  const { extensions = [] } = await cdp.send('Extensions.getExtensions');
  const lines = [`Extensions: ${extensions.length}`];
  for (const extension of extensions) {
    lines.push(`  ${extension.id} ${extension.enabled === false ? 'disabled' : 'enabled'} ${extension.name || ''} ${extension.version || ''}`.trimEnd());
    if (extension.path) lines.push(`    ${extension.path}`);
  }
  return { text: lines.join('\n'), data: { extensions } };
}

async function installExtension(cdp, pathArg, enableInIncognito) {
  if (!pathArg) throw new Error('Unpacked extension path required.');
  const path = resolveChromexPath(pathArg);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Unpacked extension directory not found: ${path}`);
  const { id } = await cdp.send('Extensions.loadUnpacked', { path, enableInIncognito: !!enableInIncognito });
  return { text: `Extension loaded: ${id}\nPath: ${path}`, data: { id, path, enableInIncognito: !!enableInIncognito } };
}

async function reloadExtension(cdp, id) {
  if (!id) throw new Error('Extension id required.');
  const { extensions = [] } = await cdp.send('Extensions.getExtensions');
  const extension = resolveExtension(extensions, id);
  if (!extension.path) throw new Error(`Extension cannot be reloaded because Chrome did not expose its unpacked path: ${extension.id}`);
  const result = await cdp.send('Extensions.loadUnpacked', { path: extension.path });
  return { text: `Extension reloaded: ${result.id || extension.id}`, data: { id: result.id || extension.id, path: extension.path } };
}

function resolveExtension(extensions, id) {
  const exact = extensions.find(item => item.id === id);
  if (exact) return exact;
  const matches = extensions.filter(item => item.id.startsWith(id));
  if (!matches.length) throw new Error(`Extension not found: ${id}`);
  if (matches.length > 1) throw new Error(`Extension id is ambiguous: ${id}. Matches: ${matches.map(item => item.id).join(', ')}`);
  return matches[0];
}

async function triggerAction(cdp, targetId, id) {
  if (!id) throw new Error('Extension id required.');
  const tabTargetId = await resolveTabTargetId(cdp, targetId);
  await cdp.send('Extensions.triggerAction', { id, targetId: tabTargetId });
  return { text: `Extension action triggered: ${id} on ${targetId.slice(0, 8)}`, data: { id, pageTargetId: targetId, targetId: tabTargetId } };
}

async function resolveTabTargetId(cdp, targetId) {
  const { targetInfos = [] } = await cdp.send('Target.getTargets', { filter: [{}] });
  const selected = targetInfos.find(target => target.targetId === targetId);
  if (selected?.type === 'tab') return targetId;
  if (!selected) throw new Error(`Page target not found: ${targetId}`);

  const candidates = targetInfos.filter(target =>
    target.type === 'tab' &&
    target.browserContextId === selected.browserContextId &&
    target.url === selected.url
  );
  if (candidates.length === 1) return candidates[0].targetId;

  for (const candidate of candidates) {
    let related = false;
    let sessionId;
    const off = cdp.onEvent('Target.attachedToTarget', (params, message) => {
      if (message?.sessionId && sessionId && message.sessionId !== sessionId) return;
      if (params.targetInfo?.targetId === targetId) related = true;
    });
    try {
      ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId: candidate.targetId, flatten: true }));
      await cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{}],
      }, sessionId);
      if (related) return candidate.targetId;
    } finally {
      off();
      if (sessionId) await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
    }
  }

  throw new Error(`Tab target not found for page ${targetId}.`);
}

async function uninstallExtension(cdp, id) {
  if (!id) throw new Error('Extension id required.');
  await cdp.send('Extensions.uninstall', { id });
  return { text: `Extension uninstalled: ${id}`, data: { id } };
}

async function extensionTargets(cdp, id) {
  const { targetInfos = [] } = await cdp.send('Target.getTargets');
  const targets = targetInfos.filter(target => !id || target.url?.startsWith(`chrome-extension://${id}`));
  const lines = [`Extension targets: ${targets.length}`];
  for (const target of targets) lines.push(`  ${target.targetId.slice(0, 8)} ${target.type} ${target.url || target.title || ''}`);
  return { text: lines.join('\n'), data: { targets } };
}

async function extensionStorage(cdp, operation, args) {
  const [id, storageArea, payload] = args;
  if (!id) throw new Error('Extension id required.');
  if (!STORAGE_AREAS.has(storageArea)) throw new Error('Storage area must be session, local, sync, or managed.');
  if (operation === 'get') {
    const includeSensitive = args.includes('--include-sensitive');
    const keys = parseKeys(payload);
    const result = await sendStorageCommand(cdp, id, 'Extensions.getStorageItems', { id, storageArea, ...(keys ? { keys } : {}) });
    const values = redactObject(result.data ?? result.items ?? result, { includeSensitive });
    return { text: JSON.stringify(values, null, 2), data: { id, storageArea, values, sensitiveIncluded: includeSensitive } };
  }
  if (operation === 'set') {
    const values = parseObject(payload, 'Storage values JSON object required.');
    await sendStorageCommand(cdp, id, 'Extensions.setStorageItems', { id, storageArea, values });
    return { text: `Extension storage updated: ${id} ${storageArea}`, data: { id, storageArea, keys: Object.keys(values) } };
  }
  if (operation === 'remove') {
    const keys = parseKeys(payload);
    if (!keys?.length) throw new Error('Storage keys required.');
    await sendStorageCommand(cdp, id, 'Extensions.removeStorageItems', { id, storageArea, keys });
    return { text: `Removed ${keys.length} extension storage key(s): ${id} ${storageArea}`, data: { id, storageArea, keys } };
  }
  if (operation === 'clear') {
    await sendStorageCommand(cdp, id, 'Extensions.clearStorageItems', { id, storageArea });
    return { text: `Extension storage cleared: ${id} ${storageArea}`, data: { id, storageArea } };
  }
  throw new Error(`Unknown extension storage operation: ${operation}`);
}

async function sendStorageCommand(cdp, id, method, params) {
  const { targetInfos = [] } = await cdp.send('Target.getTargets');
  const target = targetInfos.find(item => item.url?.startsWith(`chrome-extension://${id}/`) && ['service_worker', 'background_page', 'page'].includes(item.type));
  if (!target) throw new Error(`No debuggable target found for extension ${id}. Ensure its service worker or extension page is active.`);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  try {
    return await cdp.send(method, params, sessionId);
  } finally {
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

function parseKeys(value) {
  if (!value || value === '--include-sensitive') return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some(key => typeof key !== 'string')) throw new Error();
    return parsed;
  } catch {
    return String(value).split(',').map(key => key.trim()).filter(Boolean);
  }
}

function parseObject(value, message) {
  if (!value) throw new Error(message);
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(message);
  }
}
