import { Miniflare } from '../../../../node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js'
import { mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../../../../../',import.meta.url))
const scratch=await mkdtemp(`${tmpdir()}/b05-hash-worker-`)
const bundle=`${scratch}/worker.mjs`
const build=spawnSync('bun',['build',fileURLToPath(new URL('./task-B05-hash-worker.ts',import.meta.url)),'--target=browser',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'})
assert.equal(build.status,0,build.stderr)
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01'})
try {
 const results=[]
 for(const size of [1,10]) {
  const call=async(mode)=>{const r=await mf.dispatchFetch(`http://localhost/?mib=${size}&mode=${mode}`);assert.equal(r.status,200);return r.json()}
  const old=await call('old'), current=await call('incremental')
  assert.equal(current.id,old.id)
  if(size===10) assert.equal(current.timerBeforeCompletion,true)
  results.push({old,current})
 }
 console.log(JSON.stringify({runtime:'local workerd 1.20260601.1',passed:true,results,scratch}))
} finally {await mf.dispose()}
