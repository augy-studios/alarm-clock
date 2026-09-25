// Once a minute, works out the wall-clock time in each device's time zone and
// sends a push for every alarm that matches. This mirrors checkAlarms() in
// main-site/script.js, including the "YYYY-MM-DD HH:MM" fire key, so the page
// and the server agree on whether an alarm has already rung.

import webpush from 'web-push';

const MINUTE = 60_000;
// If the process stalls (GC pause, suspended VM), catch up on at most this
// many missed minutes rather than skipping alarms outright.
const MAX_CATCH_UP = 10;
// A push the device can't receive within this many seconds is dropped. An
// alarm arriving much later than that is worse than none.
const PUSH_TTL = 300;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const formatters = new Map();

export function wallClock(timeZone, date) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(timeZone, fmt);
  }
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    hour: Number(p.hour),
    minute: Number(p.minute),
    dow: WEEKDAYS.indexOf(p.weekday),
    key: `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`,
  };
}

export function startScheduler(store, log = console) {
  let lastMinute = Math.floor(Date.now() / MINUTE) - 1;

  function scheduleNext() {
    // A little past the boundary so the minute has definitely turned.
    const delay = MINUTE - (Date.now() % MINUTE) + 50;
    setTimeout(run, delay);
  }

  async function run() {
    scheduleNext();
    const nowMinute = Math.floor(Date.now() / MINUTE);
    const from = Math.max(lastMinute + 1, nowMinute - MAX_CATCH_UP + 1);
    lastMinute = nowMinute;
    for (let m = from; m <= nowMinute; m++) {
      await tick(store, new Date(m * MINUTE), log);
    }
  }

  scheduleNext();
}

async function tick(store, date, log) {
  const sends = [];

  for (const [deviceId, device] of store.entries()) {
    const now = wallClock(device.timeZone, date);
    let changed = false;

    for (const a of device.alarms) {
      if (!a.enabled) continue;
      if (a.hour !== now.hour || a.minute !== now.minute) continue;
      if (a.days.length > 0 && !a.days.includes(now.dow)) continue;
      if (a.lastFireKey === now.key) continue;

      a.lastFireKey = now.key;
      if (a.days.length === 0) a.enabled = false; // one-time
      changed = true;
      sends.push(send(store, deviceId, device, { alarmId: a.id, label: a.label, fireKey: now.key }, log));
    }

    const due = device.snoozes.filter((s) => s.at <= date.getTime());
    if (due.length) {
      device.snoozes = device.snoozes.filter((s) => s.at > date.getTime());
      changed = true;
      for (const s of due) {
        sends.push(send(store, deviceId, device, { alarmId: s.id, label: s.label, fireKey: now.key }, log));
      }
    }

    if (changed) store.touch();
  }

  await Promise.allSettled(sends);
}

async function send(store, deviceId, device, alarm, log) {
  const payload = JSON.stringify({ type: 'alarm', deviceId, ...alarm });
  try {
    await webpush.sendNotification(device.subscription, payload, {
      TTL: PUSH_TTL,
      urgency: 'high',
    });
  } catch (err) {
    // 404 and 410 mean the subscription is gone for good: permission revoked,
    // app uninstalled, or site data cleared.
    if (err.statusCode === 404 || err.statusCode === 410) {
      store.delete(deviceId);
      log.info(`dropped expired subscription ${deviceId}`);
    } else {
      log.error(`push to ${deviceId} failed:`, err.statusCode ?? '', err.body ?? err.message);
    }
  }
}
