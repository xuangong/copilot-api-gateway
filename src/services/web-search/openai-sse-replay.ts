import type { InterceptedSearch, OpenAIChatResponse } from "./openai-interceptor"

const encoder = new TextEncoder()

interface ChatCompletionChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: "function"
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason: string | null
  }>
  usage?: OpenAIChatResponse["usage"]
  _meta?: {
    web_search?: {
      status: "in_progress" | "searching" | "completed"
      query?: string
      item_id?: string
    }
  }
}

function buildChunkFromResponse(
  response: OpenAIChatResponse,
): ChatCompletionChunk {
  const choice = response.choices?.[0]
  const message = choice?.message
  const tool_calls = Array.isArray(message?.tool_calls)
    ? message!.tool_calls!.map((c, index) => ({
        index,
        id: c.id,
        type: "function" as const,
        function: c.function,
      }))
    : undefined

  return {
    id: response.id,
    object: "chat.completion.chunk",
    created: response.created ?? Math.floor(Date.now() / 1000),
    model: response.model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content:
            typeof message?.content === "string" ? message.content : null,
          ...(tool_calls ? { tool_calls } : {}),
        },
        finish_reason: choice?.finish_reason ?? "stop",
      },
    ],
    usage: response.usage,
  }
}

/**
 * Synthesize a tiny SSE stream from a non-streaming chat completion response.
 * Emits a content chunk, then a separate usage chunk (matching the wire
 * shape produced by `stream_options.include_usage: true`), then `[DONE]`.
 *
 * Why two frames: clients that follow the OpenAI streaming contract treat
 * a frame as either "delta" OR "usage" — when both `choices[0].delta` and
 * `usage` are present in one frame, some parsers (incl. our own dashboard)
 * dispatch on usage first and drop the text. Splitting matches real upstream
 * behaviour.
 */
export function replayChatCompletionAsSSE(
  response: OpenAIChatResponse,
  searches?: InterceptedSearch[],
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const chunk = buildChunkFromResponse(response)
      const usage = chunk.usage
      const { usage: _omit, ...contentChunk } = chunk
      // Surface intercept-loop search activity to dashboards/clients that
      // honour `_meta.web_search`. Emitted BEFORE the content frame so the UI
      // can render in-flight bubbles in the order the model issued them.
      if (searches && searches.length > 0) {
        for (const s of searches) {
          const itemId = s.toolCallId || `ws_gw_${searches.indexOf(s)}`
          for (const status of ["in_progress", "completed"] as const) {
            const wsChunk: ChatCompletionChunk = {
              id: chunk.id,
              object: "chat.completion.chunk",
              created: chunk.created,
              model: chunk.model,
              choices: [],
              _meta: {
                web_search: {
                  status,
                  item_id: itemId,
                  ...(s.query ? { query: s.query } : {}),
                },
              },
            }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(wsChunk)}\n\n`))
          }
        }
      }
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`))
      if (usage) {
        const usageChunk: ChatCompletionChunk = {
          id: chunk.id,
          object: "chat.completion.chunk",
          created: chunk.created,
          model: chunk.model,
          choices: [],
          usage,
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`))
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
}

/**
 * Same as `replayChatCompletionAsSSE` but exposed for callers (Gemini route)
 * that want to feed the synthesized chunks into an existing SSE → X transform
 * (e.g. translateChunkToGemini). Identical wire format.
 */
export const synthChatCompletionChunks = replayChatCompletionAsSSE
