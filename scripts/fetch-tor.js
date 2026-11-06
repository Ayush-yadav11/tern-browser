'use strict';

// Puts the Tor program in vendor/tor. Run with: npm run fetch-tor
// `--update` moves to Tor's latest stable version, accepting it only if the release's
// signed checksum list verifies against the Tor Browser signing key pinned below.
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const LOCK = path.join(root, 'assets', 'tor-lock.json');
const VENDOR = path.join(root, 'vendor', 'tor');
const DIST = 'https://dist.torproject.org/torbrowser';
const LATEST = 'https://aus1.torproject.org/torbrowser/update_3/release/downloads.json';
const SIGNING_KEY = 'EF6E286DDA85EA2A4BA7DE684E2C6E8793298290';
const KEY_URL = `https://keys.openpgp.org/vks/v1/by-fingerprint/${SIGNING_KEY}`;
const fileFor = (version) => `tor-expert-bundle-windows-x86_64-${version}.tar.gz`;

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

function findGpg() {
  for (const candidate of ['gpg', 'C:/Program Files/Git/usr/bin/gpg.exe']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  throw new Error('gpg is needed to verify Tor. It comes with Git for Windows.');
}

// Returns the checksum from the signed list, or throws if the signature doesn't verify.
async function verifiedChecksum(version, work) {
  const gpg = findGpg();
  const home = path.join(work, 'gnupg');
  fs.mkdirSync(home, { mode: 0o700 });
  const keyFile = path.join(work, 'key.asc');
  const sums = path.join(work, 'sums.txt');
  const signature = path.join(work, 'sums.txt.asc');
  fs.writeFileSync(keyFile, await download(KEY_URL));
  fs.writeFileSync(sums, await download(`${DIST}/${version}/sha256sums-signed-build.txt`));
  fs.writeFileSync(signature, await download(`${DIST}/${version}/sha256sums-signed-build.txt.asc`));
  // Relative paths, because the gpg in Git for Windows can't read C:\ style ones.
  const gpgIn = (args, options) => execFileSync(gpg, ['--homedir', 'gnupg', '--batch', ...args], { cwd: work, ...options });
  gpgIn(['--quiet', '--import', 'key.asc'], { stdio: 'ignore' });
  const status = gpgIn(['--status-fd', '1', '--verify', 'sums.txt.asc', 'sums.txt'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // VALIDSIG's last field is the primary key, which is the one that has to match.
  const valid = status.split(/\r?\n/).find((l) => l.startsWith('[GNUPG:] VALIDSIG'));
  if (!valid || valid.trim().split(/\s+/).pop() !== SIGNING_KEY) throw new Error('Tor checksum list is not signed by the expected key');
  const line = fs.readFileSync(sums, 'utf8').split(/\r?\n/).find((l) => l.endsWith(fileFor(version)));
  if (!line) throw new Error(`${fileFor(version)} is not in the signed list`);
  return line.split(/\s+/)[0];
}

function install(bundle) {
  fs.rmSync(VENDOR, { recursive: true, force: true });
  fs.mkdirSync(VENDOR, { recursive: true });
  const archive = path.join(VENDOR, 'bundle.tar.gz');
  fs.writeFileSync(archive, bundle);
  execFileSync('tar', ['-xzf', 'bundle.tar.gz'], { cwd: VENDOR, stdio: 'ignore' });
  fs.rmSync(archive);
  // Bridge transports, country lookups and the key tool aren't used, and they're most of the size.
  fs.rmSync(path.join(VENDOR, 'tor', 'pluggable_transports'), { recursive: true, force: true });
  fs.rmSync(path.join(VENDOR, 'tor', 'tor-gencert.exe'), { force: true });
  fs.rmSync(path.join(VENDOR, 'data'), { recursive: true, force: true });
  if (!fs.existsSync(path.join(VENDOR, 'tor', 'tor.exe'))) throw new Error('tor.exe missing from the bundle');
}

async function main() {
  const update = process.argv.includes('--update');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tern-tor-'));
  try {
    const lock = fs.existsSync(LOCK) ? JSON.parse(fs.readFileSync(LOCK, 'utf8')) : null;
    let { version, sha256: expected } = lock ?? {};
    if (update || !lock) {
      version = JSON.parse((await download(LATEST)).toString()).version;
      if (version !== lock?.version) {
        expected = await verifiedChecksum(version, work);
        fs.writeFileSync(LOCK, `${JSON.stringify({ version, sha256: expected }, null, 2)}\n`);
        console.log(`Tor ${version}: signature verified`);
      }
    }
    const installed = path.join(VENDOR, 'version.txt');
    if (fs.existsSync(installed) && fs.readFileSync(installed, 'utf8') === expected) {
      console.log(`Tor ${version} already in place`);
      return;
    }
    const bundle = await download(`${DIST}/${version}/${fileFor(version)}`);
    if (sha256(bundle) !== expected) throw new Error('Tor download does not match its checksum');
    install(bundle);
    fs.writeFileSync(installed, expected);
    console.log(`Tor ${version} installed in vendor/tor`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
