// Interação: click, clickxy, type, loadall, waitfor

import { sleep } from '../utils.mjs';
import { evalStr } from './evaluate.mjs';

export async function clickStr(cdp, sid, selector, dbl = false) {
  if (!selector) throw new Error('CSS selector required');
  const dblStr = dbl ? 'true' : 'false';
  const expr = `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.click();
      if (${dblStr}) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
    })()
  `;
  const result = await evalStr(cdp, sid, expr);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  const verb = dbl ? 'Double-clicked' : 'Clicked';
  return `${verb} <${r.tag}> "${r.text}"`;
}

export async function clickXyStr(cdp, sid, x, y, dbl = false) {
  const cx = parseFloat(x);
  const cy = parseFloat(y);
  if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
  const clickCount = dbl ? 2 : 1;
  const base = { x: cx, y: cy, button: 'left', clickCount, modifiers: 0 };
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sid);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
  await sleep(50);
  await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  if (dbl) {
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sid);
    await sleep(50);
    await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sid);
  }
  const verb = dbl ? 'Double-clicked' : 'Clicked';
  return `${verb} at CSS (${cx}, ${cy})`;
}

export async function typeStr(cdp, sid, text) {
  if (text == null || text === '') throw new Error('text required');
  await cdp.send('Input.insertText', { text }, sid);
  return `Typed ${text.length} characters`;
}

export async function loadAllStr(cdp, sid, selector, intervalMs = 1500) {
  if (!selector) throw new Error('CSS selector required');
  let clicks = 0;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists !== 'true') break;
    const clickExpr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      })()
    `;
    const clicked = await evalStr(cdp, sid, clickExpr);
    if (clicked !== 'true') break;
    clicks++;
    await sleep(intervalMs);
  }
  return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
}

export async function waitForStr(cdp, sid, selector, timeoutMs, config) {
  if (!selector) throw new Error('CSS selector required');
  const timeout = timeoutMs || config?.commandTimeout || 15000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const exists = await evalStr(cdp, sid,
      `!!document.querySelector(${JSON.stringify(selector)})`
    );
    if (exists === 'true') {
      const info = await evalStr(cdp, sid, `
        (function() {
          const el = document.querySelector(${JSON.stringify(selector)});
          return { tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
        })()
      `);
      const r = JSON.parse(info);
      return `Found <${r.tag}> "${r.text}" (waited ${Date.now() - deadline + timeout}ms)`;
    }
    await sleep(200);
  }
  throw new Error(`Timeout (${timeout}ms) waiting for selector: ${selector}`);
}
