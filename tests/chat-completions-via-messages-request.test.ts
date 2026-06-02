import { test, expect, describe } from "bun:test"
import { translateChatCompletionsToMessages } from "~/translators/chat-completions-via-messages/request"
import type { ChatCompletionsPayload } from "~/services/gemini/format-conversion"

describe("translateChatCompletionsToMessages", () => {
  test("basic user message", () => {
    const out = translateChatCompletionsToMessages({
      model: "m",
      messages: [{ role: "user", content: "hello" }],
    })
    expect(out.model).toBe("m")
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }] },
    ])
    expect(out.max_tokens).toBe(4096)
    expect(out.stream).toBe(true)
  })

  test("system messages join into Messages.system", () => {
    const out = translateChatCompletionsToMessages({
      model: "m",
      messages: [
        { role: "system", content: "rule 1" },
        { role: "system", content: "rule 2" },
        { role: "user", content: "hi" },
      ],
    })
    expect(out.system).toEqual([
      { type: "text", text: "rule 1\n\nrule 2", cache_control: { type: "ephemeral" } },
    ])
  })

  test("assistant tool_calls become tool_use blocks", () => {
    const out = translateChatCompletionsToMessages({
      model: "m",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "t1",
              type: "function",
              function: { name: "search", arguments: '{"q":"hi"}' },
            },
          ],
        },
      ],
    })
    const a = out.messages[1] as { role: "assistant"; content: Array<{ type: string }> }
    expect(a.role).toBe("assistant")
    expect(a.content[0].type).toBe("tool_use")
  })

  test("tool role becomes tool_result on a user message", () => {
    const out = translateChatCompletionsToMessages({
      model: "m",
      messages: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "t1", type: "function", function: { name: "s", arguments: "{}" } },
          ],
        },
        { role: "tool", content: "result", tool_call_id: "t1" },
      ],
    })
    const last = out.messages[out.messages.length - 1] as {
      role: "user"
      content: Array<{ type: string; tool_use_id?: string }>
    }
    expect(last.role).toBe("user")
    expect(last.content[0].type).toBe("tool_result")
    expect(last.content[0].tool_use_id).toBe("t1")
  })

  test("image_url part with data URL becomes base64 image block", () => {
    const out = translateChatCompletionsToMessages({
      model: "m",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          ],
        },
      ],
    })
    const u = out.messages[0] as { role: "user"; content: Array<{ type: string }> }
    expect(u.content[0].type).toBe("text")
    expect(u.content[1].type).toBe("image")
  })

  test("tools and tool_choice translated", () => {
    const out = translateChatCompletionsToMessages({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [
        {
          type: "function",
          function: {
            name: "search",
            description: "find",
            parameters: { type: "object" },
          },
        },
      ],
      tool_choice: "required",
    })
    expect(out.tools).toEqual([
      {
        name: "search",
        description: "find",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(out.tool_choice).toEqual({ type: "any" })
  })

  test("named tool_choice translates to type=tool", () => {
    const out = translateChatCompletionsToMessages({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [
        { type: "function", function: { name: "search", parameters: { type: "object" } } },
      ],
      tool_choice: { type: "function", function: { name: "search" } },
    } as ChatCompletionsPayload)
    expect(out.tool_choice).toEqual({ type: "tool", name: "search" })
  })

  test("stop string normalized to stop_sequences array", () => {
    const out = translateChatCompletionsToMessages({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      stop: ["END"],
    })
    expect(out.stop_sequences).toEqual(["END"])
  })

  test("fallbackMaxOutputTokens used when source omits max_tokens", () => {
    const out = translateChatCompletionsToMessages(
      { model: "m", messages: [{ role: "user", content: "x" }] },
      { fallbackMaxOutputTokens: 12345 },
    )
    expect(out.max_tokens).toBe(12345)
  })

  test("reasoning_effort maps to thinking with budget_tokens", () => {
    const low = translateChatCompletionsToMessages({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      reasoning_effort: "low",
    })
    expect(low.thinking).toEqual({ type: "enabled", budget_tokens: 1024 })

    const med = translateChatCompletionsToMessages({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      reasoning_effort: "medium",
    })
    expect(med.thinking).toEqual({ type: "enabled", budget_tokens: 4096 })

    const high = translateChatCompletionsToMessages({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      reasoning_effort: "high",
    })
    expect(high.thinking).toEqual({ type: "enabled", budget_tokens: 16384 })

    const xhigh = translateChatCompletionsToMessages({
      model: "m",
      messages: [{ role: "user", content: "x" }],
      reasoning_effort: "xhigh",
    } as ChatCompletionsPayload)
    expect(xhigh.thinking).toEqual({ type: "enabled", budget_tokens: 32768 })
  })

  test("no reasoning_effort means no thinking block", () => {
    const out = translateChatCompletionsToMessages({
      model: "m",
      messages: [{ role: "user", content: "x" }],
    })
    expect(out.thinking).toBeUndefined()
  })
})
