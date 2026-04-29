import type { OpenAIChatResponse } from "./openai-interceptor"

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
 * Emits a single chat.completion.chunk frame followed by `data: [DONE]`.
 *
 * Trade-off: not token-by-token, but every OpenAI SDK accepts a single chunk
 * and this lets us reuse the rest of the streaming plumbing unchanged.
 */
export function replayChatCompletionAsSSE(
  response: OpenAIChatResponse,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const chunk = buildChunkFromResponse(response)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
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
