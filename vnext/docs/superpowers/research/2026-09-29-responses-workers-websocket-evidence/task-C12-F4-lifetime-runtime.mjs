import assert from 'node:assert/strict'
import {createFixture} from './task-C12-F4-runtime-fixture.mjs'

const LIMIT=16_777_216
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const create=JSON.stringify({type:'response.create',model:'gpt-5.4',input:'lifetime-partial',stream:true,store:false})
async function until(read,predicate,label,ms=12000){
  const end=Date.now()+ms
  while(Date.now()<end){
    const value=await read()
    if(predicate(value))return value
    await sleep(20)
  }
  throw new Error(`${label} timed out`)
}
async function open(f){
  const port=new URL(f.gatewayBase).port
  const socket=new WebSocket(`ws://127.0.0.1:${port}/v1/responses`,{headers:{authorization:`Bearer ${f.key}`}})
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true})
    socket.addEventListener('error',()=>reject(new Error('native upgrade failed')),{once:true})
  })
  return socket
}

const f=await createFixture({directNetwork:true})
let first,renewed
try{
  first=await open(f)
  let firstBytes=0,secondBytes=0,completed=0,secondStarted=false
  first.addEventListener('message',message=>{
    const event=JSON.parse(message.data)
    if(!secondStarted)firstBytes+=Buffer.byteLength(message.data)
    else secondBytes+=Buffer.byteLength(message.data)
    if(event.type==='response.completed'){
      completed++
      if(completed===1){secondStarted=true;first.send(create)}
    }
  })
  const closed=new Promise(resolve=>first.addEventListener('close',resolve,{once:true}))
  first.send(create)
  const firstClosed=await Promise.race([closed,sleep(12000).then(()=>{throw new Error('cumulative lifetime close timed out')})])
  const after=await f.observe({summary:true})
  const firstNative=after.connections.at(-1)
  assert.equal(completed,1,'the second turn must not deliver a terminal')
  assert.equal(firstClosed.code,1009)
  assert.equal(firstNative.close_calls.at(-1).code,1009)
  assert(firstBytes>7_000_000&&firstBytes<LIMIT)
  assert(secondBytes>7_000_000&&secondBytes<LIMIT)
  assert.equal(firstNative.sent_bytes,firstBytes+secondBytes)
  assert(firstNative.sent_bytes<=LIMIT&&firstNative.sent_bytes>LIMIT-1_048_576)
  assert.equal(after.upstream_requests.length,2)

  renewed=await open(f)
  const renewedEvents=[]
  let renewedBytes=0
  renewed.addEventListener('message',message=>{
    const event=JSON.parse(message.data)
    renewedEvents.push(event.type)
    renewedBytes+=Buffer.byteLength(message.data)
  })
  renewed.send(create)
  await until(()=>renewedEvents,events=>events.includes('response.completed'),'new-socket budget reset')
  assert.equal(renewed.readyState,WebSocket.OPEN)
  const reset=await f.observe({summary:true})
  const resetNative=reset.connections.at(-1)
  assert.equal(resetNative.close_calls.length,0)
  assert.equal(resetNative.sent_bytes,renewedBytes)
  assert(renewedBytes>7_000_000&&renewedBytes<LIMIT)
  assert.equal(reset.upstream_requests.length,3)
  console.log(JSON.stringify({nativeWorkerdLifetime:true,directNetwork:true,compatibilityDate:'2025-06-01',migrations:f.migrations.length,
    sameSocket:{firstTurnBytes:firstBytes,secondTurnBytes:secondBytes,totalNativeAcceptedBytes:firstNative.sent_bytes,limitBytes:LIMIT,
      closeCode:firstClosed.code,completedTerminals:completed},
    newSocket:{nativeAcceptedBytes:resetNative.sent_bytes,completedTerminals:renewedEvents.filter(type=>type==='response.completed').length,closeCalls:resetNative.close_calls.length}},null,2))
}finally{
  first?.close()
  renewed?.close()
  await f.stop()
}
