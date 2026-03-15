// Cookie management via CDP Network domain

import { evalStr } from './evaluate.mjs';

export async function cookiesStr(cdp, sid, action, arg) {
  switch (action) {
    case undefined:
    case 'list': {
      // Obter URL atual para filtrar cookies
      const url = await evalStr(cdp, sid, 'window.location.href');
      await cdp.send('Network.enable', {}, sid);
      const { cookies } = await cdp.send('Network.getCookies', { urls: [url] }, sid);
      await cdp.send('Network.disable', {}, sid);

      if (cookies.length === 0) return 'No cookies found for this page.';

      return cookies.map(c => {
        const flags = [
          c.httpOnly ? 'HttpOnly' : '',
          c.secure ? 'Secure' : '',
          c.sameSite !== 'None' ? `SameSite=${c.sameSite}` : '',
        ].filter(Boolean).join(' ');
        const exp = c.expires > 0
          ? new Date(c.expires * 1000).toISOString().slice(0, 19)
          : 'Session';
        const val = c.value.length > 40 ? c.value.slice(0, 40) + '...' : c.value;
        return `${c.name.padEnd(30)}  ${val.padEnd(44)}  ${exp}  ${flags}`;
      }).join('\n');
    }

    case 'set': {
      if (!arg) throw new Error('Cookie JSON required: {"name":"x","value":"y","domain":".example.com"}');
      let cookie;
      try { cookie = JSON.parse(arg); }
      catch { throw new Error(`Invalid JSON: ${arg}`); }

      if (!cookie.name || cookie.value == null) throw new Error('Cookie must have "name" and "value"');

      // Default domain da página atual
      if (!cookie.domain) {
        const host = await evalStr(cdp, sid, 'window.location.hostname');
        cookie.domain = host;
      }
      if (!cookie.path) cookie.path = '/';

      await cdp.send('Network.enable', {}, sid);
      const result = await cdp.send('Network.setCookie', cookie, sid);
      await cdp.send('Network.disable', {}, sid);

      if (!result.success) throw new Error('Failed to set cookie');
      return `Cookie "${cookie.name}" set on ${cookie.domain}`;
    }

    case 'clear': {
      const url = await evalStr(cdp, sid, 'window.location.href');
      await cdp.send('Network.enable', {}, sid);
      const { cookies } = await cdp.send('Network.getCookies', { urls: [url] }, sid);

      const domain = arg; // Filtro opcional por domínio
      const toDelete = domain
        ? cookies.filter(c => c.domain === domain || c.domain === '.' + domain)
        : cookies;

      for (const c of toDelete) {
        await cdp.send('Network.deleteCookies', {
          name: c.name, domain: c.domain, path: c.path,
        }, sid);
      }
      await cdp.send('Network.disable', {}, sid);

      return `Cleared ${toDelete.length} cookie(s)${domain ? ` for domain ${domain}` : ''}`;
    }

    default:
      throw new Error(`Unknown cookies action: ${action}. Use: list, set, clear`);
  }
}
