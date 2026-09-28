/** Isolated C11 acceptance server: clean Bun bootstrap/app with counted loopback upstream. */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const gatewaySource = process.env.C11_GATEWAY_SOURCE_ROOT
  ?? "/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify"
const { bootstrapBunPlatform } = await import(`${gatewaySource}/vnext/apps/platform-bun/src/bootstrap.ts`)
const { getRepo } = await import(`${gatewaySource}/vnext/packages/gateway/src/repo/index.ts`)
const { app } = await import(`${gatewaySource}/vnext/packages/gateway/src/app.ts`)

const root = process.env.C11_FIXTURE_RUN_DIR ?? import.meta.dir
mkdirSync(join(root, "logs"), { recursive: true })
const logPath = join(root, "logs", "gateway-acceptance-requests.jsonl")
const runtimePath = join(root, "gateway-acceptance-runtime.json")
const dbPath = join(root, "gateway-acceptance.sqlite")
const apiKey = "sk_c11_local_fixture_only"
const counts = { get: 0, post: 0, upstream: 0, getStatuses: [] as number[], postStatuses: [] as number[] }

const record = (entry: Record<string, unknown>) => {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

const responseId = "resp_c11_gateway_fixture"
const events = [
  { type: "response.created", response: { id: responseId } },
  {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      model: "gpt-5.5",
      status: "completed",
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
    },
  },
]

const upstream = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url)
    record({ component: "upstream", method: request.method, path: url.pathname })
    if (request.method === "POST" && url.pathname === "/v1/responses") counts.upstream++
    if (request.method !== "POST" || url.pathname !== "/v1/responses") {
      return new Response("not found", { status: 404 })
    }
    const stream = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
  },
})

bootstrapBunPlatform({ dbPath, filesRoot: join(root, "files") })
const now = new Date().toISOString()
await getRepo().apiKeys.save({
  id: "c11-fixture-key" as never,
  name: "C11 loopback fixture",
  key: apiKey,
  createdAt: now,
  modelMappingsEnabled: false,
  modelMappings: [],
  webSearchEnabled: false,
})
await getRepo().upstreams.save({
  id: "custom:c11-loopback" as never,
  provider: "custom",
  name: "C11 loopback upstream",
  enabled: true,
  sortOrder: 0,
  config: {
    name: "C11 loopback upstream",
    baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
    authStyle: "none",
    endpoints: ["responses"],
    models: ["gpt-5.5"],
  },
  flagOverrides: {},
  disabledPublicModelIds: [],
  state: null,
  proxyFallbackList: [],
  createdAt: now,
  updatedAt: now,
})

const gateway = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  fetch: async (request, server) => {
    const url = new URL(request.url)
    if (url.pathname === "/__fixture/counts") {
      return Response.json(counts)
    }
    if (url.pathname.startsWith("/v1/")) server.timeout(request, 0)
    const response = await app.fetch(request)
    if (url.pathname === "/v1/responses" && request.method === "POST") {
      void response.clone().text().then((body) => {
        writeFileSync(join(root, "logs", "gateway-post-body.txt"), body)
      }).catch((error) => {
        record({ component: "fixture", captureError: String(error) })
      })
    }
    if (url.pathname === "/v1/responses") {
      if (request.method === "GET") {
        counts.get++
        counts.getStatuses.push(response.status)
      } else if (request.method === "POST") {
        counts.post++
        counts.postStatuses.push(response.status)
      }
    }
    record({
      component: "gateway",
      method: request.method,
      path: url.pathname,
      upgrade: request.headers.get("upgrade") ?? null,
      status: response.status,
    })
    return response
  },
})

writeFileSync(runtimePath, JSON.stringify({
  gatewayBaseUrl: `http://127.0.0.1:${gateway.port}`,
  upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
  dbPath,
  apiKey,
  gatewaySource,
}, null, 2))
console.log(`fixture-ready ${runtimePath}`)

const stop = () => {
  gateway.stop(true)
  upstream.stop(true)
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
