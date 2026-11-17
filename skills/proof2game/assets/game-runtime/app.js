/* Local, snapshot-bound reading garden. The server owns progress and unlocks. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let state = null;
  let currentLevel = null;
  let busy = false;
  let pendingLabel = '';
  let lastFocusedNode = null;
  let failedRequest = null;
  let pendingSend = null;
  let actionEpoch = 0;
  let undoBusy = false;
  let saveBusy = false;
  let languageBusy = false;
  let pendingNavigation = null;
  let forestViewInitialized = false;
  const conversationDrafts=new Map();
  function chatMode(id=currentLevel){return state?.progress?.levels?.[id]?.mode||'guide';}
  function conversationState(id=currentLevel){return chatMode(id)==='chat'?(levelState(id).chat||{messages:[],phase:null}):levelState(id);}
  function undoMessages(){return chatMode()==='chat'?state.chat_undoable_messages:state.undoable_messages;}
  const en={
    local:'Saved on this device',eyebrow:'A LITTLE CURIOSITY. A GROWING FOREST.',journey:'YOUR JOURNEY',
    available:'Ready to explore',cleared:'Understood',locked:'Not open yet',footer:'Curiosity is the beginning. Understanding is the journey.',
    composerHint:'Ask anything. If it feels easy, ask your guide to take bigger steps.',statement:'Statement',proof:'Proof',
    start:'Begin exploring',continue:'Keep exploring',revisit:'Revisit the grove',understand:'I understand this passage · Continue',
    doneNote:'Level complete. You can still ask your guide anything.',waiting:'Your guide is preparing the next step…',
    thinking:'Thinking…',saving:'Saving…',error:'The connection did not finish. Please try again.',
    intro:'Begin with an idea. Follow the branches of its proof. Explore the mathematics one goal at a time.',
    hint:'Every step of understanding reveals a little more. No quizzes. Just your own pace.',
    allDone:'Your grove is fully grown. Every chapter is always here to revisit.',
    progress:(count,total)=>count+' / '+total,progressCaption:done=>done?'Every level complete':'One thoughtful step at a time',
    placeholder:'What feels unclear? Or tell me we can take bigger steps…',empty:'Let’s begin here and understand this goal together.',
    you:'YOU',guide:'YOUR GUIDE',unavailable:'This level is not open yet.',map:'Level map',close:'Close level',send:'Send message',
    convention:'Convention',
    understandComponent:{convention:'I understand this convention',statement:'I understand this statement',proof:'I understand this proof'}
  };
  Object.assign(en,{
    home:'Proof2Game home',language:'Language',history:'Level history',back:'Back',forward:'Forward',
    conversation:'AI conversation',conversationMode:'Conversation mode',guideMode:'Step by step guide',chatMode:'Regular chat',
    saveGame:'Save game',savedGames:'Saved games',closeSaves:'Close saved games',saveCurrent:'Save current progress',
    uploadSave:'Upload save',downloadCurrent:'Download current progress',manualSaves:'Manual saves',
    saveDescription:'Save a progress point, load an earlier one, or download it to keep elsewhere. Loading or uploading replaces your current progress and conversations.',
    inputLabel:'Tell the AI what is on your mind',checkConnection:'Check local AI connection',
    aiUnavailable:'unavailable',aiCheckLogin:'check login',aiConnected:'connected',aiReady:'ready to connect',
    loading:'Loading the map…',loadingProgress:'Loading Proof2Game…',untitled:'Let understanding grow.',
    reload:'Please restart the game and refresh this page.',level:'Level',seed:'A SEED OF UNDERSTANDING',
    lockedShort:'Locked',lockedError:'This level is locked.',reference:'Reference',formulaSource:'Formula — view source',
    proofOf:name=>'Proof of '+name,pairedProof:()=> 'Proof location: ',understood:'Understood ✓',assistant:'ASSISTANT',
    chatPlaceholder:'Ask a question…',chatHint:'Ask anything about this mathematics.',chatEmpty:'What would you like to discuss?',
    undo:'Undo last action',withdraw:'Withdraw and edit',load:'Load',download:'Download',remove:'Delete',savedGame:'Saved game',
    manualSave:'Manual save',unreadableSave:'Unreadable save (preserved)',
    emptySaves:'No manual saves yet. Save a progress point to return to it later.',
    levelsComplete:(count,total)=>count+' / '+total+' levels complete',
    savedCount:count=>'Progress saved · '+count+' manual saves',
    saveDeleted:'Saved game deleted. Your current progress is unchanged.',
    saveListError:'Could not load saved games.',saveTooLarge:'This save is larger than the supported 16 MB limit.',
    invalidJsonSave:'This is not a valid JSON save file. Your current progress is unchanged.',
    apiError:'The game could not complete this action. Please try again.'
  });
  const zh={
    local:'已保存在此设备',eyebrow:'循着证明理解数学',journey:'学习进度',available:'可进入',cleared:'已理解',locked:'尚未开放',
    footer:'按自己的节奏读懂数学。',composerHint:'随时提问，也可以请引导讲快一点或慢一点。',
    statement:'陈述',proof:'证明',start:'开始学习',continue:'继续学习',revisit:'重访关卡',
    understand:'我理解了这一段 · 继续',doneNote:'本关已完成，仍可继续提问。',
    waiting:'正在准备下一步…',thinking:'思考中…',saving:'保存中…',error:'连接未完成，请重试。',
    intro:'沿着证明的结构，逐步理解这篇稿件。',hint:'每完成一关，就会开放下一关。',allDone:'已完成全部关卡，可以随时重访。',
    progress:en.progress,progressCaption:done=>done?'已完成全部关卡':'逐关学习',
    placeholder:'哪里还不清楚？也可以告诉引导调整步长。',empty:'我们从这里开始。',you:'你',guide:'逐步引导',
    unavailable:'本关尚未开放。',map:'关卡地图',close:'关闭关卡',send:'发送消息',
    convention:'约定',understandComponent:{convention:'我理解了本关约定',statement:'我理解了本关陈述',proof:'我理解了本关证明'},
    home:'Proof2Game 首页',language:'语言',history:'关卡浏览记录',back:'后退',forward:'前进',
    conversation:'AI 对话',conversationMode:'对话模式',guideMode:'逐步引导',chatMode:'普通聊天',
    saveGame:'保存游戏',savedGames:'存档',closeSaves:'关闭存档',saveCurrent:'保存当前进度',
    uploadSave:'上传存档',downloadCurrent:'下载当前进度',manualSaves:'手动存档',
    saveDescription:'可保存、载入或下载进度。载入或上传会替换当前的进度和对话。',
    inputLabel:'输入你的问题或想法',checkConnection:'检查本地 AI 连接',
    aiUnavailable:'不可用',aiCheckLogin:'请检查登录',aiConnected:'已连接',aiReady:'待连接',
    loading:'正在加载地图…',loadingProgress:'正在加载 Proof2Game…',untitled:'Proof2Game',
    reload:'请重新启动游戏并刷新页面。',level:'关卡',seed:'起点',
    lockedShort:'未解锁',lockedError:'此关尚未解锁。',reference:'引用',formulaSource:'查看公式源码',
    proofOf:name=>name+'的证明',pairedProof:()=> '证明位置：',understood:'已理解 ✓',assistant:'助手',
    chatPlaceholder:'输入问题…',chatHint:'可以讨论你感兴趣的内容。',chatEmpty:'你想聊些什么？',
    undo:'撤回上一步',withdraw:'撤回并编辑',load:'载入',download:'下载',remove:'删除',savedGame:'存档',manualSave:'手动存档',
    unreadableSave:'无法读取的存档（已保留）',emptySaves:'还没有手动存档。',
    levelsComplete:(count,total)=>'已完成 '+count+' / '+total+' 关',
    savedCount:count=>'已保存进度 · '+count+' 个手动存档',
    saveDeleted:'已删除该存档。当前进度未改变。',
    saveListError:'无法读取存档列表。',saveTooLarge:'存档超过 16 MB。',
    invalidJsonSave:'这不是有效的 JSON 存档，当前进度未改变。',
    apiError:'游戏未能完成这项操作，请重试。',
    saveMismatch:'此存档与当前游戏版本不匹配，当前进度未改变。',saveMissing:'找不到该存档。',
    changedSnapshot:'稿件文件有改动，请恢复原始游戏文件。',changedReference:'参考文献 PDF 有改动，请恢复原件。',
    progressChanged:'进度已更新，请重试。',checkConnectionError:'无法连接本地 AI，请检查 Codex 的安装、登录和模型权限。'
  };
  function language(){return state?.game?.chinese&&state.progress.language==='中文'?'中文':'English';}
  function words(){return language()==='中文'?zh:en;}
  function t(key){return words()[key]??en[key]??key;}
  function actionError(result,fallback='apiError'){
    if(language()==='中文')return Object.hasOwn(zh,result.code)?t(result.code):t(fallback);
    return result.error||t(fallback);
  }
  function localizedLevel(level){return language()==='中文'?state.game.chinese.levels[level.id]:level;}
  const kinds={Theorem:'定理',Lemma:'引理',Proposition:'命题',Corollary:'推论',Claim:'断言',Section:'节',
    Equation:'公式',Definition:'定义',Remark:'注',Example:'例',Conjecture:'猜想',Assumption:'假设',Statement:'陈述'};
  function kindName(kind){return language()==='中文'?kinds[kind]||kind:kind;}
  function applyInterface() {
    document.documentElement.lang = language()==='中文'?'zh-CN':'en';
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-label]').forEach(el => { el.setAttribute('aria-label',t(el.dataset.i18nLabel)); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title=t(el.dataset.i18nTitle); });
    $('intro-copy').textContent = t('intro');
    $('chat-input').placeholder = t('placeholder');
    document.querySelector('.garden').setAttribute('aria-label', t('map'));
    ['close-level','close-level-small'].forEach(id => $(id).setAttribute('aria-label', t('close')));
    $('send-message').setAttribute('aria-label', t('send'));
    renderLanguageMenus();
  }
  function renderLanguageMenus(){
    for(const id of ['language-map','language-level']){
      const menu=$(id);
      menu.hidden=!state?.game?.chinese;
      menu.value=language();
      menu.disabled=languageBusy||saveBusy;
      menu.setAttribute('aria-label',t('language'));
    }
  }
  async function switchLanguage(selected){
    if(!state?.game?.chinese||languageBusy||saveBusy||selected===language())return;
    languageBusy=true;clearTimeout(prefetchTimer);renderLanguageMenus();
    try{
      const request_id=crypto.randomUUID();
      const body={action:'language',language:selected,request_id};
      try{
        accept(await request('/api/action',{...body,expected_revision:state.progress.revision}));
      }catch(error){
        if(error.status!==409)throw error;
        accept(await request('/api/game'));
        if(language()!==selected)accept(await request('/api/action',{...body,expected_revision:state.progress.revision}));
      }
      for(const id of ['level-error','global-error','save-error','save-status','save-toast'])notice(id,'');
      $('level-save-status').textContent='';
    }catch(error){
      notice($('level-dialog').open?'level-error':'global-error',error.message);
    }finally{
      languageBusy=false;renderSaves();schedulePrefetch();
    }
  }
  function element(name, cls, text) {
    const el = document.createElement(name);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function svgEl(name, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    return el;
  }

  // Display-only conversion. Snapshot sources and stored dialogue stay untouched.
  function referenceTarget(key){
    const ref=state?.game?.internal_references?.[key];
    return ref&&(state.game.levels||[]).some(level=>level.id===ref.level_id)?ref:null;
  }
  function levelNumber(level){return String(level.number||levels().findIndex(item=>item.id===level.id)+1).padStart(2,'0');}
  function levelHeading(level){
    if(level.type==='convention')return t('convention');
    const title=localizedLevel(level).title;
    if(!level.statement_number)return title||level.id;
    const statement=level.type==='proof'?levels().find(item=>item.id===level.paired):level;
    const name=kindName(statement?.kind||'Statement')+' '+level.statement_number;
    return (level.type==='proof'?words().proofOf(name):name)+(title?' · '+title:'');
  }
  function referenceAnchor(key){return 'ref-'+encodeURIComponent(key);}
  function internalReferenceLink(key,label){
    const ref=referenceTarget(key);if(!ref)return document.createTextNode(label);
    if(!levelStatus().available.has(ref.level_id)){
      const locked=element('span','reference-link reference-locked',label+' · '+t('lockedShort'));
      locked.setAttribute('aria-disabled','true');locked.title=t('lockedError');
      return locked;
    }
    const link=element('a','reference-link internal-reference',label);
    link.href='/?level='+encodeURIComponent(ref.level_id)+'&ref='+encodeURIComponent(key);
    link.target='_self';
    link.title=(ref.name?kindName(ref.name):t('reference'))+' '+ref.number;
    return link;
  }
  function referenceText(token){
    const [encoded,command]=token.split('|');let key;
    try{key=decodeURIComponent(encoded);}catch{key=encoded;}
    const ref=referenceTarget(key),number=ref?.number;
    return {key,text:number?(command==='eqref'?'('+number+')':command==='autoref'?(ref.name?kindName(ref.name):t('reference'))+' '+number:number):key.replace(/^(?:eq|ms|ext|proof):/,'').replace(/-/g,' ')};
  }
  function mathReferenceText(text){
    return text.replace(/\uE100([^\uE101]+)\uE101/g,(_,token)=>referenceText(token).text).replace(/\uE102[^\uE103]+\uE103/g,'');
  }
  function sourceReferenceKey(key,namespace=''){return namespace+key;}
  function displaySource(text,namespace='') {
    return String(text || '').replace(/\\label\{([^}]+)\}/g,(_,key)=>'\uE102'+encodeURIComponent(sourceReferenceKey(key,namespace))+'\uE103')
      .replace(/\\(eqref|ref|autoref)\{([^}]+)\}/g,(_,command,key)=>'\uE100'+encodeURIComponent(sourceReferenceKey(key,namespace))+'|'+command+'\uE101')
      .replace(/~/g,' ')
      .replace(/\\cite\{([^}]+)\}(?:\*\{([^}]+)\})?/g,(_,key,loc)=>'['+key+(loc?', '+loc:'')+']');
  }
  function mathSegments(text,namespace='') {
    const source=displaySource(text,namespace);
    const pattern=/```[\s\S]*?```|\\begin\{(align(?:at)?\*?|flalign\*?|equation\*?|gather\*?|multline\*?)\}[\s\S]*?\\end\{\1\}|\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|(?<!\\)\$(?!\$)(?:\\.|[^$])*?(?<!\\)\$/g;
    const result=[]; let cursor=0;
    for (const match of source.matchAll(pattern)) {
      if(match.index>cursor) result.push({type:'text',text:source.slice(cursor,match.index)});
      const raw=match[0]; let body=raw,display=false,type='math';
      if(raw.startsWith('```')) {type='code';body=raw.replace(/^```[^\n]*\n?/,'').replace(/```$/,'');}
      else if(raw.startsWith('\\begin')) {
        display=true;
        const env=match[1]; body=raw.slice(('\\begin{'+env+'}').length,-('\\end{'+env+'}').length);
        if(env.startsWith('alignat')) body='\\begin{alignedat}'+body+'\\end{alignedat}';
        else if(env.startsWith('align')||env.startsWith('flalign')) body='\\begin{aligned}'+body+'\\end{aligned}';
        if(env.startsWith('gather')||env.startsWith('multline')) body='\\begin{gathered}'+body+'\\end{gathered}';
      } else if(raw.startsWith('$$')) {display=true;body=raw.slice(2,-2);}
      else if(raw.startsWith('\\[')) {display=true;body=raw.slice(2,-2);}
      else if(raw.startsWith('\\(')) body=raw.slice(2,-2);
      else body=raw.slice(1,-1);
      body=mathReferenceText(body).replace(/\\(?:notag|nonumber)\b/g,'');
      result.push({type,text:body,display});cursor=match.index+raw.length;
    }
    if(cursor<source.length) result.push({type:'text',text:source.slice(cursor)});
    return result;
  }

  function referenceLink(ref,label,page){
    const hosted=state.game.distribution==='pages';
    const href=hosted?ref.source_url:'/'+ref.file+(page?'#page='+page:'');
    const reference=element(href?'a':'span','reference-link',label);
    if(href){
      reference.href=href;reference.target='_blank';reference.rel='noopener noreferrer';
    }
    reference.title=ref.title+(hosted?'':' · PDF')+(page?' · '+(language()==='中文'?'第 '+page+' 页':'p. '+page):'');
    return reference;
  }
  const referenceLocatorKinds={theorem:'theorem',theorems:'theorem',lemma:'lemma',lemmas:'lemma',
    proposition:'proposition',propositions:'proposition',corollary:'corollary',corollaries:'corollary',
    definition:'definition',claim:'claim',example:'example',section:'section',chapter:'chapter',appendix:'appendix',
    '定理':'theorem','引理':'lemma','命题':'proposition','推论':'corollary','定义':'definition',
    '断言':'claim','例':'example','节':'section','章':'chapter','附录':'appendix','§':'section'};
  const referenceLocatorNumber="(?:(?:[a-z]\\.?)?\\d+(?:\\.\\d+)*[a-z]?['′’]?(?:\\s*\\([a-z0-9]+\\))*|[ivxlcdm]+)";
  const referenceLocatorPattern=new RegExp(
    '(?<![a-z])('+Object.keys(referenceLocatorKinds).join('|')+')\\s*('+referenceLocatorNumber+')(?![a-z0-9]|\\.\\d)','gi'
  );
  function namedReferenceLocators(text){
    return [...text.matchAll(referenceLocatorPattern)].map(match=>{
      const kind=referenceLocatorKinds[match[1].toLowerCase()];
      const number=match[2].toLowerCase().replace(/[′’]/g,"'").replace(/\s/g,'');
      return {id:kind+' '+number,index:match.index};
    });
  }
  function citedReferencePage(ref,text){
    const locations=ref.locations||[];
    const explicit=namedReferenceLocators(text)[0];
    if(explicit&&/^[\s,，:：]*$/.test(text.slice(0,explicit.index))){
      const pages=new Set(locations.filter(loc=>
        namedReferenceLocators(loc.label||'').some(named=>named.id===explicit.id)
      ).map(loc=>loc.page));
      // A named but unverified or ambiguous result should open the source without claiming a page.
      if(locations.length) return pages.size===1?[...pages][0]:null;
    }
    const location=locations.find(loc=>{
      if(typeof loc.match!=='string'||!loc.match) return false;
      try{return new RegExp(loc.match,'i').test(text);}catch{return false;}
    });
    return location?.page;
  }
  function appendReferenceText(parent,text){
    const refs=(state?.game?.references||[]).filter(r=>typeof r.file==='string'&&/^references\/[A-Za-z0-9._-]+\.pdf$/.test(r.file)&&!r.file.includes('..'));
    if(!refs.length){parent.append(document.createTextNode(text));return;}
    const aliases=refs.flatMap(ref=>(ref.aliases||[ref.key]).map(alias=>({alias,ref}))).filter(x=>typeof x.alias==='string'&&x.alias.length).sort((a,b)=>b.alias.length-a.alias.length);
    if(!aliases.length){parent.append(document.createTextNode(text));return;}
    const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const pattern=new RegExp('\\b(?:'+aliases.map(x=>escape(x.alias)).join('|')+')\\b','g');
    function plain(value){
      let cursor=0;
      const matches=[...value.matchAll(pattern)];
      for(const [index,m] of matches.entries()){
        parent.append(document.createTextNode(value.slice(cursor,m.index)));
        const ref=aliases.find(x=>x.alias===m[0]).ref;
        const end=m.index+m[0].length;
        const tail=value.slice(end,Math.min(end+180,matches[index+1]?.index??value.length));
        const close=tail.indexOf(']');
        const bracketed=value[m.index-1]==='['&&close>=0;
        const inside=close<0?tail:tail.slice(0,close);
        const locator=bracketed&&!inside.trim()?(tail.slice(close+1).match(/^\s*[,，:：]\s*(.*)/)?.[1]||''):inside;
        const selected=citedReferencePage(ref,locator);
        const page=selected===undefined?(ref.default_page||1):selected;
        parent.append(referenceLink(ref,m[0],page));cursor=end;
      }
      parent.append(document.createTextNode(value.slice(cursor)));
    }
    const markdown=/\[([^\]\n]+)\]\((\/references\/[A-Za-z0-9._-]+\.pdf)(?:#page=([1-9]\d*))?\)/g;
    let cursor=0;
    for(const m of text.matchAll(markdown)){
      plain(text.slice(cursor,m.index));
      const ref=refs.find(r=>'/'+r.file===m[2]);const page=m[3]?Number(m[3]):null;
      if(ref&&(!page||(Number.isSafeInteger(page)&&page<=ref.pages)))parent.append(referenceLink(ref,m[1],page));
      else parent.append(document.createTextNode(m[0]));
      cursor=m.index+m[0].length;
    }
    plain(text.slice(cursor));
  }
  function inlineText(parent,text,tokens=[]) {
    // Math stays an opaque token while emphasis is parsed across the whole phrase.
    const pattern=/\uE000(\d+)\uE001|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|`([^`]+)`|\*([^*\n]+)\*|\uE100([^\uE101]+)\uE101|\uE102([^\uE103]+)\uE103/g;
    let cursor=0;
    for(const m of text.matchAll(pattern)) {
      appendReferenceText(parent,text.slice(cursor,m.index));
      if(m[1]!==undefined) {
        const part=tokens[Number(m[1])];
        if(part) {
          if(part.type==='code')parent.append(element('pre','code-block',part.text));
          else {
            const node=element(part.display?'div':'span',part.display?'rendered-equation':'rendered-inline');
            try {window.katex.render(part.text,node,{displayMode:part.display,throwOnError:true,trust:false,strict:'ignore',macros:{...(tokens.mathMacros || state?.game?.math_macros || {})},maxExpand:1000});}
            catch(error) {
              const details=element('details','formula-fallback');details.append(element('summary','',t('formulaSource')),element('pre','',part.text));details.title=String(error.message);node.append(details);
            }
            if(part.equation){
              const row=element('div','numbered-equation'),numbers=element('div','equation-numbers');
              for(const key of part.equation.references){
                const ref=referenceTarget(key);if(!ref)continue;
                const number=internalReferenceLink(key,'('+ref.number+')');number.id=referenceAnchor(key);numbers.append(number);
              }
              row.append(node,numbers);parent.append(row);
            }else parent.append(node);
          }
        } else parent.append(document.createTextNode(m[0]));
      } else if(m[6]!==undefined){
        const ref=referenceText(m[6]);parent.append(internalReferenceLink(ref.key,ref.text));
      } else if(m[7]!==undefined){
        if(tokens.anchorLabels){let key;try{key=decodeURIComponent(m[7]);}catch{key=m[7];}
          const anchor=element('span','reference-anchor');anchor.id=referenceAnchor(key);parent.append(anchor);}
      } else {
        const node=element(m[4]!==undefined?'code':m[5]!==undefined?'em':'strong');
        if(m[4]!==undefined)node.textContent=m[4];
        else inlineText(node,m[2]??m[3]??m[5],tokens);
        parent.append(node);
      }
      cursor=m.index+m[0].length;
    }
    appendReferenceText(parent,text.slice(cursor));
  }
  function proseMarkup(text){
    // Literal TeX prose wrappers are presentation; mathematics is already tokenized.
    const wrappers=/\\(textbf|emph|textit|texttt|textrm|textsf|textnormal|paragraph|subparagraph)\{/g;
    let result='',cursor=0;
    for(const match of text.matchAll(wrappers)){
      if(match.index<cursor)continue;
      let depth=1,end=match.index+match[0].length;
      const start=end;
      while(end<text.length&&depth){
        if(text[end]==='\\'){end+=2;continue;}
        if(text[end]==='{')depth++;else if(text[end]==='}')depth--;
        end++;
      }
      if(depth)continue;
      const content=proseMarkup(text.slice(start,end-1));
      const delimiters={textbf:'**',emph:'*',textit:'*',texttt:'`'},delimiter=delimiters[match[1]];
      result+=text.slice(cursor,match.index)+(delimiter?delimiter+content+delimiter:match[1].endsWith('paragraph')?'\n\n### '+content+'\n\n':content);
      cursor=end;
    }
    return (result+text.slice(cursor)).replace(/\\(?:noindent|smallskip|medskip|bigskip|par)\b/g,' ').replace(/\\([%&#_$])/g,'$1');
  }
  function renderRich(el,text,options={}) {
    el.replaceChildren();
    let item=0;
    const sourceLevel=(state?.game?.levels||[]).find(level=>level.id===(options.levelId||options.macroLevelId));
    const namespace=sourceLevel?.reference_namespace||'';
    text=String(text || '').replace(/\\begin\{(Theorem|Lemma|Proposition|Corollary|Claim)\}(?:\[([^\]]*)\])?\s*\\label\{([^}]+)\}/g,(_,kind,title,key)=>
      '\n\n### '+kindName(kind)+' '+(referenceTarget(sourceReferenceKey(key,namespace))?.number||'')+(title?' · '+title:'')+'\\label{'+key+'}\n\n')
      .replace(/\\(?:begin|end)\{enumerate\}/g,'\n\n')
      .replace(/\\item\s*/g,()=> '\n\n'+(++item)+'. ')
      .replace(/\\(?:begin|end)\{itemize\}/g,'\n\n')
      .replace(/\\(?:begin|end)\{(?:Theorem|Lemma|Proposition|Corollary|Claim|proof|remark|definition|convention)\}(?:\[[^\]]*\])?/gi,'');
    const tokens=[];
    tokens.anchorLabels=Boolean(options.levelId);
    let equationIndex=0;
    tokens.mathMacros=state?.game?.math_macros||{};
    const prose=mathSegments(text,namespace).map(part=>{
      if(part.type==='text')return part.text;
      if(part.display){equationIndex++;part.equation=options.levelId?sourceLevel?.equations?.find(eq=>eq.index===equationIndex):undefined;}
      return '\uE000'+(tokens.push(part)-1)+'\uE001';
    }).join('').replace(/It\\\^o/g,'Itô').replace(/L\\'evy/g,'Lévy');
    for(const [index,chunk] of proseMarkup(prose).split(/\n\s*\n/).entries()) {
      if(index)el.append(element('div','paragraph-break'));
      const block=element('span','prose-run');
      const joined=chunk.replace(/\n/g,' ');
      const heading=joined.match(/^\s*#{1,6}\s+(.*)$/);
      if(heading) {const h=element('h4');inlineText(h,heading[1],tokens);block.append(h);}
      else inlineText(block,joined,tokens);
      el.append(block);
    }
  }
  function notice(target, message) { $(target).textContent = message || ''; $(target).hidden = !message; }
  function levels() { return state?.game?.levels || []; }
  function completed() { return new Set(state?.progress?.completed || []); }
  function levelState(id) { return state?.progress?.levels?.[id] || {messages:[],phase:null}; }
  function levelStatus() {
    const done = completed();
    const queue = levels();
    const next = queue.find(level => !done.has(level.id));
    const available = new Set(queue.filter(level => done.has(level.id)).map(level => level.id));
    if (next) available.add(next.id);
    const visible = new Set(available);
    queue.forEach(level => { if (level.type === 'statement' && visible.has(level.id) && level.paired) visible.add(level.paired); });
    // Prefer server-provided visibility; fallback is presentation only.
    if (state.level_status && typeof state.level_status === 'object') {
      available.clear(); visible.clear();
      queue.forEach(level => {
        const status=state.level_status[level.id];
        if (['locked','open','complete'].includes(status)) visible.add(level.id);
        if (['open','complete'].includes(status)) available.add(level.id);
      });
    }
    // Never trust these display sets as authority: every action is server-validated.
    return {done,next,available,visible};
  }
  function forestLayout(visible) {
    const visibleLevels = levels().filter(level => visible.has(level.id));
    const byId = new Map(visibleLevels.map(level => [level.id,level]));
    const parents = new Map();
    for (const level of visibleLevels) {
      const candidate = level.parent || (level.type === 'proof' ? level.paired : null);
      parents.set(level.id, candidate && byId.has(candidate) && candidate !== level.id ? candidate : null);
    }
    // Protect rendering against malformed metadata rather than freezing the page.
    for (const level of visibleLevels) {
      const visited = new Set([level.id]);
      let id = parents.get(level.id);
      while (id) {
        if (visited.has(id)) { parents.set(level.id,null); break; }
        visited.add(id); id = parents.get(id);
      }
    }
    const children = new Map(visibleLevels.map(level => [level.id,[]]));
    visibleLevels.forEach(level => { const parent = parents.get(level.id); if (parent) children.get(parent).push(level.id); });
    const roots = visibleLevels.filter(level => !parents.get(level.id));
    const gap = window.innerWidth < 760 ? 219 : 248;
    const positions = new Map();
    let cursor = 0;
    let maxDepth = 0;
    function place(id, depth) {
      maxDepth = Math.max(maxDepth,depth);
      const childIds = children.get(id);
      const start = cursor;
      childIds.forEach(child => place(child,depth+1));
      if (!childIds.length) cursor++;
      const xs = childIds.map(child => positions.get(child).x);
      positions.set(id,{x:xs.length ? (Math.min(...xs)+Math.max(...xs))/2 : (start+.5)*gap,depth});
    }
    roots.forEach((level,index) => { if (index) cursor += .5; place(level.id,0); });
    const width = Math.max($('map-scroll').clientWidth,(cursor+.35)*gap);
    const actualWidth = cursor*gap;
    const offset = (width-actualWidth)/2;
    const height = Math.max(430,$('map-scroll').clientHeight,185+(maxDepth+1)*132);
    for (const pos of positions.values()) { pos.x += offset; pos.y = height-100-pos.depth*132; }
    return {positions,roots,parents,width,height,visibleLevels};
  }
  function renderForest() {
    const {done,next,available,visible} = levelStatus();
    const {positions,roots,parents,width,height,visibleLevels} = forestLayout(visible);
    const forest = $('forest');
    forest.replaceChildren();
    forest.style.width = width+'px'; forest.style.height = height+'px';
    const svg = svgEl('svg',{width,height,class:'forest-svg','aria-hidden':'true',viewBox:`0 0 ${width} ${height}`});
    const leavesGroup = svgEl('g',{});
    const branchGroup = svgEl('g',{});
    svg.append(leavesGroup,branchGroup);
    roots.forEach((root,index) => {
      const point = positions.get(root.id);
      branchGroup.append(svgEl('path',{d:`M ${point.x} ${height-44} C ${point.x-8} ${height-62},${point.x+5} ${height-69},${point.x} ${point.y}`,class:'tree-branch-halo','stroke-width':22}));
      branchGroup.append(svgEl('path',{d:`M ${point.x} ${height-43} C ${point.x-8} ${height-62},${point.x+5} ${height-69},${point.x} ${point.y}`,class:'tree-branch','stroke-width':10}));
      [-1,1].forEach(sign => {
        branchGroup.append(svgEl('path',{d:`M ${point.x} ${height-48} Q ${point.x+sign*18} ${height-30}, ${point.x+sign*52} ${height-38}`,class:'tree-ground'}));
        branchGroup.append(svgEl('path',{d:`M ${point.x} ${height-49} Q ${point.x+sign*11} ${height-25}, ${point.x+sign*25} ${height-23}`,class:'tree-ground'}));
      });
      const label=svgEl('text',{x:point.x,y:height-8,'text-anchor':'middle',class:'root-tag'});
      label.textContent=`${String(index+1).padStart(2,'0')} / ${t('seed')}`;
      svg.append(label);
    });
    visibleLevels.forEach((level,index) => {
      const p = positions.get(level.id); const parent = parents.get(level.id); const q = positions.get(parent);
      if (q) {
        const d=`M ${q.x} ${q.y-10} C ${q.x} ${q.y-65}, ${p.x} ${p.y+74}, ${p.x} ${p.y+15}`;
        branchGroup.append(svgEl('path',{d,class:'tree-branch-halo','stroke-width':17}));
        branchGroup.append(svgEl('path',{d,class:'tree-branch','stroke-width':Math.max(3,8-p.depth)}));
        const midx=(q.x+p.x)/2, midy=(q.y+p.y)/2;
        [-1,1].forEach((sign,n) => leavesGroup.append(svgEl('ellipse',{cx:midx+sign*23,cy:midy-12+n*17,rx:21,ry:9,transform:`rotate(${sign*30} ${midx+sign*23} ${midy-12+n*17})`,class:`tree-leaf${index%2?' dark':''}`})));
      }
      const locked = !available.has(level.id);
      const status = locked?'locked':done.has(level.id)?'done':'current';
      const button=element('button',`level-node ${status}`);
      button.type='button'; button.style.left=p.x+'px'; button.style.top=p.y+'px'; button.dataset.levelId=level.id;
      button.disabled=locked || busy || saveBusy;
      const cardLabel=level.type==='convention'?t(level.type):level.statement_number?levelHeading(level).split(' · ')[0]:t(level.type);
      const cardTitle=level.type==='convention'?null:localizedLevel(level).title||null;
      button.setAttribute('aria-label',`${t('level')} ${levelNumber(level)} · ${cardLabel}${cardTitle?': '+cardTitle:''}. ${locked?t('locked'):done.has(level.id)?t('cleared'):t('available')}`);
      const top=element('span','node-top'); top.append(element('span','node-status',locked?'⌑':done.has(level.id)?'✓':'↗'));
      const title=element('span','node-title');
      title.append(element('span',cardTitle?'node-reference':'node-description',cardLabel));
      if(cardTitle)title.append(element('span','node-description',cardTitle));
      button.append(top,title);
      button.addEventListener('click',() => { lastFocusedNode=level.id; openLevel(level.id); });
      forest.append(button);
    });
    forest.prepend(svg);
    if(!forestViewInitialized){
      forestViewInitialized=true;
      const point=positions.get(next?.id)||positions.get(roots[0]?.id);
      if(point)requestAnimationFrame(()=>{
        const view=$('map-scroll');view.scrollLeft=point.x-view.clientWidth/2;view.scrollTop=point.y-view.clientHeight/2;
      });
    }
    $('progress-count').textContent=words().progress(done.size,levels().length);
    $('progress-fill').style.width=(levels().length?done.size/levels().length*100:0)+'%';
    $('progress-caption').textContent=words().progressCaption(!next);
    $('garden-hint').textContent=next?t('hint'):t('allDone');
    $('next-level').textContent=(!next?t('revisit'):done.size?t('continue'):t('start'))+' ↗';
    $('next-level').disabled=busy || !levels().length;
  }
  function renderLevel() {
    if (!currentLevel || !state) return;
    const level=levels().find(item=>item.id===currentLevel); if (!level) return;
    const saved=conversationState(),regular=chatMode()==='chat'; const done=completed().has(currentLevel);
    for(const [mode,id] of [['guide','mode-guide'],['chat','mode-chat']]){const tab=$(id);tab.setAttribute('aria-pressed',String(chatMode()===mode));tab.disabled=busy||saveBusy;}
    $('chat-input').placeholder=regular?t('chatPlaceholder'):t('placeholder');
    document.querySelector('.composer-hint').textContent=regular?t('chatHint'):t('composerHint');
    const statementRef=level.type==='proof'?Object.entries(state.game.internal_references||{}).find(([,ref])=>ref.level_id===level.paired&&ref.kind==='statement')?.[0]:null;
    const heading=levelHeading(level),ref=referenceTarget(statementRef);
    const citation=ref?kindName(ref.name)+' '+ref.number:'',offset=citation?heading.indexOf(citation):-1;
    if(offset>=0)$('level-title').replaceChildren(document.createTextNode(heading.slice(0,offset)),internalReferenceLink(statementRef,citation),document.createTextNode(heading.slice(offset+citation.length)));
    else $('level-title').textContent=heading;
    renderRich($('level-original'),localizedLevel(level).text,{levelId:level.id});
    if(level.type==='statement'){
      const proofKey=Object.keys(state.game.internal_references||{}).find(key=>
        state.game.internal_references[key].level_id===level.paired&&state.game.internal_references[key].kind==='proof');
      if(proofKey){
        const nav=element('p','proof-location');
        nav.append(document.createTextNode(words().pairedProof()),internalReferenceLink(proofKey,referenceTarget(proofKey).number));
        $('level-original').append(nav);
      }
    }
    $('level-images').replaceChildren();
    const verifiedImages=new Set(Array.isArray(state.game.images)?state.game.images:[]);
    for (const imagePath of Array.isArray(level.images)?level.images:[]) {
      if (typeof imagePath!=='string' || !verifiedImages.has(imagePath) || !imagePath.startsWith('snapshot/') || imagePath.split('/').some(part=>part==='..'||part==='.') || !/\.(png|jpe?g|webp)$/i.test(imagePath)) continue;
      const figure=element('figure','manuscript-figure');
      const image=element('img');
      image.src='/'+imagePath.split('/').map(encodeURIComponent).join('/');
      image.alt=imagePath.split('/').pop();image.loading='lazy';image.decoding='async';
      figure.append(image,element('figcaption','',image.alt));$('level-images').append(figure);
    }
    const understandAll=$('understand-all');
    understandAll.textContent=done?t('understood'):words().understandComponent[level.type];
    understandAll.disabled=busy||saveBusy||done||!levelStatus().available.has(currentLevel);
    const messages=$('messages'); const wasBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<120;
    messages.replaceChildren();
    for (const [messageIndex,message] of (saved.messages || []).entries()) {
      const article=element('article',`chat-message ${message.role==='user'?'user':'assistant'}`);
      article.append(element('div','message-label',message.role==='user'?t('you'):regular?t('assistant'):t('guide')));
      let displayedContent=String(message.content || message.message || '');
      if(message.kind!=='message'){
        const chinese=(message.language||'English')==='中文';
        if (displayedContent==='[Understood the preceding explanatory step]') displayedContent=chinese?'我理解了这一步。':'I understand this step.';
        if (displayedContent==='[Understood the answer to my question]') displayedContent=chinese?'我理解了这个回答。':'I understand the answer to my question.';
        if (displayedContent==='[Confirmed understanding of the entire level goal]') displayedContent=chinese?'我理解了整关。':'I understand the complete goal of this level.';
        if (displayedContent==='[Understood the preceding explanatory passage]') displayedContent=chinese?'我理解了这一段。':'I understand this passage.';
      }
      if(displayedContent){
        const content=element('div','message-body math-content');renderRich(content,displayedContent,{macroLevelId:level.id});
        article.append(content);
      }
      if(!regular&&message.role==='assistant'&&message.image){
        const illustration=element('img','guide-illustration');
        illustration.alt=message.image.alt;
        illustration.width=640;illustration.height=400;
        illustration.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(message.image.svg);
        article.append(illustration);
      }
      if(!regular&&message.role==='assistant'&&message.step_goal) {
        const goal=element('div','local-step-goal math-content');
        const stepPoint=message.step_goal.replace(/^(\s*)(?:The\s+)?local goal\b/i,'$1The point of this step');
        renderRich(goal,stepPoint,{macroLevelId:level.id});article.append(goal);
      }
      const undo=undoMessages()?.[currentLevel];
      if(message.role==='user'&&undo?.message_index===messageIndex&&!busy&&!saveBusy){article.classList.add('with-undo');article.append(undoButton(undo.target_id));}
      messages.append(article);
    }
    const activePending=[pendingSend,state.pending_message].find(p=>p?.level_id===currentLevel&&(p.mode||'guide')===chatMode());
    const pending=activePending||null;
    if(pending){
      const article=element('article','chat-message user pending-user with-undo');
      article.append(element('div','message-label',t('you')));
      const body=element('div','message-body');body.textContent=pending.message;article.append(body,undoButton(pending.target_id));messages.append(article);
    }
    if (!saved.messages?.length && !busy) messages.append(element('p','empty-message',regular?t('chatEmpty'):t('empty')));
    if (busy && pendingLabel) {const pending=element('div','pending-message');pending.append(element('span','pulse'),document.createTextNode(t(pendingLabel)));messages.append(pending);}
    if (wasBottom || busy) requestAnimationFrame(()=>{messages.scrollTop=messages.scrollHeight;});
    const controls=$('step-controls'); controls.replaceChildren();
    if (!regular && !busy && !saveBusy && saved.messages?.length) {
      if (done) controls.append(element('span','step-note',t('doneNote')));
      else if (saved.phase==='step') {
        const label=t('understand');
        const button=element('button','understand-button',label+' ✓');button.type='button';button.addEventListener('click',()=>act('understand'));controls.append(button);
      }
    }
    for(const id of ['level-back','level-forward'])$(id).disabled=busy||saveBusy;
    $('chat-input').disabled=busy||saveBusy;
    $('send-message').disabled=busy || saveBusy || !$('chat-input').value.trim();
  }
  async function request(path,body) {
    const options={headers:{'Accept':'application/json'},credentials:'same-origin'};
    if (body) {options.method='POST'; options.headers['Content-Type']='application/json';options.body=JSON.stringify(body);}
    const response=await fetch(path,options);
    let result;
    try {result=await response.json();} catch (_) {throw new Error(t('error'));}
    if (!response.ok) {const error=new Error(actionError(result));error.status=response.status;throw error;}
    if (!result.game || !result.progress) throw new Error(t('error'));
    return result;
  }
  function accept(next) {
    if(state&&next.progress.revision<state.progress.revision)return;
    state=next;applyInterface();
    const connected=state.connection?.available !== false && state.connection?.authenticated === true;
    $('connection-check').dataset.ready=String(connected);
    const connectionLabel=state.connection?.available===false?t('aiUnavailable'):state.connection?.authenticated===false?t('aiCheckLogin'):connected?t('aiConnected'):t('aiReady');
    $('connection-state').textContent=connectionLabel;
    $('connection-check').title=language()==='中文' ? t('checkConnection')+' · '+connectionLabel : state.connection?.message||t('checkConnection');
    renderForest();renderLevel();renderSaves();renderUndo();schedulePrefetch();
  }
  let prefetchTimer;
  function prefetchLevel(){
    if(busy||saveBusy||languageBusy||!state||document.hidden)return null;
    const {next}=levelStatus();
    // Keep the guide's opening ready without displaying it in Regular chat.
    if(next&&!levelState(next.id).messages?.length&&(!$('level-dialog').open||!levelState(next.id).chat?.messages?.length))return next.id;
    if(currentLevel&&chatMode()==='guide'&&$('level-dialog').open&&levelState(currentLevel).phase==='step'&&!completed().has(currentLevel))return currentLevel;
    return null;
  }
  function schedulePrefetch(){
    clearTimeout(prefetchTimer);
    const levelId=prefetchLevel();if(!levelId)return;
    prefetchTimer=setTimeout(()=>{
      if(prefetchLevel()===levelId)request('/api/action',{action:'prefetch',level_id:levelId,mode:chatMode(levelId),expected_revision:state.progress.revision}).catch(()=>{});
    },200);
  }
  function undoButton(targetId){
    const button=element('button','undo-message-button');button.type='button';
    const label=t('withdraw');
    button.title=label;button.setAttribute('aria-label',label);button.disabled=undoBusy;
    const icon=svgEl('svg',{viewBox:'0 0 24 24',width:17,height:17,'aria-hidden':'true'});
    icon.append(svgEl('path',{d:'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12',fill:'none',stroke:'currentColor','stroke-width':1.8,'stroke-linecap':'round','stroke-linejoin':'round'}));
    button.append(icon);button.addEventListener('click',()=>withdrawMessage(targetId));return button;
  }
  function undoTarget(){
    if(pendingSend)return {id:pendingSend.target_id,action:'message',level_id:pendingSend.level_id,mode:pendingSend.mode};
    return state?.undo;
  }
  function renderUndo(){
    for(const id of ['undo-map','undo-level'])$(id).disabled=undoBusy||saveBusy||!undoTarget();
  }
  async function withdrawMessage(targetId=undoTarget()?.id){
    if(undoBusy||!state||!targetId)return;
    const target=undoTarget();
    if(target?.id!==targetId)return;
    undoBusy=true;++actionEpoch;clearTimeout(prefetchTimer);pendingSend=null;
    busy=true;pendingLabel='saving';state.pending_message=null;renderLevel();renderUndo();
    const requestId=crypto.randomUUID();
    try{
      let result;
      for(let attempt=0;attempt<2;attempt++){
        try{result=await request('/api/action',{action:'undo_action',target_id:targetId,expected_revision:state.progress.revision,request_id:requestId});break;}
        catch(error){
          if(error.status!==409||attempt)throw error;
          accept(await request('/api/game'));
          if(state.undo?.id!==targetId)throw error;
        }
      }
      busy=false;pendingLabel='';undoBusy=false;failedRequest=null;accept(result);
      if(target.action==='message'){
        const id=target.level_id;
        const input=$('chat-input');
        const draft=(target.mode==='chat'?levelState(id).chat:levelState(id))?.draft||'';
        await openLevel(id,{startGuide:false});
        conversationDrafts.set(id+':'+target.mode,draft);
        input.value=draft;input.disabled=false;input.focus();input.setSelectionRange(input.value.length,input.value.length);
        $('send-message').disabled=!input.value.trim();
      }else if(currentLevel&&$('level-dialog').open){
        if(!levelStatus().available.has(currentLevel)||target.action==='start'&&currentLevel===target.level_id)closeLevel();
        else{
          $('chat-input').value=conversationDrafts.get(currentLevel+':'+chatMode())??conversationState().draft??'';
          renderLevel();
        }
      }
      notice('level-error','');notice('global-error','');await flushNavigation();
    }catch(error){
      busy=false;pendingLabel='';undoBusy=false;
      try{accept(await request('/api/game'));}catch(_){}
      notice($('level-dialog').open?'level-error':'global-error',error.message);renderUndo();await flushNavigation();
    }
  }
  async function act(action,extras={}) {
    if (busy || saveBusy || languageBusy || !state) return false;
    if (action!=='connection' && !currentLevel) return false;
    const levelId=currentLevel, mode=chatMode(), wasComplete=completed().has(levelId);
    const epoch=++actionEpoch;
    busy=true; pendingLabel=['complete','understand_all','mode'].includes(action)?'saving':action==='message'&&chatMode()==='chat'?'thinking':'waiting';
    notice('level-error','');notice('global-error','');
    renderForest();renderLevel();renderSaves();
    const signature=JSON.stringify({level_id:currentLevel,action,mode:chatMode(),...extras,revision:state.progress.revision});
    const requestId=failedRequest?.signature===signature?failedRequest.request_id:crypto.randomUUID();
    if(action==='message'){pendingSend={level_id:currentLevel,mode:chatMode(),message:extras.message,target_id:requestId};renderLevel();renderUndo();}
    try {
      const result=await request('/api/action',{level_id:currentLevel,action,mode:chatMode(),expected_revision:state.progress.revision,request_id:requestId,...extras});
      if(epoch!==actionEpoch)return false;
      pendingSend=null;busy=false;pendingLabel='';failedRequest=null;
      if(action==='message'){
        conversationDrafts.delete(levelId+':'+mode);
        if(currentLevel===levelId&&chatMode()===mode)$('chat-input').value='';
      }
      accept(result);
      if(!await flushNavigation()){
        if(!wasComplete&&completed().has(levelId))closeLevel();
        else schedulePrefetch();
      }
      return true;
    } catch (error) {
      if(epoch!==actionEpoch)return false;
      pendingSend=null;busy=false;pendingLabel='';failedRequest={signature,request_id:requestId};
      if (error.status===409) {
        try {accept(await request('/api/game'));} catch (_) { /* Preserve local transcript if refresh fails. */ }
      }
      renderForest();renderLevel();renderSaves();
      notice($('level-dialog').open?'level-error':'global-error',error.message);
      await flushNavigation();return false;
    }
  }
  function renderSaves(){
    const rows=$('save-list');if(!rows||!state)return;
    rows.replaceChildren();
    for(const record of state.saves||[]){
      const row=element('li','save-record');
      const info=element('div','save-info');
      const date=new Date(record.created_at);
      const label=record.label==='Manual save'?t('manualSave'):record.error?t('unreadableSave'):record.label||t('savedGame');
      info.append(element('strong','',label),element('span','',Number.isNaN(date.getTime())?String(record.created_at||''):date.toLocaleString(document.documentElement.lang)));
      if(Number.isInteger(record.completed_count))info.append(element('span','',words().levelsComplete(record.completed_count,levels().length)));
      const controls=element('div','save-record-actions');
      const load=element('button','plain-button',t('load'));load.type='button';load.disabled=busy||saveBusy;load.setAttribute('aria-label',t('load')+' '+label);load.addEventListener('click',()=>saveAction('save_load',{save_id:record.id}));
      const download=element('a','plain-button',t('download'));download.href='/api/saves/'+encodeURIComponent(record.id)+'/download';download.download='proof2game-save.json';download.setAttribute('aria-label',t('download')+' '+label);
      const remove=element('button','plain-button save-delete',t('remove'));remove.type='button';remove.disabled=busy||saveBusy;remove.setAttribute('aria-label',t('remove')+' '+label);remove.addEventListener('click',()=>saveAction('save_delete',{save_id:record.id}));
      controls.append(load,download,remove);row.append(info,controls);rows.append(row);
    }
    if(!(state.saves||[]).length)rows.append(element('li','empty-message',t('emptySaves')));
    for(const id of ['undo-map','undo-level'])$(id).addEventListener('click',()=>withdrawMessage());
  for(const id of ['save-game','save-game-level','save-game-dialog','import-save'])$(id).disabled=busy||saveBusy||languageBusy;
    $('save-upload').disabled=busy||saveBusy||languageBusy;
    renderLanguageMenus();
  }
  async function openSaves(){
    if(!state||saveBusy)return;
    notice('save-error','');notice('save-status','');renderSaves();
    if(!$('save-dialog').open)$('save-dialog').showModal();
    try{
      const response=await fetch('/api/saves',{headers:{Accept:'application/json'},credentials:'same-origin'});
      const result=await response.json();if(!response.ok)throw new Error(actionError(result,'saveListError'));
      state.saves=result.saves||[];renderSaves();
    }catch(error){notice('save-error',error.message);}
  }
  async function saveAction(action,extras={}){
    if(!state||busy||saveBusy||languageBusy)return false;
    const restoring=['save_load','save_import'].includes(action);
    const epoch=++actionEpoch;
    saveBusy=true;clearTimeout(prefetchTimer);pendingSend=null;failedRequest=null;renderForest();renderLevel();renderSaves();
    notice('save-error','');notice('save-status','');
    try{
      const result=await request('/api/action',{action,expected_revision:state.progress.revision,request_id:crypto.randomUUID(),...extras});
      if(epoch!==actionEpoch)return false;
      if(restoring){
        closeLevel({keepPending:true});currentLevel=null;conversationDrafts.clear();forestViewInitialized=false;
        window.history.replaceState(null,'','/');
      }
      saveBusy=false;accept(result);
      if(restoring){$('save-dialog').close();notice('global-error','');}
      else if(action==='save_create'){const label=words().savedCount((result.saves||[]).length);notice('save-status',label);notice('save-toast',label);$('level-save-status').textContent=label;}
      else notice('save-status',t('saveDeleted'));
      await flushNavigation();return true;
    }catch(error){
      saveBusy=false;
      if(error.status===409)try{accept(await request('/api/game'));}catch(_){}
      renderForest();renderLevel();renderSaves();notice($('save-dialog').open?'save-error':'global-error',error.message);await flushNavigation();return false;
    }
  }
  async function importSave(){
    const file=$('save-upload').files?.[0];if(!file)return;
    try{
      if(file.size>16*1024*1024)throw new Error(t('saveTooLarge'));
      const save=JSON.parse(await file.text());
      await saveAction('save_import',{save});
    }catch(error){notice('save-error',error instanceof SyntaxError?t('invalidJsonSave'):error.message);}
    finally{$('save-upload').value='';}
  }
  function focusReference(key){
    const anchor=document.getElementById(referenceAnchor(key));
    const target=anchor?.closest('.numbered-equation')||anchor?.closest('.prose-run')||$('level-title');
    target.classList.add('reference-target');
    const scroll=document.querySelector('.component-scroll');
    if(anchor)scroll.scrollTop+=target.getBoundingClientRect().top-scroll.getBoundingClientRect().top-12;
  }
  async function openLevel(id,options={}) {
    if (busy||saveBusy) return;
    const {available}=levelStatus();
    if(!levels().some(level=>level.id===id))return;
    if (!available.has(id)) {notice('global-error',t('unavailable'));return;}
    if(currentLevel)conversationDrafts.set(currentLevel+':'+chatMode(),$('chat-input').value);
    currentLevel=id;
    const url='/?level='+encodeURIComponent(id)+(options.reference?'&ref='+encodeURIComponent(options.reference):'');
    if(options.historyMode!=='none'&&window.location.pathname+window.location.search!==url)
      window.history[options.historyMode==='replace'?'replaceState':'pushState'](null,'',url);
    $('chat-input').value=conversationDrafts.get(id+':'+chatMode())??conversationState(id).draft??'';
    notice('level-error','');renderLevel();
    if (!$('level-dialog').open) $('level-dialog').showModal();
    $('messages').scrollTop=$('messages').scrollHeight;
    document.querySelector('.component-scroll').scrollTop=0;
    if (options.startGuide!==false&&chatMode()==='guide'&&!levelState(id).messages?.length) await act('start');
    else schedulePrefetch();
    if(currentLevel===id&&$('level-dialog').open&&options.reference)requestAnimationFrame(()=>focusReference(options.reference));
  }
  async function flushNavigation(){
    if(!pendingNavigation||busy||saveBusy)return false;
    const target=pendingNavigation;pendingNavigation=null;
    if(window.location.pathname+window.location.search!==target)window.history.replaceState(null,'',target);
    await navigateFromLocation();return true;
  }
  async function navigateFromLocation(){
    if(!state)return;
    if(busy||saveBusy){pendingNavigation=window.location.pathname+window.location.search;return;}
    pendingNavigation=null;
    const query=new URLSearchParams(window.location.search),id=query.get('level');
    if(!id){closeLevel({historyMode:'none'});return;}
    if(!levelStatus().available.has(id)){
      closeLevel({historyMode:'none'});notice('global-error',t('lockedError'));return;
    }
    await openLevel(id,{historyMode:'none',reference:query.get('ref')});
  }
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('a.internal-reference');
    if(!link||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();if(busy||saveBusy)return;
    const query=new URL(link.href,window.location.href).searchParams;
    openLevel(query.get('level'),{reference:query.get('ref')});
  });
  window.addEventListener('popstate',()=>navigateFromLocation());
  $('level-back').addEventListener('click',()=>{if(!busy&&!saveBusy)window.history.back();});
  $('level-forward').addEventListener('click',()=>{if(!busy&&!saveBusy)window.history.forward();});
  const mapView=$('map-scroll');let mapPan=null,suppressMapClick=false;
  mapView.addEventListener('pointerdown',event=>{
    if(event.pointerType!=='mouse'||event.button!==0)return;
    mapPan={id:event.pointerId,x:event.clientX,y:event.clientY,left:mapView.scrollLeft,top:mapView.scrollTop,moved:false};
  });
  window.addEventListener('pointermove',event=>{
    if(!mapPan||event.pointerId!==mapPan.id)return;
    if(!(event.buttons&1)){endMapPan(event);return;}
    const dx=event.clientX-mapPan.x,dy=event.clientY-mapPan.y;
    if(!mapPan.moved){
      if(Math.hypot(dx,dy)<5)return;
      mapPan.moved=true;suppressMapClick=true;mapView.setPointerCapture(event.pointerId);mapView.classList.add('is-panning');
    }
    event.preventDefault();mapView.scrollLeft=mapPan.left-dx;mapView.scrollTop=mapPan.top-dy;
  });
  function endMapPan(event){
    if(!mapPan||event.pointerId!==mapPan.id)return;
    const id=mapPan.id;mapPan=null;mapView.classList.remove('is-panning');
    if(mapView.hasPointerCapture(id))mapView.releasePointerCapture(id);
    setTimeout(()=>{suppressMapClick=false;},0);
  }
  window.addEventListener('pointerup',endMapPan);
  window.addEventListener('pointercancel',endMapPan);
  mapView.addEventListener('lostpointercapture',endMapPan);
  mapView.addEventListener('click',event=>{
    if(suppressMapClick&&event.detail){event.preventDefault();event.stopImmediatePropagation();suppressMapClick=false;}
  },true);
  async function switchMode(mode){
    if(busy||saveBusy||!state||mode===chatMode())return;
    const levelId=currentLevel;
    conversationDrafts.set(currentLevel+':'+chatMode(),$('chat-input').value);
    if(!await act('mode',{mode})||currentLevel!==levelId||!$('level-dialog').open)return;
    $('chat-input').value=conversationDrafts.get(currentLevel+':'+mode)??conversationState().draft??'';
    renderLevel();
    if(mode==='guide'&&!levelState(currentLevel).messages?.length)await act('start');
    else $('chat-input').focus();
  }
  for(const id of ['undo-map','undo-level'])$(id).addEventListener('click',()=>withdrawMessage());
  for(const id of ['save-game','save-game-level','save-game-dialog'])$(id).addEventListener('click',()=>saveAction('save_create'));
  for(const id of ['open-saves','open-saves-level'])$(id).addEventListener('click',openSaves);
  $('close-saves').addEventListener('click',()=>$('save-dialog').close());
  $('import-save').addEventListener('click',()=>$('save-upload').click());
  $('save-upload').addEventListener('change',importSave);
  $('mode-guide').addEventListener('click',()=>switchMode('guide'));
  $('mode-chat').addEventListener('click',()=>switchMode('chat'));
  for(const id of ['language-map','language-level'])$(id).addEventListener('change',()=>switchLanguage($(id).value));
  $('understand-all').addEventListener('click',()=>act('understand_all'));
  $('connection-check').addEventListener('click',()=>act('connection'));
  $('next-level').addEventListener('click',()=>{const {next}=levelStatus();const first=next || levels()[0];if(first){lastFocusedNode=first.id;openLevel(first.id);}});
  function closeLevel(options={}) {
    if(!options.keepPending)pendingNavigation=null;
    clearTimeout(prefetchTimer);
    if(currentLevel)conversationDrafts.set(currentLevel+':'+chatMode(),$('chat-input').value);
    $('level-dialog').close();
    if(options.historyMode!=='none'&&window.location.pathname+window.location.search!=='/')window.history.pushState(null,'','/');
  }
  $('close-level').addEventListener('click',closeLevel);$('close-level-small').addEventListener('click',closeLevel);
  $('level-dialog').addEventListener('cancel',event=>{event.preventDefault();closeLevel();});
  $('level-dialog').addEventListener('close',()=>{clearTimeout(prefetchTimer);const button=[...document.querySelectorAll('.level-node')].find(el=>el.dataset.levelId===lastFocusedNode);button?.focus();schedulePrefetch();});
  $('chat-input').addEventListener('input',()=>{$('send-message').disabled=busy || saveBusy || !$('chat-input').value.trim();});
  // Safari can report compositionend before the commit's Enter keydown.
  // Native IMEs may also identify that key with code 229 rather than isComposing.
  let composing=false,compositionJustEnded=false,compositionTimer;
  const chatInput=$('chat-input');
  chatInput.addEventListener('compositionstart',()=>{
    clearTimeout(compositionTimer);
    composing=true;compositionJustEnded=false;
  });
  chatInput.addEventListener('compositionend',()=>{
    composing=false;compositionJustEnded=true;
    clearTimeout(compositionTimer);
    compositionTimer=setTimeout(()=>{compositionJustEnded=false;},0);
  });
  chatInput.addEventListener('keyup',event=>{
    if(event.key==='Enter'&&!composing)compositionJustEnded=false;
  });
  chatInput.addEventListener('keydown',event=>{
    if(event.key!=='Enter'||event.shiftKey||composing||compositionJustEnded||event.isComposing||event.keyCode===229)return;
    event.preventDefault();
    if(!event.repeat)$('chat-form').requestSubmit();
  });
  $('chat-form').addEventListener('submit',async event=>{
    event.preventDefault();const input=$('chat-input');const message=input.value.trim();if(!message || busy || saveBusy)return;
    // Keep unsent feedback visible if the request fails.
    const levelId=currentLevel,mode=chatMode();
    if(await act('message',{message})&&currentLevel===levelId&&chatMode()===mode){input.value='';$('send-message').disabled=true;if($('level-dialog').open)input.focus();}
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(prefetchTimer);else schedulePrefetch();});
  window.addEventListener('pagehide',()=>clearTimeout(prefetchTimer));
  let resizeTimer;
  window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state)renderForest();},120);});
  window.addEventListener('pageshow',event=>{if(event.persisted)request('/api/game').then(accept).catch(()=>{});});
  request('/api/game').then(async result=>{
    accept(result);await navigateFromLocation();
  }).catch(error=>{notice('global-error',error.message);const loading=$('loading-copy');if(loading)loading.textContent=t('reload');});
})();
