import assert from 'node:assert/strict'
import {createFixture} from './task-C12-F4-runtime-fixture.mjs'

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function run(directNetwork,{silent=false}={}){
  const f=await createFixture({directNetwork})
  let socket
  try{
    const port=new URL(f.gatewayBase).port
    socket=new WebSocket(`ws://127.0.0.1:${port}/v1/responses`,{headers:{authorization:`Bearer ${f.key}`}})
    await new Promise((resolve,reject)=>{
      socket.addEventListener('open',resolve,{once:true})
      socket.addEventListener('error',()=>reject(new Error('native upgrade failed')),{once:true})
    })
    const created=new Promise((resolve,reject)=>{
      socket.addEventListener('message',event=>{
        const parsed=JSON.parse(event.data)
        if(parsed.type==='response.created')resolve(parsed)
      })
      socket.addEventListener('error',()=>reject(new Error('socket error before created')),{once:true})
    })
    socket.send(JSON.stringify({type:'response.create',model:'gpt-5.4',input:silent?'silent-held-generation':'held-generation',stream:true,store:false}))
    const frame=await Promise.race([created,sleep(5000).then(()=>{throw new Error('created timed out')})])
    const before=await f.observe()
    assert.equal(before.upstream_requests.length,1)
    assert.match(JSON.stringify(before.upstream_requests[0]),/held-generation/)
    const closed=new Promise(resolve=>socket.addEventListener('close',resolve,{once:true}))
    socket.close(1000,'fixture control')
    const close=await Promise.race([closed,sleep(5000).then(()=>{throw new Error('reciprocal close timed out')})])
    let after=await f.observe()
    const end=Date.now()+5000
    while(!after.upstream_closes.some(row=>row.id===frame.response.id)&&Date.now()<end){await sleep(40);after=await f.observe()}
    return {directNetwork,silent,gatewayBase:f.gatewayBase,fixtureBase:f.fixtureBase,createdId:frame.response.id,close:{code:close.code,wasClean:close.wasClean},
      upstreamClose:after.upstream_closes.find(row=>row.id===frame.response.id)??null,
      nativeCloseCalls:after.connections[0]?.close_calls??[],nativeCloseEvents:after.connections[0]?.close_events??[],
      outboundResponseWasCreated:before.connections[0]?.sent.some(event=>event.type==='response.created')??false}
  }finally{
    socket?.close()
    await f.releaseHeld().catch(()=>{})
    await f.stop()
  }
}

const results=[]
for(const [directNetwork,silent] of [[false,false],[true,false],[true,true]]){
  try{results.push(await run(directNetwork,{silent}))}
  catch(error){results.push({directNetwork,silent,error:String(error)})}
}
console.log(JSON.stringify({bridgeControl:true,results},null,2))
assert.equal(results.length,3)
for(const row of results){
  assert.equal(row.error,undefined)
  assert.deepEqual(row.close,{code:1000,wasClean:true})
  assert.equal(row.outboundResponseWasCreated,true)
  assert.deepEqual(row.nativeCloseCalls,[{code:1000,reason:'Response session closed.'}])
}
assert.equal(results[0].upstreamClose,null,'bridge control must reproduce the missing cancellation')
assert.equal(results[1].upstreamClose?.finished,false,'direct workerd fetch must abort the Node response')
