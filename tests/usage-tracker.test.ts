import { describe, test, expect, afterEach } from "bun:test"
import { trackStreamingUsage } from "../src/middleware/usage"
import { setRepoForTest } from "../src/repo"
import type { Repo } from "../src/repo"

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

    const upstream = new Response(sse([
      { type: "message_start", message: { usage: {
        input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 10,
      } } },
      { type: "message_delta", usage: { output_tokens: 5 } },
      { type: "message_delta", usage: { output_tokens: 12 } },
      { type: "message_delta", usage: { output_tokens: 27 } },
      { type: "message_delta", usage: { output_tokens: 42 } },
      { type: "message_stop" },
    ]))

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

    const upstream = new Response(sse([
      { choices: [{ delta: { content: "Hi" } }] },
      { choices: [{ delta: { content: "!" } }] },
      { choices: [], usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 } },
    ]))

    await drain(trackStreamingUsage(upstream, "k1", "gpt-4o-mini"))
    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({ inputTokens: 30, outputTokens: 8 })
  })
})

describe("trackStreamingUsage — Responses response.completed", () => {
  test("response.completed.usage 覆盖累计", async () => {
    const captured: Captured[] = []
    setRepoForTest(makeMockRepo(captured) as unknown as Repo)

    const upstream = new Response(sse([
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hello" },
      { type: "response.completed", response: { usage: { input_tokens: 200, output_tokens: 50 } } },
    ]))

    await drain(trackStreamingUsage(upstream, "k1", "gpt-5"))
    expect(captured.length).toBe(1)
    expect(captured[0]).toMatchObject({ inputTokens: 200, outputTokens: 50 })
  })
})
