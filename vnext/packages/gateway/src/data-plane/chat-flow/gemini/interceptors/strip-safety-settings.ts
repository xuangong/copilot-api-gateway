/**
 * Strip Gemini `safetySettings` from the outbound payload.
 *
 * Copilot's Gemini upstream rejects (or silently ignores) `safetySettings`
 * — the harm-category thresholds that the public Gemini SDK ships by default.
 * We drop the field before dispatch so the upstream request stays clean.
 * Ported from `copilot-gateway`'s `strip-safety-settings.ts` (reference impl).
 */
import type { GeminiInterceptor } from './types.ts'

export const stripSafetySettings: GeminiInterceptor = (ctx, _requestCtx, run) => {
  const payload = ctx.payload as { safetySettings?: unknown }
  delete payload.safetySettings
  return run()
}
