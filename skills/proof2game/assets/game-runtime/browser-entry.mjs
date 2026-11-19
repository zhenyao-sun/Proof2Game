import {loadBrowserGame} from './browser-engine.mjs';
const dialog=document.getElementById('ai-dialog');
const input=document.getElementById('deepseek-key');
window.openProof2GameConnection=()=>{input.value='';if(!dialog.open)dialog.showModal();input.focus();};
try{
  window.proof2gameBrowser=await loadBrowserGame({onMissingKey:window.openProof2GameConnection});
  document.getElementById('ai-key-form').addEventListener('submit',event=>{
    event.preventDefault();
    if(!input.value.trim()){input.setCustomValidity('Enter your API key.');input.reportValidity();return;}
    try{window.proof2gameBrowser.setKey(input.value.trim());input.value='';dialog.close();window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));}
    catch(error){document.getElementById('ai-error').textContent=error.message;}
  });
  input.addEventListener('input',()=>input.setCustomValidity(''));
  document.getElementById('forget-key').addEventListener('click',()=>{window.proof2gameBrowser.setKey('');input.value='';dialog.close();window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
  document.getElementById('close-ai').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{input.value='';document.getElementById('ai-error').textContent='';});
  const result=await window.proof2gameBrowser.request('/api/game');
  if(result.game.paper){
    document.getElementById('paper-title').textContent=result.game.paper.title;
    document.getElementById('paper-byline').textContent=result.game.paper.authors.join(', ')+' · '+result.game.paper.version;
    document.getElementById('paper-credit').hidden=false;
  }
  await import('./app.js');
}catch(error){const target=document.getElementById('global-error');target.hidden=false;target.textContent=error.message;}
