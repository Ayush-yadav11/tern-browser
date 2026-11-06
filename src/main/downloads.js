'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { JsonFile } = require('./settings');

const MAX_ENTRIES = 100;
const PUSH_MS = 250;
// File types that can run code when opened, so they get a warning first.
const RISKY = new Set([
  '.exe', '.msi', '.msix', '.msp', '.appx', '.appxbundle', '.application', '.bat', '.cmd', '.com', '.cpl',
  '.dll', '.gadget', '.hta', '.inf', '.iso', '.img', '.jar', '.js', '.jse', '.lnk', '.pif', '.ps1', '.psm1',
  '.reg', '.scr', '.url', '.vbe', '.vbs', '.vhd', '.vhdx', '.wsf', '.wsh',
]);

const isRisky = (file) => RISKY.has(path.extname(file).toLowerCase());

function uniquePath(folder, name, reserved) {
  const { name: stem, ext } = path.parse(path.basename(name) || 'download');
  let candidate = path.join(folder, `${stem}${ext}`);
  for (let n = 1; fs.existsSync(candidate) || reserved.has(candidate); n++) {
    candidate = path.join(folder, `${stem} (${n})${ext}`);
  }
  return candidate;
}

// Tells Windows the file came from the internet, so SmartScreen checks it when it's opened.
function markFromInternet(file, url) {
  if (process.platform !== 'win32') return;
  const source = /^https?:/i.test(url) ? url : 'about:internet';
  try {
    fs.writeFileSync(`${file}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=${source}\r\n`);
  } catch {
    // Some drives, such as FAT32 USB sticks, can't store this. The download still counts.
  }
}

class Downloads extends EventEmitter {
  constructor({ session, profile, getFolder, shouldAsk, onStarted, openPath, showInFolder, confirmOpen }) {
    super();
    this.file = new JsonFile(path.join(profile, 'downloads.json'));
    this.getFolder = getFolder;
    this.shouldAsk = shouldAsk;
    this.onStarted = onStarted;
    this.openPath = openPath;
    this.showInFolder = showInFolder;
    this.confirmOpen = confirmOpen;
    this.nextId = 1;
    this.items = new Map();
    this.entries = this.load();
    this.pushTimer = null;
    session.on('will-download', (_event, item, contents) => this.track(item, contents));
  }

  // Files from Tor tabs still save, but aren't written to the list on disk.
  attachPrivate(ses) {
    ses.on('will-download', (_event, item, contents) => this.track(item, contents, true));
  }

  load() {
    const saved = this.file.read();
    if (!Array.isArray(saved)) return [];
    return saved
      .filter((e) => typeof e?.path === 'string' && typeof e.filename === 'string')
      .map((e) => ({
        id: this.nextId++,
        filename: e.filename,
        path: e.path,
        url: String(e.url ?? ''),
        total: Number(e.total) || 0,
        received: Number(e.received) || 0,
        speed: 0,
        startedAt: Number(e.startedAt) || 0,
        // Anything unfinished when Tern last closed can't be picked up again.
        state: e.state === 'completed' ? 'completed' : e.state === 'cancelled' ? 'cancelled' : 'interrupted',
        paused: false,
        canResume: false,
        missing: false,
      }));
  }

  get activeCount() {
    return this.entries.filter((e) => e.state === 'progressing').length;
  }

  list() {
    return this.entries;
  }

  // Files can be moved or deleted outside Tern, so this runs when the panel opens.
  refresh() {
    for (const e of this.entries) if (e.state === 'completed') e.missing = !fs.existsSync(e.path);
    this.changed();
  }

  changed() {
    if (this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.emit('changed');
    }, PUSH_MS);
  }

  save() {
    this.file.write(this.entries.filter((e) => !e.isPrivate).map(({ filename, path: p, url, total, received, startedAt, state }) => ({
      filename, path: p, url, total, received, startedAt, state,
    })));
  }

  track(item, contents, isPrivate = false) {
    const folder = this.getFolder();
    const entry = {
      id: this.nextId++,
      filename: path.basename(item.getFilename()) || 'download',
      path: '',
      url: item.getURL(),
      isPrivate,
      total: item.getTotalBytes(),
      received: 0,
      speed: 0,
      startedAt: Date.now(),
      state: 'progressing',
      paused: false,
      canResume: false,
      missing: false,
    };
    if (this.shouldAsk()) {
      item.setSaveDialogOptions({ defaultPath: path.join(folder, entry.filename) });
    } else {
      fs.mkdirSync(folder, { recursive: true });
      const reserved = new Set(this.entries.filter((e) => e.state === 'progressing').map((e) => e.path));
      entry.path = uniquePath(folder, entry.filename, reserved);
      entry.filename = path.basename(entry.path);
      item.setSavePath(entry.path);
    }
    this.entries.unshift(entry);
    this.entries.length = Math.min(this.entries.length, MAX_ENTRIES);
    this.items.set(entry.id, item);
    this.emit('started', entry);

    let lastBytes = 0;
    let lastTime = Date.now();
    item.on('updated', (_e, state) => {
      const now = Date.now();
      if (now - lastTime >= 1000) {
        entry.speed = Math.max(0, ((item.getReceivedBytes() - lastBytes) * 1000) / (now - lastTime));
        lastBytes = item.getReceivedBytes();
        lastTime = now;
      }
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes();
      entry.paused = item.isPaused();
      entry.canResume = item.canResume();
      if (!entry.path && item.getSavePath()) {
        entry.path = item.getSavePath();
        entry.filename = path.basename(entry.path);
      }
      entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      this.changed();
    });
    item.once('done', (_e, state) => {
      this.items.delete(entry.id);
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes() || entry.received;
      entry.paused = false;
      entry.canResume = false;
      entry.speed = 0;
      entry.state = state;
      if (item.getSavePath()) {
        entry.path = item.getSavePath();
        entry.filename = path.basename(entry.path);
      }
      if (state === 'completed') markFromInternet(entry.path, isPrivate ? '' : entry.url);
      // Pressing Cancel on the Save As box isn't a download worth listing.
      if (state === 'cancelled' && !entry.path) this.entries = this.entries.filter((e) => e !== entry);
      this.save();
      this.changed();
    });
    this.onStarted?.(contents, item);
    this.save();
    this.changed();
  }

  async action(id, name) {
    const entry = this.entries.find((e) => e.id === id);
    if (!entry) return;
    const item = this.items.get(id);
    if (name === 'pause' && item) item.pause();
    if (name === 'resume' && item?.canResume()) item.resume();
    if (name === 'cancel' && item) item.cancel();
    if (name === 'remove' && !item) {
      this.entries = this.entries.filter((e) => e !== entry);
      this.save();
    }
    if (name === 'show' && entry.path && fs.existsSync(entry.path)) this.showInFolder(entry.path);
    if (name === 'open' && entry.state === 'completed') {
      entry.missing = !fs.existsSync(entry.path);
      if (!entry.missing && (!isRisky(entry.path) || await this.confirmOpen(entry))) {
        await this.openPath(entry.path);
      }
    }
    if (item && (name === 'pause' || name === 'resume')) entry.paused = item.isPaused();
    this.changed();
  }

  clearFinished() {
    this.entries = this.entries.filter((e) => this.items.has(e.id));
    this.save();
    this.changed();
  }

  cancelAll() {
    for (const item of this.items.values()) item.cancel();
  }

  flush() {
    clearTimeout(this.pushTimer);
    this.pushTimer = null;
    this.save();
    this.file.flush();
  }
}

module.exports = { Downloads, isRisky };
