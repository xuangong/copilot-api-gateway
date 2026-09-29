import { D1Repo } from '__ROOT__/vnext/apps/platform-cloudflare/src/d1-repo.ts'
import { initUpstreamRepo } from '__ROOT__/vnext/packages/upstream-repo/src/index.ts'
import { ensureCodexAccessToken } from '__ROOT__/vnext/packages/provider-codex/src/access-token.ts'
import { importCodexFromAuthJson } from '__ROOT__/vnext/packages/provider-codex/src/auth/import.ts'
import { callCodexResponses, callCodexResponsesCompact, callCodexAlphaSearch } from '__ROOT__/vnext/packages/provider-codex/src/fetch.ts'
import { readCodexCredential } from '__ROOT__/vnext/packages/provider-codex/src/credential-effects.ts'
import { CodexOAuthSessionTerminatedError } from '__ROOT__/vnext/packages/provider-codex/src/auth/oauth.ts'
import { CodexProvider } from '__ROOT__/vnext/packages/provider-codex/src/provider.ts'
import { initBackground } from '__ROOT__/vnext/packages/platform/src/index.ts'
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const caught = promise => promise.then(value => ({value}), error => ({error}))
const jwt = claims => `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify(claims)).replaceAll('=', '').replaceAll('+', '-').replaceAll('/', '_')}.synthetic`
export default { async fetch(_request, env) { let stage='start'; try {
  const repo=new D1Repo(env.DB), sibling=new D1Repo(env.DB), results={}, background=[]
  initUpstreamRepo(() => repo.upstreams); initBackground({waitUntil:promise=>background.push(promise)})
  const now=new Date().toISOString(), accountId='synthetic-account', future=Date.now()+3_600_000
  const access=(token,expiresAt=future)=>({token,expiresAt,refreshedAt:now})
  const account=(overrides={})=>({chatgptAccountId:accountId,credentialRevision:'original',refresh_token:null,state:'active',state_updated_at:now,openaiDeviceId:'11111111-2222-4333-8444-555555555555',accessToken:access('synthetic-original'),quotaSnapshot:null,...overrides})
  const row=(id,credential=account())=>({id,ownerId:'synthetic-owner',provider:'codex',name:'Fixture',enabled:true,sortOrder:0,config:{accounts:[{chatgptAccountId:accountId,email:null,chatgptUserId:null,planType:null}]},state:{accounts:[credential]},flagOverrides:{},disabledPublicModelIds:[],proxyFallbackList:[],createdAt:now,updatedAt:now})
  const save=async(id,credential)=>{stage=id;await repo.upstreams.save(row(id,credential));return await repo.upstreams.getById(id)}
  const current=async id=>(await repo.upstreams.getById(id)).state.accounts[0]
  const neverMint=async()=>{throw new Error('Unexpected OAuth')}
  stage='access-only-parser'
  const expiry=Math.floor(future/1000)
  const token=jwt({exp:expiry,'https://api.openai.com/auth':{chatgpt_account_id:accountId}})
  const imported=await importCodexFromAuthJson(JSON.stringify({tokens:{access_token:token}}))
  assert(imported.state.accounts[0].accessToken.token===token,'Parser changed bearer bytes')
  assert(imported.state.accounts[0].accessToken.expiresAt===expiry*1000,'Parser ignored JWT expiry')
  assert(imported.state.accounts[0].refresh_token===null && imported.config.accounts[0].email===null,'Parser fabricated renewal or identity')
  results.accessOnlyParser=true

  for(const [id,expiry] of [['known-near-expiry',Date.now()+120_000],['unknown-expiry',null]]){
    await save(id,account({accessToken:access(id,expiry)}))
    assert((await ensureCodexAccessToken(id,accountId,neverMint)).token===id,'Access-only bearer was not selected')
    const forced=await caught(ensureCodexAccessToken(id,accountId,neverMint,true))
    assert(forced.error && (await current(id)).accessToken.token===id,'Forced renewal cleared access-only bearer')
    results[id]=true
  }
  await save('expired',account({accessToken:access('expired',Date.now()-1000)}))
  assert((await caught(ensureCodexAccessToken('expired',accountId,neverMint))).error,'Expired nonrenewable bearer usable')
  results.expiredRejectedBeforeMint=true
  await save('renewable-unknown',account({refresh_token:'synthetic-refresh',accessToken:access('unknown',null)}));let minted=0
  const fresh=await ensureCodexAccessToken('renewable-unknown',accountId,async token=>{
    assert(token==='synthetic-refresh','Wrong refresh token');minted++;return {refreshToken:'synthetic-rotated-refresh',accessToken:access('synthetic-rotated')}
  })
  assert(minted===1 && fresh.token==='synthetic-rotated','Unknown renewable expiry did not refresh')
  results.renewableUnknownRefreshes=true

  for(const [kind,call] of [['responses',callCodexResponses],['compact',callCodexResponsesCompact],['alpha',callCodexAlphaSearch]]){
    for(const variant of ['generic','terminal','late-reimport']){
      const id=`${kind}-${variant}`;await save(id)
      const lease=await ensureCodexAccessToken(id,accountId,neverMint);let attempts=0,oauth=0
      const response=await call({upstreamId:id,account:await current(id),credential:lease.credential,model:{id:'gpt-5'},headers:new Headers(),
        body:kind==='alpha'?{commands:{search_query:[{query:'synthetic'}]}}:{input:[{type:'message',role:'user',content:'synthetic'}]},
        fetcher:async()=>{oauth++;throw new Error('Forbidden OAuth')},
        executionFetcher:async()=>{
          attempts++
          if(variant==='late-reimport')await sibling.upstreams.saveState(id,state=>({...state,accounts:[account({credentialRevision:'replacement',accessToken:access('synthetic-replacement')})]}))
          return Response.json({error:{code:variant==='terminal'?'token_invalidated':'unauthorized',message:'synthetic upstream private detail'}},{status:401})
        },
      })
      await response.text();await Promise.all(background.splice(0))
      const stored=await current(id),expected=variant==='late-reimport'?'active':variant==='terminal'?'session_terminated':'access_rejected'
      assert(response.status>=400 && attempts===1 && oauth===0,`${id} retried or succeeded`)
      assert(stored.state===expected,`${id} incorrect credential health`)
      if(variant==='late-reimport')assert(stored.accessToken.token==='synthetic-replacement','Late effect damaged replacement bearer')
      results[id]={attempts,oauth,health:stored.state}
    }
  }
  for(const [kind,call] of [['responses',callCodexResponses],['compact',callCodexResponsesCompact],['alpha',callCodexAlphaSearch]]){
    const id=`mint-abort-${kind}`;await save(id,account({refresh_token:'synthetic-refresh',accessToken:null}))
    let oauth=0,execution=0,seenSignal;const abort=new AbortController()
    const captured=await readCodexCredential(id,accountId)
    const pending=caught(call({upstreamId:id,account:captured.account,credential:captured.credential,model:{id:'gpt-5'},headers:new Headers(),signal:abort.signal,
      body:kind==='alpha'?{commands:{search_query:[{query:'synthetic'}]}}:{input:[{type:'message',role:'user',content:'synthetic'}]},
      fetcher:async(_url,init)=>{oauth++;seenSignal=init?.signal;return await new Promise((_resolve,reject)=>{
        const failed=()=>reject(new DOMException('Synthetic abort','AbortError'))
        if(seenSignal?.aborted)failed();else seenSignal?.addEventListener('abort',failed,{once:true})
      })},
      executionFetcher:async()=>{execution++;return Response.json({output:[]})},
    }))
    const timer=setTimeout(()=>abort.abort(),40)
    let fallback
    const result=await Promise.race([pending,new Promise(resolve=>{fallback=setTimeout(()=>resolve({timedOut:true}),1000)})])
    clearTimeout(timer);clearTimeout(fallback)
    assert(!result.timedOut && seenSignal?.aborted && oauth===1 && execution===0,`${id} failed to cancel OAuth I/O`)
    assert((await current(id)).state==='active' && (await current(id)).accessToken===null,`${id} abort damaged credential`)
    results[id]={oauth,execution,aborted:true}
  }
  for(const kind of ['terminal-read','terminal-effect','success-winner']){
    const id=`${kind}-abort`;await save(id,account({refresh_token:'synthetic-refresh',accessToken:null}))
    let reads=0,release,entered
    const gate=new Promise(resolve=>{release=resolve}), reached=new Promise(resolve=>{entered=resolve})
    const delayed=new Proxy(repo.upstreams,{get(target,key){
      if(key==='getById')return async value=>{const result=await target.getById(value);if(value===id && ++reads===2 && kind!=='terminal-effect'){entered();await gate}return result}
      if(key==='saveState' && kind==='terminal-effect')return async(...args)=>{entered();await gate;return target.saveState(...args)}
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
    }})
    initUpstreamRepo(()=>delayed)
    const controller=new AbortController()
    const pending=caught(ensureCodexAccessToken(id,accountId,async()=>{
      if(kind==='success-winner')return {refreshToken:'synthetic-rotated',accessToken:access('synthetic-minted')}
      throw new CodexOAuthSessionTerminatedError({code:'invalid_grant',message:'synthetic terminal'})
    },false,undefined,controller.signal))
    await reached;controller.abort()
    let timeout
    const early=await Promise.race([pending,new Promise(resolve=>{timeout=setTimeout(()=>resolve({timedOut:true}),150)})]);clearTimeout(timeout)
    release();const result=await pending;await new Promise(resolve=>setTimeout(resolve,50));initUpstreamRepo(()=>repo.upstreams)
    assert(!early.timedOut && result.error?.name==='AbortError',`${id} did not settle on abort`)
    assert((await current(id)).state==='active',`${id} mutated health after abort`)
    if(kind!=='success-winner')assert((await current(id)).accessToken===null,`${id} mutated access token`)
    results[id]={prompt:true,health:'active'}
  }
  for(const variant of ['generic','terminal','renewable-generic','late-reimport','row-replacement']){
    const id=`catalog-${variant}`, stored=await save(id,account({refresh_token:variant==='renewable-generic'?'synthetic-refresh':null}));let attempts=0
    const provider=new CodexProvider(stored,async()=>{
      attempts++
      if(variant==='late-reimport')await sibling.upstreams.saveState(id,state=>({...state,accounts:[account({credentialRevision:'replacement',accessToken:access('synthetic-replacement')})]}))
      if(variant==='row-replacement'){await sibling.upstreams.delete(id);await sibling.upstreams.save(row(id,account({credentialRevision:'replacement',accessToken:access('synthetic-replacement')})))}
      return Response.json({error:{code:variant==='terminal'?'token_invalidated':'unauthorized',message:'synthetic upstream private detail'}},{status:401})
    })
    const result=await caught(provider.getModels()),state=await current(id)
    assert(result.error && attempts===1 && !String(result.error.message).includes('private detail'),`${id} retries or leaks error body`)
    const expected=variant==='terminal'?'session_terminated':variant==='generic'?'access_rejected':'active'
    assert(state.state===expected,`${id} incorrect health`)
    results[id]={attempts,health:state.state}
  }
  await Promise.all(background)
  return Response.json({passed:true,results})
} catch(error){return Response.json({passed:false,stage,error:{name:error.name,message:error.message,stack:error.stack}},{status:500})} } }
