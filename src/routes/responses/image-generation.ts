/**
 * Responses `image_generation` server-tool shim — single-turn route entry.
 *
 * Dispatch path when a /v1/responses request declares the hosted
 * `image_generation` tool: short-circuit the chat orchestrator entirely,
 * resolve an `images_generations` binding for the configured backend
 * model (default `gpt-image-2`), call it directly, and return a
 * Responses-shaped envelope. Streaming branch synthesizes Azure's
 * native image_generation_call SSE lifecycle.
 */

import { resolveBinding } from "~/lib/binding-resolver"
import { recordLatency, startTimer } from "~/lib/latency-tracker"
import {
  buildImageGenerationResponse,
  collectImageSources,
  editSupportedMime,
  extractPromptFromInput,
  generateImageViaBinding,
  synthImageGenerationSSE,
  validateImageGenerationConfig,
} from "~/services/image-generation"
import type { ResponsesPayload } from "~/transforms"

import type { RouteContext } from "./utils"

export async function handleResponsesImageGeneration(
  ctx: RouteContext,
  payload: ResponsesPayload,
  elapsed: () => number,
): Promise<Response> {
  const { state, apiKeyId, colo, requestId } = ctx
  const publicModel = payload.model

  const validated = validateImageGenerationConfig(payload.tools)
  if (!validated.ok) {
    return new Response(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: validated.error.message,
          param: validated.error.param,
          code: validated.error.code,
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }
  const config = validated.config
  const prompt = extractPromptFromInput(payload.input)

  if (!prompt) {
    return new Response(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "image_generation shim could not extract a prompt from input.",
        },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    )
  }

  // Slice 3: inline input_image blocks route to /images/edits as multipart.
  // Unsupported mimetypes are dropped here (rather than rejected) so a stray
  // wrong-type attachment doesn't blow up an otherwise valid edit request.
  const allSources = collectImageSources(payload.input)
  const sources = allSources.filter((s) => editSupportedMime(s.mimeType) !== null)
  const isEdit = sources.length > 0
  const endpointKey = isEdit ? "images_edits" : "images_generations"

  const binding = await resolveBinding(state, ctx.userId, config.model, endpointKey)
  if (!binding) {
    return new Response(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: `No ${endpointKey} upstream available for backend model: ${config.model}.`,
        },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )
  }

  const outcome = await generateImageViaBinding(binding, prompt, config, sources)
  const responseEnvelope = buildImageGenerationResponse(publicModel, prompt, outcome)

  if (apiKeyId) {
    recordLatency(apiKeyId, publicModel, colo, {
      totalMs: elapsed(),
      upstreamMs: outcome.upstreamMs,
      ttfbMs: outcome.upstreamMs,
      tokenMiss: state.tokenMiss,
    }, requestId, {
      stream: payload.stream === true,
      inputTokens: 0,
      outputTokens: 0,
      upstream: binding.upstream,
    }).catch(() => {})
  }

  if (payload.stream === true) {
    const sse = synthImageGenerationSSE(responseEnvelope)
    return new Response(sse, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  }

  return new Response(JSON.stringify(responseEnvelope), {
    status: outcome.ok ? 200 : 502,
    headers: { "Content-Type": "application/json" },
  })
}
