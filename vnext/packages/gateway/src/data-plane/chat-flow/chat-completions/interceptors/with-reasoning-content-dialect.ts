/**
 * `reasoning_content` wire-dialect translator for Chat Completions.
 *
 * DeepSeek, Kimi (Moonshot) and Qwen all carry assistant reasoning in a
 * flat `reasoning_content` string rather than the gateway's canonical
 * `reasoning_text` / `reasoning_items`. Translating both directions is
 * what makes preserved thinking round-trip: upstream emits
 * `reasoning_content` → the client sees `reasoning_text` → the client
 * echoes `reasoning_text` back in history → this interceptor restores
 * `reasoning_content` on the way out.
 *
 * Outbound:
 * - assistant `reasoning_text` / `reasoning_items.summary` → `reasoning_content`
 *   (drop `reasoning_opaque` — these upstreams don't accept it)
 *
 * Inbound stream:
 * - delta `reasoning_content` → `reasoning_text`
 *
 * `vendor-deepseek` implies this flag. The translation used to live inside
 * the DeepSeek normalizer, so upstreams provisioned before the split carry
 * only `vendor-deepseek` in their overrides and would silently lose
 * reasoning if the new flag alone gated it.
 */
import type { ChatCompletionsInterceptor } from './types'
import { asJsonObject, type JsonObject } from '../../shared/json-helpers'
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

const rewriteOutboundPayload = (payload: JsonObject): JsonObject => {
  const messages = payload.messages
  if (!Array.isArray(messages)) return payload
  return {
    ...payload,
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

export const withReasoningContentDialect: ChatCompletionsInterceptor = async (inv, _ctx, run) => {
  const enabled =
    inv.enabledFlags.has('reasoning-content-dialect') || inv.enabledFlags.has('vendor-deepseek')
  if (!enabled) return await run()

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
        const event = rewriteInboundDeltas(frame.event)
        yield event === frame.event ? frame : eventFrame(event)
      }
    })(),
  }
}
