import { createHash, createDecipheriv, hkdfSync } from "node:crypto"
import { readFileSync } from "node:fs"
import { verifyChat } from "./contracts"

type Obj = Record<string, unknown>
export interface ReferenceLogicalRow {
  arm: "A" | "B" | "R"
  id: string
  dumpRecordId: string | null
  requestSha256: string
  responseSha256: string
  wireBytes: number
  responseBytes: number
  stream: boolean
  status: number
  wireEvents?: readonly unknown[]
  wireDone?: boolean
  wireEvidence?: string | { requestBody: string; response: string; parsedEvents: unknown[]; done: boolean; requestHeaders: [string,string][]; responseHeaders: [string,string][]; row?: unknown }
  dump?: boolean
}
export interface ReferenceDispatch {
  id: string
  bodyBytes: number
  requestSha256: string
  responseBytes: number
  responseSha256?: string
  responsePrefixSha256?: string
  responsePrefixBase64?: string
  requestedStream: boolean
  status?: number
  completed: boolean
  cancelled: boolean
  url?: string
  method?: string
  upstreamId?: string
  requestHeaders?: readonly (readonly [string, string])[]
  responseHeaders?: readonly (readonly [string, string])[]
}
export interface ReferenceObjectEvidence {
  key: string
  size: number
  type?: string
  owner?: unknown
  decodedBase64: string
  decodedBytes: number
  decodedSha256: string
  json?: unknown
}
export interface ReferenceStorageEvidence {
  schema: string
  rows: readonly Obj[]
  files: readonly Obj[]
  objects: readonly ReferenceObjectEvidence[]
  tables: Record<string, readonly Obj[]>
  ownershipIssues: readonly unknown[]
  historyCounts: { responses_snapshots: number; responses_items: number }
  compressedBytes: number
  decodedBytes: number
}
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const check = (condition: unknown, message: string): void => { if (!condition) throw new Error(`Reference oracle: ${message}`) }
const obj = (value: unknown): Obj => { check(value !== null && typeof value === "object" && !Array.isArray(value), "invalid object"); return value as Obj }
const equal = (a: unknown,b: unknown): boolean => {
  if (a === b) return true
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false
  const x = a as Obj, y = b as Obj
  return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k=>Object.hasOwn(y,k) && equal(x[k],y[k]))
}
function headerPairs(value: unknown): [string,string][] {
  check(Array.isArray(value) && value.every(p=>Array.isArray(p) && p.length===2 && p.every(v=>typeof v === "string")),"header pairs")
  const pairs=value as [string,string][]
  check(new Set(pairs.map(([name])=>name.toLowerCase())).size===pairs.length,"duplicate header names")
  return pairs
}
function requiredHeaders(actual: unknown, expected: readonly (readonly [string, string])[]) {
  check(Array.isArray(actual), "capture headers")
  const pairs = actual as unknown[]
  check(pairs.every(p=>Array.isArray(p) && p.length===2 && p.every(v=>typeof v === "string")), "header pairs")
  // The local HTTP bridge may add transport headers absent at fetch capture.
  const transport = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "date"])
  for (const [name,value] of expected) if (!transport.has(name.toLowerCase())) check(pairs.some(p=>{ const pair=p as string[]; return pair[0]?.toLowerCase()===name.toLowerCase() && pair[1]===value }), `required header ${name}`)
}
function body(value: unknown): Buffer {
  const v=obj(value)
  check(typeof v.data === "string" && (v.encoding === "utf8" || v.encoding === "base64"), "raw body encoding")
  const bytes=Buffer.from(v.data as string,v.encoding === "base64" ? "base64" : "utf8")
  if (v.encoding === "base64") check(bytes.toString("base64") === v.data,"raw body base64")
  return bytes
}
function parseWire(raw: string, stream: boolean) {
  if (!stream) return { events: [JSON.parse(raw) as unknown], done: false, donePositions: [] as number[] }
  const events: unknown[] = [], donePositions: number[] = []
  for (const frame of raw.replaceAll("\r\n","\n").split("\n\n")) {
    const data=frame.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n")
    if (data === "[DONE]") donePositions.push(events.length)
    else if (data) events.push(JSON.parse(data))
  }
  return { events, done: donePositions.length > 0, donePositions }
}
function frames(value: unknown) {
  check(Array.isArray(value),"frame log missing")
  const events: unknown[] = [], donePositions: number[] = []
  let last=-1
  for (const v of value as unknown[]) {
    const entry=obj(v), frame=obj(entry.frame)
    check(typeof entry.ts === "number" && Number.isFinite(entry.ts) && entry.ts >= last,"frame timestamps")
    last=entry.ts as number
    if (frame.type === "done") donePositions.push(events.length)
    else { check(frame.type === "event" && Object.hasOwn(frame,"event"),"frame shape"); events.push(frame.event) }
  }
  return {events,done:donePositions.length>0,donePositions}
}
function affinityEnvelope(value: unknown, apiKey:string) {
  check(typeof value === "string","affinity carrier value")
  const framed=Buffer.from(value as string,"base64")
  check(framed.toString("base64")===value && framed.length>=30,"affinity carrier base64")
  const length=framed.readUInt16BE(framed.length-2)
  check(length===framed.length-2 && length>=28,"affinity carrier trailer")
  const encrypted=framed.subarray(0,-2),iv=encrypted.subarray(0,12),ciphertext=encrypted.subarray(12,-16),tag=encrypted.subarray(-16)
  // This harness seed derives an isolated synthetic secret, never a product credential.
  const secret=createHash("sha256").update(`reference-measurement-only:${apiKey}`).digest()
  const key=hkdfSync("sha256",secret,Buffer.from("Floway server secret v1"),Buffer.from("client-carried affinity v1"),32)
  const decipher=createDecipheriv("aes-256-gcm",Buffer.from(key),iv)
  const domain=Buffer.from("openai-chat-completions.reasoning_opaque"),marker=Buffer.alloc(2);marker.writeUInt16BE(domain.length)
  decipher.setAAD(Buffer.concat([marker,domain]));decipher.setAuthTag(tag)
  const data=obj(JSON.parse(Buffer.concat([decipher.update(ciphertext),decipher.final()]).toString("utf8")))
  check(Object.keys(data).length===3 && data.version===2 && Object.hasOwn(data,"affinity") && Object.hasOwn(data,"opaqueBlobCompatibilityIdentity"),"affinity payload fields")
  const affinity=obj(data.affinity),identity=obj(data.opaqueBlobCompatibilityIdentity)
  check(equal(affinity,{upstreamId:"custom:reference-fixture",modelId:"bench-chat-ok"}) && identity.key==="bench-chat-ok" && (identity.upstreamId===undefined || identity.upstreamId==="custom:reference-fixture") && Object.keys(identity).every(k=>["key","upstreamId"].includes(k)),"affinity target identity")
}
/** Native observe() precedes affinity egress; permit only its single pre-stop carrier. */
export function verifyReferenceAffinityFidelity(stored:readonly unknown[],wire:readonly unknown[],apiKey:string, requireCarrier=false) {
  if(equal(stored,wire) && !requireCarrier) return "exact_wire_frames" as const
  check(wire.length===stored.length+1,"affinity insertion count")
  const terminalIndex=stored.findIndex(e=>{const choices=obj(e).choices;return Array.isArray(choices) && choices.length===1 && obj(choices[0]).finish_reason==="stop"})
  check(terminalIndex>=0,"affinity insertion terminal")
  const terminal=obj(stored[terminalIndex]),carrier=obj(wire[terminalIndex])
  const choices=carrier.choices;check(Array.isArray(choices) && choices.length===1,"affinity carrier choice count")
  const choice=obj((choices as unknown[])[0]),delta=obj(choice.delta)
  check(Object.keys(delta).length===1 && Object.hasOwn(delta,"reasoning_opaque"),"affinity carrier delta")
  affinityEnvelope(delta.reasoning_opaque,apiKey)
  const expected={id:terminal.id,object:terminal.object,created:terminal.created,model:terminal.model,choices:[{index:0,delta:{reasoning_opaque:delta.reasoning_opaque},finish_reason:null}]}
  check(equal(carrier,expected) && equal(stored,[...wire.slice(0,terminalIndex),...wire.slice(terminalIndex+1)]),"affinity carrier shape/position or visible frame fidelity")
  return "canonical_pre_affinity_semantics" as const
}
/** Fail closed. R's capture descriptor is a full raw exchange, not B's bounded sidecar. */
export function verifyReferenceReadback(storage: ReferenceStorageEvidence, logicalRows: readonly ReferenceLogicalRow[], dispatches: readonly ReferenceDispatch[]) {
  check(storage.schema === "reference-native-dump-v1" && storage.ownershipIssues.length === 0,"schema or ownership issues")
  check(logicalRows.length > 0 && new Set(logicalRows.map(r=>r.id)).size === logicalRows.length,"offer population")
  check(dispatches.length === logicalRows.length && new Set(dispatches.map(d=>d.id)).size === dispatches.length,"dispatch population")
  check(storage.historyCounts.responses_items === 0 && storage.historyCounts.responses_snapshots === 0 && storage.tables.responses_items?.length === 0 && storage.tables.responses_snapshots?.length === 0,"history disabled")
  const dumpRows=logicalRows.filter(r=>r.dump !== false)
  check(storage.rows.length === dumpRows.length && new Set(storage.rows.map(r=>r.id)).size === storage.rows.length && dumpRows.every(r=>r.dumpRecordId === null),"native record population")
  const associatedRecords=new Set<string>()
  const used=new Set<string>(), records: Obj[]=[]
  const objects=new Map(storage.objects.map(o=>[o.key,o]))
  check(objects.size === storage.objects.length && new Set(storage.files.map(f=>f.file_key)).size === storage.files.length,"duplicate physical object")
  for (const row of logicalRows) {
    check(row.arm === "R" && row.status === 200,"logical arm/status")
    const evidence=obj(typeof row.wireEvidence === "string" ? JSON.parse(readFileSync(row.wireEvidence,"utf8")) : row.wireEvidence)
    check(typeof evidence.requestBody === "string" && typeof evidence.response === "string","independent raw wire evidence")
    const request=Buffer.from(evidence.requestBody as string), response=Buffer.from(evidence.response as string)
    check(sha(request) === row.requestSha256 && request.length === row.wireBytes && sha(response) === row.responseSha256 && response.length === row.responseBytes,"wire digest/bytes")
    const wireRequestHeaders=headerPairs(evidence.requestHeaders), wireResponseHeaders=headerPairs(evidence.responseHeaders)
    const header=(pairs: [string,string][],name:string)=>pairs.find(([key])=>key.toLowerCase()===name)?.[1]
    const authorization=header(wireRequestHeaders,"authorization")
    check(typeof authorization === "string" && /^Bearer \S+$/.test(authorization) && header(wireRequestHeaders,"content-type")?.split(";")[0]?.trim().toLowerCase()==="application/json" && header(wireRequestHeaders,"x-benchmark-id")===row.id,"client request header evidence")
    const responseMedia=row.stream ? "text/event-stream" : "application/json"
    check(header(wireResponseHeaders,"content-type")?.split(";")[0]?.trim().toLowerCase()===responseMedia,"client response header evidence")
    const payload=obj(JSON.parse(request.toString()))
    check(payload.stream === row.stream && payload.model === "bench-chat-ok" && request.toString().includes(`BENCH_ID:${row.id}`),"offered request identity")
    if (evidence.row !== undefined) { const identity=obj(evidence.row); for (const k of ["id","dumpRecordId","requestSha256","responseSha256","wireBytes","responseBytes","stream","status"]) check(identity[k] === (row as unknown as Obj)[k],`wire identity ${k}`) }
    const parsed=parseWire(response.toString(),row.stream)
    check(equal(parsed.events,row.wireEvents) && equal(parsed.events,evidence.parsedEvents) && parsed.done === row.wireDone && parsed.done === evidence.done,"wire parser fidelity")
    check(verifyChat(row.status,parsed.events,parsed.done,row.stream,parsed).ok,"client chat semantics")
    if(row.stream) {
      const carriers=parsed.events.filter(e=>{const choices=obj(e).choices;return Array.isArray(choices) && choices.some(c=>Object.hasOwn(obj(obj(c).delta),"reasoning_opaque"))})
      check(carriers.length===1,"always-on native carrier count")
      verifyReferenceAffinityFidelity(parsed.events.filter(e=>e!==carriers[0]),parsed.events,authorization!.slice(7),true)
    } else {
      const choice=obj((obj(parsed.events[0]).choices as unknown[])[0])
      affinityEnvelope(obj(choice.message).reasoning_opaque,authorization!.slice(7))
    }
    const dispatch=dispatches.find(d=>d.id===row.id)
    check(dispatch && dispatch.completed && !dispatch.cancelled && dispatch.status === 200,"dispatch completion")
    if (row.dump === false) { check(row.dumpRecordId === null,"disabled dump identity"); continue }
    const stored=storage.rows.filter(r=>{
      check(typeof r.request_headers_json === "string","association headers missing")
      return headerPairs(JSON.parse(r.request_headers_json as string)).some(([name,value])=>name.toLowerCase()==="x-benchmark-id" && value===row.id)
    })
    check(stored.length === 1,"unique physical record")
    const sql=stored[0]!, meta=obj(sql.meta), recordId=String(sql.id)
    check(recordId.length>0 && !associatedRecords.has(recordId),"ambiguous native record association")
    associatedRecords.add(recordId)
    check(sql.key_id === "reference-key" && sql.upstream_id === "custom:reference-fixture" && meta.id === recordId && meta.method === "POST" && meta.path === "/v1/chat/completions" && meta.status === row.status && meta.model === "bench-chat-ok" && meta.requestBytes === row.wireBytes && meta.responseBytes === row.responseBytes && meta.inputTokens === 7 && meta.outputTokens === 3 && meta.error === null && meta.targetApi === null,"dump metadata")
    const read=(field:string,type: string | readonly string[],ownerKind:string) => {
      const d=obj(sql[field]); check(typeof d.key === "string" && d.key.startsWith("dumps/v1/reference-key/") && (typeof type === "string" ? d.type===type : type.includes(String(d.type))),`descriptor ${field}`)
      check(!used.has(d.key as string),"shared descriptor"); used.add(d.key as string)
      const physical=objects.get(d.key as string), file=storage.files.find(f=>f.file_key===d.key)
      check(physical && file && physical.type === d.type && file.state === "owned" && file.owner_kind === ownerKind && file.owner_key === JSON.stringify(["reference-key",recordId]),"object ownership")
      check(equal(physical!.owner,{type:d.type,keyId:"reference-key",id:recordId,ownerKind}),"reader owner")
      const bytes=Buffer.from(String(physical!.decodedBase64),"base64")
      check(bytes.toString("base64") === physical!.decodedBase64 && bytes.length === physical!.decodedBytes && sha(bytes) === physical!.decodedSha256,"decoded object identity")
      return {bytes,type:d.type,physical:physical!}
    }
    // Native persistence intentionally omits meta.upstream; SQL and the raw
    // exchange carry the identity. A supplied hydrated identity must agree.
    if (meta.upstream !== undefined) check(obj(meta.upstream).id === sql.upstream_id,"hydrated upstream identity")
    check(typeof sql.request_headers_json === "string" && typeof sql.response_headers_json === "string","SQL headers missing")
    const storedRequestHeaders=headerPairs(JSON.parse(sql.request_headers_json as string)), storedResponseHeaders=headerPairs(JSON.parse(sql.response_headers_json as string))
    requiredHeaders(storedRequestHeaders,wireRequestHeaders.filter(([name])=>["authorization","content-type","x-benchmark-id"].includes(name.toLowerCase())))
    requiredHeaders(storedResponseHeaders,wireResponseHeaders.filter(([name])=>name.toLowerCase()==="content-type"))
    const req=read("request_body_descriptor","bytes","dump-request")
    check(req.bytes.equals(request),"stored request fidelity")
    const resp=read("response_body_descriptor",["bytes","events"],"dump-response")
    let classification="exact_wire_bytes"
    if (resp.type === "bytes") check(resp.bytes.equals(response),"stored response byte fidelity")
    else {
      const canonical=frames(JSON.parse(resp.bytes.toString()))
      check(verifyChat(200,canonical.events,canonical.done,true,canonical).ok,"canonical chat semantics")
      if (row.stream) {
        classification=verifyReferenceAffinityFidelity(canonical.events,parsed.events,authorization!.slice(7),true)
        check(canonical.donePositions.length===1 && canonical.donePositions[0]===canonical.events.length && parsed.donePositions.length===1 && parsed.donePositions[0]===parsed.events.length,"canonical done fidelity")
      }
      else {
        const wire=obj(parsed.events[0]),choice=obj((wire.choices as unknown[])[0]),message=obj(choice.message)
        affinityEnvelope(message.reasoning_opaque,authorization!.slice(7))
        let text="",usage:unknown
        const first=obj(canonical.events[0]),extras:Obj={}
        for(const e of canonical.events) {
          const v=obj(e)
          for(const k of ["id","model","created"]) check(v[k]===first[k],`canonical JSON ${k}`)
          check(Object.keys(v).every(k=>["id","object","model","created","choices","usage"].includes(k)),"fixture canonical chunk extras")
          if(v.usage!=null) usage=v.usage
          for(const c of v.choices as unknown[]) {
            const ch=obj(c),delta=obj(ch.delta)
            check(Object.keys(ch).every(k=>["index","delta","finish_reason"].includes(k)) && Object.keys(delta).every(k=>["role","content"].includes(k)),"fixture canonical choice extras")
            if(typeof delta.content==="string") text+=delta.content
          }
        }
        Object.assign(extras,{id:first.id,object:"chat.completion",created:first.created,model:first.model,choices:[{index:0,message:{role:"assistant",content:text,reasoning_opaque:message.reasoning_opaque},finish_reason:"stop"}],usage})
        check(equal(wire,JSON.parse(JSON.stringify(extras))),"native JSON fold fidelity")
      }
      if(!row.stream) classification="canonical_source_semantics"
    }
    const up=read("response_upstream_body_descriptor","capture","dump-response-upstream")
    const envelope=obj(JSON.parse(up.bytes.toString()))
    check(equal(envelope,up.physical.json) && envelope.version === 1 && envelope.upstream === undefined,"native capture envelope")
    const capture=obj(envelope.capture), rawClient=obj(capture.response)
    check(rawClient.complete === true && rawClient.error === null && body(rawClient.body).equals(response),"raw client capture fidelity")
    check(Array.isArray(capture.exchanges) && capture.exchanges.length === 1,"exchange count")
    const exchange=obj((capture.exchanges as unknown[])[0]), upstreamRequest=obj(exchange.request), upstreamResponse=obj(exchange.response)
    check(exchange.error === null && exchange.upstreamId === "custom:reference-fixture" && upstreamRequest.method === "POST" && typeof upstreamRequest.url === "string" && upstreamRequest.url.endsWith("/v1/chat/completions") && Array.isArray(upstreamRequest.headers) && Array.isArray(upstreamResponse.headers),"exchange metadata")
    const d=dispatch!
    if(d.url!==undefined) check(upstreamRequest.url===d.url,"exchange URL")
    if(d.method!==undefined) check(upstreamRequest.method===d.method,"exchange method")
    if(d.upstreamId!==undefined) check(exchange.upstreamId===d.upstreamId,"exchange upstream")
    if(d.requestHeaders!==undefined) {
      // Fixture sees Miniflare/Bun bridge additions (cf-worker, accept, UA).
      // Verify every captured header independently and both provider-owned headers.
      requiredHeaders(d.requestHeaders,headerPairs(upstreamRequest.headers))
      requiredHeaders(upstreamRequest.headers,d.requestHeaders.filter(([name])=>["authorization","content-type"].includes(name.toLowerCase())))
    }
    if(d.responseHeaders!==undefined) requiredHeaders(upstreamResponse.headers,d.responseHeaders)
    const rawRequest=body(upstreamRequest.body),rawResponse=body(upstreamResponse.body)
    check(rawRequest.length === d.bodyBytes && sha(rawRequest) === d.requestSha256,"full upstream request fidelity")
    const upstreamPayload=obj(JSON.parse(rawRequest.toString()))
    check(upstreamPayload.stream === d.requestedStream && upstreamPayload.model === "bench-chat-ok" && rawRequest.toString().includes(`BENCH_ID:${row.id}`),"upstream dispatch identity")
    const expectedResponseSha=d.responseSha256 ?? (d.responsePrefixBase64 && Buffer.from(d.responsePrefixBase64,"base64").length === d.responseBytes ? d.responsePrefixSha256 : undefined)
    check(expectedResponseSha && rawResponse.length === d.responseBytes && sha(rawResponse) === expectedResponseSha && upstreamResponse.status === d.status && typeof upstreamResponse.complete === "boolean" && upstreamResponse.error === null,"full upstream response fidelity")
    const upstreamParsed=parseWire(rawResponse.toString(),d.requestedStream)
    check(verifyChat(d.status ?? 0,upstreamParsed.events,upstreamParsed.done,d.requestedStream,upstreamParsed).ok,"upstream chat semantics")
    check(upstreamResponse.complete===true || d.requestedStream && upstreamParsed.donePositions.length===1 && upstreamParsed.donePositions[0]===upstreamParsed.events.length,"raw response incomplete without native DONE")
    const upstreamTerminal={captureComplete:upstreamResponse.complete,classification:upstreamResponse.complete?"eof":"full_wire_bytes_done_cancel_before_eof",fixtureCompleted:d.completed,fixtureCancelled:d.cancelled}
    records.push({logicalId:row.id,recordId,upstreamTerminal,correlation:{basis:"sql-benchmark-header-and-full-request-bytes",benchmarkId:row.id,requestSha256:sha(req.bytes),requestBytes:req.bytes.length},classification,requestSha256:sha(req.bytes),responseSha256:sha(response),upstreamRequestSha256:sha(rawRequest),upstreamResponseSha256:sha(rawResponse),passed:true})
  }
  check(used.size === storage.objects.length && storage.files.length === used.size,"extra or missing objects")
  check(storage.compressedBytes === storage.objects.reduce((n,o)=>n+Number(o.size),0) && storage.decodedBytes === storage.objects.reduce((n,o)=>n+Number(o.decodedBytes),0),"physical aggregate bytes")
  const tables=storage.tables, count=logicalRows.length
  const dims=(r:Obj)=>r.key_id === "reference-key" && r.model === "bench-chat-ok" && r.upstream === "custom:reference-fixture" && typeof r.hour === "string"
  const usage=tables.usage ?? []
  const usageIdentity=(r:Obj)=>JSON.stringify([r.key_id,r.model,r.model_key,r.upstream,r.hour,r.pricing_selector,r.metric])
  check(new Set(usage.map(usageIdentity)).size===usage.length,"duplicate usage rows")
  check(usage.length>0 && usage.every(r=>dims(r) && r.model_key === "bench-chat-ok" && r.pricing_selector === "{}" && ["input_tokens","output_tokens"].includes(String(r.metric)) && typeof r.quantity === "string" && /^[0-9]+$/.test(r.quantity)),"usage row dimensions")
  for (const [metric,tokens] of [["input_tokens",7],["output_tokens",3]] as const) check(usage.filter(r=>r.metric===metric).reduce((n,r)=>n+Number(r.quantity),0) === count*tokens,`usage ${metric}`)
  const requests=tables.usage_requests ?? [], performance=tables.performance_summary ?? [], buckets=tables.performance_buckets ?? []
  check(new Set(requests.map(usageIdentity)).size===requests.length,"duplicate usage request rows")
  check(requests.length>0 && requests.every(r=>dims(r) && r.model_key === "bench-chat-ok" && r.pricing_selector === "{}" && Number.isSafeInteger(r.requests) && Number(r.requests)>0) && requests.reduce((n,r)=>n+Number(r.requests),0) === count,"usage request counts")
  check(performance.length>0 && performance.every(r=>dims(r) && r.operation === "chat" && typeof r.runtime_location === "string" && ["requests","ttft_samples_ok","tpot_samples","ttft_ms_sum","tpot_us_sum","neutral","errors_no_output","errors_with_output"].every(k=>Number.isSafeInteger(r[k]) && Number(r[k])>=0) && r.errors_with_output===0 && r.errors_no_output===0 && r.neutral===0 && r.requests===r.ttft_samples_ok && r.requests===r.tpot_samples) && performance.reduce((n,r)=>n+Number(r.requests),0)===count,"performance summary")
  const dimension=(r:Obj)=>JSON.stringify([r.key_id,r.model,r.upstream,r.hour,r.operation,r.runtime_location])
  check(new Set(performance.map(dimension)).size===performance.length,"duplicate performance summary")
  check(new Set(buckets.map(r=>JSON.stringify([dimension(r),r.metric,r.lower]))).size===buckets.length,"duplicate performance buckets")
  check(buckets.every(r=>["ttft_ms","tpot_us"].includes(String(r.metric)) && Number.isSafeInteger(r.count) && Number(r.count)>0 && Number.isSafeInteger(r.lower) && Number(r.lower)>=0 && (r.upper===null || typeof r.upper==="number" && r.upper>Number(r.lower)) && performance.some(p=>dimension(p)===dimension(r))),"performance buckets")
  for(const p of performance) for(const [metric,column] of [["ttft_ms","ttft_samples_ok"],["tpot_us","tpot_samples"]] as const) check(buckets.filter(b=>dimension(b)===dimension(p) && b.metric===metric).reduce((n,b)=>n+Number(b.count),0)===p[column],"performance bucket sample counts")
  return {comparator:"reference-native-readback-v1" as const,passed:true as const,logicalRows:count,checkedRecords:records.length,ownedObjects:used.size,historyDisabled:true as const,records}
}
