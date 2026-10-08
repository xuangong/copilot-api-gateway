import { createServer, request as httpRequest } from "node:http"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileIdentity, sha, verifyExecution, verifyFiles, type Manifest } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import { durableJson } from "../../2026-10-02-workerd-deployed-comparison/harness/journal"
import { deadline } from "../../2026-10-02-workerd-deployed-comparison/harness/supervisor"
import { seedReference, type ReferenceInput } from "../../2026-10-07-reference-stage-measurement/harness/reference-adapter"
import { finalResponses, frame, generationEvents, items, makeInput, object, pathFor, protocols, terminal, verifyCancellation, verifyFailure, verifyReplay, verifySuccess, type Obj, type Protocol, type SuccessKind, type Verdict, type WireInput } from "./correctness-contracts"

type Arm = "B" | "R"
type TestDatabase = Awaited<ReturnType<import("../../../../../node_modules/miniflare").Miniflare["getD1Database"]>>
type Scenario = SuccessKind | "other" | "fallback-json" | "fallback-untyped" | "fallback-plain" | "pre-failure" | "mid-failure" | "truncated" | "runaway" | "cancel"
interface ReferenceBuild { bundle: string; migrationRoot: string; inputs: ReferenceInput[] }
export interface CorrectnessContext { manifest: Manifest; referenceRoot: string; reference: ReferenceBuild }
export interface FixtureDispatch {
  id: string; source: string; protocol: Protocol; scenario: Scenario; requestBody: string; request: Obj
  requestHeaders: string[]; responseHeaders: Record<string, string>; status: number; requestedStream: boolean
  sentFrames: string[]; completed: boolean; upstreamClosed: boolean; normalCompletionSent: boolean; gateReleased: boolean
}
export const API_KEY = "matched-sse-correctness-local-key"
const SECRET = "matched-sse-correctness-fixture-secret"
const previousHarness = resolve(import.meta.dir, "../../2026-10-07-reference-stage-measurement/harness")
const scenarios: Scenario[] = ["text", "tool", "opaque", "fallback-json", "fallback-untyped", "fallback-plain", "pre-failure", "mid-failure", "truncated", "runaway", "cancel"]
const modelFor = (protocol: Protocol, scenario: Scenario) => `canary-${protocol}-${scenario}`
const delay = (ms: number) => new Promise<void>(done => setTimeout(done, ms))
const verdict = (errors: string[]): Verdict => ({ ok: errors.length === 0, errors })

export function loadContext(path: string): CorrectnessContext {
  const input = object(JSON.parse(readFileSync(path, "utf8")))
  const manifest = typeof input.manifest === "string" ? object(JSON.parse(readFileSync(input.manifest, "utf8"))) : object(input.manifest)
  const reference = object(input.reference), candidate = object(object(manifest.variants).B)
  if (candidate.head !== "963305f85654ff9b4fac28132739ec7ec9902e9a" || typeof candidate.bundle !== "string" || typeof candidate.migrationRoot !== "string" || !Array.isArray(candidate.files)) throw new Error("Correctness context requires the frozen B 963305f8 input")
  if (typeof input.referenceRoot !== "string" || typeof reference.bundle !== "string" || typeof reference.migrationRoot !== "string" || !Array.isArray(reference.inputs)) throw new Error("Correctness context requires referenceRoot and the frozen reference build receipt")
  return { manifest: manifest as unknown as Manifest, referenceRoot: input.referenceRoot, reference: reference as unknown as ReferenceBuild }
}

async function createHttpFixture() {
  const dispatches: FixtureDispatch[] = [], rejected: Obj[] = []
  const gates = new Map<string, () => void>()
  const sockets = new Set<import("node:net").Socket>()
  const server = createServer((request, response) => {
    void (async () => {
      const rawChunks: Buffer[] = []
      for await (const chunk of request) rawChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      const requestBody = Buffer.concat(rawChunks).toString("utf8"), body = object(JSON.parse(requestBody))
      const match = /^\/((?:primary|secondary))\/v1\/(chat\/completions|responses|messages)$/.exec(request.url ?? "")
      const model = /^canary-(chat|responses|messages)-(.+)$/.exec(String(body.model))
      const id = /CANARY_ID:([a-zA-Z0-9_-]+)/.exec(requestBody)?.[1]
      if (request.method !== "POST" || request.headers.authorization !== `Bearer ${SECRET}` || !match || !model || !id) {
        rejected.push({ method: request.method, path: request.url, model: body.model, id })
        response.writeHead(422, { "content-type": "application/json" }); response.end('{"error":{"message":"Unexpected correctness fixture request"}}'); return
      }
      const protocol = model[1] as Protocol, scenario = model[2] as Scenario
      const expectedPath = pathFor(protocol).replace("/v1/", "")
      if (match[2] !== expectedPath || ![...scenarios, "other"].includes(scenario)) throw new Error("Fixture protocol/scenario mismatch")
      const current: FixtureDispatch = { id, source: match[1] ?? "", protocol, scenario, requestBody, request: body, requestHeaders: request.rawHeaders, responseHeaders: {}, status: 200, requestedStream: body.stream === true, sentFrames: [], completed: false, upstreamClosed: false, normalCompletionSent: false, gateReleased: false }
      dispatches.push(current)
      response.on("close", () => { if (!response.writableEnded) current.upstreamClosed = true })
      const send = (value: string) => { if (response.destroyed) return; current.sentFrames.push(value); response.write(value) }
      const end = (normal: boolean) => { if (response.destroyed) return; current.completed = true; current.normalCompletionSent = normal; response.end() }
      const header = (status: number, contentType?: string) => {
        current.status = status
        current.responseHeaders = contentType ? { "content-type": contentType } : {}
        response.writeHead(status, current.responseHeaders)
      }
      if (scenario === "pre-failure") { header(503, "application/json"); send('{"error":{"type":"fixture_failure","message":"Synthetic pre-response failure"}}'); end(false); return }
      const kind: SuccessKind = scenario === "tool" || scenario.startsWith("fallback-") ? "tool" : scenario === "opaque" ? "opaque" : "text"
      if (scenario.startsWith("fallback-") || body.stream !== true) {
        header(200, scenario === "fallback-untyped" ? undefined : scenario === "fallback-plain" ? "text/plain" : "application/json")
        send(JSON.stringify(terminal(protocol, kind, String(body.model)))); end(true); return
      }
      header(200, "text/event-stream")
      let events = generationEvents(protocol, kind, String(body.model))
      if (protocol === "chat" && object(body.stream_options).include_usage !== true) events = events.filter(event => typeof event === "string" || event.usage === undefined)
      if (["mid-failure", "truncated", "cancel"].includes(scenario)) events = events.slice(0, protocol === "responses" ? 4 : 1)
      if (scenario === "runaway") {
        events = protocol === "chat" ? [{ id: "chat_runaway", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_runaway", type: "function", function: { name: "weather", arguments: "{" } }] }, finish_reason: null }] }, ...Array.from({ length: 4 }, () => ({ id: "chat_runaway", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "\n\t\r".repeat(4) } }] }, finish_reason: null }] }))] : [{ type: "response.created", response: { id: "resp_runaway", object: "response", model: body.model, status: "in_progress", output: [] } }, { type: "response.output_item.added", output_index: 0, item: { id: "fc_runaway", type: "function_call", call_id: "call_runaway", name: "weather", arguments: "", status: "in_progress" } }, ...Array.from({ length: 4 }, () => ({ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_runaway", delta: "\n\t\r".repeat(4) }))]
      }
      for (const event of events) { await delay(4); if (response.destroyed) return; send(frame(event)) }
      if (scenario === "cancel" || scenario === "runaway") {
        gates.set(id, () => { current.gateReleased = true; for (const event of generationEvents(protocol, kind, String(body.model))) send(frame(event)); end(true) })
        return
      }
      if (scenario === "mid-failure") send(frame({ type: "response.failed", response: { id: "resp_fixture", object: "response", status: "failed", output: [], error: { code: "fixture_failure", message: "Synthetic mid-stream failure" } } }))
      end(!["mid-failure", "truncated"].includes(scenario))
    })().catch(error => { rejected.push({ error: String(error) }); if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: String(error) } })) })
  })
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)) })
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done) })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture did not bind TCP")
  return {
    base: `http://127.0.0.1:${address.port}`, dispatches, rejected,
    release(id: string) { gates.get(id)?.(); gates.delete(id) },
    async stop() { for (const release of gates.values()) release(); for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())) },
  }
}

// Running node:http inside Bun did not expose response-close reliably in the
// cancellation qualification. The actual upstream therefore runs in Node.
export async function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "matched-sse-correctness-fixture-"))
  const build = await Bun.build({ entrypoints: [join(import.meta.dir, "correctness-contracts.ts")], outdir: directory, naming: "contracts.mjs", target: "node" })
  if (!build.success) { rmSync(directory, { recursive: true, force: true }); throw new Error(build.logs.join("\n")) }
  const entry = join(directory, "fixture.mjs")
  writeFileSync(entry, `import { createServer } from "node:http"\nimport { createInterface } from "node:readline"\nimport { object, pathFor, terminal, generationEvents, frame } from "./contracts.mjs"\nconst SECRET=${JSON.stringify(SECRET)}\nconst scenarios=${JSON.stringify(scenarios)}\nconst delay=ms=>new Promise(done=>setTimeout(done,ms))\nconst createHttpFixture=${createHttpFixture.toString()}\nconst fixture=await createHttpFixture()\nprocess.stdout.write(JSON.stringify({ready:fixture.base})+"\\n")\ncreateInterface({input:process.stdin}).on("line",async line=>{try{const command=JSON.parse(line);if(command.kind==="release")fixture.release(command.target);if(command.kind==="stop")await fixture.stop();process.stdout.write(JSON.stringify({id:command.id,dispatches:fixture.dispatches,rejected:fixture.rejected})+"\\n");if(command.kind==="stop")process.exit(0)}catch(error){process.stderr.write(String(error)+"\\n");process.exit(1)}})\n`)
  const node = Bun.which("node")
  if (!node) { rmSync(directory, { recursive: true, force: true }); throw new Error("Native Node executable is required for fixture cancellation evidence") }
  const child = spawn(node, [entry], { stdio: ["pipe", "pipe", "pipe"] })
  const dispatches: FixtureDispatch[] = [], rejected: Obj[] = []
  const pending = new Map<number, { resolve(): void; reject(error: Error): void }>()
  let nextId = 0, stdout = "", stderr = ""
  const ready = Promise.withResolvers<string>()
  child.stderr.on("data", chunk => { stderr += String(chunk) })
  child.on("error", error => { ready.reject(error); for (const entry of pending.values()) entry.reject(error) })
  child.on("exit", code => { if (code !== 0) { const error = new Error(`Native fixture exited ${code}: ${stderr}`); ready.reject(error); for (const entry of pending.values()) entry.reject(error) } })
  child.stdout.on("data", chunk => {
    stdout += String(chunk)
    while (stdout.includes("\n")) {
      const end = stdout.indexOf("\n"), line = stdout.slice(0, end)
      stdout = stdout.slice(end + 1)
      try {
        const message = object(JSON.parse(line))
        if (typeof message.ready === "string") ready.resolve(message.ready)
        if (Array.isArray(message.dispatches) && Array.isArray(message.rejected)) {
          dispatches.splice(0, dispatches.length, ...message.dispatches as FixtureDispatch[])
          rejected.splice(0, rejected.length, ...message.rejected as Obj[])
          const id = Number(message.id)
          pending.get(id)?.resolve(); pending.delete(id)
        }
      } catch (error) { ready.reject(error) }
    }
  })
  const command = (kind: "state" | "release" | "stop", target?: string) => {
    const id = ++nextId
    const reply = new Promise<void>((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(JSON.stringify({ id, kind, target }) + "\n")
    return deadline("native fixture state", 5000, () => reply)
  }
  try {
    const base = await deadline("native fixture ready", 10000, () => ready.promise)
    return { base, dispatches, rejected, identity: { node: fileIdentity(node), entry: fileIdentity(entry), contracts: fileIdentity(join(directory, "contracts.mjs")) }, refresh: () => command("state"), release: (id: string) => command("release", id), async stop() { try { await command("stop") } finally { child.kill("SIGTERM"); rmSync(directory, { recursive: true, force: true }) } } }
  } catch (error) { child.kill("SIGTERM"); rmSync(directory, { recursive: true, force: true }); throw error }
}

async function seed(db: TestDatabase, arm: Arm, context: CorrectnessContext, base: string) {
  const now = "2026-10-08T00:00:00.000Z"
  if (arm === "R") {
    const result = await seedReference(db, { referenceRoot: context.referenceRoot, baseUrl: base, apiKey: API_KEY, fixtureSecret: SECRET, dump: false, model: "unused-seed-model" })
    for (const input of result.hostInputs) if (!context.reference.inputs.some(frozen => frozen.path === input.path && frozen.sha256 === input.sha256)) throw new Error(`Reference seed input was not frozen: ${input.path}`)
    await db.prepare("DELETE FROM upstreams WHERE id = 'custom:reference-fixture'").run()
  } else {
    await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind("correctness-owner", "Fixture", "fixture@example.invalid", now).run()
    await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds,dump_retention_seconds) VALUES(?,?,?,?,?,?,?)").bind("correctness-key", "Fixture", API_KEY, now, "correctness-owner", 0, 0).run()
  }
  for (const source of ["primary", "secondary"]) for (const protocol of protocols) {
    if (source === "secondary" && protocol !== "responses") continue
    const names = source === "primary" ? scenarios.filter(scenario => scenario !== "opaque" || protocol === "responses").map(scenario => modelFor(protocol, scenario)) : [modelFor(protocol, "other")]
    const id = `up_correctness_${source}_${protocol}`
    if (arm === "B") {
      const config = { name: id, baseUrl: `${base}/${source}/v1`, apiKey: SECRET, authStyle: "bearer", endpoints: [protocol === "chat" ? "chat_completions" : protocol], models: names }
      await db.prepare("INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(id, "correctness-owner", "custom", id, JSON.stringify(config), '[{"id":"direct_fetch"}]', now, now).run()
    } else {
      const endpoints = { [protocol === "chat" ? "openaiChatCompletions" : protocol === "responses" ? "openaiResponses" : "anthropicMessages"]: {} }
      const config = { baseUrl: `${base}/${source}`, authStyle: "bearer", apiKey: SECRET, ingressHeadersRules: [], modelsFetch: { enabled: false }, endpoints, models: names.map(model => ({ kind: "chat", upstreamModelId: model, publicModelId: model, endpoints })) }
      const helperPaths = ["packages/provider-custom/src/provider.ts", "packages/gateway/src/repo/upstream-codecs.ts", "packages/gateway/src/repo/models-cache-contract.ts"].map(path => join(context.referenceRoot, path))
      const [provider, codecs, catalog] = await Promise.all(helperPaths.map(path => import(path)))
      const record = { id, kind: "custom", name: id, enabled: true, sortOrder: 0, createdAt: now, updatedAt: now, config, state: null, modelsCache: null, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], modelPrefix: null, hue: 93 }
      const models = provider?.projectCustomModels(record)
      const cache = codecs?.encodeUpstreamModelsCache({ revision: catalog?.MODEL_CATALOG_REVISION, fetchedAt: Date.now(), models, lastError: null })
      if (typeof cache !== "string") throw new Error("Reference fixture cache serialization failed")
      await db.prepare("INSERT INTO upstreams(id,provider,name,enabled,sort_order,config_version,config_json,state_json,proxy_fallback_list_json,flag_overrides,disabled_public_model_ids,model_prefix_json,models_cache_json,hue,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id, "custom", id, 1, 0, 1, JSON.stringify(config), null, '[{"id":"direct_fetch"}]', "{}", "[]", null, cache, 93, now, now).run()
    }
  }
}

interface CaseRow extends WireInput { id: string; arm: Arm; scenario: string; verdict: Verdict; requestBody: string; responseHeaders: [string, string][]; dispatches: FixtureDispatch[]; transportError?: string; capabilityDifference?: string }

export const expectedCases = (() => {
  const cases: { id: string; common: boolean }[] = []
  const add = (arm: Arm, protocol: Protocol, scenario: string, stream: boolean, common = false) => cases.push({ id: `${arm}-${protocol}-${scenario}-${stream ? "sse" : "json"}`, common })
  for (const arm of ["B", "R"] as const) {
    for (const protocol of protocols) for (const kind of ["text", "tool"]) for (const stream of [false, true]) add(arm, protocol, kind, stream, true)
    for (const stream of [false, true]) {
      for (const scenario of ["opaque", "opaque-replay", "required-source-mismatch"]) add(arm, "responses", scenario, stream, true)
      add(arm, "responses", "blobless-program-source", stream)
    }
  }
  for (const protocol of protocols) for (const stream of [false, true]) add("B", protocol, "fallback-json", stream)
  for (const scenario of ["fallback-untyped", "fallback-plain"]) for (const stream of [false, true]) add("B", "chat", scenario, stream)
  for (const scenario of ["pre-failure", "mid-failure", "truncated"]) for (const stream of [false, true]) add("B", "responses", scenario, stream)
  for (const protocol of ["chat", "responses"] as const) for (const stream of [false, true]) add("B", protocol, "runaway", stream)
  add("B", "responses", "cancel", true)
  return cases
})()

export function summarizeCorrectness(rows: { id: string; verdict: Verdict; capabilityDifference?: string }[]) {
  const actual = new Map(rows.map(row => [row.id, row]))
  const expected = new Set(expectedCases.map(row => row.id))
  const missing = expectedCases.filter(row => !actual.has(row.id)).map(row => row.id)
  const unexpected = rows.filter(row => !expected.has(row.id)).map(row => row.id)
  const duplicate = rows.filter((row, index) => rows.findIndex(other => other.id === row.id) !== index).map(row => row.id)
  const failed = rows.filter(row => !row.verdict.ok).map(row => ({ id: row.id, errors: row.verdict.errors }))
  const populationComplete = !missing.length && !unexpected.length && !duplicate.length
  const common = expectedCases.filter(row => row.common)
  const knownGap = (id: string) => ["B-chat-fallback-untyped-sse", "B-chat-fallback-plain-sse"].includes(id) ? "Chat SSE JSON fallback without standard JSON MIME fails; this boundary predates stream adoption" : id === "B-responses-cancel-sse" ? "No upstream TCP closure observed in the pre-cleanup window; final gateway cancellation metrics are recorded separately" : undefined
  return {
    completed: true, qualified: populationComplete && failed.length === 0,
    commonWorkloadQualified: !unexpected.length && !duplicate.length && common.every(row => actual.get(row.id)?.verdict.ok === true),
    performanceComparison: false, expected: expectedCases.length, expectedCommon: common.length,
    populationComplete, missing, unexpected, duplicate, total: rows.length, passed: rows.length - failed.length, failed,
    knownGaps: failed.filter(row => knownGap(row.id)).map(row => ({ ...row, gap: knownGap(row.id) })),
    otherFailures: failed.filter(row => !knownGap(row.id)),
    capabilities: rows.filter(row => row.capabilityDifference).map(row => ({ id: row.id, ok: row.verdict.ok, behavior: row.capabilityDifference })),
  }
}

async function capture(base: string, protocol: Protocol, input: Obj, id: string, cancel: boolean) {
  if (!cancel) {
    const response = await fetch(base + pathFor(protocol), { method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", "x-benchmark-id": id }, body: JSON.stringify(input), signal: AbortSignal.timeout(8000) })
    let raw = "", transportError: string | undefined
    if (response.body) {
      try { const decoder = new TextDecoder(), reader = response.body.getReader(); for (;;) { const chunk = await reader.read(); if (chunk.done) break; raw += decoder.decode(chunk.value, { stream: true }) }; raw += decoder.decode() } catch (error) { transportError = String(error) }
    }
    return { status: response.status, raw, responseHeaders: [...response.headers] as [string, string][], contentType: response.headers.get("content-type"), semanticSeen: false, clientCancelled: false, transportError }
  }
  return new Promise<{ status: number; raw: string; responseHeaders: [string, string][]; contentType: string | null; semanticSeen: boolean; clientCancelled: boolean; transportError?: string }>((done, reject) => {
    const request = httpRequest(base + pathFor(protocol), { method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json", "x-benchmark-id": id }, timeout: 8000 }, response => {
      let raw = "", finished = false
      const responseHeaders = Object.entries(response.headers).flatMap(([key, value]) => value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value] as [string, string]])
      response.setEncoding("utf8")
      const complete = (cancelled: boolean) => { if (finished) return; finished = true; done({ status: response.statusCode ?? 0, raw, responseHeaders, contentType: response.headers["content-type"] ?? null, semanticSeen: raw.includes("Weather "), clientCancelled: cancelled }) }
      response.on("data", (chunk: string) => { raw += chunk; if (raw.includes("Weather ")) { complete(true); response.destroy(); request.destroy() } })
      response.on("end", () => complete(false))
      response.on("error", error => { if (!finished) reject(error) })
    })
    request.on("timeout", () => request.destroy(new Error("Cancellation canary timed out before semantic output")))
    request.on("error", reject)
    request.end(JSON.stringify(input))
  })
}

async function runArm(context: CorrectnessContext, arm: Arm, directory: string): Promise<CaseRow[]> {
  const { Miniflare } = await import("../../../../../node_modules/miniflare")
  const { unstable_splitSqlQuery } = await import("../../../../../apps/platform-cloudflare/node_modules/wrangler")
  mkdirSync(directory, { recursive: true })
  const fixture = await createFixture(), rows: CaseRow[] = []
  let mf: InstanceType<typeof Miniflare> | undefined
  try {
    const candidate = context.manifest.variants.B, build = arm === "B" ? candidate : context.reference
    const bundle = build.bundle
    const source = readFileSync(join(previousHarness, "entry.mjs.template"), "utf8").replace("__WORKER__", JSON.stringify(bundle)).replace("__REFERENCE_EXPORTS__", arm === "R" ? `export { ExecutionDO, ExecutionOperationEntrypoint } from ${JSON.stringify(bundle)}` : "").replace("__PROBE__", JSON.stringify(join(previousHarness, "probe-runtime.ts"))).replace("__HOOKS__", "false")
    const entry = join(directory, "entry.ts")
    writeFileSync(entry, source, { flag: "wx" })
    const compiled = await Bun.build({ entrypoints: [entry], outdir: join(directory, "entry"), naming: "entry.mjs", target: "node", external: ["cloudflare:*"], sourcemap: "external" })
    if (!compiled.success) throw new Error(compiled.logs.join("\n"))
    mf = new Miniflare({ name: `matched-sse-correctness-${arm}`, modules: [{ type: "ESModule", path: join(directory, "entry/entry.mjs") }], modulesRoot: directory, host: "127.0.0.1", port: 0, cf: false, compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"], d1Databases: { DB: `correctness-${arm}` }, d1Persist: join(directory, "d1"), kvNamespaces: ["KV", "IMAGE_CACHE"], kvPersist: join(directory, "kv"), r2Buckets: ["FILES"], r2Persist: join(directory, "r2"), images: { binding: "IMAGES" }, ...(arm === "R" ? { durableObjects: { EXECUTION_DO: { className: "ExecutionDO", useSQLite: true } } } : {}) })
    const base = (await deadline("correctness workerd ready", 60000, () => mf?.ready ?? Promise.reject(new Error("Missing runtime")))).origin
    const db = await mf.getD1Database("DB")
    const frozen = arm === "B" ? candidate.files : context.reference.inputs
    const migrations = frozen.filter(input => input.path.startsWith(build.migrationRoot + "/") && input.path.endsWith(".sql")).sort((a, b) => a.path.localeCompare(b.path))
    if (!migrations.length) throw new Error("No frozen migrations")
    for (const migration of migrations) {
      const bytes = readFileSync(migration.path)
      if (sha(bytes) !== migration.sha256) throw new Error(`Migration drift: ${migration.path}`)
      for (const sql of unstable_splitSqlQuery(bytes.toString("utf8"))) await db.prepare(sql).run()
    }
    await seed(db, arm, context, fixture.base)
    durableJson(join(directory, "identity.json"), { arm, workerBundle: fileIdentity(bundle), entrySource: fileIdentity(entry), entry: fileIdentity(join(directory, "entry/entry.mjs")), fixture: fixture.identity, migrations, runtime: context.manifest.runtime, compatibilityFlags: ["nodejs_compat", "enable_ctx_exports"], transport: "Native workerd fetch to native Node HTTP TCP fixture; no outboundService body/signal bridge", scope: "Correctness only; no performance measurements, source hooks, or Inspector" }, true)
    const offer = async (protocol: Protocol, scenario: Scenario, stream: boolean, options: { body?: Obj; label?: string; expect?: "reject" | "capability-allow"; expectedSource?: string } = {}) => {
      const id = `${arm}-${protocol}-${options.label ?? scenario}-${stream ? "sse" : "json"}`
      const kind: SuccessKind = scenario === "tool" || scenario.startsWith("fallback-") ? "tool" : scenario === "opaque" ? "opaque" : "text"
      const input = makeInput(protocol, modelFor(protocol, scenario), stream, id, kind)
      Object.assign(input, options.body)
      // Keep correlation in ordinary user input, never in provider-specific fields.
      if (options.body?.input) input.input = [...items(options.body.input), { role: "user", content: `CANARY_ID:${id} Continue` }]
      const before = fixture.dispatches.length
      let row: CaseRow
      try {
        const response = await capture(base, protocol, input, id, scenario === "cancel")
        const wire: WireInput = { ...response, protocol, stream }
        await fixture.refresh()
        if (scenario === "cancel" || scenario === "runaway") {
          const until = Date.now() + 2500
          while (Date.now() < until && !fixture.dispatches.slice(before).some(dispatch => dispatch.upstreamClosed)) { await delay(10); await fixture.refresh() }
        }
        const dispatches = fixture.dispatches.slice(before).map(dispatch => structuredClone(dispatch))
        let checked: Verdict
        if (options.expect === "reject") {
          const nativeStatus = arm === "B" ? response.status === 503 && response.raw.includes("No authorized compatible route for opaque state") : response.status === 400
          checked = verdict([...(nativeStatus ? [] : ["required source mismatch differs from native rejection contract"]), ...(dispatches.length ? ["required source mismatch dispatched inference"] : []), ...verifyFailure(wire).errors])
        }
        else if (scenario === "cancel") {
          const dispatch = dispatches[0]
          checked = verifyCancellation({ semanticSeen: response.semanticSeen, clientCancelled: response.clientCancelled, upstreamClosed: dispatch?.upstreamClosed ?? false, normalCompletionSent: dispatch?.normalCompletionSent ?? false, gateReleased: dispatch?.gateReleased ?? false })
          if (dispatches.length !== 1) checked = verdict([...checked.errors, "cancellation dispatch count differs"])
        } else if (["pre-failure", "mid-failure", "truncated", "runaway"].includes(scenario)) {
          checked = verifyFailure(wire)
          if (scenario === "truncated" && response.transportError && checked.errors.length === 1 && checked.errors[0] === "failure has no error evidence") checked = verdict([])
          if (!dispatches.length) checked = verdict([...checked.errors, "failure fixture was never called"])
          if (dispatches.some(dispatch => dispatch.normalCompletionSent || dispatch.gateReleased)) checked = verdict([...checked.errors, "failure fixture reached normal completion"])
          if (scenario === "runaway" && !dispatches.some(dispatch => dispatch.upstreamClosed)) checked = verdict([...checked.errors, "runaway upstream did not close before cleanup"])
        } else {
          checked = verifySuccess(wire, kind, { synthesizedFromJson: scenario.startsWith("fallback-") })
          if (response.transportError) checked = verdict([...checked.errors, "success transport failed"])
          if (dispatches.length !== 1 || !dispatches[0]?.completed || !dispatches[0].normalCompletionSent) checked = verdict([...checked.errors, "success dispatch did not complete exactly once"])
          if (options.expectedSource && dispatches[0]?.source !== options.expectedSource) checked = verdict([...checked.errors, "request reached another physical source"])
        }
        if (dispatches.some(dispatch => !dispatch.requestedStream)) checked = verdict([...checked.errors, "upstream did not receive stream true"])
        if (protocol === "chat" && dispatches.some(dispatch => object(dispatch.request.stream_options).include_usage !== true)) checked = verdict([...checked.errors, "upstream Chat usage was not requested"])
        row = { ...wire, id, arm, scenario: options.label ?? scenario, verdict: checked, requestBody: JSON.stringify(input), responseHeaders: response.responseHeaders, dispatches, ...(response.transportError ? { transportError: response.transportError } : {}) }
      } catch (error) { row = { id, arm, protocol, scenario: options.label ?? scenario, stream, status: 0, raw: "", contentType: null, requestBody: JSON.stringify(input), responseHeaders: [], dispatches: fixture.dispatches.slice(before).map(dispatch => structuredClone(dispatch)), verdict: verdict([String(error)]) } }
      rows.push(row)
      durableJson(join(directory, `${id}.wire.json`), { ...row, requestSha256: sha(row.requestBody), responseSha256: sha(row.raw), dispatchWire: row.dispatches.map(dispatch => ({ requestSha256: sha(dispatch.requestBody), responseSha256: sha(dispatch.sentFrames.join("")), bytes: Buffer.byteLength(dispatch.sentFrames.join("")) })) }, true)
      await fixture.release(id)
      return row
    }
    const skipped = (scenario: string, stream: boolean, prerequisite: string) => {
      const id = `${arm}-responses-${scenario}-${stream ? "sse" : "json"}`
      const row: CaseRow = { id, arm, protocol: "responses", scenario, stream, status: 0, raw: "", contentType: null, requestBody: "", responseHeaders: [], dispatches: [], verdict: verdict([`Not executed: prerequisite ${prerequisite} failed`]) }
      rows.push(row)
      durableJson(join(directory, `${id}.wire.json`), { ...row, skipped: true, prerequisite }, true)
    }
    for (const protocol of protocols) for (const kind of ["text", "tool"] as const) for (const stream of [false, true]) await offer(protocol, kind, stream)
    for (const stream of [false, true]) {
      const initial = await offer("responses", "opaque", stream)
      if (initial.verdict.ok) {
        const output = items(finalResponses(initial).output)
        const replay = await offer("responses", "opaque", stream, { body: { input: output }, label: "opaque-replay", expectedSource: "primary" })
        const dispatch = replay.dispatches[0]
        const checked = verifyReplay(dispatch?.request ?? {}, dispatch?.source ?? "", initial.dispatches[0]?.source ?? "")
        replay.verdict = verdict([...replay.verdict.errors, ...checked.errors])
        durableJson(join(directory, `${replay.id}.continuation.json`), { verdict: replay.verdict, clientOutput: output, dispatch }, true)
        await offer("responses", "other", stream, { body: { input: output }, label: "required-source-mismatch", expect: "reject" })
      } else for (const scenario of ["opaque-replay", "required-source-mismatch"]) skipped(scenario, stream, initial.id)
      const plain = rows.find(row => row.protocol === "responses" && row.scenario === "text" && row.stream === stream)
      if (plain?.verdict.ok) {
        const output = items(finalResponses(plain).output)
        const capability = await offer("responses", "other", stream, { body: { input: [...output, { type: "program_output", id: "prog_out_client", call_id: "call_1", result: "done", status: "completed" }] }, label: "blobless-program-source", ...(arm === "R" ? { expect: "reject" as const } : { expect: "capability-allow" as const, expectedSource: "secondary" }) })
        capability.capabilityDifference = arm === "R" ? "Native synthetic turn carrier forces the source for a following blob-less program_output" : "B has no synthetic turn carrier; blob-less program_output is not source-bound by the opaque affinity contract"
        durableJson(join(directory, `${capability.id}.capability.json`), { verdict: capability.verdict, capabilityDifference: capability.capabilityDifference, clientOutput: output, dispatches: capability.dispatches }, true)
      } else skipped("blobless-program-source", stream, plain?.id ?? "plain Responses response")
    }
    if (arm === "B") {
      for (const protocol of protocols) for (const stream of [false, true]) await offer(protocol, "fallback-json", stream)
      for (const scenario of ["fallback-untyped", "fallback-plain"] as const) for (const stream of [false, true]) await offer("chat", scenario, stream)
      for (const scenario of ["pre-failure", "mid-failure", "truncated"] as const) for (const stream of [false, true]) await offer("responses", scenario, stream)
      for (const protocol of ["chat", "responses"] as const) for (const stream of [false, true]) await offer(protocol, "runaway", stream)
      await offer("responses", "cancel", true)
    }
    const settled = await fetch(base + "/__harness/settled", { headers: { "x-harness-key": "architecture-local-only" }, signal: AbortSignal.timeout(20000) })
    const settlement = object(await settled.json())
    const settlementOk = settled.ok && settlement.active === 0 && settlement.pending === 0 && settlement.registered === settlement.settled && Array.isArray(settlement.failures) && settlement.failures.length === 0 && settlement.observerFailures === 0 && settlement.unowned === 0
    const metrics = arm === "B" ? (await db.prepare("SELECT metric, dimensions, count, sum FROM performance_metrics WHERE metric = '__requests'").all()).results : null
    if (metrics) for (const row of rows.filter(row => ["pre-failure", "mid-failure", "truncated", "runaway", "cancel"].includes(row.scenario))) {
      const expectedOutcome = row.scenario === "cancel" ? "cancelled" : "error"
      const records = metrics.map(object).map(record => ({ ...record, count: record.count, parsed: object(JSON.parse(String(record.dimensions))) })).filter(record => record.parsed.incomingModel === modelFor(row.protocol, row.scenario as Scenario) && record.parsed.stream === row.stream)
      if (records.length !== 1 || records[0]?.parsed.outcome !== expectedOutcome || records[0]?.count !== 1) row.verdict = verdict([...row.verdict.errors, `request metric did not settle as ${expectedOutcome} exactly once`])
      durableJson(join(directory, `${row.id}.metrics.json`), { expectedOutcome, records, verdict: row.verdict }, true)
    }
    durableJson(join(directory, "observations.json"), { rows, rejected: fixture.rejected, settlement, settlementOk, metrics, unsupported: arm === "R" ? ["JSON fallback/missing MIME success: R Custom requires text/event-stream", "Custom runaway guard: R guard is Copilot-provider specific", "Wrong-key hard rejection: R foreign carriers are preserved", "Cancellation and native error cells are not executed for R in this bounded canary"] : [], scope: "Correctness and capability differences only; raw client/fixture evidence, no performance comparison" }, true)
    if (!settlementOk || fixture.rejected.length) throw new Error(`Invalid correctness settlement or fixture egress: ${JSON.stringify({ settlement, rejected: fixture.rejected })}`)
    return rows
  } finally { try { await mf?.dispose() } finally { await fixture.stop() } }
}

export async function runCorrectness(context: CorrectnessContext, directory: string) {
  mkdirSync(directory, { recursive: false })
  const inputs = [...context.manifest.variants.B.files, ...(context.manifest.dependencies ?? [])]
  verifyExecution(context.manifest.execution)
  verifyFiles(inputs)
  verifyFiles(context.manifest.artifacts)
  for (const input of context.reference.inputs) if (sha(readFileSync(input.path)) !== input.sha256) throw new Error(`Reference input drift: ${input.path}`)
  durableJson(join(directory, "inputs.json"), { context, harness: ["correctness.ts", "correctness-contracts.ts"].map(name => fileIdentity(join(import.meta.dir, name))), reused: ["entry.mjs.template", "probe-runtime.ts", "reference-adapter.ts"].map(name => fileIdentity(join(previousHarness, name))), scope: "Standalone correctness canary; no timed windows or comparative performance claims" }, true)
  const rows: CaseRow[] = []
  try {
    for (const arm of ["B", "R"] as const) rows.push(...await runArm(context, arm, join(directory, arm)))
    verifyFiles(inputs)
    verifyExecution(context.manifest.execution)
    verifyFiles(context.manifest.artifacts)
    for (const input of context.reference.inputs) if (sha(readFileSync(input.path)) !== input.sha256) throw new Error(`Reference input drift after canary: ${input.path}`)
    const summary = summarizeCorrectness(rows)
    durableJson(join(directory, "disposition.json"), summary, true)
    return summary
  } catch (error) { durableJson(join(directory, "disposition.json"), { completed: false, qualified: false, performanceComparison: false, error: String(error), rows: rows.map(row => ({ id: row.id, verdict: row.verdict })) }, true); throw error }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== "--context" || args[2] !== "--out" || !args[1] || !args[3]) throw new Error("Usage: bun correctness.ts --context CONTEXT_JSON --out NEW_DIRECTORY")
  const result = await runCorrectness(loadContext(resolve(args[1])), resolve(args[3]))
  console.log(JSON.stringify(result))
  if (!result.qualified) process.exitCode = 1
}
