/* Execute the real browser controller with a small DOM and controlled local API. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),baseAssert=require('node:assert/strict');
let checks=0;const assert=new Proxy(baseAssert,{apply(target,self,args){checks++;return Reflect.apply(target,self,args);},get(target,key){const value=target[key];return typeof value==='function'?(...args)=>{checks++;return Reflect.apply(value,target,args);}:value;}});
const assets=path.resolve(__dirname,'../assets/game-runtime');
class Node{
 constructor(tag,text=''){this.tag=tag;this.children=[];this._text=text;this.dataset={};this.style={};this.attrs={};this.handlers={};this.value='';this.scrollTop=0;this.scrollLeft=0;this.clientWidth=600;this.clientHeight=400;this.scrollHeight=400;this.classList={add:()=>{},remove:()=>{}};}
 append(...nodes){for(const node of nodes){if(node instanceof Node)node.parent=this;this.children.push(node);}}
 prepend(node){node.parent=this;this.children.unshift(node);}
 replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
 get textContent(){return this._text+this.children.map(x=>x.textContent||'').join('');}
 set textContent(value){this._text=String(value);this.children=[];}
 setAttribute(key,value){this.attrs[key]=String(value);}
 addEventListener(type,fn){(this.handlers[type]??=[]).push(fn);}
 async fire(type,event={}){for(const fn of this.handlers[type]||[])await fn(event);}
 showModal(){this.open=true;}
 close(){const was=this.open;this.open=false;if(was)this.fire('close');}
 click(){return this.fire('click');}
 focus(){} setSelectionRange(){} setPointerCapture(){} releasePointerCapture(){} hasPointerCapture(){return false;}
 closest(selector){if(selector==='a.internal-reference'&&this.tag==='a'&&this.className?.includes('internal-reference'))return this;return this.parent?.closest(selector)||null;}
 getBoundingClientRect(){return {top:0};}
}
const nodes=new Map(),html=fs.readFileSync(path.join(assets,'index.html'),'utf8');
for(const match of html.matchAll(/\bid="([^"]+)"/g))nodes.set(match[1],new Node('div'));
const special=new Map(['.garden','.composer-hint','.component-scroll'].map(key=>[key,new Node('div')]));
const descendants=node=>[node,...node.children.filter(x=>x instanceof Node).flatMap(descendants)];
const document={...new Node('document'),title:'MathGrove',hidden:false,documentElement:{},createTextNode:text=>new Node('#text',text),createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),getElementById:id=>nodes.get(id)||descendants(nodes.get('level-original')).find(node=>node.id===id),querySelector:key=>special.get(key),querySelectorAll:key=>key==='[data-i18n]'?[]:key==='.level-node'?descendants(nodes.get('forest')).filter(node=>node.dataset.levelId):[]};
document.addEventListener=Node.prototype.addEventListener;document.fire=Node.prototype.fire;
let url=new URL('http://localhost/'),entries=[url.href],cursor=0;
const window=new Node('window');window.innerWidth=1200;window.location={};
function locate(value){url=new URL(value,url);for(const key of ['href','pathname','search'])window.location[key]=url[key];}
locate(url.href);
window.history={pushState:(_,__,value)=>{entries=entries.slice(0,cursor+1);entries.push(new URL(value,url).href);cursor++;locate(entries[cursor]);},replaceState:(_,__,value)=>{entries[cursor]=new URL(value,url).href;locate(entries[cursor]);},back:()=>{if(cursor){locate(entries[--cursor]);return window.fire('popstate');}},forward:()=>{if(cursor<entries.length-1){locate(entries[++cursor]);return window.fire('popstate');}}};
const game={title:'Synthetic game',levels:[{id:'convention',type:'convention',title:'Notation',section_title:'Introduction',text:'See \\ref{thm:one} and \\ref{proof:one}.',equations:[]},{id:'one',type:'statement',kind:'Lemma',statement_number:'1.1',title:'A statement',text:'An assertion.',paired:'proof',equations:[]},{id:'proof',type:'proof',kind:'Lemma',statement_number:'1.1',title:'A statement',text:'An argument.',paired:'one',equations:[]}],internal_references:{'thm:one':{level_id:'one',kind:'statement',name:'Lemma',number:'1.1'},'proof:one':{level_id:'proof',kind:'section',name:'Section',number:'2.1'}}};
const progress={language:null,revision:1,completed:['convention'],levels:{convention:{messages:[],chat:{messages:[]}},one:{messages:[],chat:{messages:[]}},proof:{messages:[],chat:{messages:[]}}}};
let slowReply=null,releaseReply=null;
const calls=[],getCalls=[],saveRecords=[],savedStates=new Map();let saveIndex=0;
let statuses={convention:'complete',one:'open',proof:'locked'};
function response(){return {game,progress,saves:saveRecords,connection:{available:true,authenticated:true},level_status:statuses};}
function complete(id){if(!progress.completed.includes(id))progress.completed.push(id);statuses[id]='complete';const next=game.levels[progress.completed.length];if(next)statuses[next.id]='open';progress.revision++;}
const context={document,window,URL,URLSearchParams,crypto:{randomUUID:()=>String(calls.length+1)},requestAnimationFrame:fn=>fn(),setTimeout:()=>1,clearTimeout:()=>{},fetch:async(route,options)=>{
 if(route==='/api/saves'){getCalls.push(route);return {ok:true,json:async()=>structuredClone({saves:saveRecords})};}
 if(options?.body){const body=JSON.parse(options.body);calls.push(body);if(['Slow question','Slow failure'].includes(body.message)){await slowReply;if(body.message==='Slow failure')return {ok:false,status:500,json:async()=>({error:'Test response failed.'})};}
  if(body.action==='language'){progress.language=body.language;progress.revision++;}
  if(body.action==='mode'){progress.levels[body.level_id].mode=body.mode;progress.revision++;}
  if(body.action==='start'){const level=progress.levels[body.level_id];if(!level.messages.length){level.messages.push({role:'assistant',content:'Welcome. Let us explore this level together.',step_goal:'Confirm when this passage feels clear.',phase:'step'});level.phase='step';}progress.revision++;}
  if(body.action==='understand_all')complete(body.level_id);
  if(body.action==='message'){const level=progress.levels[body.level_id],chat=body.mode==='chat'?(level.chat??={messages:[]}):level;chat.messages.push({role:'user',content:body.message},{role:'assistant',content:'Your understanding is noted.',phase:'step'});if(body.message==='I understand this whole level.')complete(body.level_id);else progress.revision++;}
  if(body.action==='save_create'){const id='save-'+(++saveIndex);savedStates.set(id,structuredClone({progress,statuses}));saveRecords.unshift({id,label:'Progress '+saveIndex,created_at:'2026-11-01T10:00:0'+saveIndex+'Z',completed_count:progress.completed.length});progress.revision++;}
  if(body.action==='save_load'){const previous=savedStates.get(body.save_id),revision=progress.revision+1;Object.assign(progress,structuredClone(previous.progress));progress.revision=revision;statuses=structuredClone(previous.statuses);}
  if(body.action==='save_delete'){const index=saveRecords.findIndex(item=>item.id===body.save_id);saveRecords.splice(index,1);savedStates.delete(body.save_id);progress.revision++;}
  if(body.action==='save_import'){if(!body.save?.progress)return {ok:false,json:async()=>({error:'Save does not match this game snapshot.'})};const revision=progress.revision+1;Object.assign(progress,structuredClone(body.save.progress));progress.revision=revision;statuses=structuredClone(body.save.statuses);}
 }
 return {ok:true,json:async()=>structuredClone(response())};
}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(assets,'app.js'),'utf8'),context);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 await settle();assert.equal(nodes.get('level-dialog').open,false);
 assert.equal(document.documentElement.lang,'en');assert.equal(document.title,'MathGrove');
 assert(!nodes.has('language-dialog'));assert(!nodes.has('language-open'));
 assert(nodes.get('forest').children.length>0,'main map renders without any entry action');
 assert.equal(calls.length,0,'loading the map does not select a language or start a lesson');
 assert.equal(nodes.get('language-map').hidden,true,'legacy packages have no language selector');
 const cardTitle=id=>descendants(nodes.get('forest')).find(node=>node.dataset.levelId===id).children.find(node=>node.className==='node-title');
 const conventionCard=descendants(nodes.get('forest')).find(node=>node.dataset.levelId==='convention');
 assert.equal(cardTitle('convention').textContent,'Convention');
 assert.equal(cardTitle('convention').children.length,1,'convention has no section subtitle');
 assert(!conventionCard.attrs['aria-label'].includes('Notation'));
 assert(!conventionCard.attrs['aria-label'].includes('Introduction'));
 assert.equal(cardTitle('one').children.length,2,'statement retains its two-tier title');
 assert.equal(cardTitle('one').textContent,'Lemma 1.1A statement');
 game.levels[0].title='Main Results';game.levels[0].section_title='Main Results';
 progress.language='中文';await nodes.get('connection-check').fire('click');await settle();
 assert.equal(document.documentElement.lang,'en');assert.equal(document.title,'MathGrove');
 assert(calls.every(call=>call.action!=='language'));calls.length=0;
 assert.equal(cardTitle('convention').textContent,'Convention','different source names do not change the card label');

 progress.language='English';
 game.chinese={title:'双语游戏',levels:{convention:{title:'',text:'参见\\autoref{thm:one}。'},one:{title:'一个陈述',text:'中文陈述。'},proof:{title:'一个陈述',text:'中文证明。'}}};
 await nodes.get('connection-check').fire('click');await settle();calls.length=0;
 assert.equal(nodes.get('language-map').hidden,false);
 nodes.get('language-map').value='中文';await nodes.get('language-map').fire('change');await settle();
 assert.equal(calls[0].action,'language');assert.equal(document.documentElement.lang,'zh-CN');
 assert.equal(document.title,'MathGrove');
 assert.equal(cardTitle('convention').textContent,'约定');
 assert.equal(cardTitle('one').textContent,'引理 1.1一个陈述');
 assert.equal(nodes.get('progress-count').textContent,'1 / 3');
 await nodes.get('next-level').fire('click');await settle();
 assert.equal(nodes.get('level-original').textContent,'中文陈述。');
 assert.equal(nodes.get('language-level').value,'中文');
 assert(nodes.get('messages').textContent.includes('Welcome.'));
 nodes.get('language-level').value='English';await nodes.get('language-level').fire('change');await settle();
 assert.equal(nodes.get('level-original').textContent,'An assertion.');
 assert(nodes.get('messages').textContent.includes('Welcome.'));
 assert.equal(window.location.search,'?level=one');
 await nodes.get('close-level').fire('click');await settle();
 progress.levels.one.messages=[];progress.levels.one.phase=null;
 delete game.chinese;
 await nodes.get('connection-check').fire('click');await settle();calls.length=0;

 await nodes.get('next-level').fire('click');await settle();
 assert.equal(window.location.search,'?level=one');assert.equal(nodes.get('level-dialog').open,true);assert.equal(nodes.get('mode-guide').attrs['aria-pressed'],'true');assert.equal(calls.length,1,'fresh guide starts its opening once');assert.equal(calls[0].action,'start');assert(nodes.get('messages').textContent.includes('Welcome.'));calls.length=0;
 await nodes.get('close-level').fire('click');await settle();assert.equal(window.location.search,'');
 await window.history.back();await settle();assert.equal(window.location.search,'?level=one');assert.equal(nodes.get('level-dialog').open,true);
 await window.history.back();await settle();assert.equal(window.location.search,'');assert.equal(nodes.get('level-dialog').open,false);
 window.history.pushState(null,'','/?level=convention');await window.fire('popstate');await settle();
 const links=descendants(nodes.get('level-original')).filter(node=>node.tag==='a');assert.equal(links.length,1,'locked proof must not be a link');assert(nodes.get('level-original').textContent.includes('Locked'));
 await document.fire('click',{target:links[0],button:0,preventDefault:()=>{}});await settle();assert.equal(window.location.search,'?level=one&ref=thm%3Aone');assert(nodes.get('level-title').textContent.includes('Lemma 1.1'));
 // Browser Back may run even while the in-page controls are disabled. Apply its latest location after the turn settles.
 const composer=nodes.get('chat-input'),form=nodes.get('chat-form');
 let submitCount=0;
 form.requestSubmit=()=>{submitCount++;};
 const enter=async extra=>{const event={key:'Enter',preventDefault(){this.suppressed=true;},...extra};await composer.fire('keydown',event);return event;};
 await composer.fire('compositionstart');composer.value='abc';
 assert.equal((await enter({})).suppressed,undefined,'Pinyin must receive its Enter');
 await composer.fire('compositionend');
 assert.equal((await enter({isComposing:false})).suppressed,undefined,'Safari commit can follow compositionend');
 await composer.fire('keyup',{key:'Enter'});
 assert.equal((await enter({keyCode:229})).suppressed,undefined,'IME sentinel remains safe');
 assert.equal((await enter({isComposing:true})).suppressed,undefined,'native composing event remains safe');
 await enter({shiftKey:true});await enter({repeat:true});
 assert.equal(submitCount,0);
 assert.equal(composer.value,'abc');
 assert.equal((await enter({})).suppressed,true);
 assert.equal(submitCount,1,'a separate deliberate Enter still submits');
 composer.value='';
 slowReply=new Promise(resolve=>releaseReply=resolve);nodes.get('chat-input').value='Slow question';
 const pendingQuestion=nodes.get('chat-form').fire('submit',{preventDefault:()=>{}});await settle();
 assert.equal(nodes.get('level-back').disabled,true);assert.equal(nodes.get('chat-input').disabled,true);
 await window.history.back();await settle();
 assert.equal(window.location.search,'?level=convention');assert(nodes.get('level-title').textContent.includes('Lemma 1.1'),'the pending response still belongs to the source level');
 releaseReply();await pendingQuestion;await settle();
 assert.equal(window.location.search,'?level=convention');assert.equal(nodes.get('level-title').textContent,'Convention','settling the turn applies the queued history destination');
 assert.equal(nodes.get('chat-input').disabled,false);nodes.get('chat-input').value='Question about this convention';
 await nodes.get('chat-form').fire('submit',{preventDefault:()=>{}});await settle();
 assert.equal(calls.at(-1).level_id,'convention','next input targets the displayed history destination');
 await window.history.forward();await settle();assert(nodes.get('level-title').textContent.includes('Lemma 1.1'));
 assert.equal(nodes.get('chat-input').value,'','successfully sent question is not restored as an unsent draft');
 // Multiple browser history changes retain only the latest destination; failed turns also release queued navigation.
 slowReply=new Promise(resolve=>releaseReply=resolve);nodes.get('chat-input').value='Slow failure';
 const failedQuestion=nodes.get('chat-form').fire('submit',{preventDefault:()=>{}});await settle();
 await window.history.back();await window.history.back();await window.history.forward();await settle();
 assert.equal(window.location.search,'?level=convention');releaseReply();await failedQuestion;await settle();
 assert.equal(nodes.get('level-title').textContent,'Convention');assert.equal(nodes.get('chat-input').disabled,false);
 await window.history.forward();await settle();assert(nodes.get('level-title').textContent.includes('Lemma 1.1'));
 assert.equal(nodes.get('chat-input').value,'Slow failure','failed question remains editable on its own level');
 locate('/?level=proof');await window.fire('popstate');await settle();assert.equal(nodes.get('level-dialog').open,false,'direct locked URL cannot show a level');assert(nodes.get('global-error').textContent.includes('locked'));
 // Start from the first canonical component on an empty map.
 locate('/');await window.fire('popstate');await settle();
 game.levels.unshift({id:'entry',type:'convention',title:'Convention',text:'A fixed notation.',parent:null,paired:null,equations:[]});
 progress.completed=[];progress.levels.entry={messages:[],chat:{messages:[]}};
 statuses={entry:'open',convention:'hidden',one:'hidden',proof:'hidden'};
 await nodes.get('connection-check').fire('click');await settle();calls.length=0;
 assert(!nodes.has('game-authors'));
 assert.equal(document.title,'MathGrove');
 assert.equal(cardTitle('entry').textContent,'Convention');
 assert.equal(cardTitle('entry').children.length,1,'Convention has no redundant subtitle');
 await nodes.get('next-level').fire('click');await settle();
 assert.equal(window.location.search,'?level=entry');
 assert.equal(nodes.get('level-original').textContent,'A fixed notation.');
 assert.equal(nodes.get('mode-guide').attrs['aria-pressed'],'true');
 assert.equal(calls.length,1,'Convention defaults to the guide');assert.equal(calls[0].action,'start');calls.length=0;
 assert.equal(nodes.get('understand-all').textContent,'I understand this convention');
 nodes.get('chat-input').value='I understand this whole level.';
 await nodes.get('chat-form').fire('submit',{preventDefault:()=>{}});await settle();
 assert(calls.some(call=>call.action==='message'),'text confirmation is sent as a normal player message');

 assert.equal(window.location.search,'');assert.equal(nodes.get('level-dialog').open,false);
 assert.equal(progress.completed[0],'entry');assert.equal(statuses.convention,'open');
 // Revisit does not replay the opener; an already-completed follow-up stays in the level.
 locate('/?level=entry');await window.fire('popstate');await settle();calls.length=0;
 nodes.get('chat-input').value='Please explain this notation again.';
 await nodes.get('chat-form').fire('submit',{preventDefault:()=>{}});await settle();
 assert.equal(nodes.get('level-dialog').open,true,'completed follow-up does not force the player back to the map');
 assert(!calls.some(call=>call.action==='start'),'saved guide history is not restarted on revisit');
 const image={alt:'An arrow from x to y.',svg:'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L5 5"/></svg>'};
 progress.levels['entry'].messages.push({role:'assistant',content:'',image,step_goal:'Do you understand this step?',phase:'step'});
 await nodes.get('connection-check').fire('click');await settle();
 await nodes.get('close-level').fire('click');await settle();
 locate('/?level=entry');await window.fire('popstate');await settle();
 const illustrated=nodes.get('messages').children.filter(article=>descendants(article).some(node=>node.tag==='img'));
 assert.equal(illustrated.length,1);
 const picture=illustrated[0].children.find(node=>node.tag==='img');
 assert.equal(picture.alt,image.alt);
 assert.equal(decodeURIComponent(picture.src.split(',')[1]),image.svg);
 assert(!illustrated[0].children.some(node=>node.className?.startsWith('message-body')));
 assert(illustrated[0].textContent.includes('Do you understand this step?'));
 await nodes.get('mode-chat').fire('click');await settle();assert.equal(nodes.get('mode-chat').attrs['aria-pressed'],'true');
 assert(!descendants(nodes.get('messages')).some(node=>node.tag==='img'));
 await nodes.get('close-level').fire('click');await settle();locate('/?level=convention');await window.fire('popstate');await settle();assert.equal(nodes.get('mode-guide').attrs['aria-pressed'],'true','a prior level chat choice cannot change a fresh level default');
 await nodes.get('close-level').fire('click');await settle();locate('/?level=entry');await window.fire('popstate');await settle();assert.equal(nodes.get('mode-chat').attrs['aria-pressed'],'true','each saved mode is remembered');
 // Every click creates a separate checkpoint and exposes per-record operations.
 await nodes.get('save-game-level').fire('click');await settle();
 await nodes.get('save-game-level').fire('click');await settle();
 assert.equal(saveRecords.length,2);assert(nodes.get('level-save-status').textContent.includes('2 manual saves'));
 await nodes.get('open-saves-level').fire('click');await settle();assert.equal(nodes.get('save-dialog').open,true);assert(getCalls.includes('/api/saves'));
 const saveRows=()=>nodes.get('save-list').children.filter(row=>row.className==='save-record');
 assert.equal(saveRows().length,2);
 const saveAction=(row,name)=>descendants(row).find(node=>node.textContent===name&&['button','a'].includes(node.tag));
 assert.equal(saveAction(saveRows()[0],'Download').href,'/api/saves/save-2/download');
 assert.equal(saveAction(saveRows()[1],'Download').href,'/api/saves/save-1/download');
 // A checkpoint restore closes the active level and replaces newer conversation, without deleting checkpoints.
 progress.levels['entry'].chat.messages.push({role:'user',content:'After the checkpoint'});
 await saveAction(saveRows()[1],'Load').fire('click');await settle();
 assert.equal(nodes.get('save-dialog').open,false);assert.equal(nodes.get('level-dialog').open,false);assert.equal(window.location.search,'');
 assert(!progress.levels['entry'].chat.messages.some(m=>m.content==='After the checkpoint'));
 assert.equal(saveRecords.length,2,'restoring progress does not replace the independent manual-save catalog');
 await nodes.get('open-saves').fire('click');await settle();
 const beforeDelete=JSON.stringify(progress);
 await saveAction(saveRows()[0],'Delete').fire('click');await settle();
 assert.equal(saveRecords.length,1);assert.equal(JSON.stringify({...progress,revision:0}),JSON.stringify({...JSON.parse(beforeDelete),revision:0}),'deleting checkpoint leaves current play state unchanged');
 // Upload is parsed locally and restores via the existing state action; bad files do not mutate the game.
 const uploaded=structuredClone({progress,statuses});uploaded.progress.levels['entry'].chat.messages.push({role:'user',content:'Imported conversation'});
 nodes.get('save-upload').files=[{size:100,text:async()=>JSON.stringify(uploaded)}];
 await nodes.get('save-upload').fire('change');await settle();
 assert(calls.some(call=>call.action==='save_import'));assert.equal(nodes.get('save-dialog').open,false);assert(progress.levels['entry'].chat.messages.some(m=>m.content==='Imported conversation'));
 await nodes.get('open-saves').fire('click');await settle();const beforeBad=JSON.stringify(progress);
 nodes.get('save-upload').files=[{size:10,text:async()=>'{invalid'}];await nodes.get('save-upload').fire('change');await settle();assert(nodes.get('save-error').textContent.includes('valid JSON'));assert.equal(JSON.stringify(progress),beforeBad);
 nodes.get('save-upload').files=[{size:17*1024*1024,text:async()=>{throw Error('should not read large file');}}];await nodes.get('save-upload').fire('change');await settle();assert(nodes.get('save-error').textContent.includes('16 MB'));assert.equal(JSON.stringify(progress),beforeBad);
 nodes.get('save-upload').files=[{size:10,text:async()=>JSON.stringify({wrong:true})}];await nodes.get('save-upload').fire('change');await settle();assert(nodes.get('save-error').textContent.includes('snapshot'));assert.equal(JSON.stringify(progress),beforeBad);
 assert(html.includes('href="/api/save/export"'));
 console.log(JSON.stringify({ok:true,navigation_checks:checks,manual_save_records:true,import_export_controls:true,live_model_calls:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
