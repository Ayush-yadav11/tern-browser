'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SEARCH_ENGINES } = require('./url');

const THEMES = ['midnight', 'paper', 'lagoon', 'moss', 'ember'];
const PROXY_SERVER = /^(?:socks5|socks4|http|https):\/\/[^\s/:@]+:\d{1,5}$/i;
const TOOLBAR_IDS = ['back', 'forward', 'reload', 'home', 'url', 'star', 'shield', 'library', 'downloads', 'customize', 'menu'];
const LOCKED_ITEMS = new Set(['url', 'customize', 'menu']);
const HIDDEN_BY_DEFAULT = new Set(['home']);

const DEFAULTS = {
  theme: 'midnight',
  accent: '',
  tabPosition: 'top',
  toolbarPosition: 'top',
  toolbarItems: TOOLBAR_IDS.map((id) => ({ id, visible: !HIDDEN_BY_DEFAULT.has(id) })),
  bookmarksBar: true,
  saveHistory: true,
  askDownloadPath: false,
  autoUpdate: true,
  sideCollapse: true,
  httpsOnly: true,
  proxyEnabled: false,
  proxyServer: '',
  proxyUsername: '',
  proxyPassword: '',
  compact: false,
  radius: 8,
  customCss: '',
  searchEngine: 'ddg-noai',
  sleepMinutes: 10,
  adblock: true,
  allowedSites: [],
  totalBlocked: 0,
};

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

function clean(input, base = DEFAULTS) {
  const s = { ...base };
  if (!input || typeof input !== 'object') return s;
  if ('theme' in input) s.theme = pick(input.theme, THEMES, s.theme);
  if ('accent' in input) {
    s.accent = /^#[0-9a-f]{6}$/i.test(input.accent) ? input.accent.toLowerCase() : '';
  }
  if ('tabPosition' in input) s.tabPosition = pick(input.tabPosition, ['top', 'left', 'right'], s.tabPosition);
  if ('toolbarPosition' in input) s.toolbarPosition = pick(input.toolbarPosition, ['top', 'bottom'], s.toolbarPosition);
  if ('compact' in input) s.compact = Boolean(input.compact);
  if ('adblock' in input) s.adblock = Boolean(input.adblock);
  if ('bookmarksBar' in input) s.bookmarksBar = Boolean(input.bookmarksBar);
  if ('saveHistory' in input) s.saveHistory = Boolean(input.saveHistory);
  if ('askDownloadPath' in input) s.askDownloadPath = Boolean(input.askDownloadPath);
  if ('autoUpdate' in input) s.autoUpdate = Boolean(input.autoUpdate);
  if ('sideCollapse' in input) s.sideCollapse = Boolean(input.sideCollapse);
  if ('httpsOnly' in input) s.httpsOnly = Boolean(input.httpsOnly);
  // An unusable server stays switched on and just fails to connect, which never exposes the real IP.
  if ('proxyEnabled' in input) s.proxyEnabled = Boolean(input.proxyEnabled);
  if ('proxyServer' in input) s.proxyServer = PROXY_SERVER.test(input.proxyServer) ? input.proxyServer : '';
  if ('proxyUsername' in input && typeof input.proxyUsername === 'string') s.proxyUsername = input.proxyUsername.slice(0, 256);
  if ('proxyPassword' in input && typeof input.proxyPassword === 'string') s.proxyPassword = input.proxyPassword;
  if ('radius' in input && Number.isFinite(input.radius)) {
    s.radius = Math.min(16, Math.max(0, Math.round(input.radius)));
  }
  if ('customCss' in input && typeof input.customCss === 'string') s.customCss = input.customCss.slice(0, 20000);
  if ('searchEngine' in input) s.searchEngine = pick(input.searchEngine, Object.keys(SEARCH_ENGINES), s.searchEngine);
  if ('sleepMinutes' in input) s.sleepMinutes = pick(input.sleepMinutes, [0, 5, 10, 30, 60], s.sleepMinutes);
  if ('totalBlocked' in input && Number.isFinite(input.totalBlocked)) s.totalBlocked = Math.max(0, input.totalBlocked);
  if (Array.isArray(input.allowedSites)) {
    s.allowedSites = [...new Set(input.allowedSites.filter((h) => typeof h === 'string' && h.length < 254))];
  }
  if (Array.isArray(input.toolbarItems)) {
    // Keep every known item exactly once so a bad file can never lose a control.
    const seen = new Set();
    const items = [];
    for (const item of input.toolbarItems) {
      if (!item || !TOOLBAR_IDS.includes(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      items.push({ id: item.id, visible: LOCKED_ITEMS.has(item.id) || Boolean(item.visible) });
    }
    // Buttons added by a newer version go next to their usual neighbour, not at the far end.
    TOOLBAR_IDS.forEach((id, order) => {
      if (seen.has(id)) return;
      const before = items.findIndex((item) => item.id === TOOLBAR_IDS[order - 1]);
      items.splice(before + 1, 0, { id, visible: !HIDDEN_BY_DEFAULT.has(id) });
    });
    s.toolbarItems = items;
  }
  return s;
}

class JsonFile {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.pending = null;
  }

  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  write(value) {
    this.pending = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this.timer);
    if (this.pending === null) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.pending, null, 2));
    fs.renameSync(tmp, this.file);
    this.pending = null;
  }
}

module.exports = { DEFAULTS, THEMES, PROXY_SERVER, clean, JsonFile };
