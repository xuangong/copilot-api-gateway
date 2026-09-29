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


  const result={id:`msg_${++serial}`,type:'message',role:'assistant',model:body.model,content:[{type:'tool_use',id:'tool_synthetic',name:'synthetic_tool',input:{signature:'s'.repeat(1024*1024+1),encrypted_content:'ordinary-value',fingerprint:'ordinary-fingerprint'}}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:5,output_tokens:3}}
  if(!body.stream&&!JSON.stringify(body).includes('source-json-upstream-sse'))return Response.json(result)
  const events=[{type:'message_start',message:{...result,content:[]}},{type:'content_block_start',index:0,content_block:result.content[0]},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'tool_use'},usage:{output_tokens:3}},{type:'message_stop'}]
  const text=events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
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
 const result=await request({model:'up_messages/synthetic-model',messages:[{role:'user',content:'ordinary tool fields'}]},'key','messages')
 assert.equal(result.status,200,'Ordinary tool business data must not be classified as native opaque state')
 const item=result.json.content.find(item=>item.type==='tool_use')
 assert.equal(item.input.signature.length,1024*1024+1)
 assert.equal(item.input.encrypted_content,'ordinary-value')
 assert.equal(item.input.fingerprint,'ordinary-fingerprint')
 const streamed=await request({model:'up_messages/synthetic-model',stream:true,messages:[{role:'user',content:'ordinary tool fields'}]},'key','messages')
 const events=streamed.text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)))
 assert.equal(streamed.status,200)
 assert(!events.some(event=>event.type==='error'),'Ordinary streamed tool data rejected as opaque')
 assert(events.some(event=>event.type==='message_stop'))
 assert.equal(events.find(event=>event.type==='content_block_start').content_block.input.signature.length,1024*1024+1)
 const bridged=await request({model:'up_messages/synthetic-model',messages:[{role:'user',content:'source-json-upstream-sse'}]},'key','messages')
 assert.equal(bridged.status,200,'Explicit upstream SSE should reassemble for a JSON source')
 assert.equal(bridged.json.content.find(item=>item.type==='tool_use').input.signature.length,1024*1024+1)
 const secret=await db.prepare('SELECT affinity_secret FROM api_keys WHERE id = ?').bind('key').first()
 assert.equal(secret.affinity_secret,null,'Ordinary tool business fields must not initialize signing secrets')
 await Promise.all(pending)
 console.log(JSON.stringify({passed:true,runtime:'actual authenticated Bun/SQLite native Messages JSON',cases:['ordinary-tool-json-fields-not-opaque','ordinary-tool-sse-fields-not-opaque','source-json-upstream-sse-fields-preserved'],calls:calls.length,scratch}))
}finally{server.stop(true);upstream.stop(true)}
