// Geolocation, timezone, and locale override via Emulation domain

export async function geoStr(cdp, sid, lat, lon, accuracy) {
  if (lat === 'reset') {
    await cdp.send('Emulation.clearGeolocationOverride', {}, sid);
    return 'Geolocation override cleared.';
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);
  if (isNaN(latitude) || isNaN(longitude)) {
    throw new Error('Usage: geo <target> <latitude> <longitude> [accuracy] | reset');
  }

  await cdp.send('Emulation.setGeolocationOverride', {
    latitude, longitude, accuracy: parseFloat(accuracy) || 100,
  }, sid);
  return `Geolocation set to (${latitude}, ${longitude}).`;
}

export async function timezoneStr(cdp, sid, tz) {
  if (!tz || tz === 'reset') {
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: '' }, sid);
    return 'Timezone override cleared.';
  }
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: tz }, sid);
  return `Timezone set to ${tz}.`;
}

export async function localeStr(cdp, sid, locale) {
  if (!locale || locale === 'reset') {
    await cdp.send('Emulation.setLocaleOverride', { locale: '' }, sid);
    return 'Locale override cleared.';
  }
  await cdp.send('Emulation.setLocaleOverride', { locale }, sid);
  return `Locale set to ${locale}.`;
}
