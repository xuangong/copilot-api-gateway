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
const cases=[]
try {
 for(const protocol of ['chat','gemini'])for(const mode of ['make-compaction','make-agent'])for(const streaming of [false,true]) {
  const input=protocol==='chat'?[{role:'user',content:mode}]:[{role:'user',parts:[{text:mode}]}]
  const r=await request(protocol,'up_responses',streaming,input)
  const frames=streaming?events(r):[]
  assert(r.status>=400||frames.some(e=>e.error||e.type==='error'),'Unrepresentable opaque state silently succeeded')
  assert(!frames.some(e=>(e.choices??[]).some(c=>c.finish_reason==='stop')||(e.candidates??[]).some(c=>c.finishReason==='STOP')),'Success terminal after unsupported opaque state')
  assert(!r.text.includes('synthetic-compaction')&&!r.text.includes('synthetic-agent-opaque'),'Raw unsupported opaque leaked')
  cases.push(`${protocol}-${mode}-${streaming?'sse':'json'}-typed-rejection`)
 }
 await Promise.all(pending)
 console.log(JSON.stringify({passed:true,cases,runtime:'actual Bun HTTP/SQLite nonrepresentable opaque output rejection',scratch}))
} finally {server.stop(true);upstream.stop(true)}
