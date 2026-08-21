/**
 * `TelemetryRequestContext.sourceApi` → `Invocation.sourceApi`.
 *
 * The two use different spellings for the same thing (`'chat-completions'` vs
 * `'chat_completions'`), and telemetry is the only field threaded intact across
 * `traverseTranslation` — so it is the source of truth for "which protocol does
 * the client actually speak" once a request has hopped onto another attempt.
 *
 * `undefined` means a caller that predates the field. Each attempt supplies its
 * own protocol as the fallback so those call sites keep behaving as native.
 */
import type { Invocation } from '@vibe-llm/protocols/common'
import type { TelemetryRequestContext } from './telemetry-ctx.ts'

export const invocationSourceApi = (
  telemetrySourceApi: TelemetryRequestContext['sourceApi'],
  nativeFallback: NonNullable<Invocation['sourceApi']>,
): Invocation['sourceApi'] => {
  switch (telemetrySourceApi) {
    case 'gemini':
      return 'gemini'
    case 'responses':
      return 'responses'
    case 'chat-completions':
      return 'chat_completions'
    case 'messages':
      return 'messages'
    default:
      return nativeFallback
  }
}
