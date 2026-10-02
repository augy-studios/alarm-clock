# Moving background alarms off the VPS

Background alarms used to run on the Debian 13 VPS, as the `alarm-push`
service behind nginx at `https://alarm-push.uwuapps.org`. They now run as
Vercel functions in the site's own project (see
[`main-site/PUSH-SETUP.md`](main-site/PUSH-SETUP.md)). This guide moves the
keys and data across, then removes everything the old setup added to the VPS
and DNS.

It takes about 20 minutes. Follow the steps in order: the old keys and data
have to be copied **before** the VPS copies are deleted. Background alarms
pause between steps 3 and 5, so do it at a time when nobody's alarm is due.

**Don't push the commit with the Vercel functions until step 5.** The site
deploys on push, and the data import in step 4 has to happen first.

## 1. Add Redis to the Vercel project

Do step 1 of [`main-site/PUSH-SETUP.md`](main-site/PUSH-SETUP.md#1-add-a-redis-database):
create an Upstash for Redis database in Singapore and connect it to the
**alarm-clock** project.

## 2. Copy the keys to Vercel

The devices' subscriptions are tied to the old VAPID keys, so Vercel has to
use the same ones. If it had new keys, every device would have to turn
notifications off and on again.

SSH into the VPS and print the old config:

```sh
sudo cat /etc/alarm-push.env
```

In Vercel, open the project → **Settings → Environment Variables** and add
these for **Production** and **Preview**, marked **Sensitive**:

| Name | Value |
| --- | --- |
| `VAPID_PUBLIC_KEY` | Copied exactly from the VPS file |
| `VAPID_PRIVATE_KEY` | Copied exactly from the VPS file |
| `VAPID_SUBJECT` | Copied exactly from the VPS file |
| `CRON_SECRET` | A new random string: `node -e "console.log(crypto.randomBytes(32).toString('hex'))"` |

`ALLOWED_ORIGINS`, `PORT` and `HOST` aren't needed any more. The API is on the
site's own domain, so there's no CORS to allow.

## 3. Stop the old server and copy its data

Still on the VPS. Stopping the service first makes sure the file you copy is
final:

```sh
sudo systemctl disable --now alarm-push
sudo cp /var/lib/alarm-push/devices.json ~/devices.json
sudo chown "$USER": ~/devices.json
```

From here until step 5, no background alarms are sent.

Then, on your own computer, download it into the root of the repository
(`devices.json` is in `.gitignore`, so it won't be committed):

```sh
cd C:\Github\alarm-clock
scp <user>@<vps-address>:~/devices.json .
```

## 4. Import the data into Redis

On your own computer, get the Redis credentials into `main-site/.env.local`:

```sh
cd C:\Github\alarm-clock\main-site
npx vercel link
npx vercel env pull .env.local
```

Open `.env.local` and check that `KV_REST_API_URL` and `KV_REST_API_TOKEN`
have values. If either is empty, copy them from Vercel instead: **Storage** →
the Redis database → **.env.local** tab.

Then import, from the repository root:

```sh
cd C:\Github\alarm-clock
node --env-file=main-site/.env.local scripts/import-push-devices.mjs devices.json
```

It prints `Imported N devices.` Snoozes that were pending are not copied.
They're five minutes long at most.

## 5. Deploy

Commit and push the changes, and wait for the deployment to show **Ready**.
Then check from your own computer:

```sh
curl https://alarm.uwuapps.org/api/healthz
```

It should print `{"ok":true,"devices":N}`, with the same N as the import.

Then try it as in step 5 of
[`main-site/PUSH-SETUP.md`](main-site/PUSH-SETUP.md#5-try-it): reload the app
on your phone from the update bar, set an alarm for 2 minutes out, close the
app, and wait for the notification.

**Devices still running the old version** keep getting their imported alarms
from Vercel straight away. Changes they make, and Snooze from their
notifications, only reach the new server once they press **Reload** on the
update bar.

## 6. Remove the service

Back on the VPS:

```sh
sudo rm /etc/systemd/system/alarm-push.service
sudo systemctl daemon-reload
sudo systemctl reset-failed
```

`systemctl status alarm-push` should now say `Unit alarm-push.service could
not be found.`

## 7. Remove the nginx site

Remove the site before its certificate, because the site's config points at
the certificate files:

```sh
sudo rm /etc/nginx/sites-enabled/alarm-push
sudo rm /etc/nginx/sites-available/alarm-push
sudo nginx -t && sudo systemctl reload nginx
```

If `nginx -t` complains, nothing has reloaded and your other sites keep
running as they were. Fix what it names, then run that line again.

## 8. Delete the certificate

```sh
sudo certbot certificates
```

Find `alarm-push.uwuapps.org` in the list, and check that it is the only domain
listed for that certificate. Then:

```sh
sudo certbot delete --cert-name alarm-push.uwuapps.org
```

certbot keeps renewing the certificates of your other sites as before.

## 9. Delete the code, config and data

```sh
sudo rm -rf /opt/alarm-clock
sudo rm /etc/alarm-push.env
sudo rm -rf /var/lib/private/alarm-push /var/lib/alarm-push
```

The service ran with systemd's `DynamicUser`, so its data really lives in
`/var/lib/private/alarm-push`. `/var/lib/alarm-push` is a link to it. There's
no user account to remove; systemd removed it when the service stopped.

Keep `~/devices.json` until you're happy everything works on Vercel, then:

```sh
rm ~/devices.json
```

Also delete the `devices.json` you downloaded to the repository root.

## 10. Remove Node (optional)

Node and npm were installed only for the push server. Skip this if anything
else on the VPS uses Node. To check, this lists any running Node processes:

```sh
pgrep -a node
```

If it prints nothing and you don't need Node for anything else:

```sh
sudo apt remove nodejs npm
sudo apt autoremove
```

Keep `certbot`, `python3-certbot-nginx` and `git`. Your other nginx sites need
certbot for renewals.

## 11. Remove the DNS records

Wherever `uwuapps.org`'s DNS is managed (for a domain on Vercel:
**Domains → uwuapps.org → DNS Records**), delete the `A` record and the
`AAAA` record (if there was one) named `alarm-push`.

Check from your own computer. Once the old record's TTL has passed, it should
say the name can't be found:

```sh
nslookup alarm-push.uwuapps.org
```

## Nothing to undo

- **Firewall.** Port 8787 was never opened. Ports 80 and 443 belong to nginx
  and your other sites, so leave them open.
- **systemd-timesyncd.** If you turned it on for the push server, leave it on.
  A synced clock is good for the whole VPS.
