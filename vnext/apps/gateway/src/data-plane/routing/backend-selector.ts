/**
 * Heuristic mapping from model id to upstream endpoint. Plan 1 (Task #29) —
 * replaced in Plan 2 (Task #27) by a `ModelEndpoints` data-model lookup.
 *
 * Rules (case-insensitive on the bare model id, no upstream pin prefix):
 *   gpt-5* | o1* | o3* | o4*  → 'responses'
 *   claude-*                  → 'messages'
 *   everything else           → 'chat_completions'
 */
import type { EndpointKey } from '@vnext/protocols/common'

export function chooseBackendEndpoint(model: string): EndpointKey {
  const m = model.toLowerCase()
  if (m.startsWith('gpt-5') || /^o[134](-|$)/.test(m)) return 'responses'
  if (m.startsWith('claude-')) return 'messages'
  return 'chat_completions'
}
