/**
 * Compact a Responses-API `input[]` array before translating it into a
 * Chat-Completions request. Codex / cline drive the gateway with very long
 * histories (lots of function_call_output blobs from patch/read tools) — the
 * Copilot backend's body cap on /v1/chat/completions trips a 413 well before
 * the model's context limit.
 *
 * We only run on the chat-fallback path; the native /v1/responses passthrough
 * has a more generous backend limit and we leave it untouched.
 *
 * Strategy (loss-aware, preserves correctness):
 *   - Drop oversized `function_call_output` bodies when the total byte budget
 *     would be exceeded, oldest first. Replaced with a short placeholder so
 *     the matching tool_call_id still pairs (the model sees "<truncated …>").
 *   - Never touch the LAST function_call_output: it's the active turn the
 *     model is about to consume.
 *   - Never touch `message` items: those carry the user's prompts and the
 *     assistant's textual replies; truncating them changes meaning.
 *
 * Budget is a UTF-8 byte estimate on serialized JSON. Off by default; the
 * caller passes in a byteBudget threshold.
 */

import type {
  ResponseInputItem,
  ResponseFunctionCallOutputItem,
} from "./types"

const PLACEHOLDER = "<truncated by gateway: response body too large>"

function approxByteSize(item: ResponseInputItem): number {
  // JSON.stringify is the upstream wire format, so its byte length is the
  // honest cost here. Cheap enough at codex history sizes (<= a few MB).
  return new TextEncoder().encode(JSON.stringify(item)).length
}

export interface CompactStats {
  truncated: number
  bytesDropped: number
  totalItems: number
}

export function compactResponsesInputForChatFallback(
  input: ResponseInputItem[],
  byteBudget: number,
): { items: ResponseInputItem[]; stats: CompactStats } {
  const stats: CompactStats = {
    truncated: 0,
    bytesDropped: 0,
    totalItems: input.length,
  }

  // Find indices of function_call_output items, oldest first.
  const fcoIndices: number[] = []
  for (let i = 0; i < input.length; i++) {
    if (input[i]?.type === "function_call_output") fcoIndices.push(i)
  }
  // Preserve the last function_call_output — current turn the model is reading.
  if (fcoIndices.length > 0) fcoIndices.pop()

  const sizes = input.map(approxByteSize)
  let total = sizes.reduce((a, b) => a + b, 0)
  if (total <= byteBudget) return { items: input, stats }

  const out = [...input]
  for (const idx of fcoIndices) {
    if (total <= byteBudget) break
    const orig = out[idx] as ResponseFunctionCallOutputItem
    const truncated: ResponseFunctionCallOutputItem = {
      type: "function_call_output",
      call_id: orig.call_id,
      output: PLACEHOLDER,
    }
    const newSize = approxByteSize(truncated)
    const dropped = sizes[idx]! - newSize
    total -= dropped
    stats.bytesDropped += dropped
    stats.truncated += 1
    out[idx] = truncated
  }

  return { items: out, stats }
}
