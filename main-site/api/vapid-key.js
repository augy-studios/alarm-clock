// GET /api/vapid-key  the public key the page subscribes to push with.

import { handle, json } from './_lib/http.js';
import { vapidPublicKey } from './_lib/push.js';

export function GET(request) {
  return handle(request, async () => json(200, { publicKey: vapidPublicKey() }));
}
