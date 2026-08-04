/**
 * DeepSeek wire-dialect normalizer for Chat Completions. Flag-gated by
 * `vendor-deepseek`. Positioned last in the interceptor chain so it sees
 * the OpenAI-canonical wire body the gateway generates.
 *
 * Outbound:
 * - `reasoning_effort: 'none'` → strip + emit `thinking: { type: 'disabled' }`
 * - assistant `reasoning_text` / `reasoning_items.summary` → `reasoning_content`
 *   (drop `reasoning_opaque` — DeepSeek doesn't accept it)
 * - `response_format: { type: 'json_schema' }` → `{ type: 'json_object' }`
 *
 * Inbound stream:
 * - delta `reasoning_content` → `reasoning_text`
 * - usage `prompt_cache_hit_tokens` → `prompt_tokens_details.cached_tokens`
 *   (drop `prompt_cache_miss_tokens`)
 *
 * References:
 * - https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 * - https://api-docs.deepseek.com/guides/kv_cache
 * - copilot-gateway `packages/gateway/src/data-plane/chat/chat-completions/interceptors/vendor-deepseek-normalize.ts`
 */
import type { ChatCompletionsInterceptor } from './types'
import { asJsonObject, readJsonNumber, type JsonObject } from '../../shared/json-helpers'
import type {
  ChatCompletionsReasoningItem,
  ChatCompletionsStreamEvent,
} from '@vibe-llm/protocols/chat'
import { eventFrame } from '@vibe-core/result'

const synthesizeFromItems = (
  items: ChatCompletionsReasoningItem[] | null | undefined,
): string | undefined => {
  if (!items?.length) return undefined
  const parts = items.flatMap((item) => item.summary?.map((s) => s.text) ?? [])
  return parts.length > 0 ? parts.join('') : undefined
}

const rewriteOutboundMessage = (message: JsonObject): JsonObject => {
  const {
    reasoning_text,
    reasoning_opaque: _opaque,
    reasoning_items,
    ...rest
  } = message
  const text =
    typeof reasoning_text === 'string'
      ? reasoning_text
      : synthesizeFromItems(reasoning_items as ChatCompletionsReasoningItem[] | null | undefined)
  if (text === undefined) return rest
  return { ...rest, reasoning_content: text }
}

const stripCanonicalReasoningSentinel = (payload: JsonObject): JsonObject => {
  if (payload.reasoning_effort !== 'none') return payload
  const { reasoning_effort: _stripped, ...rest } = payload
  return { ...rest, thinking: { type: 'disabled' } }
}

const downgradeJsonSchemaResponseFormat = (payload: JsonObject): JsonObject => {
  const rf = asJsonObject(payload.response_format)
  if (!rf || rf.type !== 'json_schema') return payload
  return { ...payload, response_format: { type: 'json_object' } }
}

const rewriteOutboundPayload = (payload: JsonObject): JsonObject => {
  const withDisable = stripCanonicalReasoningSentinel(payload)
  const withResponseFormat = downgradeJsonSchemaResponseFormat(withDisable)
  const messages = withResponseFormat.messages
  if (!Array.isArray(messages)) return withResponseFormat
  return {
    ...withResponseFormat,
    messages: messages.map((m) => {
      const obj = asJsonObject(m)
      return obj ? rewriteOutboundMessage(obj) : m
    }),
  }
}

const rewriteInboundDeltas = (chunk: ChatCompletionsStreamEvent): ChatCompletionsStreamEvent => {
  let changed = false
  const choices = chunk.choices.map((choice) => {
    const delta = choice.delta as ChatCompletionsStreamEvent['choices'][number]['delta'] & {
      reasoning_content?: unknown
    }
    if (typeof delta.reasoning_content !== 'string') return choice
    const { reasoning_content, ...rest } = delta
    changed = true
    return {
      ...choice,
      delta: {
        ...rest,
        ...(delta.reasoning_text === undefined ? { reasoning_text: reasoning_content } : {}),
      },
    }
  })
  return changed ? { ...chunk, choices } : chunk
}

const VENDOR_CACHE_FIELDS = ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'] as const

const rewriteInboundUsage = (chunk: ChatCompletionsStreamEvent): ChatCompletionsStreamEvent => {
  const usage = asJsonObject(chunk.usage)
  if (!usage) return chunk
  const hasVendorField = VENDOR_CACHE_FIELDS.some((f) => usage[f] !== undefined)
  if (!hasVendorField) return chunk
  const hit = readJsonNumber(usage.prompt_cache_hit_tokens)
  const next: JsonObject = { ...usage }
  for (const f of VENDOR_CACHE_FIELDS) delete next[f]
  if (hit != null) {
    next.prompt_tokens_details = {
      ...(asJsonObject(usage.prompt_tokens_details) ?? {}),
      cached_tokens: hit,
    }
  }
  return { ...chunk, usage: next as unknown as ChatCompletionsStreamEvent['usage'] }
}

export const withVendorDeepSeekChatCompletionsNormalize: ChatCompletionsInterceptor = async (
  inv,
  _ctx,
  run,
) => {
  if (!inv.enabledFlags.has('vendor-deepseek')) return await run()

  inv.payload = rewriteOutboundPayload(inv.payload as JsonObject) as typeof inv.payload

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
        const event = rewriteInboundUsage(rewriteInboundDeltas(frame.event))
        yield event === frame.event ? frame : eventFrame(event)
      }
    })(),
  }
}
