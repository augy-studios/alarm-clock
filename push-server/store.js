// Devices and their alarms, held in memory and written to one JSON file.
// The data is small (a subscription and a few alarms per device), so a
// database would be more to run than it is worth.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SAVE_DELAY_MS = 1000;

export function createStore(file) {
  const devices = new Map(Object.entries(read(file)));
  let timer = null;

  function save() {
    if (timer) return;
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  // Write to a temp file and rename, so a crash mid-write never leaves a
  // half-written file behind.
  function flush() {
    if (timer) clearTimeout(timer);
    timer = null;
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(devices)));
    renameSync(tmp, file);
  }

  return {
    get: (id) => devices.get(id),
    has: (id) => devices.has(id),
    set(id, device) {
      devices.set(id, device);
      save();
    },
    delete(id) {
      if (devices.delete(id)) save();
    },
    entries: () => devices.entries(),
    get size() {
      return devices.size;
    },
    // Call after changing a device in place.
    touch: save,
    flush,
  };
}

function read(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}
