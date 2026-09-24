// Service worker registration and the "new version is ready" bar.
// A new worker never activates on its own: it installs, waits, and is only
// promoted when somebody presses Reload. See update-bar-spec.md.

const SW_URL = '/sw.js';

const STRINGS = {
  label: 'Update',
  ready: 'A new version of Alarm Clock is ready.',
  reload: 'Reload',
  later: 'Not now',
};

let registration = null;
let waitingWorker = null;
let reloading = false;
let dismissed = false;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function watchForUpdate() {
  if (!registration) return;

  // A worker already waiting when the page opened. This is the ordinary case on
  // the second page view after a deploy, and without it the prompt would only
  // ever reach somebody who happened to have the page open at the moment the
  // new worker finished installing.
  if (registration.waiting && navigator.serviceWorker.controller) {
    waitingWorker = registration.waiting;
    render();
  }

  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    if (!installing) return;

    installing.addEventListener('statechange', () => {
      // `installed` with a controller present means an update. `installed` with
      // no controller is a first install, which has nothing to prompt about:
      // there is no previous version on screen to protect.
      if (installing.state === 'installed' && navigator.serviceWorker.controller) {
        waitingWorker = registration.waiting ?? installing;
        render();
      }
    });
  });
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;

  navigator.serviceWorker
    .register(SW_URL)
    .then((reg) => {
      registration = reg;
      watchForUpdate();
    })
    .catch((cause) => {
      // A refused registration is not a reason to break the page. Private
      // browsing in some browsers, and any http origin that is not localhost,
      // land here.
      console.warn('service worker registration failed:', cause);
    });

  // The swap, once somebody has accepted it. Reloading here rather than in the
  // click handler is what makes the page come back on the new version: the
  // controller has changed by this point, so the reload is served by the new
  // worker and not the one being replaced.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

function render() {
  const existing = document.querySelector('.update-notice');

  if (!waitingWorker || dismissed) {
    if (existing) {
      // Animate out, then drop it. The timeout covers a transition that never
      // fires, e.g. a bar that was never painted.
      existing.classList.add('hidden');
      existing.addEventListener('transitionend', () => existing.remove(), { once: true });
      setTimeout(() => existing.remove(), 300);
    }
    return;
  }

  const bar = existing ?? document.createElement('div');
  bar.className = 'update-notice';
  bar.setAttribute('role', 'status');
  bar.setAttribute('aria-label', STRINGS.label);
  bar.innerHTML = `
    <div class="update-notice-inner">
      <p>${escapeHtml(STRINGS.ready)}</p>
      <button type="button" class="btn primary" data-sw-update>
        ${escapeHtml(STRINGS.reload)}
      </button>
      <button type="button" class="btn ghost" data-sw-later>
        ${escapeHtml(STRINGS.later)}
      </button>
    </div>
  `;

  bar.querySelector('[data-sw-update]').addEventListener('click', () => {
    // The only place anything asks for skipWaiting. The reload happens on
    // controllerchange, not here.
    waitingWorker?.postMessage('skip-waiting');
  });

  bar.querySelector('[data-sw-later]').addEventListener('click', () => {
    // This page view only, never stored.
    dismissed = true;
    render();
  });

  if (!existing) document.body.prepend(bar);
}

// Registration on `load`, not immediately: installing fetches everything the
// worker precaches, and starting that while the page is still fetching its own
// assets is how a service worker makes a first visit slower for no gain.
if (document.readyState === 'complete') registerWorker();
else window.addEventListener('load', registerWorker, { once: true });
