// Web Push with the VAPID keys from the environment. See PUSH-SETUP.md.

import webpush from 'web-push';

const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;

// A push the device can't receive within this many seconds is dropped. An
// alarm arriving much later than that is worse than none.
const PUSH_TTL = 300;

let configured = false;

function configure() {
  if (configured) return;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    throw new Error('VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set. See PUSH-SETUP.md.');
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
}

export function vapidPublicKey() {
  configure();
  return VAPID_PUBLIC_KEY;
}

export function sendPush(subscription, payload) {
  configure();
  return webpush.sendNotification(subscription, JSON.stringify(payload), {
    TTL: PUSH_TTL,
    urgency: 'high',
  });
}
