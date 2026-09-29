/* global Bun */
import assert from 'node:assert/strict'
import {createFixture} from '../2026-09-29-responses-session-evidence/task-C12-F2-runtime-fixture.mjs'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const fixture=await createFixture(root)
const {source,calls,closes,until,external}=fixture
const {app}=await import(`${source}/packages/gateway/src/app.ts`)
const {createResponsesWebSocketHandlers}=await import(`${source}/apps/platform-bun/src/responses-websocket.ts`)
const handlers=createResponsesWebSocketHandlers({app})
const native={opens:0,closes:0,drains:0,sends:[],peakBuffer:0}
const sockets=new WeakMap()
function observed(ws){
 let value=sockets.get(ws);if(value)return value
 value=new Proxy(ws,{get(target,key){
  if(key==='send')return (...args)=>{const result=target.send(...args);native.sends.push({bytes:Buffer.byteLength(args[0]),result});native.peakBuffer=Math.max(native.peakBuffer,target.getBufferedAmount());return result}
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value
 },set(target,key,value){return Reflect.set(target,key,value,target)}})
 sockets.set(ws,value);return value
}
const gateway=Bun.serve({hostname:'127.0.0.1',port:0,fetch:handlers.fetch,websocket:{...handlers.websocket,
 open(ws){native.opens++;return handlers.websocket.open(observed(ws))},
 message(ws,message){return handlers.websocket.message(observed(ws),message)},
 close(ws,code,reason){native.closes++;return handlers.websocket.close(observed(ws),code,reason)},
 drain(ws){native.drains++;return handlers.websocket.drain?.(observed(ws))},
 ...(handlers.websocket.error?{error(ws,error){return handlers.websocket.error(observed(ws),error)}}:{})
}})
const base=`http://127.0.0.1:${gateway.port}`,sessions=[],cases=[]
const create={type:'response.create',model:'up_responses/synthetic-model',stream:true,store:false}
const terminal=e=>['response.completed','response.failed','response.incomplete','error'].includes(e.type)
async function connect(path='/v1/responses',key='raw-key'){
 const sent=[],closed=[],errors=[]
 const ws=new WebSocket(`${base.replace('http:','ws:')}${path}`,{headers:{authorization:`Bearer ${key}`}})
 ws.addEventListener('message',event=>sent.push(JSON.parse(event.data)))
 ws.addEventListener('close',event=>closed.push({code:event.code,reason:event.reason}))
 ws.addEventListener('error',event=>errors.push(event.message??'error'))
 await until(()=>ws.readyState===1||closed.length||errors.length)
 assert.equal(ws.readyState,1,JSON.stringify({closed,errors}))
 const handle={ws,sent,closed,errors,send:body=>ws.send(JSON.stringify({...create,...body}))}
 sessions.push(handle);return handle
}
async function turn(h,body){const start=h.sent.length;h.send(body);await until(()=>h.sent.slice(start).some(terminal)||h.closed.length);return h.sent.slice(start)}
async function upgradeStatus(path,credential){
 const headers={upgrade:'websocket',connection:'Upgrade','sec-websocket-key':Buffer.alloc(16,7).toString('base64'),'sec-websocket-version':'13',...(credential?{authorization:`Bearer ${credential}`}:{})}
 const response=await fetch(base+path,{headers});await response.text();return response.status
}
try{
 for(const path of ['/responses','/v1/responses','/azure-api.codex/responses','/azure-api.codex/v1/responses']){
  const h=await connect(path),before=calls.length
  const events=await turn(h,{input:'route warmup',generate:false})
  assert.deepEqual(events.map(e=>e.type),['response.created','response.completed']);assert.equal(calls.length,before)
  h.ws.close();await until(()=>h.closed.length)
 }
 assert.equal(await upgradeStatus('/v1/responses'),401)
 assert.equal(await upgradeStatus('/v1/responses','invalid-synthetic'),401)
 assert.equal(await upgradeStatus('/v1/responses?key=synthetic','raw-key'),400)
 assert.equal((await fetch(`${base}/v1/responses`,{headers:{authorization:'Bearer raw-key'}})).status,404)
 cases.push('four-native-upgrade-routes-auth-before101-and-ordinaryGET-preserved')
 const beforeHttp=calls.length,http=await fetch(`${base}/v1/responses`,{method:'POST',headers:{authorization:'Bearer raw-key','content-type':'application/json'},body:JSON.stringify({model:create.model,input:'HTTP preserved',store:false})})
 assert.equal(http.status,200);assert.equal((await http.json()).status,'completed');await until(()=>calls.length===beforeHttp+1)
 cases.push('HTTP-POST-still-shares-real-Responses-pipeline')
 const first=await connect(),warm={input:[{role:'user',content:'Native warmup input'}],instructions:'Native synthetic instruction',tools:[{type:'function',name:'synthetic_tool',parameters:{type:'object',properties:{},additionalProperties:false},strict:true}]}
 const before=calls.length,ack=await turn(first,{...warm,generate:false})
 assert.deepEqual(ack.map(e=>e.type),['response.created','response.completed']);assert.equal(ack[0].response.id,ack[1].response.id);assert.equal(calls.length,before)
 const generated=await turn(first,{previous_response_id:ack[1].response.id,input:[]})
 assert.equal(generated.at(-1).type,'response.completed');await until(()=>calls.length===before+1)
 assert.deepEqual(calls.at(-1).body.input,warm.input.map(x=>({type:'message',...x})));assert.deepEqual(calls.at(-1).body.tools,warm.tools);assert.equal(calls.at(-1).body.instructions,warm.instructions)
 const firstId=generated.at(-1).response.id
 const second=await connect(),privateMiss=await turn(second,{previous_response_id:firstId,input:[]})
 assert.equal(privateMiss.at(-1).error.code,'previous_response_not_found');assert.equal(calls.length,before+1)
 const continuation=await turn(first,{previous_response_id:firstId,input:[{role:'user',content:'Native next turn'}]})
 assert.equal(continuation.at(-1).type,'response.completed');assert(JSON.stringify(calls.at(-1).body.input).includes('Synthetic answer'))
 cases.push('native-zero-inference-warmup-fullstate-and-private-local-continuation')
 const durable=await connect('/v1/responses','raw-durable')
 let immediate=false
 durable.ws.addEventListener('message',event=>{const e=JSON.parse(event.data);if(e.type==='response.completed'&&!immediate){immediate=true;durable.send({previous_response_id:e.response.id,input:'Immediate native successor',store:true})}})
 durable.send({input:'Native durable original',store:true})
 await until(()=>durable.sent.filter(e=>e.type==='response.completed').length===2)
 assert(!durable.sent.some(e=>e.type==='error'));assert.equal(durable.sent.filter(e=>e.type==='response.completed').length,2)
 cases.push('durable-native-terminal-immediate-successor-admitted')
 const held=await connect(),heldBefore=calls.length
 held.send({input:'held-generation'});await until(()=>calls.length===heldBefore+1&&held.sent.some(e=>e.type==='response.created'))
 held.ws.send('{');held.send({input:'overlap no inference'})
 await until(()=>held.sent.filter(e=>e.type==='error').length===2);assert.equal(calls.length,heldBefore+1)
 await fetch(`${fixture.upstreamBase}/_fixture/release`);await until(()=>held.sent.some(e=>e.type==='response.completed'))
 cases.push('native-malformed-and-overlap-do-not-cancel-active-generation')
 const failed=await connect(),failure=await turn(failed,{input:'fail-generation'})
 assert.equal(failure.at(-1).type,'response.failed')
 await new Promise(r=>setTimeout(r,20))
 assert.equal((await turn(failed,{input:'Full native recovery'})).at(-1).type,'response.completed')
 cases.push('native-upstream-failure-then-full-request-recovery')
 const abort=await connect(),abortBefore=calls.length
 abort.send({input:'held-generation'});await until(()=>calls.length===abortBefore+1)
 const abortId=calls.at(-1).id;abort.ws.terminate()
 await until(()=>closes.some(x=>x.id===abortId&&!x.finished))
 cases.push('native-abrupt-client-termination-aborts-independent-upstream')
 const binary=await connect(),binaryBefore=calls.length
 binary.send({input:'held-generation'});await until(()=>calls.length===binaryBefore+1)
 const binaryId=calls.at(-1).id;binary.ws.send(new Uint8Array([1,2,3]));await until(()=>binary.closed.length&&closes.some(x=>x.id===binaryId&&!x.finished))
 assert.equal(binary.closed[0].code,1003)
 cases.push('native-binary-frame-reject-and-upstream-abort')
 const oversized=await connect(),oversizedCalls=calls.length;oversized.ws.send('x'.repeat(1024*1024+1));await until(()=>oversized.closed.length);assert.equal(calls.length,oversizedCalls)
 cases.push('native-maxPayloadLength-closes-before-inference')
 const revoked=await connect('/v1/responses','raw-other-key');await turn(revoked,{input:'Before deletion',generate:false})
 external.query('DELETE FROM api_keys WHERE id=?').run('other-key')
 const revCalls=calls.length,denied=await turn(revoked,{input:'After deletion'});assert.equal(denied.at(-1).status,401);assert.equal(calls.length,revCalls)
 cases.push('native-next-message-rechecks-external-SQL-key-revocation')
 const owner=await connect();await turn(owner,{input:'Before owner disable',generate:false});external.query('UPDATE users SET disabled=1 WHERE id=?').run('owner')
 const ownerCalls=calls.length,disabled=await turn(owner,{input:'After owner disable'});assert.equal(disabled.at(-1).status,401);assert.equal(calls.length,ownerCalls)
 external.query('UPDATE users SET disabled=0 WHERE id=?').run('owner')
 cases.push('native-next-message-rechecks-external-SQL-owner-disable')
 assert(native.sends.every(x=>x.result!==0));assert(native.peakBuffer<=1024*1024)
 console.log(JSON.stringify({passed:true,cases,native:{...native,sends:native.sends.length},runtime:'real Bun production callbacks + native WS + real SQLite/second connection + independent Node HTTP/SSE',scratch:fixture.scratch}))
}finally{
 for(const h of sessions)if(h.ws.readyState<2)h.ws.close()
 await until(()=>sessions.every(h=>h.ws.readyState===3),3000).catch(()=>{})
 gateway.stop(true);await fixture.finish()
}
