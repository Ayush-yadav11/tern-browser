'use strict';

// Checks the built out/Tern-win32-x64/Tern.exe, which runs from an asar archive with
// fuses set, so a pass under `npm test` doesn't prove it. Run with: node test/packaged.js
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const EXE = path.join(__dirname, '..', 'out', 'Tern-win32-x64', 'Tern.exe');
const HOST = 'fixture.example.com';
const DEBUG_PORT = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let next = 1;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (pending.has(msg.id)) pending.get(msg.id)(msg);
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

(async () => {
  const page = fs.readFileSync(path.join(__dirname, 'fixtures', 'ads.html'));
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/ok.gif')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG);
    } else {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-pkg-'));
  const url = `http://${HOST}:${server.address().port}/ads`;
  const t0 = Date.now();
  const child = spawn(EXE, [
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    url,
  ], { stdio: 'ignore', env: { ...process.env, TERN_TEST: '1', TERN_NO_UPDATE: '1' } });

  let target = null;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(100);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find((t) => t.url.startsWith(url));
    } catch {
      // Not listening yet.
    }
  }
  if (!target) throw new Error('Tern.exe never opened the test page');
  console.log(`Launch to page open: ${Date.now() - t0} ms`);

  const tab = await cdp(target.webSocketDebuggerUrl);
  await sleep(1500);
  const report = await tab.evaluate(`(async () => {
    await window.ready;
    await new Promise((r) => setTimeout(r, 800));
    const hidden = (id) => getComputedStyle(document.getElementById(id)).display === 'none';
    return {
      results: window.results,
      adBoxesHidden: hidden('cosmetic-1') && hidden('cosmetic-2'),
      controlVisible: !hidden('control'),
      aiApis: ['LanguageModel','Summarizer','Writer','Rewriter','Proofreader','Translator','LanguageDetector','ai'].filter((n) => n in window),
      userAgent: navigator.userAgent,
    };
  })()`);
  console.log(JSON.stringify(report, null, 2));
  tab.close();

  // Goes through the real controls: click, then IPC, then back into the UI and the saved file.
  const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
  const ui = await cdp(list.find((t) => t.url.includes('index.html')).webSocketDebuggerUrl);
  const clicked = await ui.evaluate(`(async () => {
    const wait = () => new Promise((r) => setTimeout(r, 300));
    document.getElementById('customize-btn').click();
    await wait();
    document.querySelector('#themes [data-value="lagoon"]').click();
    await wait();
    document.querySelector('#seg-tabs [data-value="left"]').click();
    await wait();
    const input = document.getElementById('address-input');
    input.value = '${url}?typed=1';
    input.form.requestSubmit();
    await new Promise((r) => setTimeout(r, 1500));
    document.getElementById('star-btn').click();
    await wait();
    input.focus();
    input.value = 'typed=1';
    input.dispatchEvent(new Event('input'));
    await wait();
    await wait();
    return {
      suggested: suggestions.map((s) => s.value),
      bookmarked: document.getElementById('star-btn').classList.contains('on'),
      barShown: !document.getElementById('bookmarks-bar').hidden,
      theme: document.body.dataset.theme,
      tabs: document.body.dataset.tabs,
      address: document.getElementById('address-input').value,
      blockedBadge: document.querySelector('#shield-btn .badge').textContent,
      topButtonOn: document.querySelector('#seg-tabs .on').textContent,
    };
  })()`);
  console.log(JSON.stringify(clicked));
  ui.close();
  await sleep(800);
  const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
  const uiOk = clicked.theme === 'lagoon' && clicked.tabs === 'left' && clicked.address.includes('typed=1')
    && Number(clicked.blockedBadge) >= 3 && clicked.bookmarked && clicked.barShown
    && clicked.suggested.some((v) => v.includes('typed=1')) && saved.theme === 'lagoon' && saved.tabPosition === 'left';
  console.log(`UI clicks reach the browser and settings are saved: ${uiOk}`);

  const torExe = path.join(path.dirname(EXE), 'resources', 'tor', 'tor', 'tor.exe');
  const torOk = fs.existsSync(torExe) && spawnSync(torExe, ['--version'], { encoding: 'utf8' }).stdout.startsWith('Tor version');
  console.log(`Tor is included and runs: ${torOk}`);

  const pass = torOk && uiOk && report.results.doubleclick === 'error' && report.results.analytics === 'error'
    && report.results.control === 'loaded' && report.adBoxesHidden && report.controlVisible && report.aiApis.length === 0;
  console.log(pass ? 'PACKAGED BUILD PASS' : 'PACKAGED BUILD FAIL');

  // TERN_HOLD keeps the window open so it can be looked at or captured.
  if (process.env.TERN_HOLD) await sleep(Number(process.env.TERN_HOLD));

  child.kill();
  server.close();
  await sleep(800);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Temp folder, safe to leave.
  }
  process.exit(pass ? 0 : 1);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
