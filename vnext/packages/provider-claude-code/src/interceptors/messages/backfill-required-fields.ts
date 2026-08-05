import type { MessagesBoundaryCtx } from './types'
import { MESSAGES_FALLBACK_MAX_TOKENS } from '@vibe-llm/protocols/messages'

// Real Claude Code always sends `max_tokens` and `temperature`. Anthropic's
// `/v1/messages` requires `max_tokens` (422 otherwise); `temperature` absence
// is a CC-shape fingerprint failure. Third-party callers routinely omit one
// or both, expecting the gateway to backfill.
//
// Sub2api backfills `max_tokens=128000` and `temperature=1` unconditionally.
// We mirror the temperature default but cap `max_tokens` to the model's
// advertised output limit (`limits.max_output_tokens`), falling back to
// MESSAGES_FALLBACK_MAX_TOKENS (8192). Caller-supplied values are never
// overwritten.
export const backfillRequiredFields = async <TResult>(
  _env: object,
  ctx: MessagesBoundaryCtx,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const next = { ...ctx.payload }

  next.max_tokens ??= ctx.model.limits.max_output_tokens ?? MESSAGES_FALLBACK_MAX_TOKENS
  next.temperature ??= 1

  ctx.payload = next
  return await run()
}
