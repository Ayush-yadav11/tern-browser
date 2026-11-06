'use strict';

const { app, BaseWindow } = require('electron');
const { start } = require('./app');
const { isWebUrl } = require('./url');

// The name decides the profile folder, so the update test's copy can't touch the real profile.
app.setName(app.getName());
app.setAppUserModelId('app.tern.browser');

const urlFromArgs = (argv) => argv.slice(1).find((arg) => isWebUrl(arg)) ?? '';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let browser = null;
  app.on('second-instance', (_e, argv) => {
    if (!browser) return;
    if (browser.win.isMinimized()) browser.win.restore();
    browser.win.focus();
    const url = urlFromArgs(argv);
    if (url) browser.tabs.create(url);
  });
  app.on('window-all-closed', () => app.quit());
  start({ openUrl: urlFromArgs(process.argv) })
    .then((b) => {
      browser = b;
    })
    .catch((error) => {
      console.error(error);
      for (const win of BaseWindow.getAllWindows()) win.destroy();
      app.exit(1);
    });
}
