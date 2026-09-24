# main-site

The Alarm Clock web app, served at <https://alarm.uwuapps.org/>. Plain HTML,
CSS and ES modules with no framework, bundler or build step.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | The page. Also holds the pre-paint theme script in `<head>`. |
| `style.css` | All styles, including the theme tokens. |
| `script.js` | The alarm clock: clock loop, alarms, tones, uploads, notifications. |
| `app.js` | Boots the theme system, icons, the theme modal, and the update bar. |
| `js/theme.js` | Brand colours and light / dark / time-based mode. |
| `js/icons.js` | Inline SVG icons, looked up by name. |
| `js/ui.js` | Icon hydration (`data-icon`) and modal open/close. |
| `js/update.js` | Registers the service worker and shows the "new version is ready" bar. |
| `sw.js` | Service worker: offline cache and notification clicks. |
| `manifest.json` | PWA manifest (icons, screenshots, display modes). |
| `404.html`, `404.css` | Not-found page. |
| `vercel.json` | Vercel config (clean URLs, `sin1` region). |
| `.well-known/assetlinks.json` | Digital Asset Links for the Android app `org.uwuapps.alarm`. |
| `XAC-*.png`, `favicon.ico`, `browserconfig.xml` | Icons. |
| `images/` | Screenshots used in the manifest's install UI. |

## How it works

**Alarms.** `script.js` ticks once a second, aligned to the wall clock. Each tick
compares the current hour and minute against every enabled alarm. An alarm
fires at most once per minute (tracked by `lastFireKey`). Alarms with no repeat
days turn themselves off after they ring. Snooze adds a new one-time alarm 5
minutes out.

**Tones.** Built-in tones are synthesised with the Web Audio API, so there are
no audio files to ship. Uploaded tones are played with an `<audio>` element and
loop until stopped.

**Storage.** Everything stays on the device.

| Where | Key | Holds |
| --- | --- | --- |
| `localStorage` | `alarmClOwOck.alarms` | The alarm list |
| `localStorage` | `alarmClOwOck.prefs` | 12h/24h and volume |
| `localStorage` | `uwualarm.mode`, `uwualarm.colorTheme` | Theme choice |
| IndexedDB | `alarmClOwOckDB` / `tones` | Uploaded ringtone files |

**Notifications.** Shown through the service worker registration when there is
one, because `new Notification()` throws on Android Chrome and in installed
PWAs. Clicking a notification focuses the app.

**Theme.** Follows the shared UwU Apps theme spec in
[`../uwuapps-theme.md`](../uwuapps-theme.md).

**Offline and updates.** `sw.js` precaches the app shell and serves it
cache-first. Google Fonts get their own cache so a deploy doesn't discard them.
Analytics and ads are never cached. A new worker never takes over on its own: it
installs and waits until the reader presses **Reload** in the update bar. See
[`../update-bar-spec.md`](../update-bar-spec.md).

**Limitation.** Alarms are checked by the running page, so they only ring while
the app is open.

## Running locally

```sh
npx serve .
```

Run it from this folder, or use any other static server. Use `localhost` or
HTTPS, since service workers and notifications don't work from `file://`.

While testing service worker changes, turn on "Update on reload" in DevTools →
Application → Service workers, or you will keep seeing the cached version.

## Deploying

Vercel serves this folder as a static site. Before each deploy:

1. **Bump `VERSION` in `sw.js`** (format `YYYY-MM-DD.n`). The browser only sees
   an update when `sw.js` changes byte for byte. If you forget, nobody gets the
   new version or the update bar.
2. **If you added a file the shell needs**, add it to `ASSETS` in `sw.js`. Use
   `/`, not `/index.html`, because `cleanUrls` redirects the latter.

## Things to keep in sync

- `"uwualarm"` in the pre-paint script in `index.html` must match `APP_KEY` in
  `js/theme.js`.
- The light-mode hours (09:00 to 18:00) appear in both the pre-paint script and
  `LIGHT_FROM_HOUR` / `LIGHT_UNTIL_HOUR` in `js/theme.js`. Change them together.
- The app description is repeated in `index.html` (meta and Open Graph tags)
  and `manifest.json`.
