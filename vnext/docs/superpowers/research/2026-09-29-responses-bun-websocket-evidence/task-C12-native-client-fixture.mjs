/* global Bun */
/**
 * Scratch-only actual-gateway fixture for pinned Codex C12 acceptance.
 *
 * UNWIRED until F3 exports its real Bun callback factory. This file does not
 * implement a Responses WebSocket server, protocol event, session, or auth.
 * Edit only loadProductionCallbacks() if the final factory name/signature
 * differs. Do not substitute a scripted WS server to make acceptance green.
 *
 * Future use (never run against live services):
 *   C12_GATEWAY_SOURCE_ROOT=/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify \
 *   C12_NATIVE_RUN_DIR=<fresh-temp-dir> \
 *     bun run task-C12-native-client-fixture.mjs
 * The process prints a runtime JSON path containing exact loopback bases.
 */

import { createServer as createNodeServer } from "node:http"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const DEFAULT_SOURCE = "/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify"
const SOURCE = process.env.C12_GATEWAY_SOURCE_ROOT ?? DEFAULT_SOURCE
if (!isAbsolute(SOURCE)) throw new Error("C12_GATEWAY_SOURCE_ROOT must be an absolute local path")
const IS_NODE_UPSTREAM = process.argv[2] === "--node-upstream"
const RUN = process.env.C12_NATIVE_RUN_DIR
  ? resolve(process.env.C12_NATIVE_RUN_DIR)
  : mkdtempSync(join(tmpdir(), "c12-native-client-"))
if (!IS_NODE_UPSTREAM && process.env.C12_NATIVE_RUN_DIR && existsSync(RUN) && readdirSync(RUN).length > 0) {
  throw new Error("C12_NATIVE_RUN_DIR must be a fresh empty directory")
}
if (IS_NODE_UPSTREAM && !process.env.C12_NATIVE_RUN_DIR) throw new Error("Node upstream requires its parent run directory")
mkdirSync(RUN, { recursive: true })
mkdirSync(join(RUN, "logs"), { recursive: true })
const KEY = "sk_c12_local_fixture_only"
const OWNER_ID = "c12-fixture-owner"
const MODEL = "gpt-5.4"
const runtimePath = join(RUN, "native-client-runtime.json")
const nodeRuntimePath = join(RUN, "node-upstream-runtime.json")
const gatewayObservationPath = join(RUN, "gateway-observation.json")
const observerErrorPath = join(RUN, "observer-error.txt")
const nativeLogPath = join(RUN, "logs", "native-events.jsonl")

const observation = {
  schema_version: 1,
  connections: [],
  upstream_requests: [],
  http_posts: 0,
}
let nextConnectionId = 1
let nextResponseId = 1
let failNextUpstreamResponse = false

function persistGatewayObservation() {
  const nextPath = `${gatewayObservationPath}.next`
  writeFileSync(nextPath, JSON.stringify({ connections: observation.connections, http_posts: observation.http_posts }))
  renameSync(nextPath, gatewayObservationPath)
}

function observeWithoutAffectingGateway(write) {
  try { write() }
  catch (error) {
    try { writeFileSync(observerErrorPath, String(error)) } catch { /* Gateway callbacks must still delegate. */ }
  }
}

function mergedObservation() {
  const gateway = existsSync(gatewayObservationPath)
    ? JSON.parse(readFileSync(gatewayObservationPath, "utf8"))
    : { connections: [], http_posts: 0 }
  return {
    schema_version: 1,
    connections: gateway.connections,
    upstream_requests: observation.upstream_requests,
    http_posts: gateway.http_posts,
  }
}

function observeJsonText(text, into) {
  if (typeof text !== "string") return
  try {
    const value = JSON.parse(text)
    if (value && typeof value === "object" && !Array.isArray(value)) into.push(value)
  } catch {
    // The production handler still receives the original malformed frame.
  }
}

function nativeLog(entry) {
  appendFileSync(nativeLogPath, `${JSON.stringify(entry)}\n`)
}

function jsonReply(response, value, status = 200) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Connection": "close",
  })
  response.end(body)
}

async function readJsonBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.byteLength
    if (bytes > 2_097_152) throw new Error("fixture upstream request too large")
    chunks.push(chunk)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected JSON object")
  return parsed
}

function sse(event) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
}

function upstreamResponse(failed) {
  const id = `resp_c12_fixture_${nextResponseId++}`
  const base = {
    id,
    object: "response",
    model: MODEL,
    output: [],
    error: null,
    incomplete_details: null,
    usage: {
      input_tokens: 0,
      input_tokens_details: null,
      output_tokens: 0,
      output_tokens_details: null,
      total_tokens: 0,
    },
  }
  const created = { type: "response.created", response: { ...base, status: "in_progress" } }
  const terminal = failed
    ? {
        type: "response.failed",
        response: {
          ...base,
          status: "failed",
          error: { code: "invalid_prompt", message: "synthetic C12 upstream failure" },
        },
      }
    : { type: "response.completed", response: { ...base, status: "completed" } }
  return sse(created) + sse(terminal)
}

async function handleNodeRequest(request, response) {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  if (request.method === "GET" && path === "/__fixture/c12") {
    // The pinned Rust fixture sends HTTP/1.0 and reads to EOF. Explicit
    // Content-Length and Connection: close prevent chunk framing.
    if (existsSync(observerErrorPath)) jsonReply(response, { error: "passive observer failed" }, 500)
    else jsonReply(response, mergedObservation())
    return
  }
  if (request.method === "POST" && path === "/__fixture/c12/fail-next") {
    failNextUpstreamResponse = true
    jsonReply(response, { armed: true })
    return
  }
  if (request.method !== "POST" || path !== "/v1/responses") {
    jsonReply(response, { error: "unexpected fixture upstream route" }, 404)
    return
  }
  let body
  try { body = await readJsonBody(request) }
  catch {
    jsonReply(response, { error: "invalid fixture upstream request" }, 400)
    return
  }
  observation.upstream_requests.push(body)
  const failed = failNextUpstreamResponse
  failNextUpstreamResponse = false
  const wire = upstreamResponse(failed)
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Content-Length": Buffer.byteLength(wire),
    "Connection": "close",
  })
  response.end(wire)
}

async function runNodeUpstream() {
  const server = createNodeServer((request, response) => {
    void handleNodeRequest(request, response).catch(() => {
      if (!response.headersSent) jsonReply(response, { error: "fixture upstream failure" }, 500)
      else response.destroy()
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === "string" || address.address !== "127.0.0.1") {
    server.close()
    throw new Error("fixture upstream did not bind IPv4 loopback")
  }
  writeFileSync(nodeRuntimePath, JSON.stringify({ base: `http://127.0.0.1:${address.port}` }))
  process.once("SIGTERM", () => server.close(() => process.exit(0)))
  process.once("SIGINT", () => server.close(() => process.exit(0)))
}

async function startIndependentNodeUpstream() {
  const nodeBinary = process.env.C12_NODE_BINARY ?? "/opt/homebrew/bin/node"
  if (!isAbsolute(nodeBinary)) throw new Error("C12_NODE_BINARY must be an absolute path")
  const child = spawn(nodeBinary, [fileURLToPath(import.meta.url), "--node-upstream"], {
    env: {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      C12_NATIVE_RUN_DIR: RUN,
      C12_GATEWAY_SOURCE_ROOT: SOURCE,
    },
    stdio: ["ignore", "ignore", "pipe"],
  })
  let spawnError
  child.once("error", error => { spawnError = error })
  child.stderr.on("data", data => appendFileSync(join(RUN, "logs", "node-upstream.log"), data))
  try {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (spawnError) throw new Error("Node upstream could not start", { cause: spawnError })
      if (existsSync(nodeRuntimePath)) {
        const value = JSON.parse(readFileSync(nodeRuntimePath, "utf8"))
        if (typeof value.base === "string" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(value.base)) {
          return { child, base: value.base }
        }
        throw new Error("Node upstream advertised a non-loopback address")
      }
      if (child.exitCode !== null) throw new Error(`Node upstream exited before ready: ${child.exitCode}`)
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
    }
    throw new Error("Node upstream did not become ready within five seconds")
  } catch (error) {
    child.kill("SIGTERM")
    throw error
  }
}

async function loadProductionCallbacks(app) {
  // SINGLE UNWIRED ADAPTER SEAM. F3 must export its actual Bun.serve callback
  // factory. The adapter must remain the same function used by server.ts.
  // If F3 chooses another path/signature, change only this function.
  const moduleUrl = pathToFileURL(join(SOURCE, "vnext/apps/platform-bun/src/responses-websocket.ts")).href
  let nativeModule
  try { nativeModule = await import(moduleUrl) }
  catch (error) {
    throw new Error(`C12 native adapter not wired: ${moduleUrl}`, { cause: error })
  }
  const create = nativeModule.createResponsesWebSocketHandlers
  if (typeof create !== "function") {
    throw new Error("C12 native adapter not wired: expected createResponsesWebSocketHandlers")
  }
  // Proposed shape only. Reconcile with the F3 product export before running.
  const handlers = create({ app })
  if (typeof handlers?.fetch !== "function" || !handlers.websocket
    || typeof handlers.websocket.open !== "function"
    || typeof handlers.websocket.message !== "function"
    || typeof handlers.websocket.close !== "function") {
    throw new Error("C12 native adapter not wired: expected production fetch/open/message/close callbacks")
  }
  return handlers
}

function observedCallbacks(production) {
  const observedSockets = new WeakMap()
  function socketFor(nativeSocket) {
    const existing = observedSockets.get(nativeSocket)
    if (existing) return existing.proxy
    const record = { connection_id: nextConnectionId++, received: [], sent: [] }
    observation.connections.push(record)
    observeWithoutAffectingGateway(persistGatewayObservation)
    const proxy = new Proxy(nativeSocket, {
      get(target, property) {
        if (property === "send") return (...args) => {
          const result = target.send(...args)
          // Bun -1 is accepted/enqueued with pressure; 0 is dropped.
          if (result !== 0) {
            observeJsonText(args[0], record.sent)
            observeWithoutAffectingGateway(persistGatewayObservation)
          }
          return result
        }
        if (property === "close") return (...args) => {
          observeWithoutAffectingGateway(() => nativeLog({ kind: "native_close", connection_id: record.connection_id, code: args[0] ?? null }))
          return target.close(...args)
        }
        const value = Reflect.get(target, property, target)
        return typeof value === "function" ? value.bind(target) : value
      },
      set(target, property, value) { return Reflect.set(target, property, value, target) },
    })
    observedSockets.set(nativeSocket, { proxy, record })
    return proxy
  }
  return {
    fetch(request, server) {
      const path = new URL(request.url).pathname
      if (request.method === "POST" && (path === "/v1/responses" || path === "/responses")) {
        observation.http_posts++
        observeWithoutAffectingGateway(persistGatewayObservation)
      }
      return production.fetch(request, server)
    },
    websocket: {
      ...production.websocket,
      open(socket) { return production.websocket.open(socketFor(socket)) },
      message(socket, message) {
        const proxy = socketFor(socket)
        if (typeof message === "string") {
          const record = observedSockets.get(socket).record
          observeJsonText(message, record.received)
          observeWithoutAffectingGateway(persistGatewayObservation)
        }
        return production.websocket.message(proxy, message)
      },
      close(socket, code, reason) {
        return production.websocket.close(socketFor(socket), code, reason)
      },
      drain(socket) { return production.websocket.drain?.(socketFor(socket)) },
      ...(typeof production.websocket.error === "function"
        ? { error(socket, error) { return production.websocket.error(socketFor(socket), error) } }
        : {}),
    },
  }
}

async function main() {
  // Importing the future production callback module happens before opening
  // listening sockets. Missing F3 code therefore fails closed, not with 426
  // or a scripted WebSocket imitation.
  const { app } = await import(pathToFileURL(join(SOURCE, "vnext/packages/gateway/src/app.ts")).href)
  const production = await loadProductionCallbacks(app)
  const { bootstrapBunPlatform } = await import(pathToFileURL(join(SOURCE, "vnext/apps/platform-bun/src/bootstrap.ts")).href)
  const { getRepo } = await import(pathToFileURL(join(SOURCE, "vnext/packages/gateway/src/repo/index.ts")).href)

  let nodeUpstream
  let gateway
  try {
    persistGatewayObservation()
    nodeUpstream = await startIndependentNodeUpstream()
    const dbPath = join(RUN, "native-client.sqlite")
    bootstrapBunPlatform({ dbPath, filesRoot: join(RUN, "files") })
    const now = new Date().toISOString()
    await getRepo().users.create({ id: OWNER_ID, name: "C12 Fixture", disabled: false, createdAt: now })
    await getRepo().apiKeys.save({
      id: "c12-fixture-key", ownerId: OWNER_ID, name: "C12 local fixture", key: KEY,
      createdAt: now, responsesRetentionSeconds: 0, dumpRetentionSeconds: null,
      modelMappingsEnabled: false, modelMappings: [], webSearchEnabled: false,
    })
    await getRepo().upstreams.save({
      id: "custom:c12-loopback", ownerId: OWNER_ID, provider: "custom", name: "C12 loopback upstream",
      enabled: true, sortOrder: 0,
      config: {
        name: "C12 loopback upstream", baseUrl: `${nodeUpstream.base}/v1`,
        authStyle: "none", endpoints: ["responses"], models: [MODEL],
      },
      flagOverrides: {}, disabledPublicModelIds: [], state: null,
      proxyFallbackList: [{ id: "direct_fetch" }], createdAt: now, updatedAt: now,
    })
    const callbacks = observedCallbacks(production)
    gateway = Bun.serve({
      hostname: "127.0.0.1", port: 0, idleTimeout: 255,
      fetch: callbacks.fetch, websocket: callbacks.websocket,
    })
    const gatewayBaseUrl = `http://127.0.0.1:${gateway.port}`
    const fixtureBaseUrl = nodeUpstream.base
    writeFileSync(runtimePath, JSON.stringify({
      gatewayBaseUrl, fixtureBaseUrl, apiKey: KEY, dbPath,
      source: SOURCE, observation: `${fixtureBaseUrl}/__fixture/c12`,
    }, null, 2))
    console.log(`fixture-ready ${runtimePath}`)

    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      gateway.stop(true)
      if (nodeUpstream.child.exitCode === null) {
        const exited = new Promise(resolveExit => nodeUpstream.child.once("exit", resolveExit))
        nodeUpstream.child.kill("SIGTERM")
        await exited
      }
      process.exit(0)
    }
    process.once("SIGINT", () => { void stop() })
    process.once("SIGTERM", () => { void stop() })
  } catch (error) {
    gateway?.stop(true)
    nodeUpstream?.child.kill("SIGTERM")
    throw error
  }
}

if (IS_NODE_UPSTREAM) await runNodeUpstream()
else await main()
