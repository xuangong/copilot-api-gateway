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
import { TranslatorValidationError } from '@vnext/translate/errors'
import {
  llmEventResult,
  llmInternalErrorResult,
  type LlmEventResult,
  type LlmExecuteResult,
} from '@vnext-llm/protocols/common'
import { type ProtocolFrame } from '@vnext-gateway/result'
import type { PairTranslator } from '../../dispatch/translator-registry.ts'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'

/**
 * File-local alias mirroring `result.ts`'s `TranslatorProtocol`. The
 * `@vnext-llm/protocols/common` package does not currently export this union; we
 * replicate it here so the helper's public signature stays narrow without
 * coupling to a re-export that doesn't yet exist.
 */
type TranslatorProtocol = 'chat_completions' | 'messages' | 'responses' | 'gemini'

export interface InnerAttemptArgs {
  payload: Record<string, unknown>
  auth: unknown
  inheritedHeaders: Record<string, string>
  inheritedTelemetryCtx: TelemetryRequestContext
  snapshotMode: 'none'
  requestId?: string
  userAgent?: string
  signal?: AbortSignal
}

export interface TraverseTranslationArgs<HubFrame, SourceFrame> {
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
  args: TraverseTranslationArgs<HubFrame, SourceFrame>,
): Promise<LlmExecuteResult<ProtocolFrame<SourceFrame>>> {
  let hubPayload: Record<string, unknown>
  try {
    hubPayload = (await args.translator.translateRequest(args.sourcePayload, {
      signal: args.signal ?? new AbortController().signal,
      fallbackMaxOutputTokens: args.fallbackMaxOutputTokens,
      model: args.model,
    })) as Record<string, unknown>
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

  const inner = await args.innerAttempt({
    payload: hubPayload,
    auth: args.auth,
    inheritedHeaders: args.inheritedHeaders,
    inheritedTelemetryCtx: args.inheritedTelemetryCtx,
    snapshotMode: 'none',
    requestId: args.requestId,
    userAgent: args.userAgent,
    signal: args.signal,
  })

  if (inner.type === 'upstream-error') return inner
  if (inner.type === 'internal-error') {
    const prefix = `via-translator:${args.sourceProtocol}→${args.hubProtocol}`
    const reason = inner.reason ? `${prefix}:${inner.reason}` : prefix
    return { ...inner, reason }
  }

  // Hoist into a typed local so the cast below sees the narrowed `LlmEventResult`.
  // (TS does not propagate type-guard narrowing across the assignment.)
  const innerEvents: LlmEventResult<ProtocolFrame<HubFrame>> = inner

  // Forward hub-shape frames downstream verbatim. respond.ts decides per
  // request mode (streaming vs non-streaming) whether to apply the translator:
  //   - streaming: the chat-completions / messages / responses respond.ts
  //     unwraps `ProtocolFrame<HubFrame>` → bare hub events, runs
  //     `translator.translateEvents`, re-wraps source events into ProtocolFrame
  //     before SSE encoding;
  //   - non-streaming: respond.ts dispatches reassembly on
  //     `modelIdentity.translatorPair.hub`, drains hub frames through the hub
  //     reassembler into a hub-shape JSON envelope, then calls
  //     `result.translateBody` to convert the envelope to the source JSON
  //     shape (per spec §3.7).
  // The `translatorPair` field on `modelIdentity` (set below) is the discriminator
  // respond.ts uses for the dispatch.
  const sourceModelIdentity = {
    ...innerEvents.modelIdentity,
    translatorPair: { source: args.sourceProtocol, hub: args.hubProtocol },
  }
  return llmEventResult(
    // Cast: the events stream is structurally `ProtocolFrame<HubFrame>`, but
    // the source-protocol LlmExecuteResult is typed as `ProtocolFrame<SourceFrame>`.
    // respond.ts (the only consumer of this result) discriminates on
    // `translatorPair` and treats the events as hub-shape — so the cast is sound
    // at runtime, just outside what TS can prove.
    innerEvents.events as unknown as AsyncIterable<ProtocolFrame<SourceFrame>>,
    sourceModelIdentity,
    innerEvents.performance,
    innerEvents.finalMetadata,
    args.translator.translateBody as LlmEventResult<ProtocolFrame<SourceFrame>>['translateBody'],
    // translateEvents: respond.ts streaming branch unwraps hub frames, runs
    // these through the translator, then re-wraps as source frames before SSE
    // encoding. The translator function here consumes BARE hub events (not
    // ProtocolFrame envelopes) and yields BARE source events.
    args.translator.translateEvents as LlmEventResult<ProtocolFrame<SourceFrame>>['translateEvents'],
  )
}
