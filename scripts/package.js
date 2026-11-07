'use strict';

// Builds out/Tern-win32-x64/Tern.exe. Run with: npm run package
const fs = require('node:fs');
const path = require('node:path');
const { packager } = require('@electron/packager');
const { flipFuses, FuseV1Options, FuseVersion } = require('@electron/fuses');

const root = path.join(__dirname, '..');
const KEEP_LOCALES = new Set(['en-US.pak']);
const RELEASES = { owner: 'Ayush-yadav11', repo: 'tern-browser' };

function folderSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? folderSize(full) : fs.statSync(full).size;
  }
  return total;
}

// `name`, `version` and `feedUrl` exist so test/update.js can build a separate copy that
// can't touch the real Tern, its profile or its update feed.
async function packageApp({ name = 'Tern', version, feedUrl, out = path.join(root, 'out') } = {}) {
  const tor = path.join(root, 'vendor', 'tor');
  if (!fs.existsSync(path.join(tor, 'tor', 'tor.exe'))) throw new Error('Tor is missing. Run: npm run fetch-tor');
  const [appDir] = await packager({
    dir: root,
    out,
    name,
    executableName: name,
    appVersion: version,
    platform: 'win32',
    arch: 'x64',
    overwrite: true,
    asar: true,
    prune: true,
    extraResource: [tor],
    icon: path.join(root, 'assets', 'icon.ico'),
    appBundleId: 'app.tern.browser',
    win32metadata: { CompanyName: 'Tern', FileDescription: 'Tern Browser', ProductName: name },
    ignore: [/^\/test($|\/)/, /^\/out($|\/)/, /^\/scripts($|\/)/, /^\/docs($|\/)/, /^\/\.github($|\/)/, /^\/vendor($|\/)/, /^\/build($|\/)/, /(?<!LICENSE)\.md$/i],
    afterCopy: [async ({ buildPath }) => {
      const file = path.join(buildPath, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      pkg.productName = name;
      if (version) pkg.version = version;
      fs.writeFileSync(file, JSON.stringify(pkg, null, 2));
    }],
  });

  // The UI is English only for now, so other languages are just wasted disk.
  const locales = path.join(appDir, 'locales');
  for (const file of fs.readdirSync(locales)) {
    if (!KEEP_LOCALES.has(file)) fs.rmSync(path.join(locales, file));
  }

  const cacheName = `${name.toLowerCase()}-updater`;
  const feed = feedUrl
    ? `provider: generic\nurl: ${feedUrl}\n`
    : `provider: github\nowner: ${RELEASES.owner}\nrepo: ${RELEASES.repo}\n`;
  fs.writeFileSync(path.join(appDir, 'resources', 'app-update.yml'), `${feed}updaterCacheDirName: ${cacheName}\n`);

  // Closes off the ways a shipped Electron app can be turned into a general script runner.
  await flipFuses(path.join(appDir, `${name}.exe`), {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableCookieEncryption]: true,
  });

  console.log(`Built ${path.join(appDir, `${name}.exe`)} (${Math.round(folderSize(appDir) / 1024 / 1024)} MB on disk)`);
  return appDir;
}

if (require.main === module) {
  packageApp().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { packageApp, RELEASES };
