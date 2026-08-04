/**
 * Kimi (Moonshot) wire-dialect normalizer for Chat Completions. Flag-gated
 * by `vendor-kimi`. Inbound only: remap flat `usage.cached_tokens` →
 * `usage.prompt_tokens_details.cached_tokens`.
 *
 * Reference:
 * - https://platform.kimi.com/docs/api/chat
 * - copilot-gateway `packages/gateway/src/data-plane/chat/chat-completions/interceptors/vendor-kimi-normalize.ts`
 */
import type { ChatCompletionsInterceptor } from './types'
import { asJsonObject, readJsonNumber, type JsonObject } from '../../shared/json-helpers'
import type { ChatCompletionsStreamEvent } from '@vibe-llm/protocols/chat'
import { eventFrame } from '@vibe-core/result'

const rewriteInboundUsage = (chunk: ChatCompletionsStreamEvent): ChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage)
  if (!usage) return chunk
  const cached = readJsonNumber(usage.cached_tokens)
  if (cached == null) return chunk

  const { cached_tokens: _stripped, ...rest } = usage
  const next: JsonObject = {
    ...rest,
    prompt_tokens_details: {
      ...(asJsonObject(usage.prompt_tokens_details) ?? {}),
      cached_tokens: cached,
    },
  }
  return { ...chunk, usage: next as unknown as ChatCompletionsStreamEvent['usage'] }
}

export const withVendorKimiChatCompletionsNormalize: ChatCompletionsInterceptor = async (
  inv,
  _ctx,
  run,
) => {
  if (!inv.enabledFlags.has('vendor-kimi')) return await run()

  const result = await run()
  if (result.type !== 'events') return result

  return {
    ...result,
    events: (async function* () {
      for await (const frame of result.events) {
        if (frame.type !== 'event') {
          yield frame
          continue
        }
        const event = rewriteInboundUsage(frame.event)
        yield event === frame.event ? frame : eventFrame(event)
      }
    })(),
  }
}
