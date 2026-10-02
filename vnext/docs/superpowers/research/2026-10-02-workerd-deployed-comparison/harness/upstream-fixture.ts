// Reused from 2026-09-30-cfw-request-boundaries/harness/upstream-fixture.ts; see README provenance.
interface Env { FIXTURE_SECRET: string; LOG_DB?: { prepare(sql: string): { bind(...values: unknown[]): { all(): Promise<{ results: unknown[] }>; run(): Promise<unknown> }; run(): Promise<unknown> } } }
type Obj = Record<string, unknown>
const enc = new TextEncoder()
const sse = (event: Obj) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`
const data = (event: Obj) => `data: ${JSON.stringify(event)}\n\n`
export async function fixture(req: Request, env: Env): Promise<Response> {
  if (!env.FIXTURE_SECRET || req.headers.get("authorization") !== `Bearer ${env.FIXTURE_SECRET}`) return new Response("Unauthorized", { status: 401 })
  const path = new URL(req.url).pathname
  if (path === "/__fixture/counts") {
    if (!env.LOG_DB) return Response.json({ available: false })
    const run = new URL(req.url).searchParams.get("run")
    if (!run || !/^[a-zA-Z0-9_-]{8,40}$/.test(run)) return new Response("Valid run prefix required", { status: 400 })
    const rows = await env.LOG_DB.prepare("SELECT request_id,COUNT(*) AS dispatches FROM fixture_dispatch WHERE request_id >= ? AND request_id < ? GROUP BY request_id LIMIT 100001").bind(run+"_", run+"`" ).all()
    return Response.json({ available: true, rows: rows.results })
  }
  if (path === "/__fixture/reset" && req.method === "POST") {
    if (env.LOG_DB) await env.LOG_DB.prepare("DELETE FROM fixture_dispatch").run()
    return Response.json({ reset: true, dispatch_counts_available: Boolean(env.LOG_DB) })
  }
  if (req.method !== "POST" || !["/v1/responses", "/v1/chat/completions", "/v1/messages"].includes(path)) return new Response("Not found", { status: 404 })
  const raw = await req.text()
  let body: Obj
  try { body = JSON.parse(raw) as Obj } catch { return new Response("Invalid JSON", { status: 400 }) }
  const model = String(body.model ?? "")
  const match = /^bench-(responses|chat|messages)-(ok|tool|refusal|failed|truncated|http503|slow)$/.exec(model)
  if (!match) return new Response("Unknown fixture model", { status: 400 })
  const protocol = path.endsWith("responses") ? "responses" : path.endsWith("messages") ? "messages" : "chat"
  if (match[1] !== protocol) return new Response("Unexpected upstream protocol", { status: 422 })
  const scenario = match[2]
  const requestId = /BENCH_ID:([a-zA-Z0-9_-]+)/.exec(raw)?.[1] ?? "missing"
  if (env.LOG_DB) await env.LOG_DB.prepare("INSERT INTO fixture_dispatch(request_id,protocol,scenario,received_at) VALUES(?,?,?,?)").bind(requestId, protocol, scenario, Date.now()).run()
  const payload = /BENCH_PAYLOAD:(x*):END_PAYLOAD/.exec(raw)?.[1]
  if (payload === undefined || requestId === "missing") return Response.json({ error: { message: "Fixture input markers missing", type: "invalid_request_error" } }, { status: 422 })
  if (scenario === "http503") return Response.json({ error: { message: "Synthetic unavailable", type: "server_error" } }, { status: 503 })
  const text = `BENCH_OK:${payload.length}`
  const refusal = "BENCH_REFUSAL"
  const args = '{"city":"Paris"}'
  const tool = scenario === "tool"
  const refused = scenario === "refusal"
  const id = `resp_${requestId}`
  const item = tool ? { id: "fc_bench", type: "function_call", call_id: "call_bench", name: "weather", arguments: args, status: "completed" } : { id: "msg_bench", type: "message", role: "assistant", status: "completed", content: [refused ? { type: "refusal", refusal } : { type: "output_text", text, annotations: [] }] }
  const response = { id, object: "response", created_at: 1790726400, status: "completed", model, output: [item], error: null, incomplete_details: null, usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 } }
  const message = { id: `msg_${requestId}`, type: "message", role: "assistant", model, content: tool ? [{ type: "tool_use", id: "call_bench", name: "weather", input: { city: "Paris" } }] : [{ type: "text", text: refused ? refusal : text }], stop_reason: tool ? "tool_use" : refused ? "refusal" : "end_turn", stop_sequence: null, usage: { input_tokens: 7, output_tokens: 3 } }
  const chat = { id: `chatcmpl_${requestId}`, object: "chat.completion", created: 1790726400, model, choices: [{ index: 0, message: { role: "assistant", content: tool || refused ? null : text, ...(refused ? { refusal } : {}), ...(tool ? { tool_calls: [{ id: "call_bench", type: "function", function: { name: "weather", arguments: args } }] } : {}) }, finish_reason: tool ? "tool_calls" : refused ? "content_filter" : "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }
  if (!body.stream) {
    if (["failed", "truncated"].includes(String(scenario))) return Response.json({ error: { message: "Synthetic upstream failure", type: "server_error" } }, { status: 502 })
    return Response.json(protocol === "responses" ? response : protocol === "messages" ? message : chat)
  }
  let prefix: string[] = [], finish: string[] = []
  if (protocol === "responses") {
    prefix = [sse({ type: "response.created", response: { ...response, status: "in_progress", output: [], usage: null } }), sse({ type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", ...(tool ? { arguments: "" } : { content: [] }) } })]
    if (!tool) prefix.push(sse({ type: "response.content_part.added", item_id: "msg_bench", output_index: 0, content_index: 0, part: refused ? { type: "refusal", refusal: "" } : { type: "output_text", text: "", annotations: [] } }))
    prefix.push(sse(tool ? { type: "response.function_call_arguments.delta", item_id: "fc_bench", output_index: 0, delta: args } : { type: refused ? "response.refusal.delta" : "response.output_text.delta", item_id: "msg_bench", output_index: 0, content_index: 0, delta: refused ? refusal : text }))
    finish = [sse(tool ? { type: "response.function_call_arguments.done", item_id: "fc_bench", output_index: 0, arguments: args } : { type: refused ? "response.refusal.done" : "response.output_text.done", item_id: "msg_bench", output_index: 0, content_index: 0, ...(refused ? { refusal } : { text }) }), sse({ type: "response.output_item.done", output_index: 0, item }), sse({ type: "response.completed", response })]
  } else if (protocol === "chat") {
    const chunk = (delta: Obj, reason: string | null = null, usage: Obj | undefined = undefined) => data({ id: chat.id, object: "chat.completion.chunk", created: chat.created, model, choices: [{ index: 0, delta, finish_reason: reason }], ...(usage ? { usage } : {}) })
    prefix = [chunk({ role: "assistant" }), chunk(tool ? { tool_calls: [{ index: 0, id: "call_bench", type: "function", function: { name: "weather", arguments: args } }] } : refused ? { refusal } : { content: text })]
    finish = [chunk({}, tool ? "tool_calls" : refused ? "content_filter" : "stop", chat.usage), "data: [DONE]\n\n"]
  } else {
    prefix = [sse({ type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } }), sse({ type: "content_block_start", index: 0, content_block: tool ? { type: "tool_use", id: "call_bench", name: "weather", input: {} } : { type: "text", text: "" } }), sse({ type: "content_block_delta", index: 0, delta: tool ? { type: "input_json_delta", partial_json: args } : { type: "text_delta", text: refused ? refusal : text } })]
    finish = [sse({ type: "content_block_stop", index: 0 }), sse({ type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 3 } }), sse({ type: "message_stop" })]
  }
  if (scenario === "truncated") finish = []
  if (scenario === "failed") finish = [sse(protocol === "responses" ? { type: "response.failed", response: { ...response, status: "failed", error: { code: "server_error", message: "Synthetic partial failure" } } } : { type: "error", error: { type: "api_error", message: "Synthetic partial failure" } })]
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const frame of [...prefix, ...finish]) {
          await new Promise(resolve => setTimeout(resolve, scenario === "slow" ? 250 : 5))
          if (cancelled) return
          controller.enqueue(enc.encode(frame))
        }
        if (!cancelled) controller.close()
      } catch { if (!cancelled) controller.error(new Error("Fixture stream failed")) }
    },
    cancel() { cancelled = true },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } })
}
export default { fetch: fixture }
