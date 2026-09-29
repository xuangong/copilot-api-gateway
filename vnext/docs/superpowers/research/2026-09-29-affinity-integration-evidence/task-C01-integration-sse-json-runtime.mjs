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
  const events=[{type:'message_start',message:{id:'msg_ssejson',type:'message',role:'assistant',model:body.model,content:[],usage:{input_tokens:1,output_tokens:0}}},
   {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'a'}},
   {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'b'}},
   {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'synthetic-signature-'}},
   {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'for-final'}},
   {type:'content_block_stop',index:0},
   {type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}},
   {type:'message_stop'}]
  return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})
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
 const cases=[]
 for(const target of ['messages','responses'])for(const sourceProtocol of ['messages','responses']){
  const input=sourceProtocol==='messages'?{messages:[{role:'user',content:'partial-companion'}]}:{input:[{role:'user',content:'partial-companion'}]}
  const result=await request({model:`up_${target}/synthetic-model`,stream:false,...input},'key',sourceProtocol)
  assert.equal(result.status,200)
  const item=sourceProtocol==='messages'?result.json.content.find(item=>item.type==='thinking'):result.json.output.find(item=>item.type==='reasoning')
  assert.equal(sourceProtocol==='messages'?item.thinking:item.summary.map(item=>item.text).join(''),'ab')
  assert((sourceProtocol==='messages'?item.signature:item.encrypted_content).startsWith('vnext-affinity:'))
  const replay=sourceProtocol==='messages'?{messages:[{role:'assistant',content:[item]},{role:'user',content:'ordinary replay'}]}:{input:[item,{role:'user',content:'ordinary replay'}]}
  const follow=await request({model:`up_${target}/synthetic-model`,stream:false,...replay},'key',sourceProtocol)
  assert.equal(follow.status,200)
  const outbound=calls.at(-1).body
  const raw=target==='messages'?outbound.messages.flatMap(item=>Array.isArray(item.content)?item.content:[]).find(item=>item.type==='thinking'):outbound.input.find(item=>item.type==='reasoning')
  assert.equal(target==='messages'?raw.signature:raw.encrypted_content,'synthetic-signature-for-final')
  assert.equal(target==='messages'?raw.thinking:raw.summary.map(item=>item.text).join(''),'ab')
  cases.push(`${sourceProtocol}-json-via-${target}-sse-and-replay`)
 }
 await Promise.all(pending)
 console.log(JSON.stringify({passed:true,runtime:'actual authenticated Bun/SQLite source JSON from explicit upstream SSE',cases,calls:calls.length,scratch}))
}finally{server.stop(true);upstream.stop(true)}
