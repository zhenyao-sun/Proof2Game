'use strict';

const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const url = new URL('https://games.example.test/proof/demo/proof2game.json');
const code = '0123456789abcdef'.repeat(2);
const launcher = import('./launch-pages.mjs');
const browser = import('../assets/pages-launch/launch.js');

test('a pairing grants one use to the exact origin, manifest and code', async t => {
  const {startPairing} = await launcher;
  const {checkPair, launchPrompt} = await browser;
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
  pair.ready('http://127.0.0.1:42345');
  let requested;
  const address = await checkPair(url.href, code, (endpoint, options) => {
    requested = endpoint;
    assert.equal(options.targetAddressSpace, 'loopback');
    assert.equal(options.credentials, 'omit');
    return request(JSON.parse(options.body));
  });
  assert.match(requested, /^http:\/\/127\.0\.0\.1:\d+\/pair$/);
  assert.equal(address, 'http://127.0.0.1:42345/');
  assert.equal(await pair.paired, true);
  assert.equal(await checkPair(url.href, code, async () =>
    Response.json({url: 'http://127.0.0.1.evil.test:42345/'})), null);
  assert.match(launchPrompt('v0.1.16', url.href, code), /github\.com\/zhenyao-sun\/Proof2Game/);
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
    translation = fixture.root / 'translation.json'
    translation.write_text(json.dumps(fixture.translation(record, full)))
    result = json.loads(subprocess.check_output([
        sys.executable, game.__file__, '--main', str(fixture.main), '--translation', str(translation),
        '--pages', '--output', sys.argv[1],
    ]))
    assert result['distribution'] == 'pages' and result['published'] is False
finally:
    fixture.doCleanups()
`;

test('a real Pages export downloads, starts the local runtime and restores a save', {
  skip: process.platform !== 'darwin', timeout: 60000
}, async t => {
  const {gameURL, loadGame, startGame} = await launcher;
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
  await assert.rejects(loadGame(url, release, cache, async (target, options) => {
    if (target.href !== url.href) return fakeFetch(target, options);
    return Response.json({...manifest, files: {...manifest.files, 'snapshot/../server.mjs': manifest.files['game.json']}});
  }), /Invalid or oversized/);
  await assert.rejects(loadGame(url, release, cache, async (target, options) => {
    if (target.href === new URL('game.json', url).href) return new Response('{}');
    return fakeFetch(target, options);
  }), /did not match its manifest/);
  game = await loadGame(url, release, cache, fakeFetch);
  assert.equal(game.game.chinese.levels.main.title, '正性');
  const address = await startGame(game);
  assert.equal(await startGame(game), address);
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
  const changed = await api('action', {
    method: 'POST',
    body: JSON.stringify({action: 'language', language: '中文', request_id: 'pages-test-001', expected_revision: 0})
  });
  assert.equal(changed.progress.language, '中文');
  await stop();
  game = await loadGame(url, release, cache, async (target, options) => {
    assert.equal(target.href, url.href);
    return fakeFetch(target, options);
  });
  const reopened = await session(await startGame(game));
  assert.equal((await reopened('game')).progress.language, '中文');
});
