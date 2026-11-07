'use strict';

// Installs, updates and uninstalls for real, using a separate app called TernUpdateTest so
// the real Tern and its profile aren't touched. Run with: npm run test:update
const assert = require('node:assert/strict');
const { execSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { packageApp } = require('../scripts/package');
const { buildInstaller } = require('../scripts/installer');

const NAME = 'TernUpdateTest';
const PORT = 47831;
const DEBUG_PORT = 9348;
const FEED = `http://127.0.0.1:${PORT}/`;
const OLD = '0.0.1';
const NEW = '0.0.2';
const work = path.join(__dirname, '..', 'out', 'update-test');
const installDir = path.join(os.tmpdir(), `${NAME}-install`);
const profile = path.join(process.env.APPDATA, NAME);
const cache = path.join(process.env.LOCALAPPDATA, `${NAME.toLowerCase()}-updater`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function step(text) {
  console.log(`\n== ${text}`);
}

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(250);
  }
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let next = 1;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    pending.get(msg.id)?.(msg);
  };
  return new Promise((resolve) => {
    ws.onopen = () => resolve({
      close: () => ws.close(),
      evaluate: (expression) => new Promise((done) => {
        const id = next++;
        pending.set(id, (m) => done(m.result?.result?.value));
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      }),
    });
  });
}

function launch() {
  // TERN_TEST keeps the window painting if the display is asleep.
  const child = spawn(path.join(installDir, `${NAME}.exe`), [`--remote-debugging-port=${DEBUG_PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, TERN_TEST: '1' },
  });
  child.unref();
  return child;
}

async function attachShell() {
  const target = await waitFor(async () => {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      return list.find((t) => t.url.includes('index.html'));
    } catch {
      return null;
    }
  }, 30000, 'browser window');
  const shell = await connect(target.webSocketDebuggerUrl);
  await waitFor(() => shell.evaluate('Boolean(state)'), 10000, 'browser state');
  return shell;
}

function stopApp() {
  try {
    execSync(`taskkill /F /T /IM ${NAME}.exe`, { stdio: 'ignore' });
  } catch {
    // It wasn't running.
  }
}

const isRunning = () => execSync(`tasklist /FI "IMAGENAME eq ${NAME}.exe"`, { encoding: 'utf8' }).includes(`${NAME}.exe`);

function uninstallEntry() {
  try {
    const out = execSync('reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s /f TernUpdateTest /d', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const key = out.split(/\r?\n/).find((l) => l.startsWith('HKEY'));
    if (!key) return null;
    const values = execSync(`reg query "${key}"`, { encoding: 'utf8' });
    return { version: /DisplayVersion\s+REG_SZ\s+(.+)/.exec(values)?.[1].trim() };
  } catch {
    return null;
  }
}

// What the installer tells Windows about the browser.
function registration() {
  const read = (key, value) => {
    try {
      const flag = value === '' ? '/ve' : `/v "${value}"`;
      return execSync(`reg query "HKCU\\${key}" ${flag}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  return {
    registered: read('Software\\RegisteredApplications', NAME),
    https: read(`Software\\Clients\\StartMenuInternet\\${NAME}\\Capabilities\\URLAssociations`, 'https'),
    command: read(`Software\\Classes\\${NAME}URL\\shell\\open\\command`, ''),
  };
}

function cleanUp() {
  stopApp();
  const uninstaller = path.join(installDir, `Uninstall ${NAME}.exe`);
  if (fs.existsSync(uninstaller)) {
    try {
      execSync(`"${uninstaller}" /S`, { stdio: 'ignore' });
    } catch {
      // Falls through to removing the folders below.
    }
  }
  for (const dir of [installDir, profile, cache]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      // Temp data. Reported at the end if it's still there.
    }
  }
}

function serve(dir) {
  let tamper = false;
  const server = http.createServer((req, res) => {
    const file = path.join(dir, path.basename(decodeURIComponent(req.url.split('?')[0])));
    if (!fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    if (tamper && file.endsWith('.exe')) {
      // Same size, one changed byte: what a corrupted or swapped download looks like.
      const bytes = Buffer.from(fs.readFileSync(file));
      bytes[bytes.length - 100] ^= 0xff;
      res.writeHead(200, { 'content-length': bytes.length });
      res.end(bytes);
      return;
    }
    res.writeHead(200, { 'content-length': fs.statSync(file).size });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve({
    close: () => server.close(),
    setTamper: (on) => { tamper = on; },
  })));
}

async function buildVersion(version) {
  const appDir = await packageApp({ name: NAME, version, feedUrl: FEED, out: path.join(work, `app-${version}`) });
  const outDir = path.join(work, `installer-${version}`);
  await buildInstaller({ appDir, name: NAME, appId: 'app.tern.updatetest', version, feedUrl: FEED, desktopShortcut: false, outDir });
  return { outDir, installer: path.join(outDir, `${NAME}-Setup-${version}.exe`) };
}

(async () => {
  fs.rmSync(work, { recursive: true, force: true });
  cleanUp();

  step('Building two versions');
  const oldBuild = await buildVersion(OLD);
  const newBuild = await buildVersion(NEW);
  const setupMb = Math.round(fs.statSync(newBuild.installer).size / 1024 / 1024);
  console.log(`Installer size: ${setupMb} MB`);
  assert.ok(fs.existsSync(path.join(newBuild.outDir, 'latest.yml')), 'update description file was made');

  step(`Installing ${OLD} silently`);
  execSync(`"${oldBuild.installer}" /S /D=${installDir}`, { stdio: 'ignore' });
  await waitFor(() => fs.existsSync(path.join(installDir, `${NAME}.exe`)), 60000, 'installed files');
  await waitFor(() => uninstallEntry()?.version === OLD, 30000, 'Windows uninstall entry');
  stopApp();
  await sleep(1000);
  console.log('PASS  files installed, listed in Windows Apps');
  const startMenu = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${NAME}.lnk`);
  assert.ok(fs.existsSync(startMenu), 'Start Menu shortcut');
  console.log('PASS  Start Menu shortcut exists');
  const listed = registration();
  assert.ok(listed.registered?.includes(`StartMenuInternet\\${NAME}\\Capabilities`), 'listed with Windows as a browser');
  assert.ok(listed.https?.includes(`${NAME}URL`), 'offers to open https links');
  assert.ok(listed.command?.includes(`${NAME}.exe`) && listed.command.includes('"%1"'), 'opens links with the installed program');
  console.log('PASS  registered with Windows as a browser');

  const server = await serve(newBuild.outDir);
  try {
    step('A damaged download must be refused');
    server.setTamper(true);
    launch();
    let shell = await attachShell();
    assert.equal(await shell.evaluate('state.about.version'), OLD);
    await shell.evaluate(`(async () => {
      document.getElementById('customize-btn').click();
      await new Promise((r) => setTimeout(r, 300));
      document.getElementById('update-check').click();
    })()`);
    const refused = await waitFor(async () => {
      const u = await shell.evaluate('state.update');
      return u?.status === 'error' ? u : null;
    }, 60000, 'damaged download to be refused');
    assert.notEqual(await shell.evaluate('state.update.status'), 'ready');
    console.log(`PASS  refused: ${refused.message}`);
    shell.close();
    stopApp();
    await sleep(1500);
    assert.equal(uninstallEntry()?.version, OLD, 'still the old version');
    fs.rmSync(cache, { recursive: true, force: true });

    step('A good update downloads by itself and shows the restart button');
    server.setTamper(false);
    launch();
    shell = await attachShell();
    await shell.evaluate(`window.tern.setSettings({ theme: 'moss' })`);
    await sleep(1200);
    const ready = await waitFor(async () => {
      const u = await shell.evaluate('state.update');
      return u?.status === 'ready' ? u : null;
    }, 90000, 'automatic update download');
    assert.equal(ready.version, NEW);
    await waitFor(() => shell.evaluate(`!document.getElementById('update-chip').hidden`), 5000, 'restart button');
    console.log(`PASS  ${NEW} downloaded with no clicks, restart button showing`);

    step('Restarting installs it');
    await shell.evaluate(`document.getElementById('update-chip').click()`).catch(() => {});
    shell.close();
    await waitFor(() => uninstallEntry()?.version === NEW, 90000, 'new version installed');
    console.log('PASS  Windows reports the new version');
    await waitFor(isRunning, 30000, 'app to reopen by itself');
    console.log('PASS  reopened by itself');
    await sleep(3000);
    stopApp();
    await sleep(1500);

    launch();
    shell = await attachShell();
    assert.equal(await shell.evaluate('state.about.version'), NEW);
    assert.equal(await shell.evaluate('state.settings.theme'), 'moss', 'settings kept');
    await waitFor(() => shell.evaluate(`state.update.status === 'idle' || state.update.status === 'current'`), 5000, 'updater idle');
    console.log(`PASS  running ${NEW}, in the same folder, settings kept`);
    assert.ok(registration().registered, 'updating keeps the browser registered');
    console.log('PASS  still registered as a browser after updating');
    const beforeTabs = await shell.evaluate('state.tabs.length');
    spawn(path.join(installDir, `${NAME}.exe`), ['https://link-from-another-app.example/page'], { stdio: 'ignore', env: { ...process.env, TERN_TEST: '1' } });
    await waitFor(() => shell.evaluate(`state.tabs.length > ${beforeTabs} && state.tabs.some((t) => t.url.startsWith('https://link-from-another-app.example/'))`), 15000, 'a link from another program to open in a tab');
    console.log('PASS  a link from another program opens in the running browser');
    shell.close();
    stopApp();
    await sleep(1500);
  } finally {
    server.close();
  }

  step('Uninstalling');
  execSync(`"${path.join(installDir, `Uninstall ${NAME}.exe`)}" /S`, { stdio: 'ignore' });
  await waitFor(() => !fs.existsSync(path.join(installDir, `${NAME}.exe`)), 60000, 'files removed');
  await waitFor(() => !uninstallEntry(), 30000, 'uninstall entry removed');
  assert.ok(!fs.existsSync(startMenu), 'shortcut removed');
  assert.ok(fs.existsSync(path.join(profile, 'settings.json')), 'profile kept');
  console.log('PASS  program removed, your data kept');
  const gone = registration();
  assert.ok(!gone.registered && !gone.https && !gone.command, 'uninstalling removes the browser registration');
  console.log('PASS  browser registration removed');

  // Windows holds profile files for a moment after the app exits.
  await sleep(4000);
  cleanUp();
  console.log(`\nUPDATE TEST PASS (leftovers: ${[installDir, profile, cache].filter((d) => fs.existsSync(d)).length})`);
  process.exit(0);
})().catch((error) => {
  console.error(`\nUPDATE TEST FAIL: ${error.message}`);
  cleanUp();
  process.exit(1);
});
