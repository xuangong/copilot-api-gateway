import { serve } from 'bun'
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const source=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
const {initBackground,initSocketDial}=await import(`${source}/packages/platform/src/index.ts`)
const {CopilotProvider}=await import(`${source}/packages/provider-copilot/src/provider.ts`)
const {responsesAttempt,synthesizeResponsesFramesFromJson}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`)
const {messagesAttempt}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts`)
const {respondResponses}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/respond.ts`)
const {respondMessages}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/messages/respond.ts`)
const {getTranslator}=await import(`${source}/packages/gateway/src/data-plane/dispatch/translator-registry.ts`)
const {PerformanceRecorder}=await import(`${source}/packages/gateway/src/data-plane/observability/performance-recorder.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c05-fast-runtime-`),{db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
await db.prepare('INSERT INTO api_keys(id,name,key,created_at) VALUES(?,?,?,?)').bind('synthetic-key','synthetic','synthetic-key',new Date().toISOString()).run()
const base='claude-opus-4.8',fast=`${base}-fast`,missing='claude-sonnet-4.6'
const model=(id)=>({id,name:`Synthetic ${id}`,object:'model',vendor:'Anthropic',version:id,preview:false,model_picker_enabled:true,supported_endpoints:['/responses','/v1/messages'],capabilities:{family:'claude',limits:{max_context_window_tokens:200000,max_output_tokens:8192},object:'model_capabilities',supports:{streaming:true,...(id.endsWith('-high')?{reasoning_effort:['high']}:{})},tokenizer:'o200k',type:'chat'}})
const catalog={object:'list',data:[model(base),model(fast),model(missing),model(`${base}-1m-internal`),model(`${base}-high`)]},seen=[],refreshes=[]
const upstream=serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
 const path=new URL(request.url).pathname
 if(path==='/models')return Response.json(catalog)
 const body=await request.json(),label=request.headers.get('x-fixture-case')??'unspecified';seen.push({label,path,body})
 if(label==='responses-retry'&&seen.filter(x=>x.label===label).length===1)return Response.json({error:{message:'synthetic stale credential'}},{status:401})
 if(path==='/responses'){
  const result={id:`resp_${label}`,object:'response',status:'completed',model:body.model===fast?base:body.model,service_tier:'default',output:[{id:`item_${label}`,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:'synthetic text'}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}
  if(!body.stream)return Response.json(result)
  let text='';for await(const frame of synthesizeResponsesFramesFromJson(result))if(frame.type==='event')text+=`event: ${frame.event.type}\ndata: ${JSON.stringify(frame.event)}\n\n`
  return new Response(text,{headers:{'content-type':'text/event-stream'}})
 }
 if(path==='/v1/messages/count_tokens')return Response.json({input_tokens:6})
 if(path==='/v1/messages'){
  const message={id:`msg_${label}`,type:'message',role:'assistant',model:body.model===fast?base:body.model,content:[{type:'text',text:'synthetic text'}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:5,output_tokens:3,speed:'standard'}}
  if(!body.stream)return Response.json(message)
  const events=[{type:'message_start',message:{...message,content:[],stop_reason:null,usage:{input_tokens:5,output_tokens:0,speed:'standard'}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'synthetic text'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3,speed:'standard'}},{type:'message_stop'}]
  return new Response(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})
 }
 throw new Error(`Unexpected synthetic upstream path ${path}`)
}})
const origin=`http://127.0.0.1:${upstream.port}`
const provider=new CopilotProvider({copilotToken:'synthetic-c05-token',accountType:'individual',baseUrl:origin,refreshSession:async()=>{refreshes.push(true);return{token:'synthetic-c05-refreshed',baseUrl:origin}}},async(url,init)=>{assert(url.startsWith(origin+'/'));return fetch(url,init)})
provider.setModelCatalog(catalog)
const cases=[
 {label:'responses-fast-json',protocol:'responses',stream:false,model:base,fast:true},
 {label:'responses-fast-stream',protocol:'responses',stream:true,model:base,fast:true},
 {label:'messages-fast-json',protocol:'messages',stream:false,model:base,fast:true},
 {label:'messages-fast-stream',protocol:'messages',stream:true,model:base,fast:true},
 {label:'responses-base',protocol:'responses',stream:false,model:base,fast:false},
 {label:'responses-pin',protocol:'responses',stream:false,model:fast,fast:false,expectedFast:true},
 {label:'responses-fallback',protocol:'responses',stream:false,model:missing,fast:true,expectedFast:false},
 {label:'messages-missing',protocol:'messages',stream:false,model:missing,fast:true,error:true},
 {label:'messages-via-responses-fast',protocol:'messages',hub:'responses',stream:false,model:base,fast:true},
 {label:'messages-via-responses-stream',protocol:'messages',hub:'responses',stream:true,model:base,fast:true},
 {label:'messages-via-responses-missing',protocol:'messages',hub:'responses',stream:false,model:missing,fast:true,error:true},
 {label:'responses-via-messages-fast',protocol:'responses',hub:'messages',stream:false,model:base,fast:true},
 {label:'responses-via-messages-stream',protocol:'responses',hub:'messages',stream:true,model:base,fast:true},
 {label:'responses-via-messages-fallback',protocol:'responses',hub:'messages',stream:false,model:missing,fast:true,expectedFast:false},
 {label:'responses-retry',protocol:'responses',stream:false,model:base,fast:true},
]
const gateway=serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
 const label=new URL(request.url).searchParams.get('label'),c=cases.find(x=>x.label===label);assert(c)
 const telemetryCtx={apiKeyId:'synthetic-key',incomingModel:`alias-${label}`,userAgent:'synthetic',requestId:label,isStreaming:c.stream,runtimeLocation:'bun',requestStartedAt:Date.now(),sourceApi:c.protocol,metrics:new PerformanceRecorder(c.stream)}
 const payload=c.protocol==='messages'?{model:c.model,messages:[{role:'user',content:'synthetic'}],max_tokens:20,stream:c.stream,...(c.fast?{speed:'fast'}:{})}:{model:c.model,input:[],stream:c.stream,service_tier:c.fast?'priority':'default'}
 const attempt=c.protocol==='messages'?messagesAttempt:responsesAttempt,respond=c.protocol==='messages'?respondMessages:respondResponses
 const result=await attempt.generate({payload,auth:{ownerId:'synthetic-owner',copilot:false},ctx:{requestStartedAt:Date.now()},telemetryCtx,inheritedHeaders:{'x-fixture-case':label},selectBinding:async()=>({kind:'ok',binding:{upstream:'synthetic-copilot',model:{id:c.model,providerModelKey:c.model},provider},bareModel:c.model,targetEndpoint:c.hub??c.protocol,translator:getTranslator(c.protocol,c.hub??c.protocol)})})
 return respond(result,{wantsStream:c.stream,telemetryCtx})
}})
try{
 const results=[]
 for(const c of cases){
  const response=await fetch(`http://127.0.0.1:${gateway.port}/?label=${c.label}`),text=await response.text(),calls=seen.filter(x=>x.label===c.label)
  if(c.error){assert.equal(response.status,400,text);assert(text.includes('invalid_request_error'));assert.equal(calls.length,0);results.push({label:c.label,status:400,dispatches:0});continue}
  assert.equal(response.status,200,text);const expectedFast=c.expectedFast??c.fast,expectedModel=expectedFast?fast:c.model
  assert(calls.length>0);for(const call of calls){assert.equal(call.body.model,expectedModel,c.label);assert.equal(call.body.service_tier,undefined,c.label);assert.equal(call.body.speed,undefined,c.label)}
  const tier=c.protocol==='messages'?(expectedFast?'fast':'standard'):(expectedFast?'priority':'default'),field=c.protocol==='messages'?'speed':'service_tier'
  assert(text.includes(`"${field}":"${tier}"`),`${c.label} missing actual tier ${tier}: ${text}`)
  if(c.label==='responses-retry'){assert.equal(calls.length,2);assert.deepEqual(calls[0].body,calls[1].body)}
  results.push({label:c.label,status:200,dispatches:calls.length,model:expectedModel,tier})
 }
 for (const [label, headers, payload, expectedModel] of [
  ['count-tokens-context', {'anthropic-beta':'context-1m-2025-08-07'}, {model:base,messages:[],speed:'fast'}, `${base}-1m-internal`],
  ['count-tokens-effort', {}, {model:base,messages:[],speed:'fast',output_config:{effort:'high'}}, `${base}-high`],
 ]) {
  const result=await provider.fetch({endpoint:'messages_count_tokens',sourceApi:'anthropic',sourceProtocol:'messages',payload,headers:new Headers({...headers,'x-fixture-case':label})})
  assert.equal(result.status,200);assert.equal(result.execution,undefined,label)
  assert.equal((await new Response(result.body).json()).input_tokens,6)
  const calls=seen.filter(x=>x.label===label);assert.equal(calls.length,1);assert.equal(calls[0].body.model,expectedModel,label)
  results.push({label,status:200,dispatches:1,model:expectedModel,tier:'none'})
 }
 await Promise.all(pending)
 const rows=(await db.prepare('SELECT incoming_model,model,model_key,dimension,tokens,unit_price FROM usage ORDER BY incoming_model,dimension').all()).results
 for(const c of cases.filter(c=>!c.error)){
  const expectedFast=c.expectedFast??c.fast,raw=expectedFast?fast:c.model,selected=rows.filter(r=>r.incoming_model===`alias-${c.label}`),pricing=provider.getPricingForModelKey(raw)
  assert(selected.length>0);for(const row of selected){assert.equal(row.model,c.model);assert.equal(row.model_key,raw,c.label);assert.equal(row.unit_price,pricing?.[row.dimension]??null,c.label)}
 }
 assert.equal(refreshes.length,1)
 console.log(JSON.stringify({passed:true,runtime:'Actual Bun loopback gateway + CopilotProvider + loopback synthetic upstream + temporary SQLite',results,refreshes:refreshes.length,rows,scratch}))
}finally{gateway.stop(true);upstream.stop(true)}
