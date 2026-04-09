// LocalStorage / SessionStorage management

import { evalStr } from './evaluate.mjs';
import { emptyState } from '../output.mjs';

export async function storageStr(cdp, sid, action) {
  switch (action) {
    case 'local': {
      const raw = await evalStr(cdp, sid, `
        JSON.stringify(Object.fromEntries(
          Object.keys(localStorage).map(k => [k, localStorage.getItem(k)?.substring(0, 200)])
        ))
      `);
      const data = JSON.parse(raw);
      const keys = Object.keys(data);
      if (keys.length === 0) return emptyState('storage', 'localStorage is empty');
      return keys.map(k => {
        const v = data[k];
        const val = v && v.length > 80 ? v.slice(0, 80) + '...' : v;
        return `${k.padEnd(40)}  ${val}`;
      }).join('\n');
    }

    case 'session': {
      const raw = await evalStr(cdp, sid, `
        JSON.stringify(Object.fromEntries(
          Object.keys(sessionStorage).map(k => [k, sessionStorage.getItem(k)?.substring(0, 200)])
        ))
      `);
      const data = JSON.parse(raw);
      const keys = Object.keys(data);
      if (keys.length === 0) return emptyState('storage', 'sessionStorage is empty');
      return keys.map(k => {
        const v = data[k];
        const val = v && v.length > 80 ? v.slice(0, 80) + '...' : v;
        return `${k.padEnd(40)}  ${val}`;
      }).join('\n');
    }

    case 'clear': {
      await evalStr(cdp, sid, 'localStorage.clear(); sessionStorage.clear()');
      return 'Cleared localStorage and sessionStorage.';
    }

    default:
      throw new Error(`Unknown storage action: ${action}. Use: local, session, clear`);
  }
}
