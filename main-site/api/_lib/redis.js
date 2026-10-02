// Where the push functions keep their data: Upstash Redis, reached over its
// REST API, so a short-lived function has no connection to open or keep
// alive. Connected through the Vercel Marketplace, which sets KV_REST_API_URL
// and KV_REST_API_TOKEN. See PUSH-SETUP.md.
//
// The page's alarm list and the server's record of what it rang live under
// separate keys. PUT writes only the first and the cron only the second, so
// neither can overwrite the other's newer data with a stale copy.

import { Redis } from '@upstash/redis';

const { KV_REST_API_URL, KV_REST_API_TOKEN, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN } = process.env;

export const redis = new Redis({
  url: KV_REST_API_URL ?? UPSTASH_REDIS_REST_URL,
  token: KV_REST_API_TOKEN ?? UPSTASH_REDIS_REST_TOKEN,
  // Values are JSON or plain strings that this code parses itself.
  automaticDeserialization: false,
});

// Keep these in step with scripts/import-push-devices.mjs.

// Hash: device id -> JSON { subscription, timeZone, alarms, updatedAt }.
export const DEVICES = 'alarm:devices';
// Hash: firedField() -> the fire key ("YYYY-MM-DD HH:MM") the server last rang.
export const FIRED = 'alarm:fired';
// Sorted set: JSON { deviceId, id, label }, scored by when the snooze is due.
export const SNOOZES = 'alarm:snoozes';

export const firedField = (deviceId, alarmId) => `${deviceId}:${alarmId}`;

// HMGET as { field: value }. With automaticDeserialization off, the client
// returns the bare array of values instead.
export async function hmgetMap(key, fields) {
  if (!fields.length) return {};
  const values = await redis.hmget(key, ...fields);
  return Object.fromEntries(fields.map((f, i) => [f, values?.[i] ?? null]));
}

export async function getDevice(id) {
  const raw = await redis.hget(DEVICES, id);
  return raw ? JSON.parse(raw) : null;
}

// Pending snoozes are left in place; the cron skips them once the device is gone.
export async function deleteDevice(id) {
  const device = await getDevice(id);
  const p = redis.pipeline().hdel(DEVICES, id);
  if (device?.alarms.length) p.hdel(FIRED, ...device.alarms.map((a) => firedField(id, a.id)));
  await p.exec();
}
