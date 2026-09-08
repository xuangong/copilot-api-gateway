import { describe, expect, test } from "bun:test"
import { PerformanceRecorder } from "../src/data-plane/observability/performance-recorder"

describe("PerformanceRecorder", () => {
  test("measures request and actual upstream separately, reasoning before text, gaps and speed", () => {
    let now = 0
    const r = new PerformanceRecorder(true, () => now)
    now = 20
    const u = r.beginUpstream("responses", { reasoning: { effort: "high" } })
    now = 100
    r.observeOutput("responses", { type: "response.created" })
    now = 200
    r.observeOutput("responses", { type: "response.reasoning_text.delta", delta: "r" })
    now = 400
    r.observeOutput("responses", { type: "response.output_text.delta", delta: "answer" })
    u.observe({ type: "response.completed", response: { usage: { input_tokens: 100, output_tokens: 40, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } } } })
    now = 500
    u.finish()
    now = 600
    r.finish("success")
    now = 9000
    const metrics = r.snapshot().metrics
    expect(metrics.totalMs?.sum).toBe(600)
    expect(metrics.upstreamMs?.sum).toBe(480)
    expect(metrics.ttftMs?.sum).toBe(200)
    expect(metrics.firstTextMs?.sum).toBe(400)
    expect(metrics.generationMs?.sum).toBe(200)
    expect(metrics.gapMs?.count).toBe(1)
    expect(metrics.upstreamTps?.sum).toBeCloseTo(40 / 0.48)
    expect(metrics).not.toHaveProperty("outputTps")
    expect(metrics.overallTps?.sum).toBeCloseTo(40 / 0.6)
    expect(metrics.reasoningTokens?.sum).toBe(10)
    expect(r.snapshot()).toMatchObject({ inputBucket: "<1k", cacheStatus: "miss", reasoningEffort: "high" })
  })
  test("no output or one tool chunk cannot invent generation speed or text", () => {
    let now = 0
    const r = new PerformanceRecorder(true, () => now)
    now = 100
    r.observeOutput("messages", { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } })
    now = 500
    r.finish("success")
    expect(r.snapshot().metrics.ttftMs?.sum).toBe(100)
    for (const key of ["firstTextMs", "generationMs", "upstreamTps", "outputTokens", "gapMs", "maxGapMs"] as const) expect(r.snapshot().metrics[key]).toBeUndefined()
  })
  test("JSON synthetic timing and absent usage stay uncollected", () => {
    let now = 0
    const r = new PerformanceRecorder(true, () => now)
    const u = r.beginUpstream("messages", {})
    u.json({ content: [{ type: "text", text: "a" }] })
    now = 200
    r.observeOutput("messages", { type: "content_block_delta", delta: { type: "text_delta", text: "a" } })
    u.finish()
    r.finish("success")
    expect(r.snapshot().metrics.ttftMs).toBeUndefined()
    expect(r.snapshot().metrics.outputTokens).toBeUndefined()
    const nonstream = new PerformanceRecorder(false, () => now)
    nonstream.observeOutput("responses", { type: "response.output_text.delta", delta: "a" })
    nonstream.finish("success")
    expect(nonstream.snapshot().metrics.ttftMs).toBeUndefined()
  })
  test("cancelled start usage is partial; repeated terminal usage is not counted twice", () => {
    const r = new PerformanceRecorder(true, () => 50)
    const u = r.beginUpstream("messages", {})
    u.observe({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } })
    r.finish("cancelled")
    expect(r.snapshot().outcome).toBe("cancelled")
    expect(r.snapshot().metrics.outputTokens).toBeUndefined()
    expect(r.snapshot().metrics.inputTokens?.sum).toBe(10)
  })
  test("Messages input components accumulate independently across partial usage events", () => {
    const r = new PerformanceRecorder(true, () => 50)
    const u = r.beginUpstream("messages", {})
    u.observe({ type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 20 } } })
    u.observe({ type: "message_delta", usage: { input_tokens: 100, output_tokens: 10 } })
    expect(r.snapshot().metrics.inputTokens?.sum).toBe(170)
    u.observe({ type: "message_delta", usage: { input_tokens: 120 } })
    expect(r.snapshot().metrics.inputTokens?.sum).toBe(190)
    u.observe({ type: "message_delta", usage: { cache_read_input_tokens: 60 } })
    expect(r.snapshot().metrics.inputTokens?.sum).toBe(200)
    u.observe({ type: "message_delta", usage: { cache_creation_input_tokens: 25 } })
    expect(r.snapshot().metrics.inputTokens?.sum).toBe(205)
    u.observe({ type: "message_delta", usage: { input_tokens: 95, cache_read_input_tokens: 55, cache_creation_input_tokens: 10 } })
    expect(r.snapshot().metrics.inputTokens?.sum).toBe(205)
    expect(r.snapshot().metrics.cachedInputTokens?.sum).toBe(60)
    const second = r.beginUpstream("messages", {})
    second.observe({ type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } })
    expect(r.snapshot().metrics.inputTokens?.sum).toBe(220)
    expect(r.snapshot().metrics.cachedInputTokens?.sum).toBe(65)
  })
  test("Messages cached input alone does not fabricate base input, but later zero is measured", () => {
    const r = new PerformanceRecorder(true, () => 50)
    const u = r.beginUpstream("messages", {})
    u.observe({ type: "message_start", message: { usage: { cache_read_input_tokens: 20 } } })
    expect(r.snapshot().metrics.inputTokens).toBeUndefined()
    expect(r.snapshot().metrics.cachedInputTokens?.sum).toBe(20)
    u.observe({ type: "message_delta", usage: { input_tokens: 0 } })
    expect(r.snapshot().metrics.inputTokens?.sum).toBe(20)
  })
  test("usage sums across hosted tool calls, missing usage stays unknown and memory bounded", () => {
    let now = 0
    const r = new PerformanceRecorder(true, () => now)
    for (let j = 0; j < 2; j++) {
      const u = r.beginUpstream("chat_completions", {})
      u.observe({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      u.observe({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
      u.finish()
    }
    for (let i = 0; i < 10000; i++) {
      now += i % 7
      r.observeOutput("chat_completions", { choices: [{ delta: { content: "a" } }] })
    }
    r.finish("success")
    expect(r.snapshot().metrics.outputTokens?.sum).toBe(10)
    expect(r.snapshot().metrics.inputTokens?.sum).toBe(20)
    expect(r.snapshot().metrics.gapMs?.count).toBe(9999)
    expect(r.snapshot().metrics.gapMs?.buckets.length).toBeLessThan(50)
  })
})

test("truncated last upstream is an error, while a recovered earlier failure does not taint success", () => {
  const r = new PerformanceRecorder(true, () => 10)
  const u = r.beginUpstream("messages", {})
  u.observe({ type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 0 } } })
  u.endFrames()
  r.finish("success")
  expect(r.snapshot().outcome).toBe("error")
  expect(r.snapshot().metrics.outputTokens).toBeUndefined()
  const recovered = new PerformanceRecorder(true, () => 10)
  recovered.beginUpstream("responses", {}).endFrames()
  const last = recovered.beginUpstream("responses", {})
  last.observe({ type: "response.completed", response: { usage: { output_tokens: 3 } } })
  last.endFrames()
  recovered.finish("success")
  expect(recovered.snapshot().outcome).toBe("success")
  expect(recovered.snapshot().metrics.outputTokens).toBeUndefined()
})


test("buffered output and hidden reasoning cannot turn a long request into a millisecond generation rate", () => {
  for (const outputSpacing of [0, 1, 34]) {
    let now = 0
    const recorder = new PerformanceRecorder(true, () => now)
    const upstream = recorder.beginUpstream("responses", {})
    now = 12000
    recorder.observeOutput("responses", { type: "response.output_text.delta", delta: "A long buffered answer" })
    now += outputSpacing
    recorder.observeOutput("responses", { type: "response.output_text.delta", delta: "." })
    upstream.observe({ type: "response.completed", response: { usage: { output_tokens: 980, output_tokens_details: { reasoning_tokens: 900 } } } })
    now = 12500
    upstream.finish()
    now = 13000
    recorder.finish("success")
    const metrics = recorder.snapshot().metrics
    expect(metrics.generationMs?.sum).toBe(outputSpacing)
    expect(metrics.upstreamTps?.sum).toBeCloseTo(980 / 12.5)
    expect(metrics.overallTps?.sum).toBeCloseTo(980 / 13)
    expect(metrics).not.toHaveProperty("outputTps")
  }
})

test("upstream throughput covers whole calls, excludes tool waits, and works for JSON", () => {
  let now = 0
  const recorder = new PerformanceRecorder(true, () => now)
  const first = recorder.beginUpstream("responses", {})
  now = 1000
  first.json({ usage: { output_tokens: 20 } })
  first.finish()
  now = 10000
  const second = recorder.beginUpstream("responses", {})
  now = 12000
  second.json({ usage: { output_tokens: 40 } })
  second.finish()
  recorder.finish("success")
  const metrics = recorder.snapshot().metrics
  expect(metrics.upstreamMs?.sum).toBe(3000)
  expect(metrics.upstreamTps?.sum).toBe(20)
  expect(metrics.overallTps?.sum).toBe(5)
  expect(metrics).not.toHaveProperty("generationMs")
})

test("missing output usage or zero upstream time cannot produce throughput", () => {
  for (const output of [undefined, 0]) {
    const recorder = new PerformanceRecorder(false, () => 100)
    const upstream = recorder.beginUpstream("responses", {})
    upstream.json({ usage: output === undefined ? {} : { output_tokens: output } })
    upstream.finish()
    recorder.finish("success")
    expect(recorder.snapshot().metrics.upstreamTps).toBeUndefined()
  }
})
