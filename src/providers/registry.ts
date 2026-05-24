import type { AccountType } from "~/config/constants"

import { CopilotProvider } from "./copilot/provider"
import type { ModelProvider, UpstreamKind } from "./types"

export type { ModelProvider, ProviderCallOptions, UpstreamKind } from "./types"
export { CopilotProvider } from "./copilot/provider"

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

/**
 * Future hook for selecting a provider by upstream kind. For now copilot is
 * the only registered kind; passing anything else throws so callers fail loudly
 * when a new kind is added without a corresponding factory.
 */
export function getProvider(kind: UpstreamKind, opts: CreateProviderOptions): ModelProvider {
  if (kind === "copilot") return createCopilotProvider(opts)
  throw new Error(`Provider kind not yet supported: ${kind}`)
}
