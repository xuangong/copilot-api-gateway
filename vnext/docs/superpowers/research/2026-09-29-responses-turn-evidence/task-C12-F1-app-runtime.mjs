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
const {getResponsesStore,initResponsesStore}=await import(`${source}/packages/gateway/src/data-plane/runtime/responses-store.ts`)
const {app}=await import(`${source}/packages/gateway/src/app.ts`)
const {getDumpStore}=await import(`${source}/packages/gateway/src/shared/dump/registry.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c12-f1-http-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const now=new Date().toISOString(),calls=[],closes=[]
await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind('owner','Synthetic','synthetic@example.invalid',now).run()
await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind('key','Synthetic','raw-key',now,'owner',86400).run()
for(const id of ['unknown','zero','error'])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id) VALUES(?,?,?,?,?)').bind(id,id,`raw-${id}`,now,'owner').run()
await db.prepare('UPDATE api_keys SET dump_retention_seconds=86400 WHERE id=?').bind('error').run()
const child=spawn('node',['--input-type=module','-e',String.raw`
import {createServer} from 'node:http'
let serial=0
const server=createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw),mode=JSON.stringify(body.input??body.messages),id='resp_fixture_'+(++serial)
 console.log(JSON.stringify({call:true,body,id}))
 if(mode.includes('http-error')){res.writeHead(400,{'content-type':'application/json'});res.end(JSON.stringify({error:{type:'invalid_request_error',code:'synthetic_error',message:'Synthetic upstream error'}}));return}
 res.writeHead(200,{'content-type':'text/event-stream'})
 const wire=e=>'event: '+(e.type??'message')+'\ndata: '+JSON.stringify(e)+'\n\n'
 const chat=e=>'data: '+JSON.stringify(e)+'\n\n'
 const output=[{type:'message',id:'msg_'+serial,role:'assistant',status:'completed',content:[{type:'output_text',text:'Synthetic answer',annotations:[]}]}]
 const response={id,object:'response',model:'synthetic-model',output,status:'completed',error:null,incomplete_details:null,usage:{input_tokens:5,output_tokens:7,total_tokens:12}}
 if(mode.includes('usage-unknown'))delete response.usage
 if(mode.includes('usage-zero'))response.usage={input_tokens:0,output_tokens:0,total_tokens:0}
 let timer
 res.on('close',()=>{clearInterval(timer);console.log(JSON.stringify({closed:true,id,mode,finished:res.writableEnded}))})
 if(req.url.endsWith('/chat/completions')){
  const base={id:'chat_'+serial,object:'chat.completion.chunk',model:'synthetic-model',created:0}
  res.write(chat({...base,choices:[{index:0,delta:{role:'assistant',content:'Synthetic answer'},finish_reason:null}]}))
  res.write(chat({...base,choices:[{index:0,delta:{},finish_reason:'stop'}]}))
  if(mode.includes('multi-choice')){
   timer=setTimeout(()=>{res.write(chat({...base,choices:[{index:1,delta:{role:'assistant',content:'Second choice'},finish_reason:null}]}));res.write(chat({...base,choices:[{index:1,delta:{},finish_reason:'stop'}]}));res.write(chat({...base,choices:[],usage:{prompt_tokens:5,completion_tokens:17,total_tokens:22}}));res.end('data: [DONE]\n\n')},1400)
  }else if(mode.includes('tail-stall'))timer=setInterval(()=>res.write(': waiting\n\n'),100)
  else timer=setTimeout(()=>{res.write(chat({...base,choices:[{index:0}],usage:{prompt_tokens:5,completion_tokens:17,total_tokens:22}}));res.end('data: [DONE]\n\n')},30)
  return
 }
 res.write(wire({type:'response.created',response:{...response,status:'in_progress',output:[]}}))
 res.write(wire({type:'response.completed',response}))
 if(mode.includes('late-output'))res.write(wire({type:'response.output_text.delta',item_id:'late',output_index:1,content_index:0,delta:'MUST-NOT-LEAK'}))
 if(mode.includes('late-error'))res.write(wire({type:'error',message:'synthetic-late-error'}))
 if(mode.includes('tail-overflow-frames'))for(let i=0;i<300;i++)res.write(wire({type:'response.output_text.delta',item_id:'late',output_index:1,content_index:0,delta:'x'}))
 if(mode.includes('tail-overflow-bytes'))res.write(wire({type:'response.output_text.delta',item_id:'late',output_index:1,content_index:0,delta:'x'.repeat(1024*1024+1)}))
 if(mode.includes('tail-stall'))timer=setInterval(()=>res.write(': waiting\n\n'),100)
 else res.end()
})
server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({port:server.address().port,nodeVersion:process.version})))
`],{stdio:['ignore','pipe','inherit']})
let lines='',port,nodeVersion
child.stdout.on('data',chunk=>{lines+=chunk.toString();let at;while((at=lines.indexOf('\n'))>=0){const r=JSON.parse(lines.slice(0,at));lines=lines.slice(at+1);if(r.port){port=r.port;nodeVersion=r.nodeVersion}if(r.call)calls.push(r);if(r.closed)closes.push(r)}})
const until=async predicate=>{for(let i=0;i<300&&!predicate();i++)await new Promise(r=>setTimeout(r,10));assert(predicate(),'fixture condition timed out')}
await until(()=>port)
for(const [id,endpoint]of [['up_responses','responses'],['up_chat','chat_completions']])await getRepo().upstreams.save({id,ownerId:'owner',provider:'custom',name:id,enabled:true,sortOrder:0,config:{name:id,baseUrl:`http://127.0.0.1:${port}/${id}`,authStyle:'none',endpoints:[endpoint],models:['synthetic-model']},state:{},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[{id:'direct_fetch'}],createdAt:now,updatedAt:now})
const server=serve({hostname:'127.0.0.1',port:0,fetch:req=>app.fetch(req,{})})
const request=(id,input,stream=true,extra={},signal)=>fetch(`http://127.0.0.1:${server.port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer raw-key','content-type':'application/json'},body:JSON.stringify({model:`${id}/synthetic-model`,input,stream,...extra}),signal})
const events=text=>text.split('\n').filter(l=>l.startsWith('data: ')&&l!=='data: [DONE]').map(l=>JSON.parse(l.slice(6)))
const store=getResponsesStore(),cases=[]
try{
 for(const stream of [true,false]){
  const r=await request('up_responses','late-output',stream),text=await r.text()
  assert.equal(r.status,200,text);assert(!text.includes('MUST-NOT-LEAK'),'Post-terminal provider output reached source client')
  if(stream){const ev=events(text);assert.equal(ev.at(-1).type,'response.completed');assert.equal(ev.filter(e=>e.type==='response.completed').length,1)}
  cases.push(`provider-late-output-suppressed-${stream?'sse':'json'}`)
 }
 for(const stream of [true,false]){
  const r=await request('up_responses','late-error',stream),text=await r.text()
  assert(!events(text).some(e=>e.type==='response.completed'));assert(r.status>=400||events(text).some(e=>e.type==='error'||e.type==='response.failed'))
  cases.push(`late-error-invalidates-success-${stream?'sse':'json'}`)
 }
 for(const stream of [true,false]){
  const r=await request('up_chat','late-usage',stream),text=await r.text();assert.equal(r.status,200,text)
  const result=stream?events(text).findLast(e=>e.type==='response.completed')?.response:JSON.parse(text)
  assert(result,text)
  assert.equal(result.usage.output_tokens,17,text);cases.push(`chat-trailing-usage-${stream?'sse':'json'}`)
 }
 for(const id of ['up_responses','up_chat'])for(const stream of [true,false]){
  const control=new AbortController(),timer=setTimeout(()=>control.abort(),8000),before=calls.length,start=performance.now()
  try{
   const r=await request(id,'tail-stall',stream,{},control.signal),text=await r.text()
   assert(performance.now()-start<5000,'Tail did not stop within bound')
   assert(r.status>=400||events(text).some(e=>e.type==='error'||e.type==='response.failed'),'Stalled tail became success')
   assert(!events(text).some(e=>e.type==='response.completed'));await until(()=>calls.length>before)
   const call=calls.at(-1);await until(()=>closes.some(c=>c.id===call.id&&!c.finished))
  }finally{clearTimeout(timer);control.abort()}
  cases.push(`${id}-stalled-tail-${stream?'sse':'json'}-failure-socket-close`)
 }
 // A first choice finishing cannot close a legitimate later choice.
 const multi=await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`,{method:'POST',headers:{authorization:'Bearer raw-key','content-type':'application/json'},body:JSON.stringify({model:'up_chat/synthetic-model',messages:[{role:'user',content:'multi-choice'}],n:2,stream:true})})
 const multiText=await multi.text();assert.equal(multi.status,200,multiText);assert(multiText.includes('Second choice'),multiText);assert(!events(multiText).some(e=>e.error||e.type==='error'))
 cases.push('chat-n2-first-choice-finish-does-not-start-global-tail')
 for(const input of ['tail-overflow-frames','tail-overflow-bytes'])for(const stream of [true,false]){
  const r=await request('up_responses',input,stream),text=await r.text()
  assert(r.status>=400||events(text).some(e=>e.type==='error'||e.type==='response.failed'),'Tail overflow became success')
  assert(!events(text).some(e=>e.type==='response.completed'))
  cases.push(`${input}-${stream?'sse':'json'}-fails`)
 }
 // Observe real SQLite storage through a controllable completion gate.
 let release,entered=false;const gate=new Promise(r=>{release=r})
 initResponsesStore({load:(...args)=>store.load(...args),save:async snapshot=>{entered=true;await gate;await store.save(snapshot)}})
 let captured='',settled=false
 const consume=(async()=>{const response=await request('up_responses','blocked-save');const reader=response.body.getReader(),decoder=new TextDecoder();for(;;){const next=await reader.read();if(next.done)break;captured+=decoder.decode(next.value)}settled=true})()
 await until(()=>entered);await new Promise(r=>setTimeout(r,80));assert(!settled);assert(!events(captured).some(e=>e.type==='response.completed'))
 release();await consume;const terminal=events(captured).at(-1);assert.equal(terminal.type,'response.completed');assert(await store.load(terminal.response.id,'key'))
 initResponsesStore(store)
 const next=await request('up_responses',[{role:'user',content:'after durable terminal'}],false,{previous_response_id:terminal.response.id});assert.equal(next.status,200,await next.text())
 cases.push('save-awaited-before-terminal-immediate-continuation')
 initResponsesStore({load:(...args)=>store.load(...args),save:async()=>{throw new Error('DO-NOT-LEAK-private-SQL-binding')}})
 const failed=await request('up_responses','failed-save'),failedText=await failed.text();assert(!events(failedText).some(e=>e.type==='response.completed'));assert(events(failedText).some(e=>e.type==='error'||e.type==='response.failed'));assert(!failedText.includes('DO-NOT-LEAK'))
 cases.push('storage-failure-no-success-sanitized')
 initResponsesStore(store)
 // A non-cancellable storage operation may finish physically after disconnect,
 // but cannot release a successful terminal to the cancelled client.
 let releaseCancelled,enteredCancelled=false,cancelledSaveSettled=false
 const cancelledGate=new Promise(r=>{releaseCancelled=r}),cancelControl=new AbortController()
 initResponsesStore({load:(...args)=>store.load(...args),save:async snapshot=>{enteredCancelled=true;await cancelledGate;await store.save(snapshot);cancelledSaveSettled=true}})
 let cancelledCaptured=''
 const cancelledConsume=(async()=>{try{const response=await request('up_responses','cancelled-save',true,{},cancelControl.signal);const reader=response.body.getReader(),decoder=new TextDecoder();for(;;){const n=await reader.read();if(n.done)break;cancelledCaptured+=decoder.decode(n.value)}}catch(error){assert(cancelControl.signal.aborted,String(error))}})()
 await until(()=>enteredCancelled);cancelControl.abort();await cancelledConsume
 assert(!events(cancelledCaptured).some(e=>e.type==='response.completed'))
 releaseCancelled();await until(()=>cancelledSaveSettled)
 cases.push('cancelled-save-never-delivers-success-physical-save-settles')
 initResponsesStore(store)
 await Promise.all(pending)
 for(const id of ['unknown','zero']){
  const response=await fetch(`http://127.0.0.1:${server.port}/v1/responses`,{method:'POST',headers:{authorization:`Bearer raw-${id}`,'content-type':'application/json'},body:JSON.stringify({model:'up_responses/synthetic-model',input:`usage-${id}`,stream:false})})
  const result=await response.json();assert.equal(response.status,200,JSON.stringify(result))
  if(id==='unknown')assert(result.usage==null||!Object.hasOwn(result.usage,'output_tokens'),JSON.stringify(result))
  else assert.equal(result.usage.output_tokens,0)
  await Promise.all(pending)
  const rows=await db.prepare('SELECT dimension,tokens FROM usage WHERE key_id=?').bind(id).all()
  if(id==='unknown')assert.equal(rows.results.length,0,'Unknown usage acquired fabricated token dimensions')
  // Existing recordUsage deliberately skips all-zero observations. F1 must
  // preserve wire presence and avoid inventing nonzero SQL quantities.
  else assert(rows.results.every(r=>r.tokens===0),'Observed zero acquired nonzero quantities')
  cases.push(`usage-${id}-wire-presence-no-fabricated-SQL-quantity`)
 }
 const errorResponse=await fetch(`http://127.0.0.1:${server.port}/v1/responses`,{method:'POST',headers:{authorization:'Bearer raw-error','content-type':'application/json'},body:JSON.stringify({model:'up_chat/synthetic-model',input:'http-error',stream:false})})
 const errorBody=await errorResponse.json();assert.equal(errorResponse.status,400,JSON.stringify(errorBody));assert.equal(errorBody.error.code,'synthetic_error')
 await Promise.all(pending)
 const dumpId=errorResponse.headers.get('x-dump-record-id');assert(dumpId,'Missing dump lookup header')
 const errorDump=await getDumpStore().get('error',dumpId);assert(errorDump,'Missing persistent dump record')
 assert.equal(errorDump.response.body.type,'bytes','HTTP upstream error dump lost canonical JSON body')
 const dumpBody=JSON.parse(new TextDecoder().decode(errorDump.response.body.body));assert.equal(dumpBody.error.code,'synthetic_error')
 cases.push('HTTP-error-dump-body-preserved-in-real-files-and-SQL')
 const errors=await db.prepare('SELECT source_api,target_api,errors FROM performance_summary WHERE key_id=?').bind('error').all()
 assert.equal(errors.results.length,1,JSON.stringify(errors));assert.equal(errors.results[0].source_api,'responses');assert.equal(errors.results[0].target_api,'chat-completions');assert.equal(errors.results[0].errors,1)
 cases.push('HTTP-error-preserves-actual-hub-in-SQL')
 console.log(JSON.stringify({passed:true,runtime:'actual authenticated Bun HTTP + independent Node upstream + real SQLite',nodeVersion,cases,calls:calls.length,scratch}))
}finally{initResponsesStore(store);server.stop(true);child.kill('SIGTERM')}
