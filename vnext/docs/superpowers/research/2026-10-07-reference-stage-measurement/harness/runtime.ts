import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Miniflare, Response as LocalResponse } from "../../../../../node_modules/miniflare"
import { fileIdentity, sha } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { type LogicalDump, type CapturedDispatch } from "../../2026-10-02-workerd-deployed-comparison/harness/readback"
import { attach } from "../../2026-10-02-workerd-deployed-comparison/harness/inspector"
import { deadline } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"
import { oracle } from "../../2026-10-02-workerd-deployed-comparison/harness/oracle"
import { cells, makeRequest, verifyChat, type Cell, type Arm } from "./contracts"
import { discoverWorkerd, readProcessResource, diffProcessResource } from "./process-resources"
import { coverage } from "./instrumentation"
import type { Trace } from "./probe-runtime"

export const API_KEY = "reference-comparison-local-key"
export const SECRET = "reference-comparison-fixture-secret"
type Obj = Record<string, unknown>
const object = (value: unknown): Obj => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Obj : {}
function requireHeap(input:unknown) {
  const heap=object(input)
  for(const key of ["usedSize","totalSize","embedderHeapUsedSize","backingStorageSize"]) if(typeof heap[key]!=="number" || !Number.isFinite(heap[key]) || heap[key]<0) throw new Error(`Missing or invalid heap field ${key}`)
  return heap
}
export interface Dispatch extends CapturedDispatch {
  status: number
  requestedStream: boolean
  requestSha256: string
  normalizedRequestSha256: string
  url: string
  method: string
  upstreamId: string
  requestHeaders: [string, string][]
  responseHeaders: [string, string][]
  completed: boolean
  cancelled: boolean
}
export type TestDatabase = Awaited<ReturnType<Miniflare["getD1Database"]>>
export type TestBucket = Awaited<ReturnType<Miniflare["getR2Bucket"]>>
export interface QualifiedRow extends Omit<LogicalDump, "variant"> {
  variant: Arm
  arm: Arm
  donePositions: number[]
  wireEvents: unknown[]
  wireDone: boolean
  wireEvidence: string
  cell: string
  dump: boolean
  phase: "canary" | "warmup" | "timed"
  eofMs: number
}
export interface QualifiedInstanceOptions {
  arm: Arm
  bundle: string
  directory: string
  hooks: boolean
  window?: { id: string; cell: Cell; warmup: number; timed: number }
  initialize(db: TestDatabase, base: string): Promise<void>
  readback(db: TestDatabase, bucket: TestBucket, rows: QualifiedRow[], dispatches: Dispatch[]): Promise<{ evidence: unknown; objectCount: number; compressedBytes: number }>
}
function fixture(arm: Arm) {
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
    const observation:Dispatch = {id,status:200,protocol:"chat",bodyBytes:Buffer.byteLength(raw),requestPrefixSha256:sha(Buffer.from(raw).subarray(0,65536)),requestSha256:sha(raw),url:request.url,method:request.method,upstreamId:arm==="R"?"custom:reference-fixture":"custom:architecture-chat",requestHeaders:[...request.headers],responseHeaders:[["content-type",payload.stream===true?"text/event-stream":"application/json"]],normalizedRequestSha256:sha(raw.replace(`BENCH_ID:${id}`,"BENCH_ID:NORMALIZED")),responseBytes:bytes.length,responsePrefixSha256:sha(bytes),responsePrefixBase64:bytes.toString("base64"),requestedStream:payload.stream===true,completed:false,cancelled:false}
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

async function request(base:string, directory:string, arm:Arm, cell:Cell, id:string, phase:QualifiedRow["phase"]):Promise<QualifiedRow> {
  const body=makeRequest(id,cell)
  const wireEvidence=join(directory,`${id}.wire.json`)
  durableJson(join(directory,`${id}.offer.json`),{id,arm,cell,phase,requestSha256:sha(body)},true)
  const requestHeaders=new Headers({authorization:`Bearer ${API_KEY}`,"content-type":"application/json","x-benchmark-id":id})
  const start=performance.now()
  const response=await fetch(base+"/v1/chat/completions",{method:"POST",headers:requestHeaders,body,signal:AbortSignal.timeout(15000)})
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
  } else {
    try {events.push(JSON.parse(raw))}
    catch(error) {
      durableJson(join(directory,`${id}.invalid-wire.json`),{id,arm,cell,phase,status:response.status,requestBody:body,requestHeaders:[...requestHeaders],response:raw,responseHeaders:[...response.headers],error:String(error)},true)
      throw error
    }
  }
  const outcome=oracle(response.status,events,done,{variant:arm==="R"?undefined:arm,protocol:"chat",upstream:"chat",scenario:"ok",bytes:65536,stream:cell.stream})
  const chatOutcome=verifyChat(response.status,events,done,cell.stream,{donePositions})
  const row={id,variant:arm,arm,donePositions,phase,cell:cell.id,dump:cell.dump,protocol:"chat",upstream:"chat",scenario:"ok",bytes:65536,stream:cell.stream,status:response.status,wireBytes:Buffer.byteLength(body),responseBytes:Buffer.byteLength(raw),requestSha256:sha(body),responseSha256:sha(raw),dumpRecordId:response.headers.get("x-dump-record-id"),wireEvents:events,wireDone:done,transportCompleted:true,wireEvidence,eofMs,...outcome}
  durableJson(wireEvidence,{requestBody:body,requestHeaders:[...requestHeaders],response:raw,responseHeaders:[...response.headers],parsedEvents:events,done,row},true)
  if (sse!==cell.stream || !outcome.ok || !chatOutcome.ok) throw new Error(`Canary wire failure ${id}: ${JSON.stringify({outcome,chatOutcome})}; ${raw.slice(0,300)}`)
  return row
}

export async function runQualifiedInstance(options: QualifiedInstanceOptions) {
  const { arm, bundle, directory, hooks, window } = options
  if (window && (hooks || !/^[a-zA-Z0-9_-]{1,130}$/.test(window.id) || !Number.isSafeInteger(window.warmup) || window.warmup < 1 || !Number.isSafeInteger(window.timed) || window.timed < 1 || window.warmup + window.timed > 100)) throw new Error("Invalid uninstrumented warm window")
  mkdirSync(directory,{recursive:true})
  const upstream=fixture(arm)
  const source=readFileSync(join(import.meta.dir,"entry.mjs.template"),"utf8")
    .replace("__WORKER__",JSON.stringify(bundle)).replace("__REFERENCE_EXPORTS__",arm==="R"?`export { ExecutionDO, ExecutionOperationEntrypoint } from ${JSON.stringify(bundle)}`:"").replace("__PROBE__",JSON.stringify(join(import.meta.dir,"probe-runtime.ts")))
    .replace("__HOOKS__",String(hooks))
  const entry=join(directory,"entry.ts")
  writeFileSync(entry,source)
  const build=await Bun.build({entrypoints:[entry],outdir:join(directory,"entry"),naming:"entry.mjs",target:"node",external:["cloudflare:*"],sourcemap:"external"})
  if (!build.success) {upstream.stop();throw new Error(build.logs.join("\n"))}
  const name=`reference-stage-${arm}-${hooks?"probe":"control"}`
  let rejected=0
  const mf=new Miniflare({name,modules:[{type:"ESModule",path:join(directory,"entry/entry.mjs")}],modulesRoot:directory,host:"127.0.0.1",port:0,cf:false,compatibilityDate:"2025-06-01",compatibilityFlags:["nodejs_compat","enable_ctx_exports"],...(window?{}:{inspectorPort:0,inspectorHost:"127.0.0.1"}),d1Databases:{DB:`${arm}-${hooks}`},d1Persist:join(directory,"d1"),kvNamespaces:["KV","IMAGE_CACHE"],kvPersist:join(directory,"kv"),r2Buckets:["FILES"],r2Persist:join(directory,"r2"),images:{binding:"IMAGES"},...(arm==="R"?{durableObjects:{EXECUTION_DO:{className:"ExecutionDO",useSQLite:true}}}:{}),outboundService:async (request:InstanceType<typeof import("../../../../../node_modules/miniflare").Request>)=>{
    if (request.url!==`${upstream.base}/v1/chat/completions` || request.method!=="POST") {
      rejected++
      durableJson(join(directory,`rejected-egress-${rejected}.json`),{url:request.url,method:request.method,expectedUrl:`${upstream.base}/v1/chat/completions`},true)
      return new LocalResponse(JSON.stringify({error:{message:"Blocked egress; see rejected-egress receipt"}}),{status:502,headers:{"content-type":"application/json"}})
    }
    const result=await fetch(request.url,{method:"POST",headers:Object.fromEntries(request.headers),body:await request.arrayBuffer(),redirect:"manual",signal:AbortSignal.timeout(10000)})
    return new LocalResponse(result.body as unknown as ConstructorParameters<typeof LocalResponse>[0],{status:result.status,headers:Object.fromEntries(result.headers)})
  }})
  let inspector:Awaited<ReturnType<typeof attach>>|undefined
  try {
    const base=(await deadline("workerd ready",60000,()=>mf.ready)).origin
    const db=await mf.getD1Database("DB")
    await options.initialize(db,upstream.base)
    let clock:unknown=null
    let heapStart:Obj|null=null
    if (!window) {
      const clockResponse=await fetch(base+"/__harness/clock",{headers:{"x-harness-key":"architecture-local-only"},signal:AbortSignal.timeout(10000)})
      if (!clockResponse.ok) throw new Error("Clock qualification HTTP failure")
      clock=await clockResponse.json()
      const timer=object(clock)
      if(typeof timer.start!=="number" || typeof timer.end!=="number" || !Number.isFinite(timer.start) || !Number.isFinite(timer.end) || timer.end<=timer.start) throw new Error("Local synchronous clock did not advance; stage timing is unqualified")
      inspector=await attach(()=>mf.getInspectorURL(),name)
      heapStart=requireHeap(await inspector.send("Runtime.getHeapUsage"))
    }
    const processIdentity=await discoverWorkerd(process.pid)
    durableJson(join(directory,"identity.json"),{arm,hooks,window:window??null,workerBundle:fileIdentity(bundle),entrySource:fileIdentity(entry),entry:fileIdentity(join(directory,"entry/entry.mjs")),inspector:inspector?.identity??null,processIdentity,clock,coverage:coverage(arm)},true)
    const rows:QualifiedRow[]=[]
    const offer=async(cell:Cell,id:string,phase:QualifiedRow["phase"])=>{
      try {
        const row=await request(base,directory,arm,cell,id,phase)
        rows.push(row)
        durableJson(join(directory,`${id}.terminal.json`),{id,arm,cell:cell.id,phase,completed:true,ok:row.ok},true)
      } catch(error) {
        durableJson(join(directory,`${id}.terminal.json`),{id,arm,cell:cell.id,phase,completed:false,ok:false,error:String(error)},true)
        throw error
      }
    }
    const settle=async()=>{
      const response=await fetch(base+"/__harness/settled",{headers:{"x-harness-key":"architecture-local-only"},signal:AbortSignal.timeout(20000)})
      if (!response.ok) throw new Error("Settlement HTTP failure")
      const result=object(await response.json())
      if (result.active!==0 || result.pending!==0 || result.registered!==result.settled || !Array.isArray(result.failures) || result.failures.length || result.observerFailures!==0 || result.unowned!==0) throw new Error("Invalid settlement")
      return result
    }
    let warmupSettlement:Obj|null=null
    if (window) {
      for(let i=0;i<window.warmup;i++) await offer(window.cell,`${window.id}-warmup-${String(i).padStart(3,"0")}`,"warmup")
      warmupSettlement=await settle()
    }
    const processStart=window?await readProcessResource(processIdentity.pid):processIdentity
    diffProcessResource(processIdentity,processStart)
    if (window) {
      for(let i=0;i<window.timed;i++) await offer(window.cell,`${window.id}-timed-${String(i).padStart(3,"0")}`,"timed")
    } else for (const cell of cells.filter(cell=>cell.shape==="string" && cell.dump)) {
      await offer(cell,`${arm}-${hooks?"probe00":"control"}-${cell.id}`,"canary")
    }
    const settlement=await settle()
    const processEnd=await readProcessResource(processStart.pid)
    const resources=diffProcessResource(processStart,processEnd)
    const heapSettled=inspector?requireHeap(await inspector.send("Runtime.getHeapUsage")):null
    let traceResult:Obj={traces:[],unowned:0,observerFailures:0}
    if (!window) {
      const traceResponse=await fetch(base+"/__harness/traces",{headers:{"x-harness-key":"architecture-local-only"},signal:AbortSignal.timeout(10000)})
      if (!traceResponse.ok) throw new Error("Trace HTTP failure")
      traceResult=object(await traceResponse.json())
    }
    durableJson(join(directory,"observations.json"),{rows,dispatches:upstream.dispatches,rejected,window:window??null,warmupSettlement,settlement,traceResult,processStart,processEnd,resources,heapStart,heapSettled,scope:window?"warmed bounded pilot; no Inspector or source hooks; whole-workerd CPU through settlement and RSS endpoints only; excludes export/readback":"cold two-request observer canary; includes harness settlement but excludes trace export/readback; no performance conclusion or peak measurement"},true)
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
    const checked=await deadline("physical dump readback",30000,()=>options.readback(db,bucket,rows,upstream.dispatches))
    if(hooks) {
      const total=(name:string)=>traces.reduce((sum,trace)=>sum+(trace.counts[name]??0),0)
      if(total("sink.files.puts")!==checked.objectCount || total("sink.files.bytes")!==checked.compressedBytes) throw new Error("Sink observer counts disagree with physical readback")
    }
    const readback=checked.evidence
    durableJson(join(directory,"receipt.json"),{completed:true,arm,hooks,readback,resources,qualifiedRequests:rows.length,comparisonCompleted:false},true)
    return upstream.dispatches
  } finally {
    await inspector?.close().catch(()=>{})
    try {await deadline("workerd dispose",15000,()=>mf.dispose())} finally {upstream.stop()}
  }
}
