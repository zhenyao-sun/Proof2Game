'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const url = new URL('https://games.example.test/proof/demo/proof2game.json');
const code = '0123456789abcdef'.repeat(2);
const token = 'A'.repeat(43);
const launcher = import('./launch-pages.mjs');
const browser = import('../assets/pages-launch/launch.js');

test('a pairing grants one use to the exact origin, manifest and code', async t => {
  const {startPairing} = await launcher;
  const {checkPair, launchPrompt, activePairing} = await browser;
  const pair = await startPairing(url, code, {port: 0, lifetime: 3000});
  t.after(() => pair.close());
  const destination = 'http://127.0.0.1:' + pair.port + '/pair';
  const preflight = await fetch(destination, {
    method: 'OPTIONS',
    headers: {origin: url.origin, 'access-control-request-method': 'POST'}
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), url.origin);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  const request = (input, origin = url.origin) => fetch(destination, {
    method: 'POST', headers: {origin, 'content-type': 'application/json'}, body: JSON.stringify(input)
  });
  const correct = {manifest: url.href, code};
  assert.equal((await request(correct, 'https://other.example.test')).status, 403);
  assert.equal((await request({...correct, code: 'f'.repeat(32)})).status, 403);
  assert.equal((await request({...correct, manifest: url.origin + '/other/proof2game.json'})).status, 403);
  assert.equal((await request(correct)).status, 202);
  assert.throws(() => pair.ready('https://example.test/'));
  pair.ready('http://127.0.0.1:42345', token);
  let requested;
  const address = await checkPair(url.href, code, (endpoint, options) => {
    requested = endpoint;
    assert.equal(options.targetAddressSpace, 'loopback');
    assert.equal(options.credentials, 'omit');
    return request(JSON.parse(options.body));
  });
  assert.match(requested, /^http:\/\/127\.0\.0\.1:\d+\/pair$/);
  assert.deepEqual(address, {url: 'http://127.0.0.1:42345', token});
  const confirm = () => fetch(destination.replace('/pair', '/confirm'), {
    method: 'POST', headers: {origin: url.origin, 'content-type': 'application/json'}, body: JSON.stringify(correct)
  });
  assert.equal(pair.status(), 'issued');
  assert.equal(await Promise.race([pair.paired, Promise.resolve('unconfirmed')]), 'unconfirmed');
  assert.equal((await confirm()).status, 200);
  assert.equal(await pair.paired, true);
  const pending = {code, connector:'v0.1.25', expires:11000};
  assert.deepEqual(activePairing(JSON.parse(JSON.stringify(pending)), 'v0.1.25', 1000), pending);
  assert.equal(activePairing(pending, 'v0.1.25', 11000), null);
  assert.equal(activePairing(pending, 'v0.1.24', 1000), null);
  assert.equal(await checkPair(url.href, code, async () =>
    Response.json({url: 'http://127.0.0.1.evil.test:42345/', token})), null);
  assert.match(launchPrompt('v0.1.16', url.href, code), /github\.com\/zhenyao-sun\/Proof2Game/);
  assert.match(launchPrompt('v0.1.22', url.href, code), /Do not inspect, open, or switch browsers/);
  assert.throws(() => launchPrompt('main', url.href, code));
});

test('an unused pairing expires', async () => {
  const {startPairing} = await launcher;
  const pair = await startPairing(url, code, {port: 0, lifetime: 15});
  assert.equal(await pair.paired, false);
});

const buildFixture = `
import json, subprocess, sys
from pathlib import Path
from test_game_export import GameExportTests, game
fixture = GameExportTests()
fixture.setUp()
try:
    record, full = fixture.approve()
    record['original_sha256'] = 'a' * 64
    fixture.approval.write_text(json.dumps(record))
    paper = fixture.root / 'paper.json'
    paper.write_text(json.dumps(dict(title='Exact paper', authors=['Ada Example'], version='v1',
                                     sha256=record['original_sha256'])))
    translation = fixture.root / 'translation.json'
    translation.write_text(json.dumps(fixture.translation(record, full)))
    result = json.loads(subprocess.check_output([
        sys.executable, game.__file__, '--main', str(fixture.main), '--translation', str(translation),
        '--paper-metadata', str(paper), '--output', sys.argv[1],
    ]))
    assert result['distribution'] == 'pages' and result['published'] is False
finally:
    fixture.doCleanups()
`;

test('a real Pages export downloads, starts the local runtime and restores a save', {
  skip: process.platform !== 'darwin', timeout: 60000
}, async t => {
  const {gameURL, loadGame, startGame, bridgeFor} = await launcher;
  assert.throws(() => gameURL('http://example.test/proof2game.json'), /HTTPS/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'proof2game-pages-test-'));
  let game;
  async function stop() {
    if (!game) return;
    const lock = path.join(game.directory, '.player-save.lock');
    const pid = Number(await fs.readFile(lock, 'utf8').catch(() => 0));
    if (pid > 0) process.kill(pid, 'SIGTERM');
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!await fs.stat(lock).catch(() => null)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Timed out waiting for the local runtime to stop.');
  }
  t.after(async () => {
    await stop();
    await fs.rm(root, {recursive: true, force: true});
  });
  const website = path.join(root, 'website');
  const release = (await fs.readFile(path.join(__dirname, '../../../VERSION'), 'utf8')).trim();
  execFileSync('python3', ['-c', buildFixture, website], {
    cwd: __dirname, env: {...process.env, PYTHONDONTWRITEBYTECODE: '1'}, timeout: 45000
  });
  for (const name of ['.nojekyll', 'launch.js', 'index.html', 'launch.css']) {
    assert.ok((await fs.stat(path.join(website, name))).isFile());
  }
  for (const name of ['server.mjs', 'references', 'approval.json', 'player-save.json']) {
    await assert.rejects(fs.stat(path.join(website, name)), {code: 'ENOENT'});
  }
  const fakeFetch = async (target, options) => {
    assert.equal(target.origin, url.origin);
    assert.equal(options.redirect, 'error');
    assert.ok(target.pathname.startsWith('/proof/demo/'));
    const file = decodeURIComponent(target.pathname.slice('/proof/demo/'.length));
    return new Response(await fs.readFile(path.join(website, file)));
  };
  const cache = path.join(root, 'cache');
  await assert.rejects(loadGame(url, 'v0.0.0', cache, fakeFetch), /requires the official connector/);
  const manifest = JSON.parse(await fs.readFile(path.join(website, 'proof2game.json'), 'utf8'));
  assert.deepEqual(manifest.paper, {title: 'Exact paper', authors: ['Ada Example'], version: 'v1'});
  await assert.rejects(loadGame(url, release, cache, async (target, options) => {
    if (target.href !== url.href) return fakeFetch(target, options);
    return Response.json({...manifest, files: {...manifest.files, 'snapshot/../server.mjs': manifest.files['game.json']}});
  }), /Invalid or oversized/);
  await assert.rejects(loadGame(url, release, cache, async (target, options) => {
    if (target.href === new URL('game.json', url).href) return new Response('{}');
    return fakeFetch(target, options);
  }), /did not match its manifest/);
  let interrupted = 0;
  game = await loadGame(url, release, cache, async (target, options) => {
    if (target.pathname.endsWith('/game.json') && interrupted++ === 0) {
      return new Response('Temporary failure', {status: 503});
    }
    return fakeFetch(target, options);
  });
  assert.equal(interrupted, 2);
  assert.equal(game.game.chinese.levels.main.title, '正性');
  const address = await startGame(game, url.origin);
  assert.equal(await startGame(game, url.origin), address);
  const bridgeToken = await bridgeFor(address, url.origin);
  const stateURL = address + '/api/game';
  const headers = {origin: url.origin, authorization: 'Bearer ' + bridgeToken};
  const allowed = await fetch(stateURL, {headers});
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), url.origin);
  assert.equal((await allowed.json()).game.id, manifest.game_id);
  assert.equal((await fetch(stateURL, {headers: {origin: url.origin}})).status, 401);
  assert.equal((await fetch(stateURL, {headers: {...headers, origin: 'https://other.example.test'}})).status, 403);
  const preflight = await fetch(address + '/api/action', {method: 'OPTIONS',
    headers: {origin: url.origin, 'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type'}});
  assert.equal(preflight.status, 204);
  assert.match(preflight.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  assert.equal((await fetch(address + '/api/bridge', {headers})).status, 403);
  assert.match(await fs.readFile(path.join(website,'play/index.html'),'utf8'), /src="\.\/app\.js"/);
  assert.doesNotMatch(await fs.readFile(path.join(website,'launch.js'),'utf8'), /location\.replace/);
  async function session(origin) {
    const homepage = await fetch(origin);
    assert.match(await homepage.text(), /<title>Proof2Game<\/title>/);
    const cookie = homepage.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(origin + '/api/game')).status, 401);
    const headers = {cookie, origin, 'content-type': 'application/json'};
    return async (route, request = {}) => {
      const response = await fetch(origin + '/api/' + route, {headers, ...request});
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      return body;
    };
  }
  const api = await session(address);
  assert.equal((await api('game')).progress.language, 'English');
  const change = await fetch(address+'/api/action', {
    method: 'POST', headers: {...headers, 'content-type':'application/json'},
    body: JSON.stringify({action: 'language', language: '中文', request_id: 'pages-test-001', expected_revision: 0})
  });
  assert.equal(change.status, 200);
  assert.equal((await change.json()).progress.language, '中文');
  const {game_id, ...previous} = manifest;
  previous.connector = 'v0.1.21';
  const key = createHash('sha256').update(url.href+'\n'+JSON.stringify(previous)+'\n').digest('hex');
  const upgradeCache = path.join(root, 'upgrade');
  const old = path.join(upgradeCache,key);
  await fs.mkdir(old,{recursive:true});
  for (const name of ['game.json','player-save.json']) {
    await fs.copyFile(path.join(game.directory,name),path.join(old,name));
  }
  const upgraded = await loadGame(url,release,upgradeCache,fakeFetch);
  assert.equal(JSON.parse(await fs.readFile(path.join(upgraded.directory,'player-save.json'),'utf8')).language,'中文');
  await stop();
  game = await loadGame(url, release, cache, async (target, options) => {
    assert.equal(target.href, url.href);
    return fakeFetch(target, options);
  });
  const reopened = await session(await startGame(game));
  assert.equal((await reopened('game')).progress.language, '中文');
});
