/**
 * The playground reads hosted web search off each protocol's spec channel —
 * Chat Completions `delta.annotations`, Gemini `groundingMetadata`, Messages
 * `server_tool_use` / `web_search_tool_result`. The legacy `_meta.web_search`
 * sidecar is gone, so these guard the real wire shapes the gateway emits.
 */
import { describe, expect, it } from "bun:test"
import { parseOpenAIStream, toCitations, type StreamChunk } from "./openai"
import { parseGeminiStream } from "./gemini"
import { parseAnthropicStream, type AnthropicChunk } from "./anthropic"

const sse = (lines: string[]): ReadableStream<Uint8Array> => {
  const body = lines.join("")
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })
}

const drain = async <T extends StreamChunk | AnthropicChunk>(
  gen: AsyncGenerator<T, void, void>,
): Promise<T[]> => {
  const out: T[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe("toCitations", () => {
  it("dedupes by url, keeps the first title, and drops entries with no url", () => {
    expect(
      toCitations([
        { url_citation: { url: "https://a.example/", title: "A" } },
        { url: "https://b.example/" },
        { url_citation: { url: "https://a.example/", title: "A again" } },
        { url_citation: {} },
        { title: "no url" },
      ]),
    ).toEqual([{ url: "https://a.example/", title: "A" }, { url: "https://b.example/" }])
  })
})

describe("chat completions", () => {
  it("turns delta.annotations into a citations chunk", async () => {
    const out = await drain(
      parseOpenAIStream(
        sse([
          'data: {"choices":[{"delta":{"content":"It is sunny."}}]}\n',
          'data: {"choices":[{"delta":{"annotations":[{"type":"url_citation","url_citation":{"url":"https://a.example/","title":"A"}}]}}]}\n',
          "data: [DONE]\n",
        ]),
      ),
    )
    expect(out).toEqual([
      { type: "delta", text: "It is sunny." },
      { type: "citations", citations: [{ url: "https://a.example/", title: "A" }] },
    ])
  })

  it("handles content, annotations and usage on one line", async () => {
    // Native OpenAI web search cites on the same delta as the text it grounds.
    const out = await drain(
      parseOpenAIStream(
        sse([
          'data: {"choices":[{"delta":{"content":"Sunny.","annotations":' +
            '[{"type":"url_citation","url_citation":{"url":"https://a.example/"}}]}}],' +
            '"usage":{"prompt_tokens":9,"completion_tokens":4}}\n',
          "data: [DONE]\n",
        ]),
      ),
    )
    expect(out).toEqual([
      { type: "delta", text: "Sunny." },
      { type: "citations", citations: [{ url: "https://a.example/" }] },
      { type: "usage", usage: { input_tokens: 9, output_tokens: 4 } },
    ])
  })
})

describe("gemini", () => {
  it("reads groundingChunks off the final candidate alongside text and usage", async () => {
    const out = await drain(
      parseGeminiStream(
        sse([
          'data: {"candidates":[{"content":{"parts":[{"text":"It is sunny."}]}}]}\n',
          'data: {"candidates":[{"content":{"parts":[{"text":" Enjoy."}]},' +
            '"groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://a.example/","title":"A"}},' +
            '{"web":{"uri":"https://b.example/"}}]}}],' +
            '"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":7}}\n',
        ]),
      ),
    )
    expect(out).toEqual([
      { type: "delta", text: "It is sunny." },
      { type: "delta", text: " Enjoy." },
      { type: "citations", citations: [{ url: "https://a.example/", title: "A" }, { url: "https://b.example/" }] },
      { type: "usage", usage: { input_tokens: 11, output_tokens: 7 } },
    ])
  })
})

describe("messages", () => {
  it("tracks a server_tool_use block through to its result", async () => {
    const out = await drain(
      parseAnthropicStream(
        sse([
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,' +
            '"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
            '"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"beij"}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
            '"delta":{"type":"input_json_delta","partial_json":"ing weather\\"}"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,' +
            '"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1",' +
            '"content":[{"type":"web_search_result","url":"https://a.example/","title":"A"}]}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,' +
            '"delta":{"type":"text_delta","text":"It is sunny."}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    )
    expect(out).toEqual([
      { type: "web_search", progress: { status: "in_progress", item_id: "srvtoolu_1" } },
      // The query is only readable once every input_json_delta fragment landed.
      { type: "web_search", progress: { status: "searching", query: "beijing weather", item_id: "srvtoolu_1" } },
      // `completed` carries the id of the search it closes, so the caller can
      // update the in-flight entry instead of appending a second one.
      { type: "web_search", progress: { status: "completed", item_id: "srvtoolu_1" } },
      { type: "citations", citations: [{ url: "https://a.example/", title: "A" }] },
      { type: "delta", text: "It is sunny." },
    ])
  })

  it("hands back replayable blocks when the turn pauses", async () => {
    const out = await drain(
      parseAnthropicStream(
        sse([
          // An empty thinking block: never got a delta, so it is unsigned and
          // the upstream rejects it on replay.
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,' +
            '"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":1,' +
            '"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,' +
            '"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"bj\\"}"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":2,' +
            '"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[]}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"pause_turn"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    )
    const paused = out.find((c) => c.type === "pause_turn")
    expect(paused).toEqual({
      type: "pause_turn",
      content: [
        { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "bj" } },
        { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [] },
      ],
    })
  })

  it("does not hand back blocks when the turn ends normally", async () => {
    const out = await drain(
      parseAnthropicStream(
        sse([
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,' +
            '"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
            '"delta":{"type":"text_delta","text":"done"}}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    )
    expect(out.some((c) => c.type === "pause_turn")).toBe(false)
  })

  it("leaves ordinary content blocks alone", async () => {
    const out = await drain(
      parseAnthropicStream(
        sse([
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,' +
            '"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,' +
            '"delta":{"type":"text_delta","text":"hi"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","usage":{"input_tokens":3,"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        ]),
      ),
    )
    expect(out).toEqual([
      { type: "delta", text: "hi" },
      { type: "usage", usage: { input_tokens: 3, output_tokens: 1 } },
    ])
  })
})
