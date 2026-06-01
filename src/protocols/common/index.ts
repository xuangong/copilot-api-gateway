/**
 * Protocol-common types shared across all upstream/source pairs.
 *
 * Only the generic SSE envelope lives here. Each concrete protocol
 * keeps its own request/response/event types under `src/protocols/<protocol>`.
 */

export type { SSEFrame, FrameBuffer } from "~/lib/sse/parser"

export type UpstreamKind = "copilot" | "custom" | "azure"

/**
 * Set of API surfaces an upstream can serve. Each key maps to a concrete
 * provider-specific path inside the provider implementation.
 *
 * Adding a new endpoint:
 *   1. Add the literal to this union AND to ALL_ENDPOINT_KEYS below.
 *   2. Add the path mapping inside each provider's fetch() dispatch.
 *   3. Add the key to that provider's supportedEndpoints if it serves it.
 */
export type EndpointKey =
  | "chat_completions"
  | "responses"
  | "messages"
  | "messages_count_tokens"
  | "embeddings"
  | "images_generations"
  | "images_edits"

/** Runtime list of all valid EndpointKey values. Useful for iteration/validation. */
export const ALL_ENDPOINT_KEYS = [
  "chat_completions",
  "responses",
  "messages",
  "messages_count_tokens",
  "embeddings",
  "images_generations",
  "images_edits",
] as const satisfies readonly EndpointKey[]

/** Single per-model pricing record (USD per million tokens). */
export interface ModelPricing {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}
