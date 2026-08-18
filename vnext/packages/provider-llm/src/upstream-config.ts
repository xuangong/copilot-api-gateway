/**
 * Shared validation helpers for upstream provider configs.
 *
 * These live here rather than in the gateway's control plane because both
 * the control plane (azure) and @vibe-llm/provider-custom (custom) need
 * them, and a second copy would drift.
 */

import type { EndpointKey } from '@vibe-llm/protocols/common'

/**
 * NOTE: `alpha_search` is deliberately absent — this set is moved verbatim
 * from the control plane, which never accepted it. Adding it is a behaviour
 * change and belongs in its own task.
 */
export const ENDPOINT_KEYS = new Set<EndpointKey>([
  'chat_completions',
  'responses',
  'messages',
  'messages_count_tokens',
  'embeddings',
  'images_generations',
  'images_edits',
] as const satisfies readonly EndpointKey[])

export function parseEndpoints(value: unknown, fallback: readonly EndpointKey[]): EndpointKey[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) throw new Error('endpoints must be an array')
  const endpoints = value.map((v) => {
    if (typeof v !== 'string' || !ENDPOINT_KEYS.has(v as EndpointKey)) {
      throw new Error(`unknown endpoint: ${String(v)}`)
    }
    return v as EndpointKey
  })
  return [...new Set(endpoints)]
}

export function normalizeStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new Error(`${field}.${k} must be a string`)
    out[k] = v
  }
  return out
}
