// GET /api/healthz  confirms Redis answers, and how many devices it holds.

import { handle, json } from './_lib/http.js';
import { DEVICES, redis } from './_lib/redis.js';

export function GET(request) {
  return handle(request, async () => json(200, { ok: true, devices: await redis.hlen(DEVICES) }));
}
