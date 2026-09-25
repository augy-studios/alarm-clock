// Alarm Clock push server. Stores each device's alarms and push subscription,
// and sends a Web Push at alarm time so the alarm rings with the app closed.
// See SETUP.md for running it on the VPS.

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import { createStore } from './store.js';
import { startScheduler } from './scheduler.js';
import { ValidationError, isId, parseDevice, parseLabel } from './validate.js';

const {
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
  VAPID_SUBJECT,
  PORT = '8787',
  HOST = '127.0.0.1',
  DATA_FILE = './data/devices.json',
  ALLOWED_ORIGINS = 'https://alarm.uwuapps.org',
} = process.env;

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
  console.error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set. See SETUP.md.');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const SNOOZE_MS = 5 * 60_000;
const MAX_SNOOZES = 10;
const MAX_DEVICES = 50_000;
const MAX_BODY = 32 * 1024;
const RATE_LIMIT = 120; // requests per IP per minute

const origins = new Set(ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean));
const store = createStore(DATA_FILE);

// ---------- Routes ----------

const routes = [
  ['GET', /^\/healthz$/, () => [200, { ok: true, devices: store.size }]],

  ['GET', /^\/v1\/vapid-key$/, () => [200, { publicKey: VAPID_PUBLIC_KEY }]],

  // Replace a device's subscription and alarm list. The reply lists when the
  // server last fired each alarm, so a page that was closed at the time can
  // catch up (see applyServerFires in main-site/script.js).
  ['PUT', /^\/v1\/devices\/([^/]+)$/, async (req, id) => {
    if (!isId(id)) return [400, { error: 'bad device id' }];
    if (!store.has(id) && store.size >= MAX_DEVICES) return [503, { error: 'server full' }];

    const incoming = parseDevice(await readJson(req));
    const previous = store.get(id);
    const alarms = incoming.alarms.map((a) => mergeFired(a, previous?.alarms.find((p) => p.id === a.id)));

    store.set(id, {
      ...incoming,
      alarms,
      snoozes: previous?.snoozes ?? [],
      updatedAt: Date.now(),
    });

    const fired = Object.fromEntries(alarms.filter((a) => a.lastFireKey).map((a) => [a.id, a.lastFireKey]));
    return [200, { fired }];
  }],

  ['DELETE', /^\/v1\/devices\/([^/]+)$/, (req, id) => {
    if (!isId(id)) return [400, { error: 'bad device id' }];
    store.delete(id);
    return [204];
  }],

  // Snooze from a notification's action button. The service worker can't
  // write the page's alarm list, so the server keeps the snooze itself.
  ['POST', /^\/v1\/devices\/([^/]+)\/snooze$/, async (req, id) => {
    const device = isId(id) && store.get(id);
    if (!device) return [404, { error: 'unknown device' }];

    const body = await readJson(req);
    // Rounded down to the minute, like a snooze set in the page, which is an
    // ordinary alarm for hour:minute five minutes from now.
    const at = Math.floor((Date.now() + SNOOZE_MS) / 60_000) * 60_000;
    device.snoozes = [...device.snoozes, { id: `snooze-${randomUUID()}`, at, label: parseLabel(body?.label) }]
      .slice(-MAX_SNOOZES);
    store.touch();
    return [204];
  }],
];

// The server's record of a fire wins over the page's when it is newer: the
// server rang the alarm while the page was closed, and the page doesn't know
// yet. A one-time alarm that fired stays off even if the page still says on.
function mergeFired(alarm, previous) {
  const serverKey = previous?.lastFireKey ?? null;
  if (!serverKey || serverKey <= (alarm.lastFireKey ?? '')) return alarm;
  return {
    ...alarm,
    lastFireKey: serverKey,
    enabled: alarm.days.length === 0 ? false : alarm.enabled,
  };
}

// ---------- HTTP plumbing ----------

const hits = new Map();
setInterval(() => hits.clear(), 60_000).unref();

function rateLimited(req) {
  // Behind nginx, the client address arrives in X-Forwarded-For. Only trust it
  // when the connection itself comes from the local proxy.
  const direct = req.socket.remoteAddress;
  const local = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  const ip = (local && req.headers['x-forwarded-for']?.split(',')[0].trim()) || direct;
  const n = (hits.get(ip) ?? 0) + 1;
  hits.set(ip, n);
  return n > RATE_LIMIT;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new ValidationError('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve(null);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ValidationError('body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !origins.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function reply(res, headers, status, body) {
  if (body === undefined) {
    res.writeHead(status, headers).end();
    return;
  }
  res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const headers = corsHeaders(req);

  if (req.method === 'OPTIONS') return reply(res, headers, 204);
  if (rateLimited(req)) return reply(res, headers, 429, { error: 'too many requests' });

  const path = new URL(req.url, 'http://localhost').pathname;
  for (const [method, pattern, handler] of routes) {
    const match = path.match(pattern);
    if (!match || method !== req.method) continue;
    try {
      const [status, body] = await handler(req, ...match.slice(1));
      return reply(res, headers, status, body);
    } catch (err) {
      if (err instanceof ValidationError) return reply(res, headers, 400, { error: err.message });
      console.error(err);
      return reply(res, headers, 500, { error: 'internal error' });
    }
  }
  reply(res, headers, 404, { error: 'not found' });
});

server.listen(Number(PORT), HOST, () => {
  console.log(`alarm push server on http://${HOST}:${PORT}, ${store.size} devices loaded`);
});

startScheduler(store);

// Write any pending changes before systemd stops the service.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    store.flush();
    process.exit(0);
  });
}
