/**
 * Strip Gemini `safetySettings` from the outbound payload.
 *
 * Copilot's Gemini upstream rejects (or silently ignores) `safetySettings`
 * — the harm-category thresholds that the public Gemini SDK ships by default.
 * We drop the field before dispatch so the upstream request stays clean.
 * Ported from `copilot-gateway`'s `strip-safety-settings.ts` (reference impl).
 */
import type { GeminiInterceptor } from './types.ts'
import { withRequestNormalization } from "../../shared/request-normalization"

export const stripSafetySettings: GeminiInterceptor = withRequestNormalization((inv) => {
  const payload = inv.payload as { safetySettings?: unknown }
  delete payload.safetySettings
})
