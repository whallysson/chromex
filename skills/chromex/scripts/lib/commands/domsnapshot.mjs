// Structured DOM snapshot via DOMSnapshot domain

export async function domsnapshotStr(cdp, sid, includeStyles) {
  const computedStyles = includeStyles
    ? ['display', 'visibility', 'opacity', 'overflow', 'position', 'z-index', 'font-size', 'color', 'background-color']
    : ['display', 'visibility'];

  const snapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
    computedStyles,
    includeDOMRects: true,
    includePaintOrder: true,
  }, sid);

  const { documents, strings } = snapshot;
  if (!documents || documents.length === 0) return 'No DOM snapshot available.';

  const doc = documents[0];
  const nodes = doc.nodes;
  const layout = doc.layout;
  const lines = [];

  // Build layout index by nodeIndex
  const layoutMap = new Map();
  if (layout && layout.nodeIndex && layout.bounds) {
    for (let i = 0; i < layout.nodeIndex.length; i++) {
      const ni = layout.nodeIndex[i];
      const b = layout.bounds[i]; // Each bounds is [x, y, w, h]
      if (Array.isArray(b) && b.length >= 4) {
        layoutMap.set(ni, { bounds: b });
      }
    }
  }

  // Build indented tree
  const parentIndex = nodes.parentIndex || [];
  const nodeNames = nodes.nodeName || [];
  const nodeValues = nodes.nodeValue || [];
  const attrs = nodes.attributes || [];

  // Calcular profundidade
  const depth = new Array(nodeNames.length).fill(0);
  for (let i = 1; i < nodeNames.length; i++) {
    if (parentIndex[i] >= 0) depth[i] = depth[parentIndex[i]] + 1;
  }

  for (let i = 0; i < nodeNames.length; i++) {
    const name = strings[nodeNames[i]] || '';
    if (!name || name === '#document' || name === '#comment') continue;

    const indent = '  '.repeat(Math.min(depth[i], 8));
    const lay = layoutMap.get(i);

    if (name === '#text') {
      const text = strings[nodeValues[i]] || '';
      if (text.trim()) {
        lines.push(`${indent}"${text.trim().substring(0, 80)}"`);
      }
      continue;
    }

    // Atributos do nó
    const nodeAttrs = attrs[i] || [];
    let attrStr = '';
    for (let a = 0; a < nodeAttrs.length; a += 2) {
      const attrName = strings[nodeAttrs[a]] || '';
      const attrVal = strings[nodeAttrs[a + 1]] || '';
      if (['id', 'class', 'name', 'type', 'href', 'src', 'role'].includes(attrName) && attrVal) {
        attrStr += ` ${attrName}="${attrVal.substring(0, 40)}"`;
      }
    }

    let line = `${indent}<${name.toLowerCase()}${attrStr}>`;

    // Adicionar bounding rect se disponível
    if (lay?.bounds) {
      const [x, y, w, h] = lay.bounds;
      line += `  [${Math.round(x)},${Math.round(y)} ${Math.round(w)}x${Math.round(h)}]`;
    }

    lines.push(line);
  }

  return lines.join('\n');
}
