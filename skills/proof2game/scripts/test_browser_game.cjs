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
async function setup(options={}){
 const {createBrowserGame}=await import(moduleURL);const storage=options.storage||new MemoryStorage();const calls=[];
 const fetcher=options.fetcher||async function(url,options){calls.push({url,options});const result=answer();if(JSON.parse(options.body).messages[0].content[0].text.startsWith('Respond to')){delete result.phase;delete result.step_goal;}return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]})};};
 const engine=createBrowserGame(fixtureGame(),[{file:'snapshot/main.tex',text:'Synthetic source'}],{storage,fetcher,onMissingKey:options.onMissingKey});
 async function act(action,extras={}){const value=await engine.request('/api/game');return engine.request('/api/action',{action,level_id:'result',mode:'guide',expected_revision:value.progress.revision,request_id:crypto.randomUUID(),...extras});}
 return {engine,storage,calls,act};
}
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
test('failed DeepSeek requests and invented confirmations do not change progress',async()=>{
 for(const status of [401,402,429,500]){const f=await setup({fetcher:async()=>({ok:false,status})});f.engine.setKey('fake-key');await assert.rejects(f.act('start'));assert.equal((await f.engine.request('/api/game')).progress.revision,0);}
 const f=await setup({fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer({understanding:{kind:'confirm',scope:'level',level_id:'result',quote:'I understand',description:'all'}}))}}]})})});f.engine.setKey('fake-key');await assert.rejects(f.act('start'),/current player message/);assert.deepEqual((await f.engine.request('/api/game')).progress.completed,[]);
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

test('diagrams render and survive saves without Node globals',async()=>{
 const prior=globalThis.Buffer;delete globalThis.Buffer;
 try{
  const f=await setup({fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(answer({message:'',diagram:{alt:'Synthetic blue circle',elements:[{kind:'circle',color:'blue',x:100,y:100,radius:40}]}}))}}]})})});
  f.engine.setKey('fake-key');await f.act('start');
  const exported=await f.engine.request('/api/save/export');assert.match(exported.progress.levels.result.messages[0].image.svg,/<circle/);
  const restored=await setup({storage:f.storage});assert.equal((await restored.engine.request('/api/game')).progress.levels.result.messages[0].image.alt,'Synthetic blue circle');
 }finally{globalThis.Buffer=prior;}
});
