'use strict';

const { execFile } = require('node:child_process');

const regValue = (output, name) => new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.*?)\\s*$`, 'im').exec(output)?.[1] ?? null;

const readRegistry = (key, name) => new Promise((resolve) => {
  execFile('reg', ['query', key, '/v', name], { windowsHide: true }, (error, stdout) => resolve(error ? null : regValue(stdout, name)));
});

// Whether the installer registered this app, and whether it's what opens https links.
// Reading is all this does: Windows only lets the person using the PC choose the default.
async function defaultBrowserStatus(appName, read = readRegistry) {
  const [registered, progId] = await Promise.all([
    read('HKCU\\Software\\RegisteredApplications', appName),
    read('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId'),
  ]);
  return { installed: Boolean(registered), isDefault: progId === `${appName}URL` };
}

const defaultAppsPage = (appName) => `ms-settings:defaultapps?registeredAppUser=${encodeURIComponent(appName)}`;

module.exports = { defaultAppsPage, defaultBrowserStatus, regValue };
