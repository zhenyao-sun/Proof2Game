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
  let gameAddress, used = false, timer;
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
      if (!gameAddress) { reply(202); return; }
      used = true;
      response.on('finish', () => close(true));
      reply(200, {url: gameAddress});
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
  return {paired, close, port: server.address().port, ready(value) { gameAddress = localURL(value); }};
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

export async function startGame({directory, game}) {
  const existing = await runningGame(directory, game.id);
  if (existing) return existing;
  const log = await fs.open(path.join(directory, 'runtime.log'), 'a', 0o600);
  let child;
  try {
    // Execute the release's own server, with the downloaded data as its data directory.
    child = spawn(process.execPath, [path.join(runtime, 'server.mjs'), '--no-open'], {
      cwd: directory, env: {...process.env, PROOF2GAME_PAGES_DATA: directory},
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

async function main() {
  const [manifest, code, extra] = process.argv.slice(2);
  if (!manifest || extra || (code && !tokenPattern.test(code))) {
    throw new Error('Usage: node launch-pages.mjs HTTPS_MANIFEST_URL [PAIR_CODE]');
  }
  if (process.platform !== 'darwin' || Number(process.versions.node.split('.')[0]) < 20) {
    throw new Error('The Proof2Game connector requires macOS and Node.js 20 or later.');
  }
  const url = gameURL(manifest);
  const release = (await fs.readFile(new URL('VERSION', repo), 'ascii')).trim();
  let pairing;
  if (code) {
    try { pairing = await startPairing(url, code); }
    catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      console.error('Another pairing is in progress. Use the local address printed below.');
    }
  }
  try {
    const address = await startGame(await loadGame(url, release));
    console.log('Open Proof2Game on this Mac: ' + address);
    pairing?.ready(address);
    if (pairing && await pairing.paired) console.log('The launch tab is connected.');
  } finally {
    pairing?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
