/**
 * A reasoning-enabled follow-up needs the previous reply as its protocol
 * produced it, not just the visible text: Messages thinking blocks and their
 * signatures, Chat Completions `reasoning_text` / `reasoning_opaque`, Gemini
 * thought parts and `thoughtSignature`. These pin what each stream reader
 * captures and when the thread replays it.
 */
import { describe, expect, it } from "bun:test"
import { parseOpenAIStream } from "./streams/openai"
import { parseAnthropicStream } from "./streams/anthropic"
import { parseGeminiStream } from "./streams/gemini"
import { toChatHistory } from "./payload"
import { replayTurn, type AssistantOutput } from "./assistant-output"

const sse = (lines: string[]): ReadableStream<Uint8Array> => new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(lines.join("")))
    controller.close()
  },
})

async function outputOf(gen: AsyncGenerator<{ type: string; output?: AssistantOutput }, void, void>): Promise<AssistantOutput | undefined> {
  let output: AssistantOutput | undefined
  for await (const chunk of gen) if (chunk.type === "output") output = chunk.output
  return output
}

describe("Chat Completions", () => {
  const chunk = (delta: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`

  it("rebuilds the assistant message with its reasoning fields", async () => {
    const output = await outputOf(parseOpenAIStream(sse([
      chunk({ role: "assistant", reasoning_text: "Think" }),
      chunk({ reasoning_text: "ing." }),
      chunk({ reasoning_opaque: "sig-a" }),
      chunk({ reasoning_opaque: "sig-b" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      "data: [DONE]\n\n",
    ])))
    expect(output).toEqual({ protocol: "openai", message: {
      role: "assistant", content: "Hello", reasoning_text: "Thinking.", reasoning_opaque: "sig-asig-b",
    } })
  })

  it("reads reasoning_content as the reasoning text and keeps reasoning items", async () => {
    const output = await outputOf(parseOpenAIStream(sse([
      chunk({ reasoning_content: "Plan" }),
      chunk({ reasoning_items: [{ type: "reasoning", id: "rs_1", encrypted_content: "enc" }] }),
      chunk({ content: "Done" }),
    ])))
    expect(output).toEqual({ protocol: "openai", message: {
      role: "assistant", content: "Done", reasoning_text: "Plan",
      reasoning_items: [{ type: "reasoning", id: "rs_1", encrypted_content: "enc" }],
    } })
  })

  it("captures nothing from a stream that carried no reply", async () => {
    expect(await outputOf(parseOpenAIStream(sse([
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } })}\n\n`,
      "data: [DONE]\n\n",
    ])))).toBeUndefined()
  })
})

describe("Messages", () => {
  const event = (type: string, data: Record<string, unknown> = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`
  const block = (index: number, content_block: Record<string, unknown>, deltas: Record<string, unknown>[]) => [
    event("content_block_start", { index, content_block }),
    ...deltas.map((delta) => event("content_block_delta", { index, delta })),
    event("content_block_stop", { index }),
  ]

  it("keeps thinking blocks with their signatures, including a signed block whose text is omitted", async () => {
    const output = await outputOf(parseAnthropicStream(sse([
      event("message_start", { message: { usage: { input_tokens: 3, output_tokens: 0 } } }),
      ...block(0, { type: "thinking", thinking: "" }, [{ type: "thinking_delta", thinking: "Plan" }, { type: "signature_delta", signature: "sig-1" }]),
      ...block(1, { type: "thinking", thinking: "" }, [{ type: "signature_delta", signature: "sig-2" }]),
      ...block(2, { type: "text", text: "" }, [{ type: "text_delta", text: "Hi" }]),
      event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
      event("message_stop"),
    ])))
    expect(output).toEqual({ protocol: "anthropic", content: [
      { type: "thinking", thinking: "Plan", signature: "sig-1" },
      { type: "thinking", thinking: "", signature: "sig-2" },
      { type: "text", text: "Hi" },
    ] })
  })

  it("hands a paused turn back for continuation instead of capturing it", async () => {
    const output = await outputOf(parseAnthropicStream(sse([
      ...block(0, { type: "server_tool_use", id: "srv_1", name: "web_search" }, [{ type: "input_json_delta", partial_json: "{\"query\":\"q\"}" }]),
      event("message_delta", { delta: { stop_reason: "pause_turn" } }),
      event("message_stop"),
    ])))
    expect(output).toBeUndefined()
  })
})

describe("Gemini", () => {
  const chunk = (parts: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, ...extra }] })}\n\n`

  it("replays thought parts ahead of the reply text, merging the streamed text", async () => {
    const output = await outputOf(parseGeminiStream(sse([
      chunk([{ text: "Hel" }]),
      chunk([{ text: "lo" }]),
      chunk([{ text: "Plan", thought: true, thoughtSignature: "sig" }], { finishReason: "STOP" }),
    ])))
    expect(output).toEqual({ protocol: "gemini", parts: [{ text: "Plan", thought: true, thoughtSignature: "sig" }, { text: "Hello" }] })
  })
})

describe("replaying a thread", () => {
  const anthropic: AssistantOutput = { protocol: "anthropic", content: [{ type: "thinking", thinking: "Plan", signature: "sig" }, { type: "text", text: "Hi" }] }
  const history = toChatHistory([
    { role: "user", text: "q" },
    { role: "assistant", text: "Hi", output: anthropic },
    { role: "user", text: "more" },
  ])

  it("keeps a reply's output on its turn", () => {
    expect(history[1]).toMatchObject({ role: "assistant", output: anthropic })
  })

  it("replays a reply natively on the protocol that produced it", () => {
    const reply = history[1]
    if (!reply) throw new Error("fixture")
    expect(replayTurn(reply, "anthropic")).toEqual({ role: "assistant", content: anthropic.content })
    expect(replayTurn({ role: "assistant", output: { protocol: "openai", message: { role: "assistant", content: "Hi", reasoning_opaque: "sig" } } }, "openai"))
      .toEqual({ role: "assistant", content: "Hi", reasoning_opaque: "sig" })
    expect(replayTurn({ role: "assistant", output: { protocol: "gemini", parts: [{ text: "Hi" }] } }, "gemini"))
      .toEqual({ role: "model", parts: [{ text: "Hi" }] })
  })

  it("falls back to text once the thread switches protocol", () => {
    const reply = history[1]
    if (!reply) throw new Error("fixture")
    expect(replayTurn(reply, "openai")).toBeUndefined()
    expect(replayTurn(reply, "gemini")).toBeUndefined()
  })
})
