'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Lets a page's scripts see the Global Privacy Control signal the headers already send.
function announceGlobalPrivacyControl() {
  Object.defineProperty(Navigator.prototype, 'globalPrivacyControl', { get: () => true, configurable: true });
}

if (ipcRenderer.sendSync('tern:gpc-enabled')) {
  contextBridge.executeInMainWorld({ func: announceGlobalPrivacyControl });
}
