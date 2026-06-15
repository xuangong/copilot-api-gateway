import type { ChatCompletionsInterceptor } from './types'
import { withUsageStreamOptionsIncluded } from './include-usage-stream-options'

// Unified Chat Completions interceptor registry. Part 3 of Spec 2 wires this
// into the production data-plane; Part 2 only exposes the registry so the
// chain-level integration test can prove the include-usage interceptor runs
// end-to-end via `runInterceptors`.
//
// Order: `withUsageStreamOptionsIncluded` flips upstream `stream_options.include_usage`
// before any vendor-specific normalizer would observe the wire body, matching
// the source-then-target ordering in the reference implementation.
export const chatCompletionsInterceptors: readonly ChatCompletionsInterceptor[] = [
  withUsageStreamOptionsIncluded,
]
