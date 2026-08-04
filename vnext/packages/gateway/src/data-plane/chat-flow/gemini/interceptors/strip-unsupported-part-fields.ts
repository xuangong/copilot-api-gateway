/**
 * Strip Gemini part fields with no equivalent in the upstream target graph.
 *
 * Gemini parts can carry `fileData`, `executableCode`, and `codeExecutionResult`
 * — features not modelled by our hub protocols (messages / responses /
 * chat_completions). Drop them at source so every gemini→X translator sees a
 * clean parts array. Parts that end up empty after stripping are removed.
 * Ported from `copilot-gateway`'s `strip-unsupported-part-fields.ts`.
 */
import type { GeminiInterceptor } from './types.ts'

interface GeminiPartLike {
  fileData?: unknown
  executableCode?: unknown
  codeExecutionResult?: unknown
  [k: string]: unknown
}

interface GeminiContentLike {
  parts: GeminiPartLike[]
  [k: string]: unknown
}

interface GeminiPayloadLike {
  contents?: GeminiContentLike[]
  systemInstruction?: { parts: GeminiPartLike[] } & Record<string, unknown>
  [k: string]: unknown
}

const stripPartFields = (parts: GeminiPartLike[]): GeminiPartLike[] =>
  parts.filter((part) => {
    delete part.fileData
    delete part.executableCode
    delete part.codeExecutionResult
    return Object.keys(part).length > 0
  })

export const stripUnsupportedPartFieldsFromPayload = (payload: GeminiPayloadLike): void => {
  payload.contents?.forEach((content) => {
    content.parts = stripPartFields(content.parts)
  })
  if (payload.systemInstruction) {
    payload.systemInstruction.parts = stripPartFields(payload.systemInstruction.parts)
  }
}

export const stripUnsupportedPartFields: GeminiInterceptor = (ctx, _requestCtx, run) => {
  stripUnsupportedPartFieldsFromPayload(ctx.payload as GeminiPayloadLike)
  return run()
}
