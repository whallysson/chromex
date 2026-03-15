// Drag & Drop via Input domain

import { sleep } from '../utils.mjs';
import { evalStr } from './evaluate.mjs';

export async function dragStr(cdp, sid, from, to) {
  if (!from || !to) throw new Error('Usage: drag <target> <from_selector> <to_selector> or drag <target> x1,y1 x2,y2');

  let fromX, fromY, toX, toY;

  // Coordenadas diretas: "100,200"
  if (from.includes(',') && to.includes(',')) {
    [fromX, fromY] = from.split(',').map(Number);
    [toX, toY] = to.split(',').map(Number);
    if (isNaN(fromX) || isNaN(fromY) || isNaN(toX) || isNaN(toY)) {
      throw new Error('Invalid coordinates. Use: x1,y1 x2,y2');
    }
  } else {
    // CSS selectors: resolver para coordenadas centrais
    fromX = await getCenterX(cdp, sid, from);
    fromY = await getCenterY(cdp, sid, from);
    toX = await getCenterX(cdp, sid, to);
    toY = await getCenterY(cdp, sid, to);
  }

  const base = { button: 'left', clickCount: 1, modifiers: 0 };

  // Mouse down no ponto de origem
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', x: fromX, y: fromY }, sid);
  await sleep(100);

  // Mover em passos intermediários para simular arraste real
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const x = fromX + (toX - fromX) * (i / steps);
    const y = fromY + (toY - fromY) * (i / steps);
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', x, y }, sid);
    await sleep(50);
  }

  // Mouse up no destino
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', x: toX, y: toY }, sid);

  return `Dragged from (${Math.round(fromX)},${Math.round(fromY)}) to (${Math.round(toX)},${Math.round(toY)}).`;
}

async function getCenterX(cdp, sid, selector) {
  const raw = await evalStr(cdp, sid, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return Math.round(r.left + r.width / 2);
    })()
  `);
  if (raw === 'null') throw new Error(`Element not found: ${selector}`);
  return parseFloat(raw);
}

async function getCenterY(cdp, sid, selector) {
  const raw = await evalStr(cdp, sid, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    })()
  `);
  if (raw === 'null') throw new Error(`Element not found: ${selector}`);
  return parseFloat(raw);
}
