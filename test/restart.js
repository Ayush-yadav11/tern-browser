'use strict';

// Really quits and restarts a built copy, because that's the only way to prove windows come back.
// Run with: node test/restart.js [path to exe]
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const EXE = process.argv[2] ?? path.join(__dirname, '..', 'out', 'Tern-win32-x64', 'Tern.exe');
const PORT = 9361;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

function connect(url) {
  const ws = new WebSocket(url);
  let next = 1;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    pending.get(msg.id)?.(msg);
  };
  return new Promise((resolve) => {
    ws.onopen = () => resolve({
      close: () => ws.close(),
      run: (expression) => new Promise((done) => {
        const id = next++;
        pending.set(id, (m) => done(m.result?.result?.value));
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      }),
    });
  });
}

const targets = async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    return [];
  }
};
const shells = async () => (await targets()).filter((t) => t.url.includes('index.html'));

async function launch(profile, count) {
  const child = spawn(EXE, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    env: { ...process.env, TERN_TEST: '1', TERN_NO_UPDATE: '1' },
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const list = await waitFor(async () => {
    const found = await shells();
    return found.length === count && found;
  }, 20000, `${count} windows`);
  const windows = await Promise.all(list.map((t) => connect(t.webSocketDebuggerUrl)));
  for (const w of windows) await waitFor(() => w.run('state?.tabs.length > 0'), 10000, 'tabs to show');
  return { child, exited, windows };
}

async function quit(run, how) {
  // No reply will come, because the window closes while answering.
  run.windows[0].run(how);
  const code = await Promise.race([run.exited, sleep(15000).then(() => 'still running')]);
  for (const w of run.windows) w.close();
  assert.notEqual(code, 'still running', 'Exit closes the browser');
  await sleep(800);
}

const urlsIn = (w) => w.run('state.tabs.map((t) => t.url)');

(async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Page ${req.url}</title><p>${req.url}</p>`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-restart-'));
  let failed = false;
  try {
    // Two windows with different pages, and a group and a pinned tab in the first.
    let run = await launch(profile, 1);
    const [one] = run.windows;
    await one.run(`window.tern.open('${base}/one', {})`);
    await waitFor(() => one.run(`state.tabs.some((t) => t.url === '${base}/one' && !t.loading)`), 8000, 'page one');
    await one.run(`window.tern.open('${base}/grouped', { newTab: true })`);
    await waitFor(() => one.run(`state.tabs.some((t) => t.url === '${base}/grouped' && !t.loading)`), 8000, 'the second tab');
    await one.run('window.tern.newGroup(state.activeId)');
    await waitFor(() => one.run('state.groups.length === 1'), 3000, 'the group');
    await one.run("window.tern.renameGroup(state.groups[0].id, 'Saved group')");
    await one.run("window.tern.runAction('newWindow')");
    const second = await waitFor(async () => {
      const list = await shells();
      return list.length === 2 && list;
    }, 10000, 'the new window');
    const conns = await Promise.all(second.map((t) => connect(t.webSocketDebuggerUrl)));
    const other = (await Promise.all(conns.map(async (c) => [c, await c.run(`state.tabs.some((t) => t.url === '${base}/one')`)]))).find(([, has]) => !has)[0];
    await waitFor(() => other.run('state?.tabs.length > 0'), 8000, 'the new window to be ready');
    await other.run(`window.tern.open('${base}/two', {})`);
    await waitFor(() => other.run(`state.tabs.some((t) => t.url === '${base}/two' && !t.loading)`), 8000, 'page two');
    await sleep(1200);
    for (const c of conns) c.close();
    await quit(run, "window.tern.runAction('exit')");
    const saved = JSON.parse(fs.readFileSync(path.join(profile, 'session.json'), 'utf8'));
    assert.equal(saved.windows.length, 2, 'both windows were saved');
    console.log('PASS  Exit quits, and saves both windows');

    // Both come back with their own pages and the group.
    run = await launch(profile, 2);
    const pages = await Promise.all(run.windows.map(urlsIn));
    const firstIndex = pages.findIndex((urls) => urls.includes(`${base}/one`));
    assert.ok(firstIndex >= 0, 'first window restored');
    assert.deepEqual(pages[firstIndex], [`${base}/one`, `${base}/grouped`]);
    assert.deepEqual(pages[1 - firstIndex], [`${base}/two`]);
    const groups = await run.windows[firstIndex].run('state.groups.map((g) => g.name)');
    assert.deepEqual(groups, ['Saved group']);
    console.log('PASS  after a real restart, both windows are back with their own tabs and the group');

    // Closing a window on purpose means it doesn't come back.
    run.windows[1 - firstIndex].run("window.tern.runAction('closeWindow')");
    await waitFor(async () => (await shells()).length === 1, 8000, 'the window to close');
    await sleep(800);
    const remaining = run.windows[firstIndex];
    run.windows = [remaining];
    await quit(run, "window.tern.runAction('exit')");
    assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'session.json'), 'utf8')).windows.length, 1);
    run = await launch(profile, 1);
    assert.deepEqual(await urlsIn(run.windows[0]), [`${base}/one`, `${base}/grouped`]);
    console.log('PASS  a window closed on purpose stays closed after a restart');
    await quit(run, "window.tern.runAction('exit')");

    // A file from before Tern had several windows still restores.
    fs.writeFileSync(path.join(profile, 'session.json'), JSON.stringify({ activeIndex: 0, groups: [], tabs: [{ url: `${base}/old-format`, title: 'Old' }] }));
    run = await launch(profile, 1);
    assert.deepEqual(await urlsIn(run.windows[0]), [`${base}/old-format`]);
    console.log('PASS  tabs saved by older versions still come back');
    await quit(run, "window.tern.runAction('exit')");
    console.log('RESTART TEST PASS');
  } catch (error) {
    failed = true;
    console.log(`FAIL  ${error.message}`);
  }
  server.close();
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Temp folder, safe to leave.
  }
  process.exit(failed ? 1 : 0);
})();
