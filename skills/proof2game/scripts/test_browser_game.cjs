const {test}=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');
globalThis.location=new URL('https://example.test/games/paper/');
const moduleURL=pathToFileURL(path.resolve(__dirname,'../assets/game-runtime/browser-engine.mjs'));
class MemoryStorage{
  data=new Map();getItem(k){return this.data.get(k)??null;}setItem(k,v){this.data.set(k,String(v));}removeItem(k){this.data.delete(k);}
}
const game=()=>({schema:1,id:'synthetic',snapshot_digest:'synthetic',model:'deepseek-flash',reasoning_effort:'medium',project_type:'unpublished',references:[],snapshot_files:{'snapshot/main.tex':'fixture'},manuscript:{files:['snapshot/main.tex']},levels:[{id:'result',type:'statement',paired:'proof',parent:null,text:'A synthetic statement',source_file:'snapshot/main.tex'},{id:'proof',type:'proof',paired:'result',parent:'result',text:'Synthetic proof',source_file:'snapshot/main.tex'}],chinese:{files:['translation/zh/main.tex'],levels:{result:{title:'结论',text:'合成结论'},proof:{title:'证明',text:'合成证明'}}}});
function fixtureGame(){const value=game();value.snapshot_files['translation/zh/main.tex']='fixture';return value;}
const none={kind:'none',scope:'partial',description:'',quote:'',level_id:null};
const answer=(extra={})=>({message:'A short explanation.',diagram:null,step_goal:'Understand this passage',phase:'step',understanding:none,...extra});
function tutorReply(fields) {
  return Response.json({choices:[{finish_reason:'stop', message:{content:JSON.stringify(answer(fields))}}]});
}
async function setup(options={}){
 const {createBrowserGame}=await import(moduleURL);const storage=options.storage||new MemoryStorage();const calls=[];
 const fetcher=options.fetcher||async function(url,options){calls.push({url,options});const result=answer();if(JSON.parse(options.body).messages[0].content[0].text.startsWith('Respond to')){delete result.phase;delete result.step_goal;}return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})};};
 const engine=createBrowserGame(options.game||fixtureGame(),[{file:'snapshot/main.tex',text:'Synthetic source'}],{storage,fetcher,onMissingKey:options.onMissingKey});
 async function act(action,extras={}){const value=await engine.request('/api/game');return engine.request('/api/action',{action,level_id:'result',mode:'guide',expected_revision:value.progress.revision,request_id:crypto.randomUUID(),...extras});}
 return {engine,storage,calls,act};
}
test('opening a numbered theorem scopes its lesson even when the next convention shares the number',async()=>{
  const value=fixtureGame();
  delete value.chinese;
  const [result,proof]=value.levels;
  value.levels=[
    {id:'previous',type:'statement',title:'Previous result',text:'Prerequisite identity',paired:'previous-proof',parent:null},
    {...result,kind:'Theorem',title:'A synthetic theorem',statement_number:'1.3',structural_path:'1.2',parent:'previous',text:String.raw`Apply \ref{ms:previous}.`},
    {id:'later',type:'convention',title:'Convention',structural_path:'1.3',owner:result.id,parent:null,text:'Future convention'},
    proof,
    {id:'previous-proof',type:'proof',title:'Proof of the previous result',text:'Earlier proof',paired:'previous',parent:'previous'},
  ];
  value.internal_references={'ms:previous':{level_id:'previous'}};
  const f=await setup({game:value});
  const prompt=()=>JSON.parse(f.calls.at(-1).options.body).messages[0].content[0].text;
  const context=()=>JSON.parse(prompt().split('CONTEXT DATA:\n')[1].split('\nReturn ONLY')[0]);
  f.engine.setKey('test-key');
  await f.act('start',{level_id:'previous'});
  await f.act('understand_all',{level_id:'previous'});
  await f.act('prefetch');
  const resultState=await f.act('start');
  assert.equal(f.calls.length,2);
  assert.equal(resultState.progress.levels.result.messages.length,1);
  assert.equal(resultState.progress.levels.later,undefined);
  assert.match(prompt(),/Only context\.level identifies the active level/);
  assert.equal(context().level.id,'result');
  assert.equal(context().level.statement_number,'1.3');
  assert.equal(context().level.structural_path,'1.2');
  assert.deepEqual(context().supporting_levels.map(({id,text})=>[id,text]),[['previous','Prerequisite identity']]);
  assert.deepEqual(context().manuscript,[]);
  assert.equal(context().other_level_conversations,undefined);
  assert(!prompt().includes('Future convention'));
  await f.act('message',{message:'Where is this used?'});
  assert.equal(context().manuscript[0].text,'Synthetic source');
  assert(context().other_level_conversations.previous);
});

test('anonymous map and prefetch require neither key nor network',async()=>{
 let prompts=0;const f=await setup({onMissingKey:()=>prompts++});
 assert.equal((await f.engine.request('/api/game')).level_status.result,'open');await f.act('prefetch');assert.equal(f.calls.length,0);assert.equal(prompts,0);
 await assert.rejects(f.act('start'),/API key/);assert.equal(prompts,1);assert.equal((await f.engine.request('/api/game')).progress.revision,0);
});
test('key goes only to official API; exports, payloads and manual saves exclude it',async()=>{
 const f=await setup();f.engine.setKey('synthetic-key-never-a-real-credential');await f.act('start');
 assert.equal(f.calls[0].url,'https://api.deepseek.com/chat/completions');assert.equal(f.calls[0].options.redirect,'error');assert.equal(f.calls[0].options.credentials,'omit');
 assert.equal(f.calls[0].options.headers.Authorization,'Bearer synthetic-key-never-a-real-credential');
 assert.equal(JSON.parse(f.calls[0].options.body).model,'deepseek-flash');assert.equal(JSON.parse(f.calls[0].options.body).reasoning_effort,'medium');
 await f.act('save_create');const save=await f.engine.request('/api/save/export');assert(!JSON.stringify(save).includes('synthetic-key'));assert(!JSON.stringify(await f.engine.request('/api/game')).includes('synthetic-key'));
 const restored=await setup({storage:f.storage});assert.equal((await restored.engine.request('/api/game')).progress.levels.result.messages.length,1);
 restored.engine.setKey('');assert.equal(restored.engine.hasKey(),false);assert.equal((await restored.engine.request('/api/game')).progress.levels.result.messages.length,1);
});
test('completion order, undo and snapshot validation survive browser saves',async()=>{
 const f=await setup();let result=await f.act('understand_all');assert.equal(result.level_status.proof,'open');
 result=await f.act('undo_action',{target_id:result.undo.id});assert.equal(result.level_status.proof,'locked');
 await f.act('save_create',{label:'checkpoint'});await f.act('understand_all');let saved=await f.engine.request('/api/saves');await f.act('save_load',{save_id:saved.saves[0].id});
 assert.deepEqual((await f.engine.request('/api/game')).progress.completed,[]);
 const value=await f.engine.request('/api/save/export');value.progress.game_id='wrong';await assert.rejects(f.act('save_import',{save:value}),/snapshot/);
 assert.deepEqual((await f.engine.request('/api/game')).progress.completed,[]);
});

test('a proof branches to its direct subresults while old saves keep manuscript order', async () => {
  const value = fixtureGame();
  delete value.chinese;
  const convention = (id, scope, owner, parent) => ({id, type:'convention', structural_path:scope, owner, parent, text:id});
  const statement = (id, parent) => ({id, type:'statement', paired:id+'-proof', parent, text:id});
  const proof = id => ({id:id+'-proof', type:'proof', paired:id, parent:id, text:id});
  value.levels = [
    convention('global', '1', 'root', null),
    statement('root', 'local'),
    convention('local', '2.1', 'root', 'global'),
    statement('left', 'left-setting'),
    statement('right', 'root'),
    proof('root'),
    convention('left-setting', '2.1.1', 'left', 'root'),
    proof('left'), proof('right'),
  ];
  const before = structuredClone(value);
  const expectedParents = [null, 'global', 'root', 'root-proof', 'root-proof', 'local', 'left', 'left-setting', 'right'];
  const game = await setup({game:value});
  const initial = await game.engine.request('/api/game');
  assert.deepEqual(initial.game.levels.map(level => level.parent), expectedParents);
  assert.deepEqual(value, before);

  const oldSave = await game.engine.request('/api/save/export');
  oldSave.progress.completed = ['global', 'root', 'local'];
  let state = await game.act('save_import', {save:oldSave});
  assert.deepEqual(state.progress.completed, oldSave.progress.completed);
  assert.equal(state.level_status.left, 'open');
  assert.equal(state.level_status['root-proof'], 'locked');
  assert.equal(state.level_status['left-proof'], 'locked');
  assert.equal(state.level_status.right, 'hidden');
  assert.equal(state.level_status['right-proof'], 'hidden');
  await assert.rejects(game.act('understand_all', {level_id:'root-proof'}), /locked/i);

  const replay = await setup({game:initial.game, storage:game.storage});
  state = await replay.engine.request('/api/game');
  assert.deepEqual(state.game.levels.map(level => level.parent), expectedParents);
  for (const level of value.levels.slice(3)) {
    assert.deepEqual(Object.keys(state.level_status).filter(id => state.level_status[id] === 'open'), [level.id]);
    for (const {id, parent} of state.game.levels) {
      if (parent && state.level_status[id] !== 'hidden') assert.notEqual(state.level_status[parent], 'hidden');
    }
    state = await replay.act('understand_all', {level_id:level.id});
  }
  assert.deepEqual(state.progress.completed, value.levels.map(level => level.id));
});

test('Main Results conventions follow the manuscript context across subsections', async () => {
  const value = fixtureGame();
  delete value.chinese;
  const [statement, proof] = value.levels;
  function setting(id, structural_path, parent, context) {
    return {id, type:'convention', parent, structural_path, owner:statement.id, context:context.map(id => ({id})), text:id};
  }
  value.levels = [
    setting('global', '1', null, []),
    setting('second', '1.1', 'global', ['global']),
    setting('third', '1.2', 'global', ['global', 'second']),
    {...statement, structural_path:'1.2', parent:'third', context:[{id:'global'}, {id:'second'}, {id:'third'}]},
    proof,
  ];
  const fixture = await setup({game:value});
  const state = await fixture.engine.request('/api/game');
  assert.deepEqual(state.game.levels.map(level => level.parent), [null, 'global', 'second', 'third', statement.id]);
  assert.equal(state.level_status.second, 'hidden');
  assert.equal(state.level_status.third, 'hidden');
});
test('failed DeepSeek requests and invented confirmations do not change progress',async()=>{
 for(const status of [401,402,429,500]){const f=await setup({fetcher:async()=>({ok:false,status})});f.engine.setKey('fake-key');await assert.rejects(f.act('start'));assert.equal((await f.engine.request('/api/game')).progress.revision,0);}
 const f=await setup({fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer({understanding:{kind:'confirm',scope:'level',level_id:'result',quote:'I understand',description:'all'}}))}}]})})});f.engine.setKey('fake-key');await assert.rejects(f.act('start'),/current player message/);assert.deepEqual((await f.engine.request('/api/game')).progress.completed,[]);
});

test('the passage button accepts the next lesson even if the tutor invents a whole-level confirmation', async () => {
  const invented = {kind:'confirm', scope:'level', level_id:'result', quote:'I understood this entire level.', description:'whole level'};
  let requests = 0;
  const fixture = await setup({fetcher:async () => ++requests === 1
    ? tutorReply({message:'First passage.'})
    : tutorReply({message:'Next passage.', understanding:invented})});
  fixture.engine.setKey('test-key');
  const before = await fixture.act('start');
  const result = await fixture.act('understand');
  const guide = result.progress.levels.result;
  assert.equal(requests, 2);
  assert.deepEqual(guide.messages.map(row => row.role), ['assistant', 'user', 'assistant']);
  assert.equal(guide.messages.at(-1).content, 'Next passage.');
  assert.deepEqual(guide.understanding.map(event => [event.level_id, event.scope]), [['result', 'passage']]);
  assert.deepEqual(result.progress.completed, []);
  assert.equal(result.level_status.proof, 'locked');
  assert.equal(result.undo.action, 'understand');

  await assert.rejects(fixture.act('message', {message:'Please explain.'}), /current player message/);
  const restored = await fixture.act('undo_action', {target_id:result.undo.id});
  assert.deepEqual(restored.progress.levels.result.messages, before.progress.levels.result.messages);
  assert.equal(restored.progress.levels.result.understanding?.length || 0, 0);
});

test('a passage is saved before the tutor replies and a retry after reload adds only the next explanation', async () => {
  let failNext, notifyRequested;
  const nextResponse = new Promise(resolve => { failNext = resolve; });
  const requested = new Promise(resolve => { notifyRequested = resolve; });
  let calls = 0;
  const fixture = await setup({fetcher:async () => {
    if (++calls === 1) return tutorReply({message:'First passage.'});
    notifyRequested();
    return nextResponse;
  }});
  fixture.engine.setKey('test-key');
  const before = await fixture.act('start');
  const turn = fixture.act('understand', {request_id:'confirm-passage'});
  await requested;
  const readFromAnotherTab = await setup({storage:fixture.storage});
  const pending = await readFromAnotherTab.engine.request('/api/game');
  failNext(new Response(null, {status:503}));
  await assert.rejects(turn);
  const guide = pending.progress.levels.result;
  assert.equal(guide.phase, 'awaiting_continuation');
  assert.deepEqual(guide.messages.map(row => row.role), ['assistant', 'user']);
  assert.deepEqual(guide.understanding.map(event => event.scope), ['passage']);
  assert.equal(guide.messages.at(-1).confirms, 0);
  assert.equal(pending.undo.id, 'confirm-passage');

  const restored = await setup({storage:fixture.storage});
  assert.deepEqual((await restored.engine.request('/api/game')).progress, pending.progress);
  const result = await restored.act('continue', {request_id:'retry-generation'});
  const resumed = result.progress.levels.result;
  assert.equal(resumed.phase, 'step');
  assert.deepEqual(resumed.messages.map(row => row.role), ['assistant', 'user', 'assistant']);
  assert.deepEqual(resumed.understanding, guide.understanding);
  assert.deepEqual(result.progress.completed, []);
  assert.deepEqual(result.undo, pending.undo);
  await restored.act('continue', {request_id:'retry-generation'});
  assert.equal(restored.calls.length, 1);
  const undone = await restored.act('undo_action', {target_id:result.undo.id});
  assert.deepEqual(undone.progress.levels.result.messages, before.progress.levels.result.messages);
  assert.equal(undone.progress.levels.result.understanding?.length || 0, 0);
});
test('different tabs reject stale actions and keep confirmed newer progress',async()=>{
 const storage=new MemoryStorage(),a=await setup({storage}),b=await setup({storage});const before=await b.engine.request('/api/game');await a.act('understand_all');
 await assert.rejects(b.engine.request('/api/action',{action:'understand_all',level_id:'result',expected_revision:before.progress.revision}),/Progress changed/);
 assert.deepEqual((await b.engine.request('/api/game')).progress.completed,['result']);
});
test('guide, regular chat and language state remain distinct across reload',async()=>{
 const f=await setup();f.engine.setKey('fake-key');await f.act('start');await f.act('mode',{mode:'chat'});
 await f.act('message',{mode:'chat',message:'Please explain the notation.'});await f.act('language',{language:'中文'});
 const next=await setup({storage:f.storage}),value=await next.engine.request('/api/game');assert.equal(value.progress.language,'中文');assert.equal(value.progress.levels.result.messages.length,1);assert.equal(value.progress.levels.result.chat.messages.length,2);
});
test('opening Guide from the map preserves the previous undo target', async () => {
  const fixture = await setup();
  const explicit = await fixture.act('mode', {mode: 'chat'});
  assert.equal(explicit.undo.action, 'mode');
  const navigation = await fixture.act('mode', {mode: 'guide', navigation: true});
  assert.equal(navigation.progress.levels.result.mode, 'guide');
  assert.deepEqual(navigation.undo, explicit.undo);
  assert.equal(fixture.calls.length, 0);
});
test('malformed or truncated tutor output preserves progress',async()=>{
 for(const content of ['not JSON',JSON.stringify({message:'incomplete'})]){
  const f=await setup({fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content}}]})})});f.engine.setKey('fake-key');await assert.rejects(f.act('start'));assert.equal((await f.engine.request('/api/game')).progress.revision,0);
 }
});

test('a pending reply cannot overwrite progress changed in another tab',async()=>{
 let finish;const pending=new Promise(resolve=>finish=resolve);
 const storage=new MemoryStorage(),a=await setup({storage,fetcher:async()=>{await pending;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer())}}]})};}}),b=await setup({storage});
 a.engine.setKey('fake-key');const turn=a.act('start');const rejected=assert.rejects(turn);
 await new Promise(resolve=>setImmediate(resolve));await b.act('understand_all');
 await a.engine.request('/api/game');finish();await rejected;
 assert.deepEqual((await a.engine.request('/api/game')).progress.completed,['result']);
});

test('undo cancels a pending passage without committing its late reply or starting a replacement request', async () => {
  for (const usePrefetch of [false, true]) {
    const requested = Promise.withResolvers();
    const pendingReply = Promise.withResolvers();
    let calls = 0;
    const fixture = await setup({fetcher:async (url, {signal}) => {
      calls++;
      if (calls === 1) return tutorReply({message:'First passage.'});
      if (calls > 2) return tutorReply({message:'Unwanted replacement.'});
      if (usePrefetch) {
        signal.addEventListener('abort', () => pendingReply.reject(signal.reason), {once:true});
      }
      requested.resolve();
      return pendingReply.promise;
    }});
    fixture.engine.setKey('test-key');
    const before = await fixture.act('start');
    if (usePrefetch) await fixture.act('prefetch');
    const cancelled = assert.rejects(fixture.act('understand'), /withdrawn|cancelled/i);
    await requested.promise;
    const deadline = Date.now() + 3000;
    let pending = await fixture.engine.request('/api/game');
    while (!pending.connection.busy) {
      assert.ok(Date.now() < deadline, 'The click should consume the pending prefetch');
      await new Promise(resolve => setImmediate(resolve));
      pending = await fixture.engine.request('/api/game');
    }
    const undone = await fixture.act('undo_action', {target_id:pending.undo.id});
    if (!usePrefetch) pendingReply.resolve(tutorReply({message:'Late explanation.'}));
    await cancelled;
    assert.equal(calls, 2);
    const result = await fixture.engine.request('/api/game');
    assert.deepEqual(result.progress, undone.progress);
    assert.deepEqual(result.progress.levels.result.messages, before.progress.levels.result.messages);
    assert.equal(result.progress.levels.result.phase, 'step');
    assert.equal(result.progress.levels.result.understanding?.length || 0, 0);
    assert.deepEqual(result.undo, before.undo);
  }
});

test('diagrams render and survive saves without Node globals',async()=>{
 const prior=globalThis.Buffer;delete globalThis.Buffer;
 try{
  const f=await setup({fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer({message:'',diagram:{alt:'Synthetic blue circle',elements:[{kind:'circle',color:'blue',x:100,y:100,radius:40}]}}))}}]})})});
  f.engine.setKey('fake-key');await f.act('start');
  const exported=await f.engine.request('/api/save/export');assert.match(exported.progress.levels.result.messages[0].image.svg,/<circle/);
  const restored=await setup({storage:f.storage});assert.equal((await restored.engine.request('/api/game')).progress.levels.result.messages[0].image.alt,'Synthetic blue circle');
 }finally{globalThis.Buffer=prior;}
});

test('repeated save imports use bounded, content-free action receipts',async()=>{
 const f=await setup();await f.act('understand_all');
 for(let count=0;count<5;count++){
  const exported=await f.engine.request('/api/save/export');await f.act('save_import',{save:exported});
  const current=await f.engine.request('/api/save/export');
  assert.equal(current.progress.recent_actions.length,1);assert.match(current.progress.recent_actions[0].signature,/^[a-f0-9]{64}$/);
 }
});

test('browser loader bounds parallel downloads and rejects modified manuscript files',async()=>{
 const {loadBrowserGame}=await import(moduleURL);
 const value=fixtureGame(),encoder=new TextEncoder();
 const files=new Map([['game.json',encoder.encode(JSON.stringify(value))]]);
 for(const name of Object.keys(value.snapshot_files)){
  const bytes=encoder.encode('Synthetic source');
  value.snapshot_files[name]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  files.set(name,bytes);
 }
 for(let index=0;index<9;index++)files.set('snapshot/resource-'+index+'.tex',encoder.encode('Resource '+index));
 files.set('game.json',encoder.encode(JSON.stringify(value)));
 const records={};
 for(const [name,bytes] of files)records[name]={size:bytes.length,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')};
 const manifest=encoder.encode(JSON.stringify({schema:1,launch_mode:'browser',game_id:value.id,files:records}));
 let active=0,peak=0,corrupt=false;
 const fetcher=async target=>{
  const name=new URL(target).pathname.replace('/games/paper/','');
  if(name==='proof2game.json')return new Response(manifest);
  active++;peak=Math.max(peak,active);
  await new Promise(resolve=>setImmediate(resolve));
  active--;
  return new Response(corrupt&&name==='snapshot/main.tex'?encoder.encode('changed'):files.get(name));
 };
 const engine=await loadBrowserGame({fetcher,storage:new MemoryStorage()});
 assert.equal((await engine.request('/api/game')).game.id,value.id);
 assert(peak>1&&peak<=6,'downloads must overlap within a bounded batch');
 corrupt=true;
 await assert.rejects(loadBrowserGame({fetcher,storage:new MemoryStorage()}),/game file changed/i);
});
