export const IMAGE_MODEL = 'z-image-turbo';
export const IMAGE_ROUND_MS = 120_000;
const endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

export async function generateBailianUrl({fetcher, key, signal, prompt}) {
  const response = await fetcher(endpoint, {
    method:'POST', credentials:'omit', redirect:'error', signal,
    headers:{'Content-Type':'application/json', Authorization:'Bearer '+key},
    body:JSON.stringify({model:IMAGE_MODEL, input:{messages:[{role:'user', content:[{text:prompt}]}]},
      parameters:{size:'1248*832', prompt_extend:false}}),
  });
  const body = await response.json().catch(()=>({}));
  if (!response.ok || body.code || body.error) {
    const code = String(body.code || body.error?.code || '');
    const invalid = response.status===401 || /InvalidApiKey|InvalidAuthentication/i.test(code);
    const balance = response.status===402 || /Arrearage|InsufficientBalance|Insufficient[_ .-]?balance|AccountOverdue/i.test(code);
    const reason = invalid ? 'invalid_key' : balance ? 'balance' : 'temporary';
    const error = new Error(invalid ? 'Bailian rejected this API key.' : balance ? 'Recharge your Bailian account and verify again.' : 'Bailian could not generate the illustration.');
    const retryAfter = response.headers?.get('retry-after');
    const delay = retryAfter==null ? 0 : /^\d+(\.\d+)?$/.test(retryAfter) ? +retryAfter*1000 : Date.parse(retryAfter)-Date.now();
    throw Object.assign(error, {provider:'bailian', status:response.status, reason, delay:Math.max(0,delay||0)});
  }
  const raw = body.output?.choices?.[0]?.message?.content?.find(part=>typeof part.image==='string')?.image;
  const url = new URL(raw);
  if (url.protocol!=='https:' || url.username || url.password || url.port ||
      !/^dashscope-[a-z0-9-]+\.oss-(?:accelerate|cn-[a-z0-9-]+)\.aliyuncs\.com$/.test(url.hostname))
    throw new Error('Unexpected Bailian image location.');
  return url.href;
}

export async function generateBailianImage(options) {
  const url = await generateBailianUrl(options);
  const response = await options.fetcher(url,{credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:options.signal});
  if (!response.ok) throw new Error('The generated image could not be downloaded.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  // z-image-turbo supplies PNG. Never admit executable documents or a remote URL into a save.
  if (bytes.length>8*1024*1024 || bytes.length<24 || ![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))
    throw new Error('Bailian returned an unsupported image.');
  let binary='';
  for (let i=0;i<bytes.length;i+=0x4000) binary+=String.fromCharCode(...bytes.subarray(i,i+0x4000));
  return 'data:image/png;base64,'+btoa(binary);
}

export const drawTool = {type:'function',function:{name:'draw_math_illustration',
  description:'Generate one mathematical illustration for inspection. Send only the objects, relations, directions and labels needed for this picture. Stop once sufficient.',
  parameters:{type:'object',additionalProperties:false,properties:{
    prompt:{type:'string',description:'A self-contained description of the drawing, up to 800 characters.'},
    topic:{type:'string',description:'A short player-facing description of the mathematical subject, in the current language.'},
  },required:['prompt','topic']}}};

export const topicTool = {type:'function',function:{name:'update_learning_topic',
  description:'Update the one-line status when a longer task begins or changes focus. Name the mathematical subject only, in the player’s language, without private reasoning.',
  parameters:{type:'object',properties:{topic:{type:'string'}},required:['topic'],additionalProperties:false}}};

function waitForRetry(delay, signal) {
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);reject(signal.reason);};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},delay);
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
  });
}

// The input signal stays valid through an account pause. Only active network
// attempts have a timer; reconnecting starts the interrupted operation again.
export async function timedRequest(signal,ms,operation) {
  const controller=new AbortController();
  const abort=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  const timer=setTimeout(()=>controller.abort(new DOMException('Request timed out.','TimeoutError')),Math.max(0,ms));
  try{return await operation(controller.signal);}
  finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}

// A prepared choice can contain a tool request. Only a foreground turn calls this function.
export async function finishIllustratedTurn({messages,first,ask,draw,signal,report,roundMs=IMAGE_ROUND_MS}) {
  const candidates=[];
  let choice=first, deadline=0, pausedAt=0, failed=false, finalOnly=false, topic='', statusUpdates=0;
  function paused(value) {
    if(value)pausedAt=Date.now();
    else if(pausedAt){deadline+=Date.now()-pausedAt;pausedAt=0;}
  }
  function remaining(){return Math.max(0,deadline-Date.now());}
  while(choice?.finish_reason==='tool_calls'){
    signal.throwIfAborted();
    const request=choice.message;
    if(finalOnly || !request.tool_calls?.length)throw new Error('Unexpected illustration tool call.');
    messages.push({role:'assistant',content:request.content||null,tool_calls:request.tool_calls,
      ...(typeof request.reasoning_content==='string'?{reasoning_content:request.reasoning_content}:{})});
    let drew=false;
    for(const call of request.tool_calls){
      let result='Use the available results and return the final JSON.';
      let args;
      try{args=JSON.parse(call.function?.arguments);}catch{args=null;}
      if(call.function?.name===topicTool.function.name){
        if(statusUpdates>=2)throw new Error('Unexpected repeated topic update.');
        if(typeof args?.topic==='string' && args.topic.trim()){
          topic=args.topic.replace(/[\r\n]+/g,' ').slice(0,110);report('think',topic);
        }
        statusUpdates++;
        result='Topic displayed. Continue with the player’s request.';
      }else if(!drew && candidates.length<3 && call.function?.name===drawTool.function.name){
        if(!deadline)deadline=Date.now()+roundMs;
        if(remaining()<=0){
          messages.push({role:'tool',tool_call_id:call.id,content:result});
          continue;
        }
        // Review a candidate before generating another even for batched calls.
        drew=true;
        if(typeof args?.prompt!=='string'||!args.prompt.trim()||[...args.prompt].length>800) {
          failed=true;
          result='The drawing prompt was invalid. Give the final text explanation.';
        }else{
          topic=typeof args.topic==='string'?args.topic.replace(/[\r\n]+/g,' ').slice(0,110):'';
          report('draw',topic);
          for(let attempt=0;attempt<2;attempt++){
            try{
              const data=await draw(args.prompt,paused,remaining);
              candidates.push(data);
              result=[{type:'text',text:'Candidate '+candidates.length+'. Inspect the actual image for mathematical accuracy and phone legibility.'},
                {type:'image_url',image_url:{url:data}}];
              break;
            }catch(error){
              if(signal.aborted)throw signal.reason;
              const delay=Math.max(0,error.delay||0);
              if(attempt===1 || delay>=remaining()){
                failed=true;
                result='Image generation failed. Select any suitable earlier results and summarize.';
                break;
              }
              if(delay)await waitForRetry(delay,signal);
            }
          }
        }
      }else if(call.function?.name!==drawTool.function.name){
        throw new Error('Unknown tutor tool.');
      }
      messages.push({role:'tool',tool_call_id:call.id,content:result});
    }
    if(!deadline){
      choice=await ask(messages,true,undefined,undefined,statusUpdates<2);
      continue;
    }
    finalOnly=failed||candidates.length>=3||remaining()<=0;
    if(drew)report('review',topic);
    if(remaining()>0){
      try {
        choice=await ask(messages,!finalOnly,paused,remaining,statusUpdates<2);
        continue;
      }catch(error){
        if(signal.aborted || !(remaining()<=0||error.name==='TimeoutError'))throw error;
      }
    }
    // Time for tools and their review has expired. One text-only synthesis can
    // select suitable images already in the conversation; it cannot order another.
    finalOnly=true;
    messages.push({role:'user',content:'The illustration time budget has expired. Return the final JSON now using any suitable candidates already available.'});
    choice=await ask(messages,false,paused);
  }
  if(choice?.finish_reason!=='stop')throw new Error('The tutor response was incomplete.');
  return {answer:JSON.parse(choice.message.content),candidates,failed};
}

export function selectIllustrations(answer,candidates) {
  const placements=answer.illustrations??[];
  if(!Array.isArray(placements)||placements.length>3)throw new Error('Invalid illustration selection.');
  const paragraphs=Math.max(1,String(answer.message??'').trim().split(/\n\s*\n/).length);
  const seen=new Set();
  return placements.map(item=>{
    if(!item||!Number.isSafeInteger(item.candidate)||!candidates[item.candidate-1]||seen.has(item.candidate)||
      !Number.isSafeInteger(item.after_paragraph)||item.after_paragraph<0||item.after_paragraph>=paragraphs||
      typeof item.alt!=='string'||!item.alt.trim()||item.alt.length>500)throw new Error('Invalid illustration placement.');
    seen.add(item.candidate);
    return {after_paragraph:item.after_paragraph,alt:item.alt,data_url:candidates[item.candidate-1]};
  }).sort((a,b)=>a.after_paragraph-b.after_paragraph);
}
