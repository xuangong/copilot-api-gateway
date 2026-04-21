import { describe, test, expect, afterEach } from "bun:test"
import { trackNonStreamingUsage, trackStreamingUsage, consumeStreamForUsage } from "../src/middleware/usage"
import { setRepoForTest } from "../src/repo"
import type { Repo } from "../src/repo"
import { anthropicStream, openaiChatStream, responsesStream } from "./fixtures/sse"

interface Captured {
  keyId: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

function makeMockRepo(captured: Captured[]) {
  return {
    usage: {
      record: async (
        keyId: string,
        model: string,
        _hour: string,
        _req: number,
        inputTokens: number,
        outputTokens: number,
        _client: string | undefined,
        cacheReadTokens: number | undefined,
        cacheCreationTokens: number | undefined,
      ) => {
        captured.push({
          keyId,
          model,
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadTokens ?? 0,
          cacheCreationTokens: cacheCreationTokens ?? 0,
        })
      },
    },
    apiKeys: {
      getById: async (_id: string) => null,
      save: async () => {},
    },
  }
}

// deno-lint-ignore no-explicit-any
function sse(events: any[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
      c.close()
    },
  })
}

async function drain(r: Response): Promise<void> {
  const reader = r.body!.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) return
  }
}

afterEach(() => {
  setRepoForTest(null)
})

describe("trackStreamingUsage — Anthropic cumulative semantics", () => {
  test("message_delta usage overwrites, does not accumulate", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    const upstream = new Response(anthropicStream({
      inputTokens: 100, cacheReadTokens: 50, cacheCreationTokens: 10,
      outputDeltas: [5, 12, 27, 42],
    }))

    const wrapped = trackStreamingUsage(upstream, "key-1", "claude-sonnet-4")
    await drain(wrapped)

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      keyId: "key-1",
      inputTokens: 100,
      outputTokens: 42,
      cacheReadTokens: 50,
      cacheCreationTokens: 10,
    })
  })
})

describe("trackStreamingUsage — OpenAI chat-completions末帧 usage", () => {
  test("末帧 usage 作为终值持久化", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    const upstream = new Response(openaiChatStream({
      contentChunks: ["Hi", "!"],
      promptTokens: 30,
      completionTokens: 8,
    }))

    await drain(trackStreamingUsage(upstream, "k1", "gpt-4o-mini"))
    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({ inputTokens: 30, outputTokens: 8 })
  })
})

describe("trackStreamingUsage — Responses response.completed", () => {
  test("response.completed.usage 覆盖累计", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    const upstream = new Response(responsesStream({
      textDeltas: ["Hello"],
      inputTokens: 200,
      outputTokens: 50,
    }))

    await drain(trackStreamingUsage(upstream, "k1", "gpt-5"))
    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({ inputTokens: 200, outputTokens: 50 })
  })
})

describe("extractUsage — OpenAI cached_tokens", () => {
  test("non-streaming: prompt_tokens_details.cached_tokens 拆到 cacheRead, input 减去 cached", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    await trackNonStreamingUsage(
      {
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_tokens_details: { cached_tokens: 600 },
        },
      },
      "k1",
      "gpt-4o",
    )

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      inputTokens: 400,        // 1000 - 600
      outputTokens: 50,
      cacheReadTokens: 600,
      cacheCreationTokens: 0,
    })
  })

  test("non-streaming: 缺 details 时退化为旧行为", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    await trackNonStreamingUsage(
      { usage: { prompt_tokens: 1000, completion_tokens: 50 } },
      "k1",
      "gpt-4o",
    )

    expect(captured[0]).toMatchObject({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 0,
    })
  })
})

describe("extractUsage — Responses input_tokens_details.cached_tokens", () => {
  test("non-streaming: 拆 cached, input 减去 cached", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    await trackNonStreamingUsage(
      {
        usage: {
          input_tokens: 800,
          output_tokens: 120,
          input_tokens_details: { cached_tokens: 500 },
        },
      },
      "k1",
      "gpt-5",
    )

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      inputTokens: 300,        // 800 - 500
      outputTokens: 120,
      cacheReadTokens: 500,
    })
  })
})

describe("applyStreamEvent — cached_tokens in stream end frame", () => {
  test("OpenAI 流末帧含 cached_tokens", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    const upstream = new Response(sse([
      { choices: [{ delta: { content: "x" } }] },
      { choices: [], usage: {
        prompt_tokens: 500, completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 300 },
      } },
    ]))
    await drain(trackStreamingUsage(upstream, "k1", "gpt-4o-mini"))

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      inputTokens: 200, outputTokens: 10, cacheReadTokens: 300,
    })
  })

  test("Responses 流 response.completed 含 cached_tokens", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    const upstream = new Response(sse([
      { type: "response.completed", response: { usage: {
        input_tokens: 700, output_tokens: 40,
        input_tokens_details: { cached_tokens: 450 },
      } } },
    ]))
    await drain(trackStreamingUsage(upstream, "k1", "gpt-5"))

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      inputTokens: 250, outputTokens: 40, cacheReadTokens: 450,
    })
  })
})

describe("consumeStreamForUsage — works on tee'd upstream branch", () => {
  test("captures end-frame usage even when other branch is transformed", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    const upstream = sse([
      { choices: [{ delta: { content: "hi" } }] },
      { choices: [], usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 } },
    ])

    const [a, b] = upstream.tee()
    consumeStreamForUsage(a, "k1", "gemini-2.0-flash", "vscode")

    // Drain the other branch (simulating downstream transform consumer)
    const reader = b.getReader()
    while (true) { const { done } = await reader.read(); if (done) break }

    // give microtasks a chance
    await new Promise((r) => setTimeout(r, 20))

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({ inputTokens: 11, outputTokens: 22, model: "gemini-2.0-flash" })
  })
})

describe("trackNonStreamingUsage — raw ChatCompletionResponse shape (regression: routes must not re-wrap)", () => {
  test("full ChatCompletionResponse with prompt_tokens_details.cached_tokens yields non-zero cacheRead", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    // This is the exact shape that ChatCompletionResponse produces upstream.
    // responses.ts and gemini.ts previously re-wrapped this into
    // { usage: { input_tokens, output_tokens } }, losing cached_tokens.
    const chatResponse = {
      id: "chatcmpl-abc123",
      object: "chat.completion",
      created: 1700000000,
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        total_tokens: 1050,
        prompt_tokens_details: { cached_tokens: 800 },
        completion_tokens_details: { reasoning_tokens: 0 },
      },
    }

    await trackNonStreamingUsage(chatResponse, "k-regression", "gpt-4o")

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      inputTokens: 200,        // 1000 - 800
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
    })
  })
})

describe("trackStreamingUsage — SSE ping heartbeat frames are ignored", () => {
  test("injected 'event: ping\\ndata: {}\\n\\n' frames do not corrupt usage extraction", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    // Mirror what createIdleHeartbeatStream emits: real SSE data frames
    // interleaved with Anthropic's official ping keepalive frames.
    const enc = new TextEncoder()
    const messageStart = enc.encode(
      `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 80, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 0 } } })}\n\n`,
    )
    const ping = enc.encode("event: ping\ndata: {}\n\n")
    const messageDelta = enc.encode(
      `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 35 } })}\n\n`,
    )

    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(messageStart)
        c.enqueue(ping)          // heartbeat injected between real frames
        c.enqueue(messageDelta)
        c.enqueue(ping)          // heartbeat injected after last real frame
        c.close()
      },
    }))

    await drain(trackStreamingUsage(upstream, "k-ping", "claude-sonnet-4"))

    // The tracker only processes lines starting with "data: ", so the
    // "event: ping" line is silently skipped and "data: {}" produces a
    // no-op JSON parse (no recognised usage fields). Token counts must
    // exactly match the real message_start / message_delta frames.
    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      keyId: "k-ping",
      inputTokens: 80,
      outputTokens: 35,
      cacheReadTokens: 20,
      cacheCreationTokens: 5,
    })
  })
})

describe("trackStreamingUsage — OpenAI SSE comment keepalive frames are ignored", () => {
  test("injected ': keepalive\\n\\n' SSE comment lines do not corrupt usage extraction", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    // Hand-craft a stream interleaving real OpenAI chat chunks with
    // ": keepalive\n\n" SSE comment heartbeats (Plan C injection).
    // SSE comment lines start with ":" and are spec-defined no-ops;
    // the usage tracker only processes "data: " prefix lines.
    const enc = new TextEncoder()
    const contentChunk = enc.encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
    )
    const keepalive = enc.encode(": keepalive\n\n")
    const usageFrame = enc.encode(
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 42, completion_tokens: 17 },
      })}\n\n`,
    )
    const done = enc.encode("data: [DONE]\n\n")

    const upstream = new Response(new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(contentChunk)
        c.enqueue(keepalive)          // heartbeat between content and usage
        c.enqueue(usageFrame)
        c.enqueue(keepalive)          // heartbeat after usage frame
        c.enqueue(done)
        c.close()
      },
    }))

    await drain(trackStreamingUsage(upstream, "k-openai-keepalive", "gpt-4o"))

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      keyId: "k-openai-keepalive",
      inputTokens: 42,
      outputTokens: 17,
    })
  })
})

describe("consumeStreamForUsage — Gemini alt=sse ': keepalive' comment lines are ignored", () => {
  test("injected ': keepalive\\n\\n' SSE comment lines do not corrupt Gemini usage extraction", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    // Hand-craft a Gemini alt=sse stream interleaved with ": keepalive\n\n"
    // SSE comment heartbeats (Plan D injection). The upstream is in OpenAI
    // chat-completions SSE format (what Copilot returns), which consumeStreamForUsage
    // reads directly. SSE comment lines start with ":" and are spec-defined no-ops;
    // the usage tracker only processes "data: " prefix lines.
    const enc = new TextEncoder()
    const contentChunk = enc.encode(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`,
    )
    const keepalive = enc.encode(": keepalive\n\n")
    const usageFrame = enc.encode(
      `data: ${JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 55, completion_tokens: 13 },
      })}\n\n`,
    )
    const done = enc.encode("data: [DONE]\n\n")

    const upstream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(contentChunk)
        c.enqueue(keepalive)          // heartbeat between content and usage
        c.enqueue(usageFrame)
        c.enqueue(keepalive)          // heartbeat after usage frame
        c.enqueue(done)
        c.close()
      },
    })

    consumeStreamForUsage(upstream, "k-gemini-keepalive", "gemini-3-flash-preview", "gemini-cli")

    // give microtasks a chance to flush
    await new Promise((r) => setTimeout(r, 20))

    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({
      keyId: "k-gemini-keepalive",
      model: "gemini-3-flash-preview",
      inputTokens: 55,
      outputTokens: 13,
    })
  })
})

describe("trackStreamingUsage — multi-byte UTF-8 spanning chunk boundary", () => {
  test("UTF-8 字符被切成两半时，仍能正确解析后续 usage 末帧", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as never)

    // Construct a payload where "你好世界" may span a chunk boundary
    const payload = JSON.stringify({
      choices: [{ delta: { content: "你好世界" } }],
    })
    const usagePayload = JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 4 },
    })
    const enc = new TextEncoder()
    const fullA = enc.encode(`data: ${payload}\n\n`)
    const fullB = enc.encode(`data: ${usagePayload}\n\n`)
    // Deliberately cut in the middle of fullA (may land in a multi-byte char)
    const cut = Math.floor(fullA.length / 2)
    const part1 = fullA.slice(0, cut)
    const part2 = fullA.slice(cut)

    const upstream = new Response(new ReadableStream({
      start(c) {
        c.enqueue(part1)
        c.enqueue(part2)
        c.enqueue(fullB)
        c.close()
      },
    }))

    await drain(trackStreamingUsage(upstream, "k1", "gpt-4o-mini"))
    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({ inputTokens: 50, outputTokens: 4 })
  })
})
