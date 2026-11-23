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
  let pendingPlayerTurn = null;
  let actionEpoch = 0;
  let undoBusy = false;
  let saveBusy = false;
  let languageBusy = false;
  let pendingNavigation = null;
  let referenceDepth = 0;
  let contentPanel = false;
  const mobileLayout = () => window.innerWidth <= 760;
  const touchComposer = () => mobileLayout() || window.matchMedia?.('(pointer: coarse)')?.matches;
  let forestViewInitialized = false;
  const conversationDrafts=new Map();
  const unsentChatMessages=new Map();
  let editingDuringUndo=null;
  let openingMode=null;
  let pendingViewMode=null;
  let deferredOpening=null;
  let pendingTask=null;
  let pendingTopic=null;
  let guideAsking=false;
  const levelViews=new Map();
  let alignedPassage=null;
  function panelName(){return contentPanel?'content':chatMode();}
  function rememberView(){
    if(!currentLevel || !$('level-dialog').open)return;
    conversationDrafts.set(currentLevel+':'+chatMode(),$('chat-input').value);
    if(!mobileLayout())return;
    const view=levelViews.get(currentLevel)||{positions:{}};
    const panel=panelName();
    view.panel=panel;
    view.positions[panel]=panel==='content'?document.querySelector('.component-scroll').scrollTop:$('messages').scrollTop;
    levelViews.set(currentLevel,view);
  }
  function restorePanelScroll(){
    if(!mobileLayout()||!currentLevel)return;
    const panel=panelName(),view=levelViews.get(currentLevel);
    const scroller=panel==='content'?document.querySelector('.component-scroll'):$('messages');
    scroller.scrollTop=view?.positions[panel]||0;
  }
  function chatMode(id=currentLevel){
    if(pendingViewMode?.levelId===id)return pendingViewMode.mode;
    if(openingMode && openingMode.levelId===id)return openingMode.mode;
    return state?.progress?.levels?.[id]?.mode||'guide';
  }
  function conversationState(id=currentLevel){return chatMode(id)==='chat'?(levelState(id).chat||{messages:[],phase:null}):levelState(id);}
  function undoMessages(){return chatMode()==='chat'?state.chat_undoable_messages:state.undoable_messages;}
  const en={
    local:'Saved on this device',eyebrow:'A LITTLE CURIOSITY. A GROWING FOREST.',journey:'Levels completed',
    available:'Ready to explore',cleared:'Understood',locked:'Not open yet',footer:'Curiosity is the beginning. Understanding is the journey.',
    composerHint:'Ask anything. If it feels easy, ask your guide to take bigger steps.',statement:'Statement',proof:'Proof',
    nextHouse:'Next level',continue:'Continue learning',manuscriptComplete:'Manuscript complete',villageHint:'Drag to explore · Zoom to see the village',understand:'I understand this passage · Continue',
    continueGuide:'Continue to the next passage',passageSaved:'Your confirmation is saved.',
    nextPassageFailed:'The next passage could not be loaded. Please try again.',
    nextPassageKey:'Check your DeepSeek API key in AI Connection.',
    nextPassageBalance:'Your DeepSeek account has insufficient balance.',
    nextPassageLimited:'DeepSeek is receiving too many requests. Please retry in a moment.',
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
    guideWithoutKey:'You can read the level now. Send a question to connect your DeepSeek API key and begin the guide.',
    mobileContent:'Content',mobileGuide:'Guide',mobileChat:'Chat',
    conversation:'AI conversation',conversationMode:'Conversation mode',guideMode:'Step by step guide',chatMode:'Regular chat',
    saveGame:'Save game',savedGames:'Saved games',closeSaves:'Close saved games',saveCurrent:'Save current progress',
    uploadSave:'Upload save',downloadCurrent:'Download current progress',manualSaves:'Manual saves',
    saveDescription:'Save a progress point, load an earlier one, or download it to keep elsewhere. Loading or uploading replaces your current progress and conversations.',
    inputLabel:'Tell the AI what is on your mind',checkConnection:'AI Connection',
    aiUnavailable:'unavailable',aiCheckLogin:'add API key',aiConnected:'connected',aiReady:'ready to connect',
    loading:'Loading the map…',loadingProgress:'Loading Proof2Game…',untitled:'Let understanding grow.',
    reload:'Please restart the game and refresh this page.',level:'Level',seed:'A SEED OF UNDERSTANDING',
    lockedShort:'Locked',lockedError:'This level is locked.',reference:'Reference',formulaSource:'Formula — view source',formulaScroll:'Scroll horizontally for the full formula',
    proofOf:name=>'Proof of '+name,pairedProof:()=> 'Proof location: ',understood:'Understood ✓',assistant:'ASSISTANT',
    chatPlaceholder:'Ask a question…',chatHint:'Ask anything about this mathematics.',chatEmpty:'What would you like to discuss?',notSent:'Not sent',withdrawn:'Withdrawn',
    undo:'Undo last action',withdraw:'Withdraw and edit',load:'Load',download:'Download',remove:'Delete',savedGame:'Saved game',
    manualSave:'Manual save',unreadableSave:'Unreadable save (preserved)',
    emptySaves:'No manual saves yet. Save a progress point to return to it later.',
    levelsComplete:(count,total)=>count+' / '+total+' levels complete',
    savedCount:count=>'Progress saved · '+count+' manual saves',
    saveDeleted:'Deleted',saveUndeleted:'Save restored',undoDelete:'Undo',undoExpired:'The time to undo this deletion has expired.',
    saveLoaded:'Loaded',saveImported:'Imported',saveRecovered:'Previous progress restored',
    recoverLoad:'Restore progress from before loading',recoverImport:'Restore progress from before importing',
    saveQuota:'This device is out of save storage. Download your progress and free space.',
    saveListError:'Could not load saved games.',
    invalidJsonSave:'This is not a valid JSON save file. Your current progress is unchanged.',
    apiError:'The game could not complete this action. Please try again.'
  });
  const zh={
    local:'已保存在此设备',eyebrow:'循着证明理解数学',journey:'已完成关卡',available:'可进入',cleared:'已理解',locked:'尚未开放',
    footer:'按自己的节奏读懂数学。',composerHint:'随时提问，也可以请引导讲快一点或慢一点。',
    statement:'陈述',proof:'证明',nextHouse:'下一关',continue:'继续学习',manuscriptComplete:'全稿已通关',villageHint:'拖动看村落 · 缩放看全景',
    understand:'我理解了这一段 · 继续',doneNote:'本关已完成，仍可继续提问。',
    continueGuide:'继续下一段',passageSaved:'已保存你对本段的确认。',
    nextPassageFailed:'下一段暂时无法加载，请重试。',
    nextPassageKey:'请在 AI 连接中检查 DeepSeek API key。',
    nextPassageBalance:'DeepSeek 账户余额不足。',
    nextPassageLimited:'DeepSeek 请求过于频繁，请稍后重试。',
    waiting:'正在准备下一步…',thinking:'思考中…',saving:'保存中…',error:'连接未完成，请重试。',
    intro:'沿着证明的结构，逐步理解这篇稿件。',hint:'每完成一关，就会开放下一关。',allDone:'已完成全部关卡，可以随时重访。',
    progress:en.progress,progressCaption:done=>done?'已完成全部关卡':'逐关学习',
    placeholder:'哪里还不清楚？也可以告诉引导调整步长。',empty:'我们从这里开始。',you:'你',guide:'逐步引导',
    unavailable:'本关尚未开放。',map:'关卡地图',close:'关闭关卡',send:'发送消息',
    convention:'约定',understandComponent:{convention:'我理解了本关约定',statement:'我理解了本关陈述',proof:'我理解了本关证明'},
    home:'Proof2Game 首页',language:'语言',history:'关卡浏览记录',back:'后退',forward:'前进',
    guideWithoutKey:'可先阅读关卡内容，也可以发送问题，连接你的 DeepSeek API key 后开始逐步引导。',
    mobileContent:'关卡内容',mobileGuide:'逐步引导',mobileChat:'普通聊天',
    conversation:'AI 对话',conversationMode:'对话模式',guideMode:'逐步引导',chatMode:'普通聊天',
    saveGame:'保存游戏',savedGames:'存档',closeSaves:'关闭存档',saveCurrent:'保存当前进度',
    uploadSave:'上传存档',downloadCurrent:'下载当前进度',manualSaves:'手动存档',
    saveDescription:'可保存、载入或下载进度。载入或上传会替换当前的进度和对话。',
    inputLabel:'输入你的问题或想法',checkConnection:'AI Connection · AI 连接',
    aiUnavailable:'不可用',aiCheckLogin:'请配置 API key',aiConnected:'已连接',aiReady:'待连接',
    loading:'正在加载地图…',loadingProgress:'正在加载 Proof2Game…',untitled:'Proof2Game',
    reload:'请重新启动游戏并刷新页面。',level:'关卡',seed:'起点',
    lockedShort:'未解锁',lockedError:'此关尚未解锁。',reference:'引用',formulaSource:'查看公式源码',formulaScroll:'左右滑动查看完整公式',
    proofOf:name=>name+'的证明',pairedProof:()=> '证明位置：',understood:'已理解 ✓',assistant:'助手',
    chatPlaceholder:'输入问题…',chatHint:'可以讨论你感兴趣的内容。',chatEmpty:'你想聊些什么？',notSent:'未发送',withdrawn:'已撤回',
    undo:'撤回上一步',withdraw:'撤回并编辑',load:'载入',download:'下载',remove:'删除',savedGame:'存档',manualSave:'手动存档',
    unreadableSave:'无法读取的存档（已保留）',emptySaves:'还没有手动存档。',
    levelsComplete:(count,total)=>'已完成 '+count+' / '+total+' 关',
    savedCount:count=>'已保存进度 · '+count+' 个手动存档',
    saveDeleted:'已删除',saveUndeleted:'已恢复存档',undoDelete:'撤销',undoExpired:'撤销删除的时间已过。',
    saveLoaded:'已载入',saveImported:'已导入',saveRecovered:'已恢复原进度',
    recoverLoad:'恢复载入前的进度',recoverImport:'恢复导入前的进度',saveQuota:'设备存储空间已满。请下载进度并腾出空间。',
    saveListError:'无法读取存档列表。',
    invalidJsonSave:'这不是有效的 JSON 存档，当前进度未改变。',
    apiError:'游戏未能完成这项操作，请重试。',
    saveMismatch:'此存档与当前游戏版本不匹配，当前进度未改变。',saveMissing:'找不到该存档。',
    changedSnapshot:'稿件文件有改动，请恢复原始游戏文件。',changedReference:'参考文献 PDF 有改动，请恢复原件。',
    progressChanged:'进度已更新，请重试。',checkConnectionError:'无法连接 DeepSeek，请检查网络、API key 和账户余额。'
  };
  Object.assign(en,{ask:'Ask',retryPassage:'Retry next passage',retry:'Retry',confirmStep:'Do you understand this passage?',confirmLevel:'Do you understand this level?',thinkTopic:'Thinking about'});
  Object.assign(zh,{ask:'提问',retryPassage:'重试下一段',retry:'重试',confirmStep:'你理解这一段了吗？',confirmLevel:'你理解这一关了吗？',thinkTopic:'正在梳理'});
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
    link.href=(window.location?.pathname||'/')+'?level='+encodeURIComponent(ref.level_id)+'&ref='+encodeURIComponent(key);
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
      return {id:kind+' '+number,index:match.index,end:match.index+match[0].length};
    });
  }
  function citedReferencePage(ref,text){
    const locations=ref.locations||[];
    const explicit=namedReferenceLocators(text)[0];
    if(explicit&&/^[\s,，:：]*$/.test(text.slice(0,explicit.index))){
      const matches=locations.flatMap(loc=>{
        const label=(loc.label||'').trim();
        const named=namedReferenceLocators(label).find(item=>item.id===explicit.id);
        return named?[{page:loc.page,exact:named.index===0&&named.end===label.length}]:[];
      });
      const exact=matches.filter(match=>match.exact);
      const pages=new Set((exact.length?exact:matches).map(match=>match.page));
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
            const frame=part.display?element('div','equation-frame'):element('span','equation-frame inline-equation-frame');
            frame.append(node);
            node.addEventListener('scroll',()=>updateFormulaEdges(frame,node),{passive:true});
            if(part.equation){
              const row=element('div','numbered-equation'),numbers=element('div','equation-numbers');
              for(const key of part.equation.references){
                const ref=referenceTarget(key);if(!ref)continue;
                const number=internalReferenceLink(key,'('+ref.number+')');number.id=referenceAnchor(key);numbers.append(number);
              }
              row.append(frame,numbers);parent.append(row);
            }else parent.append(frame);
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
    text=String(text || '');
    text=text.replace(/\\begin\{(Theorem|Lemma|Proposition|Corollary|Claim)\}(?:\[([^\]]*)\])?\s*\\label\{([^}]+)\}/g,(_,kind,title,key)=>
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
    const done=completed(), queue=levels(), next=queue.find(level=>!done.has(level.id));
    // Older connectors may advertise locked previews. Only enterable houses appear.
    const available=new Set(queue.filter(level=>state.level_status
      ? ['open','complete'].includes(state.level_status[level.id])
      : done.has(level.id)||level===next).map(level=>level.id));
    return {done,next,available};
  }

  // Fixed manuscript coordinates keep existing roads and houses in place as the village grows.
  function villageLayout(queue) {
    const children=new Map(queue.map(level=>[level.id,[]])), roots=[];
    for (const level of queue) {
      const siblings=children.get(level.parent);
      if (siblings) siblings.push(level); else roots.push(level);
    }
    const positions=new Map();
    let lane=0;
    function place(level,depth) {
      const branch=children.get(level.id);
      const xs=branch.map(child=>place(child,depth+1));
      const x=xs.length?(xs[0]+xs[xs.length-1])/2:lane++*172+86;
      positions.set(level.id,{x,y:-depth*158});
      return x;
    }
    for (const root of roots) {place(root,0);lane+=.35;}
    return positions;
  }
  // Each roofline and footprint identifies a manuscript role, even without colour or a label.
  const houseArt={
    convention:`<path fill="#ffe2a7" d="m18 49 33-13 26 15v23L46 87 18 72z"/>
      <path fill="#d1a373" d="M46 63 77 51v23L46 87z"/>
      <path fill="#cd7554" d="m11 48 13-23 32-12 27 27-36 15-13-18-7 18z"/>
      <path fill="#e99269" d="m24 25 32-12 27 27-36 15z"/>
      <path fill="#fff2c6" d="m12 48 12-23 11 13-10 16z"/>
      <path fill="none" stroke="#a45843" d="m37 23 22 26m-12-29 22 25M22 59l19 8"/>
      <path fill="#705846" d="M26 73V61q5-7 11 4v13z"/>
      <path class="house-window" d="m53 63 13-5v11l-13 5z"/>
      <path fill="#795e4a" d="M79 55h3v27h-3z"/>
      <path fill="#ffe8ad" d="m72 53 14-6 8 3-6 6-16 6z"/>
      <path fill="#916348" d="m49 19 3-1V4h-3z"/>
      <path fill="#e3b657" d="m52 4 13 2-12 6z"/>`,
    statement:`<path fill="#dac7a4" d="m12 70 40-17 33 17-41 19z"/>
      <path fill="#fff0cd" d="m17 64 34-15 30 16-36 16z"/>
      <path fill="#a7b4a2" d="m44 53 34-14v26L44 79z"/>
      <path fill="#e6d5a8" d="m17 43 28 12v24L17 65z"/>
      <path fill="#648e7f" d="m8 42 21-23 38-14 22 25-43 19z"/>
      <path fill="#92b6a0" d="m29 19 38-14 22 25-43 19z"/>
      <path fill="#f5dc9e" d="m8 42 21-23 17 30z"/>
      <path fill="#628071" d="m19 39 10-12 8 17z"/>
      <path fill="#f5dfba" d="m11 44 34 15v5L11 49z"/>
      <path fill="#fcf2d3" d="m16 51 5 2v15l-5-2zm11 5 5 2v16l-5-2zm10 4 5 2v16l-5-2z"/>
      <path class="house-window" d="m51 54 6-3v11l-6 3zm12-5 6-3v11l-6 3z"/>
      <path fill="none" stroke="#4d766b" d="m45 17 17 22m-7-26 17 21"/>`,
    proof:`<path fill="#f2ce92" d="m14 50 40-16 28 16v24L42 89 14 74z"/>
      <path fill="#bc9266" d="m42 62 40-15v27L42 89z"/>
      <path fill="#889daa" d="m8 49 17-23 41-15 18 24-43 19-13-13-7 14z"/>
      <path fill="#a4b6bd" d="m25 26 41-15 18 24-43 19z"/>
      <path fill="#e9c58e" d="m9 49 16-23 16 28z"/>
      <path fill="#ab6e53" d="m58 29 4 3 8-3V9l-5-3-7 3z"/>
      <path fill="#e8a784" d="m57 8 9-4 7 4-10 5z"/>
      <path fill="#825642" d="m72 23 4 2 6-3V12l-5-2-5 2z"/>
      <path class="house-window" d="m18 57 13 6v10l-13-6z"/>
      <path fill="#755b49" d="m52 84 18-7V60l-18 7z"/>
      <path stroke="#cba879" d="m57 68 9 8m-10 2 9-13"/>
      <circle cx="28" cy="44" r="7" fill="#ddb575" stroke="#6e6857" stroke-width="3"/>
      <circle cx="28" cy="44" r="2.5" fill="#596b73"/>`
  };
  function houseIcon(type) {
    const icon=svgEl('svg',{viewBox:'0 0 100 100',class:'house-icon','aria-hidden':'true',focusable:'false'});
    // All paths are bundled artwork. No manuscript text enters this SVG markup.
    icon.innerHTML='<ellipse cx="51" cy="79" rx="43" ry="13" fill="#4a653a" opacity=".13"/>'+
      '<g stroke="#655c49" stroke-width="1.35" stroke-linejoin="round" stroke-linecap="round">'+houseArt[type]+'</g>';
    return icon;
  }
  const readableZoom=.82, focusZoom=1.16;
  const camera={x:0,y:0,zoom:focusZoom};
  let houses=new Map(), roads=[], focusHouse=null, bounds=null, flight=0, villageSignature='';
  function overviewCamera() {
    const view=$('map-scroll');
    return {x:(bounds.left+bounds.right)/2,y:(bounds.top+bounds.bottom)/2,
      zoom:Math.min(.69,view.clientWidth/(bounds.right-bounds.left+115),view.clientHeight/(bounds.bottom-bounds.top+135))};
  }
  function applyCamera() {
    if(!bounds)return;
    const view=$('map-scroll'), forest=$('forest');
    const x=view.clientWidth/2-camera.x*camera.zoom, y=view.clientHeight/2-camera.y*camera.zoom;
    forest.style.transform='translate('+x+'px,'+y+'px) scale('+camera.zoom+')';
    forest.style.setProperty?.('--inverse-zoom',String(1/camera.zoom));
    forest.style.setProperty?.('--label-width',Math.min(330,view.clientWidth-28)+'px');
    for(const [id,house] of houses) {
      const focused=focusHouse===id && camera.zoom>=readableZoom;
      house.button.dataset.focused=String(focused);
      house.label.hidden=!focused;
      if(focused){
        const screenX=x+house.x*camera.zoom,screenY=y+house.y*camera.zoom;
        const half=Math.min(330,view.clientWidth-28)/2;
        const center=Math.max(half+7,Math.min(view.clientWidth-half-7,screenX));
        house.label.style.setProperty?.('--caption-shift',(center-screenX)+'px');
        house.label.dataset.above=String(screenY>view.clientHeight*.68);
      }
    }
  }
  function centerHouse(id,zoom=focusZoom) {
    const house=houses.get(id);
    if(!house)return;
    ++flight;
    focusHouse=id;Object.assign(camera,{x:house.x,y:house.y,zoom});applyCamera();
  }
  function nearestHouse() {
    let best=null,distance=Infinity;
    for(const [id,p] of houses){
      const d=(p.x-camera.x)**2+(p.y-camera.y)**2;
      if(d<distance){best=id;distance=d;}
    }
    focusHouse=best;applyCamera();
  }
  function renderForest() {
    const {done,next,available}=levelStatus(), queue=levels();
    const visibleLevels=queue.filter(level=>available.has(level.id));
    const signature=JSON.stringify([language(),queue.map(level=>[level.id,level.parent]),visibleLevels.map(level=>[level.id,done.has(level.id),levelHeading(level)])]);
    if(signature!==villageSignature || !forestViewInitialized){
      const forest=$('forest'), positions=villageLayout(queue);
      villageSignature=signature;
      houses=new Map();roads=[];bounds=null;
      const svg=svgEl('svg',{width:1,height:1,class:'village-roads','aria-hidden':'true'});
      const scenery=svgEl('g',{'aria-hidden':'true'});
      svg.append(scenery);forest.replaceChildren(svg);
      for (const level of visibleLevels) {
        const p=positions.get(level.id);
        if(!p)continue;
        if(!bounds)bounds={left:p.x,right:p.x,top:p.y,bottom:p.y};
        bounds.left=Math.min(bounds.left,p.x);bounds.right=Math.max(bounds.right,p.x);
        bounds.top=Math.min(bounds.top,p.y);bounds.bottom=Math.max(bounds.bottom,p.y);
        // Cartographic vegetation sits beside a house; only the manuscript contributes roads.
        const grove=svgEl('g',{transform:'translate('+(p.x+59)+' '+(p.y-22)+')',opacity:'.85'});
        grove.innerHTML='<ellipse cx="8" cy="16" rx="17" ry="5" fill="#a5bd92"/><path d="M3 15V-3m12 21V6" stroke="#8b775c" stroke-width="3"/><path d="M-7 2 2-18 12 2z" fill="#759a78"/><path d="M-6-6 2-21 10-6z" fill="#96b58a"/><path d="M8 11 15-6 24 11z" fill="#88a982"/>';
        scenery.append(grove);
        if(available.has(level.parent)){
          const q=positions.get(level.parent);
          const middle=(p.y+q.y)/2;
          const d='M '+q.x+' '+q.y+' C '+q.x+' '+middle+' '+p.x+' '+middle+' '+p.x+' '+p.y;
          const road=svgEl('g',{'class':'village-road','data-from':level.parent,'data-to':level.id});
          for (const cls of ['road-border','road-bed'])road.append(svgEl('path',{d,class:cls,pathLength:1}));
          svg.append(road);
          roads.push({parent:level.parent,child:level.id,element:road});
        }
        const finished=done.has(level.id),button=element('button','level-node village-house '+(finished?'done':'current'));
        button.type='button';button.style.left=p.x+'px';button.style.top=p.y+'px';
        button.dataset.levelId=level.id;button.dataset.kind=level.type;
        const heading=level.type==='convention'?t('convention'):level.statement_number?levelHeading(level).split(' · ')[0]:t(level.type);
        const title=level.type==='convention'?'':localizedLevel(level).title, status=finished?t('cleared'):t('available');
        button.setAttribute('aria-label',[t('level')+' '+levelNumber(level),heading,title,status].filter(Boolean).join(' · '));
        button.append(houseIcon(level.type));
        if(next?.id===level.id)button.append(element('span','next-marker',t('nextHouse')));
        const label=element('span','node-title');label.setAttribute('data-status',status);
        label.append(element('span',title?'node-reference':'node-description',heading));
        if(title)label.append(element('span','node-description',title));
        button.append(label);
        button.addEventListener('click',()=>{
          if(focusHouse!==level.id || camera.zoom<readableZoom){centerHouse(level.id);return;}
          ++flight;lastFocusedNode=level.id;openLevel(level.id,{fromMap:true});
        });
        forest.append(button);houses.set(level.id,{...p,button,label});
      }
      if(bounds && (!forestViewInitialized || !houses.has(focusHouse))){
        if(next && houses.has(next.id))centerHouse(next.id);
        else {focusHouse=null;++flight;Object.assign(camera,overviewCamera());}
      }
      forestViewInitialized=true;
    }
    applyCamera();
    $('progress-count').textContent=words().progress(done.size,queue.length);
    $('progress-fill').style.width=(queue.length?done.size/queue.length*100:0)+'%';
    $('garden-hint').textContent=t('villageHint');
    $('next-level').textContent=t('continue');
    $('next-level').disabled=!next;
    $('next-level').hidden=!next;
    $('map-complete').textContent=t('manuscriptComplete');
    $('map-complete').hidden=Boolean(next)||!queue.length;
  }
  function flyToUnlockedHouse(clearedId) {
    const next=levelStatus().next, destination=next && houses.get(next.id);
    if(!bounds || (next && !destination))return;
    const token=++flight;
    const adjacent=destination?roads.filter(road=>road.child===next.id||road.parent===next.id):[];
    // A future parent can open after several of its children. Show every genuine new road.
    for(const road of adjacent)road.element.classList.add('road-opening');
    const connecting=adjacent.find(road=>road.parent===clearedId||road.child===clearedId)||adjacent[0];
    const start=connecting?houses.get(connecting.parent===next.id?connecting.child:connecting.parent):houses.get(clearedId);
    if(!start)return;
    const end=destination?{x:destination.x,y:destination.y,zoom:focusZoom}:overviewCamera();
    const endFocus=destination?next.id:null;
    if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){
      focusHouse=endFocus;Object.assign(camera,end);applyCamera();return;
    }
    if(!next)houses.get(clearedId)?.button.classList.add('final-house');
    // A newly opened parent may join widely separated branches. Frame every
    // new road before following one of them to the destination.
    let startZoom=focusZoom;
    if(next){
      const points=[destination,...adjacent.map(road=>houses.get(road.parent===next.id?road.child:road.parent))];
      const spanX=Math.max(...points.map(p=>Math.abs(p.x-start.x)));
      const spanY=Math.max(...points.map(p=>Math.abs(p.y-start.y)));
      startZoom=Math.min(.73,mapView.clientWidth/(2*spanX+130),mapView.clientHeight/(2*spanY+150));
    }
    Object.assign(camera,{x:start.x,y:start.y,zoom:startZoom});focusHouse=clearedId;applyCamera();
    let began;
    function frame(now){
      if(token!==flight)return;
      if(began===undefined)began=now;
      const elapsed=Number.isFinite(now)?now-began:1800;
      const t=Math.max(0,Math.min(1,(elapsed-350)/820));
      const eased=t*t*(3-2*t);
      // The map's cubic road has vertical tangents and its controls at mid-height.
      camera.x=start.x+(end.x-start.x)*eased;
      const along=connecting?(1.5*t-1.5*t*t+t*t*t):eased;
      camera.y=start.y+(end.y-start.y)*along;
      const scaleTime=next?Math.max(0,Math.min(1,(elapsed-950)/420)):eased;
      camera.zoom=startZoom+(end.zoom-startZoom)*scaleTime;
      if(t===1)focusHouse=endFocus;
      applyCamera();
      if(elapsed<1370)requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  function updateFormulaEdges(frame,scroller){
    const overflow=mobileLayout() && scroller.clientWidth>0 && scroller.scrollWidth>scroller.clientWidth+1;
    frame.dataset.fadeLeft=String(overflow && scroller.scrollLeft>1);
    frame.dataset.fadeRight=String(overflow && (scroller.scrollLeft||0)+scroller.clientWidth<scroller.scrollWidth-1);
  }
  let equationCheckPending=false;
  function scheduleEquationCheck(){
    if(equationCheckPending)return;
    equationCheckPending=true;
    requestAnimationFrame(()=>{
      equationCheckPending=false;
      const mobile=mobileLayout();
      for(const frame of document.querySelectorAll('.equation-frame')){
        const scroller=frame.firstElementChild;
        updateFormulaEdges(frame,scroller);
        const overflow=mobile && scroller.clientWidth>0 && scroller.scrollWidth>scroller.clientWidth+1;
        if(overflow){
          const label=t('formulaScroll');
          frame.dataset.scrollHint=label;
          scroller.tabIndex=0;
          scroller.setAttribute('role','region');
          scroller.setAttribute('aria-label',label);
        }else if(frame.hasAttribute('data-scroll-hint')){
          delete frame.dataset.scrollHint;
          scroller.removeAttribute('tabindex');
          scroller.removeAttribute('role');
          scroller.removeAttribute('aria-label');
        }
      }
    });
  }
  document.fonts?.addEventListener('loadingdone',scheduleEquationCheck);
  function renderMobileControls(){
    scheduleEquationCheck();
    const panel = contentPanel ? 'content' : chatMode();
    $('level-dialog').dataset.panel = panel;
    $('level-dialog').dataset.asking=String(guideAsking);
    for (const name of ['content','guide','chat']) {
      const button = $('mobile-'+name);
      button.setAttribute('aria-pressed', String(panel === name));
      button.disabled = saveBusy || languageBusy;
    }
    const history = window.history.state?.referenceNav;
    $('mobile-back').disabled = busy || saveBusy || !history?.depth;
    $('mobile-forward').disabled = busy || saveBusy || !history?.forward;
  }
  function renderLevelHeading(level){
    const title = $('level-title');
    const metadata = $('mobile-level-meta');
    const statement = level.type === 'proof' ? levels().find(item=>item.id===level.paired) : level;
    const proofLink = level.type === 'proof' && Object.entries(state.game.internal_references || {})
      .find(([,ref])=>ref.level_id===level.paired && ref.kind==='statement');
    const citation = statement?.statement_number ? kindName(statement.kind || 'Statement')+' '+statement.statement_number : '';
    const numbered = level.type === 'proof' && citation ? words().proofOf(citation) : citation;
    const mobile = mobileLayout();
    const name = mobile && numbered ? localizedLevel(level).title || '' : levelHeading(level);
    title.textContent = name;
    title.hidden = !name;
    title.classList.remove('reference-target');
    metadata.classList.remove('reference-target');
    metadata.textContent = t('level')+' '+levelNumber(level)+(numbered?' · '+numbered:'');
    $('level-dialog').setAttribute('aria-labelledby',mobile?'mobile-level-meta level-title':'level-title');
    if(proofLink && citation){
      const label = mobile ? metadata : title;
      const full = label.textContent;
      const at = full.indexOf(citation);
      if(at !== -1)label.replaceChildren(document.createTextNode(full.slice(0,at)),
        internalReferenceLink(proofLink[0],citation),document.createTextNode(full.slice(at+citation.length)));
    }
  }
  function sizeComposerInput() {
    const input = $('chat-input');
    input.style.height = '';
    if (mobileLayout() && input.value && !window.CSS?.supports('field-sizing', 'content') && input.scrollHeight) {
      input.style.height = input.scrollHeight + 'px';
    }
  }
  function renderComposer(mode) {
    const mobile = mobileLayout();
    const input = $('chat-input');
    input.rows = mobile ? 1 : 2;
    input.placeholder = t(mobile || mode === 'chat' ? 'chatPlaceholder' : 'placeholder');
    document.querySelector('.composer-hint').textContent = t(mode === 'chat' ? 'chatHint' : 'composerHint');
    requestAnimationFrame(sizeComposerInput);
  }
  function taskVisible(){
    return pendingTask?.levelId===currentLevel && pendingTask.mode===chatMode();
  }
  function topicText(){
    const level=levels().find(item=>item.id===currentLevel);
    const topic=pendingTopic?.topic || (level && levelHeading(level)) || '';
    return t('thinkTopic')+' '+topic;
  }
  function updateTopic(){
    const text=taskVisible()&&pendingLabel!=='saving'?topicText():'',banner=$('tutor-progress');
    let inlineVisible=false;
    const area=$('messages').getBoundingClientRect();
    for(const node of document.querySelectorAll('.guide-actions .pending-message')){
      node.textContent=text;
      const bounds=node.getBoundingClientRect();
      inlineVisible ||= bounds.height>0 && bounds.top>=area.top && bounds.bottom<=area.bottom;
    }
    banner.hidden=!text || inlineVisible;banner.textContent=text;
  }
  $('messages').addEventListener('scroll',()=>{if(pendingTask)updateTopic();},{passive:true});
  window.addEventListener('proof2game-topic',event=>{
    const topic=event.detail;
    if(!pendingTask || !topic || topic.level_id!==pendingTask?.levelId || topic.mode!==pendingTask.mode)return;
    pendingTopic=topic;updateTopic();
  });
  function guideConfirmation(message,index,saved,done,level){
    const block=element('footer','guide-confirmation');
    const avatar=element('img','guide-avatar');avatar.src='./tutor.webp';avatar.alt='';avatar.width=44;avatar.height=44;
    const goal=element('div','local-step-goal math-content'),whole=message.phase==='goal_confirmation';
    const question=message.step_goal || t(whole?'confirmLevel':'confirmStep');
    renderRich(goal,question.replace(/^(\s*)(?:The\s+)?local goal\b/i,'$1The point of this step'),{macroLevelId:level.id});
    const actions=element('div','guide-actions');
    const last=saved.messages.findLastIndex(item=>item.role==='assistant')===index;
    const advancing=last && taskVisible() && ['understand','continue'].includes(pendingTask.action);
    const waiting=last && saved.phase==='awaiting_continuation';
    const reply=saved.messages[index+1];
    const typedConfirmation=reply?.role==='user' && reply.understanding?.kind==='confirm' &&
      reply.understanding.level_id===level.id && ['passage','level'].includes(reply.understanding.scope);
    const confirmed=advancing || waiting || typedConfirmation || saved.messages.some(item=>item.role==='user'&&item.confirms===index) || (whole && done);
    const label=confirmed?t('understood'):whole?words().understandComponent[level.type]:t('understand');
    const button=element('button','understand-button',label);
    button.type='button';button.disabled=confirmed||!last||busy||saveBusy||done;
    button.addEventListener('click',()=>act(whole?'complete':'understand'));actions.append(button);
    if(advancing)actions.append(element('span','pending-message',topicText()));
    else if(waiting && !busy){
      const retry=element('button','plain-button retry-passage',t('retryPassage'));retry.type='button';
      retry.addEventListener('click',()=>act('continue'));actions.append(retry);
    }
    const ask=element('button','plain-button guide-ask',t('ask'));ask.type='button';
    ask.addEventListener('click',()=>{guideAsking=true;renderMobileControls();$('chat-input').focus();});
    actions.append(ask);block.append(avatar,goal,actions);return block;
  }
  function renderLevel() {
    if (!currentLevel || !state) return;
    const level=levels().find(item=>item.id===currentLevel); if (!level) return;
    renderMobileControls();
    const saved=conversationState(),regular=chatMode()==='chat'; const done=completed().has(currentLevel);
    for(const [mode,id] of [['guide','mode-guide'],['chat','mode-chat']]){const tab=$(id);tab.setAttribute('aria-pressed',String(chatMode()===mode));tab.disabled=saveBusy;}
    renderComposer(chatMode());
    renderLevelHeading(level);
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
      image.src='./'+imagePath.split('/').map(encodeURIComponent).join('/');
      image.alt=imagePath.split('/').pop();image.loading='lazy';image.decoding='async';
      figure.append(image,element('figcaption','',image.alt));$('level-images').append(figure);
    }
    const understandAll=$('understand-all');
    understandAll.textContent=done?t('understood'):words().understandComponent[level.type];
    understandAll.disabled=busy||saveBusy||done||!levelStatus().available.has(currentLevel);
    const messages=$('messages'),reading=messages.scrollTop;
    messages.style.paddingBottom='';
    messages.replaceChildren();
    for (const [messageIndex,message] of (saved.messages || []).entries()) {
      const article=element('article',`chat-message ${message.role==='user'?'user':'assistant'}`);
      article.dataset.messageIndex=String(messageIndex);
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
        const content=element('div','message-body math-content');
        renderRich(content,displayedContent.trim(),{macroLevelId:level.id});
        article.append(content);
      }
      if(!regular && message.role==='assistant')article.append(guideConfirmation(message,messageIndex,saved,done,level));
      const undo=undoMessages()?.[currentLevel];
      if(message.role==='user'&&undo?.message_index===messageIndex&&!busy&&!saveBusy){article.classList.add('with-undo');article.append(undoButton(undo.target_id));}
      messages.append(article);
    }
    const activePending=[pendingPlayerTurn,state.pending_message].find(p=>p?.message&&p.level_id===currentLevel&&(p.mode||'guide')===chatMode());
    const pending=activePending||null;
    if(pending){
      const article=element('article','chat-message user pending-user with-undo');
      article.append(element('div','message-label',t('you')));
      const body=element('div','message-body');body.textContent=pending.message;article.append(body,undoButton(pending.target_id));messages.append(article);
    }
    const unsent=regular ? unsentChatMessages.get(currentLevel)||[] : [];
    for(const message of unsent){
      const article=element('article','chat-message user');
      article.append(element('small','',t(message.label)),element('div','message-body',message.text));
      messages.append(article);
    }
    if (!saved.messages?.length && !busy && !unsent.length){
      const empty=regular?'chatEmpty':needsBrowserKey()?'guideWithoutKey':'empty';
      messages.append(element('p','empty-message',t(empty)));
    }
    if(alignedPassage?.levelId===currentLevel && !regular && !contentPanel)reservePassageSpace(alignedPassage.index);
    messages.scrollTop=reading;
    updateTopic();
    const controls=$('step-controls');controls.replaceChildren();
    if(failedRequest && !busy && failedRequest.levelId===level.id && failedRequest.mode===chatMode() &&
       ['start','message'].includes(failedRequest.action)){
      const {action,extras}=failedRequest;
      const retry=element('button','plain-button',t('retry'));
      retry.type='button';retry.addEventListener('click',()=>act(action,extras));controls.append(retry);
    }
    for(const id of ['level-back','level-forward'])$(id).disabled=busy||saveBusy;
    const editingChat=regular && (touchComposer() || openingMode?.levelId===currentLevel || activePending?.nextDraft || editingDuringUndo===currentLevel);
    $('chat-input').disabled=saveBusy || (busy && !editingChat);
    updateSendButton();
  }
  // Keep enough space below a short new passage for its first line to reach
  // the top of the viewport. Other conversations retain their normal spacing.
  function reservePassageSpace(index){
    const messages=$('messages');
    const article=Array.from(messages.children).find(item=>item.dataset.messageIndex===String(index));
    if(!article)return null;
    if(Number.isFinite(article.offsetHeight))messages.style.paddingBottom=Math.max(8,messages.clientHeight-article.offsetHeight-8)+'px';
    return article;
  }
  async function request(path,body) {
    if(window.proof2gameBrowser)return window.proof2gameBrowser.request(path,body);
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
    renderConnectionStatus();
    renderForest();renderLevel();renderSaves();renderUndo();schedulePrefetch();
  }
  function renderConnectionStatus(){
    if(!state)return;
    const connected=state.connection?.available !== false && state.connection?.authenticated === true;
    $('connection-check').dataset.ready=String(connected);
    const connectionLabel=state.connection?.available===false?t('aiUnavailable'):state.connection?.authenticated===false?t('aiCheckLogin'):connected?t('aiConnected'):t('aiReady');
    const providers=state.connection?.providers;
    const labelStatus=window.proof2gameConnectionStatus;
    $('connection-state').textContent=providers&&labelStatus?labelStatus(providers,language()):connectionLabel;
    $('connection-check').title=language()==='中文' ? t('checkConnection')+' · '+connectionLabel : state.connection?.message||t('checkConnection');
  }
  let prefetchTimer;
  function needsBrowserKey(){
    return Boolean(window.proof2gameBrowser && state?.connection?.authenticated===false);
  }
  function shouldStartGuide(){
    return !needsBrowserKey() && chatMode()==='guide' && !levelState(currentLevel).messages?.length;
  }
  function prefetchLevel(){
    if(busy||saveBusy||languageBusy||!state||document.hidden||needsBrowserKey())return null;
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
    button.append(icon);button.addEventListener('mousedown',keepChatEditorFocused);
    button.addEventListener('click',()=>withdrawMessage(targetId));return button;
  }
  function undoTarget(){
    if(pendingPlayerTurn)return {id:pendingPlayerTurn.target_id,action:pendingPlayerTurn.action,level_id:pendingPlayerTurn.level_id,mode:pendingPlayerTurn.mode};
    return state?.undo;
  }
  function renderUndo(){
    for(const id of ['undo-map','undo-level','mobile-undo'])$(id).disabled=undoBusy||saveBusy||!undoTarget();
  }
  function restoreConversationDraft(){
    const draft=conversationDrafts.get(currentLevel+':'+chatMode())??'';
    if(chatInput.value!==draft)chatInput.value=draft;
    sizeComposerInput();updateSendButton();
  }
  function finishOpeningMode(){
    if(!openingMode)return;
    if(currentLevel===openingMode.levelId && chatMode()===openingMode.mode)
      conversationDrafts.set(openingMode.levelId+':'+openingMode.mode,chatInput.value);
    openingMode=null;
  }
  function retainChatMessage(id,label,text){
    if(!text)return;
    const retained=unsentChatMessages.get(id)||[];
    if(!retained.some(item=>item.text===text))retained.push({label,text});
    unsentChatMessages.set(id,retained);
  }
  async function restoreWithdrawnChat(id,withdrawn,allowNavigation){
    const key=id+':chat',dialog=$('level-dialog');
    const sameEditor=currentLevel===id && chatMode()==='chat';
    const next=sameEditor?chatInput.value:conversationDrafts.get(key)||'';
    const keepNext=next!==withdrawn && (next || (sameEditor && composing));
    if(keepNext)retainChatMessage(id,'withdrawn',withdrawn);
    const draft=keepNext?next:withdrawn;
    conversationDrafts.set(key,draft);
    if(sameEditor && chatInput.value!==draft)chatInput.value=draft;
    if(allowNavigation && (!sameEditor || !dialog.open || contentPanel))await openLevel(id,{startGuide:false,panel:'chat'});
    renderLevel();
  }
  async function withdrawMessage(targetId=undoTarget()?.id){
    if(undoBusy||!state||!targetId)return;
    const target=undoTarget();
    if(target?.id!==targetId)return;
    const touchChat=target.action==='message' && target.mode==='chat' && (pendingPlayerTurn?.nextDraft || touchComposer());
    const wasOpen=$('level-dialog').open,wasContent=contentPanel;
    if(touchChat)editingDuringUndo=target.level_id;
    undoBusy=true;++actionEpoch;clearTimeout(prefetchTimer);pendingPlayerTurn=null;pendingTask=null;pendingTopic=null;
    if(openingMode){finishOpeningMode();restoreConversationDraft();}
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
      busy=false;pendingLabel='';undoBusy=false;editingDuringUndo=null;failedRequest=null;accept(result);
      if(target.action==='message'){
        const id=target.level_id;
        const input=$('chat-input');
        const draft=(target.mode==='chat'?levelState(id).chat:levelState(id))?.draft||'';
        if(touchChat){
          const leftPanel=wasOpen && (!$('level-dialog').open || (!wasContent && contentPanel));
          await restoreWithdrawnChat(id,draft,!leftPanel && !pendingNavigation);
        }else{
          await openLevel(id,{startGuide:false,panel:target.mode});
          conversationDrafts.set(id+':'+target.mode,draft);
          input.value=draft;input.disabled=false;input.focus();input.setSelectionRange(input.value.length,input.value.length);
          updateSendButton();
        }
      }else if(currentLevel&&$('level-dialog').open){
        if(!levelStatus().available.has(currentLevel)||target.action==='start'&&currentLevel===target.level_id)closeLevel();
        else{
          restoreConversationDraft();
          renderLevel();
        }
      }
      notice('level-error','');notice('global-error','');await flushNavigation();
    }catch(error){
      busy=false;pendingLabel='';undoBusy=false;editingDuringUndo=null;
      try{accept(await request('/api/game'));}catch(_){}
      notice($('level-dialog').open?'level-error':'global-error',error.message);renderUndo();await flushNavigation();
    }
  }
  async function act(action,extras={}) {
    if (busy || saveBusy || languageBusy || !state) return false;
    if (action!=='connection' && !currentLevel) return false;
    const levelId=currentLevel, mode=chatMode(), wasComplete=completed().has(levelId);
    if(action==='message' && alignedPassage?.levelId===levelId)alignedPassage=null;
    const epoch=++actionEpoch;
    pendingTask={action,levelId,mode};pendingTopic=null;
    busy=true; pendingLabel=['complete','understand_all','mode'].includes(action)?'saving':action==='message'&&chatMode()==='chat'?'thinking':'waiting';
    notice('level-error','');notice('global-error','');
    const signature=JSON.stringify({level_id:currentLevel,action,mode:chatMode(),...extras,revision:state.progress.revision});
    const requestId=failedRequest?.signature===signature?failedRequest.request_id:crypto.randomUUID();
    if(action==='mode'){
      conversationDrafts.set(levelId+':'+mode,chatInput.value);
      openingMode={levelId,mode:extras.mode};
      restoreConversationDraft();
    }
    const matchingDraft=chatInput.value.trim()===extras.message;
    const nextDraft=action==='message' && mode==='chat' && touchComposer()
      ? {sent:matchingDraft?chatInput.value:extras.message,edited:!matchingDraft} : null;
    if(action==='message'||action==='understand'){
      pendingPlayerTurn={action,level_id:levelId,mode,message:extras.message,target_id:requestId,nextDraft};
      if(nextDraft && !nextDraft.edited){
        chatInput.value='';
        conversationDrafts.set(levelId+':'+mode,'');
      }
      renderUndo();
    }
    renderForest();renderLevel();renderSaves();
    try {
      const result=await request('/api/action',{level_id:currentLevel,action,mode:chatMode(),expected_revision:state.progress.revision,request_id:requestId,...extras});
      if(epoch!==actionEpoch)return false;
      finishOpeningMode();
      pendingPlayerTurn=null;pendingTask=null;pendingTopic=null;busy=false;pendingLabel='';failedRequest=null;
      if(action==='message' && mode==='chat' && unsentChatMessages.has(levelId)){
        const retained=unsentChatMessages.get(levelId).filter(item=>item.text.trim()!==extras.message);
        unsentChatMessages.set(levelId,retained);
      }
      if(action==='message' && !nextDraft){
        conversationDrafts.delete(levelId+':'+mode);
        if(currentLevel===levelId&&chatMode()===mode)$('chat-input').value='';
      }
      accept(result);
      if(action==='mode' && currentLevel===levelId)restoreConversationDraft();
      if(['understand','continue'].includes(action) && currentLevel===levelId && $('level-dialog').open && !contentPanel && chatMode()==='guide'){
        const nextIndex=levelState(levelId).messages.findLastIndex(item=>item.role==='assistant');
        alignedPassage={levelId,index:nextIndex};
        const article=reservePassageSpace(nextIndex);
        if(article){
          const messages=$('messages');
          messages.scrollTop+=article.getBoundingClientRect().top-messages.getBoundingClientRect().top;
        }
      }
      if(!await flushNavigation()){
        if(!wasComplete&&completed().has(levelId)){closeLevel();flyToUnlockedHouse(levelId);}
        else schedulePrefetch();
      }
      await flushViewSelection();return true;
    } catch (error) {
      if(epoch!==actionEpoch)return false;
      const passageTurn=action==='understand'||action==='continue';
      if (passageTurn || error.status===409) {
        let latest;
        try {latest=await request('/api/game');} catch (_) { /* Keep the last known progress. */ }
        if(epoch!==actionEpoch)return false;
        if(latest)accept(latest);
      }
      finishOpeningMode();
      pendingPlayerTurn=null;pendingTask=null;pendingTopic=null;busy=false;pendingLabel='';failedRequest={signature,request_id:requestId,levelId,mode,action,extras};
      if(nextDraft?.edited)retainChatMessage(levelId,'notSent',nextDraft.sent);
      if(nextDraft && !nextDraft.edited)conversationDrafts.set(levelId+':'+mode,nextDraft.sent);
      if(currentLevel===levelId && (action==='mode' || (nextDraft && !nextDraft.edited)))restoreConversationDraft();
      renderForest();renderLevel();renderSaves();renderUndo();
      let message=error.message;
      if(passageTurn && levelState(levelId).phase==='awaiting_continuation'){
        const cause=window.proof2gameBrowser && {401:'nextPassageKey',402:'nextPassageBalance',429:'nextPassageLimited'}[error.status];
        message=t('passageSaved')+' '+t(cause||'nextPassageFailed');
      }
      notice($('level-dialog').open?'level-error':'global-error',message);
      await flushNavigation();await flushViewSelection();return false;
    }
  }
  function downloadSave(link,route){
    if(!window.proof2gameBrowser)return;
    link.addEventListener('click',async event=>{event.preventDefault();try{
      const value=await window.proof2gameBrowser.request(route);
      const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));
      const anchor=document.createElement('a');anchor.href=url;anchor.download='proof2game-save.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){notice('save-error',error.message);}});
  }
  function renderSaves(){
    const rows=$('save-list');if(!rows||!state)return;
    rows.replaceChildren();
    for(const record of state.saves||[]){
      const row=element('li','save-record');
      const info=element('div','save-info');
      const date=new Date(record.created_at);
      const label=record.label==='Manual save'?t('manualSave'):record.label?.startsWith('Manual save · ')?t('manualSave')+' · '+date.toLocaleTimeString(document.documentElement.lang):record.error?t('unreadableSave'):record.label||t('savedGame');
      info.append(element('strong','',label),element('span','',Number.isNaN(date.getTime())?String(record.created_at||''):date.toLocaleString(document.documentElement.lang)));
      if(Number.isInteger(record.completed_count))info.append(element('span','',words().levelsComplete(record.completed_count,levels().length)));
      const controls=element('div','save-record-actions');
      const load=element('button','plain-button',t('load'));load.type='button';load.disabled=busy||saveBusy;load.setAttribute('aria-label',t('load')+' '+label);load.addEventListener('click',()=>saveAction('save_load',{save_id:record.id}));
      const download=element('a','plain-button',t('download'));download.href='/api/saves/'+encodeURIComponent(record.id)+'/download';download.download='proof2game-save.json';downloadSave(download,'/api/saves/'+encodeURIComponent(record.id)+'/download');download.setAttribute('aria-label',t('download')+' '+label);
      const remove=element('button','plain-button save-delete',t('remove'));remove.type='button';remove.disabled=busy||saveBusy;remove.setAttribute('aria-label',t('remove')+' '+label);remove.addEventListener('click',()=>saveAction('save_delete',{save_id:record.id}));
      controls.append(load,download,remove);row.append(info,controls);rows.append(row);
    }
    if(!(state.saves||[]).length)rows.append(element('li','empty-message',t('emptySaves')));
    for(const id of ['save-game','save-game-level','save-game-dialog','import-save'])$(id).disabled=busy||saveBusy||languageBusy;
    $('save-upload').disabled=busy||saveBusy||languageBusy;
    renderLanguageMenus();
  }
  async function openSaves(){
    if(!state||saveBusy)return;
    notice('save-error','');notice('save-status','');renderDeletionNotices();renderSaves();
    if(!$('save-dialog').open)$('save-dialog').showModal();
    try{
      let result;
      if(window.proof2gameBrowser)result=await window.proof2gameBrowser.request('/api/saves');
      else{const response=await fetch('/api/saves',{headers:{Accept:'application/json'},credentials:'same-origin'});result=await response.json();if(!response.ok)throw new Error(actionError(result,'saveListError'));}
      state.saves=result.saves||[];renderSaves();
    }catch(error){notice('save-error',error.message);}
  }
  // Each deletion has its own undo period, including successive deletes in the dialog.
  const deletionNotices=new Map();
  function showSaveUndo(target,message,buttonText,onClick){
    const box=$(target);box.hidden=false;
    const row=element('div','save-notice-action');
    const button=element('button','plain-button',t(buttonText));button.type='button';
    button.addEventListener('click',onClick);row.append(element('span','',t(message)),button);box.append(row);
    return row;
  }
  function showDeleted(recovery){
    if(!recovery)return;
    const row=showSaveUndo('save-status','saveDeleted','undoDelete',async()=>{
      if(await saveAction('save_undelete',{recovery_id:recovery.id})){
        deletionNotices.delete(recovery.id);row.remove();
      }
    });
    deletionNotices.set(recovery.id,row);
    setTimeout(()=>{
      deletionNotices.delete(recovery.id);row.remove();
      if(!$('save-status').textContent)$('save-status').hidden=true;
    },Math.max(0,recovery.expires_at-Date.now()));
  }
  function renderDeletionNotices(){
    const box=$('save-status');
    for(const row of deletionNotices.values())box.append(row);
    if(deletionNotices.size)box.hidden=false;
  }
  async function saveAction(action,extras={}){
    if(!state||busy||saveBusy||languageBusy)return false;
    const restoring=['save_load','save_import','save_recover'].includes(action);
    const epoch=++actionEpoch;
    saveBusy=true;clearTimeout(prefetchTimer);pendingPlayerTurn=null;failedRequest=null;renderForest();renderLevel();renderSaves();
    notice('save-error','');notice('save-status','');renderDeletionNotices();
    try{
      const result=await request('/api/action',{action,expected_revision:state.progress.revision,request_id:crypto.randomUUID(),...extras});
      if(epoch!==actionEpoch)return false;
      if(restoring){
        closeLevel({keepPending:true});currentLevel=null;
        conversationDrafts.clear();unsentChatMessages.clear();levelViews.clear();
        alignedPassage=null;pendingViewMode=null;deferredOpening=null;forestViewInitialized=false;
        window.history.replaceState(null,'',window.location.pathname);
      }
      saveBusy=false;accept(result);
      if(restoring){
        if($('save-dialog').open)$('save-dialog').close();notice('global-error','');notice('save-toast','');
        if(action==='save_recover')notice('save-toast',t('saveRecovered'));
        else{
          const loading=action==='save_load';
          showSaveUndo('save-toast',loading?'saveLoaded':'saveImported',loading?'recoverLoad':'recoverImport',
            ()=>saveAction('save_recover',{recovery_id:result.save_recovery.id}));
        }
      }
      else if(action==='save_create'){const label=words().savedCount((result.saves||[]).length);notice('save-status',label);notice('save-toast',label);$('level-save-status').textContent=label;}
      else if(action==='save_delete')showDeleted(result.save_recovery);
      else notice('save-status',t('saveUndeleted'));
      renderDeletionNotices();
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
      const save=JSON.parse(await file.text());
      await saveAction('save_import',{save});
    }catch(error){notice('save-error',error instanceof SyntaxError?t('invalidJsonSave'):error.message);}
    finally{$('save-upload').value='';}
  }
  function focusReference(key){
    const anchor=document.getElementById(referenceAnchor(key));
    const heading=$('level-title').hidden?$('mobile-level-meta'):$('level-title');
    const target=anchor?.closest('.numbered-equation')||anchor?.closest('.prose-run')||heading;
    target.classList.add('reference-target');
    setTimeout(()=>target.classList.remove('reference-target'),3000);
    const scroll=document.querySelector('.component-scroll');
    if(anchor)scroll.scrollTop+=target.getBoundingClientRect().top-scroll.getBoundingClientRect().top-12;
  }
  async function openLevel(id,options={}) {
    if (saveBusy) return;
    const {available}=levelStatus();
    if(!levels().some(level=>level.id===id))return;
    if (!available.has(id)) {notice('global-error',t('unavailable'));return;}
    if(needsBrowserKey()){
      window.openProof2GameConnection({whenReady:()=>openLevel(id,options)});
      return;
    }
    rememberView();
    currentLevel=id;guideAsking=false;pendingViewMode=null;
    const url=window.location.pathname+'?level='+encodeURIComponent(id)+(options.reference?'&ref='+encodeURIComponent(options.reference):'');
    if(options.historyMode!=='none' && (options.reference || window.location.pathname+window.location.search!==url)){
      const entry = options.reference ? {referenceNav:{depth:referenceDepth+1}} : null;
      if (!options.reference) discardReferenceForward();
      window.history.pushState(entry,'',url);
    }
    referenceDepth = window.history.state?.referenceNav?.depth || 0;
    const source = options.source;
    const panel = source?.panel || options.panel || (options.reference ? 'content' :
      options.fromMap && mobileLayout() ? (levelViews.get(id)?.panel||'guide') : chatMode());
    contentPanel = panel === 'content';
    restoreConversationDraft();
    notice('level-error','');renderLevel();
    if (!$('level-dialog').open) {
      $('level-dialog').showModal();
      if (mobileLayout()) $('mobile-'+panel).focus({preventScroll:true});
    }
    $('messages').scrollTop=mobileLayout()?0:$('messages').scrollHeight;
    document.querySelector('.component-scroll').scrollTop=0;
    if(panel!=='content' && panel!==chatMode()){
      if(busy){pendingViewMode={levelId:id,mode:panel,navigation:true};restoreConversationDraft();renderLevel();}
      else if(!await act('mode',{mode:panel,navigation:true}) || currentLevel!==id || !$('level-dialog').open)return;
    }
    restorePanelScroll();
    if (options.startGuide!==false && !source && (!contentPanel || !mobileLayout()) && shouldStartGuide()){
      if(busy)deferredOpening=id;
      else await act('start');
    }
    else schedulePrefetch();
    if (source || options.reference) requestAnimationFrame(()=>{
      if(currentLevel!==id || !$('level-dialog').open)return;
      if(source){
        document.querySelector('.component-scroll').scrollTop = source.reading;
        $('messages').scrollTop = source.messages;
      }else focusReference(options.reference);
    });
  }
  function discardReferenceForward(){
    const entry = window.history.state;
    if(entry?.referenceNav?.forward){
      window.history.replaceState({...entry,referenceNav:{depth:entry.referenceNav.depth}},'',window.location.href);
    }
  }
  async function flushNavigation(){
    if(!pendingNavigation||busy||saveBusy)return false;
    const target=pendingNavigation;pendingNavigation=null;
    if(window.location.pathname+window.location.search!==target.url)window.history.replaceState(target.entry,'',target.url);
    await navigateFromLocation(true);return true;
  }
  async function navigateFromLocation(fromHistory=false){
    if(!state)return;
    if(busy||saveBusy){pendingNavigation={url:window.location.pathname+window.location.search,entry:window.history.state};return;}
    pendingNavigation=null;
    const query=new URLSearchParams(window.location.search),id=query.get('level');
    if(!id){referenceDepth=0;closeLevel({historyMode:'none'});return;}
    if(!levelStatus().available.has(id)){
      closeLevel({historyMode:'none'});notice('global-error',t('lockedError'));return;
    }
    const entry=window.history.state?.referenceNav;
    const source=fromHistory && entry && entry.depth < referenceDepth ? entry.source : null;
    await openLevel(id,{historyMode:'none',reference:query.get('ref'),source});
  }
  document.addEventListener('click',event=>{
    const link=event.target.closest?.('a.internal-reference');
    if(!link||event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;
    event.preventDefault();if(busy||saveBusy)return;
    const query=new URL(link.href,window.location.href).searchParams;
    if(!levelStatus().available.has(query.get('level')))return;
    const source = {
      panel:link.closest('#messages') ? chatMode() : 'content',
      reading:document.querySelector('.component-scroll').scrollTop,
      messages:$('messages').scrollTop
    };
    window.history.replaceState({referenceNav:{depth:referenceDepth,forward:true,source}},'',window.location.href);
    openLevel(query.get('level'),{reference:query.get('ref')});
  });
  window.addEventListener('popstate',()=>navigateFromLocation(true));
  $('mobile-back').addEventListener('click',()=>{if(!$('mobile-back').disabled)window.history.back();});
  $('mobile-forward').addEventListener('click',()=>{if(!$('mobile-forward').disabled)window.history.forward();});
  $('level-back').addEventListener('click',()=>{if(!busy&&!saveBusy)window.history.back();});
  $('level-forward').addEventListener('click',()=>{if(!busy&&!saveBusy)window.history.forward();});
  const mapView=$('map-scroll'), mapPointers=new Map();
  let mapDragged=false, ignoreHouseClick=false, pinchDistance=0, pinchCenter=null;
  function mapPoint(event) {
    const rect=mapView.getBoundingClientRect();
    return {x:event.clientX-rect.left-mapView.clientWidth/2,y:event.clientY-rect.top-mapView.clientHeight/2};
  }
  function zoomAt(factor,from,to=from){
    if(!bounds)return;
    const zoom=Math.max(overviewCamera().zoom*.76,Math.min(2.35,camera.zoom*factor));
    camera.x+=from.x/camera.zoom-to.x/zoom;camera.y+=from.y/camera.zoom-to.y/zoom;
    camera.zoom=zoom;applyCamera();
  }
  function panBy(horizontal,vertical) {
    // Keep some village ground within reach even when the completed map has no Continue button.
    const marginX=mapView.clientWidth*.28/camera.zoom,marginY=mapView.clientHeight*.28/camera.zoom;
    camera.x=Math.max(bounds.left-marginX,Math.min(bounds.right+marginX,camera.x+horizontal/camera.zoom));
    camera.y=Math.max(bounds.top-marginY,Math.min(bounds.bottom+marginY,camera.y+vertical/camera.zoom));
    applyCamera();
  }
  function twoFingerGesture(){
    const [a,b]=[...mapPointers.values()].map(pointer=>pointer.at);
    return {distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),center:{x:(a.x+b.x)/2,y:(a.y+b.y)/2}};
  }
  mapView.addEventListener('pointerdown',event=>{
    if(event.button!==0 || !bounds)return;
    ++flight;
    const at=mapPoint(event);
    if(!mapPointers.size){mapDragged=false;ignoreHouseClick=false;}
    mapPointers.set(event.pointerId,{at,start:at});
    if(mapPointers.size===2){
      const gesture=twoFingerGesture();pinchDistance=gesture.distance;pinchCenter=gesture.center;
      mapDragged=ignoreHouseClick=true;
      for(const id of mapPointers.keys())mapView.setPointerCapture(id);
    }
  });
  window.addEventListener('pointermove',event=>{
    const pointer=mapPointers.get(event.pointerId);
    if(!pointer)return;
    const old=pointer.at;pointer.at=mapPoint(event);
    if(mapPointers.size>=2){
      const gesture=twoFingerGesture();
      zoomAt(gesture.distance/pinchDistance,pinchCenter,gesture.center);
      pinchDistance=gesture.distance;pinchCenter=gesture.center;
    }else{
      if(!mapDragged){
        if(Math.hypot(pointer.at.x-pointer.start.x,pointer.at.y-pointer.start.y)<5)return;
        mapDragged=ignoreHouseClick=true;
        mapView.setPointerCapture(event.pointerId);mapView.classList.add('is-panning');
      }
      panBy(old.x-pointer.at.x,old.y-pointer.at.y);
    }
    event.preventDefault();
  });
  function endMapPointer(event){
    if(!mapPointers.delete(event.pointerId))return;
    if(mapView.hasPointerCapture(event.pointerId))mapView.releasePointerCapture(event.pointerId);
    if(!mapPointers.size){
      mapView.classList.remove('is-panning');
      if(mapDragged)nearestHouse();
    }else if(mapPointers.size>=2){
      const gesture=twoFingerGesture();pinchDistance=gesture.distance;pinchCenter=gesture.center;
    }
  }
  window.addEventListener('pointerup',endMapPointer);
  window.addEventListener('pointercancel',endMapPointer);
  mapView.addEventListener('lostpointercapture',event=>{
    // Touch implicitly captures to the tapped child. Transferring capture to the
    // viewport bubbles a loss from that child; the gesture itself is still active.
    if(event.target===mapView && !mapView.hasPointerCapture(event.pointerId))endMapPointer(event);
  });
  mapView.addEventListener('click',event=>{
    if(ignoreHouseClick && event.detail){event.preventDefault();event.stopImmediatePropagation();}
  },true);
  let wheelEnd=0, wheelKind='', lastWheelAt=0, nativeGesture=0;
  const macPointer=/Mac/.test(window.navigator?.platform||'');
  mapView.addEventListener('wheel',event=>{
    if(!bounds)return;
    event.preventDefault();++flight;
    if(nativeGesture)return;
    const now=Date.now(),dy=event.deltaY;
    // WheelEvent does not identify the device. On macOS, gesture streams have
    // fine pixel deltas; physical wheels usually report lines or 120-unit notches.
    if(now-lastWheelAt>180 || !wheelKind){
      const notches=event.wheelDeltaY && Math.abs(event.wheelDeltaY)%120===0;
      const coarsePixel=Number.isInteger(dy) && Math.abs(dy)>=40 && Math.abs(dy)%10===0;
      wheelKind=event.deltaMode!==0 || !macPointer || (!event.deltaX && (notches||coarsePixel))?'wheel':'pad';
    }
    lastWheelAt=now;
    const at=mapPoint(event);
    if(event.ctrlKey || wheelKind==='wheel'){
      const unit=event.deltaMode===1?16:event.deltaMode===2?mapView.clientHeight:1;
      zoomAt(Math.exp(-Math.min(300,Math.max(-300,dy*unit))*(event.ctrlKey ? .014 : .0035)),at);
    }else{
      panBy(event.deltaX,dy);
    }
    clearTimeout(wheelEnd);wheelEnd=setTimeout(nearestHouse,140);
  },{passive:false});
  // Safari exposes trackpad magnification via GestureEvent on some macOS versions.
  mapView.addEventListener('gesturestart',event=>{
    event.preventDefault();if(mapPointers.size<2){++flight;nativeGesture=event.scale||1;}
  },{passive:false});
  mapView.addEventListener('gesturechange',event=>{
    event.preventDefault();if(!nativeGesture||mapPointers.size>=2)return;
    zoomAt(event.scale/nativeGesture,mapPoint(event));nativeGesture=event.scale;
  },{passive:false});
  mapView.addEventListener('gestureend',event=>{
    event.preventDefault();if(nativeGesture){nativeGesture=0;nearestHouse();}
  },{passive:false});
  mapView.addEventListener('keydown',event=>{
    const movement={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];
    if(!bounds || (!movement && !['+','=','-'].includes(event.key)))return;
    event.preventDefault();++flight;
    if(movement)panBy(movement[0]*72,movement[1]*72);
    else zoomAt(event.key==='-' ? .82 : 1.22,{x:0,y:0});
    nearestHouse();
  });
  async function flushViewSelection(){
    if(busy||saveBusy)return;
    const choice=pendingViewMode,opening=deferredOpening;
    pendingViewMode=null;deferredOpening=null;
    if(!$('level-dialog').open)return;
    if(choice?.levelId===currentLevel && choice.mode!==chatMode()){
      // The editor already shows the newly selected conversation while the
      // previous request finishes. Persist the choice without moving its view.
      openingMode=choice;
      await act('mode',{mode:choice.mode,navigation:choice.navigation||false});
    }
    if(opening===currentLevel && !contentPanel && shouldStartGuide())await act('start');
  }
  async function switchMode(mode){
    if(saveBusy||languageBusy||!state)return;
    const levelId=currentLevel,touch=touchComposer();
    rememberView();contentPanel=false;
    if(mode!==chatMode()){
      guideAsking=false;
      if(busy){
        pendingViewMode={levelId,mode};restoreConversationDraft();renderLevel();restorePanelScroll();
      }else{
        const saving=act('mode',{mode});
        restorePanelScroll();
        if(!await saving || currentLevel!==levelId || !$('level-dialog').open)return;
      }
    }else {renderMobileControls();restorePanelScroll();}
    if(contentPanel || chatMode()!==mode)return;
    if(shouldStartGuide()){
      if(busy)deferredOpening=levelId;
      else await act('start');
    }else if(!touch && !touchComposer() && !busy)$('chat-input').focus();
  }
  $('mobile-content').addEventListener('click',()=>{
    rememberView();contentPanel=true;guideAsking=false;
    renderMobileControls();restorePanelScroll();
  });
  for (const mode of ['guide','chat']){
    $('mobile-'+mode).addEventListener('click',()=>switchMode(mode));
  }
  for(const id of ['undo-map','undo-level','mobile-undo'])$(id).addEventListener('click',()=>withdrawMessage());
  for(const id of ['save-game','save-game-level','save-game-dialog'])$(id).addEventListener('click',()=>saveAction('save_create'));
  for(const id of ['open-saves','open-saves-level'])$(id).addEventListener('click',openSaves);
  $('close-saves').addEventListener('click',()=>$('save-dialog').close());
  $('import-save').addEventListener('click',()=>$('save-upload').click());
  $('save-upload').addEventListener('change',importSave);
  $('mode-guide').addEventListener('click',()=>switchMode('guide'));
  $('mode-chat').addEventListener('click',()=>switchMode('chat'));
  for(const id of ['language-map','language-level'])$(id).addEventListener('change',()=>switchLanguage($(id).value));
  $('understand-all').addEventListener('click',()=>act('understand_all'));
  $('connection-check').addEventListener('click',()=>window.proof2gameBrowser?window.openProof2GameConnection():act('connection'));
  downloadSave($('export-current'),'/api/save/export');
  window.addEventListener('ai-connection-change',event=>{
    if(!state)return;
    state.connection={...state.connection,...event.detail};
    renderConnectionStatus();
    schedulePrefetch();
  });
  window.addEventListener('storage',event=>{
    const engine=window.proof2gameBrowser;
    if(!engine)return;
    engine.syncCredentials?.(event.key);
    if(!event.key||event.key===engine.storageKey)request('/api/game').then(accept).catch(error=>notice('global-error',error.message));
  });
  $('next-level').addEventListener('click',()=>{const {next}=levelStatus();if(next)centerHouse(next.id);});
  function closeLevel(options={}) {
    if(!options.keepPending)pendingNavigation=null;
    clearTimeout(prefetchTimer);
    rememberView();guideAsking=false;
    $('level-dialog').close();
    if(options.historyMode!=='none'&&window.location.search){
      discardReferenceForward();
      window.history.pushState(null,'',window.location.pathname);
      referenceDepth=0;
    }
  }
  $('close-level').addEventListener('click',closeLevel);$('close-level-small').addEventListener('click',closeLevel);
  $('level-dialog').addEventListener('close',()=>{
    if($('level-dialog').open)return;
    clearTimeout(prefetchTimer);
    const button=[...document.querySelectorAll('.level-node')].find(el=>el.dataset.levelId===lastFocusedNode);
    button?.focus({preventScroll:true});schedulePrefetch();
  });
  const chatInput=$('chat-input');
  const sendButton=$('send-message');
  function keepChatEditorFocused(event){
    // Cancel the mouse focus transfer without cancelling the touch pointer sequence.
    // WebKit uses that sequence to activate Send and Undo.
    if(touchComposer() && chatMode()==='chat' && document.activeElement===chatInput && event.button===0)event.preventDefault();
  }
  for(const button of [sendButton,$('mobile-undo'),$('undo-level')])button.addEventListener('mousedown',keepChatEditorFocused);
  let composing=false;
  let selectionKeyDown=false;
  let commitEnterUntil=0;
  let imeEscapeUntil=0;
  $('level-dialog').addEventListener('cancel',event=>{
    event.preventDefault();
    // The dialog's close request can arrive after the editor has ended the composition.
    if(composing || Date.now()<imeEscapeUntil){
      imeEscapeUntil=0;
      return;
    }
    closeLevel();
  });
  function candidateSelectionKey(event){
    return event.key===' ' || /^\d$/.test(event.key) || /^(Space|Digit\d|Numpad\d)$/.test(event.code);
  }
  function updateSendButton(){
    sendButton.disabled=busy || saveBusy || composing || !chatInput.value.trim();
  }
  function endComposition(){
    composing=false;
    // WebKit can deliver the commit Enter in a later task, without any IME flag.
    // Key release ends the guard. Some soft keyboards never send a keyup.
    commitEnterUntil=selectionKeyDown?0:Date.now()+200;
    selectionKeyDown=false;
    updateSendButton();
  }
  chatInput.addEventListener('compositionstart',()=>{
    if(pendingPlayerTurn?.nextDraft && currentLevel===pendingPlayerTurn.level_id && chatMode()==='chat')pendingPlayerTurn.nextDraft.edited=true;
    composing=true;
    imeEscapeUntil=0;
    selectionKeyDown=false;
    commitEnterUntil=0;
    updateSendButton();
  });
  chatInput.addEventListener('compositionend',endComposition);
  chatInput.addEventListener('input',event=>{
    if(pendingPlayerTurn?.nextDraft && currentLevel===pendingPlayerTurn.level_id && chatMode()==='chat')pendingPlayerTurn.nextDraft.edited=true;
    if(event.isComposing)composing=true;
    else if(composing && event.inputType==='insertFromComposition')endComposition();
    sizeComposerInput();
    updateSendButton();
  });
  chatInput.addEventListener('focus',()=>{
    // Blur alone does not commit the marked text. Start a fresh editing session on refocus.
    composing=false;
    imeEscapeUntil=0;
    selectionKeyDown=false;
    commitEnterUntil=0;
    updateSendButton();
    sizeComposerInput();
  });
  chatInput.addEventListener('keyup',event=>{
    if(event.key==='Enter' || event.code==='Enter' || event.code==='NumpadEnter' || candidateSelectionKey(event)){
      selectionKeyDown=false;
      commitEnterUntil=0;
    }
  });
  chatInput.addEventListener('keydown',event=>{
    if(event.key==='Escape' || event.code==='Escape'){
      imeEscapeUntil=composing || event.isComposing || event.keyCode===229 ? Date.now()+200 : 0;
      return;
    }
    if(composing || event.isComposing || event.keyCode===229){
      if(composing)selectionKeyDown=candidateSelectionKey(event);
      return;
    }
    if(event.key!=='Enter'){
      if(event.key.length===1 || event.key==='Backspace')commitEnterUntil=0;
      return;
    }
    if(event.shiftKey)return;
    event.preventDefault();
    if(!event.repeat && Date.now()>=commitEnterUntil)$('chat-form').requestSubmit();
  });
  $('chat-form').addEventListener('submit',async event=>{
    event.preventDefault();
    if(composing || (Date.now()<commitEnterUntil && event.submitter!==sendButton))return;
    const input=chatInput;const message=input.value.trim();if(!message || busy || saveBusy)return;
    if(needsBrowserKey()){window.openProof2GameConnection();return;}
    const levelId=currentLevel,mode=chatMode(),touchChat=touchComposer() && mode==='chat';
    if(mobileLayout() && mode==='guide'){
      input.blur();guideAsking=false;renderMobileControls();
    }
    if(await act('message',{message}) && !(mobileLayout() && mode==='guide') && !touchChat && !(mode==='chat' && touchComposer()) && currentLevel===levelId && chatMode()===mode &&
       $('level-dialog').open && (!mobileLayout() || !contentPanel))input.focus();
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)clearTimeout(prefetchTimer);else schedulePrefetch();});
  window.addEventListener('pagehide',()=>clearTimeout(prefetchTimer));
  // A soft keyboard can resize or pan only the visual viewport. Keep the
  // full-screen level in that rectangle without scrolling or refocusing its editor.
  const visualViewport=window.visualViewport;
  function syncLevelViewport(){
    const style=$('level-dialog').style;
    if(Math.abs(visualViewport.scale-1)>0.01 || !(visualViewport.height>0)){
      style.removeProperty('--level-viewport-height');
      style.removeProperty('--level-viewport-top');
      return;
    }
    style.setProperty('--level-viewport-height',visualViewport.height+'px');
    style.setProperty('--level-viewport-top',Math.max(0,visualViewport.offsetTop)+'px');
  }
  if(visualViewport){
    visualViewport.addEventListener('resize',syncLevelViewport);
    visualViewport.addEventListener('scroll',syncLevelViewport);
    window.addEventListener('resize',syncLevelViewport);
    window.addEventListener('pageshow',syncLevelViewport);
    syncLevelViewport();
  }
  let resizeTimer;
  let wasMobile=mobileLayout();
  window.addEventListener('resize',()=>{
    scheduleEquationCheck();
    if(mobileLayout()!==wasMobile){
      wasMobile=mobileLayout();
      const level=state && levels().find(item=>item.id===currentLevel);
      if(level){
        renderLevelHeading(level);
        renderComposer(chatMode());
      }
    }
    clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>{if(state)renderForest();},120);
  });
  window.addEventListener('pageshow',event=>{if(event.persisted)request('/api/game').then(accept).catch(()=>{});});
  request('/api/game').then(async result=>{
    accept(result);await navigateFromLocation();
  }).catch(error=>{notice('global-error',error.message);const loading=$('loading-copy');if(loading)loading.textContent=t('reload');});
})();
