import { mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { unstable_splitSqlQuery } from "../../../../../apps/platform-cloudflare/node_modules/wrangler"
import { loadManifest, verifyFiles, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { readDumps } from "../../2026-10-02-workerd-deployed-comparison/harness/readback"
import { deadline } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"
import { matchedBuild } from "./build"
import { API_KEY, SECRET, runQualifiedInstance } from "./runtime"
import { runInstanceJob, writeInstanceContext } from "./instance-job"

type Arm = "A" | "B"
export function runAbInstance(manifest:Manifest, arm:Arm, bundle:string, directory:string, hooks:boolean) {
  return runQualifiedInstance({arm,bundle,directory,hooks,
    async initialize(db,base) {
      const files=manifest.variants[arm].files.filter(file=>file.path.startsWith(manifest.variants[arm].migrationRoot+"/") && file.path.endsWith(".sql")).sort((a,b)=>a.path.localeCompare(b.path))
      for (const file of files) for (const sql of unstable_splitSqlQuery(readFileSync(file.path,"utf8"))) await deadline("migration",15000,()=>db.prepare(sql).run())
      const now="2026-10-07T00:00:00.000Z"
      await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind("architecture-owner","Fixture","fixture@example.invalid",now).run()
      await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds,dump_retention_seconds) VALUES(?,?,?,?,?,?,?)").bind("architecture-key","Fixture",API_KEY,now,"architecture-owner",0,3600).run()
      const config={name:"Fixture",baseUrl:`${base}/v1`,apiKey:SECRET,authStyle:"bearer",endpoints:["chat_completions"],models:["bench-chat-ok"]}
      await db.prepare("INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind("custom:architecture-chat","architecture-owner","custom","Fixture",JSON.stringify(config),'[{"id":"direct_fetch"}]',now,now).run()
    },
    async readback(db,bucket,rows,dispatches) {
      const evidence=await readDumps(db,bucket,rows.map(row=>({...row,variant:arm})),dispatches,{checked:new Set()},arm)
      const objects=evidence.newRecords.flatMap(value=>{
        const record=value as {objects?: {compressedBytes:number}[]}
        if(!Array.isArray(record.objects) || record.objects.some(item=>!Number.isSafeInteger(item.compressedBytes) || item.compressedBytes<0)) throw new Error("Invalid physical object receipt")
        return record.objects
      })
      return {evidence,objectCount:objects.length,compressedBytes:objects.reduce((sum,item)=>sum+item.compressedBytes,0)}
    },
  })
}

export async function qualifyAb(manifestPath:string, output:string) {
  const manifest=loadManifest(manifestPath)
  mkdirSync(output,{recursive:true})
  durableJson(join(output,"disposition.json"),{completed:false,comparisonCompleted:false,scope:"A/B observer qualification only"},true)
  const context=writeInstanceContext(join(output,"instance-context.json"),{manifest})
  for (const arm of ["A","B"] as const) {
    const approved=[...manifest.variants[arm].files,...manifest.dependencies]
    durableJson(join(output,`${arm}-approved.json`),approved,true)
    const directory=join(output,`${arm}-build`)
    mkdirSync(directory)
    await deadline("diagnostic build",120000,()=>matchedBuild(manifest.variants[arm].root,manifest.variants.B.root,join(directory,"bundle"),approved,arm))
    const control=await runInstanceJob({kind:"ab-canary",context,arm,bundle:manifest.variants[arm].bundle,directory:join(output,`${arm}-control`),hooks:false})
    const probe=await runInstanceJob({kind:"ab-canary",context,arm,bundle:join(directory,"bundle/worker.mjs"),directory:join(output,`${arm}-probe`),hooks:true})
    if(control.length!==probe.length || control.some((before,index)=>{
      const after=probe[index]
      return !after || before.normalizedRequestSha256!==after.normalizedRequestSha256 || before.bodyBytes!==after.bodyBytes || before.requestedStream!==after.requestedStream || before.responseBytes!==after.responseBytes
    })) throw new Error(`Observer changed upstream work ${arm}`)
    durableJson(join(output,`${arm}-observer-equivalence.json`),{completed:true,scope:"full upstream request bytes normalized only for equal-length BENCH_ID; format, response bytes, dispatches and client semantics match",control,probe},true)
  }
  verifyFiles([...manifest.variants.A.files,...manifest.variants.B.files])
  durableJson(join(output,"disposition.json"),{completed:true,comparisonCompleted:false,scope:"A/B observer qualification only"})
}

if (import.meta.main) {
  const [manifest,output,ready]=process.argv.slice(2)
  if (!manifest || !output || ready!=="--supervised") throw new Error("Use run.ts qualify-ab --manifest PATH --out NEW_DIR")
  try {await qualifyAb(manifest,output)} catch(error) {
    durableJson(join(output,"disposition.json"),{completed:false,comparisonCompleted:false,fatal:String(error)})
    throw error
  }
}
