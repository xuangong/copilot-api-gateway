import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { connect as connectTcp } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { app } from "@vibe-llm/gateway"
import type { ResponsesSession } from "@vibe-llm/gateway/responses-session"
import { bootstrapBunPlatform } from "../bootstrap.ts"
import { BunSqliteRepo } from "../bun-sqlite-repo.ts"
import { createResponsesWebSocketHandlers } from "../responses-websocket.ts"

type UserId = Parameters<BunSqliteRepo["users"]["create"]>[0]["id"]
type ApiKeyId = Parameters<BunSqliteRepo["apiKeys"]["save"]>[0]["id"]
type UpstreamId = Parameters<BunSqliteRepo["upstreams"]["save"]>[0]["id"]

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WebSocket fixture deadline")
    await Bun.sleep(5)
  }
}

async function handshake(port: number, path: string, credential?: string): Promise<number> {
  const socket = connectTcp(port, "127.0.0.1")
  try {
    const status = new Promise<number>((resolve, reject) => {
      let bytes = ""
      socket.setTimeout(4_000, () => reject(new Error("Upgrade handshake timed out")))
      socket.on("error", reject)
      socket.on("data", chunk => {
        bytes += chunk.toString()
        if (!bytes.includes("\r\n\r\n")) return
        const match = /^HTTP\/1\.1 (\d{3}) /.exec(bytes)
        if (!match?.[1]) reject(new Error("Invalid upgrade response"))
        else resolve(Number(match[1]))
      })
      socket.on("close", () => { if (!bytes.includes("\r\n\r\n")) reject(new Error("Upgrade response closed early")) })
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

test("native Bun socket warmup is local, then same-socket continuation uses the HTTP upstream", async () => {
  const dir = mkdtempSync(join(tmpdir(), "c12-f3-bun-"))
  const dbPath = join(dir, "gateway.sqlite")
  const { db } = bootstrapBunPlatform({ dbPath, filesRoot: join(dir, "files") })
  const external = new Database(dbPath)
  const repo = new BunSqliteRepo(external)
  const upstreamBodies: Record<string, unknown>[] = []
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    upstreamBodies.push(await request.json() as Record<string, unknown>)
    const response = { id: `resp_native_${upstreamBodies.length}`, object: "response", model: "model", status: "completed", output: [], error: null, usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }
    return new Response([
      { type: "response.created", response: { ...response, status: "in_progress" } },
      { type: "response.completed", response },
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  } })
  await repo.users.create({ id: "owner" as UserId, name: "Fixture", disabled: false, createdAt: "now" })
  await repo.apiKeys.save({ id: "key" as ApiKeyId, key: "sk_c12_f3_fixture", name: "fixture", ownerId: "owner" as UserId, createdAt: "now", dumpRetentionSeconds: null, modelMappingsEnabled: false, modelMappings: [] })
  await repo.upstreams.save({ id: "up" as UpstreamId, ownerId: "owner" as UserId, provider: "custom", name: "fixture", enabled: true, sortOrder: 0, config: { name: "fixture", baseUrl: upstream.url.toString().replace(/\/$/, ""), authStyle: "none", endpoints: ["responses"], models: ["model"] }, state: null, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], createdAt: "now", updatedAt: "now" })
  const callbacks = createResponsesWebSocketHandlers({ app })
  const sessions: ResponsesSession[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch: callbacks.fetch,
    websocket: {
      ...callbacks.websocket,
      open(ws) {
        callbacks.websocket.open(ws)
        if (ws.data.session) sessions.push(ws.data.session)
      },
    },
  })
  const port = server.port
  if (typeof port !== "number") throw new Error("Native server has no TCP port")
  const messages: Record<string, unknown>[] = []
  let socket: WebSocket | undefined
  try {
    const capability = await fetch(new URL("api/capabilities", server.url), { headers: { authorization: "Bearer sk_c12_f3_fixture" } })
    expect(capability.status).toBe(200)
    expect((await capability.json() as { codex: { responsesWebSocket: { available: boolean; maxConnectionOutboundBytes: number | null } } }).codex.responsesWebSocket)
      .toMatchObject({ available: true, maxConnectionOutboundBytes: null })
    for (const path of ["/responses", "/v1/responses", "/azure-api.codex/responses", "/azure-api.codex/v1/responses"]) {
      expect(await handshake(port, path, "sk_c12_f3_fixture")).toBe(101)
    }
    expect(await handshake(port, "/v1/responses")).toBe(401)
    expect(await handshake(port, "/v1/responses", "invalid_key")).toBe(401)
    expect(await handshake(port, "/v1/responses?key=sk_c12_f3_fixture", "sk_c12_f3_fixture")).toBe(400)
    expect(await handshake(port, "/v1/responses/compact", "sk_c12_f3_fixture")).toBe(404)
    // The Workers DOM declaration hides Bun's native WebSocket headers option.
    const connectedSocket = new WebSocket(server.url.toString().replace(/^http/, "ws") + "v1/responses", {
      headers: { authorization: "Bearer sk_c12_f3_fixture" },
    } as unknown as string[])
    socket = connectedSocket
    await new Promise<void>((resolve, reject) => {
      connectedSocket.addEventListener("open", () => resolve(), { once: true })
      connectedSocket.addEventListener("error", () => reject(new Error("Native WebSocket upgrade failed")), { once: true })
    })
    connectedSocket.addEventListener("message", event => {
      if (typeof event.data === "string") messages.push(JSON.parse(event.data) as Record<string, unknown>)
    })
    connectedSocket.send(JSON.stringify({ type: "response.create", model: "model", input: "hello", generate: false, stream: true, store: false }))
    await until(() => messages.some(message => message.type === "response.completed"))
    expect(messages.map(message => message.type)).toEqual(["response.created", "response.completed"])
    expect((messages[0]?.response as { id: string }).id).toBe((messages[1]?.response as { id: string }).id)
    expect(upstreamBodies).toHaveLength(0)
    const warmupId = (messages[1]?.response as { id: string }).id
    connectedSocket.send(JSON.stringify({ type: "response.create", model: "model", previous_response_id: warmupId, input: [], stream: true, store: false }))
    await until(() => messages.filter(message => message.type === "response.completed").length === 2)
    expect(upstreamBodies).toHaveLength(1)
    expect(JSON.stringify(upstreamBodies[0])).toContain("hello")
    expect(upstreamBodies[0]).not.toHaveProperty("previous_response_id")
    external.exec("UPDATE users SET disabled = 1 WHERE id = 'owner'")
    connectedSocket.send(JSON.stringify({ type: "response.create", model: "model", input: "later", stream: true, store: false }))
    await until(() => messages.some(message => message.type === "error" && message.status === 401))
    expect(upstreamBodies).toHaveLength(1)
    await until(() => connectedSocket.readyState === WebSocket.CLOSED)
    expect(connectedSocket.readyState).toBe(WebSocket.CLOSED)
    const session = sessions.at(-1)
    if (!session) throw new Error("Native socket did not create a Responses session")
    expect(await session.close()).toEqual({ cleanupComplete: true })
  } finally {
    if (socket && "terminate" in socket) (socket as WebSocket & { terminate(): void }).terminate()
    else socket?.close()
    // Bun 1.3 stops accepting immediately, but its stop promise can stay pending
    // after a socket has already completed a server-initiated close handshake.
    void server.stop(true).catch(() => {})
    await upstream.stop(true)
    external.close()
    db.raw.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)
