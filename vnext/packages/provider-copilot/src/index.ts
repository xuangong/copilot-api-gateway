/**
 * Public surface for @vibe-llm/provider-copilot.
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

export { HTTPError } from "./lib/error"

export { getModels, getRawModels } from "./models"
export type {
  Model,
  ModelsResponse,
  ModelLimits,
  ModelSupports,
  ModelCapabilities,
} from "./models"

export { parseCompositeModelId, normalizeAnthropicVersion, copilotPublicModelId } from "./variants"
export { clearRawModelsCache } from "./raw-models-cache"

export type { AccountType } from "./account-type"

export { copilotModelEndpoints } from "./endpoints"

// SSE parsers for hub-shape upstream responses. Exposed for the gateway's
// pairwise dispatch pipeline so it can decode upstream byte streams into
// typed events that pairwise translators consume.
export { parseSSEStream as parseMessagesSSEStream } from "./parse/messages-sse"
export { parseChatSSEStream } from "./parse/chat-sse"
export { parseResponsesSSEStream } from "./parse/responses-sse"

export { copilotProviderPlugin } from './plugin'
