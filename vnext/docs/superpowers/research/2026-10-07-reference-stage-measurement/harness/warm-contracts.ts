import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { makeRequest, verifyChat } from "./contracts"
import { balancedOrders, cells, type Arm, type Cell } from "./contracts"
import { diffProcessResource, type ProcessResource, type ProcessResourceDelta } from "./process-resources"
export interface WarmWindowPlan { id:string; block:number; orderPosition:number; arm:Arm; cell:Cell; warmup:5; timed:20 }
export interface WarmPlan { schema:"three-arm-warm-v1"; runId:string; scope:"exploratory-warmed-no-inspector"; windows:WarmWindowPlan[]; expectedWindows:number; expectedWarmup:number; expectedTimed:number; populationSha256:string }
export interface WarmRow { id:string; arm:Arm; phase:string; cell:string; dump:boolean; status:number; ok:boolean; eofMs:number; dumpRecordId:string|null; wireEvidence?:string | WarmWireEvidence; stream?:boolean; requestSha256?:string; responseSha256?:string; wireBytes?:number; responseBytes?:number; wireEvents?:unknown[]; wireDone?:boolean }
export interface WarmDispatch { id:string; status?:number; completed:boolean; cancelled:boolean; requestedStream:boolean }
export interface WarmSettlement { active:number; pending:number; registered:number; settled:number; failures:unknown[]; observerFailures:number; unowned:number }
export interface WarmWindowEvidence {
  id:string; block:number; arm:Arm; cell:string; completed:boolean
  identity:{hooks:boolean;inspector:unknown}
  observations:{ rows:WarmRow[];dispatches:WarmDispatch[];resources:ProcessResourceDelta;processStart:ProcessResource;processEnd:ProcessResource;settlement:WarmSettlement;warmupSettlement:WarmSettlement;scope:string }
  readback:{passed?:boolean;historyDisabled?:boolean;semantic?:{passed:boolean;historyDisabled:boolean;records?:{logicalId:unknown;recordId:unknown;passed:unknown;correlation?:{basis:unknown;benchmarkId:unknown;requestSha256:unknown;requestBytes:unknown}}[]}}
}
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex")
const check=(value:unknown,error:string):void=>{if(!value)throw new Error(error)}
export function requestIdentity(windowId:string,phase:"warmup"|"timed",ordinal:number):string {
  check(/^[A-Za-z0-9_-]{1,130}$/.test(windowId) && Number.isSafeInteger(ordinal) && ordinal>=0 && ordinal<1000,"Invalid warm request identity")
  return `${windowId}-${phase}-${String(ordinal).padStart(3,"0")}`
}
export function freezeWarmPlan(options:{runId:string}):WarmPlan {
  check(/^[A-Za-z0-9_-]{1,64}$/.test(options.runId),"Invalid warm run id")
  const windows:WarmWindowPlan[]=[]
  for(const [block,order] of balancedOrders.entries()) for(const cell of cells) for(const [orderPosition,arm] of order.entries()) windows.push({id:`${options.runId}-b${block}-${cell.id}-${arm}`,block,orderPosition,arm,cell:{...cell},warmup:5,timed:20})
  return {schema:"three-arm-warm-v1",runId:options.runId,scope:"exploratory-warmed-no-inspector",windows,expectedWindows:108,expectedWarmup:540,expectedTimed:2160,populationSha256:hash(windows)}
}
const quantile=(values:number[],p:number):number|null=>values.length ? [...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(p*values.length)-1)]! : null
const ratio=(cpuMs:number,count:number)=>count>0?cpuMs/count:null
export interface WarmBlockAggregate { block:number; windowId:string; qualified:boolean; errors:string[]; offered:number; successes:number; failures:number; cpuMs:number|null; cpuPerOfferedMs:number|null; cpuPerSuccessMs:number|null; medianEofMs:number|null; p95EofMs:number|null; rssStartBytes:number|null; rssEndBytes:number|null }
/** Pure aggregation retains failures and missing windows. Invalid evidence never becomes a smaller balanced run. */
export function aggregateWarmRun(plan:WarmPlan,windows:readonly WarmWindowEvidence[]) {
  const expected=freezeWarmPlan({runId:plan.runId})
  check(hash(plan)===hash(expected),"Frozen warm plan differs from the declared design")
  const errors:string[]=[], rowsByGroup=new Map<string,number[]>(), blocksByGroup=new Map<string,WarmBlockAggregate[]>()
  const population=new Map<string,WarmWindowEvidence[]>()
  for(const w of windows) {const list=population.get(w.id)??[];list.push(w);population.set(w.id,list)}
  for(const id of population.keys()) if(!expected.windows.some(w=>w.id===id)) errors.push(`Unexpected window ${id}`)
  let timedOffered=0,warmupOffered=0,timedSuccesses=0,cpuMs=0,cpuWindows=0
  for(const w of expected.windows) {
    const windowErrors:string[]=[], found=population.get(w.id)??[], evidence=found.length===1?found[0]:undefined
    let offered=0,successes=0,windowCpu:number|null=null,rssStart:number|null=null,rssEnd:number|null=null,latencies:number[]=[]
    const reject=(message:string)=>windowErrors.push(`${w.id}: ${message}`)
    if(!evidence) reject(found.length ? "Duplicate window" : "Missing window")
    else {
      const e=evidence,o=e.observations,timed=o.rows.filter(r=>r.phase==="timed"),warmup=o.rows.filter(r=>r.phase==="warmup")
      offered=timed.length;successes=timed.filter(r=>r.ok && r.status===200).length
      timedOffered+=offered;warmupOffered+=warmup.length;timedSuccesses+=successes
      if(!e.completed || e.id!==w.id || e.arm!==w.arm || e.cell!==w.cell.id || e.block!==w.block) reject("Window identity/completion mismatch")
      if(e.identity.hooks!==false || e.identity.inspector!==null) reject("Control includes observer/Inspector")
      if(!o.scope.includes("warmed") || !o.scope.includes("settlement")) reject("Resource scope does not cover warmed work through settlement")
      const before=o.warmupSettlement
      if(!before || before.active!==0 || before.pending!==0 || before.registered!==before.settled || before.failures.length || before.observerFailures!==0 || before.unowned!==0) reject("Incomplete warmup settlement")
      const s=o.settlement
      if(before && s.registered<before.registered) reject("Settlement counters regressed")
      if(s.active!==0 || s.pending!==0 || s.registered!==s.settled || s.failures.length || s.observerFailures!==0 || s.unowned!==0) reject("Incomplete settlement")
      const receipt=e.readback.semantic??e.readback
      if(receipt.passed!==true || receipt.historyDisabled!==true) reject("Readback contract failed")
      const expectedIds=(["warmup","timed"] as const).flatMap(phase=>Array.from({length:phase==="warmup"?w.warmup:w.timed},(_,i)=>requestIdentity(w.id,phase,i)))
      if(o.rows.length!==expectedIds.length || new Set(o.rows.map(r=>r.id)).size!==expectedIds.length || expectedIds.some(id=>!o.rows.some(r=>r.id===id))) reject("Offer population mismatch")
      for(const r of o.rows) {
        const phase=r.id.startsWith(`${w.id}-warmup-`)?"warmup":r.id.startsWith(`${w.id}-timed-`)?"timed":null
        if(r.arm!==w.arm || r.phase!==phase || r.cell!==w.cell.id || r.dump!==w.cell.dump || r.stream!==w.cell.stream || r.wireBytes!==w.cell.bytes || !r.wireEvidence) reject("Row phase/configuration/identity mismatch")
        if(!Number.isFinite(r.eofMs) || r.eofMs<0) reject("Invalid EOF latency")
        if(!r.ok || r.status!==200) reject(`Unsuccessful offered request ${r.id}`)
        if(w.cell.dump && w.arm!=="R" ? !r.dumpRecordId : r.dumpRecordId!==null) reject("Dump policy mismatch")
      }
      if(w.arm==="R" && w.cell.dump) {
        const native=e.readback.semantic?.records??[]
        if(native.length!==o.rows.length || new Set(native.map(r=>r.logicalId)).size!==o.rows.length || new Set(native.map(r=>r.recordId)).size!==o.rows.length || o.rows.some(row=>!native.some(r=>r.logicalId===row.id && typeof r.recordId==="string" && r.recordId.length>0 && r.passed===true && r.correlation?.basis==="sql-benchmark-header-and-full-request-bytes" && r.correlation.benchmarkId===row.id && r.correlation.requestSha256===row.requestSha256 && r.correlation.requestBytes===row.wireBytes))) reject("Native R readback association mismatch")
      }
      const dumpIds=o.rows.filter(r=>r.dump && r.arm!=="R").map(r=>r.dumpRecordId)
      if(new Set(dumpIds).size!==dumpIds.length) reject("Repeated dump identity")
      if(o.dispatches.length!==o.rows.length || new Set(o.dispatches.map(d=>d.id)).size!==o.rows.length || o.dispatches.some(d=>!o.rows.some(r=>r.id===d.id))) reject("Dispatch population mismatch")
      if(o.dispatches.some(d=>d.status!==200 || !d.completed || d.cancelled || d.requestedStream!==(w.arm==="R" || w.cell.stream))) reject("Native upstream source format/completion mismatch")
      latencies=timed.filter(r=>Number.isFinite(r.eofMs) && r.eofMs>=0).map(r=>r.eofMs)
      try {
        const delta=diffProcessResource(o.processStart,o.processEnd)
        if(Object.entries(delta).some(([key,value])=>value!==(o.resources as unknown as Record<string,unknown>)[key])) reject("Resource delta differs from independent PID samples")
        else {windowCpu=delta.cpuUs/1000;cpuMs+=windowCpu;cpuWindows++;rssStart=o.processStart.rssBytes;rssEnd=o.processEnd.rssBytes}
      } catch(error) {reject(`Invalid process identity/counters: ${String(error)}`)}
    }
    const block:WarmBlockAggregate={block:w.block,windowId:w.id,qualified:windowErrors.length===0,errors:windowErrors,offered,successes,failures:offered-successes,cpuMs:windowCpu,cpuPerOfferedMs:windowCpu===null?null:ratio(windowCpu,offered),cpuPerSuccessMs:windowCpu===null?null:ratio(windowCpu,successes),medianEofMs:quantile(latencies,0.5),p95EofMs:quantile(latencies,0.95),rssStartBytes:rssStart,rssEndBytes:rssEnd}
    const key=`${w.cell.id}/${w.arm}`, blocks=blocksByGroup.get(key)??[];blocks.push(block);blocksByGroup.set(key,blocks)
    const prior=rowsByGroup.get(key)??[];prior.push(...latencies);rowsByGroup.set(key,prior)
    errors.push(...windowErrors)
  }
  const groups=[...blocksByGroup].map(([key,blocks])=>{
    const [cell,arm]=key.split("/"),latencies=rowsByGroup.get(key)??[],groupOffered=blocks.reduce((n,b)=>n+b.offered,0),groupSuccesses=blocks.reduce((n,b)=>n+b.successes,0),validCpu=blocks.every(b=>b.cpuMs!==null),groupCpu=blocks.reduce((n,b)=>n+(b.cpuMs??0),0)
    return {cell:cell!,arm:arm! as Arm,sourceFormat:arm==="R" || cells.find(c=>c.id===cell)!.stream?"sse":"json",comparison:cells.find(c=>c.id===cell)!.stream?"common-format":"complete-behavior-different-source-format",qualified:blocks.every(b=>b.qualified),offered:groupOffered,successes:groupSuccesses,cpuMs:validCpu?groupCpu:null,cpuPerOfferedMs:validCpu?ratio(groupCpu,groupOffered):null,cpuPerSuccessMs:validCpu?ratio(groupCpu,groupSuccesses):null,eof:{n:latencies.length,p50Ms:quantile(latencies,.5),p95Ms:quantile(latencies,.95)},blocks}
  })
  return {schema:"three-arm-warm-aggregate-v1" as const,runId:plan.runId,scope:plan.scope,comparisonQualified:errors.length===0,formalStatisticsCompleted:false as const,quantileMethod:"nearest-rank" as const,latencyInterpretation:"exploratory; warmup excluded; no robust tail claim" as const,cpuInterpretation:"whole workerd process through settlement; all offered work retained" as const,rssMeasurement:"endpoints-only; not a peak" as const,totals:{expectedWindows:plan.expectedWindows,observedWindows:windows.length,warmupOffered,timedOffered,timedSuccesses,cpuMs:cpuWindows===plan.expectedWindows?cpuMs:null,cpuPerOfferedMs:cpuWindows===plan.expectedWindows?ratio(cpuMs,timedOffered):null,cpuPerSuccessMs:cpuWindows===plan.expectedWindows?ratio(cpuMs,timedSuccesses):null},groups,errors}
}

export interface WarmWireEvidence {requestBody:string;response:string;parsedEvents:unknown[];done:boolean;row:Record<string,unknown>}
/** Independent artifact check; callers must run this before accepting aggregate qualification. */
export function verifyWarmWireRows(rows:readonly WarmRow[]) {
  const sha=(s:string)=>createHash("sha256").update(s).digest("hex")
  check(new Set(rows.map(r=>r.id)).size===rows.length,"Repeated raw wire row identity")
  for(const row of rows) {
    check(row.wireEvidence,"Missing raw wire artifact")
    const evidence=(typeof row.wireEvidence==="string" ? JSON.parse(readFileSync(row.wireEvidence,"utf8")) : row.wireEvidence) as WarmWireEvidence
    check(evidence && typeof evidence.requestBody==="string" && typeof evidence.response==="string" && Array.isArray(evidence.parsedEvents) && typeof evidence.done==="boolean","Invalid raw wire evidence")
    check(typeof row.stream==="boolean" && sha(evidence.requestBody)===row.requestSha256 && sha(evidence.response)===row.responseSha256 && Buffer.byteLength(evidence.requestBody)===row.wireBytes && Buffer.byteLength(evidence.response)===row.responseBytes,"Raw wire digest/bytes mismatch")
    const plannedCell=cells.find(cell=>cell.id===row.cell)
    check(plannedCell && row.stream===plannedCell.stream && row.dump===plannedCell.dump && row.wireBytes===plannedCell.bytes,"Raw row differs from frozen cell")
    check(evidence.requestBody===makeRequest(row.id,plannedCell!),"Raw request differs from frozen byte/shape contract")
    const payload=JSON.parse(evidence.requestBody) as Record<string,unknown>
    check(payload.stream===row.stream && payload.model==="bench-chat-ok" && evidence.requestBody.includes(`BENCH_ID:${row.id}`),"Raw offered request identity mismatch")
    for(const key of ["id","arm","phase","cell","dump","status","ok","dumpRecordId","stream","requestSha256","responseSha256","wireBytes","responseBytes"] as const) check(evidence.row?.[key]===row[key],`Wire row identity mismatch ${key}`)
    const events:unknown[]=[],donePositions:number[]=[]
    if(row.stream) for(const frame of evidence.response.replaceAll("\r\n","\n").split("\n\n")) {
      const data=frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n")
      if(data==="[DONE]") donePositions.push(events.length)
      else if(data) events.push(JSON.parse(data))
    }
    else events.push(JSON.parse(evidence.response))
    const done=donePositions.length>0
    check(hash(events)===hash(evidence.parsedEvents) && hash(events)===hash(row.wireEvents) && done===evidence.done && done===row.wireDone,"Independent wire parser mismatch")
    check(verifyChat(row.status,events,done,row.stream === true,{donePositions}).ok,"Independent wire semantic failure")
  }
  return {comparator:"warm-raw-wire-v1" as const,passed:true as const,checkedRows:rows.length}
}
