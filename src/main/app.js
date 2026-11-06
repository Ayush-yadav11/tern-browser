'use strict';

const path = require('node:path');
const { app, BaseWindow, Menu, WebContentsView, dialog, ipcMain, session, shell: electronShell } = require('electron');
const { applyFlags } = require('./flags');
const { AdBlock } = require('./adblock');
const { Downloads } = require('./downloads');
const { Library } = require('./library');
const { Tabs } = require('./tabs');
const { Updater } = require('./updater');
const { DEFAULTS, clean, JsonFile } = require('./settings');
const { SEARCH_ENGINES, hostOf, isWebUrl, resolveInput } = require('./url');

applyFlags(app);

const SHELL_DIR = path.join(__dirname, '..', 'shell');
const SAFE_PERMISSIONS = new Set(['fullscreen', 'clipboard-sanitized-write', 'pointerLock', 'storage-access', 'top-level-storage-access', 'mediaKeySystem']);
const ASK_PERMISSIONS = {
  notifications: 'show notifications',
  media: 'use your camera or microphone',
  geolocation: 'see your location',
  'clipboard-read': 'read your clipboard',
  midi: 'use MIDI devices',
  midiSysex: 'use MIDI devices',
};
// Chromium's own user agent with the Electron and app tokens removed, because some sites
// refuse unknown browsers. Tern still sends the real Chromium version it runs on.
const cleanUserAgent = (ua) => ua.replace(/\s(?:Tern|tern-browser|Electron)\/\S+/g, '');

function configureTabSession(ses, getWindow) {
  const grants = new Map();
  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  };
  ses.setUserAgent(cleanUserAgent(ses.getUserAgent()));
  ses.setSpellCheckerEnabled(false);
  ses.setPermissionCheckHandler((_wc, permission, origin) => (
    SAFE_PERMISSIONS.has(permission) || grants.get(`${originOf(origin)}|${permission}`) === true
  ));
  ses.setPermissionRequestHandler(async (wc, permission, callback, details) => {
    if (SAFE_PERMISSIONS.has(permission)) return callback(true);
    const purpose = ASK_PERMISSIONS[permission];
    const origin = originOf(details.requestingUrl ?? wc.getURL());
    if (!purpose || !origin) return callback(false);
    const key = `${origin}|${permission}`;
    if (grants.has(key)) return callback(grants.get(key));
    const { response } = await dialog.showMessageBox(getWindow(), {
      type: 'question',
      buttons: ['Block', 'Allow'],
      defaultId: 0,
      cancelId: 0,
      message: `${hostOf(origin)} wants to ${purpose}.`,
      detail: 'Your choice lasts until Tern is closed.',
    });
    grants.set(key, response === 1);
    return callback(response === 1);
  });
}

// Everything that lives for one running browser. Tests call this directly with a temp profile.
async function start({ userData, show = true, openUrl = '' } = {}) {
  if (userData) app.setPath('userData', userData);
  await app.whenReady();
  Menu.setApplicationMenu(null);

  const profile = app.getPath('userData');
  const settingsFile = new JsonFile(path.join(profile, 'settings.json'));
  const sessionFile = new JsonFile(path.join(profile, 'session.json'));
  const windowFile = new JsonFile(path.join(profile, 'window.json'));
  let settings = clean(settingsFile.read());
  const saved = windowFile.read();

  const win = new BaseWindow({
    width: saved?.width ?? 1280,
    height: saved?.height ?? 800,
    x: saved?.x,
    y: saved?.y,
    minWidth: 520,
    minHeight: 360,
    show: false,
    title: 'Tern',
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
    backgroundColor: '#14161a',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#14161a', symbolColor: '#e6e8ec', height: 40 },
  });
  if (saved?.maximized) win.maximize();

  const shellView = new WebContentsView({
    webPreferences: {
      preload: path.join(SHELL_DIR, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  shellView.setBackgroundColor('#14161a');
  win.contentView.addChildView(shellView);
  const shell = shellView.webContents;
  const layoutShell = () => {
    const { width, height } = win.getContentBounds();
    shellView.setBounds({ x: 0, y: 0, width, height });
    if (tabs.fullscreen && tabs.active?.view) tabs.active.view.setBounds(tabs.fullBounds());
  };

  const tabSession = session.fromPartition('persist:tern');
  configureTabSession(tabSession, () => win);

  const send = (channel, payload) => {
    if (!shell.isDestroyed()) shell.send(channel, payload);
  };

  let stateTimer = null;
  const pushState = () => {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      const active = tabs.active;
      const host = hostOf(active?.url ?? '');
      send('tern:state', {
        ...tabs.publicState(),
        fullscreen: tabs.fullscreen,
        settings,
        about: { version: app.getVersion(), chromium: process.versions.chrome },
        update: updater.state,
        shield: {
          enabled: adblock.enabled,
          host,
          allowed: adblock.isSiteAllowed(host),
          filtersUpdatedAt: adblock.updatedAt,
        },
        searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
      });
      if (!win.isDestroyed()) win.setTitle(active?.title ? `${active.title} - Tern` : 'Tern');
    }, 16);
  };

  const saveSession = () => sessionFile.write(tabs.serialize());
  const update = (patch) => {
    settings = clean(patch, settings);
    settingsFile.write(settings);
    adblock.setEnabled(settings.adblock);
    pushState();
  };

  const shortcut = (input) => {
    if (input.type !== 'keyDown') return false;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    const combo = `${ctrl ? 'c' : ''}${input.shift ? 's' : ''}${input.alt ? 'a' : ''}+${key}`;
    const id = tabs.activeId;
    const actions = {
      'c+t': () => {
        tabs.create();
        focusAddress();
      },
      'c+w': () => tabs.close(id),
      'cs+t': () => tabs.reopenClosed(),
      'c+l': () => focusAddress(),
      'a+d': () => focusAddress(),
      'c+r': () => tabs.reload(id),
      '+f5': () => tabs.reload(id),
      'cs+r': () => tabs.active?.view?.webContents.reloadIgnoringCache(),
      'c+tab': () => tabs.cycle(1),
      'cs+tab': () => tabs.cycle(-1),
      'a+arrowleft': () => tabs.back(id),
      'a+arrowright': () => tabs.forward(id),
      'c+f': () => send('tern:find-open'),
      'c+d': () => toggleBookmark(),
      'cs+b': () => update({ bookmarksBar: !settings.bookmarksBar }),
      'cs+o': () => send('tern:open-panel', { panel: 'library', tab: 'bookmarks' }),
      'c+h': () => send('tern:open-panel', { panel: 'library', tab: 'history' }),
      'c+j': () => send('tern:open-panel', { panel: 'downloads' }),
      'c+=': () => tabs.zoom(0.5),
      'cs++': () => tabs.zoom(0.5),
      'c+-': () => tabs.zoom(-0.5),
      'c+0': () => tabs.zoom(0),
      '+f11': () => win.setFullScreen(!win.isFullScreen()),
      '+f12': () => tabs.active?.view?.webContents.toggleDevTools(),
    };
    if (ctrl && /^[1-9]$/.test(key) && !input.shift && !input.alt) {
      const target = key === '9' ? tabs.tabs.at(-1) : tabs.tabs[Number(key) - 1];
      if (target) tabs.activate(target.id);
      return true;
    }
    const action = actions[combo];
    if (!action) return false;
    action();
    return true;
  };
  const focusAddress = () => {
    shell.focus();
    send('tern:focus-address');
  };

  const tabs = new Tabs({
    window: win,
    session: tabSession,
    onShortcut: shortcut,
    getSleepMinutes: () => settings.sleepMinutes,
  });

  let blockedSinceSave = 0;
  const adblock = new AdBlock({
    session: tabSession,
    userData: profile,
    getSettings: () => settings,
    onBlocked: (contentsId) => {
      const tab = tabs.byContentsId(contentsId);
      if (tab) tab.blocked += 1;
      settings.totalBlocked += 1;
      blockedSinceSave += 1;
      pushState();
    },
  });
  adblock.setEnabled(settings.adblock);
  tabSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, '..', 'page', 'youtube-preload.js') });
  ipcMain.on('tern:block-youtube-ads', (event, host) => {
    event.returnValue = adblock.enabled && !adblock.isSiteAllowed(String(host));
  });

  const updater = new Updater({ isAutomatic: () => settings.autoUpdate });
  updater.on('changed', pushState);

  const library = new Library(profile);
  const pushBookmarks = () => send('tern:bookmarks', library.bookmarks);
  library.on('bookmarks', pushBookmarks);
  library.on('history', () => send('tern:history-changed'));
  tabs.on('visit', (url, title) => {
    if (settings.saveHistory) library.recordVisit(url, title);
  });
  tabs.on('title', (url, title) => {
    if (settings.saveHistory) library.updateTitle(url, title);
  });

  // Keeps the icon inside the bookmark, so the bookmarks bar doesn't contact every site on launch.
  const fetchBookmarkIcon = async (bookmark, source) => {
    if (!source) return;
    if (source.startsWith('data:')) {
      library.setBookmarkIcon(bookmark.id, source);
      return;
    }
    const response = await tabSession.fetch(source);
    const type = response.headers.get('content-type') ?? '';
    if (!response.ok || !type.startsWith('image/')) return;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 32 * 1024) return;
    library.setBookmarkIcon(bookmark.id, `data:${type.split(';')[0]};base64,${bytes.toString('base64')}`);
  };
  const toggleBookmark = () => {
    const tab = tabs.active;
    if (!tab?.url) return;
    const added = library.toggleBookmark({ url: tab.url, title: tab.title });
    if (added) fetchBookmarkIcon(added, tab.favicon).catch(() => {});
  };

  const downloads = new Downloads({
    session: tabSession,
    profile,
    getFolder: () => app.getPath('downloads'),
    shouldAsk: () => settings.askDownloadPath,
    onStarted: (contents) => tabs.afterDownloadStarted(contents),
    openPath: (file) => electronShell.openPath(file),
    showInFolder: (file) => electronShell.showItemInFolder(file),
    confirmOpen: async (entry) => {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        buttons: ['Cancel', 'Open anyway'],
        defaultId: 0,
        cancelId: 0,
        message: `Open ${entry.filename}?`,
        detail: `This type of file can run programs on your PC. Only open it if you trust where it came from.\n\n${entry.url}`,
      });
      return response === 1;
    },
  });
  const pushDownloads = () => send('tern:downloads', downloads.list());
  downloads.on('changed', pushDownloads);
  downloads.on('started', () => send('tern:download-started'));

  // Suggestions float above the page, which only a separate view can do. It costs a small
  // renderer, so it's created on first use and dropped again after a minute of not being needed.
  const SUGGEST_ROW = 32;
  const SUGGEST_IDLE_MS = 60 * 1000;
  let suggestView = null;
  let suggestLoaded = null;
  let suggestTimer = null;
  let suggestPayload = null;
  const showSuggestions = (rect) => {
    clearTimeout(suggestTimer);
    if (!suggestView) {
      suggestView = new WebContentsView({
        webPreferences: {
          preload: path.join(SHELL_DIR, 'suggest-preload.js'),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          spellcheck: false,
        },
      });
      suggestView.setBackgroundColor('#00000000');
      suggestLoaded = suggestView.webContents.loadFile(path.join(SHELL_DIR, 'suggest.html'));
    }
    const view = suggestView;
    const { width: winWidth, height: winHeight } = win.getContentBounds();
    const height = suggestPayload.items.length * SUGGEST_ROW + 10;
    const width = Math.max(120, Math.min(Math.max(rect.width, 420), winWidth - rect.x - 8));
    const below = rect.y + rect.height + 2;
    const y = below + height > winHeight ? Math.max(0, rect.y - height - 2) : below;
    view.setBounds({ x: Math.round(rect.x), y: Math.round(y), width: Math.round(width), height });
    win.contentView.addChildView(view);
    suggestLoaded.then(() => {
      if (suggestView === view) view.webContents.send('tern:suggest-show', suggestPayload);
    }).catch(() => {});
  };
  const hideSuggestions = () => {
    if (!suggestView) return;
    win.contentView.removeChildView(suggestView);
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(destroySuggestions, SUGGEST_IDLE_MS);
    suggestTimer.unref?.();
  };
  const destroySuggestions = () => {
    clearTimeout(suggestTimer);
    if (!suggestView) return;
    const view = suggestView;
    suggestView = null;
    if (!win.isDestroyed()) win.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  };
  const suggestionsFor = (text) => {
    const url = resolveInput(text, settings.searchEngine);
    if (!url) return [];
    const engine = SEARCH_ENGINES[settings.searchEngine];
    const isSearch = url.startsWith(engine.url);
    const first = isSearch
      ? { kind: 'search', label: text, sub: `Search ${engine.name}`, value: text }
      : { kind: 'go', label: url, sub: 'Go to this address', value: url };
    const matches = library.suggest(text)
      .filter((m) => m.url !== url)
      .map((m) => ({ kind: m.kind, label: m.title || m.url, sub: m.title ? m.url : '', value: m.url }));
    return [first, ...matches];
  };
  // Tabs brought in while the list is open would otherwise cover it.
  tabs.on('attached', () => {
    if (suggestView && win.contentView.children.includes(suggestView)) win.contentView.addChildView(suggestView);
  });

  tabs.on('changed', () => {
    pushState();
    saveSession();
  });
  tabs.on('fullscreen', pushState);
  tabs.on('found', (result) => send('tern:found', {
    active: result.activeMatchOrdinal,
    total: result.matches,
  }));
  tabs.on('empty', () => {
    tabs.create();
    focusAddress();
  });

  const fromShell = (handler) => (event, ...args) => {
    if (event.sender !== shell) throw new Error('Rejected IPC from outside the browser UI');
    return handler(...args);
  };
  const handlers = {
    'tern:ready': () => {
      pushState();
      pushBookmarks();
      pushDownloads();
    },
    'tern:update-check': () => updater.check(),
    'tern:update-install': () => updater.install(),
    'tern:open': (url, options) => {
      if (!isWebUrl(url)) return;
      if (options?.newTab) tabs.create(url, { activate: !options.background });
      else tabs.navigate(tabs.activeId, url);
    },
    'tern:toggle-bookmark': () => toggleBookmark(),
    'tern:bookmark-rename': (id, title) => library.renameBookmark(id, title),
    'tern:bookmark-remove': (id) => library.removeBookmark(id),
    'tern:bookmark-move': (id, index) => library.moveBookmark(id, index),
    'tern:history-search': (query) => library.searchHistory(query),
    'tern:history-remove': (url) => library.removeHistory(url),
    'tern:history-clear': () => library.clearHistory(),
    'tern:downloads-refresh': () => downloads.refresh(),
    'tern:download-action': (id, action) => downloads.action(id, action),
    'tern:downloads-clear': () => downloads.clearFinished(),
    'tern:suggest': (text, rect, theme) => {
      const items = suggestionsFor(String(text ?? '').slice(0, 2048));
      if (!items.length || !rect) {
        hideSuggestions();
        return [];
      }
      suggestPayload = { items, selected: 0, theme };
      showSuggestions(rect);
      return items;
    },
    'tern:suggest-select': (index, rect) => {
      if (!suggestPayload || !rect) return;
      suggestPayload = { ...suggestPayload, selected: index };
      showSuggestions(rect);
    },
    'tern:suggest-hide': () => hideSuggestions(),
    'tern:new-tab': () => {
      tabs.create();
      focusAddress();
    },
    'tern:activate': (id) => tabs.activate(id),
    'tern:close': (id) => tabs.close(id),
    'tern:move': (id, index) => tabs.move(id, index),
    'tern:navigate': (id, input) => {
      const url = resolveInput(input, settings.searchEngine);
      if (url) tabs.navigate(id, url);
    },
    'tern:back': (id) => tabs.back(id),
    'tern:forward': (id) => tabs.forward(id),
    'tern:reload': (id) => tabs.reload(id),
    'tern:stop': (id) => tabs.stop(id),
    'tern:home': (id) => tabs.goHome(id),
    'tern:content-bounds': (rect) => {
      const n = (v) => Math.max(0, Math.round(Number(v) || 0));
      tabs.setBounds({ x: n(rect?.x), y: n(rect?.y), width: n(rect?.width), height: n(rect?.height) });
    },
    'tern:set-overlay': ({ color, symbolColor, height }) => {
      const hex = /^#[0-9a-f]{6}$/i;
      if (hex.test(color) && hex.test(symbolColor) && !win.isDestroyed()) {
        win.setTitleBarOverlay({ color, symbolColor, height: Math.max(28, Math.min(48, Number(height) || 40)) });
        win.setBackgroundColor(color);
        shellView.setBackgroundColor(color);
      }
    },
    'tern:settings': (patch) => {
      const { totalBlocked, allowedSites, ...safe } = patch ?? {};
      update(safe);
    },
    'tern:reset-settings': () => {
      const { adblock: on, allowedSites, totalBlocked, saveHistory, askDownloadPath, autoUpdate } = settings;
      settings = clean({ adblock: on, allowedSites, totalBlocked, saveHistory, askDownloadPath, autoUpdate }, DEFAULTS);
      settingsFile.write(settings);
      pushState();
    },
    'tern:toggle-site': () => {
      const host = hostOf(tabs.active?.url ?? '');
      if (!host) return;
      const allowed = settings.allowedSites.includes(host)
        ? settings.allowedSites.filter((h) => h !== host)
        : [...settings.allowedSites, host];
      update({ allowedSites: allowed });
      tabs.reload(tabs.activeId);
    },
    'tern:find': (text, options) => {
      const wc = tabs.active?.view?.webContents;
      if (!wc) return;
      if (text) wc.findInPage(String(text), { forward: options?.forward !== false, findNext: Boolean(options?.next) });
      else wc.stopFindInPage('clearSelection');
    },
    'tern:find-stop': () => tabs.active?.view?.webContents.stopFindInPage('clearSelection'),
    'tern:focus-page': () => tabs.active?.view?.webContents.focus(),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, fromShell(handler));
  }
  ipcMain.handle('tern:suggest-pick', (event, index) => {
    if (event.sender !== suggestView?.webContents) throw new Error('Rejected IPC from outside the suggestions list');
    send('tern:suggest-picked', index);
  });

  shell.on('before-input-event', (event, input) => {
    if (shortcut(input)) event.preventDefault();
  });
  shell.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) tabs.create(url);
    return { action: 'deny' };
  });
  shell.on('will-navigate', (event) => event.preventDefault());

  win.on('resize', layoutShell);
  win.on('maximize', layoutShell);
  win.on('unmaximize', layoutShell);
  win.on('leave-full-screen', () => {
    if (tabs.fullscreen) tabs.active?.view?.webContents.executeJavaScript('document.exitFullscreen?.()').catch(() => {});
    layoutShell();
  });
  win.on('enter-full-screen', layoutShell);
  const saveWindow = () => {
    if (win.isDestroyed() || win.isFullScreen()) return;
    windowFile.write({ ...win.getNormalBounds(), maximized: win.isMaximized() });
  };
  win.on('moved', saveWindow);
  win.on('resized', saveWindow);
  win.on('maximize', saveWindow);
  win.on('unmaximize', saveWindow);

  const flushAll = () => {
    if (blockedSinceSave) settingsFile.write(settings);
    settingsFile.flush();
    sessionFile.flush();
    windowFile.flush();
    library.flush();
    downloads.flush();
  };
  win.on('close', (event) => {
    const active = downloads.activeCount;
    if (active) {
      const choice = dialog.showMessageBoxSync(win, {
        type: 'warning',
        buttons: ['Keep downloading', 'Cancel downloads and quit'],
        defaultId: 0,
        cancelId: 0,
        message: `${active} download${active === 1 ? ' is' : 's are'} still running.`,
        detail: 'Quitting now cancels them.',
      });
      if (choice === 0) {
        event.preventDefault();
        return;
      }
      downloads.cancelAll();
    }
    saveSession();
    flushAll();
    destroySuggestions();
    updater.dispose();
    tabs.dispose();
  });
  win.on('closed', () => {
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
    ipcMain.removeHandler('tern:suggest-pick');
    ipcMain.removeAllListeners('tern:block-youtube-ads');
  });

  await shell.loadFile(path.join(SHELL_DIR, 'index.html'));
  layoutShell();

  const previous = sessionFile.read();
  const restored = Array.isArray(previous?.tabs) ? previous.tabs.filter((t) => isWebUrl(t?.url)) : [];
  if (restored.length) {
    restored.forEach((t) => tabs.create(t.url, { activate: false, title: String(t.title ?? '') }));
    tabs.activate(tabs.tabs[Math.min(previous.activeIndex ?? 0, restored.length - 1)]?.id ?? tabs.tabs[0].id);
  }
  if (openUrl) tabs.create(openUrl);
  else if (!restored.length) {
    tabs.create();
    focusAddress();
  }
  if (show) win.show();
  pushState();

  updater.start();
  setTimeout(() => adblock.refreshIfStale().catch(() => {}), 30 * 1000).unref?.();

  return {
    win,
    shell,
    tabs,
    adblock,
    library,
    downloads,
    updater,
    tabSession,
    suggestionsVisible: () => Boolean(suggestView) && win.contentView.children.includes(suggestView),
    getSettings: () => settings,
    updateSettings: update,
    flushAll,
  };
}

module.exports = { start };
