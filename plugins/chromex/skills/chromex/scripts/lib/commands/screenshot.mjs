// Screenshot (viewport + full page)

import { writeFileSync } from 'fs';
import { evalStr } from './evaluate.mjs';

export async function shotStr(cdp, sid, filePath, fullPage = false, config, options = {}) {
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

  const format = options.format || 'png';
  const screenshotParams = { format };
  if (format !== 'png' && options.quality != null) {
    screenshotParams.quality = Math.min(100, Math.max(0, options.quality));
  }

  // Element screenshot by ref: clip to element bounding box
  if (options.refMap && options.refNum != null) {
    await cdp.send('DOM.enable', {}, sid);
    const ref = options.refMap.get(options.refNum);
    if (!ref) throw new Error(`Ref @e${options.refNum} not found. Run "snap --refs" first.`);
    if (!ref.backendNodeId) throw new Error(`Ref @e${options.refNum} has no DOM node.`);
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: ref.backendNodeId }, sid);
    const q = model.border; // border quad gives visual bounds including border
    const xs = [q[0], q[2], q[4], q[6]];
    const ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    screenshotParams.clip = {
      x, y,
      width: Math.max(...xs) - x,
      height: Math.max(...ys) - y,
      scale: 1,
    };
  } else if (fullPage) {
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

  // Determine output extension based on format
  const ext = format === 'jpeg' ? '.jpg' : `.${format}`;
  const defaultPath = `/tmp/screenshot${ext}`;
  const out = filePath || config?.defaultScreenshotPath || defaultPath;
  writeFileSync(out, Buffer.from(data, 'base64'));

  const lines = [out];
  const mode = options.refNum != null ? ` (element @e${options.refNum})` : fullPage ? ' (full page)' : ' (viewport only)';
  lines.push(`Screenshot saved${mode}. Format: ${format}. DPR: ${dpr}`);
  if (!fullPage) {
    lines.push(`Coordinate mapping: CSS px = screenshot px / ${dpr}`);
    lines.push(`  e.g. screenshot (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) -> clickxy <target> 100 200`);
    if (dpr !== 1) {
      lines.push(`  On this ${dpr}x display: CSS px = screenshot px * ${Math.round(100 / dpr) / 100}`);
    }
  }
  return lines.join('\n');
}
