export async function inspectStr(cdp, sid, action, selector, filter) {
  const normalized = String(action || 'all').toLowerCase();
  if (!selector) throw new Error('Usage: inspect <target> computed|matched|listeners|box|all <selector> [filter]');
  const nodeId = await resolveNode(cdp, sid, selector);

  if (normalized === 'computed') return computedStyles(cdp, sid, nodeId, selector, filter);
  if (normalized === 'matched') return matchedStyles(cdp, sid, nodeId, selector, filter);
  if (normalized === 'listeners') return eventListeners(cdp, sid, nodeId, selector);
  if (normalized === 'box') return boxModel(cdp, sid, nodeId, selector);
  if (normalized === 'all') {
    const [computed, matched, listeners, box] = await Promise.all([
      computedStyles(cdp, sid, nodeId, selector, filter),
      matchedStyles(cdp, sid, nodeId, selector, filter),
      eventListeners(cdp, sid, nodeId, selector),
      boxModel(cdp, sid, nodeId, selector),
    ]);
    return {
      text: [computed.text, matched.text, listeners.text, box.text].join('\n\n'),
      data: { selector, nodeId, computed: computed.data.computed, matched: matched.data.matched, listeners: listeners.data.listeners, box: box.data.box },
    };
  }
  throw new Error('Usage: inspect <target> computed|matched|listeners|box|all <selector> [filter]');
}

async function resolveNode(cdp, sid, selector) {
  await cdp.send('DOM.enable', {}, sid);
  const { root } = await cdp.send('DOM.getDocument', { depth: 0, pierce: true }, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sid);
  if (!nodeId) throw new Error(`Element not found: ${selector}`);
  return nodeId;
}

async function computedStyles(cdp, sid, nodeId, selector, filter) {
  await cdp.send('CSS.enable', {}, sid);
  const { computedStyle = [] } = await cdp.send('CSS.getComputedStyleForNode', { nodeId }, sid);
  const query = String(filter || '').toLowerCase();
  const properties = computedStyle.filter(item => !query || item.name.toLowerCase().includes(query));
  const lines = [`Computed styles for ${selector} (${properties.length})`];
  for (const item of properties.slice(0, 200)) lines.push(`  ${item.name}: ${item.value}`);
  return { text: lines.join('\n'), data: { selector, nodeId, computed: properties, total: properties.length } };
}

async function matchedStyles(cdp, sid, nodeId, selector, filter) {
  await cdp.send('CSS.enable', {}, sid);
  const result = await cdp.send('CSS.getMatchedStylesForNode', { nodeId }, sid);
  const query = String(filter || '').toLowerCase();
  const rules = (result.matchedCSSRules || []).map(match => ({
    selector: match.rule?.selectorList?.text || '',
    origin: match.rule?.origin || '',
    styleSheetId: match.rule?.styleSheetId || null,
    properties: (match.rule?.style?.cssProperties || [])
      .filter(property => !property.disabled && property.name && (!query || property.name.toLowerCase().includes(query)))
      .map(property => ({ name: property.name, value: property.value, important: !!property.important })),
  })).filter(rule => !query || rule.properties.length);
  const lines = [`Matched styles for ${selector} (${rules.length} rules)`];
  for (const rule of rules.slice(0, 100)) {
    lines.push(`  ${rule.selector || '(inline)'} [${rule.origin}]`);
    for (const property of rule.properties.slice(0, 30)) lines.push(`    ${property.name}: ${property.value}${property.important ? ' !important' : ''}`);
  }
  return { text: lines.join('\n'), data: { selector, nodeId, matched: rules, total: rules.length } };
}

async function eventListeners(cdp, sid, nodeId, selector) {
  const { object } = await cdp.send('DOM.resolveNode', { nodeId }, sid);
  if (!object?.objectId) return { text: `Event listeners for ${selector}: 0`, data: { selector, nodeId, listeners: [] } };
  try {
    const { listeners = [] } = await cdp.send('DOMDebugger.getEventListeners', { objectId: object.objectId, depth: 1, pierce: true }, sid);
    const normalized = listeners.map(listener => ({
      type: listener.type,
      useCapture: !!listener.useCapture,
      passive: !!listener.passive,
      once: !!listener.once,
      scriptId: listener.scriptId,
      lineNumber: listener.lineNumber,
      columnNumber: listener.columnNumber,
    }));
    const lines = [`Event listeners for ${selector}: ${normalized.length}`];
    for (const listener of normalized) lines.push(`  ${listener.type} capture=${listener.useCapture} passive=${listener.passive} once=${listener.once} script=${listener.scriptId}:${(listener.lineNumber ?? 0) + 1}`);
    return { text: lines.join('\n'), data: { selector, nodeId, listeners: normalized } };
  } finally {
    await cdp.send('Runtime.releaseObject', { objectId: object.objectId }, sid).catch(() => {});
  }
}

async function boxModel(cdp, sid, nodeId, selector) {
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId }, sid);
  const box = {
    width: model.width,
    height: model.height,
    content: model.content,
    padding: model.padding,
    border: model.border,
    margin: model.margin,
  };
  return { text: `Box model for ${selector}: ${model.width}x${model.height}`, data: { selector, nodeId, box } };
}
