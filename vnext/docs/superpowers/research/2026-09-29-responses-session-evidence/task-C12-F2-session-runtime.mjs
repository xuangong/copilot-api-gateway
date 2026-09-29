import assert from 'node:assert/strict'
import {createFixture} from './task-C12-F2-runtime-fixture.mjs'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const fixture=await createFixture(root)
const {source,calls,closes,until,external,background,pending}=fixture
const {authorizeResponsesSession,createResponsesSession}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/session.ts`)
const sessions=[],cases=[]
const create={type:'response.create',model:'up_responses/synthetic-model',stream:true,store:false}
const terminal=e=>['response.completed','response.failed','response.incomplete','error'].includes(e.type)
async function make(raw='raw-key',hook){
  const request={url:'http://local/v1/responses',headers:new Headers({authorization:`Bearer ${raw}`})}
  const authorization=await authorizeResponsesSession(new Request(request.url,{headers:request.headers}))
  const sent=[],closed=[],attempted=[]
  const session=createResponsesSession({authorization,request,background,transport:{pressure:{kind:'observable',bufferedBytes:()=>0},sendText:text=>{const e=JSON.parse(text);attempted.push(e);const outcome=hook?.(e,session)??'accepted';if(outcome!=='failed')sent.push(e);return outcome},close:(code,reason)=>closed.push({code,reason})}})
  const handle={session,sent,closed,attempted,send:body=>session.receiveText(JSON.stringify({...create,...body}))}
  sessions.push(handle);return handle
}
async function turn(handle,body){
  const start=handle.sent.length
  handle.send(body)
  await until(()=>handle.sent.slice(start).some(terminal))
  return handle.sent.slice(start)
}
try{
  const first=await make(),warm={input:[{role:'user',content:'Warmup original input'}],instructions:'Synthetic instruction',tools:[{type:'function',name:'synthetic_tool',parameters:{type:'object',properties:{},additionalProperties:false},strict:true}],reasoning:{effort:'low'},text:{format:{type:'text'}}}
  const ack=await turn(first,{...warm,generate:false})
  assert.deepEqual(ack.map(e=>e.type),['response.created','response.completed'])
  assert.equal(ack[0].response.id,ack[1].response.id);assert.equal(calls.length,0)
  const warmId=ack[1].response.id
  const generated=await turn(first,{previous_response_id:warmId,input:[]})
  assert.equal(generated.at(-1).type,'response.completed');await until(()=>calls.length===1)
  assert.deepEqual(calls[0].body.input,warm.input.map(item=>({type:'message',...item})));assert.equal(calls[0].body.instructions,warm.instructions)
  assert.deepEqual(calls[0].body.tools,warm.tools);assert.deepEqual(calls[0].body.reasoning,warm.reasoning)
  assert(!Object.hasOwn(calls[0].body,'generate'));assert(!Object.hasOwn(calls[0].body,'type'));assert(!Object.hasOwn(calls[0].body,'previous_response_id'))
  cases.push('warmup-zero-inference-full-input-tools-instructions-restored')
  const responseId=generated.at(-1).response.id
  const continued=await turn(first,{previous_response_id:responseId,input:[{role:'user',content:'Next input'}]})
  assert.equal(continued.at(-1).type,'response.completed');await until(()=>calls.length===2)
  assert(JSON.stringify(calls[1].body.input).includes('Synthetic answer'))
  const second=await make(),before=calls.length
  const missing=await turn(second,{previous_response_id:responseId,input:[]})
  assert.equal(missing.at(-1).type,'error');assert.equal(missing.at(-1).error.code,'previous_response_not_found');assert.equal(calls.length,before)
  cases.push('same-connection-store-false-private-continuation')
  const invalidWarm=await turn(second,{input:'unsupported durable warmup',generate:false,store:true})
  assert.equal(invalidWarm.at(-1).type,'error');assert.equal(calls.length,before)
  cases.push('durable-warmup-rejected-without-inference')
  const chat=await make(),chatEvents=await turn(chat,{model:'up_chat/synthetic-model',input:'Chat translation'})
  assert.equal(chatEvents.at(-1).type,'response.completed');assert.equal(chatEvents.at(-1).response.usage.output_tokens,7)
  cases.push('real-Chat-hub-shared-turn-and-trailing-usage')
  const active=await make(),activeStart=calls.length
  active.send({input:'held-generation'})
  await until(()=>calls.length===activeStart+1&&active.sent.some(e=>e.type==='response.created'))
  active.session.receiveText('{')
  active.send({input:'overlap must not infer'})
  await until(()=>active.sent.filter(e=>e.type==='error').length>=2)
  assert.equal(calls.length,activeStart+1);assert.equal(active.session.state,'running')
  await fetch(`${fixture.upstreamBase}/_fixture/release`)
  await until(()=>active.sent.some(e=>e.type==='response.completed'))
  assert.equal(active.sent.filter(e=>e.type==='response.completed').length,1)
  cases.push('malformed-and-overlap-preserve-active-generation-no-queue')
  const failed=await make(),failedEvents=await turn(failed,{input:'fail-generation'})
  assert.equal(failedEvents.at(-1).type,'response.failed')
  await Promise.allSettled([...pending])
  const recovered=await turn(failed,{input:'fresh full request'})
  assert.equal(recovered.at(-1).type,'response.completed')
  cases.push('failed-generation-settles-and-allows-fresh-request')
  const abort=await make(),abortBefore=calls.length
  abort.send({input:'held-generation'})
  await until(()=>calls.length===abortBefore+1)
  const abortedId=calls.at(-1).id
  const closeResult=await abort.session.close('synthetic disconnect')
  assert.equal(closeResult.cleanupComplete,true)
  await until(()=>closes.some(c=>c.id===abortedId&&!c.finished))
  assert(!abort.sent.some(e=>e.type==='response.completed'))
  cases.push('session-close-aborts-real-independent-upstream-socket')
  const dropped=await make('raw-key',event=>event.type==='response.created'?'failed':'accepted'),dropBefore=calls.length
  dropped.send({input:'held-generation'})
  await until(()=>calls.length===dropBefore+1&&dropped.closed.length>0)
  const droppedId=calls.at(-1).id
  await until(()=>closes.some(c=>c.id===droppedId&&!c.finished))
  assert(!dropped.sent.some(e=>e.type==='response.completed'));assert.equal(calls.length,dropBefore+1)
  assert.equal(dropped.attempted.filter(e=>e.type==='response.created').length,1)
  cases.push('dropped-native-send-aborts-upstream-without-inference-retry')
  const opaque=await make(),opaqueEvents=await turn(opaque,{input:'opaque-state'})
  const opaqueResponse=opaqueEvents.at(-1).response
  const signed=opaqueResponse.output.find(item=>item.type==='reasoning')?.encrypted_content
  assert.equal(typeof signed,'string');assert.notEqual(signed,'synthetic-opaque-source')
  const opaqueBefore=calls.length
  const replay=await turn(opaque,{previous_response_id:opaqueResponse.id,input:[]})
  assert.equal(replay.at(-1).type,'response.completed');await until(()=>calls.length===opaqueBefore+1)
  assert(calls.at(-1).body.input.some(item=>item.type==='reasoning'&&item.encrypted_content==='synthetic-opaque-source'))
  cases.push('connection-local-canonical-carrier-replay-reaches-owner-upstream-raw')
  const revoked=await make('raw-other-key');await turn(revoked,{input:'Before revocation',generate:false})
  const revokeCalls=calls.length
  external.query('DELETE FROM api_keys WHERE id=?').run('other-key')
  const rejection=await turn(revoked,{input:'After external revocation'})
  assert.equal(rejection.at(-1).type,'error');assert.equal(rejection.at(-1).status,401);assert.equal(calls.length,revokeCalls)
  cases.push('separate-SQL-connection-key-revocation-rechecked')
  const disabled=await make();await turn(disabled,{input:'Before disable',generate:false})
  external.query('UPDATE users SET disabled=1 WHERE id=?').run('owner')
  const disableCalls=calls.length,denied=await turn(disabled,{input:'After external owner disable'})
  assert.equal(denied.at(-1).type,'error');assert([401,403].includes(denied.at(-1).status));assert.equal(calls.length,disableCalls)
  external.query('UPDATE users SET disabled=0 WHERE id=?').run('owner')
  cases.push('separate-SQL-connection-owner-disable-rechecked')
  console.log(JSON.stringify({passed:true,runtime:'real shared session + SQLite/second connection + independent Node HTTP/SSE upstream; synthetic native transport acceptance only',cases,calls:calls.length,scratch:fixture.scratch}))
}finally{
  for(const {session}of sessions)await session.close('fixture shutdown')
  await fixture.finish()
}
