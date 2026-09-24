// Alarm Clock
import { icon } from './js/icons.js';

const el = (id) => document.getElementById(id);

const timeEl = el('time');
const dateEl = el('date');
const formatToggle = el('formatToggle');
const volumeEl = el('volume');
const notifBtn = el('notifBtn');

const alarmForm = el('alarmForm');
const alarmTime = el('alarmTime');
const alarmLabel = el('alarmLabel');
const alarmTone = el('alarmTone');
const alarmList = el('alarmList');
const emptyHint = el('emptyHint');

const ringingBox = el('ringing');
const ringingTitle = el('ringingTitle');
const snoozeBtn = el('snoozeBtn');
const stopBtn = el('stopBtn');

// Upload controls
const toneFile = el('toneFile');
const uploadToneBtn = el('uploadToneBtn');

// Persistence
const STORE_KEY = 'alarmClOwOck.alarms';
const PREFS_KEY = 'alarmClOwOck.prefs';

let alarms = load(STORE_KEY, []);
let prefs = load(PREFS_KEY, {
  is24h: true,
  volume: 0.8
});

// Apply prefs
formatToggle.checked = prefs.is24h;
volumeEl.value = prefs.volume;

// Audio engines
const synth = createSynth(); // built-in tones (WebAudio)
setVolume(prefs.volume);

// For custom uploads (HTMLAudioElement)
let currentAudioEl = null;
let currentAudioUrl = null;

// State
let ticking = null;
let isRinging = false;
let currentAlarmId = null;

// -------- IndexedDB for uploaded ringtones ----------
const DB_NAME = 'alarmClOwOckDB';
const DB_STORE = 'tones';
let idbReady = openTonesDB();

async function openTonesDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        const store = db.createObjectStore(DB_STORE, {
          keyPath: 'id'
        });
        store.createIndex('name', 'name', {
          unique: false
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPutTone(id, name, blob) {
  const db = await idbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put({
      id,
      name,
      blob
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetTone(id) {
  const db = await idbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbGetAllTones() {
  const db = await idbReady;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// ---------- Init ----------
renderAlarms();
tick(); // first paint
scheduleTick(); // steady updates
updateDateString();
populateUploadsInSelect(); // load uploaded tones into the dropdown

// ---------- Events ----------
formatToggle.addEventListener('change', () => {
  prefs.is24h = formatToggle.checked;
  save(PREFS_KEY, prefs);
  tick();
  renderAlarms();
});

volumeEl.addEventListener('input', () => {
  const v = parseFloat(volumeEl.value || '0.8');
  prefs.volume = clamp(v, 0, 1);
  save(PREFS_KEY, prefs);
  setVolume(prefs.volume);
  if (currentAudioEl) currentAudioEl.volume = prefs.volume;
});

notifBtn.addEventListener('click', async () => {
  try {
    if (!('Notification' in window)) {
      alert('Your browser does not support notifications.');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') {
      notifBtn.textContent = 'Notifications On';
      notifBtn.classList.add('primary');
      notify('Notifications enabled', {
        body: 'Alarms will also show system notifications.'
      });
    } else {
      notifBtn.textContent = 'Enable Notifications';
      notifBtn.classList.remove('primary');
    }
  } catch {}
});

// Upload a ringtone and store it
uploadToneBtn.addEventListener('click', async () => {
  const file = toneFile?.files?.[0];
  if (!file) {
    alert('Choose an audio file first.');
    return;
  }
  if (file.size > 25 * 1024 * 1024) { // 25MB guard
    alert('File is too large. Please pick a file under 25MB.');
    return;
  }
  const id = cryptoRandomId();
  try {
    await idbPutTone(id, file.name, file);
    await populateUploadsInSelect(id); // will also select the new tone
    toneFile.value = '';
  } catch (err) {
    console.error(err);
    alert('Could not save the file. Your browser may not support offline storage here.');
  }
});

alarmForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const t = alarmTime.value; // "HH:MM"
  if (!t) return;

  const label = (alarmLabel.value || 'Alarm').trim();
  const tone = alarmTone.value; // can be built-in ("chime") or "custom:<id>"

  const dayChecks = alarmForm.querySelectorAll('.days input[type="checkbox"]');
  const days = [...dayChecks].filter(c => c.checked).map(c => Number(c.value)); // 0..6 (Sun..Sat)

  const id = cryptoRandomId();
  const [hStr, mStr] = t.split(':');
  const hour = Number(hStr);
  const minute = Number(mStr);

  const item = {
    id,
    hour,
    minute,
    label,
    tone,
    days, // empty => one-time next occurrence today/tomorrow
    enabled: true,
    lastFireKey: null // "YYYY-MM-DD HH:MM"
  };

  alarms.push(item);
  save(STORE_KEY, alarms);
  renderAlarms();
  alarmForm.reset();
});

el('testBtn').addEventListener('click', async () => {
  const tone = alarmTone.value;
  await demoTone(tone);
});

snoozeBtn.addEventListener('click', () => {
  if (!currentAlarmId) return stopRinging();
  // Snooze 5 minutes (one-off alarm entry)
  const now = new Date();
  now.setMinutes(now.getMinutes() + 5);
  const id = cryptoRandomId();
  const item = {
    id,
    hour: now.getHours(),
    minute: now.getMinutes(),
    label: 'Snooze',
    tone: getCurrentToneOr('chime'),
    days: [], // one-time
    enabled: true,
    lastFireKey: null
  };
  alarms.push(item);
  save(STORE_KEY, alarms);
  stopRinging();
  renderAlarms();
});

stopBtn.addEventListener('click', stopRinging);

document.addEventListener('visibilitychange', () => {
  tick(); // catch up after tab hidden
});

// ---------- Clock loop ----------
function scheduleTick() {
  if (ticking) clearTimeout(ticking);
  const now = new Date();
  const ms = 1000 - now.getMilliseconds();
  ticking = setTimeout(() => {
    tick();
    scheduleTick();
  }, ms + 5);
}

function tick() {
  const now = new Date();
  timeEl.textContent = formatTime(now, prefs.is24h, true);
  if (now.getSeconds() === 0) updateDateString();
  checkAlarms(now);
}

function updateDateString() {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
  dateEl.textContent = fmt.format(now);
}

async function checkAlarms(now) {
  if (!alarms.length) return;
  const key = fmtKey(now);

  const currentDow = now.getDay(); // 0..6 Sun..Sat
  for (const a of alarms) {
    if (!a.enabled) continue;
    if (a.hour !== now.getHours() || a.minute !== now.getMinutes()) continue;

    // Repeat filter
    if (Array.isArray(a.days) && a.days.length > 0 && !a.days.includes(currentDow)) continue;

    if (a.lastFireKey === key) continue; // once per minute

    a.lastFireKey = key;
    save(STORE_KEY, alarms);

    await ring(a);
    // Disable one-time alarms
    if (!a.days || a.days.length === 0) {
      a.enabled = false;
      save(STORE_KEY, alarms);
      renderAlarms();
    }
  }
}

async function ring(alarm) {
  isRinging = true;
  currentAlarmId = alarm.id;
  ringingTitle.textContent = alarm.label || 'Alarm';
  ringingBox.classList.remove('hidden');

  await startTone(alarm.tone);

  try {
    navigator.vibrate && navigator.vibrate([300, 150, 300, 150, 600]);
  } catch {}

  notify('Alarm', {
    body: alarm.label || 'Alarm',
    silent: false
  });
}

function stopRinging() {
  isRinging = false;
  currentAlarmId = null;
  ringingBox.classList.add('hidden');
  stopTone();
  try {
    navigator.vibrate && navigator.vibrate(0);
  } catch {}
}

// System notification. Goes through the service worker when there is one:
// `new Notification()` throws on Android Chrome and in installed PWAs.
async function notify(title, options) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const reg = 'serviceWorker' in navigator ?
      await navigator.serviceWorker.getRegistration() :
      null;
    if (reg && reg.active) {
      await reg.showNotification(title, options);
      return;
    }
  } catch {}
  try {
    new Notification(title, options);
  } catch {}
}

function renderAlarms() {
  alarmList.innerHTML = '';
  if (alarms.length === 0) {
    alarmList.classList.add('empty');
    emptyHint.style.display = '';
    return;
  }
  alarmList.classList.remove('empty');
  emptyHint.style.display = 'none';

  // Sort by time
  const copy = [...alarms].sort((a, b) => (a.hour * 60 + a.minute) - (b.hour * 60 + b.minute));

  for (const a of copy) {
    const li = document.createElement('li');
    li.className = 'alarm-item';

    const t = document.createElement('div');
    t.className = 'alarm-time';
    t.textContent = formatHourMinute(a.hour, a.minute, prefs.is24h);
    li.appendChild(t);

    const label = document.createElement('div');
    label.className = 'alarm-label';
    label.textContent = a.label || '';
    li.appendChild(label);

    const days = document.createElement('div');
    days.className = 'alarm-days';
    days.textContent = (a.days && a.days.length) ?
      'Repeats: ' + a.days.map(dowShort).join(' ') :
      'One-time';
    li.appendChild(days);

    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.className = 'toggle';
    toggle.checked = !!a.enabled;
    toggle.setAttribute('aria-label', `Enable ${a.label || 'alarm'}`);
    toggle.addEventListener('change', () => {
      a.enabled = toggle.checked;
      save(STORE_KEY, alarms);
    });
    li.appendChild(toggle);

    const actions = document.createElement('div');
    actions.className = 'alarm-actions';

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'icon-btn small';
    playBtn.title = 'Preview tone';
    playBtn.setAttribute('aria-label', 'Preview tone');
    playBtn.innerHTML = icon('play');
    playBtn.addEventListener('click', async () => {
      await demoTone(a.tone || 'chime');
    });
    actions.appendChild(playBtn);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn small';
    delBtn.title = 'Delete alarm';
    delBtn.setAttribute('aria-label', 'Delete alarm');
    delBtn.innerHTML = icon('close');
    delBtn.addEventListener('click', () => {
      alarms = alarms.filter(x => x.id !== a.id);
      save(STORE_KEY, alarms);
      renderAlarms();
    });
    actions.appendChild(delBtn);

    li.appendChild(actions);
    alarmList.appendChild(li);
  }
}

// ---------- Tone selection helpers ----------
function isCustomTone(value) {
  return typeof value === 'string' && value.startsWith('custom:');
}

function customIdFrom(value) {
  return value.split(':', 2)[1];
}

async function populateUploadsInSelect(selectIdToPick = null) {
  // Ensure a 'My Uploads' optgroup exists
  let group = alarmTone.querySelector('optgroup[data-user-tones]');
  if (!group) {
    group = document.createElement('optgroup');
    group.setAttribute('label', 'My Uploads');
    group.setAttribute('data-user-tones', '1');
    alarmTone.appendChild(group);
  }
  group.innerHTML = '';

  const items = await idbGetAllTones();
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = `custom:${it.id}`;
    opt.textContent = `Custom • ${it.name}`;
    group.appendChild(opt);
  }

  if (selectIdToPick) {
    alarmTone.value = `custom:${selectIdToPick}`;
  }
}

// ---------- Built-in (WebAudio) tones ----------
function createSynth() {
  const ctx = new(window.AudioContext || window.webkitAudioContext)();
  let master = ctx.createGain();
  master.gain.value = 0.0;
  master.connect(ctx.destination);

  let seqTimer = null;
  let playing = false;
  let currentTone = 'chime';

  function setVolume(v) {
    master.gain.value = v;
  }

  function startTone(tone) {
    currentTone = tone || 'chime';
    if (playing) stopTone();
    playing = true;
    if (ctx.state === 'suspended') ctx.resume();

    const pattern = makePattern(currentTone);
    let step = 0;

    const tick = () => {
      if (!playing) return;
      const p = pattern[step % pattern.length];
      playBurst(p.freq, p.type, p.ms, p.decay);
      step++;
      seqTimer = setTimeout(tick, p.gap);
    };
    tick();
  }

  function stopTone() {
    playing = false;
    if (seqTimer) clearTimeout(seqTimer);
  }

  function playBurst(freq, type, ms, decay) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(master.gain.value, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, master.gain.value * (decay ?? 0.001)),
      ctx.currentTime + ms / 1000);

    osc.connect(gain).connect(master);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000 + 0.02);
  }

  function makePattern(kind) {
    switch (kind) {
      case 'beep':
        return [{
            freq: 880,
            type: 'square',
            ms: 140,
            gap: 220,
            decay: 0.05
          },
          {
            freq: 880,
            type: 'square',
            ms: 140,
            gap: 420,
            decay: 0.05
          },
        ];
      case 'pulse':
        return [{
            freq: 220,
            type: 'sawtooth',
            ms: 280,
            gap: 300,
            decay: 0.03
          },
          {
            freq: 180,
            type: 'sawtooth',
            ms: 220,
            gap: 420,
            decay: 0.03
          },
        ];
      case 'arpeggio':
        return [{
            freq: 523.25,
            type: 'triangle',
            ms: 140,
            gap: 120,
            decay: 0.06
          }, // C5
          {
            freq: 659.25,
            type: 'triangle',
            ms: 140,
            gap: 120,
            decay: 0.06
          }, // E5
          {
            freq: 783.99,
            type: 'triangle',
            ms: 140,
            gap: 360,
            decay: 0.06
          }, // G5
        ];
      case 'chime':
      default:
        return [{
            freq: 987.77,
            type: 'sine',
            ms: 280,
            gap: 160,
            decay: 0.02
          }, // B5
          {
            freq: 1318.51,
            type: 'sine',
            ms: 220,
            gap: 480,
            decay: 0.02
          }, // E6
        ];
    }
  }

  return {
    setVolume,
    startTone,
    stopTone,
    get isPlaying() {
      return playing;
    },
    get currentTone() {
      return currentTone;
    },
    get context() {
      return ctx;
    },
  };
}

// ---------- Unified tone controls ----------
function setVolume(v) {
  synth.setVolume(v);
}

async function startTone(toneValue) {
  stopTone(); // ensure clean start

  if (isCustomTone(toneValue)) {
    const id = customIdFrom(toneValue);
    const rec = await idbGetTone(id);
    if (!rec || !rec.blob) {
      // fallback to built-in if missing
      synth.startTone('chime');
      return;
    }
    // Create/reuse an Audio element
    currentAudioUrl = URL.createObjectURL(rec.blob);
    const a = new Audio(currentAudioUrl);
    a.loop = true;
    a.volume = prefs.volume;
    a.play().catch(() => {
      /* autoplay could be blocked until user gesture */ });
    currentAudioEl = a;
  } else {
    synth.startTone(toneValue);
  }
}

function stopTone() {
  // stop custom player
  if (currentAudioEl) {
    try {
      currentAudioEl.pause();
      currentAudioEl.currentTime = 0;
    } catch {}
    currentAudioEl.src = '';
    currentAudioEl = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
  // stop built-in synth
  synth.stopTone();
}

async function demoTone(tone) {
  const wasSynthPlaying = synth.isPlaying;
  const wasCustomPlaying = !!currentAudioEl;

  await startTone(tone);
  setTimeout(() => {
    if (wasSynthPlaying || wasCustomPlaying) {
      // If something was already playing, we won't stop it entirely
      // but we'll resume built-in if it was on
      if (wasSynthPlaying) synth.startTone(synth.currentTone);
      else stopTone();
    } else {
      stopTone();
    }
  }, 1800);
}

function formatTime(d, is24h, showSeconds) {
  let h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  let suffix = '';
  if (!is24h) {
    suffix = h >= 12 ? ' PM' : ' AM';
    h = h % 12 || 12;
  }
  const hh = is24h ? pad2(h) : String(h);
  const mm = pad2(m);
  const ss = pad2(s);
  return showSeconds ? `${hh}:${mm}:${ss}${suffix}` : `${hh}:${mm}${suffix}`;
}

function formatHourMinute(hour, minute, is24h) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return formatTime(d, is24h, false);
}

function dowShort(n) {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][n];
}

function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function fmtKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function load(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

function cryptoRandomId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Math.random().toString(36).slice(2, 10);
}

function getCurrentToneOr(def) {
  return (alarms.find(a => a.id === currentAlarmId)?.tone) || def;
}
