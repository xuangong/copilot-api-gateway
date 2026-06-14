/**
 * Public surface for @vnext/provider-azure.
 *
 * Gateway code should depend only on what this barrel exposes; the provider
 * class is the only public symbol — internal helpers (OPENAI_PATHS,
 * ANTHROPIC_PATHS, resolveDeployment, buildUrl, headers, send,
 * parseFormDataPayload) are package-private.
 */

export { AzureProvider } from './provider'
export type { AzureProviderConfig } from './provider'
export { azureProviderPlugin } from './plugin'
