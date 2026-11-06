'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ternSuggest', {
  onShow: (callback) => ipcRenderer.on('tern:suggest-show', (_event, payload) => callback(payload)),
  pick: (index) => ipcRenderer.invoke('tern:suggest-pick', index),
});
