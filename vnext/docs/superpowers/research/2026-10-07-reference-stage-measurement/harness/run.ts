import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join, resolve } from "node:path"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { fileIdentity, loadManifest, sha, verifyFiles } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { supervise } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"

const [command,...args]=process.argv.slice(2)
if (command!=="qualify-ab") throw new Error("Usage: bun run.ts qualify-ab --manifest PATH --out NEW_DIR")
const options=new Map<string,string>()
for(let i=0;i<args.length;i+=2) {
  const key=args[i],value=args[i+1]
  if(!key || !["--manifest","--out"].includes(key) || options.has(key) || !value || value.startsWith("--")) throw new Error("Invalid or duplicate argument")
  options.set(key,resolve(value))
}
const manifestPath=options.get("--manifest"),output=options.get("--out")
if(!manifestPath || !output) throw new Error("Missing manifest or output")
const manifest=loadManifest(manifestPath)
if(existsSync(output)) throw new Error("Output exists; preserve previous evidence")
mkdirSync(output,{recursive:true,mode:0o700})
const reused=resolve(import.meta.dir,"../../2026-10-02-workerd-deployed-comparison/harness")
const harness=[...readdirSync(import.meta.dir).filter(name=>/\.(ts|py|template|json)$/.test(name)).map(name=>fileIdentity(join(import.meta.dir,name))),...readdirSync(reused).filter(name=>name.endsWith(".ts")).map(name=>fileIdentity(join(reused,name))),fileIdentity(manifestPath)]
durableJson(join(output,"inputs.json"),{manifestPath,manifestSha256:sha(readFileSync(manifestPath)),experimentId:manifest.id,harness,runtime:manifest.runtime,compatibilityFlags:["nodejs_compat","enable_ctx_exports"],scope:"A/B cold two-request observer canary; R unavailable; no formal comparison"},true)
durableJson(join(output,"supervision.json"),{completed:false,cleanupComplete:false},true)
const abort=new AbortController()
const interrupt=()=>abort.abort()
process.on("SIGINT",interrupt)
process.on("SIGTERM",interrupt)
try {
  const result=await supervise({command:process.execPath,args:[join(import.meta.dir,"qualify.ts"),manifestPath,output,"--supervised"],directory:output,timeoutMs:360000,signal:abort.signal})
  durableJson(join(output,"supervision.json"),result)
  if(result.exitCode!==0 || result.timedOut || result.interrupted || !result.cleanupComplete) throw new Error("Qualification child failed; preserve logs and partial evidence")
  const receipt=JSON.parse(readFileSync(join(output,"disposition.json"),"utf8")) as {completed?:boolean}
  if(receipt.completed!==true) throw new Error("Incomplete qualification receipt")
  verifyFiles(harness)
  loadManifest(manifestPath)
  durableJson(join(output,"result.json"),{completed:true,comparisonCompleted:false,scope:"A/B observer canary only",supervision:result},true)
  console.log(JSON.stringify({completed:true,comparisonCompleted:false,output}))
} catch(error) {
  durableJson(join(output,"result.json"),{completed:false,comparisonCompleted:false,error:String(error)})
  console.error(String(error))
  process.exitCode=2
} finally {
  process.off("SIGINT",interrupt)
  process.off("SIGTERM",interrupt)
}
