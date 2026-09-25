// Background alarms. The page subscribes to Web Push and sends its alarm list
// to the push server (push-server/ in this repo), which pushes at alarm time
// so the alarm reaches the device while the app is closed. The page still
// rings on its own while it is open; the fire key keeps the two from doubling.

// Keep in step with API_BASE in sw.js.
export const API_BASE = 'https://alarm-push.uwuapps.org';
const DEVICE_KEY = 'alarmClOwOck.deviceId';
const SYNC_DELAY_MS = 500;

let syncTimer = null;
let pendingAlarms = null;
let onFired = () => {};

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

// Called with { alarmId: fireKey } after each sync, for alarms the server has
// rung. Also called for live pushes, with the push itself.
export function onServerFired(callback) {
  onFired = callback;
}

// Subscribe (if not already) and send the alarms. Returns whether background
// alarms are now on. Needs notification permission first.
export async function enableBackgroundAlarms(alarms) {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    const reg = await readyRegistration();
    const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: await fetchPublicKey(),
    });
    await sync(sub, alarms);
    return true;
  } catch (err) {
    console.warn('background alarms unavailable:', err);
    return false;
  }
}

// Debounced sync after the alarm list changes. Does nothing unless the
// device is already subscribed.
export function syncAlarms(alarms) {
  pendingAlarms = alarms;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(flushSync, SYNC_DELAY_MS);
}

async function flushSync() {
  const alarms = pendingAlarms;
  if (!alarms || !pushSupported() || Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await sync(sub, alarms);
    pendingAlarms = null;
  } catch (err) {
    // Offline most likely. Kept in pendingAlarms and retried on `online`.
    console.warn('alarm sync failed:', err);
  }
}

window.addEventListener('online', () => {
  if (pendingAlarms) flushSync();
});

async function sync(sub, alarms) {
  const res = await fetch(`${API_BASE}/v1/devices/${deviceId()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subscription: sub.toJSON(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      alarms: alarms.map(({ id, hour, minute, days, enabled, label, lastFireKey }) =>
        ({ id, hour, minute, days, enabled, label, lastFireKey })),
    }),
  });
  if (!res.ok) throw new Error(`push server replied ${res.status}`);
  const { fired } = await res.json();
  onFired({ fired });
}

// Pushes that arrive while the page is open, relayed by the service worker.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'alarm-fired') onFired({ push: event.data });
  });
}

function deviceId() {
  let id = null;
  try {
    id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_KEY, id);
    }
  } catch {}
  return id ?? crypto.randomUUID();
}

// navigator.serviceWorker.ready never settles if registration failed, so it
// gets a time limit.
function readyRegistration() {
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) => setTimeout(() => reject(new Error('service worker not ready')), 10_000)),
  ]);
}

async function fetchPublicKey() {
  const res = await fetch(`${API_BASE}/v1/vapid-key`);
  if (!res.ok) throw new Error(`push server replied ${res.status}`);
  const { publicKey } = await res.json();
  return base64UrlToBytes(publicKey);
}

function base64UrlToBytes(s) {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
