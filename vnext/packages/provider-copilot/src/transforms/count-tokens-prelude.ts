/**
 * /v1/messages/count_tokens prelude. Mirrors the live ordering from
 * gateway/transforms/pipeline.ts:78-85 — the minimum count_tokens needs:
 * strip Anthropic-beta context_management, port top-level cache_control onto
 * the last cacheable block, strip cache_control sub-extensions, repair
 * orphan tool_result pairs.
 */
import { stripContextManagement } from "./context-management"
import { applyTopLevelCacheControl } from "./apply-top-level-cache-control"
import { stripCacheControl } from "./cache-control"
import { repairToolResultPairs } from "../forward"

export function runCountTokensPrelude(payload: Record<string, unknown>): void {
  stripContextManagement(payload)
  applyTopLevelCacheControl(payload)
  stripCacheControl(payload)
  const messages = payload.messages
  if (Array.isArray(messages)) {
    payload.messages = repairToolResultPairs(messages as never) as unknown as typeof payload.messages
  }
}
