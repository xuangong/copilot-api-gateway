import { toCitations, type StreamChunk, type StreamUsage } from "./openai"

export type { StreamChunk, StreamUsage }

/**
 * Hosted web search on the Messages protocol is two content blocks: a
 * `server_tool_use` block whose `input` streams in as `input_json_delta`
 * fragments (that is where the query lives, so it is only complete at
 * `content_block_stop`), followed by a `web_search_tool_result` block carrying
 * the results. Both are ordinary content blocks — there is no bespoke
 * search event to listen for.
 *
 * The turn then ends with `stop_reason: 'pause_turn'` and *no answer text*:
 * Anthropic hands control back so the client can decide whether to continue.
 * `pause_turn` carries the assembled assistant blocks so the caller can replay
 * them and get the actual answer.
 */
export type AnthropicChunk = StreamChunk | { type: "pause_turn"; content: unknown[] }

/** A content block being reassembled from its start event plus deltas. */
interface BlockDraft {
  block: Record<string, unknown>
  /** Raw `input_json_delta` fragments, only parseable once the block closes. */
  json: string
}

export async function* parseAnthropicStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AnthropicChunk, void, void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  let currentEvent = ""
  let inputTokens = 0
  let outputTokens = 0
  let stopReason: string | undefined
  const drafts = new Map<number, BlockDraft>()
  const blocks: unknown[] = []
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, nl).replace(/\r$/, "")
        buf = buf.slice(nl + 1)
        if (raw === "") {
          currentEvent = ""
          continue
        }
        if (raw.startsWith("event:")) {
          currentEvent = raw.slice(6).trim()
          continue
        }
        if (!raw.startsWith("data:")) continue
        const payload = raw.slice(5).trim()
        if (!payload) continue
        let json: unknown
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const obj = json as {
          type?: string
          index?: number
          delta?: {
            type?: string
            text?: string
            partial_json?: string
            thinking?: string
            signature?: string
            stop_reason?: string
          }
          content_block?: {
            type?: string
            id?: string
            name?: string
            tool_use_id?: string
            content?: Array<{ url?: string; title?: string }>
          }
          error?: { message?: string }
          message?: { usage?: { input_tokens?: number; output_tokens?: number } }
          usage?: { input_tokens?: number; output_tokens?: number }
        }
        const event = currentEvent || obj.type
        if (event === "error") {
          throw new Error(obj.error?.message ?? "Anthropic stream error")
        }

        if (event === "content_block_start" && obj.index != null && obj.content_block) {
          const block = { ...obj.content_block } as Record<string, unknown>
          drafts.set(obj.index, { block, json: "" })
          if (block.type === "server_tool_use" && block.name === "web_search") {
            yield {
              type: "web_search",
              progress: { status: "in_progress", ...(obj.content_block.id ? { item_id: obj.content_block.id } : {}) },
            }
          } else if (block.type === "web_search_tool_result") {
            // `tool_use_id` points back at the `server_tool_use` block that
            // opened this search; without it the caller cannot tell which
            // in-flight search just finished.
            yield {
              type: "web_search",
              progress: {
                status: "completed",
                ...(obj.content_block.tool_use_id ? { item_id: obj.content_block.tool_use_id } : {}),
              },
            }
            const citations = toCitations(obj.content_block.content ?? [])
            if (citations.length) yield { type: "citations", citations }
          }
          continue
        }

        if (event === "content_block_delta" && obj.index != null && obj.delta) {
          const draft = drafts.get(obj.index)
          const d = obj.delta
          if (d.type === "text_delta" && typeof d.text === "string") {
            if (draft) draft.block.text = String(draft.block.text ?? "") + d.text
            yield { type: "delta", text: d.text }
          } else if (d.type === "input_json_delta") {
            if (draft) draft.json += d.partial_json ?? ""
          } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
            if (draft) draft.block.thinking = String(draft.block.thinking ?? "") + d.thinking
          } else if (d.type === "signature_delta" && typeof d.signature === "string") {
            if (draft) draft.block.signature = String(draft.block.signature ?? "") + d.signature
          }
          continue
        }

        if (event === "content_block_stop" && obj.index != null) {
          const draft = drafts.get(obj.index)
          if (draft) {
            drafts.delete(obj.index)
            if (draft.json) {
              try {
                draft.block.input = JSON.parse(draft.json)
              } catch {
                /* a truncated tool call is not replayable; leave input as-is */
              }
            }
            blocks.push(draft.block)
            if (draft.block.type === "server_tool_use" && draft.block.name === "web_search") {
              // The query is only readable once every input_json_delta landed.
              const query = (draft.block.input as { query?: unknown } | undefined)?.query
              yield {
                type: "web_search",
                progress: {
                  status: "searching",
                  ...(typeof query === "string" && query ? { query } : {}),
                  ...(typeof draft.block.id === "string" ? { item_id: draft.block.id } : {}),
                },
              }
            }
          }
          continue
        }

        // message_start carries initial input_tokens; message_delta carries final output_tokens
        const startUsage = obj.message?.usage
        if (startUsage?.input_tokens != null) inputTokens = startUsage.input_tokens
        if (startUsage?.output_tokens != null) outputTokens = startUsage.output_tokens
        if (obj.usage?.input_tokens != null) inputTokens = obj.usage.input_tokens
        if (obj.usage?.output_tokens != null) outputTokens = obj.usage.output_tokens
        if (obj.delta?.stop_reason) stopReason = obj.delta.stop_reason

        if (event === "message_stop") {
          if (inputTokens || outputTokens) {
            yield { type: "usage", usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
          }
          if (stopReason === "pause_turn") yield { type: "pause_turn", content: replayable(blocks) }
          return
        }
      }
    }
    if (inputTokens || outputTokens) {
      yield { type: "usage", usage: { input_tokens: inputTokens, output_tokens: outputTokens } }
    }
    if (stopReason === "pause_turn") yield { type: "pause_turn", content: replayable(blocks) }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Blocks safe to send back as an assistant turn. A `thinking` block that never
 * received a delta is empty and unsigned, which the upstream rejects; the same
 * goes for an empty `text` block.
 */
function replayable(blocks: unknown[]): unknown[] {
  return blocks.filter((b) => {
    const block = b as { type?: string; text?: string; thinking?: string }
    if (block.type === "thinking") return Boolean(block.thinking)
    if (block.type === "text") return Boolean(block.text)
    return true
  })
}
