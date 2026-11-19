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

test('a real Pages export opens directly and restores browser progress', {
  skip: process.platform !== 'darwin', timeout: 60000
}, async t => {
  const {pathToFileURL}=require('node:url');
  const {loadBrowserGame}=await import(pathToFileURL(path.join(__dirname,'../assets/game-runtime/browser-engine.mjs')));
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'proof2game-browser-site-'));
  const website=path.join(root,'website');
  execFileSync('python3',['-c',buildFixture,website],{cwd:__dirname,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},timeout:45000});
  for(const name of ['.nojekyll','index.html','browser-engine.mjs','browser-entry.mjs','level-tree.mjs','app.js'])assert.ok((await fs.stat(path.join(website,name))).isFile());
  for(const name of ['server.mjs','launch.js','references','approval.json','player-save.json'])await assert.rejects(fs.stat(path.join(website,name)),{code:'ENOENT'});
  globalThis.location=new URL('https://games.example.test/proof/demo/');
  const fakeFetch=async(target,options)=>{
    assert.equal(target.origin,location.origin);assert.equal(options.redirect,'error');
    assert.ok(target.pathname.startsWith('/proof/demo/'));
    return new Response(await fs.readFile(path.join(website,decodeURIComponent(target.pathname.slice('/proof/demo/'.length)))));
  };
  const storage={data:new Map(),getItem(key){return this.data.get(key)??null;},setItem(key,value){this.data.set(key,value);},removeItem(key){this.data.delete(key);}};
  const engine=await loadBrowserGame({fetcher:fakeFetch,storage});
  let value=await engine.request('/api/game');assert.equal(value.game.paper.title,'Exact paper');assert.equal(value.progress.language,'English');
  await engine.request('/api/action',{action:'language',language:'中文',expected_revision:0,request_id:'language'});
  const restored=await loadBrowserGame({fetcher:fakeFetch,storage});assert.equal((await restored.request('/api/game')).progress.language,'中文');
  await assert.rejects(loadBrowserGame({storage,fetcher:async(target,options)=>target.pathname.endsWith('/game.json')?new Response('{}'):fakeFetch(target,options)}),/file changed/);
  const manifest=JSON.parse(await fs.readFile(path.join(website,'proof2game.json'),'utf8'));
  await assert.rejects(loadBrowserGame({storage,fetcher:async(target,options)=>target.pathname.endsWith('/proof2game.json')?Response.json({...manifest,files:{...manifest.files,'snapshot/../private.tex':manifest.files['game.json']}}):fakeFetch(target,options)}),/Invalid game file path/);
  assert.equal(manifest.launch_mode,'browser');
  const html=await fs.readFile(path.join(website,'index.html'),'utf8');
  assert(html.includes('src="./browser-entry.mjs?v='+manifest.connector+'"'));
  assert(html.includes('href="./style.css?v='+manifest.connector+'"'));
  const entry=await fs.readFile(path.join(website,'browser-entry.mjs'),'utf8');
  for(const dependency of ['browser-engine.mjs','app.js']){
    assert(entry.includes('./'+dependency+'?v='+manifest.connector));
  }
  const engineSource=await fs.readFile(path.join(website,'browser-engine.mjs'),'utf8');
  assert(engineSource.includes('./level-tree.mjs?v='+manifest.connector));
});
