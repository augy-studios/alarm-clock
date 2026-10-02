# Setting up background alarms on Vercel

Background alarms let an alarm ring while Alarm Clock is closed. The page sends
each device's alarms to the functions in [`api/`](api/). A Vercel Cron job
runs every minute and sends a Web Push for each alarm that is due, and the
browser shows it as a notification.

Everything runs in the same Vercel project as the site, at
`https://alarm.uwuapps.org/api/…`. There's no separate server or subdomain.

| Piece | What it is |
| --- | --- |
| `api/device.js` | `PUT` saves a device's subscription and alarms; `DELETE` forgets it |
| `api/snooze.js` | `POST` from a notification's Snooze button |
| `api/vapid-key.js` | The public key the page subscribes with |
| `api/healthz.js` | Health check |
| `api/tick.js` | The cron job, every minute (schedule in `vercel.json`) |
| `api/_lib/` | Shared code. The `_` keeps Vercel from making these into endpoints |
| Upstash Redis | Where devices, alarms and snoozes are stored |

> **Moving from the old VPS push server?** Follow
> [`../push-server-teardown.md`](../push-server-teardown.md) instead. It goes
> through these same steps, plus reusing the old keys and data, in the
> order that avoids a gap.

## 1. Add a Redis database

1. In Vercel, open the **alarm-clock** project → **Storage** →
   **Create Database**, and pick **Upstash for Redis** (under Marketplace).
2. Choose region **Singapore (ap-southeast-1)**, next to the functions'
   `sin1` region.
3. Connect it to the **alarm-clock** project for Production, Preview and
   Development.

This adds `KV_REST_API_URL`, `KV_REST_API_TOKEN` and a few other variables to
the project. The code reads the first two.

**Usage.** The cron job makes about 5 Redis commands a minute, so about
220,000 a month, plus a few for each sync from a device. Check that this fits
the Upstash plan you pick.

## 2. Make the VAPID keys

These identify your server to the browsers' push services. In this folder:

```sh
npm install
npm run vapid
```

It prints a **Public Key** and a **Private Key**.

> **Generate the keys once and keep them.** Every subscription is tied to
> them. New keys mean every device has to turn notifications off and on again
> before its alarms work in the background.

## 3. Add the environment variables

In the project → **Settings → Environment Variables**, add these for
**Production** and **Preview**, marked **Sensitive**:

| Name | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | The public key |
| `VAPID_PRIVATE_KEY` | The private key |
| `VAPID_SUBJECT` | `mailto:` plus an address the push services can contact, e.g. `mailto:augybiz@gmail.com` |
| `CRON_SECRET` | A random string. Make one with `node -e "console.log(crypto.randomBytes(32).toString('hex'))"` |

Vercel sends `CRON_SECRET` with each cron call, and `api/tick.js` refuses
calls without it, so nobody else can trigger it.

Environment variables only reach deployments made **after** they're added. If
the site was already deployed, redeploy it.

## 4. Deploy

Push to `main` as usual. `VERSION` in `sw.js` is already bumped for this
change. Once the deployment is ready:

- **Settings → Cron Jobs** should list `/api/tick` every minute. Cron jobs
  only run on the production deployment.
- This should print `{"ok":true,"devices":0}` (or however many devices there
  are):

  ```sh
  curl https://alarm.uwuapps.org/api/healthz
  ```

## 5. Try it

On your phone:

1. Open <https://alarm.uwuapps.org/>. If you already had it open, press
   **Reload** on the update bar.
2. Press **Enable Notifications** and allow them. The confirmation should say
   *"Alarms will ring even when the app is closed."* If it says to keep the app
   open instead, see Troubleshooting below.
3. Add an alarm for 2 minutes from now.
4. Close the app fully by swiping it away.
5. When the time comes, a notification with **Snooze 5 min** and **Stop**
   should appear.

`/api/healthz` should now count the device.

### What to expect per platform

- **Android (Chrome, Edge, Samsung Internet):** works in a browser tab or as
  an installed app. If notifications arrive late, set the browser or app to
  *Unrestricted* under **Settings → Apps → Battery**.
- **iPhone / iPad:** only works once the app is added to the Home Screen
  (**Share → Add to Home Screen**), opened from there, and given notification
  permission there. Safari tabs can't receive push.
- **Desktop:** works while the browser is running, even with the tab closed.
  Nothing arrives once the browser itself is quit.

With the app closed, an alarm plays the phone's normal notification sound
once and vibrates. It doesn't loop or play your chosen tone, because browsers
don't allow that from the background. With the app open, it rings as before.
Do Not Disturb and silent mode apply.

Vercel starts each cron run within the scheduled minute, usually a few
seconds in, so a background alarm can arrive a few seconds after the minute
turns.

## Troubleshooting

**Logs.** Project → **Logs**, filtered to `/api/tick` for the cron or `/api/device`
for syncs. Each cron run replies `{"minutes":1,"pushes":N}`. `"minutes":0`
means a duplicate delivery of a minute that was already handled, which is
normal.

**The confirmation says to keep the app open.** The page couldn't subscribe
or reach the API. On a computer, open DevTools → Console on the site and look
for `background alarms unavailable:`. Common causes:

- `/api/vapid-key` replies 500: the `VAPID_*` variables are missing, or were
  added after the last deploy. Check step 3, then redeploy.
- `/api/healthz` replies 500: Redis isn't connected (step 1), or was connected
  after the last deploy.
- iPhone not using the Home Screen app: see above.

**`/api/tick` replies 401 in the logs.** `CRON_SECRET` was added or changed
after the last deploy. Redeploy.

**`push to ... failed: 403`** in the logs. The VAPID keys changed after
devices subscribed. On each device, turn notifications off for the site in
browser settings, then press **Enable Notifications** again.

**`dropped expired subscription`** in the logs. This is normal. That device
revoked permission, uninstalled the app or cleared site data, so the server
forgets it.

## Testing locally

```sh
npm install
npx vercel link
npx vercel env pull .env.local
npx vercel dev
```

`vercel dev` serves the site and the functions together, by default on
<http://localhost:3000>. Cron doesn't run locally, so trigger a minute by hand
with the `CRON_SECRET` from `.env.local`:

```sh
curl -H "Authorization: Bearer <CRON_SECRET>" http://localhost:3000/api/tick
```

`.env.local` points at the same Redis database as production unless you
connect a separate one for Development, so devices you add while testing show
up there too.

## What's stored

Redis holds, per device: its push subscription, time zone, and alarm times
and labels, plus when the server last rang each alarm and any pending
snoozes. There are no accounts, names or email addresses. If the data is ever
lost, each device re-sends its alarms the next time the app is opened.
