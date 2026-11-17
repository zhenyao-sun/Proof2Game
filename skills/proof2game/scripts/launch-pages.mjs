#!/usr/bin/env node
/* Run only from the official, versioned Proof2Game checkout. */
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

export const PAIR_PORT = 47682;
const MAX_DATA = 128 * 1024 * 1024;
const MAX_MANIFEST = 1024 * 1024;
const LOCAL_HOST = '127.0.0.1';
const repo = new URL('../../../', import.meta.url);
const runtime = fileURLToPath(new URL('../assets/game-runtime/', import.meta.url));
const cache = path.join(os.homedir(), 'Library', 'Application Support', 'Proof2Game', 'pages-games');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tokenPattern = /^[a-f0-9]{32}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export function gameURL(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || !url.pathname.endsWith('/proof2game.json') ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS link to the published proof2game.json manifest.');
  }
  return url;
}

function gameFile(name) {
  return name === 'game.json' || (
    /^(snapshot|translation\/zh)\/.+\.(tex|sty|cls|def|cfg|clo|bib|png|jpe?g|webp)$/i.test(name) &&
    name.split('/').every(part => part && !part.startsWith('.') && !/[%\\?#\x00-\x1f]/.test(part))
  );
}

function localURL(input) {
  const url = new URL(input);
  if (url.protocol !== 'http:' || url.hostname !== LOCAL_HOST || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid local game address.');
  }
  return url.origin;
}

async function download(url, limit, fetchFile) {
  const response = await fetchFile(url, {redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!response.ok || !response.body) throw new Error('Could not download ' + url.pathname);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > limit) throw new Error('Published file exceeds its declared size limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

// Preserve saves when upgrading the same v0.1.21 hosted game to the bridge.
async function importPreviousSaves(root, stage, url, manifest) {
  const {game_id, ...previous} = manifest;
  if (!game_id || previous.connector !== 'v0.1.22') return;
  previous.connector = 'v0.1.21';
  const key = digest(url.href + '\n' + JSON.stringify(previous) + '\n');
  const source = path.join(root, key);
  async function localType(file, kind) {
    try {
      return await fs.realpath(file) === file && (await fs.lstat(file))[kind]();
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }
  if (!await localType(source, 'isDirectory')) return;
  const previousGame = path.join(source, 'game.json');
  if (!await localType(previousGame, 'isFile') ||
      digest(await fs.readFile(previousGame)) !== manifest.files['game.json'].sha256) return;
  for (const name of ['player-save.json','player-save.json.backup']) {
    if (await localType(path.join(source, name), 'isFile')) {
      await fs.copyFile(path.join(source, name), path.join(stage, name));
    }
  }
  const manual = path.join(source, 'manual-saves');
  if (!await localType(manual, 'isDirectory')) return;
  const saves = path.join(stage, 'manual-saves');
  await fs.mkdir(saves, {mode: 0o700});
  for (const name of await fs.readdir(manual)) {
    const file = path.join(manual, name);
    if (/^[a-f0-9-]{36}\.json$/.test(name) && await localType(file, 'isFile')) {
      await fs.copyFile(file, path.join(saves, name));
    }
  }
}

export async function loadGame(url, release, root = cache, fetchFile = fetch) {
  const manifestBytes = await download(url, MAX_MANIFEST, fetchFile);
  const manifest = JSON.parse(manifestBytes);
  if (manifest.schema !== 1 || manifest.connector !== release ||
      !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) ||
      !Object.hasOwn(manifest.files, 'game.json')) {
    throw new Error('This game requires the official connector version shown on its launch page.');
  }
  const files = Object.entries(manifest.files);
  if (files.length > 2048 || files.some(([name, file]) =>
    !gameFile(name) || !file || typeof file.sha256 !== 'string' || !digestPattern.test(file.sha256) ||
    !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_DATA) ||
    files.reduce((sum, [, file]) => sum + file.size, 0) > MAX_DATA) {
    throw new Error('Invalid or oversized published game data.');
  }
  // Case-insensitive filesystems must not allow two downloads to share a file.
  if (new Set(files.map(([name]) => name.normalize('NFD').toLowerCase())).size !== files.length) {
    throw new Error('The published game contains conflicting file paths.');
  }
  const key = digest(Buffer.concat([Buffer.from(url.href + '\n'), manifestBytes]));
  await fs.mkdir(root, {recursive: true, mode: 0o700});
  const destination = path.join(await fs.realpath(root), key);
  async function validateDirectory() {
    if (await fs.realpath(destination) !== destination) throw new Error('Invalid local game directory.');
    for (const [name, entry] of files) {
      const file = path.join(destination, name);
      if (await fs.realpath(file) !== file || digest(await fs.readFile(file)) !== entry.sha256) {
        throw new Error('Local game data has changed. Preserve your saves and ask Codex to restore the game.');
      }
    }
  }
  try {
    await fs.lstat(destination);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const stage = await fs.mkdtemp(path.join(path.dirname(destination), '.download-'));
    try {
      for (const [name, entry] of files) {
        const relative = name.split('/').map(encodeURIComponent).join('/');
        const bytes = await download(new URL(relative, url), entry.size, fetchFile);
        if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) {
          throw new Error('Published file did not match its manifest: ' + name);
        }
        const file = path.join(stage, name);
        await fs.mkdir(path.dirname(file), {recursive: true});
        await fs.writeFile(file, bytes, {flag: 'wx'});
      }
      const game = JSON.parse(await fs.readFile(path.join(stage, 'game.json'), 'utf8'));
      validateHostedGame(game, manifest.files);
      await importPreviousSaves(path.dirname(destination), stage, url, manifest);
      try { await fs.rename(stage, destination); }
      catch (error) { if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error; }
    } finally {
      await fs.rm(stage, {recursive: true, force: true});
    }
  }
  await validateDirectory();
  const game = JSON.parse(await fs.readFile(path.join(destination, 'game.json'), 'utf8'));
  validateHostedGame(game, manifest.files);
  return {directory: destination, game};
}

function validateHostedGame(game, files) {
  if (game.distribution !== 'pages' || !game.chinese || typeof game.id !== 'string' || !digestPattern.test(game.id) ||
      game.id !== game.snapshot_digest || !game.snapshot_files || !game.reference_files ||
      Object.keys(game.reference_files).length || Object.keys(files).length !== Object.keys(game.snapshot_files).length + 1 ||
      Object.entries(game.snapshot_files).some(([name, sha]) =>
        name === 'game.json' || !Object.hasOwn(files, name) || files[name].sha256 !== sha)) {
    throw new Error('The published game does not match its data files.');
  }
}

export async function startPairing(url, token, {port = PAIR_PORT, lifetime = 180000} = {}) {
  if (!tokenPattern.test(token)) throw new Error('Use the one-time code from the game launch page.');
  let connection, used = false, timer;
  let finish;
  const paired = new Promise(resolve => { finish = resolve; });
  const server = http.createServer({requestTimeout: 5000, headersTimeout: 5000}, async (request, response) => {
    function reply(status, value) {
      response.writeHead(status, {'Cache-Control': 'no-store', 'Content-Type': 'application/json'});
      response.end(value === undefined ? undefined : JSON.stringify(value));
    }
    try {
      if (request.headers.host !== LOCAL_HOST + ':' + server.address()?.port ||
          request.headers.origin !== url.origin || request.url !== '/pair') {
        reply(403); return;
      }
      response.setHeader('Access-Control-Allow-Origin', url.origin);
      response.setHeader('Vary', 'Origin');
      if (request.method === 'OPTIONS' && request.headers['access-control-request-method'] === 'POST') {
        response.setHeader('Access-Control-Allow-Methods', 'POST');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        response.setHeader('Access-Control-Allow-Private-Network', 'true');
        reply(204); return;
      }
      if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
        reply(405); return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (Buffer.byteLength(body) > 2048) { reply(413); return; }
      }
      const input = JSON.parse(body);
      if (input?.code !== token || input?.manifest !== url.href) { reply(403); return; }
      if (used) { reply(410); return; }
      if (!connection) { reply(202); return; }
      used = true;
      response.on('finish', () => close(true));
      reply(200, connection);
    } catch {
      reply(400);
    }
  });
  function close(success = false) {
    clearTimeout(timer);
    server.close();
    finish(success);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOCAL_HOST, resolve);
  });
  timer = setTimeout(close, lifetime);
  return {paired, close, port: server.address().port, ready(value, bridgeToken) {
    const address = localURL(value);
    if (!/^[A-Za-z0-9_-]{43}$/.test(bridgeToken)) throw new Error('Invalid local bridge token.');
    connection = {url: address, token: bridgeToken};
  }};
}

async function runningGame(directory, gameId) {
  try {
    const url = localURL(await fs.readFile(path.join(directory, 'local-address'), 'utf8'));
    const response = await fetch(url, {redirect: 'error', signal: AbortSignal.timeout(1500)});
    await response.body?.cancel();
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (!cookie?.startsWith('proof2game_' + new URL(url).port + '=')) return null;
    const state = await fetch(url + '/api/game', {
      headers: {cookie}, redirect: 'error', signal: AbortSignal.timeout(1500)
    });
    if (state.ok && (await state.json()).game?.id === gameId) return url;
  } catch { /* An address from a previous session may no longer be in use. */ }
  return null;
}

export async function startGame({directory, game}, bridgeOrigin = '') {
  const existing = await runningGame(directory, game.id);
  if (existing) return existing;
  const log = await fs.open(path.join(directory, 'runtime.log'), 'a', 0o600);
  let child;
  try {
    // Execute the release's own server, with the downloaded data as its data directory.
    child = spawn(process.execPath, [path.join(runtime, 'server.mjs'), '--no-open'], {
      cwd: directory, env: {...process.env, PROOF2GAME_PAGES_DATA: directory, PROOF2GAME_PAGES_ORIGIN: bridgeOrigin},
      detached: true, stdio: ['ignore', log.fd, log.fd, 'ipc']
    });
  } finally {
    await log.close();
  }
  let url;
  try {
    url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('The local runtime did not start within 60 seconds. See runtime.log in ' + directory));
      }, 60000);
      const finish = (error, result) => {
        clearTimeout(timer);
        error ? reject(error) : resolve(result);
      };
      child.once('error', error => finish(error));
      child.once('exit', () => finish(new Error('The local runtime could not start. See runtime.log in ' + directory)));
      child.once('message', message => {
        try { finish(null, localURL(message.url)); } catch (error) { finish(error); }
      });
    });
  } catch (error) {
    const concurrent = await runningGame(directory, game.id);
    if (concurrent) return concurrent;
    throw error;
  }
  child.disconnect();
  child.unref();
  return url;
}

export async function bridgeFor(address, expectedOrigin) {
  const options = {redirect: 'error', signal: AbortSignal.timeout(3000)};
  const response = await fetch(address, options);
  await response.body?.cancel();
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('The local game did not issue a session.');
  const {token, origin} = await new Promise((resolve, reject) => {
    const request = http.get(address + '/api/bridge', {headers: {cookie}, timeout: 3000}, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        if (response.statusCode !== 200) { reject(new Error('The local game bridge could not be started.')); return; }
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => request.destroy(new Error('The local game bridge timed out.')));
  });
  if (origin !== expectedOrigin || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('The local game bridge does not match the hosted page.');
  }
  return token;
}

async function main() {
  const [manifest, code, extra] = process.argv.slice(2);
  if (!manifest || extra || !tokenPattern.test(code)) {
    throw new Error('Use the launch prompt from the published game: node launch-pages.mjs HTTPS_MANIFEST_URL PAIR_CODE');
  }
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 20) {
    throw new Error('The Proof2Game connector requires macOS and Node.js 20 or later.');
  }
  const url = gameURL(manifest);
  const release = (await fs.readFile(new URL('VERSION', repo), 'ascii')).trim();
  const pairing = await startPairing(url, code, {lifetime: 10 * 60 * 1000});
  try {
    const address = await startGame(await loadGame(url, release), url.origin);
    pairing.ready(address, await bridgeFor(address, url.origin));
    console.log('Proof2Game is ready. Return to the original browser tab.');
    if (await pairing.paired) console.log('The original game page is connected.');
    else throw new Error('Pairing expired. Copy a fresh prompt from the original game page.');
  } finally {
    pairing.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
