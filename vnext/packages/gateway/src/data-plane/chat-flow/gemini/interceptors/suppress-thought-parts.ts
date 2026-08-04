/**
 * Suppress Gemini thought-summary parts unless the caller opted in.
 *
 * Reference project semantics: when
 * `generationConfig.thinkingConfig.includeThoughts !== true`, filter parts
 * where `thought === true` out of every stream frame, and drop candidates that
 * end up empty (unless they carry a terminal `finishReason`). Frames with no
 * remaining payload (no candidates, no usageMetadata, no modelVersion, no
 * responseId) are skipped entirely.
 *
 * vNext specialisation: gemini has no identity target (see `attempt.ts`),
 * so `result.events` carries HUB-shape frames and `result.translateEvents`
 * converts hub → gemini at SSE time. Filtering must therefore run AFTER
 * translation, which means we wrap `translateEvents` rather than
 * `result.events` directly. Non-streaming (`renderEventsAsJson` in
 * `respond.ts`) already discards `thought: true` text chunks during
 * reassembly (see `gemini/respond.ts` `reassembleGeminiEvents` — `!part.thought`
 * guard); we only intervene when the SSE path is active. To keep behavior
 * symmetric across both branches without duplicating logic, we always attach
 * the filter — the non-stream reassembler will see already-filtered gemini
 * events and produce the same envelope.
 *
 * Ported from `copilot-gateway`'s `suppress-thought-parts.ts` interceptor.
 */
import type { GeminiInterceptor } from './types.ts'

interface GeminiPartLike {
  thought?: boolean
  text?: string
  [k: string]: unknown
}

interface GeminiCandidateLike {
  content?: { parts?: GeminiPartLike[]; [k: string]: unknown } & Record<string, unknown>
  finishReason?: unknown
  [k: string]: unknown
}

interface GeminiFrameLike {
  candidates?: GeminiCandidateLike[]
  usageMetadata?: unknown
  modelVersion?: unknown
  responseId?: unknown
  error?: unknown
  [k: string]: unknown
}

const hasEventPayload = (event: GeminiFrameLike): boolean => {
  if (event.error !== undefined) return true
  return (
    (event.candidates?.length ?? 0) > 0
    || event.usageMetadata !== undefined
    || event.modelVersion !== undefined
    || event.responseId !== undefined
  )
}

async function* suppressThoughtPartsFromEvents(
  events: AsyncIterable<unknown>,
): AsyncGenerator<unknown> {
  for await (const raw of events) {
    const frame = raw as GeminiFrameLike | null
    if (!frame || typeof frame !== 'object' || frame.error !== undefined) {
      yield raw
      continue
    }

    const candidates = frame.candidates?.flatMap((candidate) => {
      const parts = (candidate.content?.parts ?? []).filter((part) => part.thought !== true)
      if (parts.length === 0 && candidate.finishReason === undefined) return []
      return [{
        ...candidate,
        content: { ...(candidate.content ?? {}), parts },
      }]
    })

    const next: GeminiFrameLike = {
      ...frame,
      ...(candidates !== undefined ? { candidates } : {}),
    }
    if (hasEventPayload(next)) yield next
  }
}

export const suppressThoughtParts: GeminiInterceptor = async (ctx, _requestCtx, run) => {
  const result = await run()
  if (result.type !== 'events') return result

  const payload = ctx.payload as {
    generationConfig?: { thinkingConfig?: { includeThoughts?: boolean } }
  }
  if (payload.generationConfig?.thinkingConfig?.includeThoughts === true) return result

  // vNext: gemini always cross-protocol → `result.translateEvents` converts
  // hub → gemini at SSE time. Wrap it so `thought: true` parts are filtered
  // AFTER translation. If `translateEvents` is absent (defensive: shouldn't
  // happen for gemini in production), pass through — hub frames don't carry
  // gemini `thought` parts anyway.
  if (!result.translateEvents) return result
  const inner = result.translateEvents
  const wrappedTranslate: NonNullable<typeof result.translateEvents> = (events, tCtx) =>
    suppressThoughtPartsFromEvents(inner(events, tCtx))
  return { ...result, translateEvents: wrappedTranslate }
}
