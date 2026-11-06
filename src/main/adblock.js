'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { net, webContents } = require('electron');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { hostOf, isYouTubeHost } = require('./url');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BUNDLED = path.join(__dirname, '..', '..', 'assets', 'engine.bin');

function loadEngine(cacheFile) {
  for (const file of [cacheFile, BUNDLED]) {
    try {
      const engine = ElectronBlocker.deserialize(new Uint8Array(fs.readFileSync(file)));
      return { engine, file, updatedAt: fs.statSync(file).mtimeMs };
    } catch {
      // Missing file, or written by a different engine version: try the next one.
    }
  }
  throw new Error('No usable ad-block filter data. Run: npm run update-filters');
}

class AdBlock {
  constructor({ session, userData, getSettings, onBlocked }) {
    this.session = session;
    this.getSettings = getSettings;
    this.cacheFile = path.join(userData, 'filters', 'engine.bin');
    const { engine, file, updatedAt } = loadEngine(this.cacheFile);
    this.engine = engine;
    this.source = file;
    this.updatedAt = updatedAt;
    this.enabled = false;
    this.scriptsRun = new WeakMap();
    this.wrap(onBlocked);
  }

  isSiteAllowed(host) {
    return Boolean(host) && this.getSettings().allowedSites.includes(host);
  }

  // The engine has no per-site switch, so requests from allowed pages skip it here.
  // BlockingContext calls these through the instance, so replacing them is enough.
  wrap(onBlocked) {
    const { engine } = this;
    const before = engine.onBeforeRequest;
    const inject = engine.onInjectCosmeticFilters;
    const pageUrl = (id) => {
      const wc = id ? webContents.fromId(id) : null;
      return wc && !wc.isDestroyed() ? wc.getURL() : '';
    };

    engine.onBeforeRequest = (details, callback) => {
      const page = pageUrl(details.webContentsId);
      if (this.isSiteAllowed(hostOf(page))) return callback({});
      // Electron often leaves referrer empty, and third-party filters need the page.
      if (!details.referrer && page) details.referrer = page;
      return before(details, callback);
    };
    engine.onInjectCosmeticFilters = async (event, url, msg) => {
      const host = hostOf(event.sender.getURL());
      if (this.isSiteAllowed(host)) return undefined;
      return inject(this.guardScripts(event, host), url, msg);
    };
    engine.on('request-blocked', (request) => onBlocked(request.tabId, request.url));
    engine.on('request-redirected', (request) => onBlocked(request.tabId, request.url));
  }

  // The engine injects its page scripts into the main page once for every frame that asks.
  // Running one twice crashes the page, so each runs once per page. YouTube gets none at
  // all, because they stop its player appearing and youtube-preload.js does that job.
  guardScripts(event, host) {
    const { sender } = event;
    let done = this.scriptsRun.get(sender);
    if (!done) {
      done = new Set();
      this.scriptsRun.set(sender, done);
      sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) done.clear();
      });
    }
    return {
      frameId: event.frameId,
      processId: event.processId,
      sender: {
        insertCSS: (css, options) => sender.insertCSS(css, options),
        executeJavaScript: async (code, gesture) => {
          if (isYouTubeHost(host) || done.has(code)) return;
          done.add(code);
          await sender.executeJavaScript(code, gesture).catch(() => {});
        },
      },
    };
  }

  setEnabled(on) {
    if (on === this.enabled) return;
    if (on) this.engine.enableBlockingInSession(this.session);
    else this.engine.disableBlockingInSession(this.session);
    this.enabled = on;
  }

  // New filters are saved for the next launch rather than swapped into a running engine.
  async refreshIfStale(now = Date.now()) {
    if (now - this.updatedAt < WEEK_MS) return false;
    const fresh = await ElectronBlocker.fromPrebuiltAdsAndTracking((...a) => net.fetch(...a));
    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    fs.writeFileSync(this.cacheFile, fresh.serialize());
    return true;
  }
}

module.exports = { AdBlock };
