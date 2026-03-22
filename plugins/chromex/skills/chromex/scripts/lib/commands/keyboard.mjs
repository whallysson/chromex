// Keyboard input: press keys and key combinations via CDP Input.dispatchKeyEvent

// Key name -> { key, code, keyCode } mapping for CDP
const KEY_MAP = {
  enter:      { key: 'Enter',     code: 'Enter',       keyCode: 13 },
  tab:        { key: 'Tab',       code: 'Tab',         keyCode: 9  },
  escape:     { key: 'Escape',    code: 'Escape',      keyCode: 27 },
  backspace:  { key: 'Backspace', code: 'Backspace',   keyCode: 8  },
  delete:     { key: 'Delete',    code: 'Delete',      keyCode: 46 },
  space:      { key: ' ',         code: 'Space',       keyCode: 32 },
  arrowup:    { key: 'ArrowUp',   code: 'ArrowUp',     keyCode: 38 },
  arrowdown:  { key: 'ArrowDown', code: 'ArrowDown',   keyCode: 40 },
  arrowleft:  { key: 'ArrowLeft', code: 'ArrowLeft',   keyCode: 37 },
  arrowright: { key: 'ArrowRight',code: 'ArrowRight',  keyCode: 39 },
  home:       { key: 'Home',      code: 'Home',        keyCode: 36 },
  end:        { key: 'End',       code: 'End',         keyCode: 35 },
  pageup:     { key: 'PageUp',    code: 'PageUp',      keyCode: 33 },
  pagedown:   { key: 'PageDown',  code: 'PageDown',    keyCode: 34 },
  insert:     { key: 'Insert',    code: 'Insert',      keyCode: 45 },
  // Modifier keys (needed for keyDown/keyUp dispatch of modifiers themselves)
  control:    { key: 'Control',   code: 'ControlLeft',  keyCode: 17 },
  ctrl:       { key: 'Control',   code: 'ControlLeft',  keyCode: 17 },
  shift:      { key: 'Shift',     code: 'ShiftLeft',    keyCode: 16 },
  alt:        { key: 'Alt',       code: 'AltLeft',      keyCode: 18 },
  meta:       { key: 'Meta',      code: 'MetaLeft',     keyCode: 91 },
  cmd:        { key: 'Meta',      code: 'MetaLeft',     keyCode: 91 },
  command:    { key: 'Meta',      code: 'MetaLeft',     keyCode: 91 },
};

// F1-F12
for (let i = 1; i <= 12; i++) {
  KEY_MAP[`f${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };
}

// Modifier name -> CDP modifier bitfield
const MODIFIERS = {
  alt: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8,
};

function resolveKey(name) {
  const lower = name.toLowerCase();
  const mapped = KEY_MAP[lower];
  if (mapped) return mapped;

  // Single letter a-z
  if (lower.length === 1 && lower >= 'a' && lower <= 'z') {
    return { key: lower, code: `Key${lower.toUpperCase()}`, keyCode: lower.charCodeAt(0) - 32 };
  }
  // Single digit 0-9
  if (lower.length === 1 && lower >= '0' && lower <= '9') {
    return { key: lower, code: `Digit${lower}`, keyCode: lower.charCodeAt(0) };
  }
  // Single special char (pass through)
  if (name.length === 1) {
    return { key: name, code: '', keyCode: name.charCodeAt(0) };
  }

  throw new Error(`Unknown key: "${name}". Common keys: Enter, Tab, Escape, Backspace, Delete, Space, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, F1-F12, a-z, 0-9`);
}

// Parse "Control+Shift+A" -> { modifiers: 10, modifierNames: [...], key: {...} }
function parseKeyCombo(combo) {
  if (!combo) throw new Error('Key combination required (e.g. "Enter", "Control+A", "Control+Shift+R")');

  // Split on + but handle edge case "Control++" (last + is the key)
  const parts = [];
  let buf = '';
  for (const ch of combo) {
    if (ch === '+' && buf) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) parts.push(buf);

  let modBits = 0;
  const modNames = [];
  const keyParts = [];

  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()];
    if (mod !== undefined) {
      modBits |= mod;
      modNames.push(part);
    } else {
      keyParts.push(part);
    }
  }

  if (keyParts.length === 0) throw new Error(`No key found in combination: "${combo}". Modifiers alone are not valid.`);
  if (keyParts.length > 1) throw new Error(`Multiple non-modifier keys in "${combo}": ${keyParts.join(', ')}. Use only one primary key.`);

  return { modifiers: modBits, modifierNames: modNames, key: resolveKey(keyParts[0]) };
}

// Exported for testing
export { parseKeyCombo };

export async function pressKeyStr(cdp, sid, combo) {
  const { modifiers, modifierNames, key } = parseKeyCombo(combo);

  const base = { modifiers, key: key.key, code: key.code, windowsVirtualKeyCode: key.keyCode };

  // Press modifier keys down
  for (const name of modifierNames) {
    const modKey = resolveKey(name);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: modKey.key, code: modKey.code, modifiers }, sid);
  }

  // Press and release the primary key
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base }, sid);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid);

  // Release modifier keys in reverse order
  for (const name of modifierNames.toReversed()) {
    const modKey = resolveKey(name);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: modKey.key, code: modKey.code, modifiers: 0 }, sid);
  }

  return `Pressed ${combo}`;
}
