import { expect, test } from "bun:test"
import { BrowserPerformance } from "./browser-performance"
import { parseOpenAIStream } from "./streams/openai"
import { parseAnthropicStream } from "./streams/anthropic"
import { parseGeminiStream } from "./streams/gemini"

const text = (content: string) => ({ choices: [{ delta: { content } }] })

test("browser separates first output, first text, generation span and complete request", () => {
  let now = 100
  const p = new BrowserPerformance(() => now)
  p.beginResponse("chat_completions")
  now = 200
  p.observe({ choices: [{ delta: { role: "assistant", content: "" } }] })
  now = 400
  p.observe({ choices: [{ delta: { reasoning_content: "think" } }] })
  now = 700
  p.observe(text("hello"))
  now = 900
  p.observe(text(" world"))
  p.observe({ usage: { prompt_tokens: 100, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } } })
  p.observe("[DONE]")
  now = 1100
  const result = p.finish("success")
  expect(result.metrics).toMatchObject({ totalMs: 1000, ttftMs: 300, firstTextMs: 600, generationMs: 500, overallTps: 30, outputTokens: 30, reasoningTokens: 20, maxGapMs: 300 })
  expect(result.gaps?.count).toBe(2)
  expect(result.gaps?.sum).toBe(500)
  expect(result.metrics.cachedInputTokens).toBeUndefined()
  now = 5000
  expect(p.finish("error")).toEqual(result)
})

test("missing usage and single output do not fabricate rates or zero tokens", () => {
  let now = 0
  const p = new BrowserPerformance(() => now)
  p.beginResponse("messages")
  now = 50
  p.observe({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } })
  now = 100
  p.observe({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } })
  now = 200
  const result = p.finish("cancelled")
  expect(result.outcome).toBe("cancelled")
  expect(result.metrics.ttftMs).toBe(100)
  for (const metric of ["outputTokens", "firstTextMs", "generationMs", "overallTps", "gapMs"] as const) expect(result.metrics[metric]).toBeUndefined()
})

test("pause-turn continuations sum per-response cumulative usage once and retain the whole send clock", () => {
  let now = 0
  const p = new BrowserPerformance(() => now)
  p.beginResponse("messages")
  p.observe({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } })
  now = 100
  p.observe({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "query" } })
  p.observe({ type: "message_delta", usage: { output_tokens: 8 } })
  p.observe({ type: "message_delta", usage: { output_tokens: 8 } })
  p.observe({ type: "message_stop" })
  now = 1000
  p.beginResponse("messages")
  p.observe({ type: "message_start", message: { usage: { input_tokens: 20, cache_read_input_tokens: 0 } } })
  now = 1100
  p.observe({ type: "content_block_delta", delta: { type: "text_delta", text: "answer" } })
  now = 1200
  p.observe({ type: "message_delta", usage: { output_tokens: 12 } })
  p.observe({ type: "message_stop" })
  const result = p.finish("success")
  expect(result.metrics).toMatchObject({ inputTokens: 35, outputTokens: 20, cachedInputTokens: 5, ttftMs: 100, firstTextMs: 1100, totalMs: 1200, generationMs: 1000 })
  expect(result.responses).toBe(2)
  expect(result.outcome).toBe("success")
})

test("EOF without a terminal event is an error, while completed output without usage is valid", () => {
  const p = new BrowserPerformance(() => 10)
  p.beginResponse("chat_completions")
  p.observe(text("partial"))
  expect(p.finish("success").outcome).toBe("error")
  const complete = new BrowserPerformance(() => 10)
  complete.beginResponse("chat_completions")
  complete.observe({ choices: [{ delta: { content: "final" }, finish_reason: "stop" }] })
  expect(complete.finish("success").outcome).toBe("success")
})

test("Messages partial cumulative usage preserves cache components and resets them for each response", () => {
  const p = new BrowserPerformance(() => 0)
  p.beginResponse("messages")
  p.observe({ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 } } })
  p.observe({ type: "message_delta", usage: { input_tokens: 200, output_tokens: 10 } })
  p.observe({ type: "message_delta", usage: { cache_creation_input_tokens: 25 } })
  p.observe({ type: "message_stop" })
  p.beginResponse("messages")
  p.observe({ type: "message_start", message: { usage: { input_tokens: 0, cache_read_input_tokens: 0 } } })
  p.observe({ type: "message_delta", usage: { output_tokens: 0 } })
  p.observe({ type: "message_stop" })
  expect(p.finish("success").metrics).toMatchObject({ inputTokens: 275, cachedInputTokens: 50, outputTokens: 10 })

  const missing = new BrowserPerformance(() => 0)
  missing.beginResponse("messages")
  missing.observe({ type: "message_start", message: { usage: { cache_read_input_tokens: 50, output_tokens: 0 } } })
  missing.observe({ type: "message_stop" })
  expect(missing.finish("success").metrics.inputTokens).toBeUndefined()
})

test("an unreported continuation makes aggregate token usage unknown", () => {
  const p = new BrowserPerformance(() => 0)
  p.beginResponse("chat_completions")
  p.observe({ usage: { completion_tokens: 20 } })
  p.beginResponse("chat_completions")
  expect(p.finish("error").metrics.outputTokens).toBeUndefined()
})

test("gateway JSON fallback suppresses synthetic stream timing but retains total time and reported usage", () => {
  let now = 0
  const p = new BrowserPerformance(() => now)
  p.beginResponse("chat_completions")
  p.unavailableStreamingTiming()
  now = 100
  p.observe(text("one"))
  now = 110
  p.observe(text("two"))
  p.observe({ usage: { completion_tokens: 20 } })
  p.observe("[DONE]")
  const result = p.finish("success")
  expect(result.metrics.totalMs).toBe(110)
  expect(result.metrics.outputTokens).toBe(20)
  for (const metric of ["ttftMs", "firstTextMs", "generationMs", "maxGapMs"] as const) expect(result.metrics[metric]).toBeUndefined()
  expect(result.gaps).toBeUndefined()
})

test("all browser parsers observe raw reasoning and tool events even when they emit no visible text", async () => {
  const body = (events: unknown[]) => new Response(events.map(e => "data: " + JSON.stringify(e) + "\n\n").join("")).body!
  const cases = [
    { parse: parseOpenAIStream, events: [{ choices: [{ delta: { reasoning_content: "reasoning" } }] }, text("visible")] },
    { parse: parseAnthropicStream, events: [{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } }, { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "visible" } }] },
    { parse: parseGeminiStream, events: [{ candidates: [{ content: { parts: [{ thought: true, text: "reasoning" }] } }] }, { candidates: [{ content: { parts: [{ text: "visible" }] } }] }] },
  ]
  for (const { parse, events } of cases) {
    const observed: unknown[] = []
    const chunks = []
    for await (const chunk of parse(body(events), event => observed.push(event))) chunks.push(chunk)
    expect(observed).toEqual(events)
    expect(chunks.filter(c => c.type === "delta")).toEqual([{ type: "delta", text: "visible" }])
  }
})


test("browser burst timing never claims a model generation rate", () => {
  let now = 0
  const p = new BrowserPerformance(() => now)
  p.beginResponse("responses")
  now = 12000
  p.observe({ type: "response.output_text.delta", delta: "buffered" })
  now = 12001
  p.observe({ type: "response.output_text.delta", delta: " answer" })
  p.observe({ type: "response.completed", response: { usage: { output_tokens: 980, output_tokens_details: { reasoning_tokens: 900 } } } })
  now = 13000
  const result = p.finish("success")
  expect(result.metrics.generationMs).toBe(1)
  expect(result.metrics.overallTps).toBeCloseTo(980 / 13)
  expect(result.metrics).not.toHaveProperty("outputTps")
  expect(result.metrics).not.toHaveProperty("upstreamTps")
})
