'use strict';

// Wraps a packaged app in a Windows installer. Run with: npm run installer
const path = require('node:path');
const builder = require('electron-builder');
const { packageApp, RELEASES } = require('./package');

const root = path.join(__dirname, '..');

async function buildInstaller({
  appDir,
  name = 'Tern',
  appId = 'app.tern.browser',
  version,
  feedUrl,
  desktopShortcut = true,
  outDir = path.join(root, 'out', 'installer'),
}) {
  await builder.build({
    projectDir: root,
    prepackaged: appDir,
    targets: builder.Platform.WINDOWS.createTarget('nsis', builder.Arch.x64),
    publish: 'never',
    config: {
      appId,
      productName: name,
      artifactName: '${productName}-Setup-${version}.${ext}',
      npmRebuild: false,
      extraMetadata: version ? { version } : undefined,
      directories: { output: outDir },
      win: {
        icon: path.join(root, 'assets', 'icon.ico'),
        executableName: name,
        // There's no certificate to sign with, and the packaging step already set the icon.
        signAndEditExecutable: false,
      },
      nsis: {
        include: path.join(root, 'build', 'installer.nsh'),
        oneClick: true,
        perMachine: false,
        createDesktopShortcut: desktopShortcut,
        createStartMenuShortcut: true,
        shortcutName: name,
        runAfterFinish: true,
        // Bookmarks, history and settings stay if Tern is uninstalled.
        deleteAppDataOnUninstall: false,
        installerIcon: path.join(root, 'assets', 'icon.ico'),
        uninstallerIcon: path.join(root, 'assets', 'icon.ico'),
      },
      publish: feedUrl ? [{ provider: 'generic', url: feedUrl }] : [{ provider: 'github', ...RELEASES }],
    },
  });
  return outDir;
}

if (require.main === module) {
  packageApp()
    .then((appDir) => buildInstaller({ appDir }))
    .then((outDir) => console.log(`Installer is in ${outDir}`))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = { buildInstaller };
