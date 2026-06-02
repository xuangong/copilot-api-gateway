import { describe, expect, test } from "bun:test"

import { classifyCompact, setCompactHeaders } from "~/transforms/set-compact-headers"
import type { AnthropicMessagesPayload } from "~/transforms"

const COMPACT_LAST_MESSAGE_TEXT =
  "Your task is to create a detailed summary of the conversation so far.\n\n"
  + "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\n"
  + "Pending Tasks:\n- finish refactor\n\nCurrent Work:\n- reviewing diff"

const mk = (overrides: Partial<AnthropicMessagesPayload>): AnthropicMessagesPayload =>
  ({
    model: "claude-test",
    max_tokens: 10,
    messages: [],
    ...overrides,
  }) as AnthropicMessagesPayload

describe("setCompactHeaders — compact-request", () => {
  test("last user message carries all three markers", () => {
    const headers: Record<string, string> = {}
    const kind = setCompactHeaders(
      mk({ messages: [{ role: "user", content: COMPACT_LAST_MESSAGE_TEXT }] }),
      headers,
    )
    expect(kind).toBe("compact-request")
    expect(headers["x-initiator"]).toBe("agent")
    expect(headers["x-interaction-type"]).toBe("conversation-compaction")
  })

  test("multi-block last user message — system-reminder block skipped", () => {
    const headers: Record<string, string> = {}
    setCompactHeaders(
      mk({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "<system-reminder>ignore me</system-reminder>" },
              { type: "text", text: "Your task is to create a detailed summary of the conversation so far." },
              { type: "text", text: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.\n\nPending Tasks:\n- x" },
            ],
          },
        ],
      }),
      headers,
    )
    expect(headers["x-interaction-type"]).toBe("conversation-compaction")
  })

  test("string system prompt starts with compact summarization prefix", () => {
    const headers: Record<string, string> = {}
    setCompactHeaders(
      mk({
        system: "You are a helpful AI assistant tasked with summarizing conversations and other things.",
        messages: [{ role: "user", content: "go ahead" }],
      }),
      headers,
    )
    expect(headers["x-initiator"]).toBe("agent")
    expect(headers["x-interaction-type"]).toBe("conversation-compaction")
  })

  test("array system prompt contains compact prefix block", () => {
    const headers: Record<string, string> = {}
    setCompactHeaders(
      mk({
        system: [
          { type: "text", text: "You are an anchored context summarization assistant for coding sessions. ..." },
          { type: "text", text: "unrelated" },
        ],
        messages: [{ role: "user", content: "hi" }],
      }),
      headers,
    )
    expect(headers["x-interaction-type"]).toBe("conversation-compaction")
  })

  test("overrides prior x-initiator: user from setInitiatorHeader", () => {
    const headers: Record<string, string> = { "x-initiator": "user" }
    setCompactHeaders(
      mk({ messages: [{ role: "user", content: COMPACT_LAST_MESSAGE_TEXT }] }),
      headers,
    )
    expect(headers["x-initiator"]).toBe("agent")
    expect(headers["x-interaction-type"]).toBe("conversation-compaction")
  })
})

describe("setCompactHeaders — negative cases", () => {
  test("only text-only guard present (other markers missing) → no tagging", () => {
    const headers: Record<string, string> = {}
    const kind = setCompactHeaders(
      mk({ messages: [{ role: "user", content: "CRITICAL: Respond with TEXT ONLY. Do NOT call any tools." }] }),
      headers,
    )
    expect(kind).toBeNull()
    expect("x-initiator" in headers).toBe(false)
    expect("x-interaction-type" in headers).toBe(false)
  })

  test("ordinary user turn → no tagging", () => {
    const headers: Record<string, string> = {}
    setCompactHeaders(mk({ messages: [{ role: "user", content: "hello there" }] }), headers)
    expect("x-initiator" in headers).toBe(false)
  })

  test("assistant role carrying compact-summary text is ignored", () => {
    const headers: Record<string, string> = {}
    setCompactHeaders(
      mk({
        messages: [
          { role: "user", content: "kick off" },
          { role: "assistant", content: COMPACT_LAST_MESSAGE_TEXT },
        ],
      }),
      headers,
    )
    expect("x-initiator" in headers).toBe(false)
    expect("x-interaction-type" in headers).toBe(false)
  })

  test("assistant role carrying auto-continue resume prompt is ignored", () => {
    const headers: Record<string, string> = {}
    setCompactHeaders(
      mk({
        messages: [
          { role: "user", content: "first turn" },
          {
            role: "assistant",
            content:
              "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.",
          },
        ],
      }),
      headers,
    )
    expect("x-initiator" in headers).toBe(false)
  })

  test("empty messages array → no tagging", () => {
    const headers: Record<string, string> = {}
    expect(setCompactHeaders(mk({ messages: [] }), headers)).toBeNull()
    expect("x-initiator" in headers).toBe(false)
  })
})

describe("setCompactHeaders — auto-continue", () => {
  test("Claude Code resume prompt → x-initiator: agent only", () => {
    const headers: Record<string, string> = {}
    const kind = setCompactHeaders(
      mk({
        messages: [
          {
            role: "user",
            content:
              "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nMore detail follows.",
          },
        ],
      }),
      headers,
    )
    expect(kind).toBe("auto-continue")
    expect(headers["x-initiator"]).toBe("agent")
    expect("x-interaction-type" in headers).toBe(false)
  })

  test("OpenCode primary continuation prompt → x-initiator: agent only", () => {
    const headers: Record<string, string> = {}
    setCompactHeaders(
      mk({
        messages: [
          {
            role: "user",
            content:
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
          },
        ],
      }),
      headers,
    )
    expect(headers["x-initiator"]).toBe("agent")
    expect("x-interaction-type" in headers).toBe(false)
  })

  test("OpenCode media-eviction continuation prompt → x-initiator: agent only", () => {
    const headers: Record<string, string> = {}
    setCompactHeaders(
      mk({
        messages: [
          {
            role: "user",
            content:
              "The previous request exceeded the provider's size limit due to large media attachments. The conversation was compacted and media files were removed from context.",
          },
        ],
      }),
      headers,
    )
    expect(headers["x-initiator"]).toBe("agent")
    expect("x-interaction-type" in headers).toBe(false)
  })

  test("overrides prior x-initiator: user", () => {
    const headers: Record<string, string> = { "x-initiator": "user" }
    setCompactHeaders(
      mk({
        messages: [
          {
            role: "user",
            content:
              "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
          },
        ],
      }),
      headers,
    )
    expect(headers["x-initiator"]).toBe("agent")
  })
})

describe("classifyCompact priority", () => {
  test("last-message compact wins over system-prompt compact", () => {
    const result = classifyCompact(
      mk({
        system: "You are a helpful AI assistant tasked with summarizing conversations",
        messages: [{ role: "user", content: COMPACT_LAST_MESSAGE_TEXT }],
      }),
    )
    expect(result).toBe("compact-request")
  })
})
