import assert from 'node:assert/strict'
import {createFixture} from './task-C12-F2-runtime-fixture.mjs'
const fixture=await createFixture(process.env.VNEXT_PROBE_ROOT)
const {source,calls,closes,until,background}=fixture
const {authorizeResponsesSession,createResponsesSession}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/session.ts`)
const {RESPONSES_WS_SEND_HIGH_WATER_BYTES,RESPONSES_WS_MAX_CONTROL_BYTES}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/session-limits.ts`)
const sessions=[],cases=[]
const create={type:'response.create',model:'up_responses/synthetic-model',stream:true,store:false,input:'Synthetic input'}
async function make({buffer=()=>0,send=()=> 'accepted',observable=true}={}){
 const request={url:'http://local/v1/responses',headers:new Headers({authorization:'Bearer raw-key'})}
 const authorization=await authorizeResponsesSession(new Request(request.url,{headers:request.headers}))
 const sent=[],attempts=[],closed=[]
 const session=createResponsesSession({authorization,request,background,transport:{pressure:observable?{kind:'observable',bufferedBytes:buffer}:{kind:'unobservable'},sendText:text=>{const event=JSON.parse(text);attempts.push(event);const result=send(event);if(result!=='failed')sent.push({event,bytes:Buffer.byteLength(text)});return result},close:(code,reason)=>closed.push({code,reason})}})
 const h={session,sent,attempts,closed,send:body=>session.receiveText(JSON.stringify({...create,...body}))};sessions.push(h);return h
}
try{
 let bytes=RESPONSES_WS_SEND_HIGH_WATER_BYTES+1
 const high=await make({buffer:()=>bytes}),before=calls.length
 high.send({})
 await new Promise(r=>setTimeout(r,100))
 assert.equal(calls.length,before);assert.equal(high.sent.length,0)
 bytes=0;high.session.drain()
 await until(()=>high.sent.some(x=>x.event.type==='response.completed'))
 assert.equal(calls.length,before+1)
 cases.push('observable-highwater-gates-inference-until-drain')
 const pressure=await make({send:event=>event.type==='response.created'?'backpressured':'accepted'})
 pressure.send({})
 await until(()=>pressure.sent.some(x=>x.event.type==='response.created'))
 await new Promise(r=>setTimeout(r,100))
 assert.equal(pressure.sent.length,1)
 pressure.session.drain()
 await until(()=>pressure.sent.some(x=>x.event.type==='response.completed'))
 assert.equal(pressure.attempts.filter(x=>x.type==='response.created').length,1)
 cases.push('already-enqueued-backpressured-frame-not-retransmitted')
 const timeout=await make({buffer:()=>RESPONSES_WS_SEND_HIGH_WATER_BYTES+1}),time=performance.now(),timeoutCalls=calls.length
 timeout.send({})
 await until(()=>timeout.closed.length,6500)
 const elapsedMs=Math.round(performance.now()-time)
 assert(elapsedMs>=4900&&elapsedMs<6500);assert.equal(calls.length,timeoutCalls)
 assert.equal((await timeout.session.close()).cleanupComplete,true)
 cases.push(`absolute-pressure-timeout-without-inference-${elapsedMs}ms`)
 const active=await make(),start=calls.length
 active.send({input:'held-generation'})
 await until(()=>calls.length===start+1&&active.sent.length)
 const id=calls.at(-1).id
 active.session.receiveBinary()
 await until(()=>active.closed.length&&closes.some(x=>x.id===id&&!x.finished))
 assert.equal(active.closed[0].code,1003)
 assert.equal((await active.session.close()).cleanupComplete,true)
 cases.push('binary-frame-closes-and-aborts-actual-upstream')
 const control=await make({observable:false})
 for(let i=0;i<2000&&!control.closed.length;i++)control.session.receiveText('{')
 const controlBytes=control.sent.reduce((n,x)=>n+x.bytes,0)
 assert(control.closed.length);assert(controlBytes<=RESPONSES_WS_MAX_CONTROL_BYTES)
 assert(controlBytes>RESPONSES_WS_MAX_CONTROL_BYTES-1024);assert.equal(control.closed[0].code,1009)
 cases.push('unobservable-control-replies-have-cumulative-byte-bound')
 const bad=await make({buffer:()=>NaN}),badCalls=calls.length
 bad.send({})
 await until(()=>bad.closed.length)
 assert.equal(calls.length,badCalls)
 cases.push('invalid-pressure-state-fails-closed-before-inference')
 console.log(JSON.stringify({passed:true,cases,controlBytes,runtime:'real session/SQLite/independent Node upstream; synthetic transport pressure only',scratch:fixture.scratch}))
}finally{
 for(const {session}of sessions)await session.close('fixture shutdown')
 await fixture.finish()
}
