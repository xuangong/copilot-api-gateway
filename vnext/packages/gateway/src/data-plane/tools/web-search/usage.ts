// Ported from copilot-gateway data-plane/tools/web-search/usage.ts.
//
// Adapted to vNext: reference project has a single `searchUsage` repo with a
// {provider, keyId, action, hour, requests} record shape. vNext already
// carries two web-search usage tables (`webSearchUsage` for search-level
// success/failure totals, `webSearchEngineUsage` for per-engine attempt
// telemetry). Rather than add a third table, we bridge here: `search` action
// hits both (search-level + engine-level with success=true); `fetch_page`
// hits engine-level only. This keeps the porting surface small and reuses
// the dashboards already wired against those tables.

import type { WebSearchProviderName } from './types.ts'
import { getRepo } from '../../../repo/index.ts'
import type { ApiKeyId } from '../../../repo/branded-ids.ts'

export type SearchUsageAction = 'search' | 'fetch_page'

const currentHour = (): string => new Date().toISOString().slice(0, 13)

/**
 * Records a single usage row. Hour is computed at write time; `requests`
 * defaults to 1. Records into vNext's existing webSearchUsage +
 * webSearchEngineUsage tables (see file header). Throws if the repo write
 * fails — callers wrap this in try/catch to swallow telemetry failures
 * without masking the underlying provider result.
 */
export const recordSearchUsage = async (args: {
  provider: WebSearchProviderName
  keyId: ApiKeyId
  action: SearchUsageAction
  requests?: number
}): Promise<void> => {
  const hour = currentHour()
  const repo = getRepo()

  if (args.action === 'search') {
    await repo.webSearchUsage.record(args.keyId, hour, true)
  }
  await repo.webSearchEngineUsage.record(args.keyId, args.provider, hour, {
    ok: true,
    resultCount: 0,
    durationMs: 0,
  })
}
