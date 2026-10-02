import { createServer, type Server } from "node:http"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { once } from "node:events"
import { Miniflare, Response as LocalResponse } from "../../../../../node_modules/miniflare"
import { unstable_splitSqlQuery } from "../../../../../apps/platform-cloudflare/node_modules/wrangler"
import { fixture } from "./upstream-fixture.ts"
import { oracle, semantic } from "./oracle.ts"
import { readDumps } from "./readback.ts"
import { Journal, durableJson } from "./journal.ts"
import { deadline } from "./supervisor.ts"
import { HARNESS, sha, type Manifest } from "./manifest.ts"
import { API_KEY, FIXTURE_SECRET, PROTOCOLS, SCENARIOS, type Variant, type Cell, type Row, type Dispatch } from "./types.ts"
type Obj = Record<string, unknown>
const write = (path: string, value: unknown) => durableJson(path, value, true)
async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 15000) {
  await deadline(label, timeout, async () => { while (!(await predicate())) await Bun.sleep(5) })
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Local fixture did not bind")
  return address.port
}
async function upstreamFixture() {
  const dispatches: Dispatch[] = []
  const server = createServer((request, response) => { void (async () => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    const raw = body.toString()
    const model = String((JSON.parse(raw) as Obj).model ?? "")
    const match = /^bench-(responses|chat|messages)-(\w+)$/.exec(model)
    const dispatch: Dispatch = { id: /BENCH_ID:([a-zA-Z0-9_-]+)/.exec(raw)?.[1] ?? "missing", protocol: match?.[1] ?? "unknown", scenario: match?.[2] ?? "unknown", completed: false, cancelled: false, bodyBytes: body.length, requestPrefixSha256: sha(body.subarray(0, 65_536)), responseBytes: 0, responsePrefixSha256: sha(""), responsePrefixBase64: "", status: 0, requestBase64: body.toString("base64"), bodyCompleted: false }
    dispatches.push(dispatch)
    response.once("finish", () => { dispatch.completed = true })
    response.once("close", () => { if (!response.writableFinished) dispatch.cancelled = true })
    const headers = new Headers()
    for (const [name, value] of Object.entries(request.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(",") : value)
    const result = await fixture(new Request(`http://127.0.0.1${request.url}`, { method: request.method ?? "POST", headers, body }), { FIXTURE_SECRET })
    dispatch.status = result.status
    response.writeHead(result.status, Object.fromEntries(result.headers))
    const responsePrefix: Buffer[] = []
    let prefixBytes = 0
    if (result.body) {
      const reader = result.body.getReader()
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) { dispatch.bodyCompleted = true; break }
          dispatch.responseBytes += part.value.byteLength
          const prefix = Buffer.from(part.value.subarray(0, Math.max(0, 262_144 - prefixBytes)))
          responsePrefix.push(prefix)
          prefixBytes += prefix.byteLength
          if (response.destroyed) { await reader.cancel(); break }
          if (!response.write(part.value)) await once(response, "drain")
        }
      } finally { reader.releaseLock() }
    }
    const prefix = Buffer.concat(responsePrefix)
    dispatch.responsePrefixSha256 = sha(prefix)
    dispatch.responsePrefixBase64 = prefix.toString("base64")
    if (!result.body) dispatch.bodyCompleted = true
    response.end()
  })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })
  const port = await deadline("fixture bind", 5000, () => listen(server))
  return { base: `http://127.0.0.1:${port}`, dispatches, async stop() { server.closeAllConnections(); await deadline("fixture dispose", 5000, () => new Promise<void>(resolveStop => server.close(() => resolveStop()))) } }
}


export class Runtime {
  readonly rows: Row[] = []
  private sequence = 0
  constructor(readonly manifest: Manifest, readonly output: string, readonly journal: Journal, readonly unit: string) {}
  async stage<T>(stage: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
    this.journal.append({ event: "stage_begin", stage, timeoutMs })
    try {
      const result = await deadline(stage, timeoutMs, action)
      this.journal.append({ event: "stage_end", stage })
      return result
    } catch (error) {
      this.journal.append({ event: "stage_error", stage, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  async gateway(variant: Variant, phase: string, upstream: Awaited<ReturnType<typeof upstreamFixture>>) {
  const directory = join(this.output, `${variant}-${phase}`)
  mkdirSync(directory, { mode: 0o700 })
  const entry = join(directory, "entry.mjs")
  const importPath = "./" + relative(directory, this.manifest.variants[variant].bundle).replaceAll("\\", "/")
  writeFileSync(entry, readFileSync(join(HARNESS, "entry.mjs.template"), "utf8").replace("__WORKER__", JSON.stringify(importPath)))
  const egress: { allowed: number; rejected: { origin: string; pathname: string; method: string }[] } = { allowed: 0, rejected: [] }
  const name = `comparison-${this.unit}-${variant}`
  let modulesRoot = dirname(entry)
  while (!this.manifest.variants[variant].bundle.startsWith(modulesRoot + "/")) modulesRoot = dirname(modulesRoot)
  const mf = await this.stage(`${variant}/construction`, 20000, async () => new Miniflare({
    name, modules: true, modulesRoot, scriptPath: entry,
    host: "127.0.0.1", port: 0, cf: false,
    compatibilityDate: this.manifest.runtime.compatibilityDate, compatibilityFlags: this.manifest.runtime.compatibilityFlags,
    ...((phase === "diagnostic" || phase === "canary") ? { inspectorPort: 0, inspectorHost: "127.0.0.1" } : {}),
    d1Databases: { DB: `architecture-${variant}-${phase}` }, d1Persist: join(directory, "d1"),
    kvNamespaces: ["KV", "IMAGE_CACHE"], kvPersist: join(directory, "kv"),
    images: { binding: "IMAGES" }, r2Buckets: ["FILES"], r2Persist: join(directory, "r2"),
    outboundService: async (request: InstanceType<typeof import("../../../../../node_modules/miniflare").Request>) => {
      const url = new URL(request.url)
      if (url.origin !== upstream.base || request.method !== "POST" || !["/v1/responses", "/v1/messages", "/v1/chat/completions"].includes(url.pathname) || url.search) {
        egress.rejected.push({ origin: url.origin, pathname: url.pathname, method: request.method })
        return new LocalResponse("Blocked non-fixture egress", { status: 502 })
      }
      egress.allowed++
      const response = await fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), body: await request.arrayBuffer(), redirect: "manual", signal: AbortSignal.timeout(10_000) })
      return new LocalResponse(response.body as unknown as ConstructorParameters<typeof LocalResponse>[0], { status: response.status, headers: Object.fromEntries(response.headers) })
    },
  }))
  try {
    const base = (await this.stage(`${variant}/ready`, 20000, () => mf.ready)).origin
    const db = await this.stage(`${variant}/D1 binding`, 15000, () => mf.getD1Database("DB"))
    const migrations = this.manifest.variants[variant].migrationRoot
    for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) {
      await this.stage(`${variant}/migration/${name}`, 15000, async () => { for (const sql of unstable_splitSqlQuery(readFileSync(join(migrations, name), "utf8"))) await db.prepare(sql).run() })
    }
    await this.stage(`${variant}/seed`, 15000, async () => {
    const now = "2026-09-30T00:00:00.000Z"
    await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind("architecture-owner", "Fixture", "fixture@example.invalid", now).run()
    await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds,dump_retention_seconds) VALUES(?,?,?,?,?,?,?)").bind("architecture-key", "Fixture", API_KEY, now, "architecture-owner", 0, 0).run()
    for (const protocol of PROTOCOLS) {
      const ordinary = phase !== "matrix"
      const config = JSON.stringify({ name: `Fixture ${protocol}`, baseUrl: `${upstream.base}/v1`, apiKey: FIXTURE_SECRET, authStyle: "bearer", endpoints: ordinary ? ["responses", "chat_completions", "messages"] : [protocol === "chat" ? "chat_completions" : protocol], models: ordinary ? PROTOCOLS.flatMap(value => SCENARIOS.map(scenario => `bench-${value}-${scenario}`)) : SCENARIOS.map(scenario => `bench-${protocol}-${scenario}`) })
      await db.prepare("INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(`custom:architecture-${protocol}`, "architecture-owner", "custom", `Fixture ${protocol}`, config, '[{"id":"direct_fetch"}]', now, now).run()
    }
    })
    const dumpState = { checked: new Set<string>() }
    const settled = async (label: string) => this.stage(`${variant}/settlement/${label}`, 30000, async () => {
      const response = await fetch(`${base}/__harness/settled`, { headers: { "x-harness-key": "architecture-local-only" }, signal: AbortSignal.timeout(15_000) })
      const background = await response.json() as { pending: number; activeFetches: number; registered: number; settled: number; failures: unknown[] }
      if (!response.ok || background.pending || background.activeFetches !== 0 || background.registered !== background.settled || background.failures.length) throw new Error(`Background settlement failed: ${JSON.stringify(background)}`)
      await until(() => upstream.dispatches.every(value => value.completed || value.cancelled), "upstream response completion")
      const tables: Record<string, unknown> = {}
      for (const table of ["dump_records", "spilled_files", "responses_snapshots", "responses_items", "usage", "usage_requests", "performance_metrics", "performance_summary", "latency", "cache_kv"]) {
        tables[table] = await db.prepare(`SELECT COUNT(*) AS rows FROM ${table}`).first()
      }
      tables.usageTotals = (await db.prepare("SELECT dimension,SUM(tokens) AS tokens FROM usage GROUP BY dimension").all()).results
      tables.requestTotal = await db.prepare("SELECT SUM(requests) AS requests FROM usage_requests").first()
      tables.performanceMetrics = (await db.prepare("SELECT metric,SUM(count) AS observations FROM performance_metrics WHERE upper = -1 GROUP BY metric").all()).results
      const bucket = await mf.getR2Bucket("FILES")
      const logical = this.rows.filter(row => row.variant === variant && [phase, `${phase}_warmup`].includes(row.phase))
      const dumpReadback = await readDumps(db, bucket, logical, upstream.dispatches, dumpState, variant)
      const dumpPath = this.journal.path
      if (dumpReadback.newRecords.length) this.journal.append({ event: "dump_readback", variant, label, records: dumpReadback.newRecords })
      const dumps = { checkedRecords: dumpReadback.checkedRecords, sqlRows: dumpReadback.sqlRows, ownedObjects: dumpReadback.ownedObjects, path: relative(this.output, dumpPath), newRecords: dumpReadback.newRecords.length }
      const kv: Record<string, unknown> = {}
      for (const name of ["KV", "IMAGE_CACHE"]) {
        const namespace = await mf.getKVNamespace(name)
        const list = await namespace.list({ limit: 1000 })
        if (!list.list_complete) throw new Error("Incomplete physical KV inventory")
        kv[name] = { count: list.keys.length, complete: list.list_complete, keys: list.keys.map(value => ({ name: value.name, expiration: value.expiration, valueSha256: null as string | null })) }
        const keys = (kv[name] as { keys: { name: string; valueSha256: string | null }[] }).keys
        for (const key of keys) key.valueSha256 = sha(await namespace.get(key.name) ?? "")
      }
      const snapshotCounts = ["responses_snapshots", "responses_items"].map(table => Number((tables[table] as { rows: number }).rows))
      if (snapshotCounts.some(value => value !== 0)) throw new Error("Responses retention zero unexpectedly retained history")
      const capture = { label, background, tables, kv, dumps, r2Objects: dumpReadback.r2Objects, snapshotCounts, egress, upstreamCompleted: upstream.dispatches.filter(value => value.completed).length, upstreamCancelled: upstream.dispatches.filter(value => value.cancelled).length }
      const path = join(directory, `${label}-settlement.json`)
      write(path, capture)
      return { label, path: relative(this.output, path), background, dumps, snapshotCounts, r2Objects: dumpReadback.r2Objects, rejectedEgress: egress.rejected.length }
    })
    return { mf, name, base, directory, egress, settled, stop: () => this.stage(`${variant}/dispose`, 10000, () => mf.dispose()) }
  } catch (error) { await this.stage(`${variant}/failed-start-dispose`, 10000, () => mf.dispose()).catch(() => {}); throw error }
}

  async request(active: Pick<Awaited<ReturnType<Runtime["gateway"]>>, "base" | "directory">, variant: Variant, phase: string, cell: Cell, block = -1): Promise<Row> {
  const id = `${this.manifest.id.replaceAll("-", "")}_${this.unit.replaceAll("-", "_")}_${variant}_${this.sequence++}`
  const content = `BENCH_ID:${id} BENCH_PAYLOAD:${"x".repeat(cell.bytes)}:END_PAYLOAD`
  const common = { model: `bench-${cell.upstream}-${cell.scenario}`, stream: cell.stream, max_tokens: 128 }
  const body = JSON.stringify(cell.protocol === "responses" ? { ...common, input: [{ role: "user", content }] } : { ...common, messages: [{ role: "user", content }], ...(cell.protocol === "chat" && cell.stream ? { stream_options: { include_usage: true } } : {}) })
  const path = cell.protocol === "responses" ? "/v1/responses" : cell.protocol === "messages" ? "/v1/messages" : "/v1/chat/completions"
  this.journal.append({ event: "offered", id, variant, phase, block, ...cell, requestSha256: sha(body) })
  const start = performance.now()
  let status = 0, firstSemanticMs: number | null = null, terminalMs: number | null = null, responseBytes = 0, raw = "", transportCompleted = false, dumpRecordId: string | null = null
  const events: unknown[] = []
  let done = false
  try {
    await deadline("request EOF", 15000, async () => {
    const response = await fetch(active.base + path, { method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body, signal: AbortSignal.timeout(15_000) })
    status = response.status
    dumpRecordId = response.headers.get("x-dump-record-id")
    const sse = response.headers.get("content-type")?.includes("text/event-stream") ?? false
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Empty response body")
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        responseBytes += part.value.byteLength
        const decoded = decoder.decode(part.value, { stream: true })
        raw += decoded
        buffer += decoded.replaceAll("\r\n", "\n")
        if (sse) {
          let end: number
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")
            if (data === "[DONE]") { done = true; terminalMs = performance.now() - start; continue }
            if (!data) continue
            const event = JSON.parse(data) as Obj
            events.push(event)
            if (firstSemanticMs === null && semantic(event)) firstSemanticMs = performance.now() - start
            if (["response.completed", "response.failed", "response.incomplete", "message_stop", "error"].includes(String(event.type))) terminalMs = performance.now() - start
          }
        }
      }
      const tail = decoder.decode()
      raw += tail
      buffer += tail
      if (sse && buffer.trim()) throw new Error("Incomplete trailing SSE frame")
      if (!sse) { events.push(JSON.parse(raw)); terminalMs = performance.now() - start; if (status < 400) firstSemanticMs = terminalMs }
      transportCompleted = true
    } finally { if (!transportCompleted) await deadline("request cancellation", 1000, () => reader.cancel()).catch(() => {}); reader.releaseLock() }
    })
    const result = oracle(status, events, done, { ...cell, variant })
    const row: Row = { event: "terminal", wireEvents: events, wireDone: done, variant, phase, block, ...cell, id, status, eofMs: performance.now() - start, firstSemanticMs, terminalMs, responseBytes, wireBytes: Buffer.byteLength(body), requestSha256: sha(body), dumpRecordId, responseSha256: sha(raw), transportCompleted, ...result }
    if (!row.ok && phase === "matrix") write(join(active.directory, `${id}-mismatch.json`), { row, response: raw })
    write(join(active.directory, `${id}-wire.json`), { requestBody: body, response: raw, parsedEvents: events, done, row })
    this.journal.append({ ...row, wireEvidence: join(active.directory, `${id}-wire.json`) })
    this.rows.push(row)
    return row
  } catch (error) {
    const row: Row = { event: "terminal", wireEvents: events, wireDone: done, variant, phase, block, ...cell, id, status, eofMs: performance.now() - start, firstSemanticMs, terminalMs, responseBytes, wireBytes: Buffer.byteLength(body), requestSha256: sha(body), dumpRecordId, responseSha256: sha(raw), transportCompleted, ok: false, errors: [error instanceof Error ? `${error.name}: ${error.message}` : String(error)], classification: "transport_or_parse_failure" }
    write(join(active.directory, `${id}-wire.json`), { requestBody: body, response: raw, parsedEvents: events, done, row })
    this.journal.append({ ...row, wireEvidence: join(active.directory, `${id}-wire.json`) })
    this.rows.push(row)
    return row
  }
}

}
export { upstreamFixture }
