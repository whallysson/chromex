// Network throttling via Network domain

const PRESETS = {
  '3g':      { offline: false, latency: 100,  downloadThroughput: 750 * 1024 / 8,  uploadThroughput: 250 * 1024 / 8 },
  'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50 * 1024 / 8,   uploadThroughput: 50 * 1024 / 8 },
  '4g':      { offline: false, latency: 20,   downloadThroughput: 4000 * 1024 / 8,  uploadThroughput: 3000 * 1024 / 8 },
  'offline': { offline: true,  latency: 0,    downloadThroughput: 0,                uploadThroughput: 0 },
};

export async function throttleStr(cdp, sid, preset, ...customArgs) {
  if (!preset || preset === 'reset') {
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }, sid);
    return 'Network throttling reset.';
  }

  if (preset === 'custom') {
    const [latency, down, up] = customArgs.map(Number);
    if (isNaN(latency) || isNaN(down) || isNaN(up)) {
      throw new Error('Usage: throttle <target> custom <latency_ms> <down_kbps> <up_kbps>');
    }
    await cdp.send('Network.enable', {}, sid);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency, downloadThroughput: down * 1024 / 8, uploadThroughput: up * 1024 / 8,
    }, sid);
    return `Network throttled: ${latency}ms latency, ${down}kbps down, ${up}kbps up.`;
  }

  const conditions = PRESETS[preset.toLowerCase()];
  if (!conditions) {
    throw new Error(`Unknown preset: ${preset}. Available: ${Object.keys(PRESETS).join(', ')}, custom, reset`);
  }

  await cdp.send('Network.enable', {}, sid);
  await cdp.send('Network.emulateNetworkConditions', conditions, sid);
  return `Network throttled to ${preset}${conditions.offline ? ' (offline)' : ''}.`;
}
