/* Execute the real browser controller with a small DOM and controlled local API. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),baseAssert=require('node:assert/strict');
let checks=0;const assert=new Proxy(baseAssert,{apply(target,self,args){checks++;return Reflect.apply(target,self,args);},get(target,key){const value=target[key];return typeof value==='function'?(...args)=>{checks++;return Reflect.apply(value,target,args);}:value;}});
const assets=path.resolve(__dirname,'../assets/game-runtime');
class Node{
 constructor(tag,text=''){this.tag=tag;this.children=[];this._text=text;this.dataset={};this.style={};this.attrs={};this.handlers={};this.value='';this.scrollTop=0;this.scrollLeft=0;this.clientWidth=600;this.clientHeight=400;this.scrollHeight=400;this.classList={
   contains:name=>(this.className||'').split(/\s+/).includes(name),
   add:name=>{if(!this.classList.contains(name))this.className=[this.className,name].filter(Boolean).join(' ');},
   remove:name=>{this.className=(this.className||'').split(/\s+/).filter(part=>part!==name).join(' ');},
   toggle:(name,force)=>{const on=force??!this.classList.contains(name);this.classList[on?'add':'remove'](name);return on;},
  };}
 append(...nodes){for(const node of nodes){if(node instanceof Node)node.parent=this;this.children.push(node);}}
 prepend(node){node.parent=this;this.children.unshift(node);}
 replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
 get textContent(){return this._text+this.children.map(x=>x.textContent||'').join('');}
 set textContent(value){this._text=String(value);this.children=[];}
 setAttribute(key,value){this.attrs[key]=String(value);}
 get value(){return this._value;}
 set value(next){if(this._value!==next){this._value=next;this.selectionStart=this.selectionEnd=next.length;}}
 get disabled(){return this._disabled||false;}
 set disabled(value){this._disabled=Boolean(value);if(this._disabled)this.blur();}
 addEventListener(type,fn){(this.handlers[type]??=[]).push(fn);}
 async fire(type,event={}){event.target??=this;event.currentTarget=this;event.preventDefault??=()=>{};event.stopPropagation??=()=>{};for(const fn of this.handlers[type]||[])await fn(event);}
 showModal(){this.open=true;}
 close(){const was=this.open;this.open=false;if(was)this.fire('close');}
 click(){return this.disabled?Promise.resolve():this.fire('click',{target:this,preventDefault(){},stopPropagation(){}});}
 focus(){
  if(this.disabled||document.activeElement===this)return;
  document.activeElement?.blur();document.activeElement=this;this.fire('focus');
 }
 blur(){if(document.activeElement===this){document.activeElement=null;this.fire('blur');}}
 setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
 setPointerCapture(){} releasePointerCapture(){} hasPointerCapture(){return false;}
 closest(selector){if(selector==='#messages'&&this===nodes.get('messages'))return this;if(selector==='a.internal-reference'&&this.tag==='a'&&this.className?.includes('internal-reference'))return this;return this.parent?.closest(selector)||null;}
 matches(selector){
  if(selector.startsWith('#'))return this.id===selector.slice(1);
  const [tag,...classes]=selector.split('.');
  return (!tag||this.tag===tag)&&classes.every(name=>this.classList.contains(name));
 }
 querySelectorAll(selector){return descendants(this).slice(1).filter(node=>node.matches(selector));}
 querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
 getBoundingClientRect(){return {left:0,top:0,right:this.clientWidth,bottom:this.clientHeight,width:this.clientWidth,height:this.clientHeight};}
 get firstElementChild(){return this.children[0];}
 get lastElementChild(){return this.children.at(-1);}
 get parentElement(){return this.parent;}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}
 getAttribute(name){return this.attrs[name]??null;}
 removeAttribute(name){delete this.attrs[name];}
 hasAttribute(name){return Object.hasOwn(this.attrs,name);}
 contains(node){return node===this||Boolean(node?.parent&&this.contains(node.parent));}
}
const nodes=new Map(),html=fs.readFileSync(path.join(assets,'index.html'),'utf8');
for(const match of html.matchAll(/<(\w+)\b[^>]*?\bid="([^"]+)"/g)){
 const node=new Node(match[1]);node.id=match[2];if(node.tag==='dialog')node.open=false;nodes.set(node.id,node);
}
const special=new Map(['.garden','.composer-hint','.component-scroll'].map(key=>[key,new Node('div')]));
const descendants=node=>[node,...node.children.filter(x=>x instanceof Node).flatMap(descendants)];
const document={...new Node('document'),title:html.match(/<title>([^<]+)<\/title>/)?.[1],hidden:false,documentElement:{},createTextNode:text=>new Node('#text',text),createElement:tag=>new Node(tag),createElementNS:(_,tag)=>new Node(tag),getElementById:id=>nodes.get(id)||descendants(nodes.get('level-original')).find(node=>node.id===id),querySelector:key=>special.get(key),querySelectorAll:key=>key==='[data-i18n]'?[]:key==='.level-node'?descendants(nodes.get('forest')).filter(node=>node.dataset.levelId):[]};
document.addEventListener=Node.prototype.addEventListener;document.fire=Node.prototype.fire;
let url=new URL('http://localhost/'),entries=[{url:url.href,state:null}],cursor=0;
const window=new Node('window');window.navigator={platform:'MacIntel'};window.innerWidth=1200;window.location={};
let coarsePointer=false;
window.matchMedia=query=>({matches:coarsePointer && query==='(pointer: coarse)'});
const viewport=Object.assign(new Node('visualViewport'),{height:844,width:1200,offsetTop:0,scale:1});
window.visualViewport=viewport;
const dialogStyle=nodes.get('level-dialog').style;
dialogStyle.setProperty=function(name,value){this[name]=String(value);};
dialogStyle.removeProperty=function(name){delete this[name];};
dialogStyle.getPropertyValue=function(name){return this[name]||'';};
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
let slowReply=null,releaseReply=null,delayedMode=null;
let delayedContinuation;
let delayedPassage=null,passageUndo=null;
const calls=[],getCalls=[],saveRecords=[],savedStates=new Map(),recoveries=new Map();let saveIndex=0;
let statuses={convention:'complete',one:'open',proof:'hidden'};
function response(){return {game,progress,undo:passageUndo,saves:saveRecords,connection:{available:true,authenticated:true},level_status:statuses};}
function complete(id){if(!progress.completed.includes(id))progress.completed.push(id);statuses[id]='complete';const next=game.levels[progress.completed.length];if(next)statuses[next.id]='open';progress.revision++;}
const context={document,window,URL,URLSearchParams,crypto:{randomUUID:()=>String(calls.length+1)},requestAnimationFrame:fn=>fn(),setTimeout:()=>1,clearTimeout:()=>{},fetch:async(route,options)=>{
 if(route==='/api/saves'){getCalls.push(route);return {ok:true,json:async()=>structuredClone({saves:saveRecords})};}
 if(options?.body){const body=JSON.parse(options.body);let recovery;calls.push(body);if(['Slow question','Slow failure'].includes(body.message)){await slowReply;if(body.message==='Slow failure')return {ok:false,status:500,json:async()=>({error:'Test response failed.'})};}
  if(body.action==='message' && body.message==='Withdraw this pending question'){
    const chat=progress.levels[body.level_id].chat;
    chat.messages.push({role:'user',content:body.message});
    passageUndo={id:body.request_id,action:'message',level_id:body.level_id,mode:'chat'};
    await slowReply;
    return {ok:false,status:409,json:async()=>({error:'This turn was withdrawn.'})};
  }
  if(body.action==='language'){progress.language=body.language;progress.revision++;}
  if(body.action==='mode'){
    if(delayedMode && await delayedMode==='fail')return {ok:false,status:500,json:async()=>({error:'Mode change failed.'})};
    progress.levels[body.level_id].mode=body.mode;progress.revision++;
  }
  if(body.action==='start'){const level=progress.levels[body.level_id];if(!level.messages.length){level.messages.push({role:'assistant',content:'Welcome. Let us explore this level together.',step_goal:'Confirm when this passage feels clear.',phase:'step'});level.phase='step';}progress.revision++;}
  if(body.action==='understand'){
    const level=progress.levels[body.level_id];
    level.messages.push({role:'user',content:'[Understood the preceding explanatory passage]',language:progress.language,confirms:level.messages.length-1});
    level.phase='awaiting_continuation';progress.revision++;
    passageUndo={id:body.request_id,action:'understand',level_id:body.level_id,mode:'guide'};
    if(delayedPassage)await delayedPassage;
    return {ok:false,status:503,json:async()=>({error:'The tutor is unavailable.'})};
  }
  if(body.action==='undo_action'){
    if(body.expected_revision!==progress.revision)return {ok:false,status:409,json:async()=>({error:'Progress changed.'})};
    assert.equal(body.target_id,passageUndo.id);
    const level=progress.levels[passageUndo.level_id];
    if(passageUndo.action==='message'){
      if(level.chat.messages.at(-1)?.role==='assistant')level.chat.messages.pop();
      level.chat.draft=level.chat.messages.pop().content;
    }
    else{level.messages.pop();level.phase='step';}
    passageUndo=null;progress.revision++;
  }
  if(body.action==='continue'){
    if(delayedContinuation)await delayedContinuation;
    const level=progress.levels[body.level_id];assert.equal(level.phase,'awaiting_continuation');
    level.messages.push({role:'assistant',content:'The next passage.',phase:'step'});level.phase='step';progress.revision++;
  }
  if(body.action==='understand_all')complete(body.level_id);
  if(body.action==='message'){const level=progress.levels[body.level_id],chat=body.mode==='chat'?(level.chat??={messages:[]}):level;chat.messages.push({role:'user',content:body.message},{role:'assistant',content:'Your understanding is noted.',phase:'step'});if(body.message==='I understand this whole level.')complete(body.level_id);else progress.revision++;}
  if(body.action==='message' && body.message==='Withdraw after the reply')passageUndo={id:body.request_id,action:'message',level_id:body.level_id,mode:'chat'};
  if(body.action==='save_create'){const id='save-'+(++saveIndex);savedStates.set(id,structuredClone({progress,statuses}));saveRecords.unshift({id,label:'Progress '+saveIndex,created_at:'2026-11-01T10:00:0'+saveIndex+'Z',completed_count:progress.completed.length});progress.revision++;}
  if(body.action==='save_load'||(body.action==='save_import'&&body.save?.progress)){
    recovery={id:body.request_id,action:body.action};
    recoveries.set(recovery.id,structuredClone({progress,statuses}));
  }
  if(body.action==='save_recover'){
    const prior=recoveries.get(body.recovery_id),rev=progress.revision+1;
    Object.assign(progress,structuredClone(prior.progress));progress.revision=rev;statuses=structuredClone(prior.statuses);
  }
  if(body.action==='save_load'){const previous=savedStates.get(body.save_id),revision=progress.revision+1;Object.assign(progress,structuredClone(previous.progress));progress.revision=revision;statuses=structuredClone(previous.statuses);}
  if(body.action==='save_delete'){const index=saveRecords.findIndex(item=>item.id===body.save_id);
    recovery={id:body.request_id,action:body.action,expires_at:Date.now()+12000};
    recoveries.set(recovery.id,saveRecords.splice(index,1)[0]);progress.revision++;
  }
  if(body.action==='save_undelete'){saveRecords.unshift(recoveries.get(body.recovery_id));progress.revision++;}
  if(body.action==='save_import'){if(!body.save?.progress)return {ok:false,json:async()=>({error:'Save does not match this game snapshot.'})};const revision=progress.revision+1;Object.assign(progress,structuredClone(body.save.progress));progress.revision=revision;statuses=structuredClone(body.save.statuses);}
  if(recovery)return {ok:true,json:async()=>structuredClone({...response(),save_recovery:recovery})};
 }
 return {ok:true,json:async()=>structuredClone(response())};
}};
vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(assets,'app.js'),'utf8'),context);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const house=id=>descendants(nodes.get('forest')).find(node=>node.dataset.levelId===id);
async function focusNextAndEnter(id){
 await nodes.get('next-level').click();await settle();
 assert.equal(nodes.get('level-dialog').open,false,'Continue only locates the next house');
 assert.equal(house(id).dataset.focused,'true');
 await house(id).click();await settle();
}
async function enterFromMap(id){
 const button=house(id);assert(button,'the requested house is visible');
 if(button.dataset.focused!=='true'){
  await button.click();await settle();
  assert.equal(nodes.get('level-dialog').open,false,'the first tap focuses a different house');
 }
 await house(id).click();await settle();
}

async function exerciseVillageGestures(){
 const view=nodes.get('map-scroll'),forest=nodes.get('forest');
 const house=id=>descendants(forest).find(node=>node.dataset.levelId===id);
 const cameraTransform=()=>{
  const match=forest.style.transform.match(/^translate\(([^,]+)px,([^,]+)px\) scale\(([^)]+)\)$/);
  return match.slice(1).map(Number);
 };
 const worldPoint=([x,y,zoom],screen)=>[(screen[0]-x)/zoom,(screen[1]-y)/zoom];
 const near=(a,b)=>a.every((v,i)=>Math.abs(v-b[i])<.001);
 const wheel=(props)=>view.fire('wheel',{clientX:130,clientY:80,deltaX:0,deltaY:3,deltaMode:1,...props});
 const point=[130,80];
 const before=cameraTransform();
 await wheel({});
 const zoomed=cameraTransform();
 assert(zoomed[2]<before[2],'wheel zooms out at the pointer');
 assert(near(worldPoint(before,point),worldPoint(zoomed,point)),'the world position under the pointer stays fixed');
 await nodes.get('next-level').click();
 assert.equal(window.location.search,'','continue focuses without starting a level');
 const down=(id,x,y)=>view.fire('pointerdown',{pointerType:'touch',button:0,pointerId:id,clientX:x,clientY:y});
 const move=(id,x,y)=>window.fire('pointermove',{pointerType:'touch',buttons:1,pointerId:id,clientX:x,clientY:y});
 const up=id=>window.fire('pointerup',{pointerId:id});
 const start=cameraTransform();
 await down(1,150,150);await down(2,250,150);await move(2,330,170);
 const magnified=cameraTransform();
 assert(magnified[2]>start[2],'two fingers magnify the village');
 assert(near(worldPoint(start,[200,150]),worldPoint(magnified,[240,160])),'pinch follows its moving midpoint');
 await up(2);await up(1);
 let suppressed=false;
 await view.fire('click',{detail:1,stopImmediatePropagation:()=>{suppressed=true;}});
 assert(suppressed,'ending a gesture cannot enter a house');
 await nodes.get('next-level').click();
 await down(1,300,200);await move(1,495,200);await up(1);
 assert.equal(house('convention').dataset.focused,'true','drag release focuses the nearest house');
 // The next input burst uses pixel deltas in both axes, just like a Mac trackpad.
 await new Promise(resolve=>setTimeout(resolve,185));
 const panStart=cameraTransform();
 await wheel({deltaMode:0,deltaX:11.5,deltaY:2.5});
 const panned=cameraTransform();
 assert.equal(panned[2],panStart[2],'a Mac two-finger scroll pans without scaling');
 assert(near([panned[0]-panStart[0],panned[1]-panStart[1]],[-11.5,-2.5]));
 await wheel({deltaMode:0,ctrlKey:true,deltaY:-9});
 assert(cameraTransform()[2]>panned[2],'a Mac pinch scales even in the same wheel event stream');
 await nodes.get('next-level').click();
 assert.equal(house('one').dataset.focused,'true');
 assert(!house('proof'),'locked legacy previews stay hidden');
}

async function exerciseMobileViewport(mode){
 const input=nodes.get('chat-input'), messages=nodes.get('messages');
 const wide=window.innerWidth>760, covered=wide?216:436, full=wide?390:844;
 input.focus();
 input.value='我还想问一个问题';
 await input.fire('input',{inputType:'insertText'});
 input.setSelectionRange(2,4);
 messages.scrollTop=61;
 const update=async(type,geometry,expected)=>{
   Object.assign(viewport,geometry);
   await viewport.fire(type);await settle();
   assert.deepEqual(['--level-viewport-top','--level-viewport-height'].map(name=>dialogStyle.getPropertyValue(name)),expected,mode+' dialog follows the exposed screen');
 };
 await update('resize',{width:window.innerWidth,height:covered,offsetTop:0},['0px',covered+'px']);
 await update('scroll',{offsetTop:47},['47px',covered+'px']);
 assert.equal(document.activeElement,input,mode+' keeps typing focus as the keyboard pans the screen');
 assert.equal(input.value,'我还想问一个问题');
 assert.deepEqual([input.selectionStart,input.selectionEnd],[2,4]);
 assert.equal(messages.scrollTop,61,mode+' preserves the current passage while typing');
 await update('resize',{scale:2,height:218},['','']);
 await update('resize',{scale:1,height:full,offsetTop:0},['0px',full+'px']);
 input.value='';await input.fire('input',{inputType:'deleteContentBackward'});
 input.blur();
}

async function exerciseMobileChatReply(){
 const input=nodes.get('chat-input'), send=nodes.get('send-message'), form=nodes.get('chat-form');
 const submit=()=>form.fire('submit',{submitter:send,preventDefault(){}});
 const type=async value=>{input.value=value;await input.fire('input',{inputType:'insertText'});};
 const sent=()=>calls.filter(call=>call.action==='message'&&call.mode==='chat');
 const begin=async message=>{
   input.focus();await type(message);
   const primaryDown=()=>({button:0,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;}});
   const pointer={...primaryDown(),pointerType:'touch'};
   await send.fire('pointerdown',pointer);
   assert.equal(pointer.defaultPrevented,false,'native touch activation can proceed to the Send click');
   const mouse=primaryDown();
   await send.fire('mousedown',mouse);
   if(!mouse.defaultPrevented)send.focus();
   const count=sent().length;
   slowReply=new Promise(resolve=>releaseReply=resolve);
   assert.equal(send.disabled,false);
   await send.click();
   const pending=submit();await settle();
   assert.equal(sent().length,count+1,'a single Send activation posts one player message');
   assert.equal(sent().at(-1).message,message);
   assert.equal(input.disabled,false,'the next chat draft stays editable while waiting for a reply');
   assert.equal(document.activeElement,input,'tapping Send keeps the active mobile editor focused');
   assert.equal(input.value,'','only the submitted message is cleared');
   return {pending};
 };
 let {pending}=await begin('Slow question');
 await input.fire('compositionstart',{data:''});
 input.value='准备问di';await input.fire('input',{inputType:'insertCompositionText',isComposing:true});
 input.setSelectionRange(2,3);
 const count=sent().length;
 assert.equal(send.disabled,true,'a second send waits for the pending reply');
 await submit();assert.equal(sent().length,count);
 await window.fire('pageshow',{persisted:true});await settle();
 assert.equal(input.disabled,false);assert.equal(document.activeElement,input);
 releaseReply();await pending;await settle();
 assert.equal(input.value,'准备问di','the previous reply leaves marked text for the next draft intact');
 assert.deepEqual([input.selectionStart,input.selectionEnd],[2,3]);
 assert.equal(send.disabled,true,'a response does not commit an active composition');
 await submit();assert.equal(sent().length,count);
 input.value='准备问第二个问题';await input.fire('compositionend',{data:'第二个问题'});
 await input.fire('input',{inputType:'insertText',isComposing:false});
 assert.equal(send.disabled,false);assert.equal(document.activeElement,input);
 await submit();await settle();assert.equal(sent().at(-1).message,'准备问第二个问题');

 ({pending}=await begin('Slow failure'));
 input.blur();releaseReply();await pending;await settle();
 assert.equal(input.value,'Slow failure','a failed request restores an untouched draft');
 assert.notEqual(document.activeElement,input,'a failed request respects keyboard dismissal');
 ({pending}=await begin('Slow failure'));
 await type('保留新的问题');releaseReply();await pending;await settle();
 assert.equal(input.value,'保留新的问题','a failed request respects edits made in the meantime');
 const unsent=nodes.get('messages').children.find(node=>node.textContent.includes('Not sent'));
 assert(unsent?.textContent.includes('Slow failure'),'the failed question remains visible alongside the new draft');
 ({pending}=await begin('Slow question'));
 input.blur();releaseReply();await pending;await settle();
 assert.notEqual(document.activeElement,input,'a successful reply respects keyboard dismissal');

 ({pending}=await begin('Withdraw this pending question'));
 await input.fire('compositionstart',{data:''});
 input.value='继续编辑wen';await input.fire('input',{inputType:'insertCompositionText',isComposing:true});
 input.setSelectionRange(4,7);
 const undo=nodes.get(window.innerWidth<=760?'mobile-undo':'undo-level');
 assert.equal(undo.disabled,false);await undo.click();await settle();
 assert.equal(input.value,'继续编辑wen','withdrawing the prior turn preserves the next draft');
 assert.deepEqual([input.selectionStart,input.selectionEnd],[4,7]);
 assert.equal(send.disabled,true,'withdrawal cannot commit the next marked candidate');
 assert.equal(document.activeElement,input);
 assert(nodes.get('messages').textContent.includes('Withdraw this pending question'),'the withdrawn text is available alongside the new draft');
 releaseReply();await pending;await settle();
 assert.equal(input.value,'继续编辑wen','the late withdrawn reply cannot replace current text');
 await input.fire('compositionend',{data:'问'});input.value='';await input.fire('input',{inputType:'deleteContentBackward'});
 await type('Withdraw after the reply');await submit();await settle();
 await type('第二条草稿');input.setSelectionRange(0,2);
 assert.equal(undo.disabled,false);await undo.click();await settle();
 assert.equal(input.value,'第二条草稿','undo after the reply also preserves the new draft');
 assert.deepEqual([input.selectionStart,input.selectionEnd],[0,2]);
 assert(nodes.get('messages').children.some(node=>/withdrawn/i.test(node.textContent)&&node.textContent.includes('Withdraw after the reply')));
 await type('');
}

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
 await settle();assert.equal(nodes.get('global-error').textContent,'','initial render succeeds');assert.equal(nodes.get('level-dialog').open,false);
 assert.equal(document.documentElement.lang,'en');assert.equal(document.title,'Proof2Game');
 assert(!nodes.has('language-dialog'));assert(!nodes.has('language-open'));
 assert(nodes.get('forest').children.length>0,'main map renders without any entry action');
 assert.equal(calls.length,0,'loading the map does not select a language or start a lesson');
 assert.equal(nodes.get('language-map').hidden,true,'legacy packages have no language selector');
 await exerciseVillageGestures();
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
 game.chinese.levels.one.result_sections=['引导文字。','中文陈述。','后续文字。'];
 await nodes.get('connection-check').fire('click');await settle();calls.length=0;
 assert.equal(nodes.get('language-map').hidden,false);
 nodes.get('language-map').value='中文';await nodes.get('language-map').fire('change');await settle();
 assert.equal(calls[0].action,'language');assert.equal(document.documentElement.lang,'zh-CN');
 assert.equal(document.title,'Proof2Game');
 assert.equal(cardTitle('convention').textContent,'约定');
 assert.equal(cardTitle('one').textContent,'引理 1.1一个陈述');
 assert.equal(nodes.get('progress-count').textContent,'1 / 3');
 await focusNextAndEnter('one');
 assert.deepEqual(nodes.get('level-original').children.map(node=>[node.className,node.textContent]),[
   ['statement-prose','引导文字。'],['formal-statement','中文陈述。'],['statement-prose','后续文字。'],
 ]);
 assert.equal(nodes.get('language-level').value,'中文');
 assert(nodes.get('messages').textContent.includes('Welcome.'));
 const passageButtons=()=>nodes.get('messages').querySelectorAll('button.understand-button');
 const stepButton=()=>nodes.get('messages').querySelector('button.retry-passage')||passageButtons().at(-1);
 assert.match(stepButton().textContent,/我理解了这一段/);
 let releasePassage;
 delayedPassage=new Promise(resolve=>{releasePassage=resolve;});
 const pendingConfirmation=stepButton().click();await settle();
 assert.equal(passageButtons().at(-1).textContent,'已理解 ✓');
 assert.equal(passageButtons().at(-1).disabled,true);
 await window.fire('proof2game-topic',{detail:{level_id:'one',mode:'guide',stage:'think',topic:'两条曲线的交点'}});
 assert.equal(nodes.get('tutor-progress').textContent,'正在梳理 两条曲线的交点');
 assert.equal(nodes.get('undo-level').disabled,false);
 await nodes.get('undo-level').click();await settle();
 assert.equal(passageUndo,null,'undo targets the active confirmation while the next passage loads');
 releasePassage();await pendingConfirmation;delayedPassage=null;
 assert.match(stepButton().textContent,/我理解了这一段/);
 assert.equal(nodes.get('level-error').textContent,'','the cancelled request cannot show a stale provider error');
 await stepButton().click();await settle();
 assert.match(nodes.get('level-error').textContent,/已保存你对本段的确认/);
 assert.equal(stepButton().textContent,'重试下一段');
 await nodes.get('close-level').click();await settle();
 await focusNextAndEnter('one');
 assert.equal(stepButton().textContent,'重试下一段','reopening a saved confirmation only offers continuation');
 nodes.get('language-level').value='English';await nodes.get('language-level').fire('change');await settle();
 assert.equal(stepButton().textContent,'Retry next passage');
 let resolveContinuation;
 delayedContinuation=new Promise(resolve=>{resolveContinuation=resolve;});
 const continuation=stepButton().click();await settle();
 window.innerWidth=390;await window.fire('resize');await settle();
 await nodes.get('mobile-content').click();
 special.get('.component-scroll').scrollTop=84;
 resolveContinuation();await continuation;await settle();delayedContinuation=null;
 assert.equal(nodes.get('level-dialog').dataset.panel,'content','a resumed passage respects the panel now being read');
 assert.equal(special.get('.component-scroll').scrollTop,84);
 await nodes.get('mobile-guide').click();await settle();
 window.innerWidth=1200;await window.fire('resize');await settle();
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

 await focusNextAndEnter('one');
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
 await focusNextAndEnter('entry');
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
 // Old conversations can include references to generated images. Reading them must show the
 // original text and learning controls without offering to redraw or opening an image viewer.
 const oldAttachment={alt:'Two points.',svg:'<svg></svg>'};
 progress.levels.entry.messages.push({role:'assistant',content:'Two marked points.',image:oldAttachment,
   step_goal:'Do you understand this step?',phase:'step'});
 await nodes.get('connection-check').fire('click');await settle();
 await nodes.get('close-level').fire('click');await settle();
 window.history.pushState(null,'','/?level=entry');await window.fire('popstate');await settle();
 assert(nodes.get('messages').textContent.includes('Two marked points.'));
 assert(nodes.get('messages').textContent.includes('Do you understand this step?'));
 assert.equal(nodes.get('messages').querySelector('img.guide-illustration'),null);
 assert.equal(nodes.get('messages').querySelector('button.retry-illustration'),null);
 assert.equal(nodes.has('illustration-viewer'),false);
 await nodes.get('mode-chat').fire('click');await settle();assert.equal(nodes.get('mode-chat').attrs['aria-pressed'],'true');
 await exerciseChatInput('chat');
 progress.levels.entry.chat.messages.push({role:'assistant',content:'The two points lie on the line.',image:oldAttachment});
 await nodes.get('connection-check').fire('click');await settle();
 assert(nodes.get('messages').textContent.includes('The two points lie on the line.'));
 assert.equal(nodes.get('messages').querySelector('img.guide-illustration'),null);
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
 await nodes.get('save-toast').querySelector('button').click();await settle();
 assert(progress.levels.entry.chat.messages.some(m=>m.content==='After the checkpoint'));

 await nodes.get('open-saves').fire('click');await settle();
 const beforeDelete=JSON.stringify(progress), deleted=structuredClone(saveRecords[0]);
 await saveAction(saveRows()[0],'Delete').fire('click');await settle();
 assert.equal(saveRecords.length,1);assert.equal(JSON.stringify({...progress,revision:0}),JSON.stringify({...JSON.parse(beforeDelete),revision:0}),'deleting checkpoint leaves current play state unchanged');
 await nodes.get('save-status').querySelector('button').click();await settle();
 assert.deepEqual(saveRecords[0],deleted,'Undo restores the original name, time and progress');
 // Upload is parsed locally and restores via the existing state action; bad files do not mutate the game.
 const uploaded=structuredClone({progress,statuses});uploaded.progress.levels['entry'].chat.messages.push({role:'user',content:'Imported conversation'});
 const largeSave=JSON.stringify(uploaded).padEnd(17*1024*1024);
 nodes.get('save-upload').files=[{size:largeSave.length,text:async()=>largeSave}];
 await nodes.get('save-upload').fire('change');await settle();
 assert(calls.some(call=>call.action==='save_import'));assert.equal(nodes.get('save-dialog').open,false);assert(progress.levels['entry'].chat.messages.some(m=>m.content==='Imported conversation'));
 await nodes.get('save-toast').querySelector('button').click();await settle();
 assert(!progress.levels.entry.chat.messages.some(m=>m.content==='Imported conversation'));
 await nodes.get('open-saves').fire('click');await settle();const beforeBad=JSON.stringify(progress);
 nodes.get('save-upload').files=[{size:10,text:async()=>'{invalid'}];await nodes.get('save-upload').fire('change');await settle();assert(nodes.get('save-error').textContent.includes('valid JSON'));assert.equal(JSON.stringify(progress),beforeBad);
 nodes.get('save-upload').files=[{size:10,text:async()=>JSON.stringify({wrong:true})}];await nodes.get('save-upload').fire('change');await settle();assert(nodes.get('save-error').textContent.includes('snapshot'));assert.equal(JSON.stringify(progress),beforeBad);

 // A saved chat preference must not override phone map entry. Reference history
 // tracks the source pane and scroll position independently of undo and close.
 window.innerWidth=320;await window.fire('resize');await settle();
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
 await enterFromMap('entry');
 assert.equal(mobilePane(),'guide');
 assert.equal(document.activeElement,nodes.get('mobile-guide'),'opening keyboard focus matches the selected panel');
 assert.equal(nodes.get('chat-input').rows,1,'mobile input starts on one row');
 assert.equal(nodes.get('mobile-back').disabled,true);
 assert.equal(nodes.get('mobile-forward').disabled,true);
 await exerciseMobileViewport('guide');
 let releaseMode;
 delayedMode=new Promise(resolve=>{releaseMode=resolve;});
 const switching=nodes.get('mobile-chat').click();await settle();
 assert.equal(mobilePane(),'chat','chat can be used as soon as its tab is tapped');
 const mobileInput=nodes.get('chat-input');
 assert.equal(mobileInput.disabled,false);
 mobileInput.focus();mobileInput.value='切换时输入的问题';
 await mobileInput.fire('input',{inputType:'insertText'});
 nodes.get('mobile-content').focus();await clickControl('mobile-content');
 releaseMode();await switching;await settle();delayedMode=null;
 assert.equal(mobilePane(),'content');
 assert.equal(document.activeElement,nodes.get('mobile-content'),'a delayed chat switch respects the panel the player chose');
 await clickControl('mobile-chat');
 assert.equal(mobilePane(),'chat');
 assert.equal(mobileInput.value,'切换时输入的问题','the mode save preserves the chat draft');
 await exerciseMobileViewport('chat');
 await exerciseMobileChatReply();
 await clickControl('mobile-guide');mobileInput.value='引导草稿';
 await mobileInput.fire('input',{inputType:'insertText'});
 delayedMode=new Promise(resolve=>{releaseMode=resolve;});
 const failedSwitch=nodes.get('mobile-chat').click();await settle();
 mobileInput.focus();mobileInput.value='等待切换时的普通聊天草稿';
 await mobileInput.fire('input',{inputType:'insertText'});
 releaseMode('fail');await failedSwitch;await settle();delayedMode=null;
 assert.equal(mobilePane(),'guide','a failed mode change returns to the saved guide');
 assert.equal(mobileInput.value,'引导草稿','the two conversation drafts stay independent');
 await clickControl('mobile-chat');
 assert.equal(mobileInput.value,'等待切换时的普通聊天草稿','retrying the switch recovers the new chat draft');
 // A landscape phone and a laptop can have the same width. Keep the existing
 // wide layout on both while the touch keyboard supports the next draft.
 window.innerWidth=844;coarsePointer=true;await window.fire('resize');await settle();
 assert.equal(mobileInput.rows,2,'wide touch keeps the existing two-column layout');
 await exerciseMobileViewport('landscape chat');
 await exerciseMobileChatReply();
 coarsePointer=false;await window.fire('resize');await settle();
 mobileInput.focus();mobileInput.value='Slow question';await mobileInput.fire('input',{inputType:'insertText'});
 slowReply=new Promise(resolve=>releaseReply=resolve);
 const laptopSend=nodes.get('chat-form').fire('submit',{submitter:nodes.get('send-message'),preventDefault(){}});await settle();
 assert.equal(mobileInput.disabled,true,'wide mouse and keyboard retains the original single-draft behavior');
 assert.equal(mobileInput.value,'Slow question');
 releaseReply();await laptopSend;await settle();assert.equal(mobileInput.value,'');
 window.innerWidth=320;await window.fire('resize');await settle();
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

 // Anonymous players can locate the next house. Entry requests the credentials
 // dialog without reading level content or starting a model call.
 let connections=0;
 const anonymousActions=[];
 const anonymous=()=>structuredClone({...response(),connection:{available:true,authenticated:false}});
 progress.levels.entry={mode:'guide',messages:[],chat:{messages:[]}};
 window.proof2gameBrowser={request:async (route,body)=>{
  if(body){anonymousActions.push(body.action);throw Error('Unexpected anonymous action');}
  return anonymous();
 }};
 window.openProof2GameConnection=()=>{connections++;};
 await window.fire('ai-connection-change',{detail:anonymous().connection});await settle();
 await nodes.get('next-level').click();await settle();
 assert.equal(connections,0);
 assert.equal(nodes.get('level-dialog').open,false);
 assert.equal(house('convention').dataset.focused,'true');
 await house('convention').click();await settle();
 assert.equal(connections,1);
 assert.equal(nodes.get('level-dialog').open,false);
 assert.deepEqual(anonymousActions,[]);
 assert(html.includes('href="/api/save/export"'));
 console.log(JSON.stringify({ok:true,navigation_checks:checks,manual_save_records:true,import_export_controls:true,live_model_calls:0}));
})().catch(error=>{console.error(error);process.exitCode=1;});
