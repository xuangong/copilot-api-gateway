import { discardEventProducer } from "./producer-ownership"
import { selectedTierBody, selectedTierEvent, selectedTierRequest } from "./execution-tier"
import type { DumpAccumulator } from "../../../shared/dump/accumulator.ts"
/**
 * Cross-protocol attempt traversal. Calls the source translator to produce a
 * hub-protocol payload, invokes the hub attempt, and forwards the returned
 * hub-shape frames downstream verbatim — the translator's event mapper is
 * applied at the source-protocol respond.ts streaming branch, NOT here. See
 * spec §3.7.
 *
 * Why pass-through (not in-line translate): respond.ts has two consumers of
 * the result event stream:
 *   1. Streaming (SSE): needs source-shape frames → translator must run.
 *   2. Non-streaming (JSON): needs HUB-shape frames so the hub reassembler
 *      (`collectResponsesProtocolEventsToResult` / `…Messages…`) can drain
 *      them into a hub-shape JSON envelope, which `translateBody` then maps
 *      to the source JSON shape.
 *
 * Translating in `traverseTranslation` would satisfy (1) but break (2) — and
 * vice versa. Forwarding hub frames lets respond.ts apply the translator
 * lazily ONLY for streaming, while non-streaming gets the canonical
 * "hub-events → hub-JSON → translateBody" path described in spec §3.7.
 */
import { TranslatorValidationError } from '@vibe-llm/translate/errors'
import { selectedCustomToolNames } from '@vibe-llm/translate/shared/responses-tools'
import type { ResponsesPayload } from '@vibe-llm/protocols/responses'
import {
  llmInternalErrorResult,
  type TranslatedLlmEventResult,
  type TranslatorProtocol,
  type LlmExecuteResult,
} from '@vibe-llm/protocols/common'
import { type ProtocolFrame } from '@vibe-core/result'
import type { PairTranslator } from '../../dispatch/translator-registry.ts'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'
import { performanceTargetFromProtocol } from './respond-telemetry.ts'

export interface InnerAttemptArgs {
  dump?: DumpAccumulator | null
  payload: Record<string, unknown>
  auth: unknown
  inheritedHeaders: Record<string, string>
  inheritedTelemetryCtx: TelemetryRequestContext
  snapshotMode: 'none'
  requestId?: string
  userAgent?: string
  signal?: AbortSignal
}

export interface TraverseTranslationArgs<HubFrame> {
  dump?: DumpAccumulator | null
  abortUpstream?: () => void
  sourcePayload: Record<string, unknown>
  sourceProtocol: TranslatorProtocol
  hubProtocol: TranslatorProtocol
  translator: PairTranslator
  innerAttempt: (args: InnerAttemptArgs) => Promise<LlmExecuteResult<ProtocolFrame<HubFrame>>>
  inheritedHeaders: Record<string, string>
  inheritedTelemetryCtx: TelemetryRequestContext
  auth: unknown
  requestId?: string
  userAgent?: string
  signal?: AbortSignal
  fallbackMaxOutputTokens?: number
  model?: string
}

export async function traverseTranslation<HubFrame, SourceFrame>(
  args: TraverseTranslationArgs<HubFrame>,
): Promise<LlmExecuteResult<ProtocolFrame<SourceFrame>>> {
  let hubPayload: Record<string, unknown>
  let sourceSnapshot = args.sourcePayload
  let customToolNames: readonly string[] = []
  try {
    hubPayload = (await args.translator.translateRequest(args.sourcePayload, {
      signal: args.signal ?? new AbortController().signal,
      fallbackMaxOutputTokens: args.fallbackMaxOutputTokens,
      model: args.model,
    })) as Record<string, unknown>
    hubPayload = selectedTierRequest(args.sourceProtocol, args.hubProtocol, args.sourcePayload, hubPayload)
    if (args.sourceProtocol === 'responses' && (args.hubProtocol === 'chat_completions' || args.hubProtocol === 'messages')) {
      customToolNames = selectedCustomToolNames(args.sourcePayload as unknown as ResponsesPayload)
      // Reverse translation only needs these request-side envelope fields. Keep
      // their values stable if an inner interceptor mutates the source object.
      sourceSnapshot = Object.fromEntries(
        ['instructions', 'metadata', 'parallel_tool_calls', 'temperature', 'tool_choice', 'tools', 'top_p', 'text']
          .filter(key => key in args.sourcePayload)
          .map(key => [key, structuredClone(args.sourcePayload[key])]),
      )
    }
  } catch (err) {
    if (err instanceof TranslatorValidationError) {
      return llmInternalErrorResult(400, err, undefined, 'translator-validation')
    }
    return llmInternalErrorResult(
      500,
      err instanceof Error ? err : new Error(String(err)),
      undefined,
      'translator-internal',
    )
  }

  // Native targets cannot echo Responses text configuration. Keep the source
  // value independent of provider mutations for JSON and SSE envelopes.
  const sourceText = args.sourceProtocol === 'responses' ? sourceSnapshot.text : undefined
  const echoText = <T>(body: T): T => sourceText !== undefined && body !== null && typeof body === 'object'
    ? { ...body, text: structuredClone(sourceText) }
    : body
  const echoEventText = async function* (events: AsyncIterable<unknown>): AsyncIterable<unknown> {
    for await (const event of events) {
      if (sourceText !== undefined && event !== null && typeof event === 'object' && 'response' in event) {
        yield selectedTierEvent(args.sourceProtocol, { ...event, response: echoText(event.response) }, executionTier)
      } else yield selectedTierEvent(args.sourceProtocol, event, executionTier)
    }
  }

  const inner = await args.innerAttempt({
    dump: args.dump,
    payload: hubPayload,
    auth: args.auth,
    inheritedHeaders: args.inheritedHeaders,
    inheritedTelemetryCtx: args.inheritedTelemetryCtx,
    snapshotMode: 'none',
    requestId: args.requestId,
    userAgent: args.userAgent,
    signal: args.signal,
  })

  if (inner.type === 'upstream-error') {
    return inner.targetApi
      ? inner
      : {
          ...inner,
          targetApi: performanceTargetFromProtocol(args.hubProtocol),
        }
  }
  if (inner.type === 'internal-error') {
    const prefix = `via-translator:${args.sourceProtocol}→${args.hubProtocol}`
    const reason = inner.reason ? `${prefix}:${inner.reason}` : prefix
    return { ...inner, reason }
  }

  if (inner.producer || inner.translateBody || inner.translateEvents) {
    await discardEventProducer(inner, args.abortUpstream)
    return llmInternalErrorResult(502, new Error('Nested translated event producers are unsupported'), inner.performance, 'translator-producer')
  }
  const innerEvents = inner
  const executionTier = innerEvents.modelIdentity.executedServiceTier

  // Preserve opaque hub frames and make their domain independent of telemetry.
  // The source consumer chooses lazy body or event translation.
  const translatorPair = { source: args.sourceProtocol, hub: args.hubProtocol } as const
  const sourceModelIdentity = {
    ...innerEvents.modelIdentity,
    incomingModel: args.inheritedTelemetryCtx.incomingModel,
    translatorPair,
  }
  const finalMetadata = innerEvents.finalMetadata?.then((metadata) => ({
    ...metadata,
    modelIdentity: { ...metadata.modelIdentity, incomingModel: args.inheritedTelemetryCtx.incomingModel, translatorPair },
  }))
  const innerResolver = innerEvents.resolveModelIdentity
  const resolveModelIdentity = innerResolver
    ? (modelKey: string) => ({
        ...innerResolver(modelKey),
        incomingModel: args.inheritedTelemetryCtx.incomingModel,
        translatorPair,
      })
    : undefined
  const result: TranslatedLlmEventResult = {
    type: 'events',
    discardProducer: innerEvents.discardProducer,
    producer: { kind: 'translated', source: args.sourceProtocol, protocol: args.hubProtocol },
    events: innerEvents.events,
    modelIdentity: sourceModelIdentity,
    performance: innerEvents.performance,
    finalMetadata,
    // Wrap translateBody so the hub→source envelope mapper sees the original
    // client-side request payload. Required by translators (e.g.
    // responses-via-chat-completions/body.ts) that echo back fields like
    // `instructions`, `metadata`, `tool_choice`, `tools` which the upstream
    // Chat-Completions response never carries.
    translateBody: async (hubJson, ctx) =>
      selectedTierBody(args.sourceProtocol, echoText(await args.translator.translateBody(hubJson, {
        signal: ctx?.signal ?? new AbortController().signal,
        fallbackMaxOutputTokens: ctx?.fallbackMaxOutputTokens,
        model: ctx?.model,
        sourcePayload: sourceSnapshot,
        customToolNames,
      })), executionTier),
    // translateEvents: respond.ts streaming branch unwraps hub frames, runs
    // these through the translator, then re-wraps as source frames before SSE
    // encoding. The translator function here consumes BARE hub events (not
    // ProtocolFrame envelopes) and yields BARE source events.
    translateEvents: (events, ctx) => echoEventText(args.translator.translateEvents(events, {
      signal: ctx?.signal ?? new AbortController().signal,
      fallbackMaxOutputTokens: ctx?.fallbackMaxOutputTokens,
      model: ctx?.model,
      sourcePayload: sourceSnapshot,
      customToolNames,
    })),
    resolveModelIdentity,
  }
  return innerEvents.__interceptorReplaced
    ? { ...result, __interceptorReplaced: true }
    : result
}
