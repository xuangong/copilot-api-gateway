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
const reasoning=m=>m.reasoning_text??m.reasoning_content??m.reasoning
try {
 const {default:OpenAI}=await import('/tmp/vnext-reference-sdk-probe/node_modules/openai/index.mjs')
 const ai=new OpenAI({apiKey:'raw-key',baseURL:`http://127.0.0.1:${server.port}/v1`})
 for(const id of ['up_chat','up_messages','up_responses']) {
  for(const split of [false,true]) {
   if(split&&id!=='up_chat')continue
   mode=split?'split':'normal'
   const stream=ai.chat.completions.stream({model:`${id}/synthetic-model`,messages:[{role:'user',content:'SDK prompt'}]})
   const completion=await stream.finalChatCompletion(),message=completion.choices[0].message
   assert.equal(reasoning(message),thought,`${id} SDK companion`)
   assert(message.reasoning_opaque.startsWith('vnext-affinity:'))
   await ai.chat.completions.create({model:`${id}/synthetic-model`,messages:[message,{role:'user',content:'SDK replay'}]})
   assert(JSON.stringify(calls.at(-1).body).includes(id==='up_chat'?'synthetic-chat-signature':id==='up_messages'?'synthetic-signature':'synthetic-reasoning'))
   cases.push(`openai6.33.0-${id}-${split?'split':'normal'}-native-aggregate-replay`)
  }
 }
 mode='multiple'
 for(const streaming of [false,true]) {
  const r=await request('gemini','up_chat',streaming);assert.equal(r.status,200,r.text)
  const all=streaming?events(r):[r.json]
  for(const index of [0,1]) {
   const parts=all.flatMap(e=>(e.candidates??[]).filter(c=>c.index===index).flatMap(c=>c.content?.parts??[]))
   const signed=parts.find(p=>p.thoughtSignature)
   assert(signed,`Gemini candidate ${index} signed Part missing`)
   assert.equal(signed.text,`  choice ${index} \n`)
   const replay=await request('gemini','up_chat',false,[{role:'model',parts},{role:'user',parts:[{text:'replay'}]}]);assert.equal(replay.status,200,replay.text)
   assert.equal(calls.at(-1).body.messages[0].reasoning_opaque,`synthetic-multi-${index}`)
  }
  cases.push(`gemini-multiple-candidates-${streaming?'sse':'json'}`)
 }
 mode='normal'
 for(const id of ['up_chat','up_messages','up_responses'])for(const streaming of [false,true]) {
  const response=await fetch(`http://127.0.0.1:${server.port}/v1beta/models/${encodeURIComponent(`${id}/synthetic-model`)}:${streaming?'streamGenerateContent':'generateContent'}`,{method:'POST',headers:{authorization:'Bearer raw-key','content-type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:'synthetic'}]}],generationConfig:{thinkingConfig:{includeThoughts:false}}})})
  const text=await response.text();assert.equal(response.status,200,text);assert(!text.includes('thoughtSignature'),text);assert(!text.includes('Synthetic thought'),text)
  cases.push(`gemini-${id}-${streaming?'sse':'json'}-suppression-no-carrier`)
 }
 for(const protocol of ['chat','gemini']) {
  const r=await request(protocol,'up_chat',false)
  const message=protocol==='chat'?chatMessage(r,false):geminiContent(r,false)
  message.role='user';const before=calls.length
  const bad=await request(protocol,'up_chat',false,[message]);assert(bad.status>=400,bad.text);assert.equal(calls.length,before)
  cases.push(`${protocol}-role-tamper-zero-inference`)
 }
 // Foreign opaque is native upstream state, not a malformed gateway carrier.
 for(const id of ['up_chat','up_messages','up_responses']) {
  const input=[{role:'assistant',content:'visible',reasoning_text:thought,reasoning_opaque:'foreign-native-state'},{role:'user',content:'next'}]
  const r=await request('chat',id,false,input);assert.equal(r.status,200,r.text);assert(JSON.stringify(calls.at(-1).body).includes('foreign-native-state'))
  cases.push(`chat-${id}-foreign-state-preserved`)
 }

 const {AffinityCodec}=await import(`${source}/packages/gateway/src/shared/affinity/carrier.ts`)
 const {stampAffinityItem}=await import(`${source}/packages/gateway/src/shared/affinity/analysis.ts`)
 const secret=await getRepo().apiKeys.getOrCreateAffinitySecret('key','owner')
 const codec=new AffinityCodec({...secret,ownerId:'owner',apiKeyId:'key'})
 const syntheticTarget={provider:'custom',upstreamId:'up_chat',upstreamIncarnation:'synthetic-inc',credentialSubject:'synthetic-subject',credentialRevision:'synthetic-rev',model:'synthetic-model'}
 for(const state of [{functionCall:{id:'call',name:'f',args:{signature:'business'}},thoughtSignature:'required-call'},{inlineData:{mimeType:'image/png',data:'YWJj'},thoughtSignature:'required-image'}]) {
  const signed=await stampAffinityItem('gemini',state,syntheticTarget,codec)
  for(const id of ['up_chat','up_messages','up_responses']) {
   const before=calls.length,r=await request('gemini',id,false,[{role:'model',parts:[signed]},{role:'user',parts:[{text:'next'}]}])
   assert.equal(r.status,503,r.text);assert.equal(calls.length,before)
   cases.push(`gemini-${id}-required-${state.functionCall?'function':'nontext'}-zero-inference`)
  }
 }
 await Promise.all(pending)
 console.log(JSON.stringify({passed:true,runtime:'actual Bun HTTP/SQLite + OpenAI6.33.0',cases,calls:calls.length,scratch}))
} finally {server.stop(true);upstream.stop(true)}
