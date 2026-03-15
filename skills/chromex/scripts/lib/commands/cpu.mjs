// CPU throttling via Emulation domain

export async function cpuStr(cdp, sid, rate) {
  if (!rate || rate === 'reset') {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }, sid);
    return 'CPU throttling reset to normal.';
  }

  const r = parseFloat(rate);
  if (isNaN(r) || r < 1) throw new Error('Rate must be >= 1 (1=normal, 4=4x slower, 6=mobile sim)');

  await cdp.send('Emulation.setCPUThrottlingRate', { rate: r }, sid);
  return `CPU throttled to ${r}x slower.`;
}
