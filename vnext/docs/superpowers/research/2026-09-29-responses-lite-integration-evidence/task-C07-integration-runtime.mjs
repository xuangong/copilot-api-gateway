import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { serve } from 'bun'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const source=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
const {initBackground,initSocketDial}=await import(`${source}/packages/platform/src/index.ts`)
const {getRepo}=await import(`${source}/packages/gateway/src/repo/index.ts`)
const {getResponsesStore}=await import(`${source}/packages/gateway/src/data-plane/runtime/responses-store.ts`)
const {savePostTurnSnapshot,expandPreviousResponseId}=await import(`${source}/packages/gateway/src/data-plane/dispatch/responses-store-bridge.ts`)
const {CodexProvider}=await import(`${source}/packages/provider-codex/src/provider.ts`)
const {responsesAttempt,synthesizeResponsesFramesFromJson}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`)
const {respondResponses}=await import(`${source}/packages/gateway/src/data-plane/chat-flow/responses/respond.ts`)
const {getTranslator}=await import(`${source}/packages/gateway/src/data-plane/dispatch/translator-registry.ts`)
const {PerformanceRecorder}=await import(`${source}/packages/gateway/src/data-plane/observability/performance-recorder.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c07-integration-runtime-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const pending=[];initBackground({waitUntil:promise=>{pending.push(promise)}})
const now=new Date().toISOString(),key='synthetic-key',accountId='synthetic-account',upstreamId='synthetic-codex'
await db.prepare('INSERT INTO api_keys(id,name,key,created_at) VALUES(?,?,?,?)').bind(key,'synthetic',key,now).run()
const record={id:upstreamId,provider:'codex',name:'synthetic',enabled:true,sortOrder:0,config:{accounts:[{email:'synthetic@example.invalid',chatgptAccountId:accountId,chatgptUserId:'synthetic-user',planType:'plus'}]},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[],state:{accounts:[{chatgptAccountId:accountId,refresh_token:'synthetic-refresh',credentialRevision:'synthetic-revision',state:'active',state_updated_at:now,openaiDeviceId:'synthetic-device',accessToken:{token:'synthetic-access',expiresAt:Date.now()+3600000,refreshedAt:now},quotaSnapshot:null}]},createdAt:now,updatedAt:now}
await getRepo().upstreams.save(record)
const calls=[],snapshots=[],counts=new Map(),marker='x-openai-internal-codex-responses-lite',mirror='ws_request_header_x_openai_internal_codex_responses_lite'
const cases=new Map(),upstreamCanceled=[]
const upstream=serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const path=new URL(req.url).pathname
 if(path.endsWith('/models'))return Response.json({models:[{slug:'gpt-5',display_name:'Standard',context_window:128000,use_responses_lite:false},{slug:'gpt-5-codex',display_name:'Lite',context_window:128000,use_responses_lite:true}]})
 if(path.endsWith('/token')){calls.push({oauth:true});return Response.json({access_token:'synthetic-refreshed',id_token:'synthetic-id',refresh_token:'synthetic-refresh-next',expires_in:3600,token_type:'Bearer'})}
 const text=await req.text(),body=JSON.parse(text),label=body.client_metadata?.probe??req.headers.get('x-client-request-id'),spec=cases.get(label);assert(spec,`Unknown synthetic label ${label}`)
 const count=(counts.get(label)??0)+1;counts.set(label,count)
 calls.push({label,path,text,body,headers:Object.fromEntries(req.headers)})
 if(spec.retry&&count===1)return Response.json({error:{code:'invalid_token',message:'synthetic'}},{status:401})
 const lite=body.model==='gpt-5-codex',kind=spec.kind??'function',name='operate',wireKind=lite?(kind==='function'?'custom_tool_call':'function_call'):(kind==='function'?'function_call':'custom_tool_call')
 const item={type:wireKind,id:'shared-item',call_id:'shared-call',name,status:'completed',...(lite?{namespace:'functions'}:{}),...(wireKind==='function_call'?{arguments:'{}'}:{input:'{}'})}
 const compact=path.endsWith('/compact')
 const result={id:`resp_${label}`,object:compact?'response.compaction':'response',model:body.model,output:compact?[...body.input,{type:'compaction',id:'cmp-synthetic',encrypted_content:'synthetic-opaque'}]:[item],...(!compact?{status:'completed',incomplete_details:null,error:null,tools:body.tools,instructions:body.instructions,parallel_tool_calls:body.parallel_tool_calls,reasoning:body.reasoning}:{}),usage:{input_tokens:5,output_tokens:3,total_tokens:8}}
 if(compact||!spec.upstreamSse)return Response.json(result)
 let sse=''
 for await(const frame of synthesizeResponsesFramesFromJson(result)){if(frame.type!=='event')continue;const e=frame.event;if((spec.eof||spec.error||spec.cancel)&&e.type==='response.completed')continue;sse+=`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`}
 if(spec.error)sse+='event: error\ndata: {"type":"error","code":"synthetic_failure","message":"synthetic"}\n\n'
 if(spec.cancel)req.signal.addEventListener('abort',()=>upstreamCanceled.push(label),{once:true})
 if(spec.cancel)return new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode(sse))},cancel(){upstreamCanceled.push(label)}}),{headers:{'content-type':'text/event-stream'}})
 return new Response(sse,{headers:{'content-type':'text/event-stream'}})
}})
const fetcher=async(input,init)=>{
 const original=input instanceof Request?input:new Request(input,init),url=new URL(original.url)
 assert(['chatgpt.com','auth.openai.com'].includes(url.hostname),`Blocked host ${url.hostname}`)
 return fetch(`http://127.0.0.1:${upstream.port}${url.pathname}${url.search}`,{method:original.method,headers:original.headers,body:original.method==='GET'?undefined:await original.text(),signal:original.signal})
}
const stored=await getRepo().upstreams.getById(upstreamId);assert(stored)
const provider=new CodexProvider(stored,fetcher);await provider.getModels()
const store=getResponsesStore()
const server=serve({hostname:'127.0.0.1',port:0,fetch:async req=>{
 const label=new URL(req.url).searchParams.get('label'),spec=cases.get(label);assert(spec)
 const payload=await req.json();await expandPreviousResponseId(payload,store,key)
 const mergedInput=structuredClone(payload.input),controller=new AbortController()
 req.signal.addEventListener('abort',()=>controller.abort(),{once:true})
 const telemetryCtx={apiKeyId:key,incomingModel:payload.model,userAgent:'synthetic',requestId:label,isStreaming:spec.clientSse??false,runtimeLocation:'bun',requestStartedAt:Date.now(),sourceApi:'responses',metrics:new PerformanceRecorder(spec.clientSse??false)}
 const binding={upstream:upstreamId,model:{id:payload.model,providerModelKey:payload.model},provider}
 const result=await responsesAttempt.generate({payload,action:spec.compact?'compact':'generate',auth:{ownerId:'synthetic-owner',copilot:false},ctx:{requestStartedAt:Date.now(),downstreamAbortSignal:controller.signal},telemetryCtx,interceptors:[],inheritedHeaders:{[marker]:'true','x-client-request-id':label,'thread-id':`thread-${label}`},selectBinding:async()=>({kind:'ok',binding,bareModel:payload.model,targetEndpoint:'responses',translator:getTranslator('responses','responses')})})
 return respondResponses(result,{wantsStream:spec.clientSse??false,telemetryCtx,downstreamAbortController:controller,mergedInputItems:mergedInput,onCompleted:async(response,inputItems)=>{
  snapshots.push(label)
  try { await savePostTurnSnapshot(store,{retentionSeconds:86400,responseId:response.id,apiKeyId:key,model:payload.model,inputItems:[...inputItems],outputItems:response.output,compactTriggered:spec.compact??false}) } catch(error) { console.error('synthetic snapshot callback failure',error); throw error }
 }})
}})
const request=async(label,spec,extra={})=>{
 cases.set(label,spec)
 const input=[{type:'message',role:'user',content:'synthetic request'}]
 const body={model:spec.standard?'gpt-5':'gpt-5-codex',input,instructions:'Synthetic base',tools:[{type:spec.kind==='custom'?'custom':'function',name:'operate',description:'synthetic',...(spec.kind==='custom'?{}:{parameters:{type:'object'}})}],stream:spec.clientSse??false,client_metadata:{probe:label,[mirror]:'true'},...extra}
 const clientAbort=new AbortController()
 const response=await fetch(`http://127.0.0.1:${server.port}/?label=${label}`,{signal:clientAbort.signal,method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
 if(spec.cancel){const reader=response.body.getReader();const first=await reader.read();assert(!first.done);clientAbort.abort();await reader.cancel().catch(()=>{});return{label,spec,body,response,text:''}}
 const text=await response.text();return{label,spec,body,response,text}
}
try{
 const success=[]
 for(const[label,spec]of[['lite-json',{}],['lite-sse',{upstreamSse:true,clientSse:true}],['lite-retry',{retry:true}],['standard-marker',{standard:true}],['compact',{compact:true}],['compact-retry',{compact:true,retry:true}]])success.push(await request(label,spec))
 success.push(...await Promise.all([request('concurrent-function',{upstreamSse:true,clientSse:true}),request('concurrent-custom',{upstreamSse:true,clientSse:true,kind:'custom'})]))
 for(const result of success){
  assert.equal(result.response.status,200,result.text)
  if(!result.spec.clientSse&&!result.spec.compact){const json=JSON.parse(result.text);assert.deepEqual(json.tools,result.body.tools,`Lost tools echo ${result.label}`);assert.equal(json.instructions,result.body.instructions,`Lost instructions echo ${result.label}`)}
  const captured=calls.filter(c=>c.label===result.label);assert.equal(captured.length,result.spec.retry?2:1)
  for(const c of captured){assert.equal(c.headers[marker],result.spec.standard?undefined:'true');assert.equal(c.body.client_metadata?.[mirror],undefined);if(!result.spec.standard){assert.equal(c.body.tools,undefined);assert.equal(c.body.instructions,undefined);assert.equal(c.body.input[0].type,'additional_tools')}}
  if(result.spec.retry){assert.equal(captured[0].text,captured[1].text);for(const h of ['session_id','thread_id','x-client-request-id','x-codex-turn-metadata'])assert.equal(captured[0].headers[h],captured[1].headers[h])}
  const snapshot=await store.load(`resp_${result.label}`,key);assert(snapshot,`No snapshot ${result.label}`)
  assert(!snapshot.items.some(i=>i.type==='additional_tools'&&String(i.id).startsWith('at_')),`Generated prefix persisted ${result.label}`)
  if(!result.spec.compact){const item=snapshot.items.find(i=>i.call_id==='shared-call');assert(item);assert.equal(item.type,result.spec.kind==='custom'?'custom_tool_call':'function_call');assert.equal(item.namespace,undefined)}
 }
 const continuation=await request('continuation-standard',{standard:true},{previous_response_id:'resp_lite-json',input:[{type:'function_call_output',call_id:'shared-call',output:'synthetic result'}]})
 assert.equal(continuation.response.status,200,continuation.text)
 const sent=calls.find(c=>c.label==='continuation-standard').body;assert.equal(sent.previous_response_id,undefined);assert(sent.input.some(i=>i.type==='function_call'&&i.call_id==='shared-call'));assert(!sent.input.some(i=>i.type==='additional_tools'))
 const failureResults=[]
 for(const[label,spec]of[['premature-eof',{eof:true,upstreamSse:true,clientSse:true}],['upstream-error',{error:true,upstreamSse:true,clientSse:true}],['cancel',{cancel:true,upstreamSse:true,clientSse:true}]]){const result=await request(label,spec);failureResults.push(label);assert.equal(await store.load(`resp_${label}`,key),null,`Unexpected success snapshot ${label}`);if(!spec.cancel)assert(!result.text.includes('event: response.completed'),`False terminal ${label}`)}
 for(let i=0;i<50&&!upstreamCanceled.includes('cancel');i++)await new Promise(resolve=>setTimeout(resolve,20))
 assert(upstreamCanceled.includes('cancel'),'Downstream cancellation did not close upstream body')
 await Promise.all(pending)
 console.log(JSON.stringify({passed:true,runtime:'actual Bun gateway attempts/responders + real CodexProvider + independent loopback upstream + temporary SQLite snapshots',cases:[...success.map(r=>r.label),'continuation-standard',...failureResults],upstreamCanceled,snapshotCount:snapshots.length,outbound:calls.filter(c=>!c.oauth).length,oauth:calls.filter(c=>c.oauth).length,scratch,liveProvider:false}))
}finally{server.stop(true);upstream.stop(true)}
