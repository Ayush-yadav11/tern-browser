'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BaseWindow, Menu, WebContentsView, dialog, ipcMain, safeStorage, session, shell: electronShell } = require('electron');
const { applyFlags } = require('./flags');
const { AdBlock } = require('./adblock');
const { Downloads } = require('./downloads');
const { defaultAppsPage, defaultBrowserStatus } = require('./default-browser');
const { Library } = require('./library');
const { EXTRACT_TEXT, PageIndex } = require('./page-index');
const { Tabs } = require('./tabs');
const { Tor, torPath } = require('./tor');
const { Updater } = require('./updater');
const { findBrowsers, readBookmarksFile, toBookmarksHtml } = require('./bookmarks-io');
const { DEFAULTS, PROXY_SERVER, clean, JsonFile } = require('./settings');
const { SEARCH_ENGINES, SEARCH_SHORTCUTS, hostOf, isLocalHost, isWebUrl, parseShortcut, resolveInput } = require('./url');

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

// Nothing listens here. A session pointed at it reaches nothing instead of going direct.
const NOWHERE = { proxyRules: 'socks5://127.0.0.1:1', proxyBypassRules: '<-loopback>' };

function configureTabSession(ses, getWindow, { canAsk = true } = {}) {
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
    if (!purpose || !origin || !canAsk) return callback(false);
    const key = `${origin}|${permission}`;
    if (grants.has(key)) return callback(grants.get(key));
    const { response } = await dialog.showMessageBox(getWindow(wc), {
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
  return grants;
}


async function start({ userData, show = true, openUrl = '' } = {}) {
  if (userData) app.setPath('userData', userData);
  await app.whenReady();
  Menu.setApplicationMenu(null);

  const profile = app.getPath('userData');
  const settingsFile = new JsonFile(path.join(profile, 'settings.json'));
  const sessionFile = new JsonFile(path.join(profile, 'session.json'));
  const windowFile = new JsonFile(path.join(profile, 'window.json'));
  let settings = clean(settingsFile.read());

  // One entry for each open window. Everything above and below openWindow is shared by them.
  const windows = new Set();
  const windowByShell = new Map();
  // A closing window can still have messages on the way. They're expected, and nothing happens.
  const retiredShells = new WeakSet();
  const closedTabs = [];
  const httpAllowed = new Set();
  let lastFocused = null;
  let torReady = false;
  let quitting = false;
  const currentWindow = () => (windows.has(lastFocused) ? lastFocused : [...windows].at(-1) ?? null);
  const allTabs = () => [...windows].flatMap((w) => w.tabs.tabs);
  const windowFor = (contents) => [...windows].find((w) => w.tabs.tabs.some((t) => (
    t.view?.webContents === contents || t.readerView?.webContents === contents
  ))) ?? currentWindow();
  const pushAll = () => {
    for (const w of windows) w.pushState();
  };
  const broadcast = (channel, payload) => {
    for (const w of windows) w.send(channel, payload);
  };

  const tabSession = session.fromPartition('persist:tern');
  const permissionChoices = configureTabSession(tabSession, (wc) => windowFor(wc)?.win);
  // Kept in memory only, and pointed nowhere before anything can load in it.
  const torSession = session.fromPartition('tern-tor');
  await torSession.setProxy(NOWHERE);
  configureTabSession(torSession, (wc) => windowFor(wc)?.win, { canAsk: false });
  const tor = new Tor({ exePath: torPath(app), dataDir: path.join(profile, 'tor') });

  // The stored password never goes to the interface, which only needs to know one is set.
  const visibleSettings = () => {
    const { proxyPassword, ...visible } = settings;
    return { ...visible, proxyHasPassword: Boolean(proxyPassword) };
  };

  // Tor-only windows aren't saved, like Tor tabs. Nothing is written once shutdown has saved.
  const saveSession = () => {
    if (quitting) return;
    sessionFile.write({ windows: [...windows].map((w) => w.serialize()).filter((w) => w.tabs.length) });
  };
  const update = (patch) => {
    settings = clean(patch, settings);
    settingsFile.write(settings);
    // Turning this off means the text goes too, not just that no more is collected.
    if (patch.indexPages === false) pageIndex.clear();
    adblock.setEnabled(settings.adblock);
    pushAll();
  };

  let blockedSinceSave = 0;
  const adblock = new AdBlock({
    session: tabSession,
    userData: profile,
    getSettings: () => settings,
    onBlocked: (contentsId) => {
      const tab = allTabs().find((t) => t.view?.webContents.id === contentsId);
      if (tab) tab.blocked += 1;
      settings.totalBlocked += 1;
      blockedSinceSave += 1;
      pushAll();
    },
  });
  adblock.setEnabled(settings.adblock);
  tabSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, '..', 'page', 'youtube-preload.js') });
  tabSession.registerPreloadScript({ type: 'frame', filePath: path.join(__dirname, '..', 'page', 'privacy-preload.js') });
  ipcMain.on('tern:gpc-enabled', (event) => {
    event.returnValue = settings.globalPrivacyControl;
  });
  for (const ses of [tabSession, torSession]) {
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (settings.globalPrivacyControl) details.requestHeaders['Sec-GPC'] = '1';
      callback({ requestHeaders: details.requestHeaders });
    });
  }
  ipcMain.on('tern:block-youtube-ads', (event, host) => {
    event.returnValue = adblock.enabled && !adblock.isSiteAllowed(String(host));
  });

  const updater = new Updater({ isAutomatic: () => settings.autoUpdate });
  updater.on('changed', pushAll);

  adblock.attach(torSession);

  const setTorReady = (ready) => {
    torReady = ready;
    for (const w of windows) w.tabs.setTorReady(ready);
  };
  const useTorPort = async (port) => {
    await torSession.setProxy({ proxyRules: `socks5://127.0.0.1:${port}`, proxyBypassRules: '<-loopback>' });
    await torSession.closeAllConnections();
    setTorReady(true);
  };
  tor.on('changed', pushAll);
  tor.on('ready', () => useTorPort(tor.port).catch(() => tor.stop()));
  tor.on('lost', () => setTorReady(false));
  // Closing the last Tor tab, in any window, ends that identity: cookies, cache and all.
  const endTorIfUnused = () => {
    if (allTabs().some((t) => t.tor)) return;
    tor.stop();
    setTorReady(false);
    torSession.setProxy(NOWHERE)
      .then(() => torSession.clearStorageData())
      .then(() => torSession.clearCache())
      .catch(() => {});
  };

  // A proxy that's on but unreachable fails the page rather than going direct.
  const applyProxy = async () => {
    const config = settings.proxyEnabled
      ? { proxyRules: settings.proxyServer || NOWHERE.proxyRules, proxyBypassRules: '<-loopback>' }
      : { mode: 'direct' };
    for (const ses of [tabSession, session.defaultSession]) {
      await ses.setProxy(config);
      await ses.closeAllConnections();
    }
    for (const w of windows) w.tabs.applyWebRtcPolicy();
  };
  await applyProxy();
  const onLogin = (event, _contents, _details, authInfo, callback) => {
    if (!authInfo.isProxy || !settings.proxyUsername) return;
    event.preventDefault();
    const password = settings.proxyPassword ? safeStorage.decryptString(Buffer.from(settings.proxyPassword, 'base64')) : '';
    callback(settings.proxyUsername, password);
  };
  app.on('login', onLogin);

  const library = new Library(profile);
  const pageIndex = new PageIndex(profile);
  const pageText = { delayMs: 1500, allowLocal: false };
  // Waits for the page to settle, and checks again in case it moved on in the meantime.
  const capturePageText = (tab, contents) => {
    if (tab.tor || !settings.indexPages || !settings.saveHistory) return;
    clearTimeout(tab.pageTextTimer);
    const { url } = tab;
    tab.pageTextTimer = setTimeout(async () => {
      if (contents.isDestroyed() || tab.tor || !settings.indexPages || tab.url !== url || tab.error) return;
      if (!isWebUrl(url) || (isLocalHost(hostOf(url)) && !pageText.allowLocal)) return;
      const text = await contents.executeJavaScriptInIsolatedWorld(1002, [{ code: EXTRACT_TEXT }]).catch(() => null);
      if (text && settings.indexPages && tab.url === url) pageIndex.add(url, tab.title, text);
    }, pageText.delayMs);
    tab.pageTextTimer.unref?.();
  };
  const importBookmarkFiles = (files) => {
    try {
      const entries = files.flatMap((file) => readBookmarksFile(file));
      return library.importBookmarks(entries);
    } catch (error) {
      return { error: error instanceof SyntaxError ? "That file doesn't look like a bookmarks file." : error.message };
    }
  };
  library.on('bookmarks', () => broadcast('tern:bookmarks', library.bookmarks));
  library.on('history', () => broadcast('tern:history-changed'));

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

  const downloads = new Downloads({
    session: tabSession,
    profile,
    getFolder: () => app.getPath('downloads'),
    shouldAsk: () => settings.askDownloadPath,
    onStarted: (contents) => {
      for (const w of windows) w.tabs.afterDownloadStarted(contents);
    },
    openPath: (file) => electronShell.openPath(file),
    showInFolder: (file) => electronShell.showItemInFolder(file),
    confirmOpen: async (entry) => {
      const { response } = await dialog.showMessageBox(currentWindow()?.win, {
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
  downloads.attachPrivate(torSession);
  downloads.on('changed', () => broadcast('tern:downloads', downloads.list()));
  downloads.on('started', () => broadcast('tern:download-started'));

  const suggestionsFor = (text) => {
    const url = resolveInput(text, settings.searchEngine);
    if (!url) return [];
    const engine = SEARCH_ENGINES[settings.searchEngine];
    const isSearch = url.startsWith(engine.url);
    const shortcut = parseShortcut(text);
    let first = isSearch
      ? { kind: 'search', label: text, sub: `Search ${engine.name}`, value: text }
      : { kind: 'go', label: url, sub: 'Go to this address', value: url };
    if (shortcut) {
      first = shortcut.query
        ? { kind: 'search', label: shortcut.query, sub: `Search ${shortcut.shortcut.name}`, value: text }
        : { kind: 'go', label: shortcut.shortcut.name, sub: 'Go to this site', value: text };
    }
    const matches = library.suggest(text)
      .filter((m) => m.url !== url)
      .map((m) => ({ kind: m.kind, label: m.title || m.url, sub: m.title ? m.url : '', value: m.url }));
    return [first, ...matches];
  };

  // A property so tests can check this without opening Windows Settings on screen.
  const system = { openExternal: (url) => electronShell.openExternal(url) };

  const flushAll = () => {
    if (blockedSinceSave) settingsFile.write(settings);
    settingsFile.flush();
    sessionFile.flush();
    windowFile.flush();
    library.flush();
    downloads.flush();
  };

  // Only asked when the browser is really closing, not for each of several windows.
  const downloadsMayStop = (parent) => {
    const active = downloads.activeCount;
    if (!active) return true;
    const choice = dialog.showMessageBoxSync(parent, {
      type: 'warning',
      buttons: ['Keep downloading', 'Cancel downloads and quit'],
      defaultId: 0,
      cancelId: 0,
      message: `${active} download${active === 1 ? ' is' : 's are'} still running.`,
      detail: 'Quitting now cancels them.',
    });
    if (choice === 0) return false;
    downloads.cancelAll();
    return true;
  };
  const beginShutdown = () => {
    saveSession();
    flushAll();
    updater.dispose();
    tor.stop();
    quitting = true;
  };
  // Exit and updates arrive here first, so every open window gets saved, not just the last.
  const onBeforeQuit = (event) => {
    if (quitting) return;
    if (!downloadsMayStop(currentWindow()?.win)) {
      event.preventDefault();
      return;
    }
    beginShutdown();
  };
  app.on('before-quit', onBeforeQuit);

  const whole = (value) => (Number.isFinite(value) ? Math.round(value) : undefined);
  const nextWindowPlace = () => {
    const from = currentWindow();
    if (!from) return windowFile.read();
    const { x, y, width, height } = from.win.getNormalBounds();
    return { x: x + 30, y: y + 30, width, height };
  };

  // Moves a tab with its page running. A new window opens first, so the tab is never without one.
  const moveTab = async (from, id, to = null, place = null) => {
    const tab = from.tabs.byId(id);
    if (!tab || from.tabs.fullscreen || to === from) return null;
    if (!to && from.tabs.tabs.length < 2) return null;
    const target = to ?? await openWindow({ empty: true, visible: false, place });
    if (!windows.has(from) || !from.tabs.byId(id)) {
      if (!to) target.win.close();
      return null;
    }
    from.tabs.detach(id);
    target.tabs.adopt(tab);
    if (target.win.isMinimized()) target.win.restore();
    target.win.show();
    target.tabs.contentsFor(tab)?.focus();
    if (!from.tabs.tabs.length) from.win.close();
    return target;
  };
  const contains = (rect, x, y) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;

  const listening = new Set();
  ipcMain.handle('tern:suggest-pick', (event, index) => {
    const owner = [...windows].find((w) => w.suggestContents() === event.sender);
    if (!owner) throw new Error('Rejected IPC from outside the suggestions list');
    owner.send('tern:suggest-picked', index);
  });

  const openWindow = async ({ saved = null, url = '', torTab = false, empty = false, visible = show, place: wanted = null } = {}) => {
    const place = wanted ?? saved?.bounds ?? nextWindowPlace();
    const win = new BaseWindow({
      width: whole(place?.width) ?? 1280,
      height: whole(place?.height) ?? 800,
      x: whole(place?.x),
      y: whole(place?.y),
      minWidth: 520,
      minHeight: 360,
      show: false,
      title: 'Tern',
      icon: path.join(__dirname, '..', '..', 'assets', 'icon.ico'),
      backgroundColor: '#14161a',
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#14161a', symbolColor: '#e6e8ec', height: 40 },
    });
    if (place?.maximized) win.maximize();
    let lastPlace = { ...win.getNormalBounds(), maximized: win.isMaximized() };

    const shellView = new WebContentsView({
      webPreferences: {
        preload: path.join(SHELL_DIR, 'preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    // Transparent so the page shows through while expanded side tabs are lifted above it.
    shellView.setBackgroundColor('#00000000');
    win.contentView.addChildView(shellView);
    const shell = shellView.webContents;
    const layoutShell = () => {
      const { width, height } = win.getContentBounds();
      shellView.setBounds({ x: 0, y: 0, width, height });
      if (tabs.fullscreen && tabs.active?.view) tabs.active.view.setBounds(tabs.fullBounds());
    };

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
          settings: visibleSettings(),
          tor: tor.state,
          about: { version: app.getVersion(), chromium: process.versions.chrome },
          update: updater.state,
          shield: {
            enabled: adblock.enabled,
            host,
            allowed: adblock.isSiteAllowed(host),
            filtersUpdatedAt: adblock.updatedAt,
          },
          searchEngines: Object.entries(SEARCH_ENGINES).map(([id, e]) => ({ id, name: e.name })),
          searchShortcuts: Object.entries(SEARCH_SHORTCUTS).map(([id, e]) => ({ id, name: e.name })),
        });
        if (!win.isDestroyed()) win.setTitle(active?.title ? `${active.title} - Tern` : 'Tern');
      }, 16);
    };

    const shortcut = (input) => {
      if (input.type !== 'keyDown') return false;
      const key = input.key.toLowerCase();
      const ctrl = input.control || input.meta;
      const combo = `${ctrl ? 'c' : ''}${input.shift ? 's' : ''}${input.alt ? 'a' : ''}+${key}`;
      const id = tabs.activeId;
      const actions = {
        'cs+n': () => openTorTab(),
        'c+n': () => openWindow().catch(console.error),
        'cs+w': () => win.close(),
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
        'c+k': () => {
          shell.focus();
          send('tern:palette-open');
        },
        'c+p': () => tabs.print(id),
        'c+s': () => tabs.savePage(id),
        'c+pagedown': () => tabs.cycle(1),
        'c+pageup': () => tabs.cycle(-1),
        'cs+i': () => tabs.active?.view?.webContents.toggleDevTools(),
        'ca+r': () => send('tern:toggle-reader'),
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
      torSession,
      closed: closedTabs,
      httpAllowed,
      getOtherWindows: () => [...windows].filter((other) => other.win !== win).map((other) => ({
        id: other.win.id,
        title: other.tabs.active?.title || other.tabs.active?.url || 'New tab',
      })),
      onShortcut: shortcut,
      getSleepMinutes: () => settings.sleepMinutes,
      getWebRtcPolicy: () => (settings.proxyEnabled ? 'disable_non_proxied_udp' : 'default_public_interface_only'),
      getHttpsOnly: () => settings.httpsOnly,
      getStripTracking: () => settings.stripTracking,
      getSiteZoom: (host) => settings.siteZoom[host] ?? 0,
      getReaderText: () => ({ fontSize: settings.readerFontSize, serif: settings.readerSerif }),
      getSearchUrl: (text) => SEARCH_ENGINES[settings.searchEngine].url + encodeURIComponent(text),
    });
    tabs.torReady = torReady;

    const openTorTab = () => {
      tabs.create('', { tor: true });
      tor.start();
      focusAddress();
    };

    tabs.on('site-zoom', (host, level) => {
      const { [host]: _old, ...others } = settings.siteZoom;
      update({ siteZoom: level === 0 ? others : { ...others, [host]: level } });
    });

    tabs.on('reader-zoom', (step) => {
      update({ readerFontSize: step === 0 ? DEFAULTS.readerFontSize : settings.readerFontSize + (step > 0 ? 1 : -1) });
      for (const tab of allTabs()) if (tab.readerView) tabs.styleReader(tab).catch(() => {});
    });

    const toggleBookmark = () => {
      const tab = tabs.active;
      if (!tab?.url) return;
      const added = library.toggleBookmark({ url: tab.url, title: tab.title });
      // Fetching a Tor tab's icon here would go around Tor.
      if (added && !tab.tor) fetchBookmarkIcon(added, tab.favicon).catch(() => {});
    };

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

    // Tabs brought in while the list is open would otherwise cover it.
    let sideOpen = false;
    const raiseOverlays = () => {
      if (sideOpen) win.contentView.addChildView(shellView);
      if (suggestView && win.contentView.children.includes(suggestView)) win.contentView.addChildView(suggestView);
    };
    tabs.on('attached', raiseOverlays);

    tabs.on('changed', () => {
      pushState();
      saveSession();
    });
    tabs.on('fullscreen', pushState);
    tabs.on('rename-group', (id) => send('tern:group-rename-start', id));
    tabs.on('focus-address', () => focusAddress());
    tabs.on('found', (result) => send('tern:found', {
      active: result.activeMatchOrdinal,
      total: result.matches,
    }));
    // The last tab of one of several windows takes the window with it.
    tabs.on('empty', () => {
      if (windows.size > 1) {
        win.close();
        return;
      }
      tabs.create();
      focusAddress();
    });
    tabs.on('last-tor-tab-closed', endTorIfUnused);
    tabs.on('page-loaded', capturePageText);
    tabs.on('visit', (address, title) => {
      if (settings.saveHistory) library.recordVisit(address, title);
    });
    tabs.on('title', (address, title) => {
      if (settings.saveHistory) library.updateTitle(address, title);
    });
    tabs.on('move-to-window', (id, otherId) => {
      moveTab(w, id, [...windows].find((other) => other.win.id === otherId) ?? null).catch(console.error);
    });
    tabs.on('open-in-window', (address, tabIsTor) => {
      openWindow({ url: address, torTab: tabIsTor }).catch(console.error);
    });
    tabs.on('reopen-window', (closedWindow) => {
      openWindow({ saved: closedWindow }).catch(console.error);
    });

    const mainMenuItems = () => {
      const id = tabs.activeId;
      const tab = tabs.active;
      const hasPage = Boolean(tab?.view);
      const shortcut = (accelerator) => ({ accelerator, registerAccelerator: false });
      const panel = (name, tabName) => () => send('tern:open-panel', { panel: name, tab: tabName });
      return [
        { label: 'New tab', ...shortcut('Ctrl+T'), click: () => { tabs.create(); focusAddress(); } },
        { label: 'New window', ...shortcut('Ctrl+N'), click: () => openWindow().catch(console.error) },
        { label: 'New Tor tab', ...shortcut('Ctrl+Shift+N'), click: openTorTab },
        { label: 'Reopen closed tab', ...shortcut('Ctrl+Shift+T'), enabled: tabs.closed.length > 0, click: () => tabs.reopenClosed() },
        { type: 'separator' },
        { label: 'Bookmarks', ...shortcut('Ctrl+Shift+O'), click: panel('library', 'bookmarks') },
        { label: 'History', ...shortcut('Ctrl+H'), click: panel('library', 'history') },
        { label: 'Downloads', ...shortcut('Ctrl+J'), click: panel('downloads') },
        { type: 'separator' },
        { label: 'Zoom in', ...shortcut('Ctrl+='), enabled: hasPage, click: () => tabs.zoom(0.5) },
        { label: `Reset zoom (${tabs.zoomPercent()}%)`, ...shortcut('Ctrl+0'), enabled: hasPage, click: () => tabs.zoom(0) },
        { label: 'Zoom out', ...shortcut('Ctrl+-'), enabled: hasPage, click: () => tabs.zoom(-0.5) },
        { label: 'Full screen', ...shortcut('F11'), click: () => win.setFullScreen(!win.isFullScreen()) },
        { type: 'separator' },
        { label: 'Command palette', ...shortcut('Ctrl+K'), click: () => { shell.focus(); send('tern:palette-open'); } },
        { label: 'Find in page', ...shortcut('Ctrl+F'), enabled: hasPage, click: () => send('tern:find-open') },
        { label: 'Print…', ...shortcut('Ctrl+P'), enabled: hasPage, click: () => tabs.print(id) },
        { label: 'Save page as…', ...shortcut('Ctrl+S'), enabled: hasPage, click: () => tabs.savePage(id) },
        { type: 'separator' },
        { label: 'Customize', click: panel('customize') },
        {
          label: 'About Tern',
          click: () => dialog.showMessageBox(win, {
            type: 'info',
            message: `Tern ${app.getVersion()}`,
            detail: `Chromium ${process.versions.chrome}\nElectron ${process.versions.electron}`,
          }),
        },
        { type: 'separator' },
        { label: 'Close window', ...shortcut('Ctrl+Shift+W'), enabled: windows.size > 1, click: () => win.close() },
        { label: 'Exit', click: () => app.quit() },
      ];
    };

    const handlers = {
      'tern:ready': () => {
        pushState();
        send('tern:bookmarks', library.bookmarks);
        send('tern:downloads', downloads.list());
      },
      'tern:side-open': (open) => {
        sideOpen = Boolean(open);
        // Reordering views can move keyboard focus, and hovering shouldn't interrupt typing.
        const shown = tabs.contentsFor(tabs.active);
        const pageHadFocus = Boolean(shown?.isFocused());
        if (sideOpen) win.contentView.addChildView(shellView);
        else tabs.raisePages();
        raiseOverlays();
        if (pageHadFocus) shown.focus();
      },
      // Things the palette can do that the interface can't do by itself.
      'tern:run-action': (name) => {
        const id = tabs.activeId;
        const actions = {
          print: () => tabs.print(id),
          save: () => tabs.savePage(id),
          zoomIn: () => tabs.zoom(0.5),
          zoomOut: () => tabs.zoom(-0.5),
          zoomReset: () => tabs.zoom(0),
          fullscreen: () => win.setFullScreen(!win.isFullScreen()),
          reopen: () => tabs.reopenClosed(),
          devtools: () => tabs.active?.view?.webContents.toggleDevTools(),
          closeOthers: () => tabs.closeOthers(id),
          pin: () => tabs.togglePinned(id),
          mute: () => tabs.toggleMuted(id),
          duplicate: () => tabs.duplicate(id),
          exit: () => app.quit(),
          newWindow: () => openWindow().catch(console.error),
          moveToNewWindow: () => moveTab(w, id).catch(console.error),
          closeWindow: () => win.close(),
        };
        actions[name]?.();
      },
      'tern:main-menu': (x, y) => {
        Menu.buildFromTemplate(mainMenuItems()).popup({ window: win, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
      },
      'tern:tab-menu': (id) => tabs.tabMenu(id),
      'tern:toggle-muted': (id) => tabs.toggleMuted(id),
      'tern:default-browser-status': () => defaultBrowserStatus(app.getName()),
      'tern:default-browser-open': () => system.openExternal(defaultAppsPage(app.getName())),
      'tern:split-start': (id, otherId) => tabs.startSplit(id, otherId),
      'tern:split-close': (id) => tabs.closeSplit(id),
      'tern:split-ratio': (ratio) => tabs.setSplitRatio(Number(ratio)),
      // A tab dropped outside this window goes to the window under the pointer, or to a new one there.
      'tern:drag-out': (id, x, y) => {
        const [px, py] = [whole(Number(x)), whole(Number(y))];
        if (px === undefined || py === undefined || (px === 0 && py === 0) || contains(win.getBounds(), px, py)) return null;
        const other = [...windows].find((o) => o !== w && !o.win.isMinimized() && contains(o.win.getBounds(), px, py));
        const { width, height } = win.getNormalBounds();
        return moveTab(w, id, other ?? null, { x: px - 100, y: py - 20, width, height }).then(() => null);
      },
      'tern:drop-tab': (id, targetId) => tabs.dropTab(id, targetId),
      'tern:drop-on-group': (id, groupId) => tabs.dropOnGroup(id, groupId),
      'tern:new-group': (id) => tabs.newGroup(id),
      'tern:group-rename': (id, name) => tabs.renameGroup(id, name),
      'tern:group-toggle': (id) => tabs.toggleGroupCollapsed(id),
      'tern:group-menu': (id) => tabs.groupMenu(id),
      'tern:bookmark-set-folder': (id, folder) => library.setBookmarkFolder(id, folder),
      'tern:folder-rename': (from, to) => library.renameFolder(from, to),
      'tern:folder-remove': (name) => library.removeFolder(name),
      'tern:folder-menu': (folder, x, y) => {
        const inside = library.bookmarks.filter((b) => b.folder === folder);
        const tor = Boolean(tabs.active?.tor);
        const items = inside.map((b) => ({ label: (b.title || b.url).slice(0, 70), click: () => tabs.navigate(tabs.activeId, b.url) }));
        items.push({ type: 'separator' }, {
          label: `Open all ${inside.length} in new tabs`,
          click: () => inside.forEach((b) => tabs.create(b.url, { activate: false, tor })),
        });
        Menu.buildFromTemplate(items).popup({ window: win, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0) });
      },
      'tern:import-sources': () => findBrowsers().map(({ id, name }) => ({ id, name })),
      // Only reads the bookmark file of the browser you picked, when you pick it.
      'tern:import-browser': (id) => {
        const browser = findBrowsers().find((b) => b.id === id);
        return browser ? importBookmarkFiles(browser.files) : { error: "Couldn't find that browser's bookmarks." };
      },
      'tern:import-file': async () => {
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
          title: 'Import bookmarks',
          filters: [{ name: 'Bookmarks file', extensions: ['html', 'htm', 'json'] }],
          properties: ['openFile'],
        });
        return canceled ? { canceled: true } : importBookmarkFiles(filePaths);
      },
      'tern:export-bookmarks': async () => {
        const { canceled, filePath } = await dialog.showSaveDialog(win, {
          title: 'Export bookmarks',
          defaultPath: path.join(app.getPath('downloads'), 'tern-bookmarks.html'),
          filters: [{ name: 'Bookmarks file', extensions: ['html'] }],
        });
        if (canceled || !filePath) return { canceled: true };
        fs.writeFileSync(filePath, toBookmarksHtml(library.bookmarks));
        return { path: filePath, count: library.bookmarks.length };
      },
      'tern:toggle-reader': (id, theme) => tabs.toggleReader(id, theme),
      'tern:style-reader': (theme) => {
        for (const tab of allTabs()) if (tab.readerView) tabs.styleReader(tab, theme).catch(() => {});
      },
      // Everything the This site panel shows. Nothing here is written anywhere for Tor tabs.
      'tern:site-info': () => {
        const tab = tabs.active;
        const url = tab?.url ?? '';
        const host = hostOf(url);
        const origin = isWebUrl(url) ? new URL(url).origin : '';
        const permissions = tab?.tor ? [] : [...permissionChoices.entries()]
          .filter(([key]) => key.startsWith(`${origin}|`))
          .map(([key, allowed]) => ({ name: key.slice(origin.length + 1), allowed }));
        const hosts = new Set([...Object.keys(settings.siteZoom), ...settings.allowedSites]);
        return {
          host,
          tor: Boolean(tab?.tor),
          secure: url.startsWith('https:'),
          blocked: tab?.blocked ?? 0,
          adblock: adblock.enabled && !adblock.isSiteAllowed(host),
          adblockAvailable: adblock.enabled,
          zoom: tabs.zoomPercent(),
          permissions,
          customSites: [...hosts].sort().map((name) => ({
            host: name,
            zoom: settings.siteZoom[name] ? Math.round(1.2 ** settings.siteZoom[name] * 100) : 0,
            adblockOff: settings.allowedSites.includes(name),
          })),
        };
      },
      'tern:site-forget-permission': (name) => {
        const url = tabs.active?.url ?? '';
        if (isWebUrl(url)) permissionChoices.delete(`${new URL(url).origin}|${name}`);
      },
      'tern:site-clear-data': async () => {
        const tab = tabs.active;
        if (!tab || !isWebUrl(tab.url)) return;
        await (tab.tor ? torSession : tabSession).clearStorageData({ origin: new URL(tab.url).origin });
        tabs.reload(tab.id);
      },
      'tern:site-forget': (host) => {
        const { [host]: _old, ...others } = settings.siteZoom;
        update({ siteZoom: others, allowedSites: settings.allowedSites.filter((h) => h !== host) });
        for (const tab of allTabs()) {
          if (tab.view && !tab.tor && hostOf(tab.url) === host) tab.view.webContents.setZoomLevel(0);
        }
        tabs.changed();
      },
      'tern:allow-http': (id) => tabs.allowHttp(id),
      // Clears normal tabs only. Bookmarks, settings and Tor tabs aren't touched.
      'tern:clear-browsing-data': async () => {
        library.clearHistory();
        pageIndex.clear();
        await tabSession.clearStorageData();
        await tabSession.clearCache();
      },
      'tern:new-tor-tab': () => openTorTab(),
      'tern:tor-retry': () => tor.start(),
      'tern:set-proxy': async ({ enabled, server, username = '', password } = {}) => {
        const text = String(server ?? '').trim();
        if (enabled && !PROXY_SERVER.test(text)) return { ok: false, message: 'Enter the server like socks5://host:1080 or http://host:8080' };
        if (username && !/^https?:/i.test(text)) return { ok: false, message: "Usernames only work with http:// proxies. Chromium can't send them to SOCKS proxies." };
        const patch = { proxyEnabled: Boolean(enabled), proxyServer: text, proxyUsername: String(username) };
        if (typeof password === 'string' && password) {
          if (!safeStorage.isEncryptionAvailable()) return { ok: false, message: "Windows can't store the password securely here." };
          patch.proxyPassword = safeStorage.encryptString(password).toString('base64');
        } else if (!username) {
          patch.proxyPassword = '';
        }
        update(patch);
        await applyProxy();
        return { ok: true };
      },
      // Contacts ipify only when asked, to show what websites currently see.
      'tern:check-ip': async () => {
        const ses = tabs.active?.tor ? torSession : tabSession;
        try {
          const response = await ses.fetch('https://api.ipify.org?format=json');
          return { ip: (await response.json()).ip };
        } catch {
          return { error: "Couldn't check right now." };
        }
      },
      'tern:update-check': () => updater.check(),
      'tern:update-install': () => updater.install(),
      'tern:open': (url, options) => {
        if (!isWebUrl(url)) return;
        if (options?.newTab) tabs.create(url, { activate: !options.background, tor: Boolean(tabs.active?.tor) });
        else tabs.navigate(tabs.activeId, url);
      },
      'tern:toggle-bookmark': () => toggleBookmark(),
      'tern:bookmark-rename': (id, title) => library.renameBookmark(id, title),
      'tern:bookmark-remove': (id) => library.removeBookmark(id),
      'tern:bookmark-move': (id, index) => library.moveBookmark(id, index),
      'tern:history-search': (query) => library.searchHistory(query),
      'tern:history-remove': (url) => {
        library.removeHistory(url);
        pageIndex.remove(url);
      },
      'tern:history-clear': () => {
        library.clearHistory();
        pageIndex.clear();
      },
      // Only pages still in history count, so anything removed from it can't show up here.
      'tern:search-pages': (query) => (settings.indexPages ? pageIndex.search(query).filter((page) => library.history.has(page.url)) : []),
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
      'tern:activate': (id) => {
        tabs.activate(id);
        tabs.active?.view?.webContents.focus();
      },
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
        }
      },
      'tern:settings': (patch) => {
        const { totalBlocked, allowedSites, siteZoom, proxyEnabled, proxyServer, proxyUsername, proxyPassword, ...safe } = patch ?? {};
        update(safe);
      },
      'tern:reset-settings': () => {
        const { adblock: on, allowedSites, totalBlocked, siteZoom, indexPages, saveHistory, askDownloadPath, autoUpdate, httpsOnly, stripTracking, globalPrivacyControl, proxyEnabled, proxyServer, proxyUsername, proxyPassword } = settings;
        settings = clean({ adblock: on, allowedSites, totalBlocked, siteZoom, indexPages, saveHistory, askDownloadPath, autoUpdate, httpsOnly, stripTracking, globalPrivacyControl, proxyEnabled, proxyServer, proxyUsername, proxyPassword }, DEFAULTS);
        settingsFile.write(settings);
        pushAll();
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
        const wc = tabs.contentsFor(tabs.active);
        if (!wc) return;
        if (text) wc.findInPage(String(text), { forward: options?.forward !== false, findNext: Boolean(options?.next) });
        else wc.stopFindInPage('clearSelection');
      },
      'tern:find-stop': () => tabs.contentsFor(tabs.active)?.stopFindInPage('clearSelection'),
      'tern:focus-page': () => tabs.contentsFor(tabs.active)?.focus(),
    };

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
      lastPlace = { ...win.getNormalBounds(), maximized: win.isMaximized() };
      windowFile.write(lastPlace);
      saveSession();
    };
    win.on('moved', saveWindow);
    win.on('resized', saveWindow);
    win.on('maximize', saveWindow);
    win.on('unmaximize', saveWindow);
    win.on('focus', () => {
      lastFocused = w;
    });
    win.on('close', (event) => {
      if (!quitting) {
        if (windows.size === 1) {
          if (!downloadsMayStop(win)) {
            event.preventDefault();
            return;
          }
          beginShutdown();
        } else {
          const closing = w.serialize();
          if (closing.tabs.length) {
            closedTabs.push({ window: closing });
            if (closedTabs.length > 20) closedTabs.shift();
          }
        }
      }
      clearTimeout(stateTimer);
      const hadTor = tabs.tabs.some((t) => t.tor);
      windows.delete(w);
      retiredShells.add(shell);
      destroySuggestions();
      tabs.dispose();
      if (!quitting) {
        saveSession();
        if (hadTor) endTorIfUnused();
      }
    });
    win.on('closed', () => {
      windowByShell.delete(shell);
      // A view doesn't go when its window does. Left alone, each closed window would leave a process.
      if (!shell.isDestroyed()) shell.close({ waitForBeforeUnload: false });
      if (windows.size) return;
      for (const channel of listening) ipcMain.removeHandler(channel);
      ipcMain.removeHandler('tern:suggest-pick');
      ipcMain.removeAllListeners('tern:block-youtube-ads');
      ipcMain.removeAllListeners('tern:gpc-enabled');
      app.removeListener('login', onLogin);
      app.removeListener('before-quit', onBeforeQuit);
    });

    const w = {
      win,
      shell,
      tabs,
      send,
      pushState,
      mainMenuItems,
      openTorTab,
      handlers,
      focusAddress,
      suggestContents: () => suggestView?.webContents ?? null,
      suggestionsVisible: () => Boolean(suggestView) && win.contentView.children.includes(suggestView),
      serialize: () => ({ ...tabs.serialize(), bounds: lastPlace }),
    };
    windows.add(w);
    windowByShell.set(shell, w);
    lastFocused = w;
    for (const channel of Object.keys(handlers)) {
      if (listening.has(channel)) continue;
      listening.add(channel);
      ipcMain.handle(channel, (event, ...args) => {
        if (retiredShells.has(event.sender)) return undefined;
        const sender = windowByShell.get(event.sender);
        if (!sender) throw new Error('Rejected IPC from outside the browser UI');
        return sender.handlers[channel](...args);
      });
    }

    await shell.loadFile(path.join(SHELL_DIR, 'index.html'));
    layoutShell();

    const restored = Array.isArray(saved?.tabs) ? saved.tabs.filter((t) => isWebUrl(t?.url)) : [];
    if (restored.length) {
      tabs.restoreGroups(saved.groups);
      const groups = tabs.groups;
      const groupIds = new Set(groups.map((g) => g.id));
      restored.forEach((t) => tabs.create(t.url, {
        activate: false,
        title: String(t.title ?? ''),
        pinned: Boolean(t.pinned),
        group: groupIds.has(t.group) ? t.group : null,
      }));
      // Creating a tab tidies away groups with no tabs yet, so they go back once all the tabs exist.
      tabs.groups = groups;
      tabs.keepPinnedFirst();
      tabs.activate(tabs.tabs[Math.min(saved.activeIndex ?? 0, restored.length - 1)]?.id ?? tabs.tabs[0].id);
    }
    if (url) {
      tabs.create(url, { tor: torTab });
      if (torTab) tor.start();
    } else if (!restored.length && !empty) {
      tabs.create();
      focusAddress();
    }
    if (visible) win.show();
    pushState();
    return w;
  };

  const previous = sessionFile.read();
  // Sessions saved before Tern had several windows are one window's worth of tabs.
  const savedWindows = (Array.isArray(previous?.windows) ? previous.windows : [previous])
    .filter((saved) => Array.isArray(saved?.tabs) && saved.tabs.some((t) => isWebUrl(t?.url)));
  let first = null;
  for (const saved of savedWindows) {
    const opened = await openWindow({ saved });
    first ??= opened;
  }
  first ??= await openWindow({ url: openUrl });
  if (savedWindows.length && openUrl) currentWindow().tabs.create(openUrl);

  // A link from another program, or Tern being started again.
  const openFromOutside = (url) => {
    const w = currentWindow();
    if (!w) return;
    if (w.win.isMinimized()) w.win.restore();
    w.win.focus();
    if (url) w.tabs.create(url);
  };

  updater.start();
  setTimeout(() => adblock.refreshIfStale().catch(() => {}), 30 * 1000).unref?.();

  return {
    win: first.win,
    shell: first.shell,
    tabs: first.tabs,
    windows: () => [...windows],
    openWindow,
    moveTab,
    openFromOutside,
    adblock,
    library,
    downloads,
    updater,
    mainMenuItems: first.mainMenuItems,
    system,
    pageIndex,
    pageText,
    importBookmarkFiles,
    setPermissionChoiceForTest: (origin, name, allowed) => permissionChoices.set(`${origin}|${name}`, allowed),
    tor,
    torSession,
    useTorPort,
    openTorTab: first.openTorTab,
    tabSession,
    suggestionsVisible: first.suggestionsVisible,
    getSettings: () => settings,
    updateSettings: update,
    flushAll,
  };
}

module.exports = { start };
