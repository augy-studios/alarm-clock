# Setting up the push server on Debian 13

This folder is the server that lets alarms ring while Alarm Clock is closed.
The app sends it each device's alarms, and at alarm time it sends a Web Push
message. The browser shows that as a notification even with the app closed.

You'll end up with:

- the Node server running as a systemd service on `127.0.0.1:8787`
- your existing nginx in front of it, serving `https://alarm-push.uwuapps.org`
  with a Let's Encrypt certificate from certbot
- data in `/var/lib/alarm-push/devices.json`

It takes about 15 minutes. Set the server up **before** deploying the site
changes. The site still works without it, but "Enable Notifications" won't be
able to turn on background alarms until the server answers.

## 1. Point a subdomain at the VPS

Add a DNS record for `alarm-push.uwuapps.org` wherever `uwuapps.org`'s DNS is
managed (for a domain on Vercel: **Domains → uwuapps.org → DNS Records**):

| Type | Name | Value |
| --- | --- | --- |
| `A` | `alarm-push` | your VPS's IPv4 address |
| `AAAA` | `alarm-push` | your VPS's IPv6 address (skip if it has none) |

Check it from your own computer. It should print the VPS's IP:

```sh
nslookup alarm-push.uwuapps.org
```

> Want a different hostname? Use it everywhere this guide says
> `alarm-push.uwuapps.org`, and change `API_BASE` in both
> `main-site/js/push.js` and `main-site/sw.js` to match.

## 2. Install Node, certbot and git

SSH into the VPS, then:

```sh
sudo apt update
sudo apt install -y nodejs npm git certbot python3-certbot-nginx
node --version
```

nginx is already running on this VPS and keeps ports 80 and 443, so this
doesn't install another web server.

`node --version` must say `v20.6` or newer. Debian 13's own package is v20,
which is fine.

## 3. Make sure the clock is right

Alarms fire off the VPS clock, so it has to be synced:

```sh
timedatectl
```

Look for `System clock synchronized: yes`. If it says `no`:

```sh
sudo apt install -y systemd-timesyncd
sudo systemctl enable --now systemd-timesyncd
```

The VPS's own time zone doesn't matter. Each alarm uses the time zone of the
device that set it.

## 4. Open the web ports

nginx already serves on 80 and 443, so these are probably open. Port 80 is
needed for the certificate check. If you use `ufw`, make sure:

```sh
sudo ufw allow 80,443/tcp
sudo ufw status
```

Also check your VPS provider's firewall panel if it has one. Port 8787 stays
closed, because the server only listens on `127.0.0.1`.

## 5. Get the code

```sh
cd ~
sudo git clone https://github.com/augy-studios/alarm-clock.git /opt/alarm-clock
cd /opt/alarm-clock/push-server
sudo npm ci --omit=dev
```

## 6. Create the keys and config

Generate the VAPID keys, which identify your server to the browsers' push
services:

```sh
cd /opt/alarm-clock/push-server
npx web-push generate-vapid-keys
```

It prints a **Public Key** and a **Private Key**. Put them in the config file.
`.env.example` starts with a dot, so plain `ls` doesn't show it; `ls -a` does.

```sh
cd /opt/alarm-clock/push-server
sudo cp .env.example /etc/alarm-push.env
sudo chmod 600 /etc/alarm-push.env
sudo micro /etc/alarm-push.env
```

Fill in:

- `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`: the two keys you just made.
- `VAPID_SUBJECT`: `mailto:` plus an email address the push services can
  contact, e.g. `mailto:augybiz@gmail.com`.
- Leave the rest as they are.

Save with `Ctrl+S`, then quit with `Ctrl+Q`.

> **Generate the keys once and keep them.** Every subscription is tied to
> them. New keys mean every device has to turn notifications off and on again
> before its alarms work in the background.

## 7. Start the service

```sh
cd /opt/alarm-clock/push-server
sudo cp deploy/alarm-push.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now alarm-push
sudo systemctl status alarm-push
```

`status` should show `active (running)` and a line like
`alarm push server on http://127.0.0.1:8787, 0 devices loaded`. Press `q` to
leave it.

Quick check from the VPS:

```sh
curl http://127.0.0.1:8787/healthz
```

That should print `{"ok":true,"devices":0}`.

## 8. Add an nginx site for it

```sh
cd /opt/alarm-clock/push-server
sudo cp deploy/nginx.conf /etc/nginx/sites-available/alarm-push
sudo ln -s /etc/nginx/sites-available/alarm-push /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

`nginx -t` checks the whole config before anything reloads. If it complains,
your other sites keep running as they were. Fix what it names, then run the
line again.

Then get the certificate:

```sh
sudo certbot --nginx -d alarm-push.uwuapps.org
```

certbot adds the HTTPS part to `/etc/nginx/sites-available/alarm-push`,
reloads nginx, and renews the certificate on its own. If it asks whether to
redirect HTTP to HTTPS, say yes.

Check from your own computer:

```sh
curl https://alarm-push.uwuapps.org/healthz
```

You should get the same `{"ok":true,...}` reply, now over HTTPS.

## 9. Deploy the site

Deploy `main-site/` to Vercel as usual. `VERSION` in `sw.js` is already bumped
for this change.

## 10. Try it

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

On the VPS, `curl http://127.0.0.1:8787/healthz` should now show
`"devices":1`.

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

## Updating later

After you change anything in `push-server/` and push it:

```sh
cd /opt/alarm-clock
sudo git pull
cd push-server
sudo npm ci --omit=dev
sudo systemctl restart alarm-push
```

## Troubleshooting

**Logs:**

```sh
sudo journalctl -u alarm-push -f    # the server
sudo tail -f /var/log/nginx/error.log  # nginx
```

**The confirmation says to keep the app open.** The page couldn't subscribe
or reach the server. On a computer, open DevTools → Console on the site and
look for `background alarms unavailable:`. Common causes:

- `https://alarm-push.uwuapps.org/healthz` doesn't answer: go back to steps 7
  and 8.
- A CORS error: `ALLOWED_ORIGINS` in `/etc/alarm-push.env` must be exactly
  `https://alarm.uwuapps.org` (no trailing slash). Restart after editing it.
- iPhone not using the Home Screen app: see above.

**certbot can't get a certificate.** The DNS record isn't pointing here yet,
or port 80 is blocked (step 4, including the provider's firewall).

**`502 Bad Gateway` from `https://alarm-push.uwuapps.org`.** nginx is fine but
the Node server isn't running. Check `sudo systemctl status alarm-push` and
its logs.

**`push to ... failed: 403`** in the logs. The VAPID keys changed after
devices subscribed. On each device, turn notifications off for the site in
browser settings, then press **Enable Notifications** again.

**`dropped expired subscription`** in the logs. This is normal. That device
revoked permission, uninstalled the app or cleared site data, so the server
forgets it.

## Testing locally

```sh
cd push-server
npm install
cp .env.example .env    # fill in keys from: npm run vapid
npm run dev
```

To use it from a local copy of the site, add `http://localhost:3000` to
`ALLOWED_ORIGINS` in `.env`, and temporarily point `API_BASE` in
`main-site/js/push.js` and `main-site/sw.js` at `http://localhost:8787`.

## Backups and privacy

Everything the server knows is in `/var/lib/alarm-push/devices.json`: each
device's push subscription, time zone, and alarm times and labels. There are
no accounts, names or email addresses. Back that file up if you like. Losing
it just means each device re-sends its alarms the next time the app is
opened.
