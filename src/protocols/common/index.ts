/**
 * Protocol-common types shared across all upstream/source pairs.
 *
 * Only the generic SSE envelope lives here. Each concrete protocol
 * keeps its own request/response/event types under `src/protocols/<protocol>`.
 */

export type { SSEFrame, FrameBuffer } from "~/lib/sse/parser"

export type UpstreamKind = "copilot" | "custom" | "azure"

export type ModelEndpoint =
  | "chat_completions"
  | "responses"
  | "messages"
  | "messages_count_tokens"
  | "embeddings"

/** Single per-model pricing record (USD per million tokens). */
export interface ModelPricing {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}
