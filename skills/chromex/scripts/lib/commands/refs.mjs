// Ref-based element resolution: @e1, @e2... -> backendNodeId -> coordinates/actions

import { sleep } from '../utils.mjs';

// Resolve a ref (@eN) to center coordinates using DOM.getBoxModel
export async function resolveRefToCoords(cdp, sid, refMap, refNum) {
  const ref = refMap.get(refNum);
  if (!ref) throw new Error(`Ref @e${refNum} not found. Run "snap --refs" first to assign refs.`);
  if (!ref.backendNodeId) throw new Error(`Ref @e${refNum} has no DOM node (role: ${ref.role}).`);

  await cdp.send('DOM.enable', {}, sid);
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: ref.backendNodeId }, sid);
  // content quad: [x1,y1, x2,y2, x3,y3, x4,y4] -- use center
  const q = model.content;
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  return { x, y, ref };
}

// Click an element by ref
export async function clickRefStr(cdp, sid, refMap, refNum) {
  const { x, y, ref } = await resolveRefToCoords(cdp, sid, refMap, refNum);
  const base = { x, y, button: 'left', clickCount: 1, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  return `Clicked @e${refNum} [${ref.role}] "${ref.name}" at (${Math.round(x)}, ${Math.round(y)})`;
}

// Hover over an element by ref
export async function hoverRefStr(cdp, sid, refMap, refNum) {
  const { x, y, ref } = await resolveRefToCoords(cdp, sid, refMap, refNum);
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', modifiers: 0,
  }, sid);
  return `Hovering @e${refNum} [${ref.role}] "${ref.name}" at (${Math.round(x)}, ${Math.round(y)})`;
}

// Focus an element by ref (for fill/type)
export async function focusRefStr(cdp, sid, refMap, refNum) {
  const ref = refMap.get(refNum);
  if (!ref) throw new Error(`Ref @e${refNum} not found. Run "snap --refs" first.`);
  if (!ref.backendNodeId) throw new Error(`Ref @e${refNum} has no DOM node.`);

  await cdp.send('DOM.enable', {}, sid);
  await cdp.send('DOM.focus', { backendNodeId: ref.backendNodeId }, sid);
  return ref;
}

// Fill an element by ref
export async function fillRefStr(cdp, sid, refMap, refNum, value) {
  const ref = await focusRefStr(cdp, sid, refMap, refNum);
  // Select all + insert text
  const modKey = process.platform === 'darwin' ? 4 : 2;
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: modKey }, sid);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0 }, sid);
  await sleep(50);
  await cdp.send('Input.insertText', { text: String(value) }, sid);
  return `Filled @e${refNum} [${ref.role}] "${ref.name}" with "${String(value).substring(0, 50)}"`;
}

// Parse @eN from string, returns null if not a ref
export function parseRef(str) {
  if (!str) return null;
  const m = str.match(/^@e(\d+)$/i);
  return m ? parseInt(m[1]) : null;
}
