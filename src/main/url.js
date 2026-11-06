'use strict';

const SEARCH_ENGINES = {
  'ddg-noai': { name: 'DuckDuckGo (no AI)', url: 'https://noai.duckduckgo.com/?q=' },
  'google-web': { name: 'Google (web results only)', url: 'https://www.google.com/search?udm=14&q=' },
  startpage: { name: 'Startpage', url: 'https://www.startpage.com/sp/search?query=' },
};

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

const isYouTubeHost = (host) => /(^|\.)youtube\.com$/.test(host);

module.exports = { SEARCH_ENGINES, isWebUrl, resolveInput, hostOf, isYouTubeHost };
