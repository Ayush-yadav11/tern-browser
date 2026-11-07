'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_IMPORT_BYTES = 30 * 1024 * 1024;
// Other browsers' top-level containers, which aren't folders anyone made.
const CONTAINER_FOLDERS = new Set(['bookmarks bar', 'bookmarks toolbar', 'favorites bar', 'bookmarks menu', 'other bookmarks', 'mobile bookmarks']);
const FOLDER_SEPARATOR = ' / ';

const folderPath = (names) => names
  .map((name) => String(name ?? '').trim())
  .filter((name) => name && !CONTAINER_FOLDERS.has(name.toLowerCase()))
  .join(FOLDER_SEPARATOR);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code) => {
    if (code[0] !== '#') return ENTITIES[code.toLowerCase()] ?? whole;
    const number = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : whole;
  });
}

const stripTags = (html) => decodeEntities(html.replace(/<[^>]*>/g, '')).trim();

function attribute(tag, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag);
  return match ? decodeEntities(match[1]) : '';
}

// The bookmarks file format every browser exports. It's loose old HTML, so this reads the
// few parts that matter: folder headings, links, and where each list starts and ends.
function parseBookmarksHtml(html) {
  const entries = [];
  const folders = [];
  let pending = null;
  const token = /<H3\b[^>]*>([\s\S]*?)<\/H3>|<A\b([^>]*)>([\s\S]*?)<\/A>|<DL\b[^>]*>|<\/DL>/gi;
  for (let match = token.exec(html); match; match = token.exec(html)) {
    const tag = match[0].slice(0, 4).toUpperCase();
    if (tag.startsWith('<H3')) {
      pending = stripTags(match[1]);
    } else if (tag.startsWith('<A')) {
      entries.push({
        url: attribute(match[2], 'HREF'),
        title: stripTags(match[3]),
        icon: attribute(match[2], 'ICON'),
        folder: folderPath(folders),
      });
    } else if (tag.startsWith('</DL')) {
      folders.pop();
    } else {
      folders.push(pending);
      pending = null;
    }
  }
  return entries;
}

// Chrome, Edge, Brave and Vivaldi all keep bookmarks in the same JSON file.
function parseChromiumBookmarks(text) {
  const entries = [];
  const walk = (node, names) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'url') entries.push({ url: String(node.url ?? ''), title: String(node.name ?? ''), icon: '', folder: folderPath(names) });
    if (Array.isArray(node.children)) {
      const next = node.type === 'folder' ? [...names, node.name] : names;
      node.children.forEach((child) => walk(child, next));
    }
  };
  Object.values(JSON.parse(text).roots ?? {}).forEach((root) => walk(root, []));
  return entries;
}

function readLimited(file) {
  if (fs.statSync(file).size > MAX_IMPORT_BYTES) throw new Error('That file is too large to be a bookmarks file.');
  return fs.readFileSync(file, 'utf8');
}

function readBookmarksFile(file) {
  const text = readLimited(file);
  return text.trimStart().startsWith('{') ? parseChromiumBookmarks(text) : parseBookmarksHtml(text);
}

const escapeHtml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function toBookmarksHtml(bookmarks) {
  const row = (b) => `<DT><A HREF="${escapeHtml(b.url)}" ADD_DATE="${Math.floor((b.addedAt || 0) / 1000)}"${b.icon ? ` ICON="${escapeHtml(b.icon)}"` : ''}>${escapeHtml(b.title || b.url)}</A>`;
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>Bookmarks</H1>', '<DL><p>'];
  lines.push(...bookmarks.filter((b) => !b.folder).map(row));
  const folders = [...new Set(bookmarks.map((b) => b.folder).filter(Boolean))];
  for (const folder of folders) {
    lines.push(`<DT><H3>${escapeHtml(folder)}</H3>`, '<DL><p>', ...bookmarks.filter((b) => b.folder === folder).map(row), '</DL><p>');
  }
  lines.push('</DL><p>');
  return `${lines.join('\n')}\n`;
}

const BROWSERS = [
  { id: 'chrome', name: 'Chrome', dir: ['Google', 'Chrome', 'User Data'] },
  { id: 'edge', name: 'Edge', dir: ['Microsoft', 'Edge', 'User Data'] },
  { id: 'brave', name: 'Brave', dir: ['BraveSoftware', 'Brave-Browser', 'User Data'] },
  { id: 'vivaldi', name: 'Vivaldi', dir: ['Vivaldi', 'User Data'] },
];

// Finds the bookmark files of browsers on this PC, one per profile. Reads nothing else.
function findBrowsers(localAppData = process.env.LOCALAPPDATA ?? '') {
  return BROWSERS.flatMap((browser) => {
    const root = path.join(localAppData, ...browser.dir);
    let profiles = [];
    try {
      profiles = fs.readdirSync(root).filter((name) => name === 'Default' || /^Profile \d+$/.test(name));
    } catch {
      return [];
    }
    const files = profiles.map((name) => path.join(root, name, 'Bookmarks')).filter((file) => fs.existsSync(file));
    return files.length ? [{ id: browser.id, name: browser.name, files }] : [];
  });
}

module.exports = { findBrowsers, parseBookmarksHtml, parseChromiumBookmarks, readBookmarksFile, toBookmarksHtml };
