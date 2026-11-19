import type { ResponsesInterceptor } from './types'
import { withRequestNormalization } from "../../shared/request-normalization"

// `transform-force-store-false`: send `store:false`, asking the upstream to run
// the Responses request statelessly. On by default for Copilot (400
// unsupported_value on store:true); available to every provider, e.g. an
// OpenAI-compatible server that ignores `previous_response_id`.
//
// Mirrors copilot-gateway 0fbffdcd0 (#601), which moved this out of the
// Copilot provider so the flag works on any upstream.
export const withStoreForcedFalse: ResponsesInterceptor = withRequestNormalization((inv) => {
  if (!inv.enabledFlags.has('transform-force-store-false')) return
  ;(inv.payload as Record<string, unknown>).store = false
})
