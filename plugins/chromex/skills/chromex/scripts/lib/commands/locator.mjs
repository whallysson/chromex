import { parseRef } from './refs.mjs';

export async function locatorStr(cdp, sid, refMap, target, format = 'chromex-test') {
  const descriptor = await describeTarget(cdp, sid, refMap, target);
  const locator = buildLocator(descriptor, format);
  const stability = locator.stable ? 'stable' : 'fallback';
  return {
    text: `${locator.value}\nlocator: ${stability} (${locator.reason})`,
    data: { locator: locator.value, format, stable: locator.stable, reason: locator.reason, descriptor },
    artifacts: [],
  };
}

export async function actionCodeStr(cdp, sid, refMap, command, target, value) {
  const descriptor = await describeTarget(cdp, sid, refMap, target);
  const locator = buildLocator(descriptor, 'chromex-test');
  const code = buildActionCode(command, locator.value, value);
  return { code, locator };
}

async function describeTarget(cdp, sid, refMap, target) {
  const refNum = parseRef(target);
  if (refNum !== null) {
    const ref = refMap.get(refNum);
    if (!ref) throw new Error(`Ref @e${refNum} not found. Run "snap --refs" first.`);
    if (!ref.backendNodeId) throw new Error(`Ref @e${refNum} has no DOM node.`);
    return describeBackendNode(cdp, sid, ref.backendNodeId, ref);
  }
  return describeSelector(cdp, sid, target);
}

async function describeBackendNode(cdp, sid, backendNodeId, ref) {
  await cdp.send('DOM.enable', {}, sid);
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId }, sid);
  const descriptor = await describeObject(cdp, sid, object.objectId);
  return { ...descriptor, role: descriptor.role || ref.role, accessibleName: descriptor.accessibleName || ref.name };
}

async function describeSelector(cdp, sid, selector) {
  if (!selector) throw new Error('Selector or ref required.');
  const { result } = await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    objectGroup: 'chromex-locator',
  }, sid);
  if (!result?.objectId) throw new Error(`Element not found: ${selector}`);
  const descriptor = await describeObject(cdp, sid, result.objectId);
  return { ...descriptor, css: selector };
}

async function describeObject(cdp, sid, objectId) {
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId,
    returnByValue: true,
    functionDeclaration: `function() {
      const el = this;
      const attr = name => el.getAttribute(name) || '';
      const labels = Array.from(el.labels || []).map(label => label.textContent.trim()).filter(Boolean);
      const text = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
      const testId = attr('data-testid') || attr('data-test-id') || attr('data-cy');
      const css = el.id ? '#' + CSS.escape(el.id) : cssPath(el);
      return {
        tagName: el.tagName.toLowerCase(),
        id: el.id || '',
        nameAttr: attr('name'),
        type: attr('type'),
        role: attr('role'),
        ariaLabel: attr('aria-label'),
        placeholder: attr('placeholder'),
        testId,
        text,
        labels,
        css
      };
      function cssPath(node) {
        const parts = [];
        let current = node;
        while (current && current.nodeType === 1 && parts.length < 5) {
          let part = current.tagName.toLowerCase();
          if (current.id) {
            part += '#' + CSS.escape(current.id);
            parts.unshift(part);
            break;
          }
          const name = current.getAttribute('name');
          if (name) part += '[name="' + cssString(name) + '"]';
          else {
            const parent = current.parentElement;
            if (parent) {
              const same = Array.from(parent.children).filter(child => child.tagName === current.tagName);
              if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(current) + 1) + ')';
            }
          }
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(' > ');
      }
      function cssString(value) {
        return String(value).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
      }
    }`,
  }, sid);
  return result.value;
}

export function buildLocator(descriptor, format = 'chromex-test') {
  const role = normalizeRole(descriptor.role || roleFromTag(descriptor));
  const name = descriptor.accessibleName || descriptor.ariaLabel || descriptor.text || descriptor.placeholder || '';
  const label = descriptor.labels?.[0] || '';

  if (format === 'css') {
    if (descriptor.testId) return { value: `[data-testid="${cssString(descriptor.testId)}"]`, stable: true, reason: 'test id' };
    if (descriptor.id) return { value: `#${cssEscape(descriptor.id)}`, stable: false, reason: 'id selector' };
    if (descriptor.nameAttr) return { value: `${descriptor.tagName}[name="${cssString(descriptor.nameAttr)}"]`, stable: false, reason: 'name selector' };
    return { value: descriptor.css, stable: false, reason: 'css fallback' };
  }

  if (descriptor.testId) return renderLocator(format, 'testId', descriptor.testId, true, 'test id');
  if (role && name) return renderLocator(format, 'role', { role, name }, true, 'role and accessible name');
  if (label) return renderLocator(format, 'label', label, true, 'label text');
  if (descriptor.placeholder) return renderLocator(format, 'placeholder', descriptor.placeholder, true, 'placeholder');
  if (descriptor.id) return renderLocator(format, 'css', `#${cssEscape(descriptor.id)}`, false, 'id selector');
  if (descriptor.nameAttr) return renderLocator(format, 'css', `${descriptor.tagName}[name="${cssString(descriptor.nameAttr)}"]`, false, 'name selector');
  return renderLocator(format, 'css', descriptor.css, false, 'css fallback');
}

function renderLocator(format, kind, value, stable, reason) {
  const prefix = format === 'testing-library' ? 'screen.' : 'page.';
  if (kind === 'testId') return { value: `${prefix}getByTestId(${jsString(value)})`, stable, reason };
  if (kind === 'role') return { value: `${prefix}getByRole(${jsString(value.role)}, { name: ${jsString(value.name)} })`, stable, reason };
  if (kind === 'label') return { value: `${prefix}getByLabel(${jsString(value)})`, stable, reason };
  if (kind === 'placeholder') return { value: `${prefix}getByPlaceholder(${jsString(value)})`, stable, reason };
  return { value: `${prefix}locator(${jsString(value)})`, stable, reason };
}

function buildActionCode(command, locator, value) {
  if (command === 'fill') return `await ${locator}.fill(${jsString(value)});`;
  if (command === 'check') return `await ${locator}.check();`;
  if (command === 'click') return `await ${locator}.click();`;
  return `await ${locator};`;
}

function roleFromTag(descriptor) {
  const tag = descriptor.tagName;
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    if (descriptor.type === 'checkbox') return 'checkbox';
    if (descriptor.type === 'radio') return 'radio';
    if (descriptor.type === 'search') return 'searchbox';
    return 'textbox';
  }
  return '';
}

function normalizeRole(role) {
  if (!role) return '';
  return String(role).replace(/^AX/, '').toLowerCase();
}

function jsString(value) {
  return JSON.stringify(String(value));
}

function cssString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function cssEscape(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`);
}
