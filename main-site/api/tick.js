// GET /api/tick  run by Vercel Cron once a minute (see vercel.json). Works out
// the wall-clock time in each device's time zone and pushes every alarm and
// snooze that is due.

import { MINUTE, mergeFired, wallClock } from './_lib/alarms.js';
import { json } from './_lib/http.js';
import { sendPush } from './_lib/push.js';
import { DEVICES, FIRED, SNOOZES, deleteDevice, firedField, hmgetMap, redis } from './_lib/redis.js';

// If a run is missed or late, catch up on at most this many minutes rather
// than skipping alarms outright.
const MAX_CATCH_UP = 10;
const LAST_MINUTE = 'alarm:tick:last';
const SCAN_COUNT = 500;

export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  const nowMinute = Math.floor(Date.now() / MINUTE);
  const last = Number(await redis.get(LAST_MINUTE)) || nowMinute - 1;
  const from = Math.max(last + 1, nowMinute - MAX_CATCH_UP + 1);

  let minutes = 0;
  let pushes = 0;
  for (let m = from; m <= nowMinute; m++) {
    // A cron event can arrive twice, and a slow run can overlap the next one.
    // Claiming the minute first means only one run handles it.
    const claimed = await redis.set(`alarm:tick:${m}`, '1', { nx: true, ex: 86_400 });
    if (claimed !== 'OK') continue;
    minutes++;
    pushes += await tick(new Date(m * MINUTE));
  }
  await redis.set(LAST_MINUTE, String(nowMinute));

  return json(200, { minutes, pushes });
}

// Returns how many pushes were delivered.
async function tick(date) {
  const sends = [];

  let cursor = '0';
  do {
    const [next, flat] = await redis.hscan(DEVICES, cursor, { count: SCAN_COUNT });
    cursor = String(next);
    const devices = [];
    for (let i = 0; i < flat.length; i += 2) devices.push([flat[i], JSON.parse(flat[i + 1])]);
    sends.push(...await dueAlarms(devices, date));
  } while (cursor !== '0');

  sends.push(...await dueSnoozes(date));

  return (await Promise.all(sends)).filter(Boolean).length;
}

// Records each due alarm as fired before pushing it, so a device that a scan
// returns twice is only rung once. Returns the pushes, already under way.
async function dueAlarms(devices, date) {
  const candidates = [];
  for (const [deviceId, device] of devices) {
    const now = wallClock(device.timeZone, date);
    for (const alarm of device.alarms) {
      if (!alarm.enabled) continue;
      if (alarm.hour !== now.hour || alarm.minute !== now.minute) continue;
      if (alarm.days.length > 0 && !alarm.days.includes(now.dow)) continue;
      candidates.push({ deviceId, device, alarm, now });
    }
  }
  if (!candidates.length) return [];

  const fields = candidates.map((c) => firedField(c.deviceId, c.alarm.id));
  const serverFires = await hmgetMap(FIRED, fields);
  const due = candidates.filter((c, i) => {
    const alarm = mergeFired(c.alarm, serverFires[fields[i]]);
    return alarm.enabled && alarm.lastFireKey !== c.now.key;
  });
  if (!due.length) return [];

  await redis.hset(FIRED, Object.fromEntries(due.map((c) => [firedField(c.deviceId, c.alarm.id), c.now.key])));
  return due.map((c) => send(c.deviceId, c.device.subscription, {
    alarmId: c.alarm.id,
    label: c.alarm.label,
    fireKey: c.now.key,
  }));
}

async function dueSnoozes(date) {
  const members = await redis.zrange(SNOOZES, 0, date.getTime(), { byScore: true });
  if (!members.length) return [];

  // Only the run whose ZREM actually removed a snooze sends it.
  const p = redis.pipeline();
  for (const m of members) p.zrem(SNOOZES, m);
  const removed = await p.exec();
  const snoozes = members.filter((_, i) => removed[i] === 1).map((m) => JSON.parse(m));
  if (!snoozes.length) return [];

  const ids = [...new Set(snoozes.map((s) => s.deviceId))];
  const raw = await hmgetMap(DEVICES, ids);
  return snoozes.flatMap((s) => {
    if (!raw[s.deviceId]) return []; // device deleted since
    const device = JSON.parse(raw[s.deviceId]);
    return [send(s.deviceId, device.subscription, {
      alarmId: s.id,
      label: s.label,
      fireKey: wallClock(device.timeZone, date).key,
    })];
  });
}

// Resolves to whether the push was delivered. Never rejects.
async function send(deviceId, subscription, alarm) {
  try {
    await sendPush(subscription, { type: 'alarm', deviceId, ...alarm });
    return true;
  } catch (err) {
    // 404 and 410 mean the subscription is gone for good: permission revoked,
    // app uninstalled, or site data cleared.
    if (err.statusCode === 404 || err.statusCode === 410) {
      await deleteDevice(deviceId).catch((e) => console.error(`dropping ${deviceId} failed:`, e));
      console.info(`dropped expired subscription ${deviceId}`);
    } else {
      console.error(`push to ${deviceId} failed:`, err.statusCode ?? '', err.body ?? err.message);
    }
    return false;
  }
}
