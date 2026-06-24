import type { UpstreamAdapter } from './types'

/**
 * UpstreamBinding — minimal framework view of a resolved (upstream row, adapter)
 * pair. The field is named `provider` (not `adapter`) so that existing call
 * sites — `binding.provider.fetch(...)` in
 * gateway/src/data-plane/providers/registry.ts:241+ — survive Spec 9 without
 * any runtime rename. Business overlays add LLM-specific fields (kind, model)
 * via interface extension.
 */
export interface UpstreamBinding<TAdapter extends UpstreamAdapter> {
  upstream: string
  provider: TAdapter
  enabledFlags: ReadonlySet<string>
}
