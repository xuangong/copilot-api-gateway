import assert from 'node:assert/strict'
import {serve} from 'bun'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const source=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${source}/apps/platform-bun/src/bootstrap.ts`)
const {initBackground,initSocketDial}=await import(`${source}/packages/platform/src/index.ts`)
const {getRepo}=await import(`${source}/packages/gateway/src/repo/index.ts`)
const {configurationAffinityAuthority}=await import(`${source}/packages/gateway/src/data-plane/providers/affinity-authority.ts`)
const {CopilotProvider}=await import(`${source}/packages/provider-copilot/src/provider.ts`)
const {AzureProvider}=await import(`${source}/packages/provider-azure/src/provider.ts`)
const {affinityTargetMatch}=await import(`${source}/packages/provider-llm/src/opaque-affinity.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c01-provider-runtime-`)
const {db}=bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
initSocketDial(async()=>{throw new Error('External socket blocked')})
const pending=[];initBackground({waitUntil:p=>pending.push(p)})
const calls=[],sessions=[],refreshes=[],passed=[];let rejection
const upstream=serve({hostname:'127.0.0.1',port:0,fetch:async request=>{
 const path=new URL(request.url).pathname,body=await request.json();calls.push({path,body})
 if(rejection){const callback=rejection;rejection=undefined;await callback();return Response.json({error:{message:'Synthetic expired credential'}},{status:401})}
 return Response.json({id:'synthetic',object:'response',status:'completed',output:[],model:body.model,usage:{input_tokens:1,output_tokens:1,total_tokens:2}})
}})
const origin=`http://127.0.0.1:${upstream.port}`
const fetcher=async(input,init)=>{
 const request=input instanceof Request?input:new Request(input,init),url=new URL(request.url)
 assert(url.origin===origin||url.hostname==='synthetic.openai.azure.com','Unexpected external host')
 return fetch(`${origin}${url.pathname}${url.search}`,{method:request.method,headers:request.headers,body:request.method==='GET'?undefined:await request.text(),signal:request.signal})
}
const base='claude-opus-4.8',fast=`${base}-fast`
const model=id=>({id,name:id,object:'model',vendor:'Anthropic',version:id,preview:false,model_picker_enabled:true,supported_endpoints:['/responses','/v1/messages'],capabilities:{family:'claude',limits:{max_context_window_tokens:200000,max_output_tokens:8192},object:'model_capabilities',supports:{streaming:true,...(id.endsWith('-high')?{reasoning_effort:['high']}:{})},tokenizer:'o200k',type:'chat'}})
const catalog={object:'list',data:[model(base),model(fast),model(`${base}-1m-internal`),model(`${base}-high`)]}
let serial=0
async function fixture(kind){
 const id=`synthetic-${kind}-${++serial}`,now=new Date().toISOString()
 await getRepo().upstreams.save({id,ownerId:'owner',provider:kind,name:id,enabled:true,sortOrder:0,config:{name:id},state:{},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[],createdAt:now,updatedAt:now})
 const row=await getRepo().upstreams.getById(id);assert(row)
 const authority=configurationAffinityAuthority(row,getRepo().upstreams)
 const provider=kind==='copilot'?new CopilotProvider({copilotToken:'synthetic-token',accountType:'individual',baseUrl:origin,prepareSession:async()=>{sessions.push(id);return{token:'synthetic-token',baseUrl:origin}},refreshSession:async()=>{refreshes.push(id);return{token:'synthetic-new-token',baseUrl:origin}}},fetcher,undefined,authority):new AzureProvider({name:id,endpoint:'https://synthetic.openai.azure.com',apiKey:'synthetic-api-key',deployment:'default-deployment',apiVersion:'2025-01-01',endpoints:['responses','messages'],deployments:[{name:'exact-deployment',model:'public-model'}]},fetcher,undefined,authority)
 if(kind==='copilot')provider.setModelCatalog(catalog)
 return{id,provider}
}
const fence=target=>async actual=>assert.equal(affinityTargetMatch(target,actual),'exact','Execution target changed')
async function replace(id){await db.prepare("UPDATE upstreams SET config_json=json_set(config_json,'$.changed',1) WHERE id=?").bind(id).run()}
try{
 for(const c of [
  {label:'copilot-fast',kind:'copilot',payload:{model:base,input:[],service_tier:'priority'},headers:{},expected:fast},
  {label:'copilot-context-header',kind:'copilot',payload:{model:base,messages:[],max_tokens:20},endpoint:'messages',headers:{'anthropic-beta':'context-1m-2025-08-07'},expected:`${base}-1m-internal`},
  {label:'copilot-effort-header',kind:'copilot',payload:{model:base,input:[]},headers:{'x-copilot-reasoning-effort':'high'},expected:`${base}-high`},
  {label:'azure-deployment',kind:'azure',payload:{model:'public-model',input:[]},headers:{},expected:'exact-deployment'},
 ]){
  const {id,provider}=await fixture(c.kind),request={endpoint:c.endpoint??'responses',sourceApi:c.endpoint==='messages'?'anthropic':'openai',sourceProtocol:c.endpoint??'responses',payload:c.payload,headers:new Headers(c.headers)}
  const initial=[calls.length,sessions.length,refreshes.length],target=await provider.prepareAffinityExecution(request)
  assert(target,c.label);assert.equal(target.model,c.expected,c.label);assert.deepEqual([calls.length,sessions.length,refreshes.length],initial,'Preparation performed network/session work')
  const response=await provider.fetch({...request,payload:structuredClone(c.payload),beforeInference:fence(target)});await new Response(response.body).text()
  assert.equal(response.status,200);assert.deepEqual(response.affinityExecution,target)
  if(c.kind==='azure')assert(calls.at(-1).path.includes('/deployments/exact-deployment/'));else assert.equal(calls.at(-1).body.model,c.expected)
  await replace(id)
  const before=[calls.length,sessions.length,refreshes.length]
  await assert.rejects(()=>provider.fetch({...request,payload:structuredClone(c.payload),beforeInference:fence(target)}))
  assert.deepEqual([calls.length,sessions.length,refreshes.length],before,'Replacement escaped fence')
  passed.push(`${c.label}-exact-and-replacement-zero-io`)
 }
 {
  const {id,provider}=await fixture('copilot'),request={endpoint:'responses',sourceProtocol:'responses',sourceApi:'openai',payload:{model:base,input:[],service_tier:'priority'},headers:new Headers()},target=await provider.prepareAffinityExecution(request);assert(target)
  rejection=()=>replace(id);const count=calls.length,refresh=refreshes.length
  await assert.rejects(()=>provider.fetch({...request,beforeInference:fence(target)}));assert.equal(calls.length,count+1);assert.equal(refreshes.length,refresh);passed.push('copilot-401-replacement-no-refresh-retry')
 }
 {
  const {provider}=await fixture('copilot'),controller=new AbortController();controller.abort()
  const before=[calls.length,sessions.length,refreshes.length]
  await assert.rejects(()=>provider.prepareAffinityExecution({endpoint:'responses',payload:{model:base},headers:new Headers(),signal:controller.signal}))
  assert.deepEqual([calls.length,sessions.length,refreshes.length],before);passed.push('aborted-preparation-zero-io')
 }
 await Promise.all(pending)
 console.log(JSON.stringify({passed:true,runtime:'actual Bun providers + loopback HTTP + real SQLite authority',cases:passed,inferenceCalls:calls.length,sessionPreparations:sessions.length,refreshes:refreshes.length,scratch}))
}finally{upstream.stop(true)}
