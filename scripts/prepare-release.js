'use strict';

// Used by the weekly GitHub workflow. Moves Electron and the ad-block engine to their latest
// versions, then works out whether that calls for a new release.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const run = (command) => execSync(command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const installed = () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;
  return ['electron', '@ghostery/adblocker-electron'].map((name) => `${name}@${lock[`node_modules/${name}`].version}`);
};

const torLock = () => fs.readFileSync(path.join(root, 'assets', 'tor-lock.json'), 'utf8');
const before = [...installed(), torLock()];
run('npm install --save-dev --no-audit --no-fund electron@latest');
run('npm install --save --no-audit --no-fund @ghostery/adblocker-electron@latest');
// Stops the workflow, so nothing gets published, if a new Tor's signature doesn't verify.
run('node scripts/fetch-tor.js --update');
const after = [...installed(), torLock()];
const changed = before.join() !== after.join();

const readVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const tagged = (version) => run(`git tag --list v${version}`).trim() !== '';

// A version with no tag yet is one somebody bumped by hand and wants released.
let release = !tagged(readVersion());
if (changed && !release) {
  run('npm version patch --no-git-tag-version');
  release = true;
}

const version = readVersion();
const names = (list) => list.slice(0, 2).join(', ') + ', Tor ' + JSON.parse(list[2]).version;
console.log(`${names(before)} -> ${names(after)}. Release: ${release ? `v${version}` : 'nothing new'}`);
fs.appendFileSync(process.env.GITHUB_OUTPUT, `release=${release}\nversion=${version}\nnotes=Built on ${names(after)}.\n`);
