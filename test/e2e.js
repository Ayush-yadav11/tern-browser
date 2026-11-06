'use strict';

// Drives the real browser code with a throwaway profile. Run with: npm test
// Set TERN_LIVE=1 to also load a real ad-heavy site (needs internet).
process.env.TERN_TEST = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');
const { start } = require('../src/main/app');
const { resolveInput } = require('../src/main/url');
const { clean } = require('../src/main/settings');
const { isRisky } = require('../src/main/downloads');
const { Library } = require('../src/main/library');

const OUT = path.join(__dirname, 'output');
// Filters skip raw IP addresses, so the local test server needs a normal-looking name.
const TEST_HOST = 'fixture.example.com';
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${TEST_HOST} 127.0.0.1`);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
  } catch (error) {
    results.push({ name, ok: false });
    const where = /e2e\.js:(\d+)/.exec(error.stack.split('\n').slice(1).find((l) => l.includes('e2e.js') && !l.includes('waitFor')) ?? '');
    console.log(`FAIL  ${name}${where ? ` (e2e.js line ${where[1]})` : ''}\n      ${String(error.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

function serve() {
  const page = fs.readFileSync(path.join(__dirname, 'fixtures', 'ads.html'));
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/ok.gif')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    } else if (req.url.startsWith('/doc.pdf')) {
      const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF';
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(pdf);
    } else if (req.url.startsWith('/report.txt') || req.url.startsWith('/popup.txt')) {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment' });
      res.end('hello from the test server');
    } else if (req.url.startsWith('/slow.bin')) {
      // Slow enough to pause and cancel while it's running.
      const chunk = Buffer.alloc(64 * 1024);
      const total = 40;
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment', 'content-length': String(total * chunk.length) });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(chunk);
        if (++sent === total) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
      res.on('close', () => clearInterval(timer));
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page);
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Stands in for Tor. Anything it answers is proof the page really went through the proxy,
// and it records the host names it's asked for.
function fakeSocks() {
  const seen = [];
  const page = `<!doctype html><title>through the proxy</title><p>ok<script>document.cookie = 'tor=1';</script>
    <a id="popup" href="http://popup.invalid/" target="_blank">popup</a><link rel="icon" href="http://icon.invalid/i.png">`;
  const server = net.createServer((socket) => {
    socket.on('error', () => {});
    let stage = 0;
    socket.on('data', (data) => {
      if (stage === 0) {
        socket.write(Buffer.from([5, 0]));
        stage = 1;
      } else if (stage === 1) {
        // Address type 3 means the host name came here unresolved, so no local DNS lookup happened.
        const type = data[3];
        const host = type === 3 ? data.subarray(5, 5 + data[4]).toString() : `ip:${[...data.subarray(4, 8)].join('.')}`;
        seen.push({ type, host });
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        stage = 2;
      } else {
        socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(page)}\r\n\r\n${page}`);
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

// A password-protected web proxy, standing in for a paid proxy service.
function fakeWebProxy(expected) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from(expected).toString('base64')}`) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' });
      res.end();
      return;
    }
    seen.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>through web proxy</title><p>ok');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

const waitFor = async (fn, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await sleep(100);
  }
};

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-test-'));
  const downloadDir = path.join(profile, 'my-downloads');
  app.setPath('downloads', downloadDir);
  const t0 = Date.now();
  const server = await serve();
  const base = `http://${TEST_HOST}:${server.address().port}`;
  const b = await start({ userData: profile, show: true });
  const startMs = Date.now() - t0;
  const { tabs, shell, win } = b;
  const shellEval = (code) => shell.executeJavaScript(code, true);
  const inShell = (fn) => shellEval(`(${fn})()`);
  const shot = async (wc, name) => {
    await sleep(400);
    // Windows can't capture while the screen is locked or off. That says nothing about the browser.
    try {
      const image = await wc.capturePage();
      fs.writeFileSync(path.join(OUT, `${name}.png`), image.toPNG());
    } catch (error) {
      console.log(`NOTE  screenshot ${name} skipped: ${error.message}`);
    }
  };
  const load = async (url) => {
    const tab = tabs.active;
    tabs.navigate(tab.id, url);
    await waitFor(() => tab.view && !tab.loading && tab.url.startsWith(url.split('?')[0]));
    return tab;
  };
  const measureMemory = async () => {
    await sleep(1500);
    // Private memory: working sets count shared pages once per process and overstate the total.
    const metrics = app.getAppMetrics();
    const parts = metrics.map((m) => `${m.type} ${Math.round(m.memory.privateBytes / 1024)}`);
    const total = Math.round(metrics.reduce((sum, m) => sum + m.memory.privateBytes, 0) / 1024);
    return `${total} MB private [${parts.join(', ')}]`;
  };

  await sleep(500);
  const idleMemory = await measureMemory();

  await check('address bar: words search, domains load, unsafe schemes never load', () => {
    assert.equal(resolveInput('example.com', 'ddg-noai'), 'https://example.com/');
    assert.equal(resolveInput('localhost:3000/x', 'ddg-noai'), 'http://localhost:3000/x');
    assert.ok(resolveInput('hello world', 'ddg-noai').startsWith('https://noai.duckduckgo.com/'));
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'chrome://settings', 'data:text/html,x']) {
      assert.ok(resolveInput(bad, 'ddg-noai').startsWith('https://noai.duckduckgo.com/'), bad);
    }
  });

  await check('settings: a damaged file cannot lose controls or set bad values', () => {
    const s = clean({ theme: 'x', radius: 99, accent: 'red;', toolbarItems: [{ id: 'url', visible: false }, { id: 'nope' }] });
    assert.equal(s.theme, 'midnight');
    assert.equal(s.radius, 16);
    assert.equal(s.accent, '');
    assert.equal(s.toolbarItems.length, 11);
    assert.equal(s.toolbarItems.find((i) => i.id === 'url').visible, true);
  });

  await check('settings: toolbars saved by the older version gain the new buttons in sensible places', () => {
    const older = ['customize', 'url', 'back', 'forward', 'reload', 'home', 'shield'].map((id) => ({ id, visible: id !== 'home' }));
    const { toolbarItems: items } = clean({ toolbarItems: older });
    const ids = items.map((i) => i.id);
    assert.equal(ids[0], 'customize', 'custom order is kept');
    assert.equal(ids.indexOf('star'), ids.indexOf('url') + 1);
    assert.equal(ids.indexOf('library'), ids.indexOf('shield') + 1);
    assert.equal(ids.indexOf('downloads'), ids.indexOf('library') + 1);
    assert.equal(items.find((i) => i.id === 'home').visible, false, 'hidden stays hidden');
  });

  await check('new tab uses no page process until you navigate', async () => {
    assert.equal(tabs.active.view, null);
    assert.equal(await shellEval("document.getElementById('newtab').hidden"), false);
    await shot(shell, '01-new-tab');
  });

  const tab = await load(`${base}/ads`);
  const wc = () => tab.view.webContents;
  await wc().executeJavaScript('window.ready');
  const pageResults = await wc().executeJavaScript('window.results');

  await check('ad blocking: ad and tracker requests are stopped, normal ones pass', () => {
    assert.equal(pageResults.doubleclick, 'error', 'doubleclick');
    assert.equal(pageResults.analytics, 'error', 'analytics');
    assert.equal(pageResults.adsense, 'error', 'adsense');
    assert.equal(pageResults.control, 'loaded', 'control image');
    assert.ok(tab.blocked >= 3, `counter was ${tab.blocked}`);
    return `${tab.blocked} blocked`;
  });

  await check('ad blocking: ad boxes on the page are hidden, normal content stays', async () => {
    const shown = (id) => `getComputedStyle(document.getElementById('${id}')).display !== 'none'`;
    await waitFor(() => wc().executeJavaScript(`!(${shown('cosmetic-1')}) && !(${shown('cosmetic-2')})`), 6000);
    assert.equal(await wc().executeJavaScript(shown('control')), true);
  });
  await shot(wc(), '02-ads-blocked');

  await check('per-site switch: allowing a site lets ads through, turning it back blocks them', async () => {
    b.updateSettings({ allowedSites: [TEST_HOST] });
    wc().reload();
    await sleep(300);
    await waitFor(() => !tab.loading);
    await wc().executeJavaScript('window.ready');
    const allowed = await wc().executeJavaScript('window.results');
    assert.notEqual(allowed.control, undefined);
    assert.equal(tab.blocked, 0, 'nothing counted while allowed');
    b.updateSettings({ allowedSites: [] });
    wc().reload();
    await sleep(300);
    await waitFor(() => !tab.loading);
    await wc().executeJavaScript('window.ready');
    assert.equal((await wc().executeJavaScript('window.results')).doubleclick, 'error');
  });

  await check('no AI: built-in AI APIs are absent from web pages', async () => {
    const names = ['LanguageModel', 'Summarizer', 'Writer', 'Rewriter', 'Proofreader', 'Translator', 'LanguageDetector', 'ai'];
    const present = await wc().executeJavaScript(`${JSON.stringify(names)}.filter((n) => n in window)`);
    assert.deepEqual(present, []);
    return `checked ${names.join(', ')}`;
  });

  await check('no AI: the browser UI has no AI wording', async () => {
    for (const panel of ['customize', 'shield', 'library', 'downloads']) {
      await shellEval(`openPanel = '${panel}'; renderPanel();`);
      // The search engine list is left out because "DuckDuckGo (no AI)" names the absence of it.
      const text = await shellEval(`(() => {
        const copy = document.body.cloneNode(true);
        copy.querySelectorAll('select, script, style').forEach((el) => el.remove());
        return copy.textContent;
      })()`);
      assert.doesNotMatch(text, /\b(AI|gemini|copilot|assistant|summari[sz]e)\b/i);
    }
    await shellEval('openPanel = null; renderPanel();');
  });

  await check('user agent does not reveal Electron', async () => {
    const ua = await wc().executeJavaScript('navigator.userAgent');
    assert.doesNotMatch(ua, /Electron|Tern/);
    return ua;
  });

  await check('customization: tabs move to the left and the page view follows', async () => {
    b.updateSettings({ tabPosition: 'left' });
    await sleep(500);
    const rect = await shellEval('(() => { const r = document.getElementById("content").getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()');
    assert.equal(rect.x, 44, 'narrow until hovered');
    assert.deepEqual({ x: tab.view.getBounds().x, y: tab.view.getBounds().y }, rect);
  });
  await shot(shell, '03-shell-left-tabs');

  await check('customization: theme, accent, compact and toolbar order apply', async () => {
    const items = [...b.getSettings().toolbarItems].reverse();
    b.updateSettings({ theme: 'paper', accent: '#00aa66', compact: true, toolbarItems: items, tabPosition: 'right', toolbarPosition: 'bottom' });
    await sleep(500);
    const info = await shellEval(`({
      theme: document.body.dataset.theme,
      accent: getComputedStyle(document.body).getPropertyValue('--accent').trim(),
      markFill: getComputedStyle(document.querySelector('.mark')).fill,
      compact: document.body.classList.contains('compact'),
      first: document.querySelector('#toolbar > *').id,
    })`);
    assert.equal(info.theme, 'paper');
    assert.equal(info.accent, '#00aa66');
    assert.equal(info.markFill, 'rgb(0, 170, 102)', 'accent reaches elements');
    assert.equal(info.compact, true);
    assert.equal(info.first, 'menu-btn');
  });
  await shot(shell, '04-shell-paper-right');

  await check('customization: panel shrinks the page instead of covering it', async () => {
    b.updateSettings({ theme: 'midnight', accent: '', compact: false, tabPosition: 'top', toolbarPosition: 'top', toolbarItems: clean({}).toolbarItems });
    await sleep(300);
    const before = tab.view.getBounds().width;
    await shellEval("togglePanel('customize')");
    await sleep(400);
    assert.equal(tab.view.getBounds().width, before - 310);
    await shot(shell, '05-customize-panel');
    await shellEval("togglePanel('customize')");
  });

  await check('side tabs: expand over the page on hover without moving it, and shrink again', async () => {
    b.updateSettings({ tabPosition: 'left', toolbarPosition: 'top', theme: 'midnight', accent: '', compact: false });
    await sleep(500);
    const page = tab.view.getBounds();
    const stripWidth = () => inShell(() => Math.round(document.getElementById('tabs').getBoundingClientRect().width));
    const onTop = () => win.contentView.children.at(-1);
    assert.equal(await stripWidth(), 44);
    assert.equal(await inShell(() => getComputedStyle(document.querySelector('.tab-title')).display), 'none');
    assert.equal(onTop(), tab.view, 'page is on top while narrow');
    wc().focus();
    await waitFor(() => wc().isFocused(), 2000);
    await inShell(() => document.getElementById('tabs').dispatchEvent(new MouseEvent('mouseenter')));
    await waitFor(async () => (await stripWidth()) === 220, 2000);
    assert.equal(onTop().webContents, shell, 'tabs are above the page');
    assert.equal(wc().isFocused(), true, 'hovering keeps keyboard focus in the page');
    assert.deepEqual(tab.view.getBounds(), page, 'the page did not move');
    assert.notEqual(await inShell(() => getComputedStyle(document.querySelector('.tab-title')).display), 'none');

    const other = tabs.create(`${base}/hover-switch`);
    await waitFor(() => other.view && !other.loading);
    assert.equal(onTop().webContents, shell, 'still above after switching tabs');
    tabs.close(other.id);
    await shellEval(`window.tern.activate(${tab.id})`);
    await waitFor(() => wc().isFocused(), 2000);

    await inShell(() => document.getElementById('tabs').dispatchEvent(new MouseEvent('mouseleave')));
    await waitFor(async () => (await stripWidth()) === 44, 2000);
    await waitFor(() => onTop() === tab.view, 2000);
    assert.equal(wc().isFocused(), true, 'and after shrinking');

    b.updateSettings({ sideCollapse: false });
    await sleep(400);
    assert.equal(await stripWidth(), 220, 'can stay open all the time');
    b.updateSettings({ sideCollapse: true, tabPosition: 'right' });
    await sleep(400);
    assert.equal(await stripWidth(), 44);
    assert.deepEqual({ x: tab.view.getBounds().x }, { x: 0 });
    b.updateSettings({ tabPosition: 'top' });
    await sleep(400);
  });

  await check('tabs: pin keeps a tab first, and duplicate, close others and close right work', async () => {
    const a = tabs.create(`${base}/a`, { activate: false });
    const c = tabs.create(`${base}/c`, { activate: false });
    tabs.togglePinned(c.id);
    assert.equal(tabs.tabs[0], c, 'pinned goes first');
    tabs.move(a.id, 0);
    assert.equal(tabs.tabs[0], c, 'nothing moves ahead of a pinned tab');
    assert.equal(tabs.serialize().tabs.find((t) => t.url.endsWith('/c')).pinned, true, 'pin is remembered');
    tabs.duplicate(tab.id);
    const copy = tabs.active;
    assert.equal(copy.url, tab.url);
    assert.equal(tabs.tabs.indexOf(copy), tabs.tabs.indexOf(tab) + 1);
    tabs.closeToRight(tab.id);
    assert.ok(!tabs.tabs.includes(copy));
    tabs.closeOthers(tab.id);
    assert.deepEqual(tabs.tabs.map((t) => t.id).sort(), [c.id, tab.id].sort(), 'pinned tab survives close others');
    tabs.togglePinned(c.id);
    tabs.close(c.id);
    tabs.activate(tab.id);
  });

  await check('tabs: mute silences the page, and the sound button shows', async () => {
    tabs.toggleMuted(tab.id);
    assert.equal(wc().isAudioMuted(), true);
    await waitFor(() => inShell(() => !document.querySelector('.tab.active .tab-audio').hidden), 2000);
    assert.equal(await inShell(() => document.querySelector('.tab.active .tab-audio').dataset.mark), 'muted');
    tabs.toggleMuted(tab.id);
    assert.equal(wc().isAudioMuted(), false);
  });

  await check('menus: main, tab and right-click menus offer the basics', () => {
    const labels = (items) => items.map((i) => i.label ?? i.role).filter(Boolean);
    const main = labels(b.mainMenuItems());
    for (const want of ['New tab', 'New Tor tab', 'Bookmarks', 'History', 'Downloads', 'Zoom in', 'Zoom out', 'Find in page', 'Print…', 'Save page as…', 'Customize', 'About Tern', 'Exit']) {
      assert.ok(main.includes(want), want);
    }
    assert.ok(main.includes('Reset zoom (100%)'));
    const onTab = labels(tabs.tabMenuItems(tab));
    for (const want of ['Reload', 'Duplicate', 'Pin', 'Mute site', 'Close', 'Close other tabs', 'Close tabs to the right', 'Reopen closed tab']) {
      assert.ok(onTab.includes(want), want);
    }
    const onPage = labels(tabs.contextItems(tab, wc(), { linkURL: 'https://a.example/', mediaType: 'image', srcURL: 'https://a.example/i.png', selectionText: 'hello', isEditable: false, x: 1, y: 1 }));
    for (const want of ['Open link in new tab', 'Save link as…', 'Copy link address', 'Save image as…', 'Copy image', 'Search for "hello"', 'Save page as…', 'Print…', 'Back', 'Inspect']) {
      assert.ok(onPage.includes(want), want);
    }
    const inBox = labels(tabs.contextItems(tab, wc(), { linkURL: '', mediaType: 'none', srcURL: '', selectionText: '', isEditable: true, x: 1, y: 1 }));
    for (const want of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) assert.ok(inBox.includes(want), want);
  });

  await check('zoom: the main menu shows the current level', async () => {
    wc().setZoomFactor(1.5);
    assert.ok(b.mainMenuItems().some((i) => i.label === 'Reset zoom (150%)'));
    tabs.zoom(0);
    assert.equal(tabs.zoomPercent(), 100);
  });

  await check('address bar: shows when a site is not secure', async () => {
    await waitFor(() => inShell(() => document.getElementById('secure').className === 'not-secure' && !document.getElementById('secure').hidden), 3000);
  });

  await check('PDF: opens in the page instead of downloading', async () => {
    const before = b.downloads.list().length;
    await load(`${base}/doc.pdf`);
    await sleep(1500);
    assert.equal(b.downloads.list().length, before, 'not downloaded');
    assert.equal(tab.url, `${base}/doc.pdf`);
    assert.equal(tab.error, null);
    assert.ok(wc().mainFrame.framesInSubtree.some((f) => f.url.startsWith('chrome-extension://')), 'the PDF viewer loaded');
    await load(`${base}/ads`);
  });

  await check('tabs: open, switch, sleep frees the renderer, waking restores the page', async () => {
    const other = tabs.create(`${base}/other`, { activate: true });
    await waitFor(() => other.view && !other.loading);
    tabs.activate(tab.id);
    await sleep(200);
    assert.ok(other.view, 'still awake');
    other.lastActive = 0;
    tabs.sleepIdle();
    assert.equal(other.view, null, 'asleep');
    tabs.activate(other.id);
    await waitFor(() => other.view && !other.loading);
    assert.equal(other.url, `${base}/other`);
    tabs.close(other.id);
    assert.equal(tabs.active.id, tab.id);
  });

  await check('tabs: Ctrl+T works while a page has focus', async () => {
    const count = tabs.tabs.length;
    wc().focus();
    const key = (keyCode, modifiers) => {
      tabs.active.view?.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
      tabs.active.view?.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
    };
    await sleep(100);
    key('t', ['control']);
    await waitFor(() => tabs.tabs.length === count + 1, 3000);
    tabs.close(tabs.activeId);
    tabs.activate(tab.id);
  });

  await check('safety: pages cannot navigate to file: or other local schemes', async () => {
    const before = tab.url;
    await wc().executeJavaScript("location.href = 'file:///C:/Windows/win.ini'").catch(() => {});
    await sleep(600);
    assert.equal(tab.url, before);
    assert.ok(!wc().getURL().startsWith('file:'));
  });

  await check('safety: tab pages have no access to browser internals', async () => {
    const leaked = await wc().executeJavaScript("['tern', 'require', 'process', 'electron'].filter((n) => n in window)");
    assert.deepEqual(leaked, []);
  });

  await check('failed page shows a readable message and hides the page view', async () => {
    tabs.navigate(tab.id, 'http://127.0.0.1:9/');
    await waitFor(() => tab.error, 8000);
    await sleep(300);
    assert.equal(await shellEval("document.getElementById('message').hidden"), false);
    assert.ok(!win.contentView.children.includes(tab.view), 'view removed');
    await shot(shell, '06-error');
    tabs.navigate(tab.id, `${base}/ads`);
    await waitFor(() => !tab.error && !tab.loading);
  });

  await check('find in page: opens with Ctrl+F and counts matches', async () => {
    wc().focus();
    await sleep(100);
    wc().sendInputEvent({ type: 'keyDown', keyCode: 'f', modifiers: ['control'] });
    wc().sendInputEvent({ type: 'keyUp', keyCode: 'f', modifiers: ['control'] });
    await waitFor(() => shellEval("!document.getElementById('findbar').hidden"), 3000);
    await shellEval(`(() => {
      const input = document.getElementById('find-input');
      input.value = 'visible';
      input.dispatchEvent(new Event('input'));
    })()`);
    const count = await waitFor(() => shellEval("document.getElementById('find-count').textContent"), 3000);
    assert.match(count, /of [1-9]/);
    await shellEval("document.getElementById('find-close').click()");
    return count;
  });

  await check('video fullscreen: the page fills the window and comes back', async () => {
    await sleep(500); // Let the page view settle after the find bar closes.
    const normal = tab.view.getBounds();
    // Not awaited: the browser never answers this while the screen is locked or off.
    wc().executeJavaScript('document.documentElement.requestFullscreen()', true).catch(() => {});
    await waitFor(() => tabs.fullscreen, 4000);
    await sleep(700);
    assert.equal(tab.view.getBounds().y, 0);
    assert.ok(tab.view.getBounds().width >= win.getContentBounds().width - 1);
    wc().executeJavaScript('document.exitFullscreen()', true).catch(() => {});
    await waitFor(() => !tabs.fullscreen, 4000);
    await sleep(700);
    assert.deepEqual(tab.view.getBounds(), normal);
  });

  const directHits = [];
  server.on('request', (req) => directHits.push(req.url));
  const socks = await fakeSocks();
  const gatherIps = `new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.invalid:3478' }] });
    const found = [];
    pc.createDataChannel('x');
    pc.onicecandidate = (e) => { if (e.candidate && e.candidate.candidate) found.push(e.candidate.candidate); };
    pc.createOffer().then((o) => pc.setLocalDescription(o));
    setTimeout(() => { pc.close(); resolve(found); }, 2500);
  })`;

  await check('Tor tab: loads nothing at all until Tor is connected', async () => {
    const realStart = b.tor.start;
    b.tor.start = async () => {};
    b.openTorTab();
    const torTab = tabs.active;
    b.tor.start = realStart;
    assert.equal(torTab.tor, true);
    tabs.navigate(torTab.id, `${base}/before-tor-is-ready`);
    await sleep(800);
    assert.equal(torTab.view, null, 'no page exists yet');
    assert.ok(!directHits.includes('/before-tor-is-ready'), 'nothing reached the site');
    assert.equal(await inShell(() => document.getElementById('tor-status').hidden), false);
    await shot(shell, '15-tor-connecting');
    tabs.close(torTab.id);
    tabs.activate(tab.id);
  });

  let torTab = null;
  const torWc = () => torTab.view.webContents;
  await check('Tor tab: traffic goes through Tor, and host names are never looked up locally', async () => {
    const realStart = b.tor.start;
    b.tor.start = async () => {};
    b.openTorTab();
    b.tor.start = realStart;
    torTab = tabs.active;
    await b.useTorPort(socks.port);
    tabs.navigate(torTab.id, 'http://leak-check.invalid/page');
    await waitFor(() => torTab.view && !torTab.loading && torTab.title === 'through the proxy', 8000);
    assert.ok(socks.seen.some((s) => s.type === 3 && s.host === 'leak-check.invalid'));
    assert.equal(torTab.error, null);
    await shot(shell, '16-tor-tab');
  });

  await check('Tor tab: a page cannot reach this PC or the site directly by address', async () => {
    const address = `http://127.0.0.1:${server.address().port}/direct-hit`;
    await torWc().executeJavaScript(`fetch(${JSON.stringify(address)}, { mode: 'no-cors' }).catch(() => {}); new Image().src = ${JSON.stringify(`${base}/direct-image`)}; 0`);
    await sleep(800);
    assert.ok(!directHits.includes('/direct-hit'), 'local address went through the proxy instead');
    assert.ok(!directHits.includes('/direct-image'));
  });

  await check('Tor tab: WebRTC gives away no IP address', async () => {
    assert.deepEqual(await torWc().executeJavaScript(gatherIps), []);
  });

  await check('Tor tab: links stay in Tor, and nothing is saved or shared with normal tabs', async () => {
    const count = tabs.tabs.length;
    await torWc().executeJavaScript("document.getElementById('popup').click()", true);
    await waitFor(() => tabs.tabs.length === count + 1, 3000);
    assert.equal(tabs.tabs.at(-1).tor, true, 'new tab is a Tor tab too');
    tabs.close(tabs.tabs.at(-1).id);
    tabs.activate(torTab.id);
    await sleep(200);
    assert.ok(!b.library.history.has('http://leak-check.invalid/page'), 'not in history');
    assert.ok(!tabs.serialize().tabs.some((t) => t.url.includes('leak-check')), 'not reopened next launch');
    assert.ok((await b.torSession.cookies.get({})).length >= 1, 'cookie is in the Tor session');
    assert.equal((await b.tabSession.cookies.get({ domain: 'leak-check.invalid' })).length, 0);
    torTab.favicon = 'http://icon.invalid/i.png';
    assert.equal(tabs.publicState().tabs.find((t) => t.id === torTab.id).favicon, '', 'the interface never fetches its icon');
  });

  await check('Tor tab: if Tor goes down, pages fail instead of connecting directly', async () => {
    const unused = net.createServer();
    await new Promise((r) => unused.listen(0, '127.0.0.1', r));
    const deadPort = unused.address().port;
    await new Promise((r) => unused.close(r));
    await b.useTorPort(deadPort);
    tabs.navigate(torTab.id, `${base}/tor-is-down`);
    await waitFor(() => torTab.error, 8000);
    assert.ok(!directHits.includes('/tor-is-down'), 'nothing reached the site');
    await b.useTorPort(socks.port);
  });

  await check('Tor tab: closing the last one wipes its cookies and stops Tor', async () => {
    const stopped = [];
    const realStop = b.tor.stop;
    b.tor.stop = function stop() { stopped.push(1); return realStop.call(this); };
    tabs.close(torTab.id);
    b.tor.stop = realStop;
    tabs.activate(tab.id);
    assert.equal(stopped.length, 1);
    await waitFor(async () => (await b.torSession.cookies.get({})).length === 0, 4000);
    assert.equal(tabs.torReady, false);
  });

  await check('proxy: normal tabs go through it, with a password that never reaches the interface', async () => {
    const secret = 'correct-horse-battery';
    const proxy = await fakeWebProxy(`me:${secret}`);
    const result = await shellEval(`window.tern.setProxy({ enabled: true, server: 'http://127.0.0.1:${proxy.port}', username: 'me', password: '${secret}' })`);
    assert.deepEqual(result, { ok: true });
    await load('http://proxied-site.invalid/');
    await waitFor(() => tab.title === 'through web proxy', 8000);
    assert.ok(proxy.seen.some((u) => u.includes('proxied-site.invalid')));
    assert.ok(!directHits.includes('/'), 'site not contacted directly');
    assert.deepEqual(await wc().executeJavaScript(gatherIps), [], 'WebRTC stays quiet');
    const visible = JSON.stringify(await shellEval('state.settings'));
    assert.ok(!visible.includes(secret) && !visible.includes('proxyPassword":'), 'not sent to the interface');
    assert.ok(visible.includes('"proxyHasPassword":true'));
    b.flushAll();
    assert.ok(!fs.readFileSync(path.join(profile, 'settings.json'), 'utf8').includes(secret), 'stored encrypted');
    await new Promise((r) => { proxy.server.closeAllConnections(); proxy.server.close(r); });
  });

  await check('proxy: if it goes down, pages fail instead of connecting directly', async () => {
    tabs.navigate(tab.id, `${base}/proxy-is-down`);
    await waitFor(() => tab.error, 8000);
    assert.ok(!directHits.includes('/proxy-is-down'));
    const bad = await shellEval(`window.tern.setProxy({ enabled: true, server: 'not a server' })`);
    assert.equal(bad.ok, false);
    assert.equal(b.getSettings().proxyEnabled, true, 'a bad entry leaves protection on');
    const socksAuth = await shellEval(`window.tern.setProxy({ enabled: true, server: 'socks5://127.0.0.1:1080', username: 'x' })`);
    assert.equal(socksAuth.ok, false);
  });

  await check('proxy: turning it off goes back to normal and clears the password', async () => {
    assert.deepEqual(await shellEval(`window.tern.setProxy({ enabled: false, server: '', username: '' })`), { ok: true });
    await load(`${base}/ads?proxy-off=1`);
    assert.ok(directHits.includes('/ads?proxy-off=1'));
    assert.equal(b.getSettings().proxyPassword, '');
  });
  socks.server.close();

  await check('filter page scripts run once per page, however many frames ask, and again after a reload', async () => {
    const { engine } = b.adblock;
    const real = engine.getCosmeticsFilters;
    engine.getCosmeticsFilters = () => ({ active: true, styles: '', scripts: ['window.ranTimes = (window.ranTimes || 0) + 1;'] });
    try {
      await load(`${base}/ads?frames=1`);
      const event = { sender: wc(), frameId: 1, processId: 1 };
      await engine.onInjectCosmeticFilters(event, `${base}/ads?frames=1`);
      await engine.onInjectCosmeticFilters(event, `${base}/ads?frames=1`);
      await sleep(200);
      assert.equal(await wc().executeJavaScript('window.ranTimes'), 1);
      wc().reload();
      await sleep(300);
      await waitFor(() => !tab.loading);
      await engine.onInjectCosmeticFilters(event, `${base}/ads?frames=1`);
      await sleep(200);
      assert.equal(await wc().executeJavaScript('window.ranTimes'), 1, 'a new page starts fresh');
    } finally {
      engine.getCosmeticsFilters = real;
    }
  });

  await check('YouTube: ad data is removed before the page reads it, and the video data is kept', async () => {
    // youtube.com is HTTPS-only in every browser, so the test answers for it inside the session.
    const yt = 'https://www.youtube.com';
    b.tabSession.protocol.handle('https', (request) => {
      if (new URL(request.url).pathname === '/player.json') {
        return new Response('{"adPlacements":[1],"videoDetails":"kept"}', { headers: { 'content-type': 'application/json' } });
      }
      // Shaped like a YouTube page, with ad data in each place the real one puts it.
      return new Response(`<!doctype html><title>watch</title><script>
        var ytInitialPlayerResponse = { adPlacements: [1], playerAds: [1], videoDetails: { title: 'kept' } };
        window.parsed = JSON.parse('{"adSlots":[1],"playerResponse":{"adPlacements":[1],"streamingData":"kept"}}');
        window.fetched = fetch('/player.json').then((r) => r.json());
      </script>`, { headers: { 'content-type': 'text/html' } });
    });
    const read = `(async () => ({
      initial: Object.keys(ytInitialPlayerResponse),
      parsed: window.parsed,
      fetched: await window.fetched,
    }))()`;
    const untouched = "Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse').get === undefined";
    await load(`${yt}/watch?v=1`);
    const on = await wc().executeJavaScript(read);
    assert.deepEqual(on.initial, ['videoDetails']);
    assert.deepEqual(on.parsed, { playerResponse: { streamingData: 'kept' } });
    assert.deepEqual(on.fetched, { videoDetails: 'kept' });
    // Overflowed while the filter engine's page scripts also ran here, which stopped the player appearing.
    assert.ok(await wc().executeJavaScript('JSON.parse.toString().length > 0'));

    b.updateSettings({ allowedSites: ['www.youtube.com'] });
    await load(`${yt}/watch?v=2`);
    const allowed = await wc().executeJavaScript(read);
    assert.ok(allowed.initial.includes('adPlacements'), 'the per-site switch turns it off');
    assert.equal(await wc().executeJavaScript(untouched), true);
    b.updateSettings({ allowedSites: [] });
    b.tabSession.protocol.unhandle('https');

    await load(`${base}/not-youtube`);
    assert.equal(await wc().executeJavaScript("JSON.parse.toString().includes('native code')"), true, 'other sites are left alone');
  });

  await check('history: pages you visit are recorded with their titles', async () => {
    await load(`${base}/history-page`);
    await waitFor(() => b.library.history.get(`${base}/history-page`)?.title === 'Tern test page', 4000);
    assert.equal(b.library.history.get(`${base}/history-page`).visits, 1);
  });

  await check('history: failed pages are not recorded, and reloading is not a second visit', async () => {
    assert.ok(![...b.library.history.keys()].some((u) => u.includes('127.0.0.1:9')));
    await load(`${base}/history-page`);
    assert.equal(b.library.history.get(`${base}/history-page`).visits, 1);
  });

  await check('history panel: shows visits, filters, removes one entry, needs two clicks to clear', async () => {
    await load(`${base}/second-page`);
    await sleep(100);
    await shellEval("showPanel('library', 'history')");
    await waitFor(() => inShell(() => document.querySelectorAll('#history-list .entry').length >= 2), 3000);
    assert.equal(await inShell(() => document.querySelector('#history-list .day').textContent), 'Today');
    await shot(shell, '09-history-panel');
    await inShell(() => {
      const input = document.getElementById('library-search');
      input.value = 'second-page';
      input.dispatchEvent(new Event('input'));
    });
    await waitFor(() => inShell(() => document.querySelectorAll('#history-list .entry').length === 1), 3000);
    await inShell(() => document.querySelector('#history-list .entry .icon').click());
    await waitFor(() => !b.library.history.has(`${base}/second-page`), 3000);
    await inShell(() => {
      const input = document.getElementById('library-search');
      input.value = '';
      input.dispatchEvent(new Event('input'));
    });
    await waitFor(() => inShell(() => !document.getElementById('history-clear').hidden), 3000);
    const before = b.library.history.size;
    assert.ok(before > 0);
    await inShell(() => document.getElementById('history-clear').click());
    await sleep(200);
    assert.equal(b.library.history.size, before, 'first click only asks');
    await inShell(() => document.getElementById('history-clear').click());
    await waitFor(() => b.library.history.size === 0, 3000);
    await shellEval('togglePanel(openPanel)');
  });

  await check('history: can be turned off', async () => {
    b.updateSettings({ saveHistory: false });
    await load(`${base}/private-page`);
    await sleep(200);
    assert.ok(!b.library.history.has(`${base}/private-page`));
    b.updateSettings({ saveHistory: true });
  });

  await check('bookmarks: star adds with a stored icon, shows in the bar, star removes', async () => {
    await load(`${base}/ads?bookmarked=1`);
    await waitFor(() => tabs.active.favicon, 4000);
    const beforeBounds = tab.view.getBounds();
    await inShell(() => document.getElementById('star-btn').click());
    await waitFor(() => b.library.bookmarks.length === 1, 3000);
    await waitFor(() => b.library.bookmarks[0].icon.startsWith('data:image/'), 4000);
    assert.equal(b.library.bookmarks[0].title, 'Tern test page');
    await waitFor(() => inShell(() => document.getElementById('star-btn').classList.contains('on')), 3000);
    await waitFor(() => inShell(() => !document.getElementById('bookmarks-bar').hidden), 3000);
    await sleep(300);
    assert.ok(tab.view.getBounds().y > beforeBounds.y, 'page moved down for the bar');
    await shot(shell, '10-bookmarks-bar');
    await inShell(() => document.getElementById('star-btn').click());
    await waitFor(() => b.library.bookmarks.length === 0, 3000);
    await sleep(300);
    assert.deepEqual(tab.view.getBounds(), beforeBounds, 'bar gone, page back');
  });

  await check('bookmarks: Ctrl+D from a page, open from the bar, rename, reorder, survive a restart', async () => {
    wc().focus();
    await sleep(100);
    wc().sendInputEvent({ type: 'keyDown', keyCode: 'd', modifiers: ['control'] });
    wc().sendInputEvent({ type: 'keyUp', keyCode: 'd', modifiers: ['control'] });
    await waitFor(() => b.library.bookmarks.length === 1, 3000);
    const first = b.library.bookmarks[0];
    await load(`${base}/other-page`);
    await inShell(() => document.getElementById('star-btn').click());
    await waitFor(() => b.library.bookmarks.length === 2, 3000);
    await sleep(200);
    await inShell(() => document.querySelector('#bookmarks-bar .bookmark-chip').click());
    await waitFor(() => tab.url === first.url && !tab.loading, 4000);
    await shellEval("showPanel('library', 'bookmarks')");
    await waitFor(() => inShell(() => document.querySelectorAll('#bookmark-list .entry').length === 2), 3000);
    await shot(shell, '11-bookmarks-panel');
    b.library.renameBookmark(first.id, 'Renamed <b>bookmark</b>');
    await waitFor(() => inShell(() => document.querySelector('#bookmarks-bar .bookmark-chip > span:last-child').textContent === 'Renamed <b>bookmark</b>'), 3000);
    assert.equal(await inShell(() => document.querySelector('#bookmarks-bar b')), null, 'names are text, never markup');
    b.library.moveBookmark(first.id, 1);
    assert.equal(b.library.bookmarks[1].id, first.id);
    b.flushAll();
    const reopened = new Library(profile);
    assert.deepEqual(reopened.bookmarks.map((x) => x.url), b.library.bookmarks.map((x) => x.url));
    assert.equal(reopened.bookmarks[1].title, 'Renamed <b>bookmark</b>');
    await shellEval('togglePanel(openPanel)');
  });

  await check('library files: damaged data is ignored and unsafe addresses are dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-lib-'));
    fs.writeFileSync(path.join(dir, 'bookmarks.json'), JSON.stringify([
      { url: 'javascript:alert(1)', title: 'bad' },
      { url: 'file:///C:/x', title: 'bad' },
      { url: 'https://good.example/', title: 'good', icon: 'https://not-inline.example/x.png' },
      { url: 'https://good.example/', title: 'duplicate' },
    ]));
    fs.writeFileSync(path.join(dir, 'history.json'), '{ not json');
    const lib = new Library(dir);
    assert.deepEqual(lib.bookmarks.map((x) => x.url), ['https://good.example/']);
    assert.equal(lib.bookmarks[0].icon, '');
    assert.equal(lib.history.size, 0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('suggestions: ranks matches, and bookmarks are included', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-lib-'));
    const lib = new Library(dir);
    lib.recordVisit('https://news.example.org/a', 'Some story');
    lib.recordVisit('https://example.org/news', 'Other');
    lib.toggleBookmark({ url: 'https://docs.example.org/news-guide', title: 'Guide' });
    assert.equal(lib.suggest('news.ex')[0].url, 'https://news.example.org/a', 'address starting with the text wins');
    assert.equal(lib.suggest('news')[0].url, 'https://news.example.org/a');
    assert.equal(lib.suggest('guide')[0].kind, 'bookmark');
    assert.deepEqual(lib.suggest('zzzz'), []);
    assert.deepEqual(lib.suggest('   '), []);
    lib.flush();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('suggestions: list appears above the page, keys select, Enter opens it, Esc hides it', async () => {
    await load(`${base}/ads?suggest-target=1`);
    await waitFor(() => b.library.history.has(`${base}/ads?suggest-target=1`), 3000);
    await load(`${base}/other-page`);
    const typeInto = (text) => shellEval(`(() => {
      const input = document.getElementById('address-input');
      input.focus();
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input'));
    })()`);
    await typeInto('suggest-target');
    await waitFor(() => inShell(() => suggestions.length >= 2), 3000);
    assert.equal(b.suggestionsVisible(), true);
    const overlay = win.contentView.children.at(-1).webContents;
    await sleep(500);
    assert.ok(overlay.getURL().endsWith('suggest.html'), 'on top of the page');
    assert.equal(await overlay.executeJavaScript("document.querySelector('.row .title').textContent"), 'suggest-target');
    assert.equal(await overlay.executeJavaScript("document.querySelectorAll('.row').length"), 2);
    await shot(overlay, '12-suggestions');

    await inShell(() => document.getElementById('address-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
    await waitFor(() => inShell(() => document.getElementById('address-input').value.includes('suggest-target=1')), 2000);
    await sleep(200);
    assert.equal(await overlay.executeJavaScript("[...document.querySelectorAll('.row')].findIndex((r) => r.classList.contains('on'))"), 1);
    await inShell(() => document.getElementById('address-input').form.requestSubmit());
    await waitFor(() => tab.url.includes('suggest-target=1') && !tab.loading, 4000);
    assert.equal(b.suggestionsVisible(), false, 'gone after opening');
    await waitFor(() => inShell(() => document.getElementById('address-input').value.includes('/ads?suggest-target=1')), 2000);

    await typeInto('suggest-target');
    await waitFor(() => b.suggestionsVisible(), 3000);
    await inShell(() => document.getElementById('address-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await waitFor(() => !b.suggestionsVisible(), 2000);

    await load(`${base}/other-page`);
    await typeInto('suggest-target');
    await waitFor(() => inShell(() => suggestions.length >= 2), 3000);
    await sleep(300);
    await overlay.executeJavaScript("document.querySelectorAll('.row')[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))");
    await waitFor(() => tab.url.includes('suggest-target=1') && !b.suggestionsVisible(), 4000);
    await waitFor(() => inShell(() => document.getElementById('address-input').value.includes('/ads?suggest-target=1')), 2000);
  });

  await check('suggestions: pages cannot reach the suggestions channel', async () => {
    const leaked = await wc().executeJavaScript("['ternSuggest', 'tern'].filter((n) => n in window)");
    assert.deepEqual(leaked, []);
  });

  const lastDownload = () => b.downloads.list()[0];
  await check('clear browsing data: needs two clicks, removes history and cookies, keeps bookmarks', async () => {
    await load(`${base}/ads?clear=1`);
    await wc().executeJavaScript("document.cookie = 'a=1; max-age=999'; 0");
    await waitFor(() => b.library.history.size > 0, 2000);
    const marks = b.library.bookmarks.length;
    await shellEval("showPanel('customize')");
    await inShell(() => document.getElementById('clear-data').click());
    await sleep(300);
    assert.ok(b.library.history.size > 0, 'first click only asks');
    await inShell(() => document.getElementById('clear-data').click());
    await waitFor(() => b.library.history.size === 0, 3000);
    await waitFor(async () => (await b.tabSession.cookies.get({})).length === 0, 3000);
    assert.equal(b.library.bookmarks.length, marks);
    await shellEval('togglePanel(openPanel)');
  });

  await check('save page: Ctrl+S saves the page to Downloads', async () => {
    await load(`${base}/ads?saved=1`);
    wc().focus();
    await sleep(100);
    const count = b.downloads.list().length;
    wc().sendInputEvent({ type: 'keyDown', keyCode: 's', modifiers: ['control'] });
    wc().sendInputEvent({ type: 'keyUp', keyCode: 's', modifiers: ['control'] });
    await waitFor(() => b.downloads.list().length === count + 1 && b.downloads.list()[0].state === 'completed', 5000);
    assert.ok(fs.existsSync(b.downloads.list()[0].path));
    fs.rmSync(b.downloads.list()[0].path);
    assert.equal(tab.url, `${base}/ads?saved=1`, 'the tab stays on its page');
    await b.downloads.clearFinished();
  });

  await check('downloads: saves to the Downloads folder, marked as coming from the internet', async () => {
    await load(`${base}/ads`);
    const count = b.downloads.list().length;
    await wc().executeJavaScript("document.getElementById('file-link').click()", true);
    await waitFor(() => b.downloads.list().length === count + 1 && lastDownload().state === 'completed', 6000);
    const d = lastDownload();
    assert.equal(path.dirname(d.path), downloadDir);
    assert.equal(fs.readFileSync(d.path, 'utf8'), 'hello from the test server');
    assert.equal(tab.url, `${base}/ads`, 'the tab stays on its page');
    assert.ok(tab.blocked >= 3, 'the blocked count survives the click');
    const zone = fs.readFileSync(`${d.path}:Zone.Identifier`, 'utf8');
    assert.match(zone, /ZoneId=3/);
    assert.ok(zone.includes(`${base}/report.txt`));
    return path.basename(d.path);
  });

  await check('downloads: a second copy gets a new name instead of overwriting', async () => {
    await wc().executeJavaScript("document.getElementById('file-link').click()", true);
    await waitFor(() => lastDownload().filename === 'report (1).txt' && lastDownload().state === 'completed', 6000);
    assert.equal(fs.readdirSync(downloadDir).length, 2);
  });

  await check('downloads: a link in a new tab saves the file and closes the empty tab', async () => {
    const tabCount = tabs.tabs.length;
    await wc().executeJavaScript("document.getElementById('popup-file').click()", true);
    await waitFor(() => lastDownload().filename === 'popup.txt' && lastDownload().state === 'completed', 6000);
    await waitFor(() => tabs.tabs.length === tabCount, 3000);
    assert.equal(fs.readFileSync(lastDownload().path, 'utf8'), 'hello from the test server');
    tabs.activate(tab.id);
  });

  await check('downloads: typing a file address saves it and the tab recovers', async () => {
    const fresh = tabs.create();
    tabs.navigate(fresh.id, `${base}/report.txt?typed=1`);
    await waitFor(() => lastDownload().filename === 'report (2).txt' && lastDownload().state === 'completed', 6000);
    await waitFor(() => fresh.url === '', 3000);
    assert.equal(fs.readFileSync(lastDownload().path, 'utf8'), 'hello from the test server');
    tabs.close(fresh.id);
    tabs.activate(tab.id);
  });

  await check('downloads panel: pause and resume work through the buttons', async () => {
    await shellEval("showPanel('downloads')");
    wc().downloadURL(`${base}/slow.bin`);
    await waitFor(() => lastDownload().filename === 'slow.bin' && lastDownload().received > 0, 6000);
    await waitFor(() => inShell(() => document.querySelector('#download-list [data-action="pause"]') !== null), 3000);
    assert.equal(await inShell(() => document.querySelector('#downloads-btn .badge').textContent), '1');
    await shot(shell, '13-downloads-panel');
    await inShell(() => document.querySelector('#download-list [data-action="pause"]').click());
    await waitFor(() => lastDownload().paused, 3000);
    await waitFor(() => inShell(() => document.querySelector('#download-list [data-action="resume"]') !== null), 3000);
    await inShell(() => document.querySelector('#download-list [data-action="resume"]').click());
    await waitFor(() => lastDownload().state === 'completed', 15000);
    assert.equal(fs.statSync(lastDownload().path).size, 40 * 64 * 1024);
    await waitFor(() => inShell(() => document.querySelector('#download-list [data-action="open"]') !== null), 3000);
  });

  await check('downloads panel: cancel stops it and leaves no partial file behind', async () => {
    wc().downloadURL(`${base}/slow.bin?again=1`);
    await waitFor(() => lastDownload().filename === 'slow (1).bin' && lastDownload().received > 0, 6000);
    const file = lastDownload().path;
    await waitFor(() => inShell(() => document.querySelector('#download-list [data-action="cancel"]') !== null), 3000);
    await inShell(() => document.querySelector('#download-list [data-action="cancel"]').click());
    await waitFor(() => lastDownload().state === 'cancelled', 4000);
    await sleep(300);
    assert.equal(fs.existsSync(file), false);
    assert.equal(b.downloads.activeCount, 0);
  });

  await check('downloads: Open warns first for programs, and a moved file is noticed', async () => {
    assert.equal(isRisky('setup.EXE'), true);
    assert.equal(isRisky('run.ps1'), true);
    assert.equal(isRisky('photo.jpg'), false);
    const opened = [];
    const asked = [];
    const realOpen = b.downloads.openPath;
    const realConfirm = b.downloads.confirmOpen;
    b.downloads.openPath = async (file) => opened.push(file);
    b.downloads.confirmOpen = async (entry) => {
      asked.push(entry.filename);
      return false;
    };
    const plain = b.downloads.list().find((d) => d.filename === 'report.txt');
    await b.downloads.action(plain.id, 'open');
    assert.deepEqual(opened, [plain.path], 'a text file opens without a warning');
    assert.deepEqual(asked, []);
    const copy = `${plain.path}.exe`;
    fs.copyFileSync(plain.path, copy);
    const realPath = plain.path;
    plain.path = copy;
    await b.downloads.action(plain.id, 'open');
    assert.deepEqual(asked, ['report.txt'], 'a program asks first');
    assert.equal(opened.length, 1, 'declining means it does not open');
    plain.path = realPath;
    fs.rmSync(realPath);
    await b.downloads.action(plain.id, 'open');
    assert.equal(plain.missing, true);
    assert.equal(opened.length, 1);
    b.downloads.openPath = realOpen;
    b.downloads.confirmOpen = realConfirm;
    await waitFor(() => inShell(() => document.getElementById('download-list').textContent.includes('File moved or deleted')), 3000);
  });

  await check('downloads: the list survives a restart, and clearing keeps the files', async () => {
    b.flushAll();
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'downloads.json'), 'utf8'));
    assert.ok(saved.some((d) => d.filename === 'slow.bin' && d.state === 'completed'));
    const keep = b.downloads.list().find((d) => d.filename === 'slow.bin').path;
    await inShell(() => document.getElementById('downloads-clear').click());
    await waitFor(() => b.downloads.list().length === 0, 3000);
    assert.equal(fs.existsSync(keep), true);
    await waitFor(() => inShell(() => !document.getElementById('downloads-empty').hidden), 3000);
    await shellEval('togglePanel(openPanel)');
  });

  await check('open tabs are saved for the next launch', async () => {
    b.flushAll();
    tabs.create(`${base}/second`, { activate: false });
    await sleep(100);
    fs.mkdirSync(profile, { recursive: true });
    const saved = tabs.serialize();
    assert.equal(saved.tabs.length, tabs.tabs.filter((t) => t.url).length);
    assert.ok(saved.tabs.some((t) => t.url.endsWith('/second')));
    tabs.close(tabs.tabs.at(-1).id);
  });

  const pageMemory = await measureMemory();

  let live = null;
  if (process.env.TERN_LIVE) {
    await check('live: a real ad-heavy news site', async () => {
      const site = tabs.create('https://www.speedtest.net/');
      await waitFor(() => site.view && !site.loading, 45000);
      await sleep(5000);
      live = site.blocked;
      await shot(site.view.webContents, '07-live-site');
      assert.ok(site.blocked > 0, 'nothing blocked');
      return `${site.blocked} requests blocked`;
    });
    await check('live: on YouTube, clicking a search result brings up a playing video', async () => {
      const yt = tabs.create(`https://www.youtube.com/results?search_query=${encodeURIComponent('cooking at home')}`);
      await waitFor(() => yt.view && !yt.loading, 30000);
      await sleep(4000);
      const page = yt.view.webContents;
      page.setAudioMuted(true);
      await page.executeJavaScript("[...document.querySelectorAll('a#video-title')].find((a) => /watch\\?v=/.test(a.href) && a.getBoundingClientRect().width > 0).click(); 0", true);
      await waitFor(() => page.executeJavaScript("(document.querySelector('#movie_player video')?.currentTime ?? 0) > 2"), 30000);
      assert.equal(await page.executeJavaScript("Boolean(document.querySelector('#movie_player.ad-showing'))"), false);
      tabs.close(yt.id);
    });

    await check('live: real Tor connects, and check.torproject.org confirms the IP is hidden', async () => {
      const direct = (await (await b.tabSession.fetch('https://api.ipify.org?format=json')).json()).ip;
      b.openTorTab();
      const real = tabs.active;
      await waitFor(() => tabs.torReady, 120000);
      tabs.navigate(real.id, 'https://check.torproject.org/api/ip');
      await waitFor(() => real.view && !real.loading && real.url.includes('check.torproject'), 60000);
      await sleep(500);
      const body = JSON.parse(await real.view.webContents.executeJavaScript('document.body.innerText'));
      assert.equal(body.IsTor, true);
      assert.notEqual(body.IP, direct);
      tabs.close(real.id);
      tabs.activate(tab.id);
      return 'Tor confirmed, address differs from the real one';
    });

    await check('live: built-in AI APIs absent on a secure https page', async () => {
      const present = await tabs.active.view.webContents.executeJavaScript(
        "['LanguageModel','Summarizer','Writer','Rewriter','Proofreader','Translator','LanguageDetector','ai'].filter((n) => n in window)",
      );
      assert.deepEqual(present, []);
    });
  }

  await check('no AI: no on-device model folders were created', () => {
    const found = [];
    const walk = (dir, depth = 0) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (/OptGuide|OnDeviceModel|optimization_guide|GenAI|Gemini/i.test(entry.name)) found.push(entry.name);
        if (entry.isDirectory() && depth < 4) walk(path.join(dir, entry.name), depth + 1);
      }
    };
    walk(profile);
    assert.deepEqual(found, []);
  });

  console.log(`\nStartup to ready window: ${startMs} ms`);
  console.log(`Memory with one empty new tab: ${idleMemory}`);
  console.log(`Memory with one simple page:   ${pageMemory}`);
  if (live !== null) console.log(`Blocked on live site: ${live}`);
  console.log(`Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`);

  win.close();
  server.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  setTimeout(() => {
    try {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows can keep profile files locked for a moment. It's only a temp folder.
    }
    app.exit(failed.length ? 1 : 0);
  }, 500);
}

app.on('window-all-closed', () => {});
main().catch((error) => {
  console.error(error);
  app.exit(1);
});
