import assert from 'node:assert/strict'
import {createFixture} from './task-C12-F4-runtime-fixture.mjs'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function until(read,predicate,label,ms=7000){
  const end=Date.now()+ms
  while(Date.now()<end){
    const value=await read()
    if(predicate(value))return value
    await sleep(20)
  }
  throw new Error(`${label} timed out`)
}
const create=extra=>JSON.stringify({type:'response.create',model:'gpt-5.4',input:'durable-first',stream:true,store:true,...extra})

const f=await createFixture({directNetwork:true})
let socket
try{
  await f.db.prepare("UPDATE api_keys SET responses_retention_seconds=86400 WHERE id='c12-f4-key'").run()
  const port=new URL(f.gatewayBase).port
  socket=new WebSocket(`ws://127.0.0.1:${port}/v1/responses`,{headers:{authorization:`Bearer ${f.key}`}})
  const events=[]
  let firstId,immediateSuccessorSent=false
  socket.addEventListener('message',message=>{
    const event=JSON.parse(message.data)
    events.push(event)
    if(event.type==='response.completed'&&!immediateSuccessorSent){
      firstId=event.response.id
      immediateSuccessorSent=true
      socket.send(create({previous_response_id:firstId,input:[]}))
    }
  })
  await new Promise((resolve,reject)=>{
    socket.addEventListener('open',resolve,{once:true})
    socket.addEventListener('error',()=>reject(new Error('native upgrade failed')),{once:true})
  })
  socket.send(create({input:'durable-first'}))
  await until(()=>events,rows=>rows.filter(event=>event.type==='response.completed').length===2,'immediate durable successor')
  assert.equal(events.filter(event=>event.type==='response.completed').length,2)
  assert.equal(events.some(event=>event.type==='error'),false)
  const snapshot=await f.db.prepare('SELECT response_id,api_key_id FROM responses_snapshots WHERE response_id=?').bind(firstId).first()
  assert.deepEqual(snapshot,{response_id:firstId,api_key_id:'c12-f4-key'})
  const observed=await f.observe({summary:true})
  assert.equal(observed.upstream_requests.length,2)
  assert.match(JSON.stringify(observed.upstream_requests[1]),/durable-first/)
  assert.equal(observed.connections.at(-1).close_calls.length,0)
  console.log(JSON.stringify({nativeWorkerdDurable:true,directNetwork:true,compatibilityDate:'2025-06-01',migrations:f.migrations.length,
    firstResponseId:firstId,snapshotPresentAfterSuccessor:true,immediateSuccessorCompleted:true,upstreamCalls:observed.upstream_requests.length},null,2))
}finally{
  socket?.close()
  await f.stop()
}
