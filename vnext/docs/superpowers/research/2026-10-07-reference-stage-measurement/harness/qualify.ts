import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Miniflare, Response as LocalResponse } from "../../../../../node_modules/miniflare"
import { unstable_splitSqlQuery } from "../../../../../apps/platform-cloudflare/node_modules/wrangler"
import { loadManifest, fileIdentity, sha, verifyFiles, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { readDumps, type LogicalDump, type CapturedDispatch } from "../../2026-10-02-workerd-deployed-comparison/harness/readback"
import { attach } from "../../2026-10-02-workerd-deployed-comparison/harness/inspector"
import { deadline } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"
import { oracle } from "../../2026-10-02-workerd-deployed-comparison/harness/oracle"
import { cells, makeRequest, verifyChat, type Cell } from "./contracts"
import { discoverWorkerd, readProcessResource, diffProcessResource } from "./process-resources"
import { coverage } from "./instrumentation"
import { matchedBuild } from "./build"
import type { Trace } from "./probe-runtime"

const API_KEY = "reference-comparison-local-key"
const SECRET = "reference-comparison-fixture-secret"
type Arm = "A" | "B"
type Obj = Record<string, unknown>
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {}
function requireHeap(input:unknown) {
  const heap=object(input)
  for(const key of ["usedSize","totalSize","embedderHeapUsedSize","backingStorageSize"]) if(typeof heap[key]!=="number" || !Number.isFinite(heap[key]) || heap[key]<0) throw new Error(`Missing or invalid heap field ${key}`)
  return heap
}
interface Dispatch extends CapturedDispatch { requestedStream: boolean; normalizedRequestSha256:string; completed:boolean; cancelled:boolean }
function fixture() {
  const dispatches: Dispatch[] = []
  const server = Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions" || request.headers.get("authorization") !== `Bearer ${SECRET}`) return new Response("Unexpected fixture request",{status:422})
    const raw = await request.text()
    const payload = object(JSON.parse(raw))
    const id = /BENCH_ID:([a-zA-Z0-9_-]+)/.exec(raw)?.[1]
    if (!id || payload.model !== "bench-chat-ok") return new Response("Invalid fixture identity",{status:422})
    const chunk = (delta:Obj, finish_reason:string|null, usage?:Obj) => `data: ${JSON.stringify({id:`chatcmpl_${id}`,object:"chat.completion.chunk",created:1790726400,model:"bench-chat-ok",choices:[{index:0,delta,finish_reason}],...(usage?{usage}:{})})}\n\n`
    const frames = [chunk({role:"assistant"},null),chunk({content:"BENCH_OK:65536"},null),chunk({},"stop",{prompt_tokens:7,completion_tokens:3,total_tokens:10}),"data: [DONE]\n\n"]
    const json=JSON.stringify({id:`chatcmpl_${id}`,object:"chat.completion",created:1790726400,model:"bench-chat-ok",choices:[{index:0,message:{role:"assistant",content:"BENCH_OK:65536"},finish_reason:"stop"}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}})
    const bytes = Buffer.from(payload.stream===true?frames.join(""):json)
    const observation:Dispatch = {id,status:200,protocol:"chat",bodyBytes:Buffer.byteLength(raw),requestPrefixSha256:sha(Buffer.from(raw).subarray(0,65536)),normalizedRequestSha256:sha(raw.replace(`BENCH_ID:${id}`,"BENCH_ID:NORMALIZED")),responseBytes:bytes.length,responsePrefixSha256:sha(bytes),responsePrefixBase64:bytes.toString("base64"),requestedStream:payload.stream===true,completed:false,cancelled:false}
    dispatches.push(observation)
    if(payload.stream!==true) {
      await Bun.sleep(20)
      observation.completed=true
      return new Response(json,{headers:{"content-type":"application/json"}})
    }
    const body = new ReadableStream<Uint8Array>({async start(controller) {
      for (const frame of frames) {
        await Bun.sleep(5)
        if (observation.cancelled) return
        controller.enqueue(new TextEncoder().encode(frame))
      }
      observation.completed=true
      controller.close()
    },cancel(){observation.cancelled=true}})
    // Honor the provider's actual source-format request; A/B JSON cannot parse SSE.
    return new Response(body,{headers:{"content-type":"text/event-stream"}})
  }})
  return {base:`http://127.0.0.1:${server.port}`,dispatches,stop:()=>server.stop(true)}
}

async function request(base:string, directory:string, arm:Arm, cell:Cell, id:string):Promise<LogicalDump & {ok:boolean}> {
  const body=makeRequest(id,cell)
  const wireEvidence=join(directory,`${id}.wire.json`)
  durableJson(join(directory,`${id}.offer.json`),{id,arm,cell,requestSha256:sha(body)},true)
  const start=performance.now()
  const response=await fetch(base+"/v1/chat/completions",{method:"POST",headers:{authorization:`Bearer ${API_KEY}`,"content-type":"application/json","x-benchmark-id":id},body,signal:AbortSignal.timeout(15000)})
  const raw=await response.text()
  const eofMs=performance.now()-start
  const sse=response.headers.get("content-type")?.includes("text/event-stream")??false
  let done=false
  const donePositions:number[]=[]
  const events:unknown[]=[]
  if (sse) {
    for (const frame of raw.replaceAll("\r\n","\n").split("\n\n")) {
      const data=frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n")
      if (data==="[DONE]") {done=true;donePositions.push(events.length);continue}
      if (data) events.push(JSON.parse(data))
    }
  } else events.push(JSON.parse(raw))
  const outcome=oracle(response.status,events,done,{variant:arm,protocol:"chat",upstream:"chat",scenario:"ok",bytes:65536,stream:cell.stream})
  const chatOutcome=verifyChat(response.status,events,done,cell.stream,{donePositions})
  const row={id,variant:arm,phase:"canary",protocol:"chat",upstream:"chat",scenario:"ok",bytes:65536,stream:cell.stream,status:response.status,wireBytes:Buffer.byteLength(body),responseBytes:Buffer.byteLength(raw),requestSha256:sha(body),responseSha256:sha(raw),dumpRecordId:response.headers.get("x-dump-record-id"),wireEvents:events,wireDone:done,transportCompleted:true,wireEvidence,eofMs,...outcome}
  durableJson(wireEvidence,{requestBody:body,response:raw,parsedEvents:events,done,row},true)
  if (sse!==cell.stream || !outcome.ok || !chatOutcome.ok) throw new Error(`Canary wire failure ${id}: ${JSON.stringify({outcome,chatOutcome})}; ${raw.slice(0,300)}`)
  return row
}

async function instance(manifest:Manifest, arm:Arm, bundle:string, directory:string, hooks:boolean) {
  mkdirSync(directory,{recursive:true})
  const upstream=fixture()
  const source=readFileSync(join(import.meta.dir,"entry.mjs.template"),"utf8")
    .replace("__WORKER__",JSON.stringify(bundle)).replace("__REFERENCE_EXPORTS__","").replace("__PROBE__",JSON.stringify(join(import.meta.dir,"probe-runtime.ts")))
    .replace("__HOOKS__",String(hooks))
  const entry=join(directory,"entry.ts")
  writeFileSync(entry,source)
  const build=await Bun.build({entrypoints:[entry],outdir:join(directory,"entry"),naming:"entry.mjs",target:"node",external:["cloudflare:sockets"],sourcemap:"external"})
  if (!build.success) {upstream.stop();throw new Error(build.logs.join("\n"))}
  const name=`reference-stage-${arm}-${hooks?"probe":"control"}`
  let rejected=0
  const mf=new Miniflare({name,modules:true,scriptPath:join(directory,"entry/entry.mjs"),modulesRoot:directory,host:"127.0.0.1",port:0,cf:false,compatibilityDate:"2025-06-01",compatibilityFlags:["nodejs_compat","enable_ctx_exports"],inspectorPort:0,inspectorHost:"127.0.0.1",d1Databases:{DB:`${arm}-${hooks}`},d1Persist:join(directory,"d1"),kvNamespaces:["KV","IMAGE_CACHE"],kvPersist:join(directory,"kv"),r2Buckets:["FILES"],r2Persist:join(directory,"r2"),images:{binding:"IMAGES"},outboundService:async (request:InstanceType<typeof import("../../../../../node_modules/miniflare").Request>)=>{
    if (request.url!==`${upstream.base}/v1/chat/completions` || request.method!=="POST") {rejected++;return new LocalResponse("Blocked egress",{status:502})}
    const result=await fetch(request.url,{method:"POST",headers:Object.fromEntries(request.headers),body:await request.arrayBuffer(),redirect:"manual",signal:AbortSignal.timeout(10000)})
    return new LocalResponse(result.body as unknown as ConstructorParameters<typeof LocalResponse>[0],{status:result.status,headers:Object.fromEntries(result.headers)})
  }})
  let inspector:Awaited<ReturnType<typeof attach>>|undefined
  try {
    const base=(await deadline("workerd ready",20000,()=>mf.ready)).origin
    const db=await mf.getD1Database("DB")
    const files=manifest.variants[arm].files.filter(file=>file.path.startsWith(manifest.variants[arm].migrationRoot+"/") && file.path.endsWith(".sql")).sort((a,b)=>a.path.localeCompare(b.path))
    for (const file of files) for (const sql of unstable_splitSqlQuery(readFileSync(file.path,"utf8"))) await deadline("migration",15000,()=>db.prepare(sql).run())
    const now="2026-10-07T00:00:00.000Z"
    await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind("architecture-owner","Fixture","fixture@example.invalid",now).run()
    await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds,dump_retention_seconds) VALUES(?,?,?,?,?,?,?)").bind("architecture-key","Fixture",API_KEY,now,"architecture-owner",0,0).run()
    const config={name:"Fixture",baseUrl:`${upstream.base}/v1`,apiKey:SECRET,authStyle:"bearer",endpoints:["chat_completions"],models:["bench-chat-ok"]}
    await db.prepare("INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind("custom:architecture-chat","architecture-owner","custom","Fixture",JSON.stringify(config),'[{"id":"direct_fetch"}]',now,now).run()
    const clockResponse=await fetch(base+"/__harness/clock",{headers:{"x-harness-key":"architecture-local-only"},signal:AbortSignal.timeout(10000)})
    if (!clockResponse.ok) throw new Error("Clock qualification HTTP failure")
    const clock:unknown=await clockResponse.json()
    const timer=object(clock)
    if(typeof timer.start!=="number" || typeof timer.end!=="number" || !Number.isFinite(timer.start) || !Number.isFinite(timer.end) || timer.end<=timer.start) throw new Error("Local synchronous clock did not advance; stage timing is unqualified")
    inspector=await attach(()=>mf.getInspectorURL(),name)
    const heapStart=requireHeap(await inspector.send("Runtime.getHeapUsage"))
    const processStart=await discoverWorkerd(process.pid)
    durableJson(join(directory,"identity.json"),{arm,hooks,workerBundle:fileIdentity(bundle),entrySource:fileIdentity(entry),entry:fileIdentity(join(directory,"entry/entry.mjs")),inspector:inspector.identity,processStart,clock,coverage:coverage(arm)},true)
    const rows:LogicalDump[]=[]
    for (const cell of cells.filter(cell=>cell.shape==="string" && cell.dump)) {
      rows.push(await request(base,directory,arm,cell,`${arm}-${hooks?"probe00":"control"}-${cell.id}`))
    }
    const response=await fetch(base+"/__harness/settled",{headers:{"x-harness-key":"architecture-local-only"},signal:AbortSignal.timeout(20000)})
    if (!response.ok) throw new Error("Settlement HTTP failure")
    const settlement:unknown=await response.json()
    const processEnd=await readProcessResource(processStart.pid)
    const resources=diffProcessResource(processStart,processEnd)
    const heapSettled=requireHeap(await inspector.send("Runtime.getHeapUsage"))
    const traceResponse=await fetch(base+"/__harness/traces",{headers:{"x-harness-key":"architecture-local-only"},signal:AbortSignal.timeout(10000)})
    if (!traceResponse.ok) throw new Error("Trace HTTP failure")
    const traceResult=object(await traceResponse.json())
    durableJson(join(directory,"observations.json"),{rows,dispatches:upstream.dispatches,rejected,settlement,traceResult,processStart,processEnd,resources,heapStart,heapSettled,scope:"cold two-request observer canary; includes harness settlement but excludes trace export/readback; no performance conclusion or peak measurement"},true)
    const state=object(settlement)
    if (state.active!==0 || state.pending!==0 || state.registered!==state.settled || !Array.isArray(state.failures) || state.failures.length || state.observerFailures!==0 || !Array.isArray(traceResult.traces) || state.unowned!==0 || traceResult.unowned!==0 || traceResult.observerFailures!==0) throw new Error("Invalid settlement or probe ownership")
    const traces=traceResult.traces as Trace[]
    if (rejected || upstream.dispatches.length!==rows.length || upstream.dispatches.some(dispatch=>!dispatch.completed || dispatch.cancelled || rows.filter(row=>row.id===dispatch.id).length!==1) || rows.some(row=>upstream.dispatches.filter(dispatch=>dispatch.id===row.id).length!==1)) throw new Error("Dispatch population mismatch")
    if (traces.length!==(hooks?rows.length:0) || new Set(traces.map(trace=>trace.id)).size!==traces.length) throw new Error("Trace cardinality mismatch")
    for (const trace of traces) {
      if (!rows.some(row=>row.id===trace.id) || trace.overflow || trace.counts["http.dispatches"]!==1 || trace.counts["request.body.bytes"]!==65536) throw new Error(`Invalid trace ${trace.id}`)
      for (const name of ["worker.entry","worker.response-return","auth.ready","body.ready","body.parsed","routing.start","routing.ready","provider.call","http.dispatch","sink.dump.persisted"]) if (!trace.marks.some(mark=>mark.name===name)) throw new Error(`Missing required boundary ${trace.id}/${name}`)
      for (const name of ["worker.entry","worker.response-return","http.dispatch"]) if(trace.marks.filter(mark=>mark.name===name).length!==1) throw new Error(`Duplicate boundary ${trace.id}/${name}`)
      for(let i=0;i<trace.marks.length;i++) {
        const at=trace.marks[i]?.at
        if(typeof at!=="number" || !Number.isFinite(at) || at<0 || at<(trace.marks[i-1]?.at??0)) throw new Error(`Nonmonotonic trace ${trace.id}`)
      }
      const dispatch=upstream.dispatches.find(dispatch=>dispatch.id===trace.id)
      if(!dispatch || (trace.counts["sse.parsed.frames"]??0)!==(dispatch.requestedStream?4:0) || (trace.counts["sse.input.bytes"]??0)!==(dispatch.requestedStream?dispatch.responseBytes:0)) throw new Error(`SSE observer coverage mismatch ${trace.id}`)
    }
    const bucket=await mf.getR2Bucket("FILES")
    const readback=await deadline("physical dump readback",30000,()=>readDumps(db,bucket,rows,upstream.dispatches,{checked:new Set()},arm))
    if(hooks) {
      let objects=0,compressedBytes=0
      for(const value of readback.newRecords) {
        const record=object(value)
        if(!Array.isArray(record.objects)) throw new Error("Missing physical object receipt")
        for(const value of record.objects) {
          const item=object(value)
          if(typeof item.compressedBytes!=="number") throw new Error("Missing physical byte count")
          objects++;compressedBytes+=item.compressedBytes
        }
      }
      const total=(name:string)=>traces.reduce((sum,trace)=>sum+(trace.counts[name]??0),0)
      if(total("sink.files.puts")!==objects || total("sink.files.bytes")!==compressedBytes) throw new Error("Sink observer counts disagree with physical readback")
    }
    durableJson(join(directory,"receipt.json"),{completed:true,arm,hooks,readback,resources,qualifiedRequests:rows.length,comparisonCompleted:false},true)
    return upstream.dispatches
  } finally {
    await inspector?.close().catch(()=>{})
    try {await deadline("workerd dispose",15000,()=>mf.dispose())} finally {upstream.stop()}
  }
}

export async function qualifyAb(manifestPath:string, output:string) {
  const manifest=loadManifest(manifestPath)
  mkdirSync(output,{recursive:true})
  durableJson(join(output,"disposition.json"),{completed:false,comparisonCompleted:false,scope:"A/B observer qualification only"},true)
  for (const arm of ["A","B"] as const) {
    const approved=[...manifest.variants[arm].files,...manifest.dependencies]
    durableJson(join(output,`${arm}-approved.json`),approved,true)
    const directory=join(output,`${arm}-build`)
    mkdirSync(directory)
    await deadline("diagnostic build",120000,()=>matchedBuild(manifest.variants[arm].root,manifest.variants.B.root,join(directory,"bundle"),approved,arm))
    const control=await instance(manifest,arm,manifest.variants[arm].bundle,join(output,`${arm}-control`),false)
    const probe=await instance(manifest,arm,join(directory,"bundle/worker.mjs"),join(output,`${arm}-probe`),true)
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
