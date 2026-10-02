// POST /api/snooze?id=  snooze from a notification's action button. The
// service worker can't write the page's alarm list, so the server keeps the
// snooze itself and /api/tick pushes it again when it is due.

import { randomUUID } from 'node:crypto';
import { MINUTE } from './_lib/alarms.js';
import { deviceIdParam, empty, handle, json, readJson } from './_lib/http.js';
import { DEVICES, SNOOZES, redis } from './_lib/redis.js';
import { parseLabel } from './_lib/validate.js';

const SNOOZE_MS = 5 * MINUTE;

export function POST(request) {
  return handle(request, async () => {
    const id = deviceIdParam(request);
    if (!(await redis.hexists(DEVICES, id))) return json(404, { error: 'unknown device' });

    const body = await readJson(request);
    // Rounded down to the minute, like a snooze set in the page, which is an
    // ordinary alarm for hour:minute five minutes from now.
    const at = Math.floor((Date.now() + SNOOZE_MS) / MINUTE) * MINUTE;
    await redis.zadd(SNOOZES, {
      score: at,
      member: JSON.stringify({ deviceId: id, id: `snooze-${randomUUID()}`, label: parseLabel(body?.label) }),
    });
    return empty();
  });
}
