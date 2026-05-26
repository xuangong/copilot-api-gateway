import type { AppState } from "~/lib/state"
import { createSSETransform } from "~/lib/sse-transform"
import { createFrameBuffer } from "~/lib/sse/parser"
import {
  createStreamState,
  translateChunkToResponsesEvents,
  type ChatCompletionChunk,
} from "~/services/responses"
import type { WebSearchMeta } from "~/services/web-search"
import type { ResponseItemReference, ResponsesPayload } from "~/transforms"

export interface RouteContext {
  state: AppState
  body: ResponsesPayload
  apiKeyId?: string
  colo: string
  requestId?: string
  userAgent?: string
  userId?: string
  executionCtx?: { waitUntil(promise: Promise<unknown>): void }
}

/**
 * Determine whether to use /v1/responses (direct) or /chat/completions (conversion).
 *
 * Only gpt-5.x series support /v1/responses natively. Everything older
 * (gpt-4.x, gpt-4o, gpt-4, gpt-3.x) goes through chat fallback.
 */
export function shouldUseChatFallback(model: string): boolean {
  if (model.startsWith("gpt-5")) return false
  return true
}

// Codex emits its auto-review traffic with this synthetic model id. Rewrite
// to a real gpt-5.x slug so the request takes the native /v1/responses
// passthrough — the chat-completions fallback inflates long codex histories
// (many function_call_output items) past the Copilot backend's body limit
// and trips 413. Lowering reasoning effort keeps cost predictable for the
// implicit upgrade.
const CODEX_AUTO_REVIEW_ALIAS = "codex-auto-review"
const CODEX_AUTO_REVIEW_TARGET = "gpt-5.4"

export function rewriteCodexAutoReviewAlias(payload: ResponsesPayload): ResponsesPayload {
  if (payload.model !== CODEX_AUTO_REVIEW_ALIAS) return payload
  return {
    ...payload,
    model: CODEX_AUTO_REVIEW_TARGET,
    reasoning: { ...(payload.reasoning ?? { effort: "low" }), effort: "low" },
  }
}

// The gateway is stateless: it never stores prior responses, so a client that
// sends previous_response_id or item_reference is referring to history we
// don't have. Return OpenAI's verbatim "not found" envelopes — codex,
// cline, openai-agents-python etc. key their auto-fallback on these exact
// shapes (status / code / param) and will retry with the full input inlined.
function isItemReferenceInput(item: unknown): item is ResponseItemReference {
  return (
    typeof item === "object"
    && item !== null
    && (item as { type?: unknown }).type === "item_reference"
  )
}

export function statefulContinuationNotFoundResponse(
  payload: ResponsesPayload,
): Response | undefined {
  if (payload.previous_response_id != null) {
    return new Response(
      JSON.stringify({
        error: {
          message: `Previous response with id '${payload.previous_response_id}' not found.`,
          type: "invalid_request_error",
          param: "previous_response_id",
          code: "previous_response_not_found",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }
  if (Array.isArray(payload.input)) {
    const itemRef = payload.input.find(isItemReferenceInput)
    if (itemRef) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Item with id '${itemRef.id}' not found.`,
            type: "invalid_request_error",
            param: "input",
            code: null,
          },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      )
    }
  }
  return undefined
}

/**
 * Count completed `web_search_call` items in a non-streaming Responses
 * payload. Used to populate X-Web-Search-* headers on the gpt-5.x direct
 * path where Copilot executes the search natively.
 */
export function countNativeWebSearchFromOutput(
  output: Array<{ type?: string; status?: string }> | undefined,
): WebSearchMeta {
  const meta: WebSearchMeta = {
    searchCount: 0,
    totalResults: 0,
    enginesUsed: [],
    successes: 0,
    failures: 0,
    engineAttempts: [],
  }
  if (!Array.isArray(output)) return meta
  for (const item of output) {
    if (item?.type !== "web_search_call") continue
    meta.searchCount++
    if (item.status === "completed") {
      meta.successes++
    } else {
      meta.failures++
    }
  }
  if (meta.searchCount > 0 && !meta.enginesUsed.includes("copilot-native")) {
    meta.enginesUsed.push("copilot-native")
  }
  return meta
}

/**
 * Drain a teed copy of the Responses SSE stream and count native
 * web_search_call items emitted via response.output_item.done events.
 * Returns the assembled meta after the stream ends.
 */
export async function countNativeWebSearchFromSSE(
  stream: ReadableStream<Uint8Array>,
): Promise<WebSearchMeta> {
  const meta: WebSearchMeta = {
    searchCount: 0,
    totalResults: 0,
    enginesUsed: [],
    successes: 0,
    failures: 0,
    engineAttempts: [],
  }
  const reader = stream.getReader()
  const frameBuffer = createFrameBuffer()
  const processFrame = (frame: { data?: string }) => {
    if (!frame.data || frame.data === "[DONE]") return
    try {
      const evt = JSON.parse(frame.data) as {
        type?: string
        item?: { type?: string; status?: string }
      }
      if (
        evt.type === "response.output_item.done" &&
        evt.item?.type === "web_search_call"
      ) {
        meta.searchCount++
        if (evt.item.status === "completed") {
          meta.successes++
        } else {
          meta.failures++
        }
      }
    } catch {
      // Skip malformed JSON
    }
  }
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const frame of frameBuffer.push(value)) processFrame(frame)
    }
    const tail = frameBuffer.flush()
    if (tail) processFrame(tail)
  } finally {
    reader.releaseLock()
  }
  if (meta.searchCount > 0 && !meta.enginesUsed.includes("copilot-native")) {
    meta.enginesUsed.push("copilot-native")
  }
  return meta
}

/**
 * Build a TransformStream that converts Chat Completions SSE → Responses SSE.
 */
export function buildStreamTransform(
  payload: ResponsesPayload,
  model: string,
): TransformStream<Uint8Array, Uint8Array> {
  const streamState = createStreamState(model)
  const encoder = new TextEncoder()

  return createSSETransform((data) => {
    try {
      const chatChunk = JSON.parse(data) as ChatCompletionChunk
      const events = translateChunkToResponsesEvents(chatChunk, streamState, payload)

      if (events.length > 0) {
        const parts: string[] = []
        for (const event of events) {
          parts.push(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
        }
        return encoder.encode(parts.join(""))
      }
    } catch {
      // Skip invalid JSON chunks
    }
    return null
  })
}
