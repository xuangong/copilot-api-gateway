/**
 * Endpoint and model-kind taxonomy shared by all protocols.
 * Sourced verbatim from old src/protocols/common/index.ts; keep both in sync
 * until the old code is retired (shared D1 means schema drift is dangerous).
 */

export type UpstreamKind = 'copilot' | 'custom' | 'azure'

export type EndpointKey =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'messages_count_tokens'
  | 'embeddings'
  | 'images_generations'
  | 'images_edits'

export const ALL_ENDPOINT_KEYS = [
  'chat_completions',
  'responses',
  'messages',
  'messages_count_tokens',
  'embeddings',
  'images_generations',
  'images_edits',
] as const satisfies readonly EndpointKey[]

export type ModelKind = 'chat' | 'embedding' | 'image'

export const ALL_MODEL_KINDS = ['chat', 'embedding', 'image'] as const satisfies readonly ModelKind[]

export const ENDPOINTS_BY_MODEL_KIND: Record<ModelKind, readonly EndpointKey[]> = {
  chat: ['chat_completions', 'responses', 'messages', 'messages_count_tokens'],
  embedding: ['embeddings'],
  image: ['images_generations', 'images_edits'],
}

export function endpointCompatibleWithKind(endpoint: EndpointKey, kind: ModelKind): boolean {
  return ENDPOINTS_BY_MODEL_KIND[kind].includes(endpoint)
}

export interface ModelPricing {
  input: number
  output: number
  cache_read?: number
  cache_write?: number
}

/** Client-visible protocol families. */
export type ClientProtocol = 'messages' | 'chat' | 'responses' | 'gemini'
