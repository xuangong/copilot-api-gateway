/**
 * Per-model structured endpoint capability map. Key presence = supported;
 * value reserved for future sub-capability flags.
 *
 * Replaces the old per-upstream `EndpointKey[]` + model-id heuristic. See
 * docs/superpowers/specs/2026-06-11-plan2-model-endpoints-design.md.
 */
import type { ModelKind } from './index'

export interface ModelEndpoints {
  chat_completions?: Record<string, never>
  responses?: Record<string, never>
  messages?: Record<string, never>
  messages_count_tokens?: Record<string, never>
  embeddings?: Record<string, never>
  images_generations?: Record<string, never>
  images_edits?: Record<string, never>
}

/**
 * Derive ModelKind from a ModelEndpoints map.
 *   only `embeddings` → 'embedding'
 *   only `images_*`   → 'image'
 *   anything else (incl. mixed, empty) → 'chat'
 */
export function kindForEndpoints(e: ModelEndpoints): ModelKind {
  const keys = Object.keys(e) as Array<keyof ModelEndpoints>
  if (keys.length === 1 && keys[0] === 'embeddings') return 'embedding'
  if (keys.length > 0 && keys.every((k) => k === 'images_generations' || k === 'images_edits')) {
    return 'image'
  }
  return 'chat'
}
