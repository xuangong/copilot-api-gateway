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
      const content = contentChunk.choices[0]?.delta.content
      const toolCalls = contentChunk.choices[0]?.delta.tool_calls
      if (typeof content === "string" && content.length > 0 && !toolCalls) {
        const pieces = chunkText(content)
        for (let i = 0; i < pieces.length; i++) {
          const piece = pieces[i]!
          const isLast = i === pieces.length - 1
          const piecedChunk: ChatCompletionChunk = {
            id: contentChunk.id,
            object: "chat.completion.chunk",
            created: contentChunk.created,
            model: contentChunk.model,
            choices: [
              {
                index: 0,
                delta: i === 0
                  ? { role: "assistant", content: piece }
                  : { content: piece },
                finish_reason: isLast
                  ? contentChunk.choices[0]!.finish_reason
                  : null,
              },
            ],
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(piecedChunk)}\n\n`))
        }
      } else {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(contentChunk)}\n\n`))
      }
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

function chunkText(text: string, size = 24): Array<string> {
  if (!text) return [""]
  const chars = Array.from(text)
  if (chars.length <= size) return [text]
  const out: Array<string> = []
  for (let i = 0; i < chars.length; i += size) {
    out.push(chars.slice(i, i + size).join(""))
  }
  return out
}
