const REDACTED = '<redacted>';
const SENSITIVE_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-access-token)$/i;
const SENSITIVE_KEYS = /(pass(word)?|secret|token|api[-_]?key|authorization|credential|cookie|session|private[-_]?key)/i;
const FULLY_SENSITIVE_COMMANDS = new Set(['eval', 'evalraw', 'form', 'inject']);

export function redactCommandArgs(command, args = []) {
  const values = args.map(value => String(value));
  if (FULLY_SENSITIVE_COMMANDS.has(command)) return values.length ? [REDACTED] : [];
  if (command === 'type') return values.length ? [REDACTED] : [];
  if (command === 'fill') return values.length ? [truncate(values[0]), REDACTED] : [];
  if (command === 'dialog') return values.map((value, index) => index === 0 ? truncate(value) : REDACTED);
  if (command === 'cookies' && values[0]?.toLowerCase() === 'set') return [truncate(values[0]), REDACTED];
  if (command === 'extensions' && values[0]?.toLowerCase() === 'storage-set') return values.map((value, index) => index === 3 ? REDACTED : truncate(value));
  if (command === 'third-party' && values[0]?.toLowerCase() === 'execute') return values.map((value, index) => index === 2 ? REDACTED : truncate(value));
  if (command === 'webmcp' && values[0]?.toLowerCase() === 'execute') return values.map((value, index) => index === 2 ? REDACTED : truncate(value));
  if (command === 'intercept') {
    return values.map(value => /^(--body|--header)=/i.test(value) ? `${value.split('=')[0]}=${REDACTED}` : sanitizeValue(value));
  }
  return values.map(sanitizeValue);
}

export function redactHeaders(headers = {}, options = {}) {
  if (options.includeSensitive) return { ...headers };
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [
    name,
    SENSITIVE_HEADERS.test(name) ? REDACTED : sanitizeRaw(value),
  ]));
}

export function redactUrl(value, options = {}) {
  if (options.includeSensitive) return String(value ?? '');
  try {
    const url = new URL(String(value));
    for (const key of url.searchParams.keys()) {
      if (SENSITIVE_KEYS.test(key)) url.searchParams.set(key, REDACTED);
    }
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    return url.toString();
  } catch {
    return sanitizeValue(value);
  }
}

export function redactText(value, options = {}) {
  const text = options.includeSensitive ? String(value ?? '') : sanitizeRaw(value);
  const maxLength = Math.max(1, Number(options.maxLength) || 2000);
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

export function redactObject(value, options = {}) {
  if (options.includeSensitive) return value;
  if (Array.isArray(value)) return value.map(item => redactObject(item, options));
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object') return sanitizeRaw(value);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SENSITIVE_KEYS.test(key) ? REDACTED : redactObject(item, options),
  ]));
}

function sanitizeValue(value) {
  return truncate(sanitizeRaw(value));
}

function sanitizeRaw(value) {
  return String(value ?? '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/([?&](?:password|passwd|secret|token|api[-_]?key|authorization|credential|session)=)[^&#\s]*/gi, `$1${REDACTED}`)
    .replace(/("?[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key|authorization|credential|cookie|session)[A-Za-z0-9_-]*"?\s*[:=]\s*)"?[^",}\s]+"?/gi, `$1${REDACTED}`);
}

function truncate(value) {
  return value.length > 120 ? `${value.slice(0, 120)}...` : value;
}
