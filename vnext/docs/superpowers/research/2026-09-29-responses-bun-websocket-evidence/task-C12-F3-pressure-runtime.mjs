/* global Bun */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {randomBytes} from 'node:crypto'
import net from 'node:net'
import {createFixture} from '../2026-09-29-responses-session-evidence/task-C12-F2-runtime-fixture.mjs'

// Run with VNEXT_PROBE_ROOT=<absolute F3 worktree> bun <this file>.
// Only loopback sockets, synthetic credentials, and the fixture's temporary SQLite are used.
const root=process.env.VNEXT_PROBE_ROOT
assert(root && root.startsWith('/'), 'VNEXT_PROBE_ROOT must be an absolute path')
const fixture=await createFixture(root)
const {source,until,getRepo}=fixture
const producerEvents=[]
let producerPort,producerLines=''
const producer=spawn('node',['--input-type=module','-e',String.raw`
  import {createServer} from 'node:http'
  let serial=0
  const report=o=>console.log(JSON.stringify(o))
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part
    const body=JSON.parse(raw),id='pressure_'+(++serial),mode=raw.includes('pressure-timeout')?'pressure-timeout':raw.includes('pressure-abrupt-abort')?'pressure-abrupt-abort':String(body.input)
    report({kind:'call',id,mode})
    res.writeHead(200,{'content-type':'text/event-stream'})
    let writes=0,closed=false
    res.on('close',()=>{closed=true;report({kind:'close',id,mode,writes,finished:res.writableEnded})})
    const wire=e=>'event: '+e.type+'\ndata: '+JSON.stringify(e)+'\n\n'
    const response={id,object:'response',model:body.model,output:[],status:'in_progress',error:null,incomplete_details:null}
    res.write(wire({type:'response.created',response}))
    const delta='p'.repeat(240_000)
    for(let i=0;i<48&&!closed;i++){
      const ok=res.write(wire({type:'response.output_text.delta',item_id:'item_'+id,output_index:0,content_index:0,delta,probe_index:i}))
      writes++
      if(i%4===0)report({kind:'progress',id,mode,writes})
      if(!ok&&!closed)await new Promise(resolve=>{
        const done=()=>{res.off('drain',done);res.off('close',done);resolve()}
        res.once('drain',done);res.once('close',done)
      })
    }
    if(closed)return
    report({kind:'all-written',id,mode,writes})
    const keepalive=setInterval(()=>res.write(': held\n\n'),100)
    res.once('close',()=>clearInterval(keepalive))
  })
  server.listen(0,'127.0.0.1',()=>report({kind:'listening',port:server.address().port}))
`],{stdio:['ignore','pipe','inherit']})
producer.stdout.on('data',chunk=>{
  producerLines+=chunk.toString()
  let at
  while((at=producerLines.indexOf('\n'))>=0){
    const line=producerLines.slice(0,at);producerLines=producerLines.slice(at+1)
    const event=JSON.parse(line)
    if(event.kind==='listening')producerPort=event.port
    else producerEvents.push({...event,at:performance.now()})
  }
})

const {app}=await import(`${source}/packages/gateway/src/app.ts`)
const {createResponsesWebSocketHandlers}=await import(`${source}/apps/platform-bun/src/responses-websocket.ts`)
const {RESPONSES_WS_SEND_HIGH_WATER_BYTES,RESPONSES_WS_DRAIN_TIMEOUT_MS}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/session-limits.ts`)
const handlers=createResponsesWebSocketHandlers({app})
const records=[]
const proxies=new WeakMap()
function recordFor(ws){
  let record=records.find(r=>r.ws===ws)
  if(!record){record={ws,opens:0,drains:[],sends:[],samples:[],closeCalls:[],nativeCloses:[],peakBuffered:0};records.push(record)}
  return record
}
function observed(ws){
  let proxy=proxies.get(ws)
  if(proxy)return proxy
  const record=recordFor(ws)
  const sample=()=>{
    const value=ws.getBufferedAmount()
    record.samples.push({at:performance.now(),bytes:value})
    record.peakBuffered=Math.max(record.peakBuffered,value)
    return value
  }
  proxy=new Proxy(ws,{get(target,key){
    if(key==='getBufferedAmount')return sample
    if(key==='send')return text=>{
      const before=sample(),result=target.send(text),after=sample()
      const event=JSON.parse(text)
      record.sends.push({at:performance.now(),type:event.type,sequence:event.sequence_number,probeIndex:event.probe_index,bytes:Buffer.byteLength(text),before,after,result})
      return result
    }
    if(key==='close')return (code,reason)=>{record.closeCalls.push({at:performance.now(),code,reason});return target.close(code,reason)}
    const value=Reflect.get(target,key,target)
    return typeof value==='function'?value.bind(target):value
  },set(target,key,value){return Reflect.set(target,key,value,target)}})
  proxies.set(ws,proxy)
  return proxy
}
const gateway=Bun.serve({hostname:'127.0.0.1',port:0,fetch:handlers.fetch,websocket:{...handlers.websocket,
  open(ws){recordFor(ws).opens++;return handlers.websocket.open(observed(ws))},
  message(ws,message){return handlers.websocket.message(observed(ws),message)},
  drain(ws){const record=recordFor(ws);record.drains.push({at:performance.now(),bytes:ws.getBufferedAmount()});return handlers.websocket.drain?.(observed(ws))},
  close(ws,code,reason){recordFor(ws).nativeCloses.push({at:performance.now(),code,reason:String(reason)});return handlers.websocket.close(observed(ws),code,reason)},
}})

function maskedTextFrame(text){
  const body=Buffer.from(text),mask=randomBytes(4)
  assert(body.length<65_536)
  const header=body.length<126?Buffer.from([0x81,0x80|body.length]):Buffer.from([0x81,0xfe,body.length>>8,body.length&255])
  const encoded=Buffer.from(body)
  for(let i=0;i<encoded.length;i++)encoded[i]^=mask[i&3]
  return Buffer.concat([header,mask,encoded])
}
async function rawPausedReader(mode){
  const socket=net.connect({host:'127.0.0.1',port:gateway.port})
  socket.setNoDelay(true)
  const upgraded=new Promise((resolve,reject)=>{
    let header=Buffer.alloc(0)
    socket.on('error',reject)
    socket.on('data',function onData(chunk){
      header=Buffer.concat([header,chunk])
      const end=header.indexOf('\r\n\r\n')
      if(end<0)return
      socket.off('data',onData)
      socket.pause()
      const firstLine=header.subarray(0,end).toString().split('\r\n')[0]
      if(!firstLine.includes('101 Switching Protocols'))reject(new Error(`Upgrade failed: ${firstLine}`))
      else resolve({handshakeBytes:end+4,coalescedFrameBytes:header.length-end-4})
    })
  })
  await new Promise((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject)})
  const key=randomBytes(16).toString('base64')
  socket.write(`GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${gateway.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer raw-key\r\n\r\n`)
  const handshake=await upgraded
  socket.write(maskedTextFrame(JSON.stringify({type:'response.create',model:'up_pressure/synthetic-model',stream:true,store:false,input:mode})))
  return {socket,handshake,record:records.at(-1)}
}
async function waitFor(predicate,ms,label){
  const deadline=performance.now()+ms
  while(!predicate()&&performance.now()<deadline)await Bun.sleep(10)
  assert(predicate(),`${label} timed out: ${JSON.stringify({native:summary(),producer:producerEvents.slice(-8)})}`)
}
function summary(){return records.map((r,i)=>({socket:i,opens:r.opens,sends:r.sends.length,negativeSends:r.sends.filter(s=>s.result===-1).length,zeroSends:r.sends.filter(s=>s.result===0).length,peakBuffered:r.peakBuffered,drains:r.drains.length,closeCalls:r.closeCalls,nativeCloses:r.nativeCloses.length}))}

let timeoutReader,abortReader
try{
  await until(()=>producerPort)
  const now=new Date().toISOString()
  await getRepo().upstreams.save({id:'up_pressure',ownerId:'owner',provider:'custom',name:'pressure',enabled:true,sortOrder:0,
    config:{name:'pressure',baseUrl:`http://127.0.0.1:${producerPort}/up_pressure`,authStyle:'none',endpoints:['responses'],models:['synthetic-model']},
    state:{},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[{id:'direct_fetch'}],createdAt:now,updatedAt:now})

  timeoutReader=await rawPausedReader('pressure-timeout')
  const timed=timeoutReader.record
  await waitFor(()=>producerEvents.some(e=>e.kind==='call'&&e.mode==='pressure-timeout'),5000,'timeout producer call')
  await waitFor(()=>timed.sends.length>=2,5000,'timeout native output')
  await waitFor(()=>timed.closeCalls.length>0,12_000,'5-second pressure close')
  await waitFor(()=>producerEvents.some(e=>e.kind==='close'&&e.mode==='pressure-timeout'),5000,'timeout upstream abort')
  const timedClose=producerEvents.find(e=>e.kind==='close'&&e.mode==='pressure-timeout')
  assert.equal(timedClose.finished,false,'timeout must abort an unfinished upstream')
  assert(timed.sends.some(s=>s.result===-1),'paused reader did not exercise native send -1')
  assert(timed.peakBuffered>0,'native getBufferedAmount never observed queued bytes')
  assert(timed.drains.length>0,'native drain callback was not observed')
  assert(timed.sends.some(s=>s.result===-1&&timed.drains.some(d=>d.at>s.at)),'drain did not follow an already-enqueued send')
  assert(timed.sends.some(s=>timed.drains.some(d=>s.at>d.at)),'drain did not resume a new native send')
  assert.equal(timed.closeCalls[0].code,1008)
  assert(timed.peakBuffered<=RESPONSES_WS_SEND_HIGH_WATER_BYTES,`native buffer exceeded approved highwater: ${timed.peakBuffered}`)
  assert(timed.sends.every(s=>s.result!==0),'native send returned 0 (dropped)')
  const lastSend=timed.sends.at(-1).at,elapsedFromLastSendMs=Math.round(timed.closeCalls[0].at-lastSend)
  assert(elapsedFromLastSendMs>=RESPONSES_WS_DRAIN_TIMEOUT_MS-400&&elapsedFromLastSendMs<RESPONSES_WS_DRAIN_TIMEOUT_MS+2500,
    `pressure deadline differs from 5 seconds: ${elapsedFromLastSendMs}ms`)
  for(const sent of timed.sends.filter(s=>s.result===-1)){
    assert.equal(timed.sends.filter(s=>s.sequence===sent.sequence).length,1,`already-enqueued sequence ${sent.sequence} was resent`)
  }
  timeoutReader.socket.destroy()

  abortReader=await rawPausedReader('pressure-abrupt-abort')
  const abrupt=abortReader.record
  await waitFor(()=>producerEvents.some(e=>e.kind==='call'&&e.mode==='pressure-abrupt-abort'),5000,'abrupt producer call')
  await waitFor(()=>abrupt.sends.length>=2,5000,'abrupt native output')
  const destroyedAt=performance.now()
  abortReader.socket.destroy()
  await waitFor(()=>producerEvents.some(e=>e.kind==='close'&&e.mode==='pressure-abrupt-abort'),5000,'abrupt upstream abort')
  const abortClose=producerEvents.find(e=>e.kind==='close'&&e.mode==='pressure-abrupt-abort')
  assert.equal(abortClose.finished,false)
  assert(abortClose.at-destroyedAt<3000,`upstream abort took ${Math.round(abortClose.at-destroyedAt)}ms`)

  const report={passed:true,runtime:Bun.version,source:root,limits:{nativeHighWaterBytes:RESPONSES_WS_SEND_HIGH_WATER_BYTES,drainTimeoutMs:RESPONSES_WS_DRAIN_TIMEOUT_MS},
    cases:['native-paused-TCP-reader-bounded-buffer-5s-close-and-upstream-abort','native-paused-TCP-reader-abrupt-disconnect-aborts-upstream'],
    timeout:{handshake:timeoutReader.handshake,sends:timed.sends,peakBuffered:timed.peakBuffered,bufferSamples:timed.samples.length,drains:timed.drains,closeCalls:timed.closeCalls,upstream:timedClose,elapsedFromLastSendMs},
    abrupt:{handshake:abortReader.handshake,sends:abrupt.sends,peakBuffered:abrupt.peakBuffered,drains:abrupt.drains,closeCalls:abrupt.closeCalls,nativeCloses:abrupt.nativeCloses,upstream:abortClose,abortLatencyMs:Math.round(abortClose.at-destroyedAt)},
    negativeSendObserved:timed.sends.some(s=>s.result===-1)||abrupt.sends.some(s=>s.result===-1),
    caveat:'send acceptance and buffered bytes are server-side observations, not peer delivery or acknowledgement',scratch:fixture.scratch}
  console.log(JSON.stringify(report))
}finally{
  timeoutReader?.socket.destroy()
  abortReader?.socket.destroy()
  gateway.stop(true)
  producer.kill('SIGTERM')
  await fixture.finish()
}
