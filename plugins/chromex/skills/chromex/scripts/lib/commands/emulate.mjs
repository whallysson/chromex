// Device emulation via CDP

const DEVICES = {
  'iphone-14': { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iphone-15-pro': { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'ipad-pro': { width: 1024, height: 1366, deviceScaleFactor: 2, mobile: true, ua: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' },
  'pixel-7': { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  'galaxy-s23': { width: 360, height: 780, deviceScaleFactor: 3, mobile: true, ua: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
  'macbook-air': { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false, ua: '' },
  'desktop-1080p': { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, ua: '' },
  'desktop-4k': { width: 3840, height: 2160, deviceScaleFactor: 1, mobile: false, ua: '' },
};

export async function emulateStr(cdp, sid, device) {
  if (!device) {
    const list = Object.keys(DEVICES).join(', ');
    throw new Error(`Device name required. Available: ${list}, reset`);
  }

  if (device === 'reset') {
    await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sid);
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: '' }, sid);
    return 'Device emulation reset to default.';
  }

  const preset = DEVICES[device.toLowerCase()];
  if (!preset) {
    const list = Object.keys(DEVICES).join(', ');
    throw new Error(`Unknown device: ${device}. Available: ${list}, reset`);
  }

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: preset.width,
    height: preset.height,
    deviceScaleFactor: preset.deviceScaleFactor,
    mobile: preset.mobile,
  }, sid);

  if (preset.ua) {
    await cdp.send('Emulation.setUserAgentOverride', { userAgent: preset.ua }, sid);
  }

  return `Emulating ${device}: ${preset.width}x${preset.height} @${preset.deviceScaleFactor}x${preset.mobile ? ' (mobile)' : ''}`;
}

export async function resizeStr(cdp, sid, widthStr, heightStr, dprStr) {
  const width = parseInt(widthStr);
  const height = parseInt(heightStr);
  if (!width || !height || width < 1 || height < 1) {
    throw new Error('Width and height required (e.g. resize 1280 720)');
  }
  const dpr = dprStr ? parseFloat(dprStr) : 1;

  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: dpr, mobile: false,
  }, sid);

  return `Viewport resized to ${width}x${height} @${dpr}x`;
}
