// Screenshot (viewport + full page)

import { writeFileSync } from 'fs';
import { evalStr } from './evaluate.mjs';

export async function shotStr(cdp, sid, filePath, fullPage = false, config) {
  let dpr = 1;
  try {
    const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
    dpr = metrics.visualViewport?.clientWidth
      ? metrics.cssVisualViewport?.clientWidth
        ? Math.round((metrics.visualViewport.clientWidth / metrics.cssVisualViewport.clientWidth) * 100) / 100
        : 1
      : 1;
    const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sid).catch(() => ({}));
    if (deviceScaleFactor) dpr = deviceScaleFactor;
  } catch { /* fallback */ }
  if (dpr === 1) {
    try {
      const raw = await evalStr(cdp, sid, 'window.devicePixelRatio');
      const parsed = parseFloat(raw);
      if (parsed > 0) dpr = parsed;
    } catch { /* fallback */ }
  }

  const screenshotParams = { format: 'png' };

  if (fullPage) {
    try {
      const metrics = await cdp.send('Page.getLayoutMetrics', {}, sid);
      const width = metrics.contentSize?.width || metrics.cssContentSize?.width;
      const height = metrics.contentSize?.height || metrics.cssContentSize?.height;
      if (width && height) {
        screenshotParams.clip = { x: 0, y: 0, width, height, scale: 1 };
        screenshotParams.captureBeyondViewport = true;
      }
    } catch { /* fallback para viewport */ }
  }

  const { data } = await cdp.send('Page.captureScreenshot', screenshotParams, sid);
  const out = filePath || config?.defaultScreenshotPath || '/tmp/screenshot.png';
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  lines.push(`Screenshot saved${fullPage ? ' (full page)' : ' (viewport only)'}. DPR: ${dpr}`);
  if (!fullPage) {
    lines.push(`Coordinate mapping: CSS px = screenshot px / ${dpr}`);
    lines.push(`  e.g. screenshot (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) -> clickxy <target> 100 200`);
    if (dpr !== 1) {
      lines.push(`  On this ${dpr}x display: CSS px = screenshot px * ${Math.round(100 / dpr) / 100}`);
    }
  }
  return lines.join('\n');
}
