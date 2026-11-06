'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const BUSY = new Set(['checking', 'downloading', 'ready']);

// Downloads new versions in the background and installs them on restart. The packaging
// script writes the feed address to resources/app-update.yml, so builds run from source
// or made without a feed simply have updates switched off.
class Updater extends EventEmitter {
  constructor({ isAutomatic }) {
    super();
    this.isAutomatic = isAutomatic;
    const configured = app.isPackaged && !process.env.TERN_NO_UPDATE
      && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
    this.state = { status: configured ? 'idle' : 'off', version: '', percent: 0, message: '' };
    this.engine = null;
    this.timers = [];
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('changed');
  }

  // Loaded on first use, which keeps it out of the time it takes Tern to open.
  load() {
    if (this.engine) return this.engine;
    const { autoUpdater } = require('electron-updater');
    autoUpdater.logger = null;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking', message: '' }));
    autoUpdater.on('update-not-available', () => this.set({ status: 'current', percent: 0 }));
    autoUpdater.on('update-available', (info) => this.set({ status: 'downloading', version: info.version, percent: 0 }));
    autoUpdater.on('download-progress', (p) => this.set({ status: 'downloading', percent: Math.round(p.percent) }));
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version, percent: 100 }));
    autoUpdater.on('error', (error) => {
      if (this.state.status !== 'ready') this.set({ status: 'error', message: String(error?.message ?? error).split('\n')[0].slice(0, 200) });
    });
    this.engine = autoUpdater;
    return autoUpdater;
  }

  async check() {
    if (this.state.status === 'off' || BUSY.has(this.state.status)) return;
    try {
      await this.load().checkForUpdates();
    } catch {
      // The 'error' listener has already recorded it.
    }
  }

  start() {
    if (this.state.status === 'off') return;
    const automatic = () => {
      if (this.isAutomatic()) this.check();
    };
    const first = setTimeout(automatic, FIRST_CHECK_MS);
    const repeat = setInterval(automatic, CHECK_EVERY_MS);
    first.unref?.();
    repeat.unref?.();
    this.timers = [first, repeat];
  }

  install() {
    if (this.state.status === 'ready') this.engine.quitAndInstall(true, true);
  }

  dispose() {
    this.timers.forEach(clearTimeout);
  }
}

module.exports = { Updater };
