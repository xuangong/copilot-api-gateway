import type { ChatCompletionsInterceptor } from './types'

// Chat Completions streaming only includes the final usage-only chunk when
// `stream_options.include_usage` is enabled. We force that on here because
// the gateway's source responders and usage tracking rely on those usage
// frames for both streaming passthrough and non-stream reassembly.
//
// The follow-on question is whether to surface the synthesized usage chunk
// to the client. The client's intent is whatever the caller put on
// `stream_options.include_usage` BEFORE this interceptor mutated it; the
// downstream SSE renderer reads that intent directly off the original
// payload, so this interceptor only has to flip the upstream-facing flag.
//
// This interceptor is a no-op when the request is not a streaming request:
// non-stream requests synthesize their own non-stream result via reassembly
// and never look at `stream_options.include_usage` for upstream behavior.
//
// Reference: https://platform.openai.com/docs/api-reference/chat/create
export const withUsageStreamOptionsIncluded: ChatCompletionsInterceptor = async (inv, _ctx, run) => {
  if (inv.payload.stream !== true) return await run()
  const existing = inv.payload.stream_options as Record<string, unknown> | undefined
  inv.payload.stream_options = existing
    ? { ...existing, include_usage: true }
    : { include_usage: true }
  return await run()
}
