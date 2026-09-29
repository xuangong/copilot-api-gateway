import {readFile,writeFile,mkdtemp} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {tmpdir} from 'node:os'
import assert from 'node:assert/strict'
const root=process.env.VNEXT_PROBE_ROOT;assert(root)
const scratch=await mkdtemp(`${tmpdir()}/c07-codec-runtime-`),entry=`${scratch}/worker.mjs`,bundle=`${scratch}/bundle.mjs`
const vectors=JSON.parse(await readFile(new URL('./task-C07-codec-vectors.json',import.meta.url),'utf8'))
await writeFile(entry,(await readFile(new URL('./task-C07-codec-worker.mjs.txt',import.meta.url),'utf8')).replaceAll('__ROOT__',root).replace('__VECTORS__',JSON.stringify(vectors)))
const local=await import(entry);const bun=await local.runCodecProbe();assert.equal(bun.passed,true)
const build=spawnSync('bun',['build',entry,'--target=browser',`--outfile=${bundle}`],{cwd:root,encoding:'utf8'});assert.equal(build.status,0,build.stderr)
const {Miniflare}=await import(`${root}/vnext/node_modules/.bun/miniflare@4.20260601.0/node_modules/miniflare/dist/src/index.js`)
const mf=new Miniflare({modules:true,modulesRoot:scratch,scriptPath:bundle,compatibilityDate:'2026-06-01',compatibilityFlags:['nodejs_compat']})
try{
 const response=await mf.dispatchFetch('http://local/'),body=await response.text();assert.equal(response.status,200,body)
 const workerd=JSON.parse(body);assert.deepEqual(workerd,bun)
 console.log(JSON.stringify({passed:true,runtimes:['actual Bun','actual local workerd'],bun,workerd,scratch,liveProvider:false}))
}finally{await mf.dispose()}
