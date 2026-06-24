/**
 * Round-trip Anthropic Messages thinking blocks ↔ OpenAI Responses reasoning
 * items. The Responses item carries two pieces of state we need to preserve:
 *
 *   - `id` — opaque token (`rs_xxx`) used by the upstream to correlate later
 *     turns; required when echoing a reasoning item back into a follow-up
 *     request.
 *   - `encrypted_content` — opaque blob containing the model's signed
 *     reasoning; required by Anthropic's Messages thinking block as
 *     `signature` to satisfy chain-of-thought integrity.
 *
 * To survive the asymmetric vocabularies, we pack both into Anthropic's single
 * `signature` (or `redacted_thinking.data`) field as `${encrypted}@${id}`. The
 * inverse splits at the **last** `@` so an encrypted blob containing `@`
 * stays intact (the id is a plain token without `@`).
 *
 * Empty summary → emit `redacted_thinking` (the model thought but produced no
 * visible summary). Non-empty summary → emit `thinking` with the joined text.
 */

import type { MessagesThinkingBlock, MessagesRedactedThinkingBlock } from '@vnext-llm/protocols/messages'

export function packReasoningSignature(id: string | undefined, encrypted: string | undefined): string {
  const e = encrypted ?? ''
  const i = id ?? ''
  if (!e && !i) return ''
  if (!i) return e
  if (!e) return `@${i}`
  return `${e}@${i}`
}

export function unpackReasoningSignature(signature: string): { id: string | undefined; encrypted: string | undefined } {
  if (!signature) return { id: undefined, encrypted: undefined }
  const at = signature.lastIndexOf('@')
  if (at === -1) {
    return { id: undefined, encrypted: signature }
  }
  const encrypted = signature.slice(0, at)
  const id = signature.slice(at + 1)
  return {
    id: id ? id : undefined,
    encrypted: encrypted ? encrypted : undefined,
  }
}

interface ResponsesReasoningItem {
  id?: string
  summary?: Array<{ type?: string; text?: string }>
  encrypted_content?: string
}

export function responsesReasoningToMessagesBlock(
  reasoning: ResponsesReasoningItem,
): MessagesThinkingBlock | MessagesRedactedThinkingBlock {
  const summaryParts = (reasoning.summary ?? [])
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .filter((s) => s.length > 0)
  const summaryText = summaryParts.join('\n')
  const packed = packReasoningSignature(reasoning.id, reasoning.encrypted_content)
  if (summaryText.length === 0) {
    return { type: 'redacted_thinking', data: packed }
  }
  const block: MessagesThinkingBlock = { type: 'thinking', thinking: summaryText }
  if (packed) block.signature = packed
  return block
}
