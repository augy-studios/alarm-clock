// PUT /api/device?id=  replaces a device's subscription and alarm list.
// DELETE /api/device?id=  forgets the device, so nothing is pushed to it.

import { mergeFired } from './_lib/alarms.js';
import { deviceIdParam, empty, handle, json, readJson } from './_lib/http.js';
import { DEVICES, FIRED, deleteDevice, firedField, hmgetMap, redis } from './_lib/redis.js';
import { parseDevice } from './_lib/validate.js';

const MAX_DEVICES = 50_000;

// The reply lists when the server last fired each alarm, so a page that was
// closed at the time can catch up (see applyServerFires in script.js).
export function PUT(request) {
  return handle(request, async () => {
    const id = deviceIdParam(request);
    const incoming = parseDevice(await readJson(request));

    const [previousRaw, count] = await redis.pipeline().hget(DEVICES, id).hlen(DEVICES).exec();
    if (!previousRaw && count >= MAX_DEVICES) return json(503, { error: 'server full' });
    const previous = previousRaw ? JSON.parse(previousRaw) : null;

    const fields = incoming.alarms.map((a) => firedField(id, a.id));
    const serverFires = await hmgetMap(FIRED, fields);
    const alarms = incoming.alarms.map((a, i) => mergeFired(a, serverFires[fields[i]]));

    // Forget the fire records of alarms the page has deleted.
    const kept = new Set(alarms.map((a) => a.id));
    const dropped = (previous?.alarms ?? []).filter((a) => !kept.has(a.id)).map((a) => firedField(id, a.id));

    const p = redis.pipeline().hset(DEVICES, {
      [id]: JSON.stringify({ ...incoming, alarms, updatedAt: Date.now() }),
    });
    if (dropped.length) p.hdel(FIRED, ...dropped);
    await p.exec();

    const fired = Object.fromEntries(alarms.filter((a) => a.lastFireKey).map((a) => [a.id, a.lastFireKey]));
    return json(200, { fired });
  });
}

export function DELETE(request) {
  return handle(request, async () => {
    await deleteDevice(deviceIdParam(request));
    return empty();
  });
}
