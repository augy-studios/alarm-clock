// One-off: copies the old VPS push server's devices.json into the Redis
// database the Vercel push functions use, so devices keep getting alarms
// without having to open the app first. See push-server-teardown.md.
//
//   node --env-file=main-site/.env.local scripts/import-push-devices.mjs devices.json
//
// Run it before the new site is deployed. It overwrites devices with the same
// id, which would throw away newer alarms a device had already synced.
// No dependencies: talks to Upstash's REST API with fetch.

import { readFileSync } from 'node:fs';

// Keep in step with the keys in main-site/api/_lib/redis.js.
const DEVICES = 'alarm:devices';
const FIRED = 'alarm:fired';
const BATCH = 500;

const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const file = process.argv[2];

if (!url || !token || !file) {
  console.error('Usage: node --env-file=main-site/.env.local scripts/import-push-devices.mjs devices.json');
  console.error('The env file must set KV_REST_API_URL and KV_REST_API_TOKEN.');
  process.exit(1);
}

const devices = JSON.parse(readFileSync(file, 'utf8'));

const commands = [];
for (const [id, d] of Object.entries(devices)) {
  const { subscription, timeZone, alarms, updatedAt } = d;
  commands.push(['HSET', DEVICES, id, JSON.stringify({ subscription, timeZone, alarms, updatedAt })]);
  // The old server kept its fire record on each alarm.
  for (const a of alarms) {
    if (a.lastFireKey) commands.push(['HSET', FIRED, `${id}:${a.id}`, a.lastFireKey]);
  }
}

for (let i = 0; i < commands.length; i += BATCH) {
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands.slice(i, i + BATCH)),
  });
  if (!res.ok) throw new Error(`Redis replied ${res.status}: ${await res.text()}`);
  for (const r of await res.json()) {
    if (r.error) throw new Error(`Redis error: ${r.error}`);
  }
}

console.log(`Imported ${Object.keys(devices).length} devices.`);
