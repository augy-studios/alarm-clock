// Alarm time logic shared by the API and the cron. Mirrors checkAlarms() in
// script.js, including the "YYYY-MM-DD HH:MM" fire key, so the page and the
// server agree on whether an alarm has already rung.

export const MINUTE = 60_000;

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

// The server's record of a fire wins over the page's when it is newer: the
// server rang the alarm while the page was closed, and the page doesn't know
// yet. A one-time alarm that fired stays off even if the page still says on.
export function mergeFired(alarm, serverKey) {
  if (!serverKey || serverKey <= (alarm.lastFireKey ?? '')) return alarm;
  return {
    ...alarm,
    lastFireKey: serverKey,
    enabled: alarm.days.length === 0 ? false : alarm.enabled,
  };
}
