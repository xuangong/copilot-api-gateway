import assert from 'node:assert/strict'
import {serve} from 'bun'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const source=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
const {initBackground,initSocketDial}=await import(`${source}/packages/platform/src/index.ts`)
const {getRepo}=await import(`${source}/packages/gateway/src/repo/index.ts`)
const {app}=await import(`${source}/packages/gateway/src/app.ts`)
const {synthesizeResponsesFramesFromJson}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`)
const {synthesizeMessagesFramesFromJson}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c01-client-adapters-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const now=new Date().toISOString(),calls=[]
for(const owner of ['owner','foreign'])await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind(owner,owner,`${owner}@example.invalid`,now).run()
for(const [id,owner] of [['key','owner'],['key2','owner'],['foreign-key','foreign']])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind(id,id,`raw-${id}`,now,owner,86400).run()
let serial=0,mode="normal"
const upstream=serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const body=await req.json(),up=new URL(req.url).pathname.split('/')[1];calls.push({up,body})
 if(new URL(req.url).pathname.endsWith('/messages')){
  const result={id:`msg_${++serial}`,type:'message',role:'assistant',model:body.model,content:[{type:'thinking',thinking:'  Synthetic thought \n',signature:'synthetic-signature'},{type:'text',text:'Synthetic answer'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:5,output_tokens:3}}
  if(!body.stream)return Response.json(result)
  let text='';for await(const f of synthesizeMessagesFramesFromJson(result)){if(f.type==='event')text+=`event: ${f.event.type}\ndata: ${JSON.stringify(f.event)}\n\n`}
  return new Response(text,{headers:{'content-type':'text/event-stream'}})
 }
 if(new URL(req.url).pathname.endsWith('/chat/completions')){
  const completion={id:`chat_${++serial}`,object:'chat.completion',created:0,model:body.model,choices:[{index:0,message:{role:'assistant',content:'Synthetic answer',reasoning_content:'  Synthetic thought \n',reasoning_opaque:'synthetic-chat-signature'},finish_reason:'stop'}],usage:{prompt_tokens:5,completion_tokens:3,total_tokens:8}}
  if(mode==='multiple')completion.choices=[0,1].map(index=>({index,message:{role:'assistant',content:`answer-${index}`,reasoning_content:`  choice ${index} \n`,reasoning_opaque:`synthetic-multi-${index}`},finish_reason:'stop'}))
  if(!body.stream)return Response.json(completion)
  if(mode==='multiple')return new Response([{...completion,object:'chat.completion.chunk',choices:completion.choices.map(c=>({index:c.index,delta:c.message,finish_reason:null}))},{...completion,object:'chat.completion.chunk',choices:completion.choices.map(c=>({index:c.index,delta:{},finish_reason:'stop'}))}].map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  if(mode==='split')return new Response([
   {index:0,delta:{role:'assistant',reasoning_content:'  Synthetic '},finish_reason:null},
   {index:0,delta:{reasoning_content:'thought \n',reasoning_opaque:'synthetic-chat-'},finish_reason:null},
   {index:0,delta:{reasoning_opaque:'signature',content:'Synthetic answer'},finish_reason:null},
   {index:0,delta:{},finish_reason:'stop'},
  ].map(choice=>`data: ${JSON.stringify({...completion,object:'chat.completion.chunk',choices:[choice]})}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  const frames=[{...completion,object:'chat.completion.chunk',choices:[{index:0,delta:completion.choices[0].message,finish_reason:null}]},{...completion,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]}]
  return new Response(frames.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
 }
 const inputText=JSON.stringify(body.input??[]),required=inputText.includes('make-compaction'),agent=inputText.includes('make-agent')
 const item=agent?{type:'agent_message',id:`agent_${++serial}`,author:'assistant',recipient:'all',agent:{agent_name:'synthetic-agent'},content:[{type:'text',text:'Synthetic agent context'},{type:'encrypted_content',encrypted_content:'synthetic-agent-opaque'}]}:required?{type:'compaction',id:`cmp_${++serial}`,encrypted_content:'synthetic-compaction'}:{type:'reasoning',id:`rs_${++serial}`,summary:[{type:'summary_text',text:'  Synthetic thought \n'}],encrypted_content:'synthetic-reasoning'}
 const result={id:`resp_fixture_${serial}`,object:'response',model:body.model,output:[item],status:'completed',error:null,incomplete_details:null,usage:{input_tokens:5,output_tokens:3,total_tokens:8}}
 if(!body.stream)return Response.json(result)
 let text='';for await(const f of synthesizeResponsesFramesFromJson(result)){if(f.type==='event')text+=`event: ${f.event.type}\ndata: ${JSON.stringify(f.event)}\n\n`}
 return new Response(text,{headers:{'content-type':'text/event-stream'}})
}})
for(const [id,owner,order,endpoints]of [['up_a','owner',0,['responses','messages']],['up_chat','owner',4,['chat_completions']],['up_b','owner',1,['responses','messages']],['up_foreign','foreign',0,['responses','messages']],['up_responses','owner',2,['responses']],['up_messages','owner',3,['messages']]])await getRepo().upstreams.save({id,ownerId:owner,provider:'custom',name:id,enabled:true,sortOrder:order,config:{name:id,baseUrl:`http://127.0.0.1:${upstream.port}/${id}`,authStyle:'none',endpoints,models:['synthetic-model']},state:{},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[{id:'direct_fetch'}],createdAt:now,updatedAt:now})
const server=serve({hostname:'127.0.0.1',port:0,fetch:req=>app.fetch(req,{})})
const request=async(protocol,id,stream,input,key='key')=>{
 const path=protocol==='chat'?'/v1/chat/completions':`/v1beta/models/${encodeURIComponent(`${id}/synthetic-model`)}:${stream?'streamGenerateContent':'generateContent'}`
 const body=protocol==='chat'?{model:`${id}/synthetic-model`,messages:input??[{role:'user',content:'synthetic'}],stream}:{contents:input??[{role:'user',parts:[{text:'synthetic'}]}],generationConfig:{thinkingConfig:{includeThoughts:true}}}
 const response=await fetch(`http://127.0.0.1:${server.port}${path}`,{method:'POST',headers:{authorization:`Bearer raw-${key}`,'content-type':'application/json'},body:JSON.stringify(body)});const text=await response.text()
 return{status:response.status,text,json:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null}
}
function events(r){return r.text.split('\n').filter(line=>line.startsWith('data: ')&&line!=='data: [DONE]').map(line=>JSON.parse(line.slice(6)))}
function chatMessage(r,stream,index=0){
 if(!stream)return r.json.choices.find(c=>c.index===index).message
 const result={role:'assistant',content:'',reasoning_content:'',reasoning_opaque:''}
 for(const ev of events(r))for(const choice of ev.choices??[])if(choice.index===index){const d=choice.delta??{};result.content+=d.content??'';result.reasoning_content+=d.reasoning_text??d.reasoning_content??d.reasoning??'';result.reasoning_opaque+=d.reasoning_opaque??''}
 return result
}
function geminiContent(r,stream){
 if(!stream)return r.json.candidates[0].content
 return{role:'model',parts:events(r).flatMap(e=>(e.candidates??[]).filter(c=>c.index===0||c.index===undefined).flatMap(c=>c.content?.parts??[]))}
}
const thought='  Synthetic thought \n',cases=[]
try{
 let chatCarrier
 for(const protocol of ['chat','gemini'])for(const id of ['up_chat','up_messages','up_responses'])for(const stream of [false,true]){
  const r=await request(protocol,id,stream);assert.equal(r.status,200,r.text)
  const message=protocol==='chat'?chatMessage(r,stream):geminiContent(r,stream)
  const signed=protocol==='chat'?message:message.parts.find(p=>p.thoughtSignature)
  assert(signed,`${protocol}/${id}/${stream}: missing signed part`)
  const signature=protocol==='chat'?signed.reasoning_opaque:signed.thoughtSignature
  assert(signature?.startsWith('vnext-affinity:'),`${protocol}/${id}/${stream}: no authenticated signature`)
  assert.equal(signature.split('vnext-affinity:').length,2,'Repeated complete envelopes concatenated')
  assert.equal(protocol==='chat'?(signed.reasoning_text??signed.reasoning_content??signed.reasoning):signed.text,thought,'Incomplete companion')
  if(protocol==='gemini')assert.equal(message.parts.filter(p=>p.thought).map(p=>p.text??'').join(''),thought,'Duplicate or partial thought parts')
  const next=protocol==='chat'?[message,{role:'user',content:'keep ordinary visible'}]:[message,{role:'user',parts:[{text:'keep ordinary visible'}]}]
  const replay=await request(protocol,id,false,next);assert.equal(replay.status,200,replay.text)
  const expected=id==='up_chat'?'synthetic-chat-signature':id==='up_messages'?'synthetic-signature':'synthetic-reasoning'
  assert(JSON.stringify(calls.at(-1).body).includes(expected),'Original opaque did not reach upstream')
  assert(JSON.stringify(calls.at(-1).body).includes(JSON.stringify(thought).slice(1,-1)),'Companion whitespace changed')
  for(const key of ['key2','foreign-key']){const n=calls.length,bad=await request(protocol,id,false,next,key);assert(bad.status>=400,bad.text);assert.equal(calls.length,n)}
  const changed=structuredClone(next)
  if(protocol==='chat')changed[0].reasoning_text='tampered';else changed[0].parts.find(p=>p.thoughtSignature).text='tampered'
  const n=calls.length,bad=await request(protocol,id,false,changed);assert(bad.status>=400,bad.text);assert.equal(calls.length,n)
  const degraded=await request(protocol,'up_b',false,next);assert.equal(degraded.status,200,degraded.text);assert(!JSON.stringify(calls.at(-1).body).includes('Synthetic thought'));assert(JSON.stringify(calls.at(-1).body).includes('keep ordinary visible'))
  if(protocol==='chat')chatCarrier=signature
  cases.push(`${protocol}-${id}-${stream?'sse':'json'}-replay-auth-whole-block`)
 }
 const n=calls.length,wrongDomain=await request('gemini','up_chat',false,[{role:'model',parts:[{thought:true,text:thought,thoughtSignature:chatCarrier}]},{role:'user',parts:[{text:'next'}]}]);assert(wrongDomain.status>=400,wrongDomain.text);assert.equal(calls.length,n);cases.push('cross-source-domain-zero-inference')
 mode='multiple'
 for(const stream of [false,true]){
  const r=await request('chat','up_chat',stream);assert.equal(r.status,200,r.text)
  for(const index of [0,1]){
   const message=chatMessage(r,stream,index);assert.equal(message.reasoning_content,`  choice ${index} \n`);assert(message.reasoning_opaque.startsWith('vnext-affinity:'))
   const replay=await request('chat','up_chat',false,[message,{role:'user',content:'next'}]);assert.equal(replay.status,200,replay.text);assert.equal(calls.at(-1).body.messages[0].reasoning_opaque,`synthetic-multi-${index}`)
  }
  cases.push(`chat-${stream?'sse':'json'}-independent-choices`)
 }
 mode='split'
 for(const protocol of ['chat','gemini']){
  const r=await request(protocol,'up_chat',true);assert.equal(r.status,200,r.text)
  const message=protocol==='chat'?chatMessage(r,true):geminiContent(r,true),signed=protocol==='chat'?message:message.parts.find(p=>p.thoughtSignature)
  assert.equal(protocol==='chat'?signed.reasoning_content:signed.text,thought)
  const replay=await request(protocol,'up_chat',false,[message,protocol==='chat'?{role:'user',content:'next'}:{role:'user',parts:[{text:'next'}]}]);assert.equal(replay.status,200,replay.text);assert.equal(calls.at(-1).body.messages[0].reasoning_opaque,'synthetic-chat-signature');cases.push(`${protocol}-split-native-chat-signature`)
 }
 mode='normal'
 const {GoogleGenAI}=await import('/tmp/vnext-c01-google-sdk.1pB76e/node_modules/@google/genai/dist/node/index.mjs')
 const ai=new GoogleGenAI({apiKey:'raw-key',httpOptions:{baseUrl:`http://127.0.0.1:${server.port}`,apiVersion:'v1beta'}})
 for(const id of ['up_chat','up_messages','up_responses']){
  const chat=ai.chats.create({model:`${id}/synthetic-model`,config:{thinkingConfig:{includeThoughts:true}}})
  const stream=await chat.sendMessageStream({message:'synthetic SDK prompt'});for await(const part of stream)assert(part.candidates?.length)
  const history=chat.getHistory(true),parts=history.filter(c=>c.role==='model').flatMap(c=>c.parts??[]),signed=parts.find(p=>p.thoughtSignature)
  assert(signed?.thoughtSignature.startsWith('vnext-affinity:'));assert.equal(signed.text,thought)
  await chat.sendMessage({message:'SDK next turn'});assert(JSON.stringify(calls.at(-1).body).includes(id==='up_chat'?'synthetic-chat-signature':id==='up_messages'?'synthetic-signature':'synthetic-reasoning'))
  cases.push(`google-2.24.0-${id}-native-history-replay`)
 }
 await Promise.all(pending)
 console.log(JSON.stringify({passed:true,runtime:'actual authenticated Bun HTTP + loopback hubs + SQLite + Google2.24.0',cases,calls:calls.length,scratch}))
}finally{server.stop(true);upstream.stop(true)}
