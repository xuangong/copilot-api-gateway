/**
 * Public surface for @vibe-llm/provider-custom.
 *
 * Gateway code should depend only on what this barrel exposes; the provider
 * class is the only public symbol — internal helpers (CUSTOM_PATHS,
 * authHeaders, send) are package-private.
 */

export { CustomProvider } from './provider'
export type { CustomProviderConfig } from './provider'
export { customProviderPlugin } from './plugin'
