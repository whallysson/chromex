// Multi-tab management via Target domain

export async function openTabStr(cdp, url) {
  if (!url) throw new Error('URL required');
  const { targetId } = await cdp.send('Target.createTarget', { url });
  return `Opened new tab (targetId: ${targetId.slice(0, 8)}). URL: ${url}`;
}

export async function closeTabStr(cdp, targetPrefix) {
  if (!targetPrefix) throw new Error('Target ID required');
  const targetId = await resolveTarget(cdp, targetPrefix);
  const { success } = await cdp.send('Target.closeTarget', { targetId });
  if (!success) throw new Error(`Failed to close target ${targetId.slice(0, 8)}`);
  return `Closed tab ${targetId.slice(0, 8)}.`;
}

export async function focusTabStr(cdp, targetPrefix) {
  if (!targetPrefix) throw new Error('Target ID required');
  const targetId = await resolveTarget(cdp, targetPrefix);
  await cdp.send('Target.activateTarget', { targetId });
  return `Focused tab ${targetId.slice(0, 8)}.`;
}

async function resolveTarget(cdp, prefix) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const pages = targetInfos.filter(t => t.type === 'page');
  const matches = pages.filter(p => p.targetId.toUpperCase().startsWith(prefix.toUpperCase()));
  if (matches.length === 0) throw new Error(`No target matching prefix "${prefix}"`);
  if (matches.length > 1) throw new Error(`Ambiguous prefix "${prefix}" — matches ${matches.length} targets`);
  return matches[0].targetId;
}
