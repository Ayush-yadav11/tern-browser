'use strict';

const { EventEmitter } = require('node:events');
const { Menu, WebContentsView, clipboard } = require('electron');
const { extractArticle, readerPage, readerStyle } = require('./reader');
const { hostOf, isLocalHost, isWebUrl, stripTracking } = require('./url');

// These mean the site or network is the problem, not that the site lacks HTTPS.
const HTTPS_WAIT_MS = 10 * 1000;
const HTTPS_WAIT_TOR_MS = 30 * 1000;
const NOT_AN_HTTPS_PROBLEM = new Set([-3, -105, -106, -120, -130, -137]);

const MAX_CLOSED = 20;

// A tab only owns a renderer while it is awake. New tabs and sleeping tabs have
// view === null, and the shell draws whatever belongs in the content area instead.
class Tabs extends EventEmitter {
  constructor({ window, session, torSession, onShortcut, getSleepMinutes, getWebRtcPolicy, getSearchUrl, getHttpsOnly, getStripTracking, getSiteZoom, getReaderText }) {
    super();
    this.window = window;
    this.session = session;
    this.onShortcut = onShortcut;
    this.getSleepMinutes = getSleepMinutes;
    this.torSession = torSession;
    this.torReady = false;
    this.getWebRtcPolicy = getWebRtcPolicy;
    this.getSearchUrl = getSearchUrl;
    this.getHttpsOnly = getHttpsOnly;
    this.getStripTracking = getStripTracking;
    this.getSiteZoom = getSiteZoom;
    this.getReaderText = getReaderText;
    // Sites allowed to stay on http until Tern closes. Tor tabs keep their own list.
    this.httpAllowed = new Set();
    this.httpsWaitMs = HTTPS_WAIT_MS;
    this.tabs = [];
    this.activeId = null;
    this.nextId = 1;
    this.bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.closed = [];
    this.fullscreen = false;
    this.sleepTimer = setInterval(() => this.sleepIdle(), 60 * 1000);
    this.sleepTimer.unref?.();
  }

  get active() {
    return this.tabs.find((t) => t.id === this.activeId) ?? null;
  }

  byId(id) {
    return this.tabs.find((t) => t.id === id) ?? null;
  }

  byContentsId(contentsId) {
    return this.tabs.find((t) => t.view && t.view.webContents.id === contentsId) ?? null;
  }

  publicState() {
    return {
      activeId: this.activeId,
      tabs: this.tabs.map((t) => ({
        id: t.id,
        url: t.url,
        title: t.title,
        // The interface fetches favicons itself, which wouldn't go through Tor.
        favicon: t.tor && !t.favicon.startsWith('data:') ? '' : t.favicon,
        tor: t.tor,
        loading: t.loading,
        canBack: Boolean(t.view?.webContents.navigationHistory.canGoBack()),
        canForward: Boolean(t.view?.webContents.navigationHistory.canGoForward()),
        blocked: t.blocked,
        error: t.error,
        sleeping: !t.view && Boolean(t.url),
        audible: Boolean(t.view?.webContents.isCurrentlyAudible()),
        muted: t.muted,
        reader: Boolean(t.readerView),
        readerNote: t.readerNote ?? '',
        zoom: t.view ? Math.round(t.view.webContents.getZoomFactor() * 100) : 100,
        pinned: t.pinned,
      })),
    };
  }

  changed() {
    this.emit('changed');
  }

  create(url = '', { activate = true, title = '', index, openedByPage = false, tor = false, pinned = false } = {}) {
    const tab = {
      openedByPage,
      tor,
      pinned,
      muted: false,
      id: this.nextId++,
      url: isWebUrl(url) ? url : '',
      title,
      favicon: '',
      loading: false,
      blocked: 0,
      error: null,
      view: null,
      history: null,
      lastActive: Date.now(),
    };
    tab.url = tab.url && this.secureUrl(tab, tab.url);
    if (Number.isInteger(index)) this.tabs.splice(index, 0, tab);
    else this.tabs.push(tab);
    if (activate) this.activate(tab.id);
    else this.changed();
    return tab;
  }

  activate(id) {
    const tab = this.byId(id);
    if (!tab) return;
    const previous = this.active;
    if (previous?.view && previous !== tab) {
      this.window.contentView.removeChildView(previous.view);
      if (previous.readerView) this.window.contentView.removeChildView(previous.readerView);
      previous.lastActive = Date.now();
    }
    this.activeId = id;
    tab.lastActive = Date.now();
    if (this.canLoad(tab) && tab.url && !tab.view && !tab.error) this.wake(tab);
    this.attach(tab);
    this.changed();
  }

  // Returns the https address when HTTPS-only mode applies, and remembers the original.
  secureUrl(tab, address) {
    const url = this.getStripTracking() ? stripTracking(address) : address;
    tab.upgrade = null;
    if (!this.getHttpsOnly() || !url.startsWith('http:')) return url;
    const parsed = new URL(url);
    if (isLocalHost(parsed.hostname) || this.httpAllowed.has(`${tab.tor}|${parsed.hostname}`)) return url;
    tab.upgrade = { host: parsed.hostname, http: url };
    parsed.protocol = 'https:';
    return parsed.href;
  }

  // Sites with no https often just never answer, so an upgrade only gets so long.
  watchUpgrade(tab) {
    clearTimeout(tab.upgradeTimer);
    const { upgrade } = tab;
    if (!upgrade) return;
    tab.upgradeTimer = setTimeout(() => {
      if (tab.upgrade !== upgrade) return;
      tab.view?.webContents.stop();
      this.showNoHttps(tab, 0, 'The secure version of this site did not respond.');
    }, tab.tor ? Math.max(this.httpsWaitMs, HTTPS_WAIT_TOR_MS) : this.httpsWaitMs);
    tab.upgradeTimer.unref?.();
  }

  showNoHttps(tab, code, description) {
    clearTimeout(tab.upgradeTimer);
    const { http } = tab.upgrade;
    tab.error = { code, description, url: http, noHttps: true };
    tab.url = http;
    tab.title = '';
    tab.favicon = '';
    tab.upgrade = null;
    this.attach(tab);
    this.changed();
  }

  allowHttp(id) {
    const tab = this.byId(id);
    if (!tab?.error?.noHttps) return;
    this.httpAllowed.add(`${tab.tor}|${hostOf(tab.error.url)}`);
    this.navigate(id, tab.error.url);
  }

  // A Tor tab loads nothing at all until Tor is connected.
  canLoad(tab) {
    return !tab.tor || this.torReady;
  }

  setTorReady(ready) {
    this.torReady = ready;
    const tab = this.active;
    if (ready && tab?.tor && tab.url && !tab.view) this.wake(tab);
    this.changed();
  }

  attach(tab) {
    if (!tab.view || tab.id !== this.activeId) return;
    if (tab.error) {
      this.window.contentView.removeChildView(tab.view);
      return;
    }
    // Adding a view again would lift it above the suggestions list.
    if (!this.window.contentView.children.includes(tab.view)) {
      this.window.contentView.addChildView(tab.view);
      if (tab.readerView) this.window.contentView.addChildView(tab.readerView);
      this.emit('attached');
    }
    tab.view.setBounds(this.fullscreen ? this.fullBounds() : this.bounds);
    tab.readerView?.setBounds(this.bounds);
  }

  // A link that turned out to be a file shouldn't leave its tab stuck on the file's address.
  afterDownloadStarted(contents) {
    const tab = this.tabs.find((t) => t.view?.webContents === contents);
    if (!tab) return;
    const committed = contents.getURL();
    if (committed) {
      tab.url = committed;
      tab.blocked = tab.blockedBefore ?? tab.blocked;
      this.changed();
    } else if (tab.openedByPage && this.tabs.length > 1) {
      setImmediate(() => this.close(tab.id));
    } else {
      setImmediate(() => this.goHome(tab.id));
    }
  }

  fullBounds() {
    const { width, height } = this.window.getContentBounds();
    return { x: 0, y: 0, width, height };
  }

  setBounds(bounds) {
    this.bounds = bounds;
    if (this.active?.view && !this.fullscreen) this.active.view.setBounds(bounds);
    this.active?.readerView?.setBounds(bounds);
  }

  close(id) {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const tab = this.tabs[index];
    if (tab.url && !tab.tor) {
      this.closed.push({ url: tab.url, title: tab.title, index });
      if (this.closed.length > MAX_CLOSED) this.closed.shift();
    }
    this.destroyView(tab);
    this.tabs.splice(index, 1);
    if (tab.tor && !this.tabs.some((t) => t.tor)) this.emit('last-tor-tab-closed');
    if (this.tabs.length === 0) {
      this.emit('empty');
      return;
    }
    if (this.activeId === id) {
      this.activeId = null;
      this.activate(this.tabs[Math.min(index, this.tabs.length - 1)].id);
    } else {
      this.changed();
    }
  }

  reopenClosed() {
    const last = this.closed.pop();
    if (last) this.create(last.url, { title: last.title, index: Math.min(last.index, this.tabs.length) });
  }

  move(id, toIndex) {
    const from = this.tabs.findIndex((t) => t.id === id);
    if (from < 0 || !Number.isInteger(toIndex)) return;
    const [tab] = this.tabs.splice(from, 1);
    this.tabs.splice(Math.max(0, Math.min(toIndex, this.tabs.length)), 0, tab);
    this.keepPinnedFirst();
    this.changed();
  }

  keepPinnedFirst() {
    this.tabs = [...this.tabs.filter((t) => t.pinned), ...this.tabs.filter((t) => !t.pinned)];
  }

  togglePinned(id) {
    const tab = this.byId(id);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    this.keepPinnedFirst();
    this.changed();
  }

  toggleMuted(id) {
    const tab = this.byId(id);
    if (!tab) return;
    tab.muted = !tab.muted;
    tab.view?.webContents.setAudioMuted(tab.muted);
    this.changed();
  }

  duplicate(id) {
    const tab = this.byId(id);
    if (!tab) return;
    this.create(tab.url, { title: tab.title, tor: tab.tor, index: this.tabs.indexOf(tab) + 1 });
  }

  // Pinned tabs are only closed one at a time, on purpose.
  closeOthers(id) {
    if (!this.byId(id)) return;
    this.activate(id);
    this.tabs.filter((t) => t.id !== id && !t.pinned).forEach((t) => this.close(t.id));
  }

  closeToRight(id) {
    const index = this.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    this.activate(id);
    this.tabs.slice(index + 1).filter((t) => !t.pinned).forEach((t) => this.close(t.id));
  }

  // What the user is actually looking at in a tab: the reader when it's open.
  contentsFor(tab) {
    return tab?.readerView?.webContents ?? tab?.view?.webContents ?? null;
  }

  print(id) {
    this.contentsFor(this.byId(id))?.print({}, () => {});
  }

  async toggleReader(id, theme) {
    const tab = this.byId(id);
    if (!tab) return;
    tab.readerTheme = theme ?? tab.readerTheme;
    if (tab.readerView) {
      this.closeReader(tab);
      tab.view?.webContents.focus();
      this.changed();
      return;
    }
    if (!tab.view || tab.loading) return;
    let article = null;
    try {
      article = await extractArticle(tab.view.webContents);
    } catch {
      article = null;
    }
    if (!tab.view) return;
    if (!article) {
      tab.readerNote = "This page doesn't have an article to show in reader view.";
      clearTimeout(tab.readerNoteTimer);
      tab.readerNoteTimer = setTimeout(() => {
        tab.readerNote = '';
        this.changed();
      }, 4000);
      tab.readerNoteTimer.unref?.();
      this.changed();
      return;
    }
    await this.openReader(tab, article);
    this.changed();
  }

  // Same session as the tab, so images follow its rules: through Tor in a Tor tab, and past the
  // ad blocker in all of them. Scripts are off, and any link leaves the reader instead of following.
  async openReader(tab, article) {
    const view = new WebContentsView({
      webPreferences: {
        session: tab.tor ? this.torSession : this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        javascript: false,
        spellcheck: false,
      },
    });
    const wc = view.webContents;
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
    wc.setWindowOpenHandler(({ url }) => {
      if (isWebUrl(url)) this.create(url, { tor: tab.tor });
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      event.preventDefault();
      if (isWebUrl(url)) this.navigate(tab.id, url);
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.closeReader(tab);
        tab.view?.webContents.focus();
        this.changed();
      } else if (this.onShortcut(input)) {
        event.preventDefault();
      }
    });
    wc.on('found-in-page', (_e, result) => this.emit('found', result));
    wc.on('context-menu', (_e, p) => {
      const items = [
        ...(p.selectionText ? [{ role: 'copy' }, { type: 'separator' }] : []),
        ...(isWebUrl(p.linkURL) ? [{ label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) }, { type: 'separator' }] : []),
        { label: 'Print…', click: () => wc.print({}, () => {}) },
        { label: 'Exit reader view', click: () => this.toggleReader(tab.id) },
      ];
      Menu.buildFromTemplate(items).popup({ window: this.window });
    });
    tab.readerView = view;
    view.setBounds(this.bounds);
    if (tab.id === this.activeId) this.window.contentView.addChildView(view);
    this.emit('attached');
    await wc.loadURL(readerPage(article, { pageUrl: tab.url })).catch(() => {});
    if (tab.readerView === view) {
      await this.styleReader(tab);
      if (tab.id === this.activeId) wc.focus();
    }
  }

  async styleReader(tab, theme) {
    if (theme) tab.readerTheme = theme;
    const wc = tab.readerView?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const css = readerStyle({ theme: tab.readerTheme, ...this.getReaderText() });
    const key = await wc.insertCSS(css, { cssOrigin: 'user' }).catch(() => null);
    if (tab.readerCssKey) wc.removeInsertedCSS(tab.readerCssKey).catch(() => {});
    tab.readerCssKey = key;
  }

  closeReader(tab) {
    const view = tab.readerView;
    if (!view) return;
    tab.readerView = null;
    tab.readerCssKey = null;
    this.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  savePage(id) {
    const wc = this.byId(id)?.view?.webContents;
    if (wc && isWebUrl(wc.getURL())) wc.downloadURL(wc.getURL());
  }

  zoomPercent() {
    const wc = this.active?.view?.webContents;
    return wc ? Math.round(wc.getZoomFactor() * 100) : 100;
  }

  tabMenu(id) {
    const tab = this.byId(id);
    if (!tab) return;
    Menu.buildFromTemplate(this.tabMenuItems(tab)).popup({ window: this.window });
  }

  tabMenuItems(tab) {
    const index = this.tabs.indexOf(tab);
    return [
      { label: 'Reload', enabled: Boolean(tab.url), click: () => this.reload(tab.id) },
      { label: 'Duplicate', enabled: Boolean(tab.url), click: () => this.duplicate(tab.id) },
      { label: tab.pinned ? 'Unpin' : 'Pin', click: () => this.togglePinned(tab.id) },
      { label: tab.muted ? 'Unmute site' : 'Mute site', click: () => this.toggleMuted(tab.id) },
      { type: 'separator' },
      { label: 'Close', click: () => this.close(tab.id) },
      { label: 'Close other tabs', enabled: this.tabs.some((t) => t !== tab && !t.pinned), click: () => this.closeOthers(tab.id) },
      { label: 'Close tabs to the right', enabled: this.tabs.slice(index + 1).some((t) => !t.pinned), click: () => this.closeToRight(tab.id) },
      { type: 'separator' },
      { label: 'Reopen closed tab', enabled: this.closed.length > 0, click: () => this.reopenClosed() },
    ];
  }

  cycle(step) {
    if (this.tabs.length < 2) return;
    const index = this.tabs.findIndex((t) => t.id === this.activeId);
    this.activate(this.tabs[(index + step + this.tabs.length) % this.tabs.length].id);
  }

  navigate(id, url) {
    const tab = this.byId(id);
    if (!tab || !isWebUrl(url)) return;
    const target = this.secureUrl(tab, url);
    tab.url = target;
    tab.lastFollowed = target;
    tab.error = null;
    tab.history = null;
    if (!this.canLoad(tab)) {
      this.changed();
      return;
    }
    if (!tab.view) this.createView(tab);
    this.attach(tab);
    this.watchUpgrade(tab);
    tab.view.webContents.loadURL(target).catch(() => {});
    tab.view.webContents.focus();
    this.changed();
  }

  // Back to the empty new-tab card. Dropping the view also frees its renderer.
  goHome(id) {
    const tab = this.byId(id);
    if (!tab) return;
    this.destroyView(tab);
    Object.assign(tab, { url: '', title: '', favicon: '', error: null, blocked: 0, loading: false, history: null });
    this.changed();
  }

  back(id) {
    this.byId(id)?.view?.webContents.navigationHistory.goBack();
  }

  forward(id) {
    this.byId(id)?.view?.webContents.navigationHistory.goForward();
  }

  reload(id) {
    const tab = this.byId(id);
    if (!tab?.url) return;
    if (tab.error || !tab.view) {
      tab.error = null;
      this.navigate(id, tab.url);
      return;
    }
    tab.view.webContents.reload();
  }

  stop(id) {
    this.byId(id)?.view?.webContents.stop();
  }

  zoom(step) {
    const tab = this.active;
    if (tab?.readerView) {
      this.emit('reader-zoom', step);
      return;
    }
    const wc = tab?.view?.webContents;
    if (wc) this.setZoom(tab, step === 0 ? 0 : wc.getZoomLevel() + step);
  }

  // Remembered per site, except in Tor tabs, which keep nothing.
  setZoom(tab, level) {
    tab.view.webContents.setZoomLevel(level);
    if (!tab.tor && isWebUrl(tab.url)) this.emit('site-zoom', hostOf(tab.url), level);
    this.changed();
  }

  wake(tab) {
    this.createView(tab);
    const wc = tab.view.webContents;
    if (tab.history) {
      wc.navigationHistory.restore(tab.history).catch(() => {});
      tab.history = null;
    } else {
      this.watchUpgrade(tab);
      wc.loadURL(tab.url).catch(() => {});
    }
  }

  sleep(tab) {
    if (!tab.view || tab.id === this.activeId) return;
    const nav = tab.view.webContents.navigationHistory;
    const entries = nav.getAllEntries();
    tab.history = entries.length ? { entries, index: nav.getActiveIndex() } : null;
    this.destroyView(tab);
    this.changed();
  }

  sleepIdle(now = Date.now()) {
    const minutes = this.getSleepMinutes();
    if (!minutes) return;
    for (const tab of this.tabs) {
      if (!tab.view || tab.id === this.activeId) continue;
      if (tab.view.webContents.isCurrentlyAudible()) continue;
      if (now - tab.lastActive >= minutes * 60 * 1000) this.sleep(tab);
    }
  }

  destroyView(tab) {
    if (!tab.view) return;
    this.closeReader(tab);
    const { view } = tab;
    tab.view = null;
    clearTimeout(tab.upgradeTimer);
    tab.loading = false;
    this.window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false });
  }

  createView(tab) {
    const view = new WebContentsView({
      webPreferences: {
        session: tab.tor ? this.torSession : this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false,
        // Needed for Chromium's built-in PDF viewer.
        plugins: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    view.webContents.setAudioMuted(tab.muted);
    view.webContents.setWebRTCIPHandlingPolicy(tab.tor ? 'disable_non_proxied_udp' : this.getWebRtcPolicy());
    tab.view = view;
    this.wire(tab, view.webContents);
    return view;
  }

  wire(tab, wc) {
    const update = () => this.changed();
    const isCurrent = () => tab.view?.webContents === wc;

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (isWebUrl(url)) this.create(url, { activate: disposition !== 'background-tab', openedByPage: true, tor: tab.tor });
      return { action: 'deny' };
    });
    const followSecurely = (event, url) => {
      event.preventDefault();
      const target = this.secureUrl(tab, url);
      tab.url = target;
      tab.lastFollowed = target;
      this.watchUpgrade(tab);
      wc.loadURL(target).catch(() => {});
    };
    wc.on('will-navigate', (event, url) => {
      if (!isWebUrl(url)) event.preventDefault();
      else if (this.secureUrl(tab, url) !== url) followSecurely(event, url);
      else tab.upgrade = null;
    });
    wc.on('will-redirect', (event, url) => {
      if (!event.isMainFrame) return;
      if (!isWebUrl(url)) {
        event.preventDefault();
        return;
      }
      // A site that insists on its own tracking parameters gets them, rather than a loop.
      if (this.getStripTracking() && stripTracking(url) === tab.lastFollowed) return;
      // A site sending its secure address back to http would otherwise bounce forever.
      if (url.startsWith('http:') && tab.upgrade && tab.upgrade.host === hostOf(url)) {
        event.preventDefault();
        wc.stop();
        this.showNoHttps(tab, 0, 'This site only offers an unencrypted connection.');
        return;
      }
      const pending = tab.upgrade;
      if (this.secureUrl(tab, url) !== url) followSecurely(event, url);
      else tab.upgrade = pending;
    });
    wc.on('will-frame-navigate', (event) => {
      if (event.isMainFrame && !isWebUrl(event.url)) event.preventDefault();
    });

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      this.closeReader(tab);
      tab.error = null;
      tab.blockedBefore = tab.blocked;
      tab.blocked = 0;
      if (isWebUrl(details.url)) tab.url = details.url;
      this.attach(tab);
      update();
    });
    wc.on('did-navigate', (_e, url) => {
      if (isWebUrl(url)) {
        tab.upgrade = null;
        // Chromium only reports a favicon when it changes, so pages on the same site keep theirs.
        if (hostOf(url) !== tab.faviconHost) tab.favicon = '';
        tab.faviconHost = hostOf(url);
        tab.url = url;
        if (!tab.tor) {
          this.emit('visit', url, '');
          const level = this.getSiteZoom(hostOf(url));
          if (wc.getZoomLevel() !== level) wc.setZoomLevel(level);
        }
      }
      update();
    });
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame && isWebUrl(url)) {
        tab.url = url;
        if (!tab.tor) this.emit('visit', url, '');
      }
      update();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      update();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      update();
    });
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      if (!tab.tor) this.emit('title', tab.url, title);
      update();
    });
    wc.on('page-favicon-updated', (_e, favicons) => {
      const icon = favicons.find((u) => /^(https?:|data:image\/)/i.test(u));
      tab.favicon = icon ?? '';
      update();
    });
    wc.on('media-started-playing', update);
    wc.on('audio-state-changed', update);
    wc.on('zoom-changed', (_e, direction) => {
      this.setZoom(tab, wc.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5));
    });
    wc.on('media-paused', update);

    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is an aborted navigation, which also fires when the user stops or moves on.
      if (!isMainFrame || code === -3 || !isCurrent()) return;
      if (tab.upgrade && !NOT_AN_HTTPS_PROBLEM.has(code)) {
        this.showNoHttps(tab, code, description);
        return;
      }
      tab.error = { code, description, url };
      if (isWebUrl(url)) tab.url = url;
      this.attach(tab);
      update();
    });
    wc.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit' || !isCurrent()) return;
      tab.error = { code: 0, description: `This page crashed (${details.reason}).`, url: tab.url };
      this.attach(tab);
      update();
    });

    wc.on('enter-html-full-screen', () => this.setFullscreen(tab, true));
    wc.on('leave-html-full-screen', () => this.setFullscreen(tab, false));
    wc.on('before-input-event', (event, input) => {
      if (this.onShortcut(input)) event.preventDefault();
    });
    wc.on('found-in-page', (_e, result) => this.emit('found', result));
    wc.on('context-menu', (_e, params) => this.contextMenu(tab, wc, params));
  }

  setFullscreen(tab, on) {
    if (tab.id !== this.activeId) return;
    this.fullscreen = on;
    this.window.setFullScreen(on);
    tab.view?.setBounds(on ? this.fullBounds() : this.bounds);
    this.emit('fullscreen', on);
  }

  contextMenu(tab, wc, p) {
    Menu.buildFromTemplate(this.contextItems(tab, wc, p)).popup({ window: this.window });
  }

  contextItems(tab, wc, p) {
    const nav = wc.navigationHistory;
    const items = [];
    const openInNewTab = (url) => this.create(url, { activate: false, tor: tab.tor });
    if (isWebUrl(p.linkURL)) {
      items.push(
        { label: 'Open link in new tab', click: () => openInNewTab(p.linkURL) },
        { label: 'Save link as…', click: () => wc.downloadURL(p.linkURL) },
        { label: 'Copy link address', click: () => clipboard.writeText(p.linkURL) },
        ...(stripTracking(p.linkURL) !== p.linkURL
          ? [{ label: 'Copy link without tracking', click: () => clipboard.writeText(stripTracking(p.linkURL)) }]
          : []),
        { type: 'separator' },
      );
    }
    if (p.mediaType === 'image' && isWebUrl(p.srcURL)) {
      items.push(
        { label: 'Open image in new tab', click: () => openInNewTab(p.srcURL) },
        { label: 'Save image as…', click: () => wc.downloadURL(p.srcURL) },
        { label: 'Copy image', click: () => wc.copyImageAt(p.x, p.y) },
        { type: 'separator' },
      );
    }
    if (p.isEditable) {
      items.push({ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }, { type: 'separator' });
    } else if (p.selectionText) {
      const text = p.selectionText.trim();
      const shown = text.length > 30 ? `${text.slice(0, 30)}…` : text;
      items.push(
        { role: 'copy' },
        { label: `Search for "${shown}"`, click: () => this.create(this.getSearchUrl(text), { tor: tab.tor }) },
        { type: 'separator' },
      );
    }
    items.push(
      { label: 'Back', enabled: nav.canGoBack(), click: () => nav.goBack() },
      { label: 'Forward', enabled: nav.canGoForward(), click: () => nav.goForward() },
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Save page as…', click: () => this.savePage(tab.id) },
      { label: 'Print…', click: () => this.print(tab.id) },
      { type: 'separator' },
      { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) },
    );
    return items;
  }

  applyWebRtcPolicy() {
    for (const tab of this.tabs) {
      if (tab.view && !tab.tor) tab.view.webContents.setWebRTCIPHandlingPolicy(this.getWebRtcPolicy());
    }
  }

  serialize() {
    const saved = this.tabs.filter((t) => t.url && !t.tor);
    return {
      activeIndex: Math.max(0, saved.findIndex((t) => t.id === this.activeId)),
      tabs: saved.map((t) => ({ url: t.url, title: t.title, pinned: t.pinned })),
    };
  }

  dispose() {
    clearInterval(this.sleepTimer);
    for (const tab of this.tabs) this.destroyView(tab);
  }
}

module.exports = { Tabs };
