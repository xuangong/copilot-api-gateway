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
const scratch=await mkdtemp(`${tmpdir()}/c01-app-runtime-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const now=new Date().toISOString(),calls=[]
for(const owner of ['owner','foreign'])await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind(owner,owner,`${owner}@example.invalid`,now).run()
for(const [id,owner] of [['key','owner'],['key2','owner'],['foreign-key','foreign']])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind(id,id,`raw-${id}`,now,owner,86400).run()
let serial=0
const upstream=serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const body=await req.json(),up=new URL(req.url).pathname.split('/')[1];calls.push({up,body})
 if(new URL(req.url).pathname.endsWith('/messages')){
  const result={id:`msg_${++serial}`,type:'message',role:'assistant',model:body.model,content:[{type:'thinking',thinking:'  Synthetic thought \n',signature:'synthetic-signature'},{type:'text',text:'Synthetic answer'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:5,output_tokens:3}}
  if(!body.stream)return Response.json(result)
  let text='';for await(const f of synthesizeMessagesFramesFromJson(result)){if(f.type==='event')text+=`event: ${f.event.type}\ndata: ${JSON.stringify(f.event)}\n\n`}
  return new Response(text,{headers:{'content-type':'text/event-stream'}})
 }
 const inputText=JSON.stringify(body.input??[]),required=inputText.includes('make-compaction'),agent=inputText.includes('make-agent')
 if(inputText.includes('partial-companion')||inputText.includes('conflicting-companion')){
  const finalText=inputText.includes('conflicting-companion')?'z':'ab'
  const item={type:'reasoning',id:'rs_partial',summary:[{type:'summary_text',text:finalText}],encrypted_content:'synthetic-signature-for-final'}
  const result={id:'resp_partial',object:'response',model:body.model,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}
  const events=[{type:'response.created',response:{...result,status:'in_progress',output:[]}},
   {type:'response.reasoning_summary_text.delta',output_index:0,summary_index:0,item_id:'rs_partial',delta:'a'},
   {type:'response.output_item.done',output_index:0,item},
   {type:'response.completed',response:result}]
  return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})
 }

 const item=agent?{type:'agent_message',id:`agent_${++serial}`,author:'assistant',recipient:'all',agent:{agent_name:'synthetic-agent'},content:[{type:'text',text:'Synthetic agent context'},{type:'encrypted_content',encrypted_content:'synthetic-agent-opaque'}]}:required?{type:'compaction',id:`cmp_${++serial}`,encrypted_content:'synthetic-compaction'}:{type:'reasoning',id:`rs_${++serial}`,summary:[{type:'summary_text',text:'  Synthetic thought \n'}],encrypted_content:'synthetic-reasoning'}
 const result={id:`resp_fixture_${serial}`,object:'response',model:body.model,output:[item],status:'completed',error:null,incomplete_details:null,usage:{input_tokens:5,output_tokens:3,total_tokens:8}}
 if(!body.stream)return Response.json(result)
 let text='';for await(const f of synthesizeResponsesFramesFromJson(result)){if(f.type==='event')text+=`event: ${f.event.type}\ndata: ${JSON.stringify(f.event)}\n\n`}
 return new Response(text,{headers:{'content-type':'text/event-stream'}})
}})
for(const [id,owner,order,endpoints]of [['up_a','owner',0,['responses','messages']],['up_b','owner',1,['responses','messages']],['up_foreign','foreign',0,['responses','messages']],['up_responses','owner',2,['responses']],['up_messages','owner',3,['messages']]])await getRepo().upstreams.save({id,ownerId:owner,provider:'custom',name:id,enabled:true,sortOrder:order,config:{name:id,baseUrl:`http://127.0.0.1:${upstream.port}/${id}`,authStyle:'none',endpoints,models:['synthetic-model']},state:{},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[{id:'direct_fetch'}],createdAt:now,updatedAt:now})
const server=serve({hostname:'127.0.0.1',port:0,fetch:req=>app.fetch(req,{})})
const request=async(extra={},key='key',protocol='responses')=>{
 const response=await fetch(`http://127.0.0.1:${server.port}/v1/${protocol}`,{method:'POST',headers:{authorization:`Bearer raw-${key}`,'content-type':'application/json'},body:JSON.stringify({model:'up_a/synthetic-model',...(protocol==='messages'?{max_tokens:128,messages:[{role:'user',content:'synthetic request'}]}:{input:[{role:'user',content:'synthetic request'}]}),stream:false,...extra})})
 const text=await response.text();return{status:response.status,text,json:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null}
}
try{
 const result=await request({model:'up_responses/synthetic-model',stream:true,messages:[{role:'user',content:'partial-companion'}]},'key','messages')
 assert.equal(result.status,200)
 const events=result.text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)))
 let thinking='',signature=''
 for(const event of events){
  if(event.type==='content_block_start'&&event.content_block?.type==='thinking'){thinking+=event.content_block.thinking??'';signature+=event.content_block.signature??''}
  if(event.delta?.type==='thinking_delta')thinking+=event.delta.thinking??''
  if(event.delta?.type==='signature_delta')signature+=event.delta.signature??''
 }
 assert.equal(thinking,'ab','Final companion suffix was lost');assert(signature.startsWith('vnext-affinity:'))
 const follow=await request({model:'up_responses/synthetic-model',messages:[{role:'assistant',content:[{type:'thinking',thinking,signature}]},{role:'user',content:'ordinary replay'}]},'key','messages');assert.equal(follow.status,200)
 const input=calls.at(-1).body.input.find(i=>i.type==='reasoning');assert.equal(input.encrypted_content,'synthetic-signature-for-final');assert.equal(input.summary[0].text,'ab')
 const conflict=await request({model:'up_responses/synthetic-model',stream:true,messages:[{role:'user',content:'conflicting-companion'}]},'key','messages')
 const conflictEvents=conflict.text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)))
 assert(!conflictEvents.some(e=>e.delta?.type==='signature_delta'),'Irreconcilable companion must not acquire a signed carrier')
 assert(conflict.status>=400||conflictEvents.some(e=>e.type==='error'),'Conflicting companion must fail explicitly')
 await Promise.all(pending)
 console.log(JSON.stringify({passed:true,runtime:'actual authenticated Bun/SQLite Messages via Responses stream',cases:['partial-final-companion-complete','complete-companion-raw-replay','conflicting-companion-no-signed-success'],calls:calls.length,scratch}))
}finally{server.stop(true);upstream.stop(true)}
