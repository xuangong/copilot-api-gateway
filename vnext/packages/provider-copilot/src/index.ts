/**
 * Public surface for @vnext/provider-copilot.
 *
 * Gateway code should depend only on what this barrel exposes; internal
 * modules (transforms/*, interceptors/*, lib/*, raw-models-cache, variants,
 * etc.) are package-private. The `./models` and `./forward` subpath exports
 * declared in package.json exist for tests and ad-hoc gateway code that
 * needs the raw service entry points without dragging the provider class.
 */

export { CopilotProvider } from "./provider"
export type { CopilotProviderConfig } from "./provider"

export { callCopilotAPI, repairToolResultPairs } from "./forward"

export { getModels, getRawModels } from "./models"
export type {
  Model,
  ModelsResponse,
  ModelLimits,
  ModelSupports,
  ModelCapabilities,
} from "./models"

export { parseCompositeModelId } from "./variants"
export { clearRawModelsCache } from "./raw-models-cache"

export type { AccountType } from "./account-type"
