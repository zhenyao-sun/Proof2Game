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
const answer=(extra={})=>({message:'A short explanation.',illustrations:[],step_goal:'Understand this passage',phase:'step',understanding:none,...extra});
function tutorReply(fields) {
  return Response.json({choices:[{finish_reason:'stop', message:{content:JSON.stringify(answer(fields))}}]});
}
async function setup(options={}){
 const {createBrowserGame}=await import(moduleURL);const storage=options.storage||new MemoryStorage();const calls=[];
 const tutorFetch=options.fetcher||async function(url,options){calls.push({url,options});const result=answer();if(JSON.parse(options.body).messages[0].content[0].text.startsWith('Respond to')){delete result.phase;delete result.step_goal;}return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})};};
 const verificationCalls = [];
 const fetcher = async (url, init) => {
   const body = init?.body ? JSON.parse(init.body) : {};
   const service = body.messages?.[0]?.content === 'Reply with OK.' ? 'deepseek'
     : body.input?.messages?.[0]?.content?.[0]?.text === 'A single blue dot on a white background.' ? 'bailian' : null;
   if (!service) return tutorFetch(url,init);
   verificationCalls.push({service,url,init});
   const response = await options.verify?.(service,init);
   if (response) return response;
   const data = service === 'deepseek' ? {choices:[{message:{content:'OK'}}]}
     : {output:{choices:[{message:{content:[{image:'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/test.png'}]}}]}};
   return {ok:true,json:async()=>data};
 };
 const engine=createBrowserGame(options.game||fixtureGame(),[{file:'snapshot/main.tex',text:'Synthetic source'}],{storage,fetcher,onMissingKey:options.onMissingKey});
 if(options.authenticated!==false){
   for(const [provider,key] of [['deepseek','synthetic-key-never-a-real-credential'],['bailian','synthetic-key-for-images']]){
     if(engine.connection().providers[provider].state==='missing')engine.setKey(provider,key);
     await engine.verifyKey(provider);
   }
 }
 async function act(action,extras={}){const value=await engine.request('/api/game');return engine.request('/api/action',{action,level_id:'result',mode:'guide',expected_revision:value.progress.revision,request_id:crypto.randomUUID(),...extras});}
 return {engine,storage,calls,verificationCalls,act};
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
 let prompts=0;const f=await setup({authenticated:false,onMissingKey:()=>prompts++});
 assert.equal((await f.engine.request('/api/game')).level_status.result,'open');await f.act('prefetch');assert.equal(f.calls.length,0);assert.equal(prompts,0);
 await assert.rejects(f.act('start'),/API key/);assert.equal(prompts,1);assert.equal((await f.engine.request('/api/game')).progress.revision,0);
});
test('key goes only to official API; exports, payloads and manual saves exclude it',async()=>{
 const f=await setup(); await f.act('start');
 assert.equal(f.calls[0].url,'https://api.deepseek.com/chat/completions');assert.equal(f.calls[0].options.redirect,'error');assert.equal(f.calls[0].options.credentials,'omit');
 assert.equal(f.calls[0].options.headers.Authorization,'Bearer synthetic-key-never-a-real-credential');
 assert.equal(JSON.parse(f.calls[0].options.body).model,'deepseek-flash');assert.equal(JSON.parse(f.calls[0].options.body).reasoning_effort,'medium');
 await f.act('save_create');const save=await f.engine.request('/api/save/export');assert(!JSON.stringify(save).includes('synthetic-key'));assert(!JSON.stringify(await f.engine.request('/api/game')).includes('synthetic-key'));
 const restored=await setup({storage:f.storage});assert.equal((await restored.engine.request('/api/game')).progress.levels.result.messages.length,1);
 restored.engine.setKey('deepseek','');assert.equal(restored.engine.connection().providers.deepseek.state,'missing');assert.equal((await restored.engine.request('/api/game')).progress.levels.result.messages.length,1);
});
test('each key is checked against its own model and successful checks survive reopening',async()=>{
  const wait = Promise.withResolvers();
  let delayed = true;
  const f = await setup({authenticated:false,verify:service => service === 'bailian' && delayed ? wait.promise : undefined});
  f.engine.setKey('bailian','fixture-drawing-key');
  const first = f.engine.verifyKey('bailian'), second = f.engine.verifyKey('bailian');
  assert.equal(f.engine.connection().providers.bailian.state,'verifying');
  await assert.rejects(f.act('understand_all'),/both API keys/);
  wait.resolve(); await Promise.all([first,second]); delayed = false;
  assert.deepEqual(f.verificationCalls.map(item=>item.service),['bailian']);
  assert.equal(f.engine.connection().authenticated,false);
  f.engine.setKey('deepseek','fixture-tutor-key');
  await assert.rejects(f.act('start'),/both API keys/);
  await f.engine.verifyKey('deepseek');
  assert.equal(f.engine.connection().authenticated,true);
  for (const call of f.verificationCalls) {
    assert.equal(new URL(call.url).hostname,call.service==='bailian'?'dashscope.aliyuncs.com':'api.deepseek.com');
    assert.equal(call.init.headers.Authorization,'Bearer '+(call.service==='bailian'?'fixture-drawing-key':'fixture-tutor-key'));
    assert.equal(call.init.credentials,'omit');
    assert.equal(call.init.redirect,'error');
    assert.equal(JSON.parse(call.init.body).model,call.service==='bailian'?'z-image-turbo':'deepseek-flash');
  }
  const restored=await setup({storage:f.storage});
  assert.equal(restored.verificationCalls.length,0);
  assert.equal(restored.engine.connection().authenticated,true);
  restored.engine.setKey('bailian','replacement-key');
  assert.deepEqual(Object.values(restored.engine.connection().providers).map(p=>p.state),['verified','unverified']);
  await restored.engine.verifyKey('bailian');
  assert.deepEqual(restored.verificationCalls.map(c=>c.service),['bailian']);
  restored.engine.setKey('bailian','');
  assert.equal(restored.engine.connection().providers.bailian.state,'missing');
  const exported=JSON.stringify(await restored.engine.request('/api/save/export'));
  for (const value of ['fixture-drawing-key','fixture-tutor-key','replacement-key','test.png'])assert(!exported.includes(value));
});
test('explicit revalidation calls just the selected service and a rejection removes its previous success',async()=>{
  let expired=false;
  const f=await setup({verify:service=>expired && service==='deepseek' ? new Response(null,{status:401}) : undefined});
  expired=true;
  await assert.rejects(f.engine.verifyKey('deepseek',{force:true}));
  assert.deepEqual(f.verificationCalls.map(c=>c.service),['deepseek','bailian','deepseek']);
  assert.equal(f.engine.connection().providers.deepseek.state,'invalid_key');
  assert.equal(f.engine.connection().providers.bailian.state,'verified');
  await assert.rejects(f.act('understand_all'),/both API keys/);
});
test('a late verification response cannot approve a replacement or resurrect a cleared key',async()=>{
  for (const replacement of ['another-key','']) {
    const wait = Promise.withResolvers();
    const f = await setup({authenticated:false,verify:()=>wait.promise});
    f.engine.setKey('deepseek','old-key');
    const pending=f.engine.verifyKey('deepseek');
    f.engine.setKey('deepseek',replacement);
    wait.resolve(); await pending;
    assert.equal(f.engine.connection().providers.deepseek.state,replacement?'unverified':'missing');
  }
});
test('a rejected tutor key pauses the original question and resumes it once after successful verification',async()=>{
  const interrupted=Promise.withResolvers();
  let rejectVerification=false;
  const keys=[];
  const f=await setup({
    onMissingKey:reason=>interrupted.resolve(reason),
    verify:service=>service==='deepseek'&&rejectVerification ? new Response(null,{status:401}) : undefined,
    fetcher:async (url,options)=>{
      keys.push(options.headers.Authorization);
      if(keys.length===1)return new Response(null,{status:401});
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({message:'Confirmed receipt.',illustrations:[],understanding:none})}}]});
    }
  });
  await f.act('mode',{mode:'chat'});
  const pending=f.act('message',{mode:'chat',message:'Explain this formula.'});
  assert.equal((await interrupted.promise).connection.providers.deepseek.state,'invalid_key');
  assert.equal((await f.engine.request('/api/game')).pending_message.message,'Explain this formula.');
  f.engine.setKey('deepseek','new-key');
  rejectVerification=true;
  await assert.rejects(f.engine.verifyKey('deepseek'));
  assert.equal(f.engine.connection().providers.bailian.state,'verified');
  assert.equal(keys.length,1);
  rejectVerification=false;
  await f.engine.verifyKey('deepseek');
  const result=await pending;
  assert.deepEqual(keys,['Bearer synthetic-key-never-a-real-credential','Bearer new-key']);
  assert.deepEqual(result.progress.levels.result.chat.messages.map(row=>row.content),['Explain this formula.','Confirmed receipt.']);
  assert.deepEqual(f.verificationCalls.map(call=>call.service),['deepseek','bailian','deepseek','deepseek']);
});
test('completion order, undo and snapshot validation survive browser saves',async()=>{
 const f=await setup();let result=await f.act('understand_all');assert.equal(result.level_status.proof,'open');
 result=await f.act('undo_action',{target_id:result.undo.id});assert.equal(result.level_status.proof,'hidden');
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
  assert.equal(state.level_status['root-proof'], 'hidden');
  assert.equal(state.level_status['left-proof'], 'hidden');
  assert.equal(state.level_status.right, 'hidden');
  assert.equal(state.level_status['right-proof'], 'hidden');
  await assert.rejects(game.act('understand_all', {level_id:'root-proof'}), /locked/i);

  const replay = await setup({game:initial.game, storage:game.storage});
  state = await replay.engine.request('/api/game');
  assert.deepEqual(state.game.levels.map(level => level.parent), expectedParents);
  for (const level of value.levels.slice(3)) {
    assert.deepEqual(Object.keys(state.level_status).filter(id => state.level_status[id] === 'open'), [level.id]);
    for (const future of value.levels.slice(value.levels.indexOf(level) + 1)) {
      assert.equal(state.level_status[future.id], 'hidden');
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
 for(const status of [402,429,500]){const f=await setup({fetcher:async()=>({ok:false,status})}); await assert.rejects(f.act('start'));assert.equal((await f.engine.request('/api/game')).progress.revision,0);}
 const f=await setup({fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer({understanding:{kind:'confirm',scope:'level',level_id:'result',quote:'I understand',description:'all'}}))}}]})})}); await assert.rejects(f.act('start'),/current player message/);assert.deepEqual((await f.engine.request('/api/game')).progress.completed,[]);
});

test('the passage button accepts the next lesson even if the tutor invents a whole-level confirmation', async () => {
  const invented = {kind:'confirm', scope:'level', level_id:'result', quote:'I understood this entire level.', description:'whole level'};
  let requests = 0;
  const fixture = await setup({fetcher:async () => ++requests === 1
    ? tutorReply({message:'First passage.'})
    : tutorReply({message:'Next passage.', understanding:invented})});
  const before = await fixture.act('start');
  const result = await fixture.act('understand');
  const guide = result.progress.levels.result;
  assert.equal(requests, 2);
  assert.deepEqual(guide.messages.map(row => row.role), ['assistant', 'user', 'assistant']);
  assert.equal(guide.messages.at(-1).content, 'Next passage.');
  assert.deepEqual(guide.understanding.map(event => [event.level_id, event.scope]), [['result', 'passage']]);
  assert.deepEqual(result.progress.completed, []);
  assert.equal(result.level_status.proof, 'hidden');
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
 const f=await setup(); await f.act('start');await f.act('mode',{mode:'chat'});
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
  const f=await setup({fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content}}]})})}); await assert.rejects(f.act('start'));assert.equal((await f.engine.request('/api/game')).progress.revision,0);
 }
});

test('a pending reply cannot overwrite progress changed in another tab',async()=>{
 let finish;const pending=new Promise(resolve=>finish=resolve);
 const storage=new MemoryStorage(),a=await setup({storage,fetcher:async()=>{await pending;return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer())}}]})};}}),b=await setup({storage});
 const turn=a.act('start');const rejected=assert.rejects(turn);
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

const testImage='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9cAAAAASUVORK5CYII=';
const resultUrl='https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/candidate.png';
function drawReply(number){
  return Response.json({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,reasoning_content:'provider context',
    tool_calls:[{id:'call-'+number,type:'function',function:{name:'draw_math_illustration',arguments:JSON.stringify({topic:'A unit circle',prompt:'Draw circle '+number})}}]}}]});
}
function imageReply(){return Response.json({output:{choices:[{message:{content:[{image:resultUrl}]}}]}});}

test('Bailian downloads the generated PNG with a Safari-compatible fetch receiver',async()=>{
  const {generateBailianImage}=await import(new URL('illustration-tools.mjs',moduleURL));
  const requests=[];
  async function nativeFetch(url,init){
    'use strict';
    if(this!==undefined && this!==globalThis)throw new TypeError('Can only call Window.fetch on instances of Window');
    requests.push(url);
    if(init.method==='POST')return imageReply();
    assert.equal(init.headers,undefined);
    return new Response(Buffer.from(testImage,'base64'));
  }
  const image=await generateBailianImage({fetcher:nativeFetch,key:'fixture',signal:new AbortController().signal,prompt:'Draw a circle.'});
  assert.deepEqual(requests,['https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',resultUrl]);
  assert.equal(image,'data:image/png;base64,'+testImage);
});

test('prefetch only plans, actual review receives image bytes, and selected placements survive export',async()=>{
  let deep=0,draws=0,downloads=0;const drawsWhenPaused=[];
  const f=await setup({onMissingKey:()=>drawsWhenPaused.push(draws),fetcher:async(url,options)=>{
    if(url===resultUrl){
      downloads++;
      assert.equal(options.headers,undefined);
      return new Response(Uint8Array.from(atob(testImage),c=>c.charCodeAt(0)));
    }
    const body=JSON.parse(options.body);
    if(url.startsWith('https://dashscope.')){
      assert.equal(body.model,'z-image-turbo');assert.equal(body.input.messages.length,1);
      const prompt=body.input.messages[0].content[0].text;assert.match(prompt,/^Draw circle [123]$/);
      draws++;
      if(draws===1)return Response.json({code:'Throttling'},{status:429,headers:{'Retry-After':'0'}});
      if(draws===3)return Response.json({code:'Arrearage'},{status:400});
      return imageReply();
    }
    assert.equal(url,'https://api.deepseek.com/chat/completions');
    const reviewed=body.messages.filter(m=>m.role==='tool');
    assert.equal(reviewed.length,deep++);
    for(const tool of reviewed)assert.equal(tool.content[1].image_url.url,'data:image/png;base64,'+testImage);
    if(reviewed.length<3){assert.equal(body.tools[0].function.name,'draw_math_illustration');return drawReply(reviewed.length+1);}
    assert.equal(body.tools,undefined);
    return tutorReply({message:'First relation.\n\nSecond relation.',illustrations:[
      {candidate:3,after_paragraph:1,alt:'Third diagram'},{candidate:1,after_paragraph:0,alt:'First diagram'}]});
  }});
  await f.act('prefetch');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(deep,1);assert.equal(draws,0);
  const pending=f.act('start');
  for(let i=0;i<100&&!drawsWhenPaused.length;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(drawsWhenPaused,[3]);
  await f.engine.verifyKey('bailian');
  const state=await pending,reply=state.progress.levels.result.messages[0];
  assert.equal(draws,5);assert.equal(downloads,3);assert.equal(deep,4);
  assert.deepEqual(reply.images.map(x=>[x.after_paragraph,x.alt]),[[0,'First diagram'],[1,'Third diagram']]);
  const save=await f.engine.request('/api/save/export');
  assert(!JSON.stringify(save).includes(resultUrl));assert(!JSON.stringify(save).includes('provider context'));
  const restored=await setup();await restored.act('save_import',{save});
  assert.deepEqual((await restored.engine.request('/api/game')).progress.levels.result.messages[0].images,reply.images);
  save.progress.levels.result.messages[0].images[0].data_url='https://example.test/unsafe';
  await assert.rejects(restored.act('save_import',{save}),/illustration/);
});

test('failed drawing retries once, text remains playable and manual retry updates just that reply',async()=>{
  let deep=0,draws=0;
  const f=await setup({fetcher:async(url,options)=>{
    if(url===resultUrl)return new Response(Uint8Array.from(atob(testImage),c=>c.charCodeAt(0)));
    if(url.startsWith('https://dashscope.')){
      if(++draws<=2)return Response.json({code:'Throttling'},{status:429,headers:{'Retry-After':'0'}});
      return imageReply();
    }
    const body=JSON.parse(options.body);deep++;
    if(!body.messages.some(m=>m.role==='tool'))return drawReply(1);
    const success=Array.isArray(body.messages.at(-1).content);
    if(!success)assert.equal(body.tools,undefined);
    if(success)return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({illustrations:[{candidate:1,after_paragraph:0,alt:'Circle'}]})}}]});
    return tutorReply({message:'Keep this passage.',illustrations:[{candidate:1,after_paragraph:0,alt:'Missing candidate'}]});
  }});
  const first=await f.act('start');
  assert.equal(first.progress.levels.result.messages[0].image_retry,true);assert.equal(draws,2);
  const updated=await f.act('retry_image',{message_index:0});
  const [reply]=updated.progress.levels.result.messages;
  assert.equal(updated.progress.levels.result.messages.length,1);
  assert.equal(reply.image_retry,undefined);assert.equal(reply.content,'Keep this passage.');assert.equal(reply.images[0].alt,'Circle');
  assert.equal(draws,3);assert.equal(deep,4);
});

test('manual retry distinguishes a failed download from a reviewed but unselected image',async()=>{
  let downloadWorks=false;
  const f=await setup({fetcher:async(url,init)=>{
    if(url===resultUrl){
      if(!downloadWorks)throw new TypeError('Load failed');
      return new Response(Buffer.from(testImage,'base64'));
    }
    if(url.startsWith('https://dashscope.'))return imageReply();
    const {messages}=JSON.parse(init.body);
    if(!messages.some(m=>m.role==='tool'))return drawReply(1);
    return tutorReply({illustrations:[]});
  }});
  const first=await f.act('start');
  const retry=()=>f.act('retry_image',{message_index:0});
  await assert.rejects(retry,/browser could not download/);
  downloadWorks=true;
  await assert.rejects(retry,/reviewed the generated images and selected none/);
  const current=await f.engine.request('/api/game');
  assert.deepEqual(current.progress,first.progress);
});

test('placement repair reuses the reviewed pixels and cannot change the lesson or the player’s progress',async()=>{
  let draws=0,corrections=0;
  const f=await setup({fetcher:async(url,init)=>{
    if(url===resultUrl)return new Response(Buffer.from(testImage,'base64'));
    if(url.startsWith('https://dashscope.')){draws++;return imageReply();}
    const {messages,tools}=JSON.parse(init.body);
    if(!messages.some(m=>m.role==='tool'))return drawReply(1);
    if(messages.at(-1).role==='user'){
      corrections++;
      assert.equal(tools,undefined);
      assert.ok(messages.some(m=>m.role==='tool' && m.content[1].image_url.url==='data:image/png;base64,'+testImage));
      return tutorReply({message:'Replacement lesson.',understanding:{kind:'confirm'},illustrations:[{candidate:1,after_paragraph:1,alt:'Two cells'}]});
    }
    return tutorReply({message:'One paragraph.',illustrations:[{candidate:7,after_paragraph:0,alt:'Nonexistent image'}]});
  }});
  const {progress}=await f.act('start');
  const reply=progress.levels.result.messages[0];
  assert.equal(draws,1);assert.equal(corrections,1);
  assert.equal(reply.content,'One paragraph.');assert.deepEqual(progress.completed,[]);
  assert.deepEqual(reply.images,[{after_paragraph:0,alt:'Two cells',data_url:'data:image/png;base64,'+testImage}]);
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
 const fetcher=async (target,options)=>{
  assert.equal(options.credentials,'same-origin','private hosting must retain same-origin authentication');
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

test('one-click saves sort by time and retain separate undoable deletion and replacement snapshots', async () => {
  const f=await setup();
  const blank=await f.engine.request('/api/save/export');
  const first=(await f.act('save_create')).saves[0];
  await f.act('understand_all');
  const second=(await f.act('save_create')).saves[0];
  const loaded=await f.act('save_load',{save_id:first.id});
  assert.deepEqual(loaded.progress.completed,[]);
  const third=(await f.act('save_create')).saves[0];
  assert.deepEqual([third,second,first].map(record=>record.completed_count),[0,1,0]);
  assert.equal(new Set([third,second,first].map(record=>record.id)).size,3);
  assert(loaded.save_recovery.id);
  const recovered=await f.act('save_recover',{recovery_id:loaded.save_recovery.id});
  assert.deepEqual(recovered.progress.completed,['result']);
  assert.equal(recovered.undo.action,'understand_all');
  const imported=await f.act('save_import',{save:blank});
  assert.deepEqual(imported.progress.completed,[]);
  const reopened=await setup({storage:f.storage});
  assert.deepEqual((await reopened.act('save_recover',{recovery_id:imported.save_recovery.id})).progress.completed,['result']);
  const deleted=await reopened.act('save_delete',{save_id:second.id});
  assert.deepEqual(deleted.saves.map(r=>r.id),[third.id,first.id]);
  const restored=await reopened.act('save_undelete',{recovery_id:deleted.save_recovery.id});
  assert.deepEqual(restored.saves,[third,second,first]);
  assert.deepEqual((await reopened.engine.request('/api/saves/'+second.id+'/download')).progress.completed,['result']);
});

test('legacy browser manual saves migrate and invalid imports preserve progress and backup state',async()=>{
  const f=await setup();
  const original=await f.engine.request('/api/save/export');
  const id=crypto.randomUUID();
  f.storage.setItem(f.engine.storageKey,JSON.stringify({progress:original.progress,saves:{[id]:original},recovery:[],generation:1}));
  const opened=await setup({storage:f.storage});
  assert.equal((await opened.engine.request('/api/saves')).saves[0].id,id);
  const before=f.storage.getItem(f.engine.storageKey);
  await assert.rejects(opened.act('save_import',{save:{...original,snapshot_digest:'another-paper'}}),/snapshot/);
  assert.equal(f.storage.getItem(f.engine.storageKey),before);
  await opened.act('save_create');
  assert.deepEqual(await opened.engine.request('/api/saves/'+id+'/download'),original);
});

test('drawing deadline, review expiry and Retry-After use available candidates without further draws',async t=>{
  const {finishIllustratedTurn,selectIllustrations}=await import(new URL('illustration-tools.mjs',moduleURL));
  const first=(await drawReply(1).json()).choices[0];
  t.mock.timers.enable({apis:['Date'],now:10_000});
  for(const scenario of ['first-sufficient','retry-after','review-timeout','budget-before-retry','no-suitable']){
    let draws=0,reviews=0;
    const report=[];
    const {answer,candidates}=await finishIllustratedTurn({
      messages:[],first,signal:new AbortController().signal,roundMs:100,
      report:(stage,topic)=>report.push([stage,topic]),
      draw:async()=>{
        draws++;
        if(scenario==='retry-after')throw Object.assign(new Error('Rate limit'),{delay:101});
        if(scenario==='budget-before-retry'&&draws===2){t.mock.timers.tick(101);throw new Error('Timed out');}
        return 'data:image/png;base64,'+testImage;
      },
      ask:async(history,allowed)=>{
        reviews++;
        if(reviews===1 && scenario==='review-timeout'){t.mock.timers.tick(100);throw new DOMException('Timed out','TimeoutError');}
        if(reviews===1 && scenario==='budget-before-retry')return first;
        if(['retry-after','budget-before-retry','review-timeout'].includes(scenario))assert.equal(allowed,false);
        const acceptable=!['retry-after','no-suitable'].includes(scenario);
        return {finish_reason:'stop',message:{content:JSON.stringify({message:'The line.',illustrations:acceptable?[{candidate:1,after_paragraph:0,alt:'Line'}]:[]})}};
      },
    });
    assert.equal(selectIllustrations(answer,candidates).length,['retry-after','no-suitable'].includes(scenario)?0:1);
    assert.equal(draws,scenario==='budget-before-retry'?2:1);
    assert.equal(report.some(([stage])=>stage==='review'),scenario!=='retry-after');
  }
});

test('public topic updates precede a regular-chat illustration without adding player messages',async()=>{
  const planning=Promise.withResolvers(),continuation=Promise.withResolvers();
  let calls=0;
  const f=await setup({fetcher:async(url,options)=>{
    if(url===resultUrl)return new Response(Uint8Array.from(atob(testImage),c=>c.charCodeAt(0)));
    if(url.startsWith('https://dashscope.'))return imageReply();
    const body=JSON.parse(options.body);
    if(++calls===1)return Response.json({choices:[{finish_reason:'tool_calls',message:{
      tool_calls:[{id:'status',type:'function',function:{name:'update_learning_topic',arguments:JSON.stringify({topic:'The normal to the tangent'})}}]}}]});
    if(calls===2){planning.resolve();await continuation.promise;return drawReply(1);}
    assert.equal(body.messages.at(-1).content[1].image_url.url,'data:image/png;base64,'+testImage);
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({message:'The normal.',understanding:none,illustrations:[{candidate:1,after_paragraph:0,alt:'Tangent and normal'}]})}}]});
  }});
  await f.act('mode',{mode:'chat'});
  const pending=f.act('message',{mode:'chat',message:'Draw the tangent and normal.'});
  await planning.promise;
  const snapshot=await f.engine.request('/api/game');
  assert.deepEqual(snapshot.pending_topic,{level_id:'result',mode:'chat',stage:'think',topic:'The normal to the tangent'});
  continuation.resolve();
  const result=await pending;
  assert.equal(result.progress.levels.result.chat.messages.length,2);
  assert.equal(result.progress.levels.result.chat.messages[1].images.length,1);
  assert.equal(result.pending_topic,null);
});

test('an invalid Bailian key resumes the same Chat drawing without duplicating the question',async()=>{
  let drawings=0,reviews=0;
  const paused=Promise.withResolvers(),requests=[];
  const f=await setup({onMissingKey:()=>paused.resolve(),fetcher:async(url,options)=>{
    if(url===resultUrl)return new Response(Uint8Array.from(atob(testImage),c=>c.charCodeAt(0)));
    if(url.startsWith('https://dashscope.')){
      requests.push(options.headers.Authorization);
      if(++drawings===2)return Response.json({code:'InvalidApiKey'},{status:401});
      return imageReply();
    }
    const body=JSON.parse(options.body),seen=body.messages.filter(m=>m.role==='tool').length;
    if(seen<2)return drawReply(++reviews);
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({message:'Both circles.',understanding:none,
      illustrations:[{candidate:1,after_paragraph:0,alt:'Original'},{candidate:2,after_paragraph:0,alt:'Additional'}]})}}]});
  }});
  await f.act('mode',{mode:'chat'});
  const pending=f.act('message',{mode:'chat',message:'Draw these circles.'});
  await paused.promise;
  const state=await f.engine.request('/api/game');
  assert.equal(state.pending_message.message,'Draw these circles.');
  f.engine.setKey('bailian','replacement-key');
  await f.engine.verifyKey('bailian');
  const messages=(await pending).progress.levels.result.chat.messages;
  assert.equal(messages.length,2);assert.equal(messages[0].content,'Draw these circles.');
  assert.equal(messages[1].images.length,2);assert.equal(drawings,3);
  assert.deepEqual(requests.slice(1),['Bearer synthetic-key-for-images','Bearer replacement-key']);
});

test('older portable SVG illustrations still import without making a model request',async()=>{
  const {renderGuideDiagram}=await import(new URL('guide-diagram.mjs',moduleURL));
  const f=await setup();
  const save=await f.engine.request('/api/save/export');
  const image=renderGuideDiagram({alt:'Existing blue circle',elements:[{kind:'circle',color:'blue',x:100,y:100,radius:40}]});
  save.progress.levels.result={messages:[{role:'assistant',content:'',image,phase:'step',step_goal:'Clear?'}],phase:'step'};
  const imported=await f.act('save_import',{save});
  assert.deepEqual(imported.progress.levels.result.messages[0].image,image);
  assert.equal(f.calls.length,0);
});

test('illustrated saves larger than the old 16 MiB limit load on a fresh device',async()=>{
  // A valid PNG with a large ancillary text chunk, independent of any image provider.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwNjYGAAE2AJp53qClAAAAAElFTkSuQmCC','base64');
  const data=Buffer.alloc(4600000,97);data.write('Comment\0');
  const chunk=Buffer.alloc(data.length+12);chunk.writeUInt32BE(data.length);chunk.write('tEXt',4);data.copy(chunk,8);
  chunk.writeUInt32BE(0x06839c66,chunk.length-4); // CRC of the tEXt type and these fixed comment bytes.
  const image='data:image/png;base64,'+Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]).toString('base64');
  const f=await setup();
  const save=await f.engine.request('/api/save/export');
  save.progress.levels.result={phase:'step',messages:[{role:'assistant',content:'First.\n\nSecond.\n\nThird.',
    images:[0,1,2].map(after_paragraph=>({data_url:image,alt:'Example '+after_paragraph,after_paragraph}))}]};
  assert(Buffer.byteLength(JSON.stringify(save))>16*1024*1024);
  await f.act('save_import',{save});
  const manual=(await f.act('save_create')).saves[0];
  const exported=await f.engine.request('/api/saves/'+manual.id+'/download');
  const second=await setup();
  const imported=await second.act('save_import',{save:exported});
  assert.deepEqual(imported.progress.levels.result.messages,save.progress.levels.result.messages);
});

test('JSON mode blank or malformed finals retry once without repeating tools',async()=>{
  const {finishIllustratedTurn}=await import(new URL('illustration-tools.mjs',moduleURL));
  for(const content of ['   ','{"message":"bad \\q"}']){
    let calls=0,draws=0;
    const result=await finishIllustratedTurn({messages:[],first:{finish_reason:'stop',message:{content}},signal:new AbortController().signal,report:()=>{},draw:()=>{draws++;},ask:async(history,tools)=>{calls++;assert.equal(tools,false);return {finish_reason:'stop',message:{content:JSON.stringify(answer())}};}});
    assert.equal(result.answer.message,'A short explanation.');assert.equal(calls,1);assert.equal(draws,0);
  }
});
test('persistent blank JSON fails with a specific error after one retry',async()=>{
  const {finishIllustratedTurn}=await import(new URL('illustration-tools.mjs',moduleURL));let calls=0;
  await assert.rejects(finishIllustratedTurn({messages:[],first:{finish_reason:'stop',message:{content:' '}},signal:new AbortController().signal,report:()=>{},ask:async()=>{calls++;return {finish_reason:'stop',message:{content:' '}};}}),/empty or invalid JSON after one retry/);assert.equal(calls,1);
});
test('JSON retry still rejects fabricated confirmation and leaves progress unchanged',async()=>{
  let calls=0;const f=await setup({fetcher:async()=>{if(++calls===1)return Response.json({choices:[{finish_reason:'stop',message:{content:' '}}]});return tutorReply({understanding:{kind:'confirm',scope:'level',description:'invented',quote:'yes',level_id:'result'}});}});
  const before=(await f.engine.request('/api/game')).progress;
  await assert.rejects(f.act('start'),/Confirmation/);assert.deepEqual((await f.engine.request('/api/game')).progress,before);
});


test('fenced JSON final replies parse without a second provider call',async()=>{
  const {finishIllustratedTurn}=await import(new URL('illustration-tools.mjs',moduleURL));
  const result=await finishIllustratedTurn({messages:[],first:{finish_reason:'stop',message:{content:'```json\n'+JSON.stringify(answer())+'\n```'}},signal:new AbortController().signal,ask:()=>{throw new Error('Unexpected retry');}});
  assert.equal(result.answer.message,'A short explanation.');
});
