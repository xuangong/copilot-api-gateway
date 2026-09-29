import assert from 'node:assert/strict'
import {connect} from 'node:net'
import {randomBytes} from 'node:crypto'
import {createFixture} from './task-C12-F4-runtime-fixture.mjs'

const LIMIT=16_777_216
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const create=JSON.stringify({type:'response.create',model:'gpt-5.4',input:'pressure-flood',stream:true,store:false})
async function until(read,predicate,label,ms=12000){
  const end=Date.now()+ms
  while(Date.now()<end){
    const value=await read()
    if(predicate(value))return value
    await sleep(30)
  }
  throw new Error(`${label} timed out`)
}
function maskedText(value){
  const payload=Buffer.from(value),mask=randomBytes(4)
  const header=payload.length<126?Buffer.from([0x81,0x80|payload.length]):Buffer.from([0x81,0xfe,payload.length>>8,payload.length&0xff])
  const masked=Buffer.alloc(payload.length)
  for(let index=0;index<payload.length;index++)masked[index]=payload[index]^mask[index%4]
  return Buffer.concat([header,mask,masked])
}
async function pausedSocket(port,key){
  const socket=connect(Number(port),'127.0.0.1')
  const status=await new Promise((resolve,reject)=>{
    let head=''
    socket.setTimeout(5000,()=>reject(new Error('paused socket handshake timeout')))
    socket.once('error',reject)
    socket.on('data',chunk=>{
      head+=chunk.toString()
      if(!head.includes('\r\n\r\n'))return
      resolve(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1])
    })
    socket.write([
      'GET /v1/responses HTTP/1.1',`Host: 127.0.0.1:${port}`,
      'Connection: keep-alive, Upgrade','Upgrade: websocket',
      'Sec-WebSocket-Key: AQIDBAUGBwgJCgsMDQ4PEA==','Sec-WebSocket-Version: 13',
      `Authorization: Bearer ${key}`,'','',
    ].join('\r\n'))
  })
  assert.equal(Number(status),101)
  socket.pause()
  socket.write(maskedText(create))
  return socket
}

const f=await createFixture({directNetwork:true})
let reader,paused
const cases=[]
try{
  const port=new URL(f.gatewayBase).port
  reader=new WebSocket(`ws://127.0.0.1:${port}/v1/responses`,{headers:{authorization:`Bearer ${f.key}`}})
  let frames=0,receivedBytes=0,terminalSeen=false
  reader.addEventListener('message',event=>{
    frames++;receivedBytes+=Buffer.byteLength(event.data)
    const type=JSON.parse(event.data).type
    if(type==='response.completed'||type==='response.failed')terminalSeen=true
  })
  await new Promise((resolve,reject)=>{
    reader.addEventListener('open',resolve,{once:true})
    reader.addEventListener('error',()=>reject(new Error('reader upgrade failed')),{once:true})
  })
  const close=new Promise(resolve=>reader.addEventListener('close',resolve,{once:true}))
  reader.send(create)
  const closed=await Promise.race([close,sleep(12000).then(()=>{throw new Error('reader lifetime close timed out')})])
  const after=await until(()=>f.observe({summary:true}),value=>value.upstream_closes.length>=1,'reader upstream cancellation')
  const observed=after.connections.at(-1)
  assert.equal(closed.code,1009)
  assert.equal(observed.close_calls.at(-1)?.code,1009)
  assert(observed.sent_bytes<=LIMIT)
  assert(observed.sent_bytes>LIMIT-1_048_576)
  assert.equal(after.upstream_closes.at(-1).finished,false)
  assert.equal(terminalSeen,false)
  cases.push({case:'readable_lifetime',closeCode:closed.code,wasClean:closed.wasClean,frames,receivedBytes,nativeAcceptedBytes:observed.sent_bytes,limitBytes:LIMIT,upstreamFinished:after.upstream_closes.at(-1).finished,terminalSeen})

  const before=(await f.observe({summary:true})).connections.length
  paused=await pausedSocket(port,f.key)
  const saturated=await until(()=>f.observe({summary:true}),value=>value.connections.length>before&&value.connections.at(-1).close_calls.length>0,'paused-reader lifetime close')
  const last=saturated.connections.at(-1)
  assert.equal(last.close_calls.at(-1).code,1009)
  assert(last.sent_bytes<=LIMIT)
  assert(last.sent_bytes>LIMIT-1_048_576)
  const aborted=await until(()=>f.observe({summary:true}),value=>value.upstream_closes.length>=2,'paused-reader upstream cancellation')
  assert.equal(aborted.upstream_closes.at(-1).finished,false)
  assert.equal(last.last_sent_type,'response.output_text.delta')
  cases.push({case:'paused_native_tcp_reader',closeCode:last.close_calls.at(-1).code,nativeAcceptedBytes:last.sent_bytes,limitBytes:LIMIT,
    sentFrames:last.sent_count,lastSentType:last.last_sent_type,upstreamFinished:aborted.upstream_closes.at(-1).finished})

  console.log(JSON.stringify({nativeWorkerdPressure:true,directNetwork:true,compatibilityDate:'2025-06-01',migrations:f.migrations.length,cases},null,2))
}finally{
  reader?.close()
  paused?.destroy()
  await f.stop()
}
