/**
 * Gemini interceptor chain (generate path).
 *
 * Order matches the reference project: payload cleanups first, then the
 * post-stream thought filter. All four are unconditional protocol-shape
 * fixes required because gemini requests never ride verbatim to any hub
 * target (gemini has no identity target — see attempt.ts).
 *
 * Ported from `copilot-gateway`'s `interceptors/index.ts`. countTokens
 * companion list is intentionally omitted here: vNext's count-tokens
 * path (`count-tokens.ts`) applies the payload mutators inline before
 * dispatching, matching the reference approach.
 */
import { stripSafetySettings } from './strip-safety-settings.ts'
import { stripUnsupportedPartFields } from './strip-unsupported-part-fields.ts'
import { stripUnsupportedTools } from './strip-unsupported-tools.ts'
import { suppressThoughtParts } from './suppress-thought-parts.ts'
import type { GeminiInterceptor } from './types.ts'

export const geminiInterceptors: readonly GeminiInterceptor[] = [
  stripUnsupportedPartFields,
  stripUnsupportedTools,
  stripSafetySettings,
  suppressThoughtParts,
]

export { stripSafetySettings, stripUnsupportedPartFields, stripUnsupportedTools, suppressThoughtParts }
export type { GeminiInterceptor } from './types.ts'
