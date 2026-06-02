import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { setRepoForTest, getRepo } from "~/repo"
import { SqliteRepo } from "~/repo/sqlite"
import { interceptResponsesViaChat } from "~/services/web-search/responses-interceptor"
import { synthResponsesSSE } from "~/services/web-search/responses-sse-synth"
import type { ResponsesPayload } from "~/transforms/types"

interface ChatStubBehavior {
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  content?: string
}

interface FetchStubState {
  chatBehaviors: ChatStubBehavior[]
  chatCallCount: number
  langsearchCallCount: number
  chatBodies: Array<Record<string, unknown>>
}

function installFetchStub(state: FetchStubState): () => void {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString()

    if (url.includes("/chat/completions")) {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
      state.chatBodies.push(body)
      const behavior = state.chatBehaviors[state.chatCallCount] ?? {
        content: "default reply",
      }
      state.chatCallCount++
      const toolCalls = behavior.toolCalls?.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: c.arguments },
      }))
      const message: Record<string, unknown> = {
        role: "assistant",
        content: behavior.content ?? null,
      }
      if (toolCalls && toolCalls.length > 0) message.tool_calls = toolCalls
      return new Response(
        JSON.stringify({
          id: `chatcmpl-${state.chatCallCount}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: (body.model as string) ?? "gpt-4o",
          choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    if (url.includes("langsearch.com")) {
      state.langsearchCallCount++
      return new Response(
        JSON.stringify({
          code: 200,
          msg: null,
          data: {
            webPages: {
              value: [
                {
                  name: "Example Result",
                  url: "https://example.com/a",
                  snippet: "snippet text",
                  summary: "summary text",
                },
              ],
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }

    throw new Error(`Unstubbed fetch: ${url}`)
  }) as typeof fetch
  return () => {
    globalThis.fetch = originalFetch
  }
}

const baseOptions = () => ({
  copilotToken: "tok",
  accountType: "individual" as const,
  engineOptions: { langsearchKey: "ls-key" },
  apiKeyId: "k_test",
})

const userPayload = (text: string): ResponsesPayload => ({
  model: "gpt-4o",
  input: [{ type: "message", role: "user", content: text }],
})

describe("interceptResponsesViaChat", () => {
  let state: FetchStubState
  let restore: () => void

  beforeEach(() => {
    const db = new Database(":memory:")
    setRepoForTest(new SqliteRepo(db))
    state = { chatBehaviors: [], chatCallCount: 0, langsearchCallCount: 0, chatBodies: [] }
    restore = installFetchStub(state)
  })

  afterEach(() => {
    restore()
  })

  test("turn 1: mints ws_gw_* id, splices web_search_call into output, persists private payload", async () => {
    state.chatBehaviors = [
      {
        toolCalls: [{ id: "call_1", name: "web_search", arguments: JSON.stringify({ query: "hi" }) }],
      },
      { content: "the answer" },
    ]

    const result = await interceptResponsesViaChat(userPayload("ask me"), baseOptions())

    expect(state.chatCallCount).toBe(2)
    expect(state.langsearchCallCount).toBe(1)
    expect(result.mintedItems.length).toBe(1)
    const mintedId = result.mintedItems[0]!.id
    expect(mintedId).toMatch(/^ws_gw_[0-9a-f]{24}$/)
    expect(result.meta.searchCount).toBe(1)

    const output = result.responsesResult.output as Array<{ type: string; id?: string }>
    expect(output[0]?.type).toBe("web_search_call")
    expect(output[0]?.id).toBe(mintedId)
    expect(output.some((o) => o.type === "message")).toBe(true)

    const repo = getRepo()
    const rows = await repo.responsesItems.lookupMany([mintedId])
    expect(rows.length).toBe(1)
    expect(rows[0]!.privateJson).toBeTruthy()
    const priv = JSON.parse(rows[0]!.privateJson!) as { query: string; content: string; chatToolCallId: string }
    expect(priv.query).toBe("hi")
    expect(priv.chatToolCallId).toBe("call_1")
    expect(priv.content).toContain("Example Result")
  })

  test("turn 2: echoed web_search_call id restores tool exchange, no new search", async () => {
    state.chatBehaviors = [
      {
        toolCalls: [{ id: "call_1", name: "web_search", arguments: JSON.stringify({ query: "hi" }) }],
      },
      { content: "first answer" },
    ]
    const first = await interceptResponsesViaChat(userPayload("ask me"), baseOptions())
    const mintedId = first.mintedItems[0]!.id

    state.chatBehaviors = [{ content: "follow up answer" }]
    state.chatCallCount = 0
    state.langsearchCallCount = 0
    state.chatBodies = []

    const second = await interceptResponsesViaChat(
      {
        model: "gpt-4o",
        input: [
          { type: "message", role: "user", content: "ask me" },
          { type: "web_search_call", id: mintedId },
          { type: "message", role: "user", content: "follow up" },
        ],
      },
      baseOptions(),
    )

    expect(state.langsearchCallCount).toBe(0)
    expect(state.chatCallCount).toBe(1)
    expect(second.meta.searchCount).toBe(0)
    expect(second.restoredItems.length).toBe(1)
    expect(second.restoredItems[0]!.id).toBe(mintedId)
    expect(second.mintedItems.length).toBe(0)

    const sentMessages = state.chatBodies[0]!.messages as Array<{ role: string; tool_call_id?: string }>
    expect(sentMessages.some((m) => m.role === "tool" && m.tool_call_id === "call_1")).toBe(true)
    expect(sentMessages.some((m) => m.role === "assistant" && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls))).toBe(true)

    const output = second.responsesResult.output as Array<{ type: string; id?: string }>
    expect(output[0]?.type).toBe("web_search_call")
    expect(output[0]?.id).toBe(mintedId)
  })

  test("unknown ws_gw_* id is dropped silently", async () => {
    state.chatBehaviors = [{ content: "answer with no search" }]

    const result = await interceptResponsesViaChat(
      {
        model: "gpt-4o",
        input: [
          { type: "web_search_call", id: "ws_gw_aaaaaaaaaaaaaaaaaaaaaaaa" },
          { type: "message", role: "user", content: "hi" },
        ],
      },
      baseOptions(),
    )

    expect(state.langsearchCallCount).toBe(0)
    expect(result.restoredItems.length).toBe(0)
    expect(result.mintedItems.length).toBe(0)
  })
})

describe("synthResponsesSSE", () => {
  let state: FetchStubState
  let restore: () => void

  beforeEach(() => {
    const db = new Database(":memory:")
    setRepoForTest(new SqliteRepo(db))
    state = { chatBehaviors: [], chatCallCount: 0, langsearchCallCount: 0, chatBodies: [] }
    restore = installFetchStub(state)
  })

  afterEach(() => {
    restore()
  })

  test("emits web_search_call lifecycle events and response.completed", async () => {
    state.chatBehaviors = [
      {
        toolCalls: [{ id: "call_1", name: "web_search", arguments: JSON.stringify({ query: "hi" }) }],
      },
      { content: "the answer" },
    ]

    const { responsesResult } = await interceptResponsesViaChat(userPayload("ask"), baseOptions())
    const stream = synthResponsesSSE(responsesResult)
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value)
    }

    const eventLines = buf.split("\n").filter((l) => l.startsWith("event: "))
    const eventTypes = eventLines.map((l) => l.slice("event: ".length))

    expect(eventTypes).toContain("response.created")
    expect(eventTypes).toContain("response.in_progress")
    expect(eventTypes).toContain("response.web_search_call.in_progress")
    expect(eventTypes).toContain("response.web_search_call.searching")
    expect(eventTypes).toContain("response.web_search_call.completed")
    expect(eventTypes).toContain("response.output_text.delta")
    expect(eventTypes).toContain("response.output_text.done")
    expect(eventTypes).toContain("response.completed")
    expect(buf.endsWith("data: [DONE]\n\n")).toBe(true)

    const wsIdx = eventTypes.indexOf("response.web_search_call.completed")
    const msgIdx = eventTypes.indexOf("response.output_text.delta")
    expect(wsIdx).toBeLessThan(msgIdx)
  })
})
