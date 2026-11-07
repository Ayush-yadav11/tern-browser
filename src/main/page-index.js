'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_PAGES = 1000;
const MAX_TEXT = 20000;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const UNLOAD_AFTER_MS = 60 * 1000;
const SNIPPET_BEFORE = 60;
const SNIPPET_LENGTH = 180;

// Runs out of reach of the page's scripts. Pages asking for a password or card number
// aren't kept, because their text is likely to be private.
const EXTRACT_TEXT = `(() => {
  if (document.querySelector('input[type="password"], [autocomplete~="cc-number"], [autocomplete~="cc-csc"]')) return null;
  return (document.body?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, ${MAX_TEXT});
})()`;

// Searchable text of visited pages, in one file on this PC. It's only held in memory
// while it's being searched, so it costs nothing the rest of the time.
class PageIndex {
  constructor(profile) {
    this.file = path.join(profile, 'page-text.jsonl');
    this.pages = null;
    this.unloadTimer = null;
  }

  add(url, title, text, now = Date.now()) {
    const trimmed = String(text ?? '').slice(0, MAX_TEXT);
    if (!trimmed) return;
    const entry = { url, title: String(title ?? '').slice(0, 300), text: trimmed, at: now };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
    if (this.pages) {
      this.pages.delete(url);
      this.pages.set(url, entry);
    }
  }

  remove(url) {
    if (!fs.existsSync(this.file)) return;
    fs.appendFileSync(this.file, `${JSON.stringify({ url, deleted: true })}\n`);
    this.pages?.delete(url);
  }

  clear() {
    this.pages = null;
    clearTimeout(this.unloadTimer);
    fs.rmSync(this.file, { force: true });
  }

  // Reads the file, keeps the newest copy of each page, and rewrites it if it has grown stale.
  load(now = Date.now()) {
    clearTimeout(this.unloadTimer);
    this.unloadTimer = setTimeout(() => {
      this.pages = null;
    }, UNLOAD_AFTER_MS);
    this.unloadTimer.unref?.();
    if (this.pages) return this.pages;
    const pages = new Map();
    let lines = 0;
    if (fs.existsSync(this.file)) {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        lines += 1;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (typeof entry?.url !== 'string') continue;
        pages.delete(entry.url);
        if (!entry.deleted && typeof entry.text === 'string' && now - Number(entry.at) < RETENTION_MS) pages.set(entry.url, entry);
      }
    }
    while (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value);
    if (lines > pages.size) {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, [...pages.values()].map((entry) => `${JSON.stringify(entry)}\n`).join(''));
      fs.renameSync(tmp, this.file);
    }
    this.pages = pages;
    return pages;
  }

  // Newest first. Every word has to appear in the page's text.
  search(query, limit = 20, now = Date.now()) {
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const found = [];
    const entries = [...this.load(now).values()];
    for (let i = entries.length - 1; i >= 0 && found.length < limit; i--) {
      const lower = entries[i].text.toLowerCase();
      if (words.every((word) => lower.includes(word))) {
        const at = lower.indexOf(words[0]);
        const start = Math.max(0, at - SNIPPET_BEFORE);
        const snippet = entries[i].text.slice(start, start + SNIPPET_LENGTH).trim();
        found.push({ url: entries[i].url, title: entries[i].title, snippet: `${start > 0 ? '…' : ''}${snippet}…` });
      }
    }
    return found;
  }
}

module.exports = { EXTRACT_TEXT, PageIndex };
