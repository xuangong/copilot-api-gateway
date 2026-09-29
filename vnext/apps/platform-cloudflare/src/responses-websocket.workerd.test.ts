import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { connect } from "node:net"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"

const HERE = dirname(fileURLToPath(import.meta.url))
const VNEXT = join(HERE, "../../..")
const KEY = "sk_c12_f4_workerd_fixture"
const workerdTest = test.serial
const openSockets = new Set<WebSocket>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture has no TCP port")
  return address.port
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, milliseconds = 5_000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`${label} timed out`)
    await Bun.sleep(10)
  }
}

async function handshake(port: number, path: string, credential?: string): Promise<number> {
  const socket = connect(port, "127.0.0.1")
  try {
    const status = new Promise<number>((resolve, reject) => {
      let head = ""
      socket.setTimeout(5_000, () => reject(new Error("WebSocket handshake timed out")))
      socket.on("error", reject)
      socket.on("data", chunk => {
        head += chunk.toString()
        if (!head.includes("\r\n\r\n")) return
        const match = /^HTTP\/1\.1 (\d{3}) /.exec(head)
        if (match?.[1]) resolve(Number(match[1]))
        else reject(new Error("Invalid WebSocket handshake response"))
      })
    })
    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      "Connection: keep-alive, Upgrade",
      "Upgrade: websocket",
      "Sec-WebSocket-Key: AQIDBAUGBwgJCgsMDQ4PEA==",
      "Sec-WebSocket-Version: 13",
      ...(credential ? [`Authorization: Bearer ${credential}`] : []),
      "", "",
    ].join("\r\n"))
    return await status
  } finally { socket.destroy() }
}

function openSocket(port: number, path = "/v1/responses"): Promise<WebSocket> {
  // Bun supports a headers option here; the shared DOM declaration describes browser sockets.
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
    headers: { authorization: `Bearer ${KEY}` },
  } as unknown as string[])
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => { openSockets.add(socket); resolve(socket) }, { once: true })
    socket.addEventListener("close", () => openSockets.delete(socket), { once: true })
    socket.addEventListener("error", () => reject(new Error("Native workerd socket did not open")), { once: true })
  })
}

function terminateSocket(socket: WebSocket | undefined): void {
  if (!socket) return
  if ("terminate" in socket && typeof socket.terminate === "function") socket.terminate()
  else socket.close()
}

async function closeOpenSockets(): Promise<void> {
  for (const socket of openSockets) terminateSocket(socket)
  await until(() => openSockets.size === 0, "native socket cleanup")
}

function collectMessages(socket: WebSocket): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = []
  socket.addEventListener("message", event => {
    if (typeof event.data !== "string") return
    const parsed: unknown = JSON.parse(event.data)
    if (isRecord(parsed)) messages.push(parsed)
  })
  return messages
}

function responseId(event: Record<string, unknown> | undefined): string {
  const response = event?.response
  if (!isRecord(response) || typeof response.id !== "string") throw new Error("Response event has no ID")
  return response.id
}

function create(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "response.create", model: "gpt-5.4", input: "hello", stream: true, store: false, ...extra })
}

interface Fixture {
  readonly gatewayBase: string
  readonly port: number
  readonly db: Awaited<ReturnType<Miniflare["getD1Database"]>>
  readonly upstreamBodies: Record<string, unknown>[]
  failNext(): void
  reset(): Promise<void>
  stop(): Promise<void>
}

async function startFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "c12-f4-workerd-test-"))
  const upstreamBodies: Record<string, unknown>[] = []
  let failNext = false
  let upstreamConfig = ""
  const upstream = createServer((request, response) => { void (async () => {
    const body: Uint8Array[] = []
    for await (const chunk of request) body.push(chunk)
    const parsed: unknown = JSON.parse(Buffer.concat(body).toString())
    if (!isRecord(parsed)) throw new Error("Invalid upstream request")
    upstreamBodies.push(parsed)
    const index = upstreamBodies.length
    const base = { id: `resp_c12_f4_${index}`, object: "response", model: "gpt-5.4", output: [], error: null, usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }
    const sse = (event: Record<string, unknown>) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
    response.writeHead(200, { "content-type": "text/event-stream" })
    response.write(sse({ type: "response.created", response: { ...base, status: "in_progress" } }))
    if (failNext) {
      failNext = false
      response.end(sse({ type: "response.failed", response: { ...base, status: "failed", error: { code: "invalid_prompt", message: "Synthetic fixture failure" } } }))
    } else response.end(sse({ type: "response.completed", response: { ...base, status: "completed" } }))
  })().catch(() => { response.writeHead(500); response.end() }) })
  let mf: Miniflare | undefined
  try {
    const upstreamPort = await listen(upstream)
    const entry = join(dir, "entry.ts")
    const bundle = join(dir, "worker.mjs")
    writeFileSync(entry, `import worker from ${JSON.stringify(join(HERE, "worker.ts"))}\nexport default worker\n`)
    const build = Bun.spawnSync(["bun", "build", entry, "--target=node", "--external=cloudflare:sockets", `--outfile=${bundle}`], { cwd: VNEXT })
    if (build.exitCode !== 0) throw new Error(new TextDecoder().decode(build.stderr))
    mf = new Miniflare({
      modules: true, modulesRoot: dir, scriptPath: bundle, host: "127.0.0.1", port: 0,
      compatibilityDate: "2025-06-01", compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "c12-f4-test" }, d1Persist: join(dir, "d1"),
      kvNamespaces: ["KV", "IMAGE_CACHE"], images: { binding: "IMAGES" }, r2Buckets: ["FILES"],
    })
    const db = await mf.getD1Database("DB")
    for (const name of readdirSync(join(VNEXT, "packages/gateway/migrations")).filter(name => name.endsWith(".sql")).sort()) {
      for (const sql of unstable_splitSqlQuery(readFileSync(join(VNEXT, "packages/gateway/migrations", name), "utf8"))) await db.prepare(sql).run()
    }
    const now = new Date().toISOString()
    upstreamConfig = JSON.stringify({ name: "Fixture", baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, authStyle: "none", endpoints: ["responses"], models: ["gpt-5.4"] })
    await db.prepare("INSERT INTO users(id,name,email,created_at) VALUES(?,?,?,?)").bind("c12-f4-owner", "Fixture", "fixture@example.invalid", now).run()
    await db.prepare("INSERT INTO api_keys(id,name,key,created_at,owner_id,responses_retention_seconds) VALUES(?,?,?,?,?,?)").bind("c12-f4-key", "Fixture", KEY, now, "c12-f4-owner", 0).run()
    await db.prepare("INSERT INTO upstreams(id,owner_id,provider,name,config_json,proxy_fallback_list_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").bind(
      "custom:c12-test", "c12-f4-owner", "custom", "Fixture", upstreamConfig, '[{"id":"direct_fetch"}]', now, now,
    ).run()
    const ready = await mf.ready
    const active = mf
    const port = Number(ready.port)
    if (!Number.isInteger(port) || port <= 0) throw new Error("Workerd has no TCP port")
    return {
      gatewayBase: `http://127.0.0.1:${port}`, port, db, upstreamBodies,
      failNext() { failNext = true },
      async reset() {
        await closeOpenSockets()
        upstreamBodies.length = 0
        failNext = false
        await db.prepare("UPDATE users SET disabled = 0 WHERE id = 'c12-f4-owner'").run()
        await db.prepare("UPDATE upstreams SET config_json = ? WHERE id = 'custom:c12-test'").bind(upstreamConfig).run()
        await db.prepare("DELETE FROM responses_snapshots").run()
        await db.prepare("DELETE FROM responses_items").run()
      },
      async stop() {
        await closeOpenSockets()
        upstream.closeAllConnections()
        await active.dispose()
        await new Promise<void>(resolve => upstream.close(() => resolve()))
        rmSync(dir, { recursive: true, force: true })
      },
    }
  } catch (error) {
    upstream.closeAllConnections()
    await mf?.dispose()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}

async function startNodeUpstream(): Promise<{
  readonly base: string
  state(): Promise<{ requests: unknown[]; closes: unknown[] }>
  stop(): Promise<void>
}> {
  const producer = spawn("node", [join(HERE, "responses-websocket-upstream.fixture.mjs")], { stdio: ["ignore", "pipe", "inherit"] })
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = ""
    producer.once("error", reject)
    producer.once("exit", code => reject(new Error(`Node upstream exited before readiness: ${code}`)))
    producer.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
      const newline = stdout.indexOf("\n")
      if (newline < 0) return
      const ready: unknown = JSON.parse(stdout.slice(0, newline))
      if (!isRecord(ready) || typeof ready.port !== "number") reject(new Error("Node upstream returned no port"))
      else resolve(ready.port)
    })
  })
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    async state() {
      const response = await fetch(`${base}/__fixture/state`)
      if (response.status !== 200) throw new Error("Node upstream observation failed")
      const state: unknown = await response.json()
      if (!isRecord(state) || !Array.isArray(state.requests) || !Array.isArray(state.closes)) throw new Error("Invalid Node upstream observation")
      const requests: unknown[] = state.requests
      const closes: unknown[] = state.closes
      return { requests, closes }
    },
    async stop() {
      if (producer.exitCode !== null) return
      const exited = new Promise<void>(resolve => producer.once("exit", () => resolve()))
      producer.kill("SIGTERM")
      await exited
    },
  }
}

let fixture: Fixture
beforeAll(async () => { fixture = await startFixture() })
beforeEach(async () => { await fixture.reset() })
afterAll(async () => { if (fixture) await fixture.stop() })

workerdTest("production Worker upgrades only four exact authenticated routes before 101", async () => {
  const capability = await fetch(`${fixture.gatewayBase}/api/capabilities`, { headers: { authorization: `Bearer ${KEY}` } })
  expect(capability.status).toBe(200)
  expect(capability.headers.get("cache-control")).toBe("no-store")
  expect((await capability.json() as { codex: { responsesWebSocket: { available: boolean; maxConnectionOutboundBytes: number } } }).codex.responsesWebSocket)
    .toMatchObject({ available: true, maxConnectionOutboundBytes: 16_777_216 })
  for (const path of ["/responses", "/v1/responses", "/azure-api.codex/responses", "/azure-api.codex/v1/responses"]) {
    const socket = await openSocket(fixture.port, path)
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener("close", event => resolve(event), { once: true }))
    socket.close(1000, "route check")
    expect((await closed).wasClean).toBe(true)
  }
  expect(await handshake(fixture.port, "/v1/responses")).toBe(401)
  expect(await handshake(fixture.port, "/v1/responses", "invalid")).toBe(401)
  expect(await handshake(fixture.port, `/v1/responses?key=${KEY}`, KEY)).toBe(400)
  expect(await handshake(fixture.port, "/v1/responses/compact", KEY)).toBe(404)
  expect((await fetch(`${fixture.gatewayBase}/health`)).status).toBe(200)
  expect((await fetch(`${fixture.gatewayBase}/v1/responses`)).status).toBe(404)
  expect(fixture.upstreamBodies).toHaveLength(0)
}, 30_000)

workerdTest("native workerd socket keeps warmup private and reauthorizes every turn after completion", async () => {
  let socket: WebSocket | undefined
  try {
    socket = await openSocket(fixture.port)
    const messages = collectMessages(socket)
    socket.send(create({ generate: false, instructions: "remember" }))
    await until(() => messages.some(event => event.type === "response.completed"), "workerd warmup")
    expect(messages.map(event => event.type)).toEqual(["response.created", "response.completed"])
    const id = responseId(messages[1])
    expect(responseId(messages[0])).toBe(id)
    expect(fixture.upstreamBodies).toHaveLength(0)

    socket.send(create({ previous_response_id: id, input: [] }))
    await until(() => messages.filter(event => event.type === "response.completed").length === 2, "workerd continuation")
    expect(fixture.upstreamBodies).toHaveLength(1)
    expect(JSON.stringify(fixture.upstreamBodies[0])).toContain("remember")
    expect(JSON.stringify(fixture.upstreamBodies[0])).toContain("hello")
    expect(fixture.upstreamBodies[0]).not.toHaveProperty("previous_response_id")

    await fixture.db.prepare("UPDATE users SET disabled = 1 WHERE id = 'c12-f4-owner'").run()
    socket.send(create({ input: "after revocation" }))
    await until(() => messages.some(event => event.type === "error"), "revocation error")
    expect(messages.at(-1)).toMatchObject({ type: "error", status: 401 })
    expect(fixture.upstreamBodies).toHaveLength(1)
  } finally {
    terminateSocket(socket)
  }
}, 30_000)

workerdTest("a failed native turn closes, and a new socket sends a full upstream request", async () => {
  let first: WebSocket | undefined
  let second: WebSocket | undefined
  try {
    fixture.failNext()
    first = await openSocket(fixture.port)
    const failed = collectMessages(first)
    first.send(create({ input: "first" }))
    await until(() => failed.some(event => event.type === "response.failed"), "failed native turn")
    expect(failed[0]?.type).toBe("response.created")
    expect(failed.at(-1)?.type).toBe("response.failed")
    expect(fixture.upstreamBodies).toHaveLength(1)

    second = await openSocket(fixture.port)
    const succeeded = collectMessages(second)
    second.send(create({ input: "second" }))
    await until(() => succeeded.some(event => event.type === "response.completed"), "recovery on new socket")
    expect(succeeded.at(-1)?.type).toBe("response.completed")
    expect(fixture.upstreamBodies).toHaveLength(2)
    expect(JSON.stringify(fixture.upstreamBodies[1])).toContain("second")
    expect(fixture.upstreamBodies[1]).not.toHaveProperty("previous_response_id")
  } finally {
    terminateSocket(first)
    terminateSocket(second)
  }
}, 30_000)

workerdTest("native overlap and malformed input reject without queuing another inference; binary closes", async () => {
  const upstream = await startNodeUpstream()
  let socket: WebSocket | undefined
  try {
    await fixture.db.prepare("UPDATE upstreams SET config_json = ? WHERE id = 'custom:c12-test'").bind(JSON.stringify({
      name: "Fixture", baseUrl: `${upstream.base}/v1`, authStyle: "none", endpoints: ["responses"], models: ["gpt-5.4"],
    })).run()
    socket = await openSocket(fixture.port)
    const messages = collectMessages(socket)
    socket.send(create({ input: "held-generation" }))
    await until(() => messages.some(event => event.type === "response.created"), "held native turn")
    expect((await upstream.state()).requests).toHaveLength(1)
    socket.send(create({ input: "overlap" }))
    socket.send("{")
    await until(() => messages.filter(event => event.type === "error").length === 2, "overlap and malformed errors")
    expect(messages.filter(event => event.type === "error").map(event => event.status)).toEqual([409, 400])
    expect((await upstream.state()).requests).toHaveLength(1)
    const closeEvent = new Promise<CloseEvent>(resolve => socket?.addEventListener("close", event => resolve(event), { once: true }))
    socket.send(new Uint8Array([1, 2, 3]))
    const closed = await Promise.race([closeEvent, Bun.sleep(5_000).then(() => { throw new Error("Binary close timed out") })])
    expect(closed.code).toBe(1003)
    await until(async () => (await upstream.state()).closes.length > 0, "binary cleanup")
    expect((await upstream.state()).requests).toHaveLength(1)
  } finally {
    terminateSocket(socket)
    await upstream.stop()
  }
}, 30_000)

workerdTest("oversize native text frame closes before any upstream request", async () => {
  let socket: WebSocket | undefined
  try {
    socket = await openSocket(fixture.port)
    const closeEvent = new Promise<CloseEvent>(resolve => socket?.addEventListener("close", event => resolve(event), { once: true }))
    socket.send(create({ input: "x".repeat(1_048_576) }))
    const closed = await Promise.race([closeEvent, Bun.sleep(5_000).then(() => { throw new Error("Oversize close timed out") })])
    expect(closed.code).toBe(1009)
    expect(fixture.upstreamBodies).toHaveLength(0)
  } finally {
    terminateSocket(socket)
  }
}, 30_000)

workerdTest("native peer close receives a reciprocal close and cancels the real upstream", async () => {
  const upstream = await startNodeUpstream()
  let socket: WebSocket | undefined
  try {
    await fixture.db.prepare("UPDATE upstreams SET config_json = ? WHERE id = 'custom:c12-test'").bind(JSON.stringify({
      name: "Fixture", baseUrl: `${upstream.base}/v1`, authStyle: "none", endpoints: ["responses"], models: ["gpt-5.4"],
    })).run()
    socket = await openSocket(fixture.port)
    const messages = collectMessages(socket)
    socket.send(create({ input: "held-generation" }))
    await until(() => messages.some(event => event.type === "response.created"), "held upstream")
    expect((await upstream.state()).requests).toHaveLength(1)
    const closeEvent = new Promise<CloseEvent>(resolve => socket?.addEventListener("close", event => resolve(event), { once: true }))
    socket.close(1000, "fixture done")
    const closed = await Promise.race([closeEvent, Bun.sleep(5_000).then(() => { throw new Error("Reciprocal close timed out") })])
    expect(closed.code).toBe(1000)
    expect(closed.wasClean).toBe(true)
    let closes: unknown[] = []
    await until(async () => {
      closes = (await upstream.state()).closes
      return closes.length > 0
    }, "upstream abort", 10_000)
    expect(closes).toContainEqual({ id: responseId(messages.find(event => event.type === "response.created")), finished: false })
  } finally {
    terminateSocket(socket)
    await upstream.stop()
  }
}, 35_000)

workerdTest("unobservable native output closes at the session budget and aborts generation", async () => {
  const upstream = await startNodeUpstream()
  let socket: WebSocket | undefined
  try {
    await fixture.db.prepare("UPDATE upstreams SET config_json = ? WHERE id = 'custom:c12-test'").bind(JSON.stringify({
      name: "Fixture", baseUrl: `${upstream.base}/v1`, authStyle: "none", endpoints: ["responses"], models: ["gpt-5.4"],
    })).run()
    socket = await openSocket(fixture.port)
    const closeEvent = new Promise<CloseEvent>(resolve => socket?.addEventListener("close", event => resolve(event), { once: true }))
    socket.send(create({ input: "pressure-flood" }))
    const closed = await Promise.race([closeEvent, Bun.sleep(15_000).then(() => { throw new Error("Native output limit close timed out") })])
    expect(closed.code).toBe(1009)
    let closes: unknown[] = []
    await until(async () => {
      closes = (await upstream.state()).closes
      return closes.length > 0
    }, "bounded generation abort", 10_000)
    expect(closes).toContainEqual({ id: "resp_c12_f4_node_1", finished: false })
    expect((await upstream.state()).requests).toHaveLength(1)
  } finally {
    terminateSocket(socket)
    await upstream.stop()
  }
}, 35_000)
