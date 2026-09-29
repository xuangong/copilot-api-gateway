import assert from 'node:assert/strict'
import {writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {createFixture} from './task-C12-F4-runtime-fixture.mjs'

// Long-running host for the two existing pinned Codex accept filters.
const preparationOnly=process.env.C12_F4_PREPARATION_ONLY==='1'
const fixture=await createFixture({preparationOnly})
let stopping=false
async function stop(){if(stopping)return;stopping=true;await fixture.stop()}
process.once('SIGINT',()=>{void stop().then(()=>process.exit(0))})
process.once('SIGTERM',()=>{void stop().then(()=>process.exit(0))})
try{
  if(preparationOnly){
    const response=await fetch(`${fixture.gatewayBase}/v1/responses`,{method:'POST',headers:{authorization:`Bearer ${fixture.key}`,'content-type':'application/json'},body:JSON.stringify({model:'gpt-5.4',input:'C12 F4 infrastructure smoke',stream:false,store:false})})
    const text=await response.text()
    assert.equal(response.status,200,text)
    const after=await fixture.observe()
    assert.equal(after.http_posts,1)
    assert.equal(after.upstream_requests.length,1)
    assert.deepEqual(after.connections,[])
  }
  const info={gatewayBaseUrl:fixture.gatewayBase,fixtureBaseUrl:fixture.fixtureBase,apiKey:fixture.key,source:fixture.root,runDir:fixture.run,
    d1Persist:join(fixture.run,'d1'),compatibilityDate:'2025-06-01',compatibilityFlags:['nodejs_compat'],migrations:fixture.migrations.length,
    observation:`${fixture.fixtureBase}/__fixture/c12`,preparationOnly,
    note:preparationOnly?'Real workerd/D1 HTTP infrastructure smoke only. No WS acceptance.':'Harness ready only. No pinned-client acceptance has run.'}
  await writeFile(join(fixture.run,'runtime.json'),JSON.stringify(info,null,2))
  console.log(JSON.stringify({harnessReady:true,...info}))
  await new Promise(()=>{})
}finally{await stop()}
