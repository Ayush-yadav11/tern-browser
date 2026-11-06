'use strict';

const $ = (id) => document.getElementById(id);
const api = window.tern;

const ICON = {
  back: '<path d="M10 3L5 8l5 5"/>',
  forward: '<path d="M6 3l5 5-5 5"/>',
  reload: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2v3h-3"/>',
  stop: '<path d="M4 4l8 8M12 4l-8 8"/>',
  home: '<path d="M3 8l5-5 5 5M4.5 7v6h7V7"/>',
  shield: '<path d="M8 2l5 2v4c0 3-2 5-5 6-3-1-5-3-5-6V4z"/>',
  customize: '<path d="M3 5h6M12 5h1M3 11h1M7 11h6"/><circle cx="10.5" cy="5" r="1.5"/><circle cx="5.5" cy="11" r="1.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  up: '<path d="M4 10l4-4 4 4"/>',
  down: '<path d="M4 6l4 4 4-4"/>',
  star: '<path d="M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11l-3.4 1.5.7-3.8-2.8-2.7 3.8-.5z"/>',
  library: '<path d="M3 3v10M6 3v10M9.5 3.5l3.5 9.5"/>',
  downloads: '<path d="M8 2.5v7.5M4.5 7L8 10.5 11.5 7M3 13.5h10"/>',
  edit: '<path d="M3 13l.7-2.8L10.5 3.4l2.1 2.1-6.8 6.8z"/>',
  menu: '<circle cx="8" cy="3.5" r=".6"/><circle cx="8" cy="8" r=".6"/><circle cx="8" cy="12.5" r=".6"/>',
  speaker: '<path d="M3 6.5v3h2.2L8.5 12V4L5.2 6.5zM10.5 6a3 3 0 0 1 0 4M12 4.5a5 5 0 0 1 0 7"/>',
  muted: '<path d="M3 6.5v3h2.2L8.5 12V4L5.2 6.5zM10.5 6.5l3 3M13.5 6.5l-3 3"/>',
  secure: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
  'not-secure': '<path d="M8 2.5l6 10.5H2zM8 6.5v3M8 11.2v.1"/>',
};
const svg = (name) => `<svg viewBox="0 0 16 16" aria-hidden="true">${ICON[name]}</svg>`;
const ITEM_NAMES = { back: 'Back', forward: 'Forward', reload: 'Reload', home: 'New tab page', url: 'Address bar', star: 'Bookmark this page', shield: 'Ad blocker', library: 'Bookmarks and history', downloads: 'Downloads', customize: 'Customize', menu: 'Menu' };
const LOCKED = new Set(['url', 'customize', 'menu']);
const THEMES = [
  ['midnight', 'Night'],
  ['paper', 'Paper'],
  ['lagoon', 'Lagoon'],
  ['moss', 'Moss'],
  ['ember', 'Ember'],
];

let state = null;
let openPanel = null;
let toolbarKey = '';
let bookmarks = [];
let bookmarkedUrls = new Set();
let downloads = [];
let libraryTab = 'bookmarks';
let editingBookmark = null;
let freshDownload = false;
const tabEls = new Map();
const customStyle = document.createElement('style');
document.head.append(customStyle);

const activeTab = () => state?.tabs.find((t) => t.id === state.activeId) ?? null;
const openHost = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/* Toolbar */
function set2(id, fn) {
  const el = $(id);
  if (el) fn(el);
}

function buildToolbar(items) {
  const bar = $('toolbar');
  bar.textContent = '';
  for (const { id, visible } of items) {
    if (!visible) continue;
    if (id === 'url') {
      const form = document.createElement('form');
      form.id = 'address';
      form.className = 'no-drag';
      form.innerHTML = '<span id="secure" hidden></span><input id="address-input" placeholder="Search or enter address" aria-label="Address and search" spellcheck="false" autocomplete="off">';
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        go($('address-input').value);
      });
      const input = form.querySelector('input');
      input.addEventListener('focus', () => input.select());
      // Clicking the page without pressing Enter puts the real address back.
      input.addEventListener('blur', () => setTimeout(renderToolbar, 200));
      wireSuggestions(input, () => {
        input.value = displayUrl(activeTab());
        api.focusPage();
      });
      bar.append(form);
      continue;
    }
    const button = document.createElement('button');
    button.id = `${id}-btn`;
    button.className = 'icon no-drag';
    button.title = ITEM_NAMES[id];
    button.setAttribute('aria-label', ITEM_NAMES[id]);
    button.innerHTML = svg(id);
    if (id === 'shield' || id === 'downloads') button.insertAdjacentHTML('beforeend', '<span class="badge"></span>');
    button.addEventListener('click', () => toolbarAction(id));
    bar.append(button);
  }
  const chip = make('button', 'primary no-drag', 'Restart to update');
  chip.id = 'update-chip';
  chip.hidden = true;
  chip.addEventListener('click', () => api.installUpdate());
  bar.append(chip);
}

function toolbarAction(id) {
  const tab = activeTab();
  if (id === 'back') api.back(tab.id);
  if (id === 'forward') api.forward(tab.id);
  if (id === 'reload') (tab.loading ? api.stop : api.reload)(tab.id);
  if (id === 'home') api.home(tab.id);
  if (id === 'star') api.toggleBookmark();
  if (id === 'menu') {
    const r = $('menu-btn').getBoundingClientRect();
    api.mainMenu(r.left, r.bottom);
  }
  if (['shield', 'library', 'downloads', 'customize'].includes(id)) togglePanel(id);
}

function go(text) {
  hideSuggestions();
  // Focus moving to the page doesn't clear activeElement here, which would freeze the address bar.
  document.activeElement?.blur?.();
  if (text.trim()) api.navigate(state.activeId, text);
}

const displayUrl = (tab) => tab?.url ?? '';

function renderToolbar() {
  const key = JSON.stringify(state.settings.toolbarItems);
  if (key !== toolbarKey) {
    toolbarKey = key;
    buildToolbar(state.settings.toolbarItems);
  }
  const tab = activeTab();
  if (!tab) return;
  const input = $('address-input');
  const editing = document.activeElement === input && document.hasFocus();
  if (input && !editing) input.value = displayUrl(tab);
  set2('secure', (el) => {
    const isHttps = tab.url.startsWith('https:');
    const mark = isHttps ? 'secure' : 'not-secure';
    el.hidden = !tab.url || Boolean(tab.error);
    if (el.dataset.mark !== mark) {
      el.dataset.mark = mark;
      el.className = mark;
      el.innerHTML = svg(mark);
      el.title = isHttps ? 'Connection is encrypted' : "Not secure: this site's connection isn't encrypted";
    }
  });
  const set = (id, fn) => {
    const el = $(id);
    if (el) fn(el);
  };
  set('back-btn', (el) => { el.disabled = !tab.canBack; });
  set('forward-btn', (el) => { el.disabled = !tab.canForward; });
  set('reload-btn', (el) => {
    el.disabled = !tab.url;
    const name = tab.loading ? 'stop' : 'reload';
    if (el.dataset.icon !== name) {
      el.dataset.icon = name;
      el.innerHTML = svg(name);
      el.title = tab.loading ? 'Stop' : 'Reload';
      el.setAttribute('aria-label', el.title);
    }
  });
  set('shield-btn', (el) => {
    const on = state.shield.enabled && !state.shield.allowed;
    el.classList.toggle('off', !on);
    el.querySelector('.badge').textContent = on && tab.blocked ? tab.blocked : '';
    el.setAttribute('aria-pressed', String(openPanel === 'shield'));
    el.title = on ? `Ad blocker: ${tab.blocked} blocked on this page` : 'Ad blocker is off here';
  });
  set('customize-btn', (el) => el.setAttribute('aria-pressed', String(openPanel === 'customize')));
  set('update-chip', (el) => {
    el.hidden = state.update.status !== 'ready';
    el.title = `Tern ${state.update.version} is ready to install`;
  });
  set('library-btn', (el) => el.setAttribute('aria-pressed', String(openPanel === 'library')));
  set('star-btn', (el) => {
    const on = bookmarkedUrls.has(tab.url);
    el.disabled = !tab.url;
    el.classList.toggle('on', on);
    el.title = on ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)';
    el.setAttribute('aria-pressed', String(on));
  });
  set('downloads-btn', (el) => {
    const active = downloads.filter((d) => d.state === 'progressing').length;
    el.querySelector('.badge').textContent = active || '';
    el.classList.toggle('fresh', freshDownload && openPanel !== 'downloads');
    el.setAttribute('aria-pressed', String(openPanel === 'downloads'));
    el.title = active ? `Downloads: ${active} running` : 'Downloads (Ctrl+J)';
  });
}

/* Address bar suggestions. The list itself is a separate view so it can sit above the page. */
let suggestions = [];
let suggestSelected = 0;
let suggestInput = null;
let suggestTyped = '';

const inputRect = (input) => {
  const r = input.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
};

function suggestTheme() {
  const css = getComputedStyle(document.body);
  const theme = {};
  for (const name of ['--raised', '--line', '--hover', '--text', '--muted', '--accent', '--on-accent']) {
    theme[name] = css.getPropertyValue(name).trim();
  }
  theme['--radius'] = getComputedStyle(document.documentElement).getPropertyValue('--radius').trim();
  return theme;
}

function hideSuggestions() {
  if (!suggestions.length && !suggestInput) return;
  suggestions = [];
  suggestInput = null;
  api.suggestHide();
}

async function updateSuggestions(input) {
  suggestTyped = input.value;
  suggestSelected = 0;
  if (!input.value.trim()) {
    hideSuggestions();
    return;
  }
  suggestInput = input;
  const typed = input.value;
  const items = await api.suggest(typed, inputRect(input), suggestTheme());
  // Typing moved on, or the box was left, while that answer was on its way.
  if (suggestInput !== input || input.value !== typed) return;
  suggestions = items;
}

function moveSuggestion(step) {
  if (!suggestions.length) return;
  suggestSelected = (suggestSelected + step + suggestions.length) % suggestions.length;
  suggestInput.value = suggestSelected === 0 ? suggestTyped : suggestions[suggestSelected].value;
  api.suggestSelect(suggestSelected, inputRect(suggestInput));
}

function wireSuggestions(input, onEscape) {
  input.addEventListener('input', () => updateSuggestions(input));
  input.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement !== input && suggestInput === input) hideSuggestions();
  }, 150));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveSuggestion(e.key === 'ArrowDown' ? 1 : -1);
    }
    if (e.key === 'Escape') {
      if (suggestions.length) {
        input.value = suggestTyped;
        hideSuggestions();
      } else {
        onEscape();
      }
    }
  });
}

/* Tabs */
function makeTab(tab) {
  const el = document.createElement('div');
  el.className = 'tab';
  el.draggable = true;
  el.setAttribute('role', 'tab');
  el.innerHTML = '<span class="tab-icon"></span><span class="tab-title"></span>'
    + '<button class="tab-audio" hidden></button>'
    + `<button class="tab-close" aria-label="Close tab" title="Close tab">${svg('close')}</button>`;
  el.addEventListener('mousedown', (e) => {
    if (e.button === 0 && !e.target.closest('.tab-close, .tab-audio')) api.activate(tab.id);
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) api.close(tab.id);
  });
  el.querySelector('.tab-close').addEventListener('click', () => api.close(tab.id));
  el.querySelector('.tab-audio').addEventListener('click', (e) => {
    e.stopPropagation();
    api.toggleMuted(tab.id);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.tabMenu(tab.id);
  });
  el.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/tern-tab', String(tab.id));
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('dragover', (e) => e.preventDefault());
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/tern-tab'));
    if (id && id !== tab.id) api.move(id, state.tabs.findIndex((t) => t.id === tab.id));
  });
  return el;
}

function renderTabs() {
  const list = $('tablist');
  const seen = new Set();
  state.tabs.forEach((tab, index) => {
    seen.add(tab.id);
    let el = tabEls.get(tab.id);
    if (!el) {
      el = makeTab(tab);
      tabEls.set(tab.id, el);
    }
    if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null);
    el.classList.toggle('active', tab.id === state.activeId);
    el.classList.toggle('loading', tab.loading);
    el.classList.toggle('sleeping', tab.sleeping);
    el.classList.toggle('tor', tab.tor);
    el.classList.toggle('pinned', tab.pinned);
    const audio = el.querySelector('.tab-audio');
    audio.hidden = !tab.audible && !tab.muted;
    const sound = tab.muted ? 'muted' : 'speaker';
    if (audio.dataset.mark !== sound) {
      audio.dataset.mark = sound;
      audio.innerHTML = svg(sound);
      audio.title = tab.muted ? 'Unmute this site' : 'Mute this site';
      audio.setAttribute('aria-label', audio.title);
    }
    el.setAttribute('aria-selected', String(tab.id === state.activeId));
    const title = tab.title || (tab.url ? openHost(tab.url) : 'New tab');
    el.querySelector('.tab-title').textContent = title;
    el.title = `${title}${tab.tor ? ' (Tor tab)' : ''}${tab.sleeping ? ' (sleeping)' : ''}`;
    const icon = el.querySelector('.tab-icon');
    const want = tab.loading ? 'loading' : tab.favicon || 'dot';
    if (icon.dataset.src !== want) {
      icon.dataset.src = want;
      icon.textContent = '';
      if (want === 'dot') {
        icon.innerHTML = '<span class="dot"></span>';
      } else if (want !== 'loading') {
        const img = document.createElement('img');
        img.src = want;
        img.alt = '';
        img.addEventListener('error', () => { img.remove(); });
        icon.append(img);
      }
    }
  });
  for (const [id, el] of tabEls) {
    if (!seen.has(id)) {
      el.remove();
      tabEls.delete(id);
    }
  }
}

/* What shows in the content area when no page view covers it */
function renderContent() {
  const tab = activeTab();
  const torWaiting = Boolean(tab?.tor) && state.tor.status !== 'ready';
  const showNew = Boolean(tab) && !tab.url && !tab.error && !torWaiting;
  document.body.classList.toggle('in-tor', Boolean(tab?.tor));
  $('newtab').hidden = !showNew;
  $('tor-status').hidden = !torWaiting;
  $('message').hidden = !tab?.error || torWaiting;
  if (showNew) {
    const n = state.settings.totalBlocked;
    $('newtab-title').textContent = tab.tor ? 'Tor tab' : 'Tern';
    $('newtab-stat').textContent = tab.tor
      ? 'Websites see a Tor address instead of yours. Nothing here is saved, and it all goes when you close your last Tor tab. Signing in to a site still tells it who you are.'
      : n ? `${n.toLocaleString()} ads and trackers blocked so far` : '';
  }
  if (torWaiting) {
    const failed = state.tor.status === 'error';
    $('tor-status-title').textContent = failed ? "Couldn't connect to Tor" : 'Connecting to Tor...';
    $('tor-status-body').textContent = failed
      ? `${state.tor.message} Nothing was loaded, so your IP wasn't exposed.`
      : `${state.tor.percent}%. Nothing loads in this tab until Tor is connected.`;
    $('tor-retry').hidden = !failed;
  }
  if (tab?.error) {
    $('message-title').textContent = tab.error.noHttps ? "This site isn't secure" : "This page didn't load";
    $('message-body').textContent = tab.error.noHttps
      ? "Tern couldn't reach a secure (HTTPS) version, so it hasn't connected. Without encryption, your network could see or change what you send and receive here."
      : friendlyError(tab.error);
    $('message-http').hidden = !tab.error.noHttps;
    $('message-url').textContent = tab.error.url || tab.url;
  }
}

function friendlyError({ code, description }) {
  const known = {
    '-130': "Couldn't reach your proxy. Tern didn't connect without it, so your IP stayed hidden.",
    '-120': "Couldn't connect through the proxy or Tor. Tern didn't connect without it, so your IP stayed hidden.",
    '-105': "That address couldn't be found. Check the spelling.",
    '-106': "You don't seem to be connected to the internet.",
    '-109': "That site couldn't be reached.",
    '-102': 'That site refused the connection.',
    '-118': 'That site took too long to respond.',
    '-137': "That address couldn't be found.",
    '-201': "This site's security certificate is out of date, so Tern didn't open it.",
    '-202': "This site's security certificate isn't trusted, so Tern didn't open it.",
    '-200': "This site's security certificate doesn't match, so Tern didn't open it.",
  };
  return known[String(code)] ?? description ?? 'Something went wrong.';
}

/* Appearance */
function applyAppearance() {
  const s = state.settings;
  const b = document.body;
  b.dataset.theme = s.theme;
  b.dataset.tabs = s.tabPosition;
  b.dataset.toolbar = s.toolbarPosition;
  b.classList.toggle('compact', s.compact);
  b.dataset.side = s.tabPosition !== 'top' && s.sideCollapse ? 'auto' : 'fixed';
  if (b.dataset.side === 'fixed') setSideOpen(false);
  document.documentElement.style.setProperty('--radius', `${s.radius}px`);
  b.style.setProperty('--accent', s.accent || 'var(--theme-accent)');
  if (customStyle.textContent !== s.customCss) customStyle.textContent = s.customCss;

  const css = getComputedStyle(b);
  const hex = (v) => {
    const probe = document.createElement('canvas').getContext('2d');
    probe.fillStyle = v.trim();
    return probe.fillStyle;
  };
  const topIsTabs = s.tabPosition === 'top';
  const overlayColor = topIsTabs ? css.getPropertyValue('--bar-bg') : css.getPropertyValue('--bg');
  const overlay = {
    color: hex(overlayColor),
    symbolColor: hex(css.getPropertyValue('--text')),
    height: s.compact ? 32 : 40,
  };
  const key = JSON.stringify(overlay);
  if (key !== applyAppearance.last) {
    applyAppearance.last = key;
    api.setOverlay(overlay);
  }
}

/* Side panel */
function togglePanel(name) {
  if (openPanel === name) {
    openPanel = null;
    renderPanel();
    renderToolbar();
  } else {
    showPanel(name);
  }
}

function showPanel(name, tab) {
  if (tab) libraryTab = tab;
  if (name === 'library') {
    renderLibrary.historyDirty = true;
    $('library-search').value = '';
  }
  if (name === 'downloads') {
    freshDownload = false;
    api.refreshDownloads();
  }
  openPanel = name;
  renderPanel();
  renderToolbar();
}

function renderPanel() {
  $('panel').hidden = !openPanel;
  $('panel-shield').hidden = openPanel !== 'shield';
  $('panel-customize').hidden = openPanel !== 'customize';
  $('panel-library').hidden = openPanel !== 'library';
  $('panel-downloads').hidden = openPanel !== 'downloads';
  if (openPanel === 'shield') {
    $('panel-title').textContent = 'Ad blocker';
    renderShield();
  }
  if (openPanel === 'customize') {
    $('panel-title').textContent = 'Customize';
    renderCustomize();
  }
  if (openPanel === 'library') {
    $('panel-title').textContent = libraryTab === 'history' ? 'History' : 'Bookmarks';
    renderLibrary();
  }
  if (openPanel === 'downloads') {
    $('panel-title').textContent = 'Downloads';
    renderDownloads();
  }
  watchContent.send();
}

/* Small helpers for the list panels. Page titles and addresses only ever go in as text. */
function make(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function iconButton(name, label, onClick) {
  const b = make('button', 'icon');
  b.innerHTML = svg(name);
  b.title = label;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function bookmarkIcon(bookmark) {
  const box = make('span', 'bm-icon');
  if (bookmark.icon) {
    const img = make('img');
    img.src = bookmark.icon;
    img.alt = '';
    box.append(img);
  } else {
    box.append(make('span', 'dot'));
  }
  return box;
}

function openFromList(el, url) {
  el.addEventListener('click', (e) => api.open(url, e.ctrlKey ? { newTab: true, background: true } : {}));
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) api.open(url, { newTab: true, background: true });
  });
}

function bookmarkChip(bookmark) {
  const chip = make('button', 'bookmark-chip');
  chip.title = `${bookmark.title || bookmark.url}\n${bookmark.url}`;
  chip.append(bookmarkIcon(bookmark), make('span', '', bookmark.title || openHost(bookmark.url)));
  openFromList(chip, bookmark.url);
  return chip;
}

function renderBookmarksBar() {
  const bar = $('bookmarks-bar');
  bar.hidden = !state?.settings.bookmarksBar || !bookmarks.length;
  bar.textContent = '';
  if (!bar.hidden) bar.append(...bookmarks.map(bookmarkChip));
  const shortcuts = $('newtab-shortcuts');
  shortcuts.textContent = '';
  shortcuts.append(...bookmarks.slice(0, 8).map(bookmarkChip));
  watchContent.send?.();
}

function renderLibrary() {
  setSeg('seg-library', libraryTab);
  const isHistory = libraryTab === 'history';
  $('bookmark-list').hidden = isHistory;
  $('history-area').hidden = !isHistory;
  if (!isHistory) renderBookmarkList();
  else if (renderLibrary.historyDirty) refreshHistory();
}
renderLibrary.historyDirty = true;

function renderBookmarkList() {
  const list = $('bookmark-list');
  const words = $('library-search').value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = bookmarks.filter((b) => {
    const haystack = `${b.title} ${b.url}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
  const empty = $('library-empty');
  empty.hidden = shown.length > 0;
  empty.textContent = words.length ? 'No bookmarks match that.' : 'Press the star in the toolbar, or Ctrl+D, to save a page here.';
  const key = JSON.stringify([shown, editingBookmark]);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.textContent = '';
  for (const bookmark of shown) {
    const row = make('li', 'entry');
    row.append(bookmarkIcon(bookmark));
    const main = make('div', 'entry-main');
    if (editingBookmark === bookmark.id) {
      const input = make('input', 'rename');
      input.value = bookmark.title;
      input.setAttribute('aria-label', 'Bookmark name');
      const finish = (save) => {
        editingBookmark = null;
        if (save) api.renameBookmark(bookmark.id, input.value);
        else renderBookmarkList();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => {
        if (editingBookmark === bookmark.id) finish(true);
      });
      main.append(input);
      setTimeout(() => {
        input.focus();
        input.select();
      });
    } else {
      main.append(make('span', 'entry-title', bookmark.title || openHost(bookmark.url)), make('span', 'entry-sub', bookmark.url));
      openFromList(row, bookmark.url);
    }
    row.append(
      main,
      iconButton('edit', 'Rename bookmark', () => {
        editingBookmark = bookmark.id;
        renderBookmarkList();
      }),
      iconButton('close', 'Remove bookmark', () => api.removeBookmark(bookmark.id)),
    );
    // Reordering a filtered list would be guesswork, so dragging only works on the full one.
    if (!words.length) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/tern-bookmark', String(bookmark.id));
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        const id = Number(e.dataTransfer.getData('text/tern-bookmark'));
        if (id && id !== bookmark.id) api.moveBookmark(id, bookmarks.findIndex((b) => b.id === bookmark.id));
      });
    }
    list.append(row);
  }
}

function dayLabel(time) {
  const day = new Date(time).toDateString();
  const today = new Date();
  if (day === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (day === yesterday.toDateString()) return 'Yesterday';
  return new Date(time).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

async function refreshHistory() {
  renderLibrary.historyDirty = false;
  const query = $('library-search').value;
  const entries = await api.searchHistory(query);
  if (query !== $('library-search').value || libraryTab !== 'history') return;
  const list = $('history-list');
  list.textContent = '';
  let currentDay = '';
  for (const entry of entries) {
    const label = dayLabel(entry.lastVisit);
    if (label !== currentDay) {
      currentDay = label;
      list.append(make('div', 'day', label));
    }
    const row = make('div', 'entry');
    const main = make('div', 'entry-main');
    const time = new Date(entry.lastVisit).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    main.append(make('span', 'entry-title', entry.title || openHost(entry.url)), make('span', 'entry-sub', `${time}  ${openHost(entry.url)}`));
    row.title = entry.url;
    row.append(main, iconButton('close', 'Remove from history', () => api.removeHistory(entry.url)));
    openFromList(row, entry.url);
    list.append(row);
  }
  const empty = $('library-empty');
  empty.hidden = entries.length > 0;
  empty.textContent = query.trim() ? 'Nothing in your history matches that.' : 'Pages you visit will show up here.';
  $('history-clear').hidden = entries.length === 0 || Boolean(query.trim());
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function downloadStatus(d) {
  if (d.state === 'completed') return d.missing ? 'File moved or deleted' : formatBytes(d.total);
  if (d.state === 'cancelled') return 'Cancelled';
  if (d.state === 'interrupted') return "Didn't finish";
  const size = d.total ? `${formatBytes(d.received)} of ${formatBytes(d.total)}` : formatBytes(d.received);
  if (d.paused) return `Paused, ${size}`;
  return d.speed ? `${size}, ${formatBytes(d.speed)}/s` : size;
}

function downloadActions(d) {
  if (d.state === 'progressing') {
    return d.paused ? [['resume', 'Resume'], ['cancel', 'Cancel']] : [['pause', 'Pause'], ['cancel', 'Cancel']];
  }
  if (d.state === 'completed' && !d.missing) return [['open', 'Open'], ['show', 'Show in folder']];
  return [];
}

const downloadRows = new Map();
function renderDownloads() {
  const list = $('download-list');
  const seen = new Set();
  downloads.forEach((d, index) => {
    seen.add(d.id);
    let row = downloadRows.get(d.id);
    if (!row) {
      row = make('li', 'download');
      const top = make('div', 'download-top');
      top.append(make('span', 'entry-title'), iconButton('close', 'Remove from list', () => api.downloadAction(d.id, 'remove')));
      const bar = make('div', 'progress');
      bar.append(make('div'));
      row.append(top, bar, make('span', 'entry-sub'), make('div', 'actions'));
      downloadRows.set(d.id, row);
    }
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    const [top, bar, sub, actions] = row.children;
    const name = top.firstChild;
    name.textContent = d.filename;
    name.title = d.path || d.filename;
    name.classList.toggle('failed', d.state !== 'progressing' && d.state !== 'completed');
    top.lastChild.hidden = d.state === 'progressing';
    bar.hidden = d.state !== 'progressing';
    bar.classList.toggle('unknown', !d.total);
    bar.firstChild.style.width = d.total ? `${Math.min(100, (d.received / d.total) * 100)}%` : '';
    sub.textContent = downloadStatus(d);
    // Rebuilt only when the choices change, so progress updates can't swallow a click.
    const wanted = downloadActions(d);
    const key = wanted.map(([action]) => action).join();
    if (actions.dataset.key !== key) {
      actions.dataset.key = key;
      actions.textContent = '';
      for (const [action, label] of wanted) {
        const b = make('button', 'link', label);
        b.type = 'button';
        b.dataset.action = action;
        b.addEventListener('click', () => api.downloadAction(d.id, action));
        actions.append(b);
      }
    }
  });
  for (const [id, row] of downloadRows) {
    if (!seen.has(id)) {
      row.remove();
      downloadRows.delete(id);
    }
  }
  $('downloads-empty').hidden = downloads.length > 0;
  $('downloads-clear').hidden = !downloads.some((d) => d.state !== 'progressing');
}

function renderShield() {
  const tab = activeTab();
  const { shield, settings } = state;
  $('shield-count').textContent = tab?.blocked ?? 0;
  $('shield-count-label').textContent = 'ads and trackers blocked on this page';
  $('shield-host').textContent = shield.host || 'this site';
  $('shield-site').checked = !shield.allowed;
  $('shield-site').disabled = !shield.host || !shield.enabled;
  $('shield-global').checked = shield.enabled;
  $('shield-total').textContent = settings.totalBlocked.toLocaleString();
  $('shield-updated').textContent = new Date(shield.filtersUpdatedAt).toLocaleDateString();
}

function setSeg(id, value) {
  for (const b of $(id).children) {
    b.classList.toggle('on', b.dataset.value === value);
    b.setAttribute('aria-pressed', String(b.dataset.value === value));
  }
}

function renderCustomize() {
  const s = state.settings;
  for (const el of $('themes').children) el.classList.toggle('on', el.dataset.value === s.theme);
  $('accent').value = s.accent || toHex(getComputedStyle(document.body).getPropertyValue('--theme-accent'));
  $('radius').value = s.radius;
  $('radius-value').textContent = `${s.radius}px`;
  $('compact').checked = s.compact;
  setSeg('seg-tabs', s.tabPosition);
  setSeg('seg-toolbar', s.toolbarPosition);
  renderToolbarItems(s.toolbarItems);
  const engine = $('engine');
  if (engine.options.length !== state.searchEngines.length) {
    engine.textContent = '';
    for (const e of state.searchEngines) engine.add(new Option(e.name, e.id));
  }
  engine.value = s.searchEngine;
  $('sleep').value = String(s.sleepMinutes);
  $('bookmarks-bar-toggle').checked = s.bookmarksBar;
  $('save-history').checked = s.saveHistory;
  $('ask-download').checked = s.askDownloadPath;
  $('auto-update').checked = s.autoUpdate;
  $('side-collapse').checked = s.sideCollapse;
  $('https-only').checked = s.httpsOnly;
  $('strip-tracking').checked = s.stripTracking;
  $('gpc').checked = s.globalPrivacyControl;
  $('update-status').textContent = updateStatus(state.update);
  $('update-check').hidden = ['off', 'checking', 'downloading', 'ready'].includes(state.update.status);
  $('auto-update').disabled = state.update.status === 'off';
  $('proxy-enabled').checked = s.proxyEnabled;
  if (document.activeElement !== $('proxy-server')) $('proxy-server').value = s.proxyServer;
  if (document.activeElement !== $('proxy-username')) $('proxy-username').value = s.proxyUsername;
  $('proxy-password').placeholder = s.proxyHasPassword ? 'Saved. Type to replace it.' : '';
  $('about-version').textContent = state.about.version;
  $('about-chromium').textContent = state.about.chromium;
  if (document.activeElement !== $('custom-css')) $('custom-css').value = s.customCss;
}

function updateStatus({ status, version, percent }) {
  if (status === 'off') return 'Updates are only available in the installed app.';
  if (status === 'checking') return 'Checking for updates...';
  if (status === 'downloading') return `Downloading version ${version}: ${percent}%`;
  if (status === 'ready') return `Version ${version} is ready. It installs when you restart or close Tern.`;
  if (status === 'current') return 'Tern is up to date.';
  if (status === 'error') return "Couldn't check for updates. Tern will try again later.";
  return 'Tern checks for updates by itself.';
}

function toHex(value) {
  const probe = document.createElement('canvas').getContext('2d');
  probe.fillStyle = value.trim();
  return probe.fillStyle;
}

function renderToolbarItems(items) {
  const list = $('toolbar-items');
  const key = JSON.stringify(items);
  if (list.dataset.key === key) return;
  list.dataset.key = key;
  list.textContent = '';
  items.forEach((item, i) => {
    const li = document.createElement('li');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = item.visible;
    check.disabled = LOCKED.has(item.id);
    check.setAttribute('aria-label', `Show ${ITEM_NAMES[item.id]}`);
    check.addEventListener('change', () => {
      api.setSettings({ toolbarItems: items.map((x) => (x.id === item.id ? { ...x, visible: check.checked } : x)) });
    });
    const name = document.createElement('span');
    name.textContent = ITEM_NAMES[item.id];
    const move = (delta) => {
      const next = [...items];
      const [taken] = next.splice(i, 1);
      next.splice(i + delta, 0, taken);
      api.setSettings({ toolbarItems: next });
    };
    const arrow = (dir, delta, disabled) => {
      const b = document.createElement('button');
      b.className = 'icon';
      b.innerHTML = svg(dir);
      b.disabled = disabled;
      b.setAttribute('aria-label', `Move ${ITEM_NAMES[item.id]} ${dir}`);
      b.addEventListener('click', () => move(delta));
      return b;
    };
    li.append(check, name, arrow('up', -1, i === 0), arrow('down', 1, i === items.length - 1));
    list.append(li);
  });
}

function wirePanel() {
  for (const [value, label] of THEMES) {
    const b = document.createElement('button');
    b.className = 'theme';
    b.dataset.value = value;
    b.innerHTML = `<span class="swatch" data-theme-swatch="${value}"></span>`;
    b.append(label);
    b.addEventListener('click', () => api.setSettings({ theme: value, accent: '' }));
    $('themes').append(b);
    // Read each theme's colours from the stylesheet so the swatches can't drift from it.
    document.body.dataset.theme = value;
    const css = getComputedStyle(document.body);
    b.firstChild.style.background = `linear-gradient(135deg, ${css.getPropertyValue('--bg')} 50%, ${css.getPropertyValue('--theme-accent')} 50%)`;
  }
  $('panel-close').addEventListener('click', () => togglePanel(openPanel));
  $('accent').addEventListener('input', (e) => api.setSettings({ accent: e.target.value }));
  $('accent-reset').addEventListener('click', (e) => {
    e.preventDefault();
    api.setSettings({ accent: '' });
  });
  $('radius').addEventListener('input', (e) => api.setSettings({ radius: Number(e.target.value) }));
  $('compact').addEventListener('change', (e) => api.setSettings({ compact: e.target.checked }));
  $('engine').addEventListener('change', (e) => api.setSettings({ searchEngine: e.target.value }));
  $('sleep').addEventListener('change', (e) => api.setSettings({ sleepMinutes: Number(e.target.value) }));
  $('custom-css').addEventListener('input', (e) => api.setSettings({ customCss: e.target.value }));
  $('reset').addEventListener('click', () => api.resetSettings());
  $('seg-tabs').addEventListener('click', (e) => {
    if (e.target.dataset.value) api.setSettings({ tabPosition: e.target.dataset.value });
  });
  $('seg-toolbar').addEventListener('click', (e) => {
    if (e.target.dataset.value) api.setSettings({ toolbarPosition: e.target.dataset.value });
  });
  $('bookmarks-bar-toggle').addEventListener('change', (e) => api.setSettings({ bookmarksBar: e.target.checked }));
  $('save-history').addEventListener('change', (e) => api.setSettings({ saveHistory: e.target.checked }));
  $('ask-download').addEventListener('change', (e) => api.setSettings({ askDownloadPath: e.target.checked }));
  $('auto-update').addEventListener('change', (e) => api.setSettings({ autoUpdate: e.target.checked }));
  $('update-check').addEventListener('click', () => api.checkForUpdate());
  $('tor-open').addEventListener('click', () => api.newTorTab());
  $('side-collapse').addEventListener('change', (e) => api.setSettings({ sideCollapse: e.target.checked }));
  $('https-only').addEventListener('change', (e) => api.setSettings({ httpsOnly: e.target.checked }));
  $('strip-tracking').addEventListener('change', (e) => api.setSettings({ stripTracking: e.target.checked }));
  $('gpc').addEventListener('change', (e) => api.setSettings({ globalPrivacyControl: e.target.checked }));
  const clearData = $('clear-data');
  let clearDataTimer = null;
  clearData.addEventListener('click', async () => {
    if (!clearDataTimer) {
      clearData.textContent = 'Click again to clear history, cookies and cache';
      $('clear-data-status').textContent = '';
      clearDataTimer = setTimeout(() => {
        clearDataTimer = null;
        clearData.textContent = 'Clear browsing data';
      }, 4000);
      return;
    }
    clearTimeout(clearDataTimer);
    clearDataTimer = null;
    clearData.textContent = 'Clear browsing data';
    await api.clearBrowsingData();
    $('clear-data-status').textContent = 'Cleared. Sites will have signed you out.';
  });
  const saveProxy = async () => {
    const result = await api.setProxy({
      enabled: $('proxy-enabled').checked,
      server: $('proxy-server').value,
      username: $('proxy-username').value,
      password: $('proxy-password').value,
    });
    $('proxy-password').value = '';
    $('proxy-status').classList.toggle('bad', !result.ok);
    $('proxy-status').textContent = result.ok ? (state.settings.proxyEnabled ? 'Saved.' : 'Saved. Proxy is off.') : result.message;
    if (!result.ok) $('proxy-enabled').checked = state.settings.proxyEnabled;
  };
  $('proxy-save').addEventListener('click', saveProxy);
  $('proxy-enabled').addEventListener('change', saveProxy);
  $('check-ip').addEventListener('click', async () => {
    $('check-ip-result').textContent = 'Checking...';
    const { ip, error } = await api.checkIp();
    $('check-ip-result').textContent = ip ? `Websites see: ${ip}` : error;
  });
  $('seg-library').addEventListener('click', (e) => {
    if (!e.target.dataset.value) return;
    libraryTab = e.target.dataset.value;
    $('library-search').value = '';
    renderLibrary.historyDirty = true;
    renderPanel();
  });
  $('library-search').addEventListener('input', () => {
    if (libraryTab === 'history') refreshHistory();
    else renderBookmarkList();
  });
  // A second click is required because clearing history can't be undone.
  const clearHistory = $('history-clear');
  let clearTimer = null;
  clearHistory.addEventListener('click', () => {
    if (clearTimer) {
      clearTimeout(clearTimer);
      clearTimer = null;
      clearHistory.textContent = 'Clear all history';
      api.clearHistory();
      return;
    }
    clearHistory.textContent = 'Click again to clear everything';
    clearTimer = setTimeout(() => {
      clearTimer = null;
      clearHistory.textContent = 'Clear all history';
    }, 4000);
  });
  $('downloads-clear').addEventListener('click', () => api.clearDownloads());
  $('shield-site').addEventListener('change', () => api.toggleSite());
  $('shield-global').addEventListener('change', (e) => api.setSettings({ adblock: e.target.checked }));
}

/* Side tabs expanding on hover. The page is a separate native view, so the whole interface
   is lifted above it with its middle transparent, and lowered again afterwards. */
let sideOpen = false;
let sideTimer = null;
const SIDE_OPEN_DELAY_MS = 120;
const SIDE_CLOSE_DELAY_MS = 250;
const SIDE_ANIMATION_MS = 130;

// Anything drawn over the page lifts the interface, and it's lowered once nothing needs it.
const lifts = new Set();
function setLift(reason, on) {
  if (on) lifts.add(reason);
  else lifts.delete(reason);
  document.body.classList.toggle('lifted', lifts.size > 0);
  return api.setSideOpen(lifts.size > 0);
}

async function setSideOpen(open) {
  clearTimeout(sideTimer);
  if (sideOpen === open) return;
  sideOpen = open;
  if (open) {
    await setLift('side', true);
    if (sideOpen) document.body.classList.add('side-open');
  } else {
    document.body.classList.remove('side-open');
    sideTimer = setTimeout(() => setLift('side', false), SIDE_ANIMATION_MS);
  }
}

function wireSideTabs() {
  const strip = $('tabs');
  const later = (open, delay) => {
    clearTimeout(sideTimer);
    if (document.body.dataset.side !== 'auto') return;
    sideTimer = setTimeout(() => setSideOpen(open), delay);
  };
  strip.addEventListener('mouseenter', () => later(true, SIDE_OPEN_DELAY_MS));
  strip.addEventListener('mouseleave', () => later(false, SIDE_CLOSE_DELAY_MS));
  strip.addEventListener('focusin', () => later(true, 0));
  strip.addEventListener('focusout', () => later(false, SIDE_CLOSE_DELAY_MS));
}

/* Command palette */
const PALETTE_THEMES = THEMES.map(([id, label]) => [`Theme: ${label}`, () => api.setSettings({ theme: id, accent: '' })]);
const PALETTE_ACTIONS = [
  ['New tab', () => api.newTab()],
  ['New Tor tab', () => api.newTorTab()],
  ['Reopen closed tab', () => api.runAction('reopen')],
  ['Duplicate tab', () => api.runAction('duplicate')],
  ['Pin or unpin tab', () => api.runAction('pin')],
  ['Mute or unmute tab', () => api.runAction('mute')],
  ['Close other tabs', () => api.runAction('closeOthers')],
  ['Close tab', () => api.close(state.activeId)],
  ['Bookmark this page', () => api.toggleBookmark()],
  ['Show bookmarks', () => showPanel('library', 'bookmarks')],
  ['Show history', () => showPanel('library', 'history')],
  ['Show downloads', () => showPanel('downloads')],
  ['Show ad blocker', () => showPanel('shield')],
  ['Customize', () => showPanel('customize')],
  ['Find in page', () => { $('findbar').hidden = false; watchContent.send(); $('find-input').focus(); }],
  ['Print', () => api.runAction('print')],
  ['Save page', () => api.runAction('save')],
  ['Zoom in', () => api.runAction('zoomIn')],
  ['Zoom out', () => api.runAction('zoomOut')],
  ['Reset zoom', () => api.runAction('zoomReset')],
  ['Full screen', () => api.runAction('fullscreen')],
  ['Developer tools', () => api.runAction('devtools')],
  ['Tabs on top', () => api.setSettings({ tabPosition: 'top' })],
  ['Tabs on left', () => api.setSettings({ tabPosition: 'left' })],
  ['Tabs on right', () => api.setSettings({ tabPosition: 'right' })],
  ['Address bar on top', () => api.setSettings({ toolbarPosition: 'top' })],
  ['Address bar on bottom', () => api.setSettings({ toolbarPosition: 'bottom' })],
  ['Compact mode on or off', () => api.setSettings({ compact: !state.settings.compact })],
  ['Exit Tern', () => api.runAction('exit')],
  ...PALETTE_THEMES,
];
const PALETTE_LIMIT = 40;
let paletteItems = [];
let paletteIndex = 0;
let paletteToken = 0;

// Best match first: the start of a word beats the middle of one. Null means no match.
function paletteScore(text, words) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    const at = lower.indexOf(word);
    if (at < 0) return null;
    score += at === 0 ? 3 : /\W/.test(lower[at - 1]) ? 2 : 1;
  }
  return score;
}

function paletteRow(kind, main, sub, run, boost = 0) {
  return { kind, main, sub, run, boost };
}

async function updatePalette() {
  const token = ++paletteToken;
  const query = $('palette-input').value.trim();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tabs = state.tabs.filter((t) => t.id !== state.activeId).map((t) => paletteRow(
    t.tor ? 'Tor tab' : 'Tab',
    t.title || (t.url ? openHost(t.url) : 'New tab'),
    t.url ? openHost(t.url) : '',
    () => api.activate(t.id),
    2,
  ));
  const actions = PALETTE_ACTIONS.map(([label, run]) => paletteRow('Action', label, '', run));
  const marks = bookmarks.map((b) => paletteRow('Bookmark', b.title || openHost(b.url), openHost(b.url), () => api.open(b.url, {}), 1));
  let rows;
  if (!words.length) {
    rows = [...tabs, ...actions];
  } else {
    const history = (await api.searchHistory(query)).slice(0, 12)
      .map((h) => paletteRow('History', h.title || openHost(h.url), openHost(h.url), () => api.open(h.url, {})));
    if (token !== paletteToken) return;
    const seen = new Set();
    rows = [...tabs, ...marks, ...actions, ...history]
      .map((row) => ({ row, score: paletteScore(`${row.main} ${row.sub}`, words) }))
      .filter(({ score }) => score !== null)
      .sort((a, b) => (b.score + b.row.boost) - (a.score + a.row.boost))
      .map(({ row }) => row)
      .filter((row) => {
        const key = `${row.main}|${row.sub}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    rows.push(paletteRow('Go', query, 'Open or search', () => api.navigate(state.activeId, query)));
  }
  paletteItems = rows.slice(0, PALETTE_LIMIT);
  paletteIndex = 0;
  renderPalette();
}

function renderPalette() {
  const list = $('palette-list');
  list.textContent = '';
  paletteItems.forEach((item, index) => {
    const row = make('li');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === paletteIndex));
    row.classList.toggle('on', index === paletteIndex);
    row.append(make('span', 'p-kind', item.kind), make('span', 'p-main', item.main));
    if (item.sub) row.append(make('span', 'p-sub', item.sub));
    row.addEventListener('mousemove', (e) => {
      // Rows appearing under a resting pointer shouldn't change what Enter picks.
      if (paletteIndex === index || (!e.movementX && !e.movementY)) return;
      paletteIndex = index;
      markPaletteRow();
    });
    row.addEventListener('click', () => runPaletteItem(index));
    list.append(row);
  });
}

function markPaletteRow() {
  [...$('palette-list').children].forEach((row, index) => {
    row.classList.toggle('on', index === paletteIndex);
    row.setAttribute('aria-selected', String(index === paletteIndex));
    if (index === paletteIndex) row.scrollIntoView({ block: 'nearest' });
  });
}

async function openPalette() {
  $('palette').hidden = false;
  $('palette-input').value = '';
  await setLift('palette', true);
  $('palette-input').focus();
  updatePalette();
}

function closePalette({ focusPage = true } = {}) {
  if ($('palette').hidden) return;
  $('palette').hidden = true;
  setLift('palette', false);
  if (focusPage) api.focusPage();
}

function runPaletteItem(index) {
  const item = paletteItems[index];
  if (!item) return;
  closePalette({ focusPage: false });
  item.run();
}

function wirePalette() {
  const input = $('palette-input');
  input.addEventListener('input', updatePalette);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePalette();
    if (e.key === 'Enter') runPaletteItem(paletteIndex);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!paletteItems.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      paletteIndex = (paletteIndex + step + paletteItems.length) % paletteItems.length;
      markPaletteRow();
    }
  });
  $('palette').addEventListener('mousedown', (e) => {
    if (e.target === $('palette')) closePalette();
  });
  api.onPaletteOpen(() => {
    if ($('palette').hidden) openPalette();
    else closePalette();
  });
}

/* Find in page */
function wireFind() {
  const input = $('find-input');
  const close = () => {
    $('findbar').hidden = true;
    $('find-count').textContent = '';
    watchContent.send();
    api.findStop();
    api.focusPage();
  };
  const run = (next, forward = true) => api.find(input.value, { next, forward });
  input.addEventListener('input', () => {
    if (!input.value) $('find-count').textContent = '';
    run(false);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run(true, !e.shiftKey);
    if (e.key === 'Escape') close();
  });
  $('find-next').addEventListener('click', () => run(true));
  $('find-prev').addEventListener('click', () => run(true, false));
  $('find-close').addEventListener('click', close);
  api.onFindOpen(() => {
    $('findbar').hidden = false;
    watchContent.send();
    input.focus();
    input.select();
  });
  api.onFound(({ active, total }) => {
    $('find-count').textContent = `${active} of ${total}`;
  });
}

/* Keeps the native page view exactly over #content, whatever the layout does. */
function watchContent() {
  const content = $('content');
  const send = () => {
    const r = content.getBoundingClientRect();
    api.setContentBounds({ x: r.x, y: r.y, width: r.width, height: r.height });
  };
  new ResizeObserver(send).observe(content);
  window.addEventListener('resize', send);
  // A layout switch can move #content without changing its size.
  watchContent.send = send;
}

function render() {
  applyAppearance();
  renderToolbar();
  renderTabs();
  renderContent();
  if (state.settings.bookmarksBar !== render.barOn) {
    render.barOn = state.settings.bookmarksBar;
    renderBookmarksBar();
  }
  if (openPanel) renderPanel();
  watchContent.send();
}

wirePanel();
wireFind();
wireSideTabs();
wirePalette();
watchContent();
$('new-tab').addEventListener('click', () => api.newTab());
$('new-tor-tab').addEventListener('click', () => api.newTorTab());
$('tor-retry').addEventListener('click', () => api.retryTor());
$('message-retry').addEventListener('click', () => api.reload(state.activeId));
$('message-http').addEventListener('click', () => api.allowHttp(state.activeId));
$('newtab-search').addEventListener('submit', (e) => {
  e.preventDefault();
  go($('newtab-input').value);
  $('newtab-input').value = '';
});
wireSuggestions($('newtab-input'), () => {
  $('newtab-input').value = '';
});
api.onSuggestPicked((index) => {
  const item = suggestions[index];
  if (!item) return;
  const input = suggestInput;
  go(item.value);
  if (input?.id === 'newtab-input') input.value = '';
});
api.onBookmarks((next) => {
  bookmarks = next;
  bookmarkedUrls = new Set(next.map((b) => b.url));
  renderBookmarksBar();
  if (state) {
    renderToolbar();
    if (openPanel === 'library') renderLibrary();
  }
});
api.onHistoryChanged(() => {
  if (openPanel === 'library' && libraryTab === 'history') refreshHistory();
  else renderLibrary.historyDirty = true;
});
api.onDownloads((next) => {
  downloads = next;
  if (state) renderToolbar();
  if (openPanel === 'downloads') renderDownloads();
});
api.onDownloadStarted(() => {
  freshDownload = true;
});
api.onOpenPanel(({ panel, tab }) => showPanel(panel, tab));
let focusWhenReady = false;
function focusAddress() {
  if (!state) {
    focusWhenReady = true;
    return;
  }
  const target = activeTab()?.url ? $('address-input') : $('newtab-input');
  target?.focus();
  target?.select();
}
api.onFocusAddress(focusAddress);
api.onState((next) => {
  state = next;
  render();
  if (focusWhenReady) {
    focusWhenReady = false;
    focusAddress();
  }
});
api.ready();
