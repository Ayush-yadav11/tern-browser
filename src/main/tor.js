'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const START_LIMIT_MS = 120 * 1000;

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Runs the Tor program, only while there are Tor tabs open.
class Tor extends EventEmitter {
  constructor({ exePath, dataDir }) {
    super();
    this.exePath = exePath;
    this.dataDir = dataDir;
    this.child = null;
    this.port = null;
    this.limit = null;
    this.state = { status: 'off', percent: 0, message: '' };
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('changed');
  }

  async start() {
    if (this.child || this.state.status === 'ready') return;
    if (!fs.existsSync(this.exePath)) {
      this.set({ status: 'error', percent: 0, message: "Tor isn't included in this build." });
      return;
    }
    this.set({ status: 'starting', percent: 0, message: '' });
    this.port = await freePort();
    fs.mkdirSync(this.dataDir, { recursive: true });
    const child = spawn(this.exePath, [
      '--ignore-missing-torrc',
      '-f', 'NUL',
      '--SocksPort', `127.0.0.1:${this.port}`,
      '--DataDirectory', this.dataDir,
      '--ClientOnly', '1',
      // Tor shuts itself down if Tern ever exits without stopping it.
      '--__OwningControllerProcess', String(process.pid),
      '--Log', 'notice stdout',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child = child;
    let pending = '';
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) this.readLine(line);
    });
    const failed = (message) => {
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(this.limit);
      this.set({ status: 'error', percent: 0, message });
      this.emit('lost');
    };
    child.once('error', () => failed("Tor couldn't start. Security software may be blocking it."));
    child.once('exit', () => failed('Tor stopped unexpectedly.'));
    clearTimeout(this.limit);
    this.limit = setTimeout(() => {
      if (this.state.status !== 'ready') {
        const running = this.child;
        failed("Couldn't connect to the Tor network. Your network may be blocking it.");
        running?.kill();
      }
    }, START_LIMIT_MS);
    this.limit.unref?.();
  }

  readLine(line) {
    const match = /Bootstrapped (\d+)%/.exec(line);
    if (!match) return;
    const percent = Number(match[1]);
    if (percent === 100) {
      clearTimeout(this.limit);
      this.set({ status: 'ready', percent, message: '' });
      this.emit('ready');
    } else {
      this.set({ percent });
    }
  }

  stop() {
    clearTimeout(this.limit);
    const running = this.child;
    this.child = null;
    running?.kill();
    this.port = null;
    if (this.state.status !== 'off') this.set({ status: 'off', percent: 0, message: '' });
  }
}

const torPath = (app) => (app.isPackaged
  ? path.join(process.resourcesPath, 'tor', 'tor', 'tor.exe')
  : path.join(__dirname, '..', '..', 'vendor', 'tor', 'tor', 'tor.exe'));

module.exports = { Tor, torPath };
