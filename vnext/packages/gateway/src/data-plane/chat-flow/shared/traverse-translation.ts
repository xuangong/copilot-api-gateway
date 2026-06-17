/**
 * Cross-protocol attempt traversal. Calls the source translator to produce a
 * hub-protocol payload, invokes the hub attempt, then wraps the returned event
 * stream with the translator's event mapper so the source protocol sees its
 * native frames. See spec §3.3.
 */
import { TranslatorValidationError } from '@vnext/translate/errors'
import {
  eventResult,
  internalErrorResult,
  type EventResult,
  type ExecuteResult,
  type ProtocolFrame,
} from '@vnext/protocols/common'
import type { PairTranslator } from '../../dispatch/translator-registry.ts'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'

/**
 * File-local alias mirroring `result.ts`'s `TranslatorProtocol`. The
 * `@vnext/protocols/common` package does not currently export this union; we
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
  innerAttempt: (args: InnerAttemptArgs) => Promise<ExecuteResult<ProtocolFrame<HubFrame>>>
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
): Promise<ExecuteResult<ProtocolFrame<SourceFrame>>> {
  let hubPayload: Record<string, unknown>
  try {
    hubPayload = (await args.translator.translateRequest(args.sourcePayload, {
      signal: args.signal ?? new AbortController().signal,
      fallbackMaxOutputTokens: args.fallbackMaxOutputTokens,
      model: args.model,
    })) as Record<string, unknown>
  } catch (err) {
    if (err instanceof TranslatorValidationError) {
      return internalErrorResult(400, err, undefined, 'translator-validation')
    }
    return internalErrorResult(
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

  // Hoist into a typed local so the closure below sees the narrowed `EventResult`.
  // (TS does not propagate type-guard narrowing into nested function expressions.)
  const innerEvents: EventResult<ProtocolFrame<HubFrame>> = inner

  // events: wrap with translator.translateEvents and protect against mid-stream throws
  async function* safeWrap(): AsyncGenerator<ProtocolFrame<SourceFrame>> {
    try {
      const translated = args.translator.translateEvents(innerEvents.events as never, {
        signal: args.signal ?? new AbortController().signal,
        fallbackMaxOutputTokens: args.fallbackMaxOutputTokens,
        model: args.model,
      }) as AsyncIterable<ProtocolFrame<SourceFrame>>
      for await (const frame of translated) yield frame
    } catch (err) {
      // Emit a terminal source-protocol error frame instead of throwing.
      // Shape is intentionally generic — `withUpstreamTelemetry` consumers downstream
      // tolerate unknown frame kinds; consumers that need a specific shape (e.g.
      // SSE encoders) sniff `kind` and ignore.
      yield {
        kind: 'translator-error',
        protocol: args.sourceProtocol,
        error: err instanceof Error ? err.message : String(err),
      } as never
    }
  }

  const sourceModelIdentity = {
    ...innerEvents.modelIdentity,
    translatorPair: { source: args.sourceProtocol, hub: args.hubProtocol },
  }
  return eventResult(
    safeWrap(),
    sourceModelIdentity,
    innerEvents.performance,
    innerEvents.finalMetadata,
    args.translator.translateBody as EventResult<ProtocolFrame<SourceFrame>>['translateBody'],
  )
}
