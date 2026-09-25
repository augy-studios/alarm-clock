// Checks what the app sends before it is stored. Anything that fails throws
// a ValidationError, which the server turns into a 400.

export const MAX_ALARMS = 100;
export const MAX_LABEL = 60;

// The server POSTs to whatever endpoint a subscription names, so only the
// browsers' own push services are accepted. Otherwise anyone could point it at
// an arbitrary URL, including ones inside this VPS.
const PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge on Android, Samsung Internet, Opera
  '.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari, and iOS home screen apps
  '.notify.windows.com', // Edge on Windows
];

const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const FIRE_KEY_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+=*$/;

export class ValidationError extends Error {}

function fail(message) {
  throw new ValidationError(message);
}

export function isId(value) {
  return typeof value === 'string' && ID_RE.test(value);
}

export function parseDevice(body) {
  if (!body || typeof body !== 'object') fail('body must be an object');
  return {
    subscription: parseSubscription(body.subscription),
    timeZone: parseTimeZone(body.timeZone),
    alarms: parseAlarms(body.alarms),
  };
}

export function parseLabel(value) {
  if (value == null) return 'Alarm';
  if (typeof value !== 'string') fail('label must be a string');
  return value.trim().slice(0, MAX_LABEL) || 'Alarm';
}

function parseSubscription(sub) {
  if (!sub || typeof sub !== 'object') fail('subscription is required');

  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    fail('subscription.endpoint must be a URL');
  }
  if (url.protocol !== 'https:') fail('subscription.endpoint must be https');
  const host = url.hostname;
  const known = PUSH_HOSTS.some((h) => (h.startsWith('.') ? host.endsWith(h) : host === h));
  if (!known) fail('subscription.endpoint is not a known push service');

  const { p256dh, auth } = sub.keys ?? {};
  if (typeof p256dh !== 'string' || p256dh.length > 200 || !B64URL_RE.test(p256dh)) fail('bad subscription.keys.p256dh');
  if (typeof auth !== 'string' || auth.length > 100 || !B64URL_RE.test(auth)) fail('bad subscription.keys.auth');

  return { endpoint: url.href, keys: { p256dh, auth } };
}

function parseTimeZone(tz) {
  if (typeof tz !== 'string' || tz.length > 64) fail('timeZone is required');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    fail('timeZone is not a valid IANA time zone');
  }
  return tz;
}

function parseAlarms(list) {
  if (!Array.isArray(list)) fail('alarms must be an array');
  if (list.length > MAX_ALARMS) fail(`at most ${MAX_ALARMS} alarms`);

  return list.map((a) => {
    if (!a || typeof a !== 'object') fail('each alarm must be an object');
    if (!isId(a.id)) fail('alarm.id is invalid');
    if (!Number.isInteger(a.hour) || a.hour < 0 || a.hour > 23) fail('alarm.hour must be 0-23');
    if (!Number.isInteger(a.minute) || a.minute < 0 || a.minute > 59) fail('alarm.minute must be 0-59');

    const days = a.days ?? [];
    if (!Array.isArray(days) || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      fail('alarm.days must be day numbers 0-6');
    }

    const lastFireKey = a.lastFireKey ?? null;
    if (lastFireKey !== null && (typeof lastFireKey !== 'string' || !FIRE_KEY_RE.test(lastFireKey))) {
      fail('alarm.lastFireKey is invalid');
    }

    return {
      id: a.id,
      hour: a.hour,
      minute: a.minute,
      days: [...new Set(days)],
      enabled: a.enabled !== false,
      label: parseLabel(a.label),
      lastFireKey,
    };
  });
}
