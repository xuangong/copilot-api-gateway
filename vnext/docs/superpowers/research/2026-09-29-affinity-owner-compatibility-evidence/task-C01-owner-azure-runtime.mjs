import assert from 'node:assert/strict'
import {serve} from 'bun'
import {mkdtemp} from 'node:fs/promises'
import {tmpdir} from 'node:os'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const src=`${root}/vnext`
const {bootstrapBunPlatform}=await import(`${src}/apps/platform-bun/src/bootstrap.ts`)
const {getRepo}=await import(`${src}/packages/gateway/src/repo/index.ts`)
const {configurationAffinityAuthority}=await import(`${src}/packages/gateway/src/data-plane/providers/affinity-authority.ts`)
const {AzureProvider}=await import(`${src}/packages/provider-azure/src/provider.ts`)
const {affinityTargetMatch}=await import(`${src}/packages/provider-llm/src/opaque-affinity.ts`)
const scratch=await mkdtemp(`${tmpdir()}/c01-owner-azure-`)
bootstrapBunPlatform({dbPath:`${scratch}/fixture.sqlite`,filesRoot:`${scratch}/files`})
const calls=[],cases=[]
const upstream=serve({hostname:'127.0.0.1',port:0,fetch:async req=>{calls.push({path:new URL(req.url).pathname,body:await req.json()});return Response.json({ok:true})}})
const group={version:1,key:'synthetic-openai-group',scope:'owner'},other={...group,key:'synthetic-anthropic-group'}
const config={name:'synthetic',endpoint:'https://synthetic.openai.azure.com',apiKey:'synthetic-key',deployment:'default',apiVersion:'2025-01-01',endpoints:['responses','messages'],deployments:[{name:'actual-deployment',model:'public-model'}],opaqueCompatibility:{'openai:actual-deployment':group,'anthropic:public-model':other}}
const now=new Date().toISOString()
await getRepo().upstreams.save({id:'up_azure',ownerId:'owner',provider:'azure',name:'synthetic',enabled:true,sortOrder:0,config,state:{},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[],createdAt:now,updatedAt:now})
const row=await getRepo().upstreams.getById('up_azure');assert(row)
const provider=new AzureProvider(config,async(input,init)=>{const req=input instanceof Request?input:new Request(input,init),u=new URL(req.url);assert.equal(u.hostname,'synthetic.openai.azure.com');return fetch(`http://127.0.0.1:${upstream.port}${u.pathname}`,{method:req.method,headers:req.headers,body:await req.text(),signal:req.signal})},undefined,configurationAffinityAuthority(row,getRepo().upstreams))
try{
 for(const [endpoint,expected]of [['responses',group],['messages',other]]){
  const request={endpoint,sourceApi:endpoint==='responses'?'openai':'anthropic',sourceProtocol:endpoint,payload:{model:'public-model'},headers:new Headers()}
  const count=calls.length,target=await provider.prepareAffinityExecution(request);assert(target);assert.deepEqual(target.compatibility,expected);assert.equal(calls.length,count)
  const response=await provider.fetch({...request,beforeInference:async actual=>{assert.equal(affinityTargetMatch(target,actual),'exact');assert.deepEqual(actual.compatibility,expected)}});await new Response(response.body).text()
  assert.deepEqual(response.affinityExecution,target)
  if(endpoint==='responses')assert(calls.at(-1).path.includes('/deployments/actual-deployment/'));else{assert.equal(calls.at(-1).path,'/anthropic/v1/messages');assert.equal(calls.at(-1).body.model,'public-model')}
  cases.push(`${endpoint}-declaration-matches-actual-surface`)
 }
 const request={endpoint:'responses',payload:{model:'public-model'},headers:new Headers()},target=await provider.prepareAffinityExecution(request);assert(target)
 await getRepo().upstreams.save({...row,config:{...config,opaqueCompatibility:{}}})
 const before=calls.length
 await assert.rejects(()=>provider.fetch({...request,beforeInference:async actual=>assert.equal(affinityTargetMatch(target,actual),'exact')}));assert.equal(calls.length,before);cases.push('configuration-replacement-zero-inference')
 console.log(JSON.stringify({passed:true,runtime:'actual Azure provider + loopback HTTP + real SQLite authority',cases,calls:calls.length,scratch}))
}finally{upstream.stop(true)}
