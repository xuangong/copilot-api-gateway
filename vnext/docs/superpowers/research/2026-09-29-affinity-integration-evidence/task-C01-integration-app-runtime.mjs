import assert from 'node:assert/strict'
import {serve} from 'bun'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const source=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
const {initBackground,initSocketDial}=await import(`${source}/packages/platform/src/index.ts`)
const {getRepo}=await import(`${source}/packages/gateway/src/repo/index.ts`)
const {app}=await import(`${source}/packages/gateway/src/app.ts`)
const {synthesizeResponsesFramesFromJson}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`)
const {synthesizeMessagesFramesFromJson}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c01-app-runtime-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const now=new Date().toISOString(),calls=[]
for(const owner of ['owner','foreign'])await db.prepare('INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)').bind(owner,owner,`${owner}@example.invalid`,now).run()
for(const [id,owner] of [['key','owner'],['key2','owner'],['foreign-key','foreign']])await db.prepare('INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)').bind(id,id,`raw-${id}`,now,owner,86400).run()
let serial=0
const upstream=serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const body=await req.json(),up=new URL(req.url).pathname.split('/')[1];calls.push({up,body})
 if(new URL(req.url).pathname.endsWith('/messages')){
  const result={id:`msg_${++serial}`,type:'message',role:'assistant',model:body.model,content:[{type:'thinking',thinking:'  Synthetic thought \n',signature:'synthetic-signature'},{type:'text',text:'Synthetic answer'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:5,output_tokens:3}}
  if(!body.stream)return Response.json(result)
  let text='';for await(const f of synthesizeMessagesFramesFromJson(result)){if(f.type==='event')text+=`event: ${f.event.type}\ndata: ${JSON.stringify(f.event)}\n\n`}
  return new Response(text,{headers:{'content-type':'text/event-stream'}})
 }
 const inputText=JSON.stringify(body.input??[]),required=inputText.includes('make-compaction'),agent=inputText.includes('make-agent')
 const item=agent?{type:'agent_message',id:`agent_${++serial}`,author:'assistant',recipient:'all',agent:{agent_name:'synthetic-agent'},content:[{type:'text',text:'Synthetic agent context'},{type:'encrypted_content',encrypted_content:'synthetic-agent-opaque'},{type:'encrypted_content',encrypted_content:'synthetic-agent-second'}]}:required?{type:'compaction',id:`cmp_${++serial}`,encrypted_content:'synthetic-compaction'}:{type:'reasoning',id:`rs_${++serial}`,summary:[{type:'summary_text',text:'  Synthetic thought \n'}],encrypted_content:'synthetic-reasoning'}
 const result={id:`resp_fixture_${serial}`,object:'response',model:body.model,output:[item],status:'completed',error:null,incomplete_details:null,usage:{input_tokens:5,output_tokens:3,total_tokens:8}}
 if(!body.stream)return Response.json(result)
 let text='';for await(const f of synthesizeResponsesFramesFromJson(result)){if(f.type==='event')text+=`event: ${f.event.type}\ndata: ${JSON.stringify(f.event)}\n\n`}
 return new Response(text,{headers:{'content-type':'text/event-stream'}})
}})
for(const [id,owner,order,endpoints]of [['up_a','owner',0,['responses','messages']],['up_b','owner',1,['responses','messages']],['up_foreign','foreign',0,['responses','messages']],['up_responses','owner',2,['responses']],['up_messages','owner',3,['messages']]])await getRepo().upstreams.save({id,ownerId:owner,provider:'custom',name:id,enabled:true,sortOrder:order,config:{name:id,baseUrl:`http://127.0.0.1:${upstream.port}/${id}`,authStyle:'none',endpoints,models:['synthetic-model']},state:{},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[{id:'direct_fetch'}],createdAt:now,updatedAt:now})
const server=serve({hostname:'127.0.0.1',port:0,fetch:req=>app.fetch(req,{})})
const request=async(extra={},key='key',protocol='responses')=>{
 const response=await fetch(`http://127.0.0.1:${server.port}/v1/${protocol}`,{method:'POST',headers:{authorization:`Bearer raw-${key}`,'content-type':'application/json'},body:JSON.stringify({model:'up_a/synthetic-model',...(protocol==='messages'?{max_tokens:128,messages:[{role:'user',content:'synthetic request'}]}:{input:[{role:'user',content:'synthetic request'}]}),stream:false,...extra})})
 const text=await response.text();return{status:response.status,text,json:response.headers.get('content-type')?.includes('application/json')?JSON.parse(text):null}
}
try{
 const first=await request();assert.equal(first.status,200,first.text)
 const item=first.json.output.find(i=>i.type==='reasoning');assert(item)
 if(process.env.C01_BASELINE==='1'){
  const responsesViaMessages=await request({model:'up_messages/synthetic-model'}),messagesViaResponses=await request({model:'up_responses/synthetic-model'},'key','messages')
  assert.equal(responsesViaMessages.status,200,responsesViaMessages.text);assert.equal(messagesViaResponses.status,200,messagesViaResponses.text)
  const reasoning=responsesViaMessages.json.output?.find(i=>i.type==='reasoning'),thinking=messagesViaResponses.json.content?.find(i=>i.type==='thinking')
  console.log(JSON.stringify({baseline:true,status:first.status,carrierActivated:item.encrypted_content.startsWith('vnext-affinity:'),crossResponsesKeepsOpaque:typeof reasoning?.encrypted_content==='string',crossMessagesKeepsOpaque:typeof thinking?.signature==='string',crossMessagesKeepsCompanion:thinking?.thinking==='  Synthetic thought \n',calls:calls.length}));process.exitCode=0
 }
 else{
  assert(item.encrypted_content.startsWith('vnext-affinity:'),'No authenticated egress carrier')
  const follow=await request({input:[item,{role:'user',content:'next'}]});assert.equal(follow.status,200,follow.text);assert.equal(calls.at(-1).body.input[0].encrypted_content,'synthetic-reasoning')
  let before=calls.length;const wrongKey=await request({input:[item]},'key2');assert(wrongKey.status>=400,wrongKey.text);assert.equal(calls.length,before)
  before=calls.length;const wrongOwner=await request({model:'up_foreign/synthetic-model',input:[item]},'foreign-key');assert(wrongOwner.status>=400,wrongOwner.text);assert.equal(calls.length,before)
  const required=await request({input:[{role:'user',content:'make-compaction'}]});assert.equal(required.status,200,required.text);const compact=required.json.output[0];assert(compact.encrypted_content.startsWith('vnext-affinity:'))
  before=calls.length;const pinned=await request({model:'up_b/synthetic-model',input:[compact]});assert(pinned.status>=400,pinned.text);assert.equal(calls.length,before)
  const continued=await request({previous_response_id:required.json.id,input:[{role:'user',content:'continue'}]});assert.equal(continued.status,200,continued.text);assert(calls.at(-1).body.input.some(i=>i.type==='compaction'&&i.encrypted_content==='synthetic-compaction'))
  const degraded=await request({model:'up_b/synthetic-model',input:[item,{role:'user',content:'keep visible'}]});assert.equal(degraded.status,200,degraded.text);assert(!calls.at(-1).body.input.some(i=>i.type==='reasoning'));assert(calls.at(-1).body.input.some(i=>i.role==='user'))
  const foreign=await request({input:[{type:'reasoning',id:'rs_foreign',summary:[],encrypted_content:'foreign-opaque'}]});assert.equal(foreign.status,200,foreign.text);assert.equal(calls.at(-1).body.input[0].encrypted_content,'foreign-opaque')
  const streamed=await request({stream:true});assert.equal(streamed.status,200,streamed.text)
  const events=streamed.text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)))
  const done=events.find(e=>e.type==='response.output_item.done')?.item,terminal=events.find(e=>e.type==='response.completed')?.response
  assert(done?.encrypted_content.startsWith('vnext-affinity:'));assert.equal(done.encrypted_content,terminal.output[0].encrypted_content,'SSE carrier changed between item and terminal')
  const streamedContinuation=await request({previous_response_id:terminal.id,input:[{role:'user',content:'immediate stream continuation'}]});assert.equal(streamedContinuation.status,200,streamedContinuation.text)
  assert(calls.at(-1).body.input.some(i=>i.encrypted_content==='synthetic-reasoning'),'Stored SSE carrier did not unwrap')
  const msg=await request({},'key','messages');assert.equal(msg.status,200,msg.text)
  const thought=msg.json.content.find(b=>b.type==='thinking');assert(thought?.signature.startsWith('vnext-affinity:'))
  const messages=[{role:'assistant',content:msg.json.content},{role:'user',content:'next'}]
  const msgFollow=await request({messages},'key','messages');assert.equal(msgFollow.status,200,msgFollow.text);assert.equal(calls.at(-1).body.messages[0].content[0].signature,'synthetic-signature')
  before=calls.length;const tampered=await request({messages:[{role:'assistant',content:[{...thought,thinking:'Changed thought'}]},{role:'user',content:'next'}]},'key','messages');assert(tampered.status>=400,tampered.text);assert.equal(calls.length,before)
  const msgDegraded=await request({model:'up_b/synthetic-model',messages},'key','messages');assert.equal(msgDegraded.status,200,msgDegraded.text);assert(!calls.at(-1).body.messages[0].content.some(b=>b.type==='thinking'));assert(calls.at(-1).body.messages[0].content.some(b=>b.type==='text'))
  const msgStream=await request({stream:true},'key','messages');assert.equal(msgStream.status,200,msgStream.text)
  const msgEvents=msgStream.text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)))
  let streamedThinking='',streamedSignature=''
  for(const ev of msgEvents){
   if(ev.type==='content_block_start'&&ev.content_block?.type==='thinking'){streamedThinking+=ev.content_block.thinking??'';streamedSignature+=ev.content_block.signature??''}
   if(ev.delta?.type==='thinking_delta')streamedThinking+=ev.delta.thinking??''
   if(ev.delta?.type==='signature_delta')streamedSignature+=ev.delta.signature??''
  }
  assert(streamedSignature.startsWith('vnext-affinity:'));assert.equal(streamedThinking,'  Synthetic thought \n')
  const msgStreamFollow=await request({messages:[{role:'assistant',content:[{type:'thinking',thinking:streamedThinking,signature:streamedSignature},{type:'text',text:'synthetic'}]},{role:'user',content:'next'}]},'key','messages');assert.equal(msgStreamFollow.status,200,msgStreamFollow.text);assert.equal(calls.at(-1).body.messages[0].content[0].signature,'synthetic-signature')
  for(const stream of [false,true]){
   const cross=await request({model:'up_messages/synthetic-model',stream});assert.equal(cross.status,200,cross.text)
   const output=stream?cross.text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6))).find(e=>e.type==='response.completed')?.response.output:cross.json.output
   const reason=output?.find(i=>i.type==='reasoning');assert(reason?.encrypted_content.startsWith('vnext-affinity:'),'Responses via Messages lost signed state')
   const replay=await request({model:'up_messages/synthetic-model',input:[reason,{role:'user',content:'next'}]});assert.equal(replay.status,200,replay.text)
   const sent=calls.at(-1).body.messages.flatMap(m=>Array.isArray(m.content)?m.content:[]).find(b=>b.type==='thinking');assert(sent);assert.equal(sent.signature,'synthetic-signature');assert.equal(sent.thinking,'  Synthetic thought \n')
  }
  const crossMsg=await request({model:'up_responses/synthetic-model'},'key','messages');assert.equal(crossMsg.status,200,crossMsg.text)
  const crossThought=crossMsg.json.content.find(b=>b.type==='thinking');assert(crossThought?.signature.startsWith('vnext-affinity:'),'Messages via Responses lost encrypted state')
  const crossMsgFollow=await request({model:'up_responses/synthetic-model',messages:[{role:'assistant',content:crossMsg.json.content},{role:'user',content:'next'}]},'key','messages');assert.equal(crossMsgFollow.status,200,crossMsgFollow.text)
  assert(calls.at(-1).body.input.some(i=>i.type==='reasoning'&&i.encrypted_content==='synthetic-reasoning'))
  const crossMsgStream=await request({model:'up_responses/synthetic-model',stream:true},'key','messages');assert.equal(crossMsgStream.status,200,crossMsgStream.text)
  const crossMsgEvents=crossMsgStream.text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)))
  let crossThinking='',crossSignature=''
  for(const ev of crossMsgEvents){
   if(ev.type==='content_block_start'&&ev.content_block?.type==='thinking'){crossThinking+=ev.content_block.thinking??'';crossSignature+=ev.content_block.signature??''}
   if(ev.delta?.type==='thinking_delta')crossThinking+=ev.delta.thinking??''
   if(ev.delta?.type==='signature_delta')crossSignature+=ev.delta.signature??''
  }
  assert.equal(crossThinking,'  Synthetic thought \n');assert(crossSignature.startsWith('vnext-affinity:'))
  const crossStreamReplay=await request({model:'up_responses/synthetic-model',messages:[{role:'assistant',content:[{type:'thinking',thinking:crossThinking,signature:crossSignature}]},{role:'user',content:'next'}]},'key','messages');assert.equal(crossStreamReplay.status,200,crossStreamReplay.text)
  assert(calls.at(-1).body.input.some(i=>i.type==='reasoning'&&i.encrypted_content==='synthetic-reasoning'))
  const agentResult=await request({input:[{role:'user',content:'make-agent'}]});assert.equal(agentResult.status,200,agentResult.text)
  const agentItem=agentResult.json.output.find(i=>i.type==='agent_message');assert(agentItem?.content[1].encrypted_content.startsWith('vnext-affinity:'))
  const agentReplay=await request({input:[agentItem,{role:'user',content:'next'}]});assert.equal(agentReplay.status,200,agentReplay.text);assert.equal(calls.at(-1).body.input[0].content[1].encrypted_content,'synthetic-agent-opaque')
  before=calls.length;const wrongAgent=await request({input:[{...agentItem,author:'different'}]});assert(wrongAgent.status>=400,wrongAgent.text);assert.equal(calls.length,before)
  assert(agentItem.content[2].encrypted_content.startsWith('vnext-affinity:'));before=calls.length;const swappedSlots=structuredClone(agentItem);swappedSlots.content[2].encrypted_content=swappedSlots.content[1].encrypted_content;const duplicatedSlot=await request({input:[swappedSlots]});assert(duplicatedSlot.status>=400,'Duplicated nested carrier was accepted');assert.equal(calls.length,before,'Nested carrier substitution reached inference')
  before=calls.length;const wrongDomain=await request({input:[{type:'compaction',id:'cmp_wrong_domain',encrypted_content:item.encrypted_content}]});assert(wrongDomain.status>=400,wrongDomain.text);assert.equal(calls.length,before)
  const otherRequired=await request({model:'up_b/synthetic-model',input:[{role:'user',content:'make-compaction'}]});assert.equal(otherRequired.status,200,otherRequired.text)
  before=calls.length;const mixed=await request({model:'synthetic-model',input:[compact,otherRequired.json.output[0]]});assert(mixed.status>=400,mixed.text);assert.equal(calls.length,before)
  const {default:OpenAI}=await import('/tmp/vnext-reference-sdk-probe/node_modules/openai/index.mjs')
  const {default:Anthropic}=await import('/tmp/vnext-reference-sdk-probe/node_modules/@anthropic-ai/sdk/index.mjs')
  const openai=new OpenAI({apiKey:'raw-key',baseURL:`http://127.0.0.1:${server.port}/v1`,maxRetries:0})
  const anthropic=new Anthropic({apiKey:'raw-key',baseURL:`http://127.0.0.1:${server.port}`,maxRetries:0})
  const sdkResponse=await openai.responses.stream({model:'up_a/synthetic-model',input:'synthetic SDK request'}).finalResponse()
  const sdkReason=sdkResponse.output.find(i=>i.type==='reasoning');assert(sdkReason?.encrypted_content.startsWith('vnext-affinity:'))
  await openai.responses.create({model:'up_a/synthetic-model',input:[sdkReason,{role:'user',content:'SDK continuation'}]});assert(calls.at(-1).body.input.some(i=>i.type==='reasoning'&&i.encrypted_content==='synthetic-reasoning'))
  const sdkMessage=await anthropic.messages.stream({model:'up_a/synthetic-model',max_tokens:128,messages:[{role:'user',content:'synthetic SDK request'}]}).finalMessage()
  const sdkThinking=sdkMessage.content.find(b=>b.type==='thinking');assert(sdkThinking?.signature.startsWith('vnext-affinity:'));assert.equal(sdkThinking.thinking,'  Synthetic thought \n')
  await anthropic.messages.create({model:'up_a/synthetic-model',max_tokens:128,messages:[{role:'assistant',content:sdkMessage.content},{role:'user',content:'SDK continuation'}]});assert(calls.at(-1).body.messages[0].content.some(b=>b.type==='thinking'&&b.signature==='synthetic-signature'))
  await getRepo().apiKeys.patchModelMappings('key',{modelMappingsEnabled:true,modelMappings:[{source:'client-alias',destination:'synthetic-model'}]})
  const mapped=await request({model:'up_a/client-alias',input:[compact,{role:'user',content:'mapped continuation'}]});assert.equal(mapped.status,200,mapped.text);assert.equal(calls.at(-1).body.model,'synthetic-model');assert(calls.at(-1).body.input.some(i=>i.type==='compaction'&&i.encrypted_content==='synthetic-compaction'))
  before=calls.length;const mappedPin=await request({model:'up_b/client-alias',input:[compact]});assert(mappedPin.status>=400,mappedPin.text);assert.equal(calls.length,before)
  await getRepo().apiKeys.patchModelMappings('key',{modelMappingsEnabled:false})
  await db.prepare("UPDATE upstreams SET enabled=0 WHERE id='up_a'").run()
  before=calls.length;const disabled=await request({input:[compact]});assert(disabled.status>=400,disabled.text);assert.equal(calls.length,before)
  const disabledRow=await getRepo().upstreams.getById('up_a');assert(disabledRow);await getRepo().upstreams.save({...disabledRow,enabled:true})
  await db.prepare("UPDATE upstreams SET config_json=json_set(config_json,'$.configuration_change',1) WHERE id='up_a'").run()
  before=calls.length;const replaced=await request({input:[compact]});assert(replaced.status>=400,replaced.text);assert.equal(calls.length,before)
  console.log(JSON.stringify({passed:true,runtime:'actual authenticated Bun app + loopback CustomProvider + real SQLite',cases:['native-json','same-target','wrong-key-zero-egress','wrong-owner-zero-egress','pin-conflict-zero-egress','immediate-durable-continuation','optional-degradation','foreign-pass-through','sse-canonical-carrier','sse-immediate-continuation','messages-whole-thinking','messages-tamper-zero-egress','messages-optional-degradation','messages-sse-roundtrip','responses-via-messages-json-sse','messages-via-responses-json-sse','nested-agent-message','nested-slot-substitution-zero-egress','wrong-companion-zero-egress','wrong-domain-zero-egress','mixed-required-zero-egress','configuration-replacement-zero-egress','key-mapping-same-target','key-mapping-pin-zero-egress','disabled-target-zero-egress','official-openai-6.33-stream-replay','official-anthropic-0.80-stream-replay'],calls:calls.length,scratch}))
 }
 await Promise.all(pending)
}finally{server.stop(true);upstream.stop(true)}
