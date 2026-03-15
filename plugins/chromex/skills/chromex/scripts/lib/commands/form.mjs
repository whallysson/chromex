// Form filling: fill, clear, select, check, form (batch)

import { sleep } from '../utils.mjs';
import { evalStr } from './evaluate.mjs';

export async function fillStr(cdp, sid, selector, value) {
  if (!selector) throw new Error('CSS selector required');
  if (value == null) throw new Error('Value required');

  // Focar e limpar o campo
  const info = await evalStr(cdp, sid, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (el.select) el.select();
      return { ok: true, tag: el.tagName, type: el.type || '', name: el.name || '' };
    })()
  `);
  const r = JSON.parse(info);
  if (!r.ok) throw new Error(r.error);

  // Selecionar tudo e deletar (funciona em campos React controlled)
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', modifiers: getModifierKey(),
  }, sid);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0,
  }, sid);
  await sleep(50);

  // Inserir texto
  await cdp.send('Input.insertText', { text: String(value) }, sid);

  // Disparar eventos de mudança para frameworks reativos
  await evalStr(cdp, sid, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);

  return `Filled <${r.tag}${r.name ? ` name="${r.name}"` : ''}> with "${String(value).substring(0, 50)}"`;
}

export async function clearStr(cdp, sid, selector) {
  if (!selector) throw new Error('CSS selector required');

  const info = await evalStr(cdp, sid, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center' });
      el.focus();
      if (el.select) el.select();
      return { ok: true, tag: el.tagName, name: el.name || '' };
    })()
  `);
  const r = JSON.parse(info);
  if (!r.ok) throw new Error(r.error);

  // Selecionar tudo + Delete
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'a', code: 'KeyA', modifiers: getModifierKey(),
  }, sid);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0,
  }, sid);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Delete', code: 'Delete',
  }, sid);
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Delete', code: 'Delete',
  }, sid);

  await evalStr(cdp, sid, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()
  `);

  return `Cleared <${r.tag}${r.name ? ` name="${r.name}"` : ''}>`;
}

export async function selectStr(cdp, sid, selector, value) {
  if (!selector) throw new Error('CSS selector required');
  if (value == null) throw new Error('Value required');

  const result = await evalStr(cdp, sid, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      if (el.tagName !== 'SELECT') return { ok: false, error: 'Element is not a <select>' };
      const val = ${JSON.stringify(String(value))};
      const option = Array.from(el.options).find(o => o.value === val || o.textContent.trim() === val);
      if (!option) {
        const opts = Array.from(el.options).map(o => o.value || o.textContent.trim()).slice(0, 10);
        return { ok: false, error: 'Option not found: ' + val + '. Available: ' + opts.join(', ') };
      }
      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return { ok: true, selected: option.textContent.trim(), value: option.value };
    })()
  `);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `Selected "${r.selected}" (value="${r.value}")`;
}

export async function checkStr(cdp, sid, selector, checked = true) {
  if (!selector) throw new Error('CSS selector required');

  const result = await evalStr(cdp, sid, `
    (function() {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
      const want = ${JSON.stringify(checked)};
      if (el.type !== 'checkbox' && el.type !== 'radio') {
        return { ok: false, error: 'Element is not a checkbox/radio (type: ' + el.type + ')' };
      }
      if (el.checked !== want) {
        el.click();
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ok: true, type: el.type, checked: el.checked, name: el.name || '' };
    })()
  `);
  const r = JSON.parse(result);
  if (!r.ok) throw new Error(r.error);
  return `${r.type} ${r.name ? `"${r.name}" ` : ''}is now ${r.checked ? 'checked' : 'unchecked'}`;
}

export async function formStr(cdp, sid, fieldsJson) {
  let fields;
  try {
    fields = JSON.parse(fieldsJson);
  } catch {
    throw new Error(`Invalid JSON: ${fieldsJson}`);
  }

  const results = [];
  for (const [selector, value] of Object.entries(fields)) {
    if (typeof value === 'boolean') {
      results.push(await checkStr(cdp, sid, selector, value));
    } else {
      results.push(await fillStr(cdp, sid, selector, String(value)));
    }
    await sleep(100); // Pausa entre campos para frameworks reativos
  }
  return results.join('\n');
}

// macOS usa Meta (Cmd), Linux usa Control
function getModifierKey() {
  return process.platform === 'darwin' ? 4 : 2; // 4 = Meta, 2 = Control
}
