import { Miniflare } from '../../../../node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js'
import { mkdtemp } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const root=fileURLToPath(new URL('../../../../../',import.meta.url))
const scratch=await mkdtemp(`${tmpdir()}/b05-serializer-worker-`)
const bundle=`${scratch}/worker.mjs`
const build=spawnSync('bun',['build',fileURLToPath(new URL('./task-B05-serializer-worker.ts',import.meta.url)),'--target=browser',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'})
assert.equal(build.status,0,build.stderr)
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01'})
try {
 const response=await mf.dispatchFetch('http://localhost/')
 assert.equal(response.status,200,await response.clone().text())
 const result=await response.json();assert.equal(result.passed,true)
 console.log(JSON.stringify(result))
} finally {await mf.dispose()}
