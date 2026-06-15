// packages/gateway/src/data-plane/chat-flow/responses/image-generation-shortcut.ts
/**
 * Responses `image_generation` server-tool shortcut.
 *
 * Wraps the legacy `handleResponsesImageGeneration` route helper into the new
 * Spec-3 `serve → attempt → respond` chain. Two public entry points:
 *
 *   - `isImageGenerationRequest(payload)` — guard used by attempt.ts to
 *     route a payload through this shortcut instead of the general
 *     binding-selection terminal.
 *   - `runImageGenerationShortcut(args)` — produces an
 *     `EventResult<ProtocolFrame<ResponsesStreamEvent>>` populated with a
 *     `finalMetadata` Promise so respond.ts persists usage + perf rows
 *     under the corrected `modelKey` (the backend image model, defaulting
 *     to `gpt-image-2`) instead of the public model the user requested.
 *
 * Telemetry-channel ownership: this shortcut REPLACES the upstream stream
 * (synthesises SSE events from the image-generation outcome) and must own
 * its own modelIdentity + performance rows. The `__interceptorReplaced` flag
 * is set on the returned EventResult object via `Object.assign` so
 * `eventResultMetadata` in respond-telemetry.ts can prefer `finalMetadata`
 * over the surface `modelIdentity` without warning about a drift bug.
 *
 * Failure shape: any 4xx/5xx the route helper returns (validation, missing
 * binding) is preserved verbatim by surfacing it as a `bridged-response`
 * sentinel so respond.ts hands the original Response back unchanged. We
 * only synthesise an EventResult on the success path because only the
 * success path produces a stream-shaped envelope from `synthImageGenerationSSE`.
 */
import {
  eventFrame,
  type EventResult,
  type EventResultMetadata,
  type ProtocolFrame,
  type TelemetryModelIdentity,
} from '@vnext/protocols/common'
import type { ResponsesStreamEvent } from '@vnext/protocols/responses'
import {
  buildImageGenerationResponse,
  collectImageSources,
  DEFAULT_IMAGE_MODEL,
  editSupportedMime,
  extractPromptFromInput,
  generateImageViaBinding,
  hasImageGeneration,
  validateImageGenerationConfig,
  type ImageGenerationOutcome,
  type ImageGenerationResponseShape,
} from '../../orchestrator/server-tools/plugins/image-generation/index.ts'
import { resolveBinding } from '../../routing/binding-resolver.ts'
import type { CreateProviderOptions } from '../../providers/registry.ts'
import {
  recordPerformance,
  type EventResult as _EventResult,
} from '../shared/respond-telemetry.ts'
import type { TelemetryRequestContext } from '../shared/telemetry-ctx.ts'
import { waitUntil } from '@vnext/platform'

/**
 * Predicate the attempt orchestrator uses to gate the shortcut. Mirrors
 * `hasImageGeneration` from the plugin core; declared here so the chat-flow
 * doesn't have to import the plugin module just to inspect the payload shape.
 */
export function isImageGenerationRequest(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const tools = (payload as { tools?: unknown }).tools
  if (!Array.isArray(tools)) return false
  return hasImageGeneration(tools as Parameters<typeof hasImageGeneration>[0])
}

export interface RunImageGenerationShortcutArgs {
  readonly payload: {
    readonly model: string
    readonly input: unknown
    readonly tools?: ReadonlyArray<Record<string, unknown>>
    readonly stream?: boolean
  }
  readonly auth: { readonly userId?: string; readonly copilot?: CreateProviderOptions; readonly apiKeyId?: string }
  readonly telemetryCtx: TelemetryRequestContext
  readonly requestId?: string
  readonly userAgent?: string
}

export type RunImageGenerationShortcutResult =
  | EventResult<ProtocolFrame<ResponsesStreamEvent>>
  | { readonly kind: 'bridged-response'; readonly response: Response }

const IMAGE_GEN_UPSTREAM = 'image-generation' as const

const synthesizeFramesFromResponse = function* (
  response: ImageGenerationResponseShape,
): Generator<ProtocolFrame<ResponsesStreamEvent>> {
  // Build the Responses-API SSE event sequence from the image-generation
  // envelope. Mirrors `synthImageGenerationSSE` from the plugin core but
  // emits raw event objects (not encoded SSE bytes) so respond.ts can run
  // its own consumeWithState + encodeClientSSE pipeline uniformly with
  // the identity (responses → responses) attempt path.
  let seq = 0
  const inProgressView: ResponsesStreamEvent = {
    type: 'response.created',
    response: { ...response, status: 'in_progress', output: [] } as never,
    sequence_number: seq++,
  } as never
  yield eventFrame(inProgressView)
  yield eventFrame({
    type: 'response.in_progress',
    response: { ...response, status: 'in_progress', output: [] } as never,
    sequence_number: seq++,
  } as never as ResponsesStreamEvent)

  const item = response.output[0]
  if (!item) {
    yield eventFrame({
      type: 'response.completed',
      response,
      sequence_number: seq++,
    } as never as ResponsesStreamEvent)
    return
  }
  const outputIndex = 0
  const itemId = item.id as string
  const inProgressItem = { type: 'image_generation_call', id: itemId, status: 'in_progress' }
  yield eventFrame({
    type: 'response.output_item.added',
    output_index: outputIndex,
    item: inProgressItem as never,
    sequence_number: seq++,
  } as never as ResponsesStreamEvent)
  yield eventFrame({
    type: 'response.image_generation_call.in_progress',
    output_index: outputIndex,
    item_id: itemId,
    sequence_number: seq++,
  } as never as ResponsesStreamEvent)
  yield eventFrame({
    type: 'response.image_generation_call.generating',
    output_index: outputIndex,
    item_id: itemId,
    sequence_number: seq++,
  } as never as ResponsesStreamEvent)
  if (item.status === 'completed') {
    yield eventFrame({
      type: 'response.image_generation_call.completed',
      output_index: outputIndex,
      item_id: itemId,
      sequence_number: seq++,
    } as never as ResponsesStreamEvent)
  }
  yield eventFrame({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item: item as never,
    sequence_number: seq++,
  } as never as ResponsesStreamEvent)
  yield eventFrame({
    type: 'response.completed',
    response,
    sequence_number: seq++,
  } as never as ResponsesStreamEvent)
}

const errorJsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/**
 * Attach the `__interceptorReplaced` provenance flag to an EventResult so
 * `respond-telemetry.eventResultMetadata` knows the surface modelIdentity
 * was deliberately overridden by an interceptor-style replacement (here,
 * the image-gen shortcut). Without the flag respond-telemetry warns on the
 * console about an accidental finalMetadata set.
 */
const markInterceptorReplaced = <T>(
  result: EventResult<ProtocolFrame<T>>,
): EventResult<ProtocolFrame<T>> =>
  Object.assign(result, { __interceptorReplaced: true }) as never

export async function runImageGenerationShortcut(
  args: RunImageGenerationShortcutArgs,
): Promise<RunImageGenerationShortcutResult> {
  const publicModel = args.payload.model

  const validated = validateImageGenerationConfig(
    args.payload.tools as Parameters<typeof validateImageGenerationConfig>[0],
  )
  if (!validated.ok) {
    return {
      kind: 'bridged-response',
      response: errorJsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: validated.error.message,
          param: validated.error.param,
          code: validated.error.code,
        },
      }),
    }
  }
  const config = validated.config
  const prompt = extractPromptFromInput(args.payload.input)

  if (!prompt) {
    return {
      kind: 'bridged-response',
      response: errorJsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: 'image_generation shim could not extract a prompt from input.',
        },
      }),
    }
  }

  const allSources = collectImageSources(args.payload.input)
  const sources = allSources.filter((s) => editSupportedMime(s.mimeType) !== null)
  const isEdit = sources.length > 0
  const endpointKey = isEdit ? 'images_edits' : 'images_generations'

  const binding = await resolveBinding(config.model, endpointKey, {
    ownerId: args.auth.userId,
    copilot: args.auth.copilot,
  })
  if (!binding) {
    return {
      kind: 'bridged-response',
      response: errorJsonResponse(404, {
        error: {
          type: 'invalid_request_error',
          message: `No ${endpointKey} upstream available for backend model: ${config.model}.`,
        },
      }),
    }
  }

  const outcome: ImageGenerationOutcome = await generateImageViaBinding(
    binding,
    prompt,
    config,
    sources,
    {
      apiKeyId: args.auth.apiKeyId,
      userAgent: args.userAgent,
      requestId: args.requestId,
    },
  )
  const responseEnvelope = buildImageGenerationResponse(publicModel, prompt, outcome)

  // Build the identity used for telemetry persistence. The model id stamped
  // into the Repo `usage`/`performance` rows is the BACKEND image model
  // (`config.model`, defaulting to gpt-image-2) — not the public model the
  // SDK passed in. Dashboards already aggregate by backend model so usage
  // imported from the legacy path keeps matching.
  const backendModel = config.model || DEFAULT_IMAGE_MODEL
  const modelIdentity: TelemetryModelIdentity = {
    model: backendModel,
    upstream: IMAGE_GEN_UPSTREAM,
    modelKey: backendModel,
    cost: null,
  }

  // Image-generation always reports zero-token usage so `recordUsage` no-ops
  // (its nonZeroUsage guard skips the row). The performance row, however,
  // is always written with the request's success/failure flag so dashboards
  // capture the latency + isError shape.
  const failed = !outcome.ok
  const finalMetadataValue: EventResultMetadata = {
    modelIdentity,
    performance: {
      keyId: args.telemetryCtx.apiKeyId,
      model: backendModel,
      upstream: IMAGE_GEN_UPSTREAM,
      modelKey: backendModel,
      stream: args.telemetryCtx.isStreaming,
      runtimeLocation: args.telemetryCtx.runtimeLocation,
    },
  }

  // For the failure outcome (non-ok), respond.ts's success branch would
  // happily render a 200 SSE/JSON envelope (since synthImageGenerationSSE
  // emits a `response.completed` regardless), so we explicitly persist a
  // `failed=true` performance row here via waitUntil. The success branch
  // re-uses the same finalMetadata; persistFromEventResult won't double-write
  // because this writer skips the usage row (zero-token) and the perf row
  // here lands BEFORE respond.ts's recordPerformance fires (race-free under
  // a single `waitUntil` queue).
  //
  // Implementation note: we only force-write the failed perf row here so
  // respond.ts's normal flow (state.failed observed mid-stream → failed=true)
  // still works for the success path. The synthesised event sequence has no
  // failure events, so state.failed remains false in the success branch.
  if (failed) {
    waitUntil(
      recordPerformance(
        args.telemetryCtx,
        finalMetadataValue.performance,
        true,
      ),
    )
  }

  // Wrap the synthesised generator so respond.ts can drain it through its
  // identity-translator pipeline (consumeWithState → encodeClientSSE).
  const events = (async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    for (const frame of synthesizeFramesFromResponse(responseEnvelope)) yield frame
  })()

  const result: EventResult<ProtocolFrame<ResponsesStreamEvent>> = {
    type: 'events',
    events,
    modelIdentity,
    performance: finalMetadataValue.performance,
    finalMetadata: Promise.resolve(finalMetadataValue),
  }
  return markInterceptorReplaced(result)
}
