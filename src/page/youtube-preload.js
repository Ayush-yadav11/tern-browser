'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Runs in the page before any of YouTube's own code. The filter engine's rules arrive too
// late for this, because YouTube has already read its ad schedule by the time they're injected.
function removeYouTubeAds() {
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];
  const strip = (data) => {
    if (!data || typeof data !== 'object') return;
    for (const key of AD_KEYS) delete data[key];
    if (data.playerResponse) strip(data.playerResponse);
  };

  const parse = JSON.parse;
  JSON.parse = function ternParse(...args) {
    const value = parse.apply(this, args);
    strip(value);
    return value;
  };

  const readJson = Response.prototype.json;
  Response.prototype.json = async function ternJson() {
    const value = await readJson.call(this);
    strip(value);
    return value;
  };

  // The first video's data is written directly into the page instead of being parsed.
  let initial;
  Object.defineProperty(window, 'ytInitialPlayerResponse', {
    configurable: true,
    get: () => initial,
    set: (value) => {
      strip(value);
      initial = value;
    },
  });

  // Anything that still gets through is skipped.
  setInterval(() => {
    if (!document.querySelector('#movie_player.ad-showing')) return;
    const video = document.querySelector('#movie_player video');
    if (video && Number.isFinite(video.duration)) video.currentTime = video.duration;
    document.querySelector('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern')?.click();
  }, 400);
}

if (/(^|\.)youtube\.com$/.test(location.hostname) && ipcRenderer.sendSync('tern:block-youtube-ads', location.hostname)) {
  contextBridge.executeInMainWorld({ func: removeYouTubeAds });
}
