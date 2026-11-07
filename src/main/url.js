'use strict';

const SEARCH_ENGINES = {
  'ddg-noai': { name: 'DuckDuckGo (no AI)', url: 'https://noai.duckduckgo.com/?q=' },
  'google-web': { name: 'Google (web results only)', url: 'https://www.google.com/search?udm=14&q=' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=' },
};

// Typing "!w cats" or "cats !w" searches that site directly. The list lives here, so
// using a shortcut tells nobody but the site you asked for.
const SEARCH_SHORTCUTS = {
  w: { name: 'Wikipedia', url: 'https://en.wikipedia.org/wiki/Special:Search?search=', home: 'https://en.wikipedia.org/' },
  yt: { name: 'YouTube', url: 'https://www.youtube.com/results?search_query=', home: 'https://www.youtube.com/' },
  g: { name: 'Google', url: 'https://www.google.com/search?udm=14&q=', home: 'https://www.google.com/' },
  d: { name: 'DuckDuckGo', url: 'https://noai.duckduckgo.com/?q=', home: 'https://noai.duckduckgo.com/' },
  gh: { name: 'GitHub', url: 'https://github.com/search?q=', home: 'https://github.com/' },
  r: { name: 'Reddit', url: 'https://www.reddit.com/search/?q=', home: 'https://www.reddit.com/' },
  a: { name: 'Amazon', url: 'https://www.amazon.in/s?k=', home: 'https://www.amazon.in/' },
  so: { name: 'Stack Overflow', url: 'https://stackoverflow.com/search?q=', home: 'https://stackoverflow.com/' },
  mdn: { name: 'MDN', url: 'https://developer.mozilla.org/search?q=', home: 'https://developer.mozilla.org/' },
  npm: { name: 'npm', url: 'https://www.npmjs.com/search?q=', home: 'https://www.npmjs.com/' },
  map: { name: 'OpenStreetMap', url: 'https://www.openstreetmap.org/search?query=', home: 'https://www.openstreetmap.org/' },
  imdb: { name: 'IMDb', url: 'https://www.imdb.com/find/?q=', home: 'https://www.imdb.com/' },
  wt: { name: 'Wiktionary', url: 'https://en.wiktionary.org/wiki/Special:Search?search=', home: 'https://en.wiktionary.org/' },
};

// Returns the shortcut and what to search for, or null if the text doesn't use a known one.
function parseShortcut(text) {
  const match = /^!(\S+)(?:\s+(.*))?$/.exec(text) ?? /^(.*\S)\s+!(\S+)$/.exec(text);
  if (!match) return null;
  const leading = text.startsWith('!');
  const shortcut = SEARCH_SHORTCUTS[(leading ? match[1] : match[2]).toLowerCase()];
  if (!shortcut) return null;
  return { shortcut, query: ((leading ? match[2] : match[1]) ?? '').trim() };
}

const HOST_RE = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|(?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d{1,5})?(?:[/?#].*)?$/i;
const LOCAL_RE = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#].*)?$/i;

function isWebUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

// Turns what was typed in the address bar into a URL. Anything that is not clearly
// a web address becomes a search, so file:, javascript: and chrome: never load.
function resolveInput(input, engineId) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const parsed = parseShortcut(text);
  if (parsed) return parsed.query ? parsed.shortcut.url + encodeURIComponent(parsed.query) : parsed.shortcut.home;
  if (/^https?:\/\//i.test(text) && isWebUrl(text)) return new URL(text).href;
  if (!/\s/.test(text) && HOST_RE.test(text)) {
    const scheme = LOCAL_RE.test(text) ? 'http://' : 'https://';
    if (isWebUrl(scheme + text)) return new URL(scheme + text).href;
  }
  const engine = SEARCH_ENGINES[engineId] ?? SEARCH_ENGINES['ddg-noai'];
  return engine.url + encodeURIComponent(text);
}

function hostOf(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// Addresses that can't have a public certificate, so HTTPS-only mode leaves them alone.
const isLocalHost = (host) => (
  !host.includes('.') || host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
  || /\.(?:localhost|local|lan|internal|home\.arpa|onion)$/.test(host)
);

// Link parameters that only exist to track clicks. Kept short on purpose: anything a site
// might need to work, such as a generic "ref", stays.
const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid', 'twclid', 'ttclid', 'li_fat_id',
  'igshid', 'igsh', 'mc_cid', 'mc_eid', 'mkt_tok', '_hsenc', '_hsmi', 'hsctatracking', 'vero_id', 'wickedid',
  '_openstat', 'oly_anon_id', 'oly_enc_id', 'ml_subscriber', 'ml_subscriber_hash', 'rb_clickid', 's_cid',
]);
const TRACKING_PREFIXES = ['utm_'];
const SITE_TRACKING_PARAMS = [
  [/(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/, ['si']],
  [/(^|\.)(twitter\.com|x\.com)$/, ['s', 't']],
];

// Works on the raw query text, so everything else in the address stays exactly as written.
function stripTracking(url) {
  const hashAt = url.indexOf('#');
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const beforeHash = hashAt < 0 ? url : url.slice(0, hashAt);
  const queryAt = beforeHash.indexOf('?');
  if (queryAt < 0) return url;
  const site = SITE_TRACKING_PARAMS.filter(([host]) => host.test(hostOf(url))).flatMap(([, names]) => names);
  const parts = beforeHash.slice(queryAt + 1).split('&');
  const kept = parts.filter((part) => {
    const name = decodeName(part.split('=')[0]).toLowerCase();
    return !TRACKING_PARAMS.has(name) && !site.includes(name) && !TRACKING_PREFIXES.some((prefix) => name.startsWith(prefix));
  });
  if (kept.length === parts.length) return url;
  const base = beforeHash.slice(0, queryAt);
  return `${base}${kept.length ? `?${kept.join('&')}` : ''}${hash}`;
}

function decodeName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

const isYouTubeHost = (host) => /(^|\.)youtube\.com$/.test(host);

module.exports = { SEARCH_ENGINES, SEARCH_SHORTCUTS, parseShortcut, isWebUrl, resolveInput, hostOf, isLocalHost, isYouTubeHost, stripTracking };
