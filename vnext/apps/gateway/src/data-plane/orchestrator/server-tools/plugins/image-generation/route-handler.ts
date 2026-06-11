/**
 * Responses `image_generation` server-tool shim — single-turn route entry.
 *
 * Week 4b-4 port of src/routes/responses/image-generation.ts. Behavior 1:1:
 *   - validate tool config (Azure-strict)
 *   - extract prompt from input
 *   - collect inline image sources → if any supported, route to images_edits
 *   - resolve binding for the backend image model
 *   - call provider, build Responses envelope, return JSON or synthesized SSE
 *
 * Latency tracking (recordLatency) is deferred to Week 6 observability
 * bundle — old project's RouteContext.elapsed/colo aren't wired in vnext yet.
 */
import { resolveBinding } from '../../../../routing/binding-resolver.ts'
import type { CreateProviderOptions } from '../../../../providers/registry.ts'
import {
  buildImageGenerationResponse,
  collectImageSources,
  editSupportedMime,
  extractPromptFromInput,
  generateImageViaBinding,
  synthImageGenerationSSE,
  validateImageGenerationConfig,
} from './core.ts'

export interface ImageGenerationRouteContext {
  userId?: string
  copilot?: CreateProviderOptions
  apiKeyId?: string
  requestId?: string
}

interface ResponsesPayloadLike {
  model: string
  input: unknown
  tools?: Array<Record<string, unknown>>
  stream?: boolean
}

export async function handleResponsesImageGeneration(
  ctx: ImageGenerationRouteContext,
  payload: ResponsesPayloadLike,
): Promise<Response> {
  // Observability bypass: this intercept hits the image backend directly and
  // does not flow through dispatch(), so quota/latency/usage trackers are skipped.
  console.warn('[observability] handleResponsesImageGeneration bypasses dispatch quota/latency/usage tracking')
  const publicModel = payload.model

  const validated = validateImageGenerationConfig(payload.tools as Parameters<typeof validateImageGenerationConfig>[0])
  if (!validated.ok) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: validated.error.message,
          param: validated.error.param,
          code: validated.error.code,
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }
  const config = validated.config
  const prompt = extractPromptFromInput(payload.input)

  if (!prompt) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: 'image_generation shim could not extract a prompt from input.',
        },
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const allSources = collectImageSources(payload.input)
  const sources = allSources.filter((s) => editSupportedMime(s.mimeType) !== null)
  const isEdit = sources.length > 0
  const endpointKey = isEdit ? 'images_edits' : 'images_generations'

  const binding = await resolveBinding(config.model, endpointKey, {
    ownerId: ctx.userId,
    copilot: ctx.copilot,
  })
  if (!binding) {
    return new Response(
      JSON.stringify({
        error: {
          type: 'invalid_request_error',
          message: `No ${endpointKey} upstream available for backend model: ${config.model}.`,
        },
      }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const outcome = await generateImageViaBinding(binding, prompt, config, sources)
  const responseEnvelope = buildImageGenerationResponse(publicModel, prompt, outcome)

  if (payload.stream === true) {
    const sse = synthImageGenerationSSE(responseEnvelope)
    return new Response(sse, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    })
  }

  return new Response(JSON.stringify(responseEnvelope), {
    status: outcome.ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json' },
  })
}
