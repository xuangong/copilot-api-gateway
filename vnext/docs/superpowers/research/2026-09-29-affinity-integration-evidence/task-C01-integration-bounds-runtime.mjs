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
let serial=0,overflowSent,overflowCancelled
const upstream=serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const body=await req.json(),up=new URL(req.url).pathname.split('/')[1];calls.push({up,body})
 if(new URL(req.url).pathname.endsWith('/messages')){
 if(JSON.stringify(body).includes('oversized-signature')){
  const encoder=new TextEncoder();let timer
  const wire=event=>encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const stream=new ReadableStream({start(controller){
   controller.enqueue(wire({type:'message_start',message:{id:'msg_overflow',type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:1,output_tokens:0}}}))
   controller.enqueue(wire({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'x'}}))
   timer=setInterval(()=>{
    try{
     overflowSent++;controller.enqueue(wire({type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'s'.repeat(128*1024)}}))
     if(overflowSent>=40){clearInterval(timer);controller.enqueue(wire({type:'content_block_stop',index:0}));controller.enqueue(wire({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}}));controller.enqueue(wire({type:'message_stop'}));controller.close()}
    }catch{clearInterval(timer)}
   },25)
  },cancel(){overflowCancelled=true;clearInterval(timer)}})
  req.signal.addEventListener('abort',()=>{overflowCancelled=true;clearInterval(timer)},{once:true})
  return new Response(stream,{headers:{'content-type':'text/event-stream'}})
 }

  const result={id:`msg_${++serial}`,type:'message',role:'assistant',model:body.model,content:[{type:'thinking',thinking:'  Synthetic thought \n',signature:'synthetic-signature'},{type:'text',text:'Synthetic answer'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:5,output_tokens:3}}
  if(!body.stream)return Response.json(result)
  let text='';for await(const f of synthesizeMessagesFramesFromJson(result)){if(f.type==='event')text+=`event: ${f.event.type}\ndata: ${JSON.stringify(f.event)}\n\n`}
  return new Response(text,{headers:{'content-type':'text/event-stream'}})
 }
 const inputText=JSON.stringify(body.input??[]),required=inputText.includes('make-compaction'),agent=inputText.includes('make-agent')
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
 const outcomes=[]
 for(const streaming of [true,false]){
 overflowSent=0;overflowCancelled=false
 const result=await request({model:'up_messages/synthetic-model',input:[{role:'user',content:'oversized-signature'}],stream:streaming})
 const events=result.text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)))
 assert(!events.some(e=>e.type==='response.completed'),'Overflow must not expose a successful terminal')
 assert(result.status>=400||events.some(e=>e.type==='error'||e.type==='response.failed'),'Overflow must fail explicitly')
 for(let i=0;i<50&&!overflowCancelled;i++)await new Promise(resolve=>setTimeout(resolve,10))
 assert(overflowSent<40,'Translator consumed the complete oversized signature before rejecting')
 assert(overflowCancelled,'Failed translation did not cancel upstream stream')
 outcomes.push({streaming,chunksSent:overflowSent,upstreamCancelled:overflowCancelled})
 }
 await Promise.all(pending)
 const metrics=await db.prepare("SELECT SUM(count) AS requests, SUM(CASE WHEN json_extract(dimensions, '$.outcome') = 'error' THEN count ELSE 0 END) AS errors FROM performance_metrics WHERE metric = '__requests'").first()
 assert.deepEqual(metrics,{requests:2,errors:2},'Overflow is an upstream failure, not caller cancellation')
 const snapshots=await db.prepare('SELECT COUNT(*) AS total FROM responses_snapshots').first()
 assert.equal(snapshots.total,0,'Failed overflow must not create durable success')
 console.log(JSON.stringify({passed:true,runtime:'actual authenticated Bun/SQLite Responses via Messages streaming HTTP',cases:['cross-translator-overflow-rejected-early','upstream-stream-cancelled','no-success-terminal','error-not-cancelled-metrics','no-success-snapshot'],outcomes,totalChunksPerRequest:40,scratch}))
}finally{server.stop(true);upstream.stop(true)}
