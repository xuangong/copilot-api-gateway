import { serve } from 'bun'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const source=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
const {initBackground,initSocketDial}=await import(`${source}/packages/platform/src/index.ts`)
const {responsesAttempt}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`)
const {chatCompletionsAttempt}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts`)
const {respondResponses}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/respond.ts`)
const {respondChatCompletions}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/chat-completions/respond.ts`)
const {getTranslator}=await import(`${source}/packages/gateway/src/data-plane/dispatch/translator-registry.ts`)
const {PerformanceRecorder}=await import(`${source}/packages/gateway/src/data-plane/observability/performance-recorder.ts`)
const {synthesizeResponsesFramesFromJson}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`)
const scratch=await mkdtemp(`${tmpdir()}/provider-call-context-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const pending=[];initBackground({waitUntil:promise=>{pending.push(promise)}})
const now=new Date().toISOString()
await db.prepare('INSERT INTO api_keys(id,name,key,created_at) VALUES(?,?,?,?)').bind('synthetic-key','synthetic','synthetic-key',now).run()
const counters={frame:0,result:0,provider:0};const snapshots=[]
const normalize=(value,label)=>JSON.parse(JSON.stringify(value).replaceAll(`wire-${label}`,`canonical-${label}`))
const makeResponse=async(label,sse,metadata)=>{
 const value={id:`wire-${label}`,object:'response',status:'completed',model:'synthetic-base',output:[{id:`wire-${label}-item`,type:'message',status:'completed',role:'assistant',content:[{type:'output_text',text:`wire-${label}`}]}],usage:{input_tokens:5,output_tokens:3,total_tokens:8}}
 let body=JSON.stringify(value)
 if(sse){body='';for await(const frame of synthesizeResponsesFramesFromJson(value))if(frame.type==='event')body+=`event: ${frame.event.type}\ndata: ${JSON.stringify(frame.event)}\n\n`}
 return {status:200,headers:new Headers({'content-type':sse?'text/event-stream':'application/json'}),body:new Response(body).body,
 ...(metadata?{execution:{modelKey:'synthetic-base-fast',serviceTier:'priority'},responsesAdapter:{
 result:json=>{counters.result++;return normalize(json,label)},
 frame:frame=>{counters.frame++;return normalize(frame,label)},
 }}:{})}
}
const server=serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
 const url=new URL(request.url),label=url.searchParams.get('label'),sse=url.searchParams.get('sse')==='1',metadata=url.searchParams.get('metadata')!=='0',chat=url.searchParams.get('chat')==='1'
 const telemetryCtx={apiKeyId:'synthetic-key',incomingModel:`alias-${label}`,userAgent:'synthetic',requestId:label,isStreaming:sse,runtimeLocation:'bun',requestStartedAt:Date.now(),sourceApi:chat?'chat-completions':'responses',metrics:new PerformanceRecorder(sse)}
 const binding={upstream:'synthetic-upstream',model:{id:'synthetic-public',providerModelKey:'synthetic-base'},provider:{fetch:async()=>{counters.provider++;return makeResponse(label,sse,metadata)},getPricingForModelKey:key=>({input:key.endsWith('-fast')?20:2,output:key.endsWith('-fast')?40:4})}}
 const protocol=chat?'chat_completions':'responses',attempt=chat?chatCompletionsAttempt:responsesAttempt
 const result=await attempt.generate({payload:chat?{model:'synthetic-public',messages:[{role:'user',content:'synthetic'}],stream:sse}:{model:'synthetic-public',input:[],stream:sse},auth:{ownerId:'synthetic-owner',copilot:false},ctx:{requestStartedAt:Date.now()},telemetryCtx,interceptors:[],selectBinding:async()=>({kind:'ok',binding,bareModel:'synthetic-public',targetEndpoint:'responses',translator:getTranslator(protocol,'responses')})})
 const options={wantsStream:sse,telemetryCtx,...(!chat?{onCompleted:async snapshot=>{snapshots.push({label,snapshot})}}:{})}
 return chat?respondChatCompletions(result,options):respondResponses(result,options)
}})
try{
 const cases=[['unary',false,false,true],['stream',true,false,true],['chat-unary',false,true,true],['chat-stream',true,true,true],['fallback',false,false,false]]
 const results=await Promise.all(cases.map(async([label,sse,chat,metadata])=>{
  const response=await fetch(`http://127.0.0.1:${server.port}/?label=${label}&sse=${+sse}&chat=${+chat}&metadata=${+metadata}`),text=await response.text();assert.equal(response.status,200,text)
  if(metadata){assert(text.includes(`canonical-${label}`),`Missing adapter output ${label}`);assert(!text.includes(`wire-${label}`),`Leaked wire output ${label}`)}else assert(text.includes(`wire-${label}`))
  for(const[other]of cases)if(other!==label)assert(!text.includes(`canonical-${other}"`),`Foreign call output ${label}/${other}`)
  return{label,sse,chat,metadata,status:response.status}
 }))
 await Promise.all(pending)
 const rows=(await db.prepare('SELECT incoming_model,model,model_key,dimension,tokens,unit_price FROM usage ORDER BY incoming_model,dimension').all()).results
 for(const[label,,,metadata]of cases){const selected=rows.filter(row=>row.incoming_model===`alias-${label}`);assert(selected.length>0,`No usage ${label}`);for(const row of selected){assert.equal(row.model,'synthetic-public');assert.equal(row.model_key,metadata?'synthetic-base-fast':'synthetic-base');assert(row.unit_price===(row.dimension.includes('output')?(metadata?40:4):(metadata?20:2)),JSON.stringify(row))}}
 for(const{label,snapshot}of snapshots){if(label!=='fallback'){assert(JSON.stringify(snapshot).includes(`canonical-${label}`));assert(!JSON.stringify(snapshot).includes(`wire-${label}`))}}
 assert(counters.frame>0&&counters.result>0)
 console.log(JSON.stringify({passed:true,runtime:'Bun actual loopback HTTP + gateway attempts/responders + temporary SQLite, synthetic provider',results,counters,snapshots:snapshots.map(x=>x.label),rows,scratch}))
}finally{server.stop(true)}
