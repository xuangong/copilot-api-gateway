import type { UpstreamAdapter } from './types'

/**
 * UpstreamPlugin — per-package factory contract.
 *
 * Three generics:
 *   - TConfig: the stored row / config shape the gateway hands in
 *   - TCtx:    runtime hooks (token cache, fallbacks, ...) supplied by the host
 *   - TAdapter: the concrete adapter subtype returned. Defaults to the bare
 *              UpstreamAdapter so framework-only callers don't need to spell it.
 *              Business overlays bind TAdapter to their narrowed adapter (e.g.
 *              LlmModelProvider) so consumers see the richer return type at the
 *              registry call site.
 */
export interface UpstreamPlugin<
  TConfig,
  TCtx,
  TAdapter extends UpstreamAdapter = UpstreamAdapter,
> {
  /** Plain string at framework level. Business overlays narrow via aliasing. */
  readonly kind: string
  createFromUpstream(config: TConfig, ctx: TCtx): Promise<TAdapter | null>
}
