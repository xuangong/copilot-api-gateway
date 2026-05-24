import type { AccountType } from "~/config/constants"

import { AzureProvider, type AzureProviderConfig } from "./azure/provider"
import { CopilotProvider } from "./copilot/provider"
import { CustomProvider, type CustomProviderConfig } from "./custom/provider"
import type { ModelProvider, UpstreamKind } from "./types"

export type { ModelProvider, ProviderCallOptions, UpstreamKind } from "./types"
export { CopilotProvider } from "./copilot/provider"
export { CustomProvider, type CustomProviderConfig } from "./custom/provider"
export { AzureProvider, type AzureProviderConfig } from "./azure/provider"

export interface CreateProviderOptions {
  copilotToken: string
  accountType: AccountType
}

/**
 * Build the provider for the current request. Today only Copilot exists; this
 * is the single seam future Azure/custom upstreams will plug into.
 */
export function createCopilotProvider(opts: CreateProviderOptions): ModelProvider {
  return new CopilotProvider({
    copilotToken: opts.copilotToken,
    accountType: opts.accountType,
  })
}

export function createCustomProvider(cfg: CustomProviderConfig): ModelProvider {
  return new CustomProvider(cfg)
}

export function createAzureProvider(cfg: AzureProviderConfig): ModelProvider {
  return new AzureProvider(cfg)
}

/**
 * Dispatch table for provider kinds. Copilot uses CreateProviderOptions;
 * custom requires its own config and must be created via createCustomProvider
 * directly (the registry-by-kind path remains copilot-only for now).
 */
export function getProvider(kind: UpstreamKind, opts: CreateProviderOptions): ModelProvider {
  if (kind === "copilot") return createCopilotProvider(opts)
  throw new Error(`Provider kind not constructible from CreateProviderOptions: ${kind}`)
}
