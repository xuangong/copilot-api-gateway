import assert from 'node:assert/strict'
import {createFixture} from './task-C12-F4-runtime-fixture.mjs'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const create=extra=>JSON.stringify({type:'response.create',model:'gpt-5.4',input:'hello',stream:true,store:false,...extra})
async function until(read,predicate,label,ms=7000){
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
  const events=[]
  socket.addEventListener('message',message=>events.push(JSON.parse(message.data)))
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true})
    socket.addEventListener('error',()=>reject(new Error('native WebSocket open failed')),{once:true})
  })
  return {socket,events}
}
async function closing(socket){
  return Promise.race([
    new Promise(resolve=>socket.addEventListener('close',resolve,{once:true})),
    sleep(7000).then(()=>{throw new Error('native close timed out')}),
  ])
}

const f=await createFixture({directNetwork:true})
const opened=[]
const cases=[]
try{
  const overlap=await open(f);opened.push(overlap)
  overlap.socket.send(create({input:'held-generation'}))
  await until(()=>overlap.events,events=>events.some(event=>event.type==='response.created'),'held created')
  const held=await f.observe({summary:true})
  assert.equal(held.upstream_requests.length,1)
  overlap.socket.send(create({input:'overlapping inference'}))
  await until(()=>overlap.events,events=>events.some(event=>event.type==='error'&&event.status===409),'overlap error')
  assert.equal(overlap.events.at(-1).error.code,'response_in_progress')
  assert.equal((await f.observe({summary:true})).upstream_requests.length,1)
  const overlapClose=closing(overlap.socket)
  overlap.socket.close(1000,'overlap complete')
  const reciprocal=await overlapClose
  assert.deepEqual({code:reciprocal.code,wasClean:reciprocal.wasClean},{code:1000,wasClean:true})
  const aborted=await until(()=>f.observe({summary:true}),value=>value.upstream_closes.length===1,'held upstream abort')
  assert.equal(aborted.upstream_closes[0].finished,false)
  assert.equal(aborted.connections.at(-1).close_calls.at(-1).code,1000)
  cases.push({case:'overlap_and_reciprocal_close',overlapStatus:409,extraUpstreamCalls:0,peerClose:{code:reciprocal.code,wasClean:reciprocal.wasClean},upstreamFinished:false})

  const malformed=await open(f);opened.push(malformed)
  malformed.socket.send('{')
  await until(()=>malformed.events,events=>events.some(event=>event.type==='error'),'invalid JSON')
  assert.equal(malformed.events.at(-1).error.code,'invalid_json')
  malformed.socket.send(create({stream_id:'unsupported'}))
  await until(()=>malformed.events,events=>events.filter(event=>event.type==='error').length===2,'unsupported field')
  assert.equal(malformed.events.at(-1).error.code,'unsupported_feature')
  malformed.socket.send(create({generate:false}))
  await until(()=>malformed.events,events=>events.some(event=>event.type==='response.completed'),'valid after malformed')
  assert.equal((await f.observe({summary:true})).upstream_requests.length,1)
  cases.push({case:'malformed_recovery',invalidJson:'invalid_json',unsupported:'unsupported_feature',subsequentWarmup:'response.completed',extraUpstreamCalls:0})

  const binary=await open(f);opened.push(binary)
  const binaryClose=closing(binary.socket)
  binary.socket.send(Buffer.from([1,2,3]))
  await until(()=>binary.events,events=>events.some(event=>event.type==='error'),'binary error')
  assert.equal(binary.events.at(-1).error.code,'unsupported_frame')
  const binaryClosed=await binaryClose
  const binaryObserved=(await f.observe({summary:true})).connections.at(-1)
  assert.equal(binaryObserved.close_calls.at(-1).code,1003)
  cases.push({case:'binary_frame',error:'unsupported_frame',nativeCloseCode:1003,peerCloseCode:binaryClosed.code})

  const oversized=await open(f);opened.push(oversized)
  const oversizeClose=closing(oversized.socket)
  oversized.socket.send(create({instructions:'x'.repeat(1_048_576)}))
  await until(()=>oversized.events,events=>events.some(event=>event.type==='error'),'oversize error')
  assert.equal(oversized.events.at(-1).error.code,'frame_too_large')
  const oversizeClosed=await oversizeClose
  const oversizeObserved=(await f.observe({summary:true})).connections.at(-1)
  assert.equal(oversizeObserved.close_calls.at(-1).code,1009)
  assert.equal((await f.observe({summary:true})).upstream_requests.length,1)
  cases.push({case:'oversize_inbound',error:'frame_too_large',nativeCloseCode:1009,peerCloseCode:oversizeClosed.code,extraUpstreamCalls:0})

  console.log(JSON.stringify({nativeWorkerdProtocol:true,directNetwork:true,compatibilityDate:'2025-06-01',migrations:f.migrations.length,cases},null,2))
}finally{
  for(const item of opened)item.socket.close()
  await f.stop()
}
