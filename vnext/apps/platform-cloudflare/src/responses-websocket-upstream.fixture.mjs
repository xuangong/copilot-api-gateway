import { createServer } from "node:http"

const requests = []
const closes = []
const held = new Map()
let serial = 0

function json(response, value) {
  const body = JSON.stringify(value)
  response.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  response.end(body)
}

function event(value) {
  return `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`
}

const server = createServer((request, response) => { void (async () => {
  const path = new URL(request.url, "http://127.0.0.1").pathname
  if (request.method === "GET" && path === "/__fixture/state") {
    json(response, { requests, closes, held: held.size })
    return
  }
  if (request.method === "POST" && path === "/__fixture/release") {
    for (const finish of held.values()) finish()
    json(response, { released: held.size })
    return
  }
  if (request.method !== "POST" || path !== "/v1/responses") {
    response.writeHead(404)
    response.end()
    return
  }
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  requests.push(body)
  const id = `resp_c12_f4_node_${++serial}`
  const base = { id, object: "response", model: "gpt-5.4", output: [], error: null, usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }
  let timer
  response.on("close", () => {
    if (timer) clearInterval(timer)
    held.delete(id)
    closes.push({ id, finished: response.writableEnded })
  })
  response.writeHead(200, { "content-type": "text/event-stream" })
  response.write(event({ type: "response.created", response: { ...base, status: "in_progress" } }))
  const finish = () => response.end(event({ type: "response.completed", response: { ...base, status: "completed" } }))
  held.set(id, finish)
  if (JSON.stringify(body.input).includes("pressure-flood")) {
    const delta = "p".repeat(240_000)
    for (let index = 0; index < 80 && !response.destroyed; index++) {
      const ready = response.write(event({ type: "response.output_text.delta", item_id: `item_${id}`, output_index: 0, content_index: 0, delta, probe_index: index }))
      if (!ready && !response.destroyed) await new Promise(resolve => {
        const done = () => { response.off("drain", done); response.off("close", done); resolve() }
        response.once("drain", done)
        response.once("close", done)
      })
    }
    if (!response.destroyed) timer = setInterval(() => response.write(": held\n\n"), 100)
  }
})().catch(() => { if (!response.headersSent) response.writeHead(500); response.end() }) })

server.listen(0, "127.0.0.1", () => {
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Fixture has no TCP address")
  console.log(JSON.stringify({ port: address.port }))
})

process.once("SIGTERM", () => { server.closeAllConnections(); server.close(() => process.exit(0)) })
