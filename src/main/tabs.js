'use strict';

const { EventEmitter } = require('node:events');
const { Menu, WebContentsView, clipboard } = require('electron');
const { hostOf, isWebUrl } = require('./url');

const MAX_CLOSED = 20;

// A tab only owns a renderer while it is awake. New tabs and sleeping tabs have
// view === null, and the shell draws whatever belongs in the content area instead.
class Tabs extends EventEmitter {
  constructor({ window, session, torSession, onShortcut, getSleepMinutes, getWebRtcPolicy, getSearchUrl }) {
    super();
    this.window = window;
    this.session = session;
    this.onShortcut = onShortcut;
    this.getSleepMinutes = getSleepMinutes;
    this.torSession = torSession;
    this.torReady = false;
    this.getWebRtcPolicy = getWebRtcPolicy;
    this.getSearchUrl = getSearchUrl;
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
      previous.lastActive = Date.now();
    }
    this.activeId = id;
    tab.lastActive = Date.now();
    if (this.canLoad(tab) && tab.url && !tab.view && !tab.error) this.wake(tab);
    this.attach(tab);
    this.changed();
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
      this.emit('attached');
    }
    tab.view.setBounds(this.fullscreen ? this.fullBounds() : this.bounds);
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

  print(id) {
    this.byId(id)?.view?.webContents.print({}, () => {});
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
    tab.url = url;
    tab.error = null;
    tab.history = null;
    if (!this.canLoad(tab)) {
      this.changed();
      return;
    }
    if (!tab.view) this.createView(tab);
    this.attach(tab);
    tab.view.webContents.loadURL(url).catch(() => {});
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
    const wc = this.active?.view?.webContents;
    if (wc) wc.setZoomLevel(step === 0 ? 0 : wc.getZoomLevel() + step);
  }

  wake(tab) {
    this.createView(tab);
    const wc = tab.view.webContents;
    if (tab.history) {
      wc.navigationHistory.restore(tab.history).catch(() => {});
      tab.history = null;
    } else {
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
    const { view } = tab;
    tab.view = null;
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
    const guard = (event, url) => {
      if (!isWebUrl(url)) event.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('will-frame-navigate', (event) => {
      if (event.isMainFrame && !isWebUrl(event.url)) event.preventDefault();
    });

    wc.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      tab.error = null;
      tab.blockedBefore = tab.blocked;
      tab.blocked = 0;
      if (isWebUrl(details.url)) tab.url = details.url;
      this.attach(tab);
      update();
    });
    wc.on('did-navigate', (_e, url) => {
      if (isWebUrl(url)) {
        // Chromium only reports a favicon when it changes, so pages on the same site keep theirs.
        if (hostOf(url) !== tab.faviconHost) tab.favicon = '';
        tab.faviconHost = hostOf(url);
        tab.url = url;
        if (!tab.tor) this.emit('visit', url, '');
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
      wc.setZoomLevel(wc.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5));
    });
    wc.on('media-paused', update);

    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is an aborted navigation, which also fires when the user stops or moves on.
      if (!isMainFrame || code === -3 || !isCurrent()) return;
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
