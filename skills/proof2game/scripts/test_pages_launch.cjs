'use strict';

const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const url = new URL('https://games.example.test/proof/demo/proof2game.json');
const launcher = import('./launch-pages.mjs');
const browser = import('../assets/pages-launch/launch.js');

test('the public prompt starts the local game with one manifest argument', async () => {
  const {launchPrompt} = await browser;
  const prompt = launchPrompt('v0.1.28', url.href);
  assert.match(prompt, /github[.]com\/zhenyao-sun\/Proof2Game/);
  assert.match(prompt, /open it in my default browser/);
  assert.doesNotMatch(prompt, /pairing code/i);
  assert.throws(() => launchPrompt('main', url.href));
  const {openGame} = await launcher;
  await assert.rejects(openGame('https://example.test/'), /Invalid local game address/);
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
  const address = await startGame(game);
  assert.equal(await startGame(game), address);
  assert.equal(manifest.launch_mode, 'local');
  assert.equal(manifest.game_id, game.game.id);
  await assert.rejects(fs.stat(path.join(website,'play')), {code:'ENOENT'});
  assert.match(await fs.readFile(path.join(website,'index.html'),'utf8'), /src="\.\/launch\.js\?release=v[\d.]+"/);
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
  const {game_id,launch_mode,...previous} = manifest;
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
