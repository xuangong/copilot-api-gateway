/**
 * Storage shape for a configured upstream provider row.
 *
 * Lives in @vnext/protocols/common so plugin contracts (@vnext/provider's
 * ProviderPlugin) can reference it without depending on the gateway package.
 * Gateway re-exports from src/shared/repo/types.ts to preserve old import
 * paths.
 */
import type { UpstreamKind } from './index'

export interface UpstreamRecord {
  id: string
  ownerId?: string
  provider: UpstreamKind
  name: string
  enabled: boolean
  sortOrder: number
  config: Record<string, unknown>
  flagOverrides: Record<string, boolean>
  /** Public model ids hidden from /v1/models and from routing. Empty by default. */
  disabledPublicModelIds: string[]
  createdAt: string
  updatedAt: string
}
