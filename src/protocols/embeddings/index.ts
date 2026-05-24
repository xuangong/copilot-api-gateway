/**
 * OpenAI Embeddings protocol types.
 *
 * Defined inline here — no translator dependency, request shape is
 * identical across providers (Copilot, Custom, Azure OpenAI).
 */

export interface EmbeddingsPayload {
  model: string
  input: string | string[] | number[] | number[][]
  encoding_format?: "float" | "base64"
  dimensions?: number
  user?: string
}

export interface EmbeddingObject {
  object: "embedding"
  index: number
  embedding: number[] | string
}

export interface EmbeddingsResponse {
  object: "list"
  data: EmbeddingObject[]
  model: string
  usage?: {
    prompt_tokens?: number
    total_tokens?: number
  }
}
