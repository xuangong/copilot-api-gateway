/**
 * Anthropic Fast Mode bridge (`speed: 'fast'`).
 *
 * Anthropic Fast Mode is a per-request opt-in carried by `speed: 'fast'` on
 * the Messages request and echoed back as `usage.speed: 'fast'`. Copilot
 * upstream does NOT speak Fast Mode on the wire — the tier is resolved via
 * the `-fast` raw model id (variant selection) and the upstream never echoes
 * `usage.speed`. This interceptor bridges the two contracts at the gateway
 * boundary:
 *
 *   - Strip `speed: 'fast' | 'standard'` from the outbound payload. Copilot
 *     rejects unknown fields on strict variants, so leaking `speed` through
 *     would trigger 400s. Unknown `speed` values (client bug) are left
 *     untouched so upstream surfaces the same `invalid_request_error`
 *     Anthropic itself would.
 *   - When the caller asked for Fast Mode, stamp `usage.speed = 'fast'`
 *     onto every `message_start` (via `event.message.usage`) and
 *     `message_delta` (via `event.usage`) frame downstream so billing
 *     (`speed` → tier='fast' → `serviceTier: 'fast'` pricing entry) and
 *     Anthropic-compatible clients see the marker they expect.
 *
 * Wire location: gateway messages interceptor chain (not provider-copilot).
 * In vNext, provider-copilot's `CopilotInterceptor` returns raw `Response`
 * before SSE parsing — event-frame reshaping must happen at the gateway
 * MessagesInterceptor layer where the stream has been decoded to
 * `ProtocolFrame<MessagesStreamEvent>`. Reference project's
 * `handle-speed-fast.ts` lives at the provider boundary because there the
 * boundary already exposes typed event frames; vNext moves it up one layer.
 *
 * References:
 * - https://docs.claude.com/en/build-with-claude/fast-mode
 * - https://docs.claude.com/en/api/service-tiers
 * - copilot-gateway `provider-copilot/interceptors/messages/handle-speed-fast.ts`
 */
import type { MessagesInterceptor } from './types'
import { eventFrame, type ProtocolFrame } from '@vibe-core/result'
import type { MessagesStreamEvent } from '@vibe-llm/protocols/messages'

interface SpeedPayload {
  speed?: unknown
  [k: string]: unknown
}

const stampFastSpeedOntoUsage = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  for await (const frame of frames) {
    if (frame.type === 'done') {
      yield frame
      continue
    }
    const { event } = frame
    if (event.type === 'message_start') {
      yield eventFrame({
        ...event,
        message: {
          ...event.message,
          usage: { ...event.message.usage, speed: 'fast' },
        },
      })
      continue
    }
    if (event.type === 'message_delta' && event.usage) {
      yield eventFrame({
        ...event,
        usage: { ...event.usage, speed: 'fast' },
      })
      continue
    }
    yield frame
  }
}

export const withSpeedFast: MessagesInterceptor = async (inv, _ctx, run) => {
  const payload = inv.payload as SpeedPayload
  const speed = payload.speed
  const stampFast = speed === 'fast'

  if (speed === 'fast' || speed === 'standard') {
    delete payload.speed
  }

  const result = await run()

  if (!stampFast || result.type !== 'events') return result
  return {
    ...result,
    events: stampFastSpeedOntoUsage(result.events),
  }
}
