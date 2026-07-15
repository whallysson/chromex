// Local diagnostics for Chromex browser and CDP connectivity.

import { existsSync } from 'fs';
import { CDP } from '../client.mjs';
import { findDevToolsPortFile, findPipeMarker, getPages, resolveWsUrl } from '../browser.mjs';
import { redactUrl } from '../redaction.mjs';

function status(ok, label, detail) {
  return `${ok ? 'ok' : 'fail'}  ${label}${detail ? `: ${detail}` : ''}`;
}

export async function doctorStr(config) {
  const lines = ['chromex doctor'];
  lines.push(status(true, 'node', process.version));
  lines.push(status(Number(process.versions.node.split('.')[0]) >= 22, 'node>=22', process.versions.node));
  lines.push(status(true, 'platform', `${process.platform} ${process.arch}`));
  lines.push(status(existsSync(config._configDir), 'configDir', config._configDir));
  lines.push(status(existsSync(config._socketDir), 'socketDir', config._socketDir));

  const browserPath = process.env.CHROMEX_BROWSER_PATH;
  if (browserPath) {
    const mustExist = process.platform === 'darwin' || browserPath.includes('/');
    lines.push(status(!mustExist || existsSync(browserPath), 'CHROMEX_BROWSER_PATH', browserPath));
  } else {
    lines.push(status(true, 'CHROMEX_BROWSER_PATH', 'not set'));
  }

  const portFile = findDevToolsPortFile();
  const pipeMarker = findPipeMarker();
  const configured = config.cdpUrl || config.cdpEndpoint || process.env.CHROMEX_CDP_URL || process.env.CHROMEX_CDP_ENDPOINT;
  lines.push(status(Boolean(portFile || pipeMarker || configured), 'endpointDiscovery', portFile || pipeMarker || configured || 'not found'));

  if (process.env.CDP_PORT_FILE) {
    lines.push(status(existsSync(process.env.CDP_PORT_FILE), 'CDP_PORT_FILE', process.env.CDP_PORT_FILE));
  }

  const cdp = new CDP(config.commandTimeout);
  try {
    const wsUrl = await resolveWsUrl(config);
    lines.push(status(true, 'cdpEndpoint', redactUrl(wsUrl).replace(/\/devtools\/browser\/.*/, '/devtools/browser/...')));
    await cdp.connect(wsUrl);
    lines.push(status(true, 'cdpConnect', 'connected'));
    const pages = await getPages(cdp);
    lines.push(status(true, 'pages', String(pages.length)));
    if (pages.length === 0) lines.push('hint: open a page, then run `chromex list`');
  } catch (e) {
    lines.push(status(false, 'cdpConnect', e.message));
    lines.push('hint: run `chromex launch --url https://example.com` or enable remote debugging in chrome://inspect/#remote-debugging');
  } finally {
    try { cdp.close(); } catch { /* Connection may not have opened. */ }
  }

  return lines.join('\n');
}
