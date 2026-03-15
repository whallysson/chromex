// Element highlight overlay via Overlay domain

export async function highlightStr(cdp, sid, selectorOrAction) {
  if (!selectorOrAction) throw new Error('Usage: highlight <target> <selector> | clear');

  if (selectorOrAction === 'clear') {
    await cdp.send('Overlay.hideHighlight', {}, sid);
    return 'Highlight cleared.';
  }

  // Encontrar o nodeId do elemento
  await cdp.send('DOM.enable', {}, sid);
  await cdp.send('Overlay.enable', {}, sid);

  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: selectorOrAction,
  }, sid);

  if (!nodeId) throw new Error(`Element not found: ${selectorOrAction}`);

  await cdp.send('Overlay.highlightNode', {
    highlightConfig: {
      contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
      paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
      borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
      marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
      showInfo: true,
      showStyles: true,
    },
    nodeId,
  }, sid);

  return `Highlighting "${selectorOrAction}". Use "highlight <target> clear" to remove.`;
}
