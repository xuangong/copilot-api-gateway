import assert from 'node:assert/strict'
import {serve} from 'bun'
import {spawn} from 'node:child_process'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const source=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
const {initBackground,initSocketDial}=await import(`${source}/packages/platform/src/index.ts`)
const {getRepo}=await import(`${source}/packages/gateway/src/repo/index.ts`)
const {app}=await import(`${source}/packages/gateway/src/app.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c01-app-runtime-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const now=new Date().toISOString()
for(const owner of ['owner','foreign'])await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind(owner,owner,`${owner}@example.invalid`,now).run()
for(const [id,owner] of [['key','owner'],['key2','owner'],['foreign-key','foreign']])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind(id,id,`raw-${id}`,now,owner,86400).run()
let overflowSent,overflowCancelled,nodeVersion
const child=spawn('node',['--input-type=module','-e',`
import {createServer} from 'node:http'
const server=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;JSON.parse(body)
 res.writeHead(200,{'content-type':'text/event-stream'})
 const wire=event=>'event: '+(event.type??'message')+'\\ndata: '+JSON.stringify(event)+'\\n\\n'
 const isChat=req.url.includes('/chat/completions')
 if(!isChat)res.write(wire({type:'message_start',message:{id:'msg_overflow',type:'message',role:'assistant',model:'synthetic-model',content:[],usage:{input_tokens:1,output_tokens:0}}}))
 if(!isChat)res.write(wire({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'x'}}))
 let sent=0
 const timer=setInterval(()=>{sent++;res.write(wire(isChat?{id:'chat_overflow',object:'chat.completion.chunk',model:'synthetic-model',choices:[{index:0,delta:{reasoning_opaque:'s'.repeat(128*1024)},finish_reason:null}]}:{type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'s'.repeat(128*1024)}}));if(sent>=40){clearInterval(timer);res.write(wire({type:'content_block_stop',index:0}));res.write(wire({type:'message_delta',delta:{stop_reason:'end_turn'},usage:{output_tokens:1}}));res.write(wire({type:'message_stop'}));res.end()}},25)
 res.on('close',()=>{clearInterval(timer);console.log(JSON.stringify({closed:true,sent,finished:res.writableEnded}))})
})
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,nodeVersion:process.version})))
`],{stdio:['ignore','pipe','inherit']})
let lines='',port
child.stdout.on('data',chunk=>{lines+=chunk.toString();let at;while((at=lines.indexOf('\n'))>=0){const record=JSON.parse(lines.slice(0,at));lines=lines.slice(at+1);if(record.port){port=record.port;nodeVersion=record.nodeVersion}if(record.closed){overflowCancelled=!record.finished;overflowSent=record.sent}}})
for(let i=0;i<200&&!port;i++)await new Promise(resolve=>setTimeout(resolve,10))
assert(port,'Node fixture failed to bind')
const upstream={port,stop(){child.kill('SIGTERM')}}
for(const [id,owner,order,endpoints]of [['up_chat','owner',4,['chat_completions']],['up_a','owner',0,['responses','messages']],['up_b','owner',1,['responses','messages']],['up_foreign','foreign',0,['responses','messages']],['up_responses','owner',2,['responses']],['up_messages','owner',3,['messages']]])await getRepo().upstreams.save({id,ownerId:owner,provider:'custom',name:id,enabled:true,sortOrder:order,config:{name:id,baseUrl:`http://127.0.0.1:${upstream.port}/${id}`,authStyle:'none',endpoints,models:['synthetic-model']},state:{},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[{id:'direct_fetch'}],createdAt:now,updatedAt:now})
const server=serve({hostname:'127.0.0.1',port:0,fetch:req=>app.fetch(req,{})})
const request=async(protocol,id,stream)=>{
 const path=protocol==='chat'?'/v1/chat/completions':`/v1beta/models/${encodeURIComponent(`${id}/synthetic-model`)}:${stream?'streamGenerateContent':'generateContent'}`
 const body=protocol==='chat'?{model:`${id}/synthetic-model`,messages:[{role:'user',content:'synthetic'}],stream}:{contents:[{role:'user',parts:[{text:'synthetic'}]}],generationConfig:{thinkingConfig:{includeThoughts:true}}}
 const response=await fetch(`http://127.0.0.1:${server.port}${path}`,{method:'POST',headers:{authorization:'Bearer raw-key','content-type':'application/json'},body:JSON.stringify(body)})
 const text=await response.text();return{status:response.status,text}
}

try{
 const outcomes=[]
 for(const protocol of ['chat','gemini'])for(const id of ['up_chat','up_messages'])for(const streaming of [true,false]){
 overflowSent=0;overflowCancelled=false
 const result=await request(protocol,id,streaming)
 const events=result.text.split('\n').filter(l=>l.startsWith('data: ')&&l!=='data: [DONE]').map(l=>JSON.parse(l.slice(6)))
 assert(!events.some(e=>e.type==='response.completed'),'Overflow must not expose a successful terminal')
 assert(result.status>=400||events.some(e=>e.type==='error'||e.type==='response.failed'||e.error),'Overflow must fail explicitly')
 for(let i=0;i<50&&!overflowCancelled;i++)await new Promise(resolve=>setTimeout(resolve,10))
 assert(overflowSent<40,'Translator consumed the complete oversized signature before rejecting')
 assert(overflowCancelled,'Failed translation did not cancel upstream stream')
 outcomes.push({protocol,hub:id,streaming,chunksSent:overflowSent,upstreamCancelled:overflowCancelled})
 }
 await Promise.all(pending)
 const metrics=await db.prepare("SELECT SUM(count) AS requests, SUM(CASE WHEN json_extract(dimensions, '$.outcome') = 'error' THEN count ELSE 0 END) AS errors FROM performance_metrics WHERE metric = '__requests'").first()
 assert.deepEqual(metrics,{requests:8,errors:8},'Overflow is an upstream failure, not caller cancellation')
 const snapshots=await db.prepare('SELECT COUNT(*) AS total FROM responses_snapshots').first()
 assert.equal(snapshots.total,0,'Failed overflow must not create durable success')
 console.log(JSON.stringify({passed:true,runtime:'actual authenticated Bun gateway/SQLite Chat/Gemini via independent Node HTTP upstream',nodeVersion,cases:['cross-translator-overflow-rejected-early','upstream-stream-cancelled','no-success-terminal','error-not-cancelled-metrics','no-success-snapshot'],outcomes,totalChunksPerRequest:40,scratch}))
}finally{server.stop(true);upstream.stop(true)}
