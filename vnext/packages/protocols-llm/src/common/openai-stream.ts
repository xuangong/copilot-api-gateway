/**
 * Shared OpenAI streaming wire-shape predicate.
 *
 * When `stream_options.include_usage` is on, an OpenAI-compatible upstream
 * closes the stream with a chunk that carries the usage totals and no content.
 * The gateway forces that flag upstream for billing and strips the chunk back
 * out when the client did not ask for it, so several call sites need to
 * recognize the chunk.
 *
 * The chunk's `choices` shape varies by vendor. Vanilla OpenAI and vanilla
 * vLLM emit `choices: []`. Vendor vLLM forks — the Zhipu/GLM fork is the one
 * seen in the wild — emit `choices: [{ index: 0 }]`: a structural placeholder
 * with no content fields. A bare `choices.length === 0` test therefore misses
 * the fork's chunk entirely.
 *
 * This predicate identifies the chunk by "carries usage" + "no choice element
 * has any actual content", which covers both shapes and matches the LiteLLM /
 * One-API / New-API consensus. Ported from copilot-gateway's
 * packages/protocols/src/common/openai-stream.ts.
 */
export const isOpenAIUsageOnlyEventShape = (event: unknown): boolean => {
  if (typeof event !== 'object' || event === null) return false
  const { choices, usage } = event as { choices?: unknown; usage?: unknown }
  if (usage === undefined || usage === null) return false
  if (!Array.isArray(choices)) return false
  // `every` over an empty array is true, which is what admits the OpenAI /
  // vanilla-vLLM shape. A non-empty array passes only when every element is a
  // structural placeholder — no text, no delta keys, no finish_reason.
  return choices.every((choice) => {
    if (typeof choice !== 'object' || choice === null) return false
    const {
      text,
      delta,
      finish_reason: finishReason,
    } = choice as { text?: unknown; delta?: unknown; finish_reason?: unknown }
    if (typeof text === 'string' && text.length > 0) return false
    if (finishReason !== undefined && finishReason !== null) return false
    if (delta !== undefined && delta !== null) {
      if (typeof delta !== 'object') return false
      if (Object.keys(delta as object).length > 0) return false
    }
    return true
  })
}
