import { detectClient } from "~/lib/client-detect"
import { resolveBinding, pinFromPayload } from "~/lib/binding-resolver"
import { raceWithHeartbeat } from "~/lib/heartbeat-json"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import { wrapOpenAIHeartbeat } from "~/lib/sse-heartbeat"
import { consumeStreamForUsage, trackNonStreamingUsage } from "~/middleware/usage"
import {
  createStreamState as _createStreamState,
  translateChatCompletionsToResponses,
  translateResponsesToChatCompletions,
  type ChatCompletionResponse,
} from "~/services/responses"
import {
  compactResponsesInputForChatFallback,
  runResponsesChatFallbackPipeline,
  type ResponsesPayload,
} from "~/transforms"

import { buildStreamTransform, type RouteContext } from "./utils"

/**
 * Chat Completions fallback path: convert Responses→Chat upstream, then map
 * the result back. Handles streaming + non-streaming. Also applies two
 * mitigations specific to this path:
 *   1. Compact oversized function_call_output history to stay under Copilot's
 *      body cap (avoids 413 on long codex sessions).
 *   2. Rewrite codex's Freeform `custom` apply_patch tool into a JSON
 *      function tool (chat-completions doesn't grok `custom`). Native
 *      passthrough leaves `custom` intact.
 */
export async function handleChatFallback(
  ctx: RouteContext,
  payload: ResponsesPayload,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId } = ctx
  const client = detectClient(ctx.userAgent)
  const model = payload.model

  if (Array.isArray(payload.input)) {
    const { items, stats } = compactResponsesInputForChatFallback(payload.input, 1_500_000)
    if (stats.truncated > 0) {
      console.log(JSON.stringify({
        evt: "responses_input_compacted",
        rid: requestId,
        model,
        truncated: stats.truncated,
        bytesDropped: stats.bytesDropped,
        totalItems: stats.totalItems,
      }))
      payload.input = items
    }
  }

  runResponsesChatFallbackPipeline(payload)

  const chatPayload = translateResponsesToChatCompletions(payload, model)
  const binding = await resolveBinding(state, ctx.userId, model, "chat_completions", pinFromPayload(payload as unknown as Record<string, unknown>))
  if (!binding) {
    return new Response(
      JSON.stringify({ error: { type: "invalid_request_error", message: `No chat-completions upstream available for model: ${model}` } }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }
  const provider = binding.provider
  const upstreamId = binding.upstream

  if (payload.stream === true) {
    chatPayload.stream = true
    chatPayload.stream_options = { include_usage: true }

    const upstreamTimer = startTimer()
    const response = await provider.callChatCompletions(
      chatPayload as unknown as Record<string, unknown>,
      { operationName: "responses (via chat)" },
    )
    const upstreamMs = upstreamTimer()

    if (apiKeyId) {
      recordLatency(apiKeyId, model, colo, {
        totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
      }, requestId, { stream: true, sourceApi: "responses", targetApi: "chat-completions", upstream: upstreamId }).catch(() => {})
    }

    // Heartbeat BEFORE tee so both branches share the keepalive stream.
    // SSE comment ":" lines are ignored by createSSETransform's parser
    // (it filters on "data: " prefix), so usage extraction is unaffected.
    const heartbeated = wrapOpenAIHeartbeat(response.body)

    let usageBranch: ReadableStream<Uint8Array> | null = null
    let transformBranch: ReadableStream<Uint8Array> | null = null
    if (heartbeated) {
      const [a, b] = heartbeated.tee()
      usageBranch = a
      transformBranch = b
    }
    if (apiKeyId && usageBranch) {
      consumeStreamForUsage(usageBranch, apiKeyId, model, client, upstreamId)
    }
    const transformedBody = transformBranch?.pipeThrough(buildStreamTransform(payload, model))
    return new Response(transformedBody, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  chatPayload.stream = false

  const upstreamTimer = startTimer()
  let upstreamMs = 0
  const syncPromise: Promise<{
    responsesResult: ReturnType<typeof translateChatCompletionsToResponses>
    chatResponse: ChatCompletionResponse
  }> = (async () => {
    const response = await provider.callChatCompletions(
      chatPayload as unknown as Record<string, unknown>,
      { operationName: "responses (via chat)" },
    )
    upstreamMs = upstreamTimer()
    const chatResponse = (await response.json()) as ChatCompletionResponse
    return {
      responsesResult: translateChatCompletionsToResponses(chatResponse, model, payload),
      chatResponse,
    }
  })()

  const recordSync = async ({
    responsesResult,
    chatResponse,
  }: {
    responsesResult: ReturnType<typeof translateChatCompletionsToResponses>
    chatResponse: ChatCompletionResponse
  }) => {
    if (!apiKeyId) return
    await trackNonStreamingUsage(chatResponse, apiKeyId, model, client, upstreamId)
    recordLatency(apiKeyId, model, colo, {
      totalMs: elapsed(), upstreamMs, ttfbMs: upstreamMs, tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: false,
      inputTokens: responsesResult.usage.input_tokens,
      outputTokens: responsesResult.usage.output_tokens,
      sourceApi: "responses",
      targetApi: "chat-completions",
      upstream: upstreamId,
    }).catch(() => {})
  }

  const raced = await raceWithHeartbeat(syncPromise, { onResolve: recordSync })
  if (raced.kind === "stream") return raced.response

  const { responsesResult } = raced.value
  await recordSync(raced.value)
  return new Response(JSON.stringify(responsesResult), {
    headers: { "Content-Type": "application/json" },
  })
}
