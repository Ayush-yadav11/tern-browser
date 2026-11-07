'use strict';

const { EventEmitter } = require('node:events');
const path = require('node:path');
const { JsonFile } = require('./settings');
const { isWebUrl } = require('./url');

const MAX_HISTORY = 5000;
const MAX_URL = 2048;
const MAX_TITLE = 300;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const REVISIT_MS = 30 * 1000;

const text = (value) => (typeof value === 'string' ? value.slice(0, MAX_TITLE) : '');
const validIcon = (value) => (typeof value === 'string' && /^data:image\//.test(value) && value.length < 64 * 1024 ? value : '');
const bareUrl = (url) => url.replace(/^https?:\/\/(?:www\.)?/i, '').toLowerCase();

// Bookmarks and history. Both are plain files in the profile and never leave this PC.
class Library extends EventEmitter {
  constructor(profile, now = Date.now()) {
    super();
    this.bookmarkFile = new JsonFile(path.join(profile, 'bookmarks.json'));
    this.historyFile = new JsonFile(path.join(profile, 'history.json'));
    this.nextId = 1;
    this.bookmarks = [];
    // Kept oldest to newest, so a new visit is re-inserted at the end.
    this.history = new Map();
    this.loadBookmarks();
    this.loadHistory(now);
  }

  loadBookmarks() {
    const saved = this.bookmarkFile.read();
    if (!Array.isArray(saved)) return;
    const seen = new Set();
    for (const b of saved) {
      if (!isWebUrl(b?.url) || seen.has(b.url)) continue;
      seen.add(b.url);
      this.bookmarks.push({
        id: this.nextId++,
        url: b.url,
        title: text(b.title),
        icon: validIcon(b.icon),
        folder: text(b.folder).trim(),
        addedAt: Number(b.addedAt) || 0,
      });
    }
  }

  loadHistory(now) {
    const saved = this.historyFile.read();
    if (!Array.isArray(saved)) return;
    const fresh = saved
      .filter((h) => isWebUrl(h?.url) && now - Number(h.lastVisit) < RETENTION_MS)
      .sort((a, b) => a.lastVisit - b.lastVisit)
      .slice(-MAX_HISTORY);
    for (const h of fresh) {
      this.history.set(h.url, {
        url: h.url,
        title: text(h.title),
        visits: Math.max(1, Number(h.visits) || 1),
        lastVisit: Number(h.lastVisit),
      });
    }
  }

  saveBookmarks() {
    this.bookmarkFile.write(this.bookmarks.map(({ id, ...rest }) => rest));
    this.emit('bookmarks');
  }

  saveHistory() {
    this.historyFile.write([...this.history.values()]);
    this.emit('history');
  }

  bookmarkFor(url) {
    return this.bookmarks.find((b) => b.url === url) ?? null;
  }

  // Returns the bookmark that was added, or null if the page was already bookmarked and got removed.
  toggleBookmark({ url, title, icon }, now = Date.now()) {
    if (!isWebUrl(url)) return null;
    const existing = this.bookmarkFor(url);
    if (existing) {
      this.removeBookmark(existing.id);
      return null;
    }
    const added = { id: this.nextId++, url, title: text(title), icon: validIcon(icon), folder: '', addedAt: now };
    this.bookmarks.push(added);
    this.saveBookmarks();
    return added;
  }

  setBookmarkIcon(id, icon) {
    const bookmark = this.bookmarks.find((b) => b.id === id);
    if (!bookmark || !validIcon(icon)) return;
    bookmark.icon = icon;
    this.saveBookmarks();
  }

  renameBookmark(id, title) {
    const bookmark = this.bookmarks.find((b) => b.id === id);
    if (!bookmark) return;
    bookmark.title = text(title).trim();
    this.saveBookmarks();
  }

  removeBookmark(id) {
    this.bookmarks = this.bookmarks.filter((b) => b.id !== id);
    this.saveBookmarks();
  }

  moveBookmark(id, toIndex) {
    const from = this.bookmarks.findIndex((b) => b.id === id);
    if (from < 0 || !Number.isInteger(toIndex)) return;
    const [bookmark] = this.bookmarks.splice(from, 1);
    this.bookmarks.splice(Math.max(0, Math.min(toIndex, this.bookmarks.length)), 0, bookmark);
    this.saveBookmarks();
  }

  setBookmarkFolder(id, folder) {
    const bookmark = this.bookmarks.find((b) => b.id === id);
    if (!bookmark) return;
    bookmark.folder = text(folder).trim();
    this.saveBookmarks();
  }

  renameFolder(from, to) {
    const name = text(to).trim();
    if (!from || !name) return;
    for (const b of this.bookmarks) if (b.folder === from) b.folder = name;
    this.saveBookmarks();
  }

  // Removes the folder itself. Its bookmarks stay, outside any folder.
  removeFolder(name) {
    for (const b of this.bookmarks) if (b.folder === name) b.folder = '';
    this.saveBookmarks();
  }

  // Adds what isn't already here. Addresses Tern wouldn't open are left out.
  importBookmarks(entries, now = Date.now()) {
    const known = new Set(this.bookmarks.map((b) => b.url));
    let added = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (!isWebUrl(entry.url) || known.has(entry.url) || entry.url.length > MAX_URL) {
        skipped += 1;
        continue;
      }
      known.add(entry.url);
      this.bookmarks.push({
        id: this.nextId++,
        url: entry.url,
        title: text(entry.title).trim(),
        icon: validIcon(entry.icon),
        folder: text(entry.folder).trim(),
        addedAt: now,
      });
      added += 1;
    }
    if (added) this.saveBookmarks();
    return { added, skipped };
  }

  recordVisit(url, title, now = Date.now()) {
    if (!isWebUrl(url) || url.length > MAX_URL) return;
    const previous = this.history.get(url);
    // A reload or a redirect back to the same page isn't a new visit.
    const isNewVisit = !previous || now - previous.lastVisit > REVISIT_MS;
    this.history.delete(url);
    this.history.set(url, {
      url,
      title: text(title) || previous?.title || '',
      visits: (previous?.visits ?? 0) + (isNewVisit ? 1 : 0),
      lastVisit: now,
    });
    while (this.history.size > MAX_HISTORY) this.history.delete(this.history.keys().next().value);
    this.saveHistory();
  }

  updateTitle(url, title) {
    const entry = this.history.get(url);
    if (!entry || !title || entry.title === title) return;
    entry.title = text(title);
    this.saveHistory();
  }

  // Newest first. Every word has to appear somewhere in the title or address.
  searchHistory(query = '', limit = 200) {
    const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const found = [];
    const entries = [...this.history.values()];
    for (let i = entries.length - 1; i >= 0 && found.length < limit; i--) {
      const haystack = `${entries[i].title} ${entries[i].url}`.toLowerCase();
      if (words.every((w) => haystack.includes(w))) found.push(entries[i]);
    }
    return found;
  }

  removeHistory(url) {
    if (this.history.delete(url)) this.saveHistory();
  }

  clearHistory() {
    this.history.clear();
    this.saveHistory();
  }

  // Address bar matches. Works only from local data, so typing sends nothing to anyone.
  suggest(query, limit = 6, now = Date.now()) {
    const typed = String(query).trim().toLowerCase();
    const words = typed.split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const score = (entry, isBookmark) => {
      const url = bareUrl(entry.url);
      const title = (entry.title ?? '').toLowerCase();
      if (!words.every((w) => url.includes(w) || title.includes(w))) return 0;
      let points = 1;
      if (url.startsWith(typed)) points += 100;
      else if (title.startsWith(typed)) points += 40;
      if (isBookmark) points += 30;
      points += Math.min(entry.visits ?? 0, 20);
      if (entry.lastVisit && now - entry.lastVisit < 7 * 24 * 60 * 60 * 1000) points += 10;
      return points;
    };
    const best = new Map();
    for (const entry of this.history.values()) {
      const points = score(entry, false);
      if (points) best.set(entry.url, { url: entry.url, title: entry.title, kind: 'history', points });
    }
    for (const b of this.bookmarks) {
      const seen = this.history.get(b.url);
      const points = score({ ...b, visits: seen?.visits, lastVisit: seen?.lastVisit }, true);
      if (points) best.set(b.url, { url: b.url, title: b.title || seen?.title || '', kind: 'bookmark', points });
    }
    return [...best.values()]
      .sort((a, b) => b.points - a.points)
      .slice(0, limit)
      .map(({ points, ...item }) => item);
  }

  flush() {
    this.bookmarkFile.flush();
    this.historyFile.flush();
  }
}

module.exports = { Library };
