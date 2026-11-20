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
 focus(){document.activeElement=this;} setSelectionRange(){} setPointerCapture(){} releasePointerCapture(){} hasPointerCapture(){return false;}
 closest(selector){if(selector==='#messages'&&this===nodes.get('messages'))return this;if(selector==='a.internal-reference'&&this.tag==='a'&&this.className?.includes('internal-reference'))return this;return this.parent?.closest(selector)||null;}
 getBoundingClientRect(){return {top:0};}
}
const nodes=new Map(),html=fs.readFileSync(path.join(assets,'index.html'),'utf8');
for(const match of html.matchAll(/\bid="([^"]+)"/g))nodes.set(match[1],new Node('div'));
const special=new Map(['.garden','.composer-hint','.component-scroll'].map(key=>[key,new Node('div')]));
const descendants=node=>[node,...node.children.filter(x=>x instanceof Node).flatMap(descendants)];
const document={...new Node('document'),title:html.match(/<title>([^<]+)<\/title>/)?.[1],hidden:false,documentElement:{},createTextNode:text=>new Node('#text',text),createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),getElementById:id=>nodes.get(id)||descendants(nodes.get('level-original')).find(node=>node.id===id),querySelector:key=>special.get(key),querySelectorAll:key=>key==='[data-i18n]'?[]:key==='.level-node'?descendants(nodes.get('forest')).filter(node=>node.dataset.levelId):[]};
document.addEventListener=Node.prototype.addEventListener;document.fire=Node.prototype.fire;
let url=new URL('http://localhost/'),entries=[{url:url.href,state:null}],cursor=0;
const window=new Node('window');window.innerWidth=1200;window.location={};
function locate(value){url=new URL(value,url);for(const key of ['href','pathname','search'])window.location[key]=url[key];}
locate(url.href);
window.history={
 get state(){return entries[cursor].state;},
 pushState(state,_,value){
  const entry={url:new URL(value,url).href,state:structuredClone(state)};
  entries=entries.slice(0,cursor+1);
  entries.push(entry);cursor++;locate(entry.url);
 },
 replaceState(state,_,value){
  entries[cursor]={url:new URL(value,url).href,state:structuredClone(state)};locate(entries[cursor].url);
 },
 back(){if(cursor){locate(entries[--cursor].url);return window.fire('popstate');}},
 forward(){if(cursor<entries.length-1){locate(entries[++cursor].url);return window.fire('popstate');}},
};
const game={title:'Synthetic game',levels:[{id:'convention',type:'convention',title:'Notation',section_title:'Introduction',text:'See \\ref{thm:one} and \\ref{proof:one}.',equations:[]},{id:'one',type:'statement',kind:'Lemma',statement_number:'1.1',title:'A statement',text:'An assertion.',paired:'proof',equations:[]},{id:'proof',type:'proof',kind:'Lemma',statement_number:'1.1',title:'A statement',text:'An argument.',paired:'one',equations:[]}],internal_references:{'thm:one':{level_id:'one',kind:'statement',name:'Lemma',number:'1.1'},'proof:one':{level_id:'proof',kind:'section',name:'Section',number:'2.1'}}};
const progress={language:null,revision:1,completed:['convention'],levels:{convention:{messages:[],chat:{messages:[]}},one:{messages:[],chat:{messages:[]}},proof:{messages:[],chat:{messages:[]}}}};
let slowReply=null,releaseReply=null;
let delayedPassage=null,passageUndo=null;
const calls=[],getCalls=[],saveRecords=[],savedStates=new Map();let saveIndex=0;
let statuses={convention:'complete',one:'open',proof:'locked'};
function response(){return {game,progress,undo:passageUndo,saves:saveRecords,connection:{available:true,authenticated:true},level_status:statuses};}
function complete(id){if(!progress.completed.includes(id))progress.completed.push(id);statuses[id]='complete';const next=game.levels[progress.completed.length];if(next)statuses[next.id]='open';progress.revision++;}
const context={document,window,URL,URLSearchParams,crypto:{randomUUID:()=>String(calls.length+1)},requestAnimationFrame:fn=>fn(),setTimeout:()=>1,clearTimeout:()=>{},fetch:async(route,options)=>{
 if(route==='/api/saves'){getCalls.push(route);return {ok:true,json:async()=>structuredClone({saves:saveRecords})};}
 if(options?.body){const body=JSON.parse(options.body);calls.push(body);if(['Slow question','Slow failure'].includes(body.message)){await slowReply;if(body.message==='Slow failure')return {ok:false,status:500,json:async()=>({error:'Test response failed.'})};}
  if(body.action==='language'){progress.language=body.language;progress.revision++;}
  if(body.action==='mode'){progress.levels[body.level_id].mode=body.mode;progress.revision++;}
  if(body.action==='start'){const level=progress.levels[body.level_id];if(!level.messages.length){level.messages.push({role:'assistant',content:'Welcome. Let us explore this level together.',step_goal:'Confirm when this passage feels clear.',phase:'step'});level.phase='step';}progress.revision++;}
  if(body.action==='understand'){
    const level=progress.levels[body.level_id];
    level.messages.push({role:'user',content:'[Understood the preceding explanatory passage]',language:progress.language});
    level.phase='awaiting_continuation';progress.revision++;
    passageUndo={id:body.request_id,action:'understand',level_id:body.level_id,mode:'guide'};
    if(delayedPassage)await delayedPassage;
    return {ok:false,status:503,json:async()=>({error:'The tutor is unavailable.'})};
  }
  if(body.action==='undo_action'){
    if(body.expected_revision!==progress.revision)return {ok:false,status:409,json:async()=>({error:'Progress changed.'})};
    assert.equal(body.target_id,passageUndo.id);
    const level=progress.levels[passageUndo.level_id];level.messages.pop();level.phase='step';
    passageUndo=null;progress.revision++;
  }
  if(body.action==='continue'){
    const level=progress.levels[body.level_id];assert.equal(level.phase,'awaiting_continuation');
    level.messages.push({role:'assistant',content:'The next passage.',phase:'step'});level.phase='step';progress.revision++;
  }
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

// Dispatch editor events to the live controller and observe actual message requests.
// Only the host IME's native editing of the textarea is supplied by the fixture.
async function exerciseChatInput(mode) {
 const input=nodes.get('chat-input'), form=nodes.get('chat-form'), send=nodes.get('send-message');
 const sent=()=>calls.filter(call=>call.action==='message' && call.mode===mode);
 const formSubmit=submitter=>form.fire('submit',{submitter,preventDefault(){}});
 form.requestSubmit=()=>formSubmit(null);
 const key=async(type,value,extra={})=>{
   const event={key:value,preventDefault(){this.defaultPrevented=true;},...extra};
   await input.fire(type,event);
   return event;
 };
 const typeMarked=async text=>{
   await input.fire('compositionstart',{data:''});
   input.value=text;
   await input.fire('input',{data:text,isComposing:true,inputType:'insertCompositionText'});
 };
 const commit=async text=>{
   input.value=text;
   await input.fire('compositionend',{data:text});
   await input.fire('input',{data:text,isComposing:false,inputType:'insertText'});
 };
 const deliberateEnter=async text=>{
   const before=sent().length;
   await key('keydown','Enter');await key('keyup','Enter');await settle();
   assert.equal(sent().length,before+1,mode+' sends precisely once on a separate Enter');
   assert.equal(sent().at(-1).message,text);
   assert.equal(input.value,'');
 };
 const oldTimeout=context.setTimeout,oldClear=context.clearTimeout;
 const timers=[];
 context.setTimeout=(fn,delay)=>{const timer=setTimeout(fn,delay);timers.push(timer);return timer;};
 context.clearTimeout=clearTimeout;
 try {
   input.focus();
   await typeMarked('pin');
   await window.fire('pageshow',{persisted:true});await settle();
   assert.equal(document.activeElement,input,mode+' keeps composer focus when progress is redrawn');
   assert.equal(input.value,'pin');
   let before=sent().length;
   // Form submission can be requested while composing, without any Enter keydown.
   assert.equal(send.disabled,true,mode+' disables Send for unfinished input');
   await formSubmit(null);
   await send.fire('pointerdown',{pointerType:'touch',preventDefault(){}});
   await input.fire('blur');
   await formSubmit(send);await settle();
   assert.equal(sent().length,before,mode+' must not submit provisional characters');
   assert.equal(input.value,'pin');

   await commit('拼音');
   // A release from an earlier composing key does not release the candidate Enter.
   await key('keyup','Shift');await key('keyup','n');
   await key('keyup','Process',{keyCode:229});
   // A later browser task can deliver the settling Enter after compositionend.
   await new Promise(resolve=>setTimeout(resolve,8));
   await formSubmit(null);await settle();
   assert.equal(sent().length,before,mode+' ignores keyboard submission while the commit is settling');
   const trailingEnter=await key('keydown','Enter',{isComposing:false});
   assert.equal(trailingEnter.defaultPrevented,true,mode+' avoids an extra newline after committing the candidate');
   await key('keyup','Enter');await settle();
   assert.equal(sent().length,before,mode+' must not submit with the candidate-confirming Enter');
   assert.equal(input.value,'拼音');
   await deliberateEnter('拼音');

   await typeMarked('raw');
   before=sent().length;
   const imeKey=await key('keydown','Enter',{isComposing:true,keyCode:229});
   assert.equal(imeKey.defaultPrevented,undefined,mode+' leaves the active Enter to the IME');
   await commit('raw');await key('keyup','Enter');await settle();
   assert.equal(sent().length,before,mode+' can commit the literal Latin input');
   await deliberateEnter('raw');

   for(const selectionKey of [' ','2']){
     await typeMarked('wen');
     await key('keydown',selectionKey,{isComposing:true,keyCode:229});
     await commit('问');
     if(selectionKey===' ')await key('keyup',selectionKey);
     await deliberateEnter('问');
     if(selectionKey!==' ')await key('keyup',selectionKey);
   }

   // WebKit can dispatch a dialog cancel for the Escape used in marked text.
   before=sent().length;
   const dialog=nodes.get('level-dialog');
   const cancelDialog=()=>dialog.fire('cancel',{preventDefault(){}});
   input.focus();
   for(const cancelBeforeEnd of [true,false]){
     await typeMarked('先前的草稿pin');
     const escape=await key('keydown','Escape',{isComposing:true});
     assert.equal(escape.defaultPrevented,undefined,mode+' leaves Escape available to the input method');
     if(cancelBeforeEnd)await cancelDialog();
     input.value='先前的草稿';
     await input.fire('compositionend',{data:''});
     if(!cancelBeforeEnd)await cancelDialog();
     await key('keyup','Escape');
     assert.equal(dialog.open,true,mode+' keeps the level open on candidate cancellation');
     assert.equal(sent().length,before);
     assert.equal(input.value,'先前的草稿');
   }
   await key('keydown','Escape');await cancelDialog();await key('keyup','Escape');
   assert.equal(dialog.open,false,mode+' still closes on a separate Escape');
   await window.history.back();await settle();
   assert.equal(dialog.open,true);
   assert.equal(input.value,'先前的草稿',mode+' keeps the unsent draft on return');

   // A candidate may be selected with a pointer in the IME window, outside this document.
   await typeMarked('zi');await commit('字');
   before=sent().length;
   await formSubmit(send);await settle();
   assert.equal(sent().length,before+1,mode+' sends committed pointer selection on explicit Send');
   assert.equal(sent().at(-1).message,'字');

   // Some software keyboards communicate the start/end only through InputEvent.
   input.value='ci';
   await input.fire('input',{inputType:'insertCompositionText',isComposing:true,data:'ci'});
   before=sent().length;
   await formSubmit(send);await settle();
   assert.equal(sent().length,before,mode+' also guards input-event composition');
   input.value='词';
   await input.fire('input',{inputType:'insertFromComposition',isComposing:false,data:'词'});
   assert.equal(send.disabled,false);
   await formSubmit(send);await settle();
   assert.equal(sent().at(-1).message,'词');

   input.value='line one';
   await input.fire('input',{inputType:'insertText'});
   before=sent().length;
   const newline=await key('keydown','Enter',{shiftKey:true});
   assert.equal(newline.defaultPrevented,undefined,mode+' leaves Shift+Enter to the textarea');
   await key('keyup','Enter');
   await key('keydown','Enter',{keyCode:229});await key('keyup','Enter');
   await key('keydown','Enter',{repeat:true});await key('keyup','Enter');await settle();
   assert.equal(sent().length,before);
   input.value='';
 } finally {
   timers.forEach(clearTimeout);
   context.setTimeout=oldTimeout;context.clearTimeout=oldClear;
 }
}
(async()=>{
 await settle();assert.equal(nodes.get('level-dialog').open,false);
 assert.equal(document.documentElement.lang,'en');assert.equal(document.title,'Proof2Game');
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
 assert.equal(document.documentElement.lang,'en');assert.equal(document.title,'Proof2Game');
 assert(calls.every(call=>call.action!=='language'));calls.length=0;
 assert.equal(cardTitle('convention').textContent,'Convention','different source names do not change the card label');

 progress.language='English';
 game.chinese={title:'双语游戏',levels:{convention:{title:'',text:'参见\\autoref{thm:one}。'},one:{title:'一个陈述',text:'中文陈述。'},proof:{title:'一个陈述',text:'中文证明。'}}};
 await nodes.get('connection-check').fire('click');await settle();calls.length=0;
 assert.equal(nodes.get('language-map').hidden,false);
 nodes.get('language-map').value='中文';await nodes.get('language-map').fire('change');await settle();
 assert.equal(calls[0].action,'language');assert.equal(document.documentElement.lang,'zh-CN');
 assert.equal(document.title,'Proof2Game');
 assert.equal(cardTitle('convention').textContent,'约定');
 assert.equal(cardTitle('one').textContent,'引理 1.1一个陈述');
 assert.equal(nodes.get('progress-count').textContent,'1 / 3');
 await nodes.get('next-level').fire('click');await settle();
 assert.equal(nodes.get('level-original').textContent,'中文陈述。');
 assert.equal(nodes.get('language-level').value,'中文');
 assert(nodes.get('messages').textContent.includes('Welcome.'));
 const stepButton=()=>nodes.get('step-controls').children[0];
 assert.match(stepButton().textContent,/我理解了这一段/);
 let releasePassage;
 delayedPassage=new Promise(resolve=>{releasePassage=resolve;});
 const pendingConfirmation=stepButton().click();await settle();
 assert.equal(nodes.get('undo-level').disabled,false);
 await nodes.get('undo-level').click();await settle();
 assert.equal(passageUndo,null,'undo targets the active confirmation while the next passage loads');
 releasePassage();await pendingConfirmation;delayedPassage=null;
 assert.match(stepButton().textContent,/我理解了这一段/);
 assert.equal(nodes.get('level-error').textContent,'','the cancelled request cannot show a stale provider error');
 await stepButton().click();await settle();
 assert.match(nodes.get('level-error').textContent,/已保存你对本段的确认/);
 assert.equal(stepButton().textContent,'继续下一段');
 await nodes.get('close-level').click();await settle();
 await nodes.get('next-level').click();await settle();
 assert.equal(stepButton().textContent,'继续下一段','reopening a saved confirmation only offers continuation');
 nodes.get('language-level').value='English';await nodes.get('language-level').fire('change');await settle();
 assert.equal(stepButton().textContent,'Continue to the next passage');
 await stepButton().click();await settle();
 assert.equal(calls.filter(call=>call.action==='understand').length,2,'retry does not create another confirmation');
 assert.equal(calls.filter(call=>call.action==='continue').length,1);
 assert(nodes.get('messages').textContent.includes('The next passage.'));
 assert.match(stepButton().textContent,/I understand this passage/);
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
 await exerciseChatInput('guide');
 // Browser Back may run even while the in-page controls are disabled. Apply its latest location after the turn settles.
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
 assert.equal(document.title,'Proof2Game');
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
 window.history.pushState(null,'','/?level=entry');await window.fire('popstate');await settle();
 const illustrated=nodes.get('messages').children.filter(article=>descendants(article).some(node=>node.tag==='img'));
 assert.equal(illustrated.length,1);
 const picture=illustrated[0].children.find(node=>node.tag==='img');
 assert.equal(picture.alt,image.alt);
 assert.equal(decodeURIComponent(picture.src.split(',')[1]),image.svg);
 assert(!illustrated[0].children.some(node=>node.className?.startsWith('message-body')));
 assert(illustrated[0].textContent.includes('Do you understand this step?'));
 await nodes.get('mode-chat').fire('click');await settle();assert.equal(nodes.get('mode-chat').attrs['aria-pressed'],'true');
 await exerciseChatInput('chat');
 assert(!descendants(nodes.get('messages')).some(node=>node.tag==='img'));
 progress.levels.entry.chat.messages.push({role:'assistant',content:'',image});
 await nodes.get('connection-check').fire('click');await settle();
 const chatPicture=descendants(nodes.get('messages')).find(node=>node.tag==='img');
 assert.equal(chatPicture.alt,image.alt);
 assert.equal(decodeURIComponent(chatPicture.src.split(',')[1]),image.svg);
 assert(!nodes.get('messages').textContent.includes('Do you understand this step?'));
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

 // A saved chat preference must not override phone map entry. Reference history
 // tracks the source pane and scroll position independently of undo and close.
 window.innerWidth=320;
 window.history.pushState(null,'','/');
 await window.fire('popstate');await settle();
 progress.levels.entry.mode='chat';
 progress.levels.entry.chat.messages=[{role:'assistant',content:'Read \\ref{thm:one}.'}];
 progress.levels.entry.messages=[{role:'assistant',content:'Read \\ref{thm:one}.'}];
 statuses.one='open';
 game.levels.find(level=>level.id==='one').text='Refer to \\ref{thm:one} again.';
 await nodes.get('connection-check').fire('click');await settle();
 const clickControl=async id=>{await nodes.get(id).fire('click');await settle();};
 const openReference=async container=>{
  const link=descendants(nodes.get(container)).find(node=>node.tag==='a'&&node.className?.includes('internal-reference'));
  assert(link,'the visible fixture contains an active reference');
  await document.fire('click',{target:link,button:0,preventDefault(){}});
  await settle();
 };
 const mobilePane=()=>nodes.get('level-dialog').dataset.panel;
 await descendants(nodes.get('forest')).find(node=>node.dataset.levelId==='entry').fire('click');await settle();
 assert.equal(mobilePane(),'guide');
 assert.equal(document.activeElement,nodes.get('mobile-guide'),'opening keyboard focus matches the selected panel');
 assert.equal(nodes.get('chat-input').rows,1,'mobile input starts on one row');
 assert.equal(nodes.get('mobile-back').disabled,true);
 assert.equal(nodes.get('mobile-forward').disabled,true);
 await clickControl('mobile-chat');
 assert.equal(mobilePane(),'chat');
 nodes.get('chat-input').value='Unsent thought';
 nodes.get('messages').scrollTop=83;
 await openReference('messages');
 assert.equal(window.location.search,'?level=one&ref=thm%3Aone');
 assert.equal(mobilePane(),'content');
 assert.match(nodes.get('mobile-level-meta').textContent,/1\.1/);
 assert.equal(nodes.get('level-title').textContent,'A statement','mobile title does not repeat the number above it');
 assert.equal(nodes.get('mobile-back').disabled,false);
 assert.equal(nodes.get('mobile-forward').disabled,true);
 await clickControl('mobile-back');
 assert.equal(window.location.search,'?level=entry');
 assert.equal(mobilePane(),'chat');
 assert.equal(nodes.get('chat-input').value,'Unsent thought');
 assert.equal(nodes.get('messages').scrollTop,83);
 assert.equal(nodes.get('mobile-forward').disabled,false);
 await clickControl('mobile-forward');
 assert.equal(mobilePane(),'content');
 assert.equal(window.location.search,'?level=one&ref=thm%3Aone');
 special.get('.component-scroll').scrollTop=63;
 await openReference('level-original'); // Same URL, still a separate jump.
 await clickControl('mobile-back');
 assert.equal(mobilePane(),'content');
 assert.equal(special.get('.component-scroll').scrollTop,63);
 assert.equal(nodes.get('mobile-back').disabled,false);
 await clickControl('mobile-back');
 assert.equal(mobilePane(),'chat');
 assert.equal(nodes.get('mobile-back').disabled,true);
 await clickControl('close-level-small');
 assert.equal(window.location.search,'');
 assert.equal(nodes.get('level-dialog').open,false);

 // An anonymous static-site visitor can read a new level before entering a key.
 // The transport rejects every action, so opening and switching panes cannot
 // acquire credentials, start a tutor turn, or fake a successful response.
 let connections=0;
 const anonymousActions=[];
 const anonymous=()=>structuredClone({...response(),connection:{available:true,authenticated:false}});
 progress.levels.entry={mode:'guide',messages:[],chat:{messages:[]}};
 window.proof2gameBrowser={request:async (route,body)=>{
  if(body){anonymousActions.push(body.action);throw Error('Unexpected anonymous action');}
  return anonymous();
 }};
 window.openProof2GameConnection=()=>{connections++;};
 await window.fire('storage',{key:'proof2game:deepseek-key'});await settle();
 await descendants(nodes.get('forest')).find(node=>node.dataset.levelId==='entry').fire('click');await settle();
 assert.equal(mobilePane(),'guide');
 assert.equal(connections,0);
 assert(nodes.get('messages').textContent.includes('DeepSeek API key'));
 await clickControl('mobile-content');
 assert.equal(mobilePane(),'content');
 assert(nodes.get('level-original').textContent.includes('notation'));
 await clickControl('mobile-guide');
 assert.equal(mobilePane(),'guide');
 assert.equal(connections,0);
 nodes.get('chat-input').value='Anonymous draft';
 await nodes.get('chat-form').fire('submit',{preventDefault(){}});
 assert.equal(connections,1);
 assert.equal(nodes.get('chat-input').value,'Anonymous draft');
 assert.deepEqual(anonymousActions,[]);
 assert(html.includes('href="/api/save/export"'));
 console.log(JSON.stringify({ok:true,navigation_checks:checks,manual_save_records:true,import_export_controls:true,live_model_calls:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
