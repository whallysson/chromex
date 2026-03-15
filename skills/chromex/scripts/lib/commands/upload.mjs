// File upload via DOM domain

import { existsSync } from 'fs';
import { resolve } from 'path';
import { evalStr } from './evaluate.mjs';

export async function uploadStr(cdp, sid, selector, ...filePaths) {
  if (!selector) throw new Error('CSS selector required');
  if (filePaths.length === 0) throw new Error('At least one file path required');

  // Validar que arquivos existem
  const resolvedPaths = filePaths.map(f => resolve(f));
  for (const fp of resolvedPaths) {
    if (!existsSync(fp)) throw new Error(`File not found: ${fp}`);
  }

  // Encontrar o backendNodeId do input
  await cdp.send('DOM.enable', {}, sid);
  const { root } = await cdp.send('DOM.getDocument', {}, sid);
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector,
  }, sid);

  if (!nodeId) throw new Error(`Element not found: ${selector}`);

  const { node } = await cdp.send('DOM.describeNode', { nodeId }, sid);

  await cdp.send('DOM.setFileInputFiles', {
    files: resolvedPaths,
    backendNodeId: node.backendNodeId,
  }, sid);

  // Disparar change event
  await evalStr(cdp, sid, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);

  return `Uploaded ${resolvedPaths.length} file(s) to ${selector}: ${resolvedPaths.map(f => f.split('/').pop()).join(', ')}`;
}
