// Scroll controlado

import { evalStr } from './evaluate.mjs';

export async function scrollStr(cdp, sid, direction, amountOrSelector) {
  if (!direction) throw new Error('Direction required: up, down, top, bottom, to');

  switch (direction.toLowerCase()) {
    case 'down': {
      const px = parseInt(amountOrSelector) || 500;
      await evalStr(cdp, sid, `window.scrollBy(0, ${px})`);
      const pos = await evalStr(cdp, sid, 'Math.round(window.scrollY)');
      return `Scrolled down ${px}px (position: ${pos}px)`;
    }
    case 'up': {
      const px = parseInt(amountOrSelector) || 500;
      await evalStr(cdp, sid, `window.scrollBy(0, -${px})`);
      const pos = await evalStr(cdp, sid, 'Math.round(window.scrollY)');
      return `Scrolled up ${px}px (position: ${pos}px)`;
    }
    case 'top':
      await evalStr(cdp, sid, 'window.scrollTo(0, 0)');
      return 'Scrolled to top';
    case 'bottom':
      await evalStr(cdp, sid, 'window.scrollTo(0, document.documentElement.scrollHeight)');
      return 'Scrolled to bottom';
    case 'to': {
      if (!amountOrSelector) throw new Error('CSS selector required for "scroll to"');
      const result = await evalStr(cdp, sid, `
        (function() {
          const el = document.querySelector(${JSON.stringify(amountOrSelector)});
          if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(amountOrSelector)} };
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 50) };
        })()
      `);
      const r = JSON.parse(result);
      if (!r.ok) throw new Error(r.error);
      return `Scrolled to <${r.tag}> "${r.text}"`;
    }
    default:
      throw new Error(`Unknown scroll direction: ${direction}. Use: up, down, top, bottom, to`);
  }
}
