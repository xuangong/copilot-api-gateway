/**
 * Copilot account-type + base-URL helpers.
 *
 * Verbatim copy of the subset of apps/gateway/src/shared/config/constants.ts
 * that the Copilot data-plane (provider, forward, headers) depends on. The
 * gateway-side original stays in place because the control-plane reuses the
 * same symbols; duplicating ~15 LOC here keeps the package self-contained
 * without dragging in unrelated admin/email config.
 */

// Copilot API
export const COPILOT_VERSION = "0.26.7"
export const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
export const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
export const API_VERSION = "2025-04-01"

// Account types
export type AccountType = "individual" | "business" | "enterprise"

export const getCopilotBaseUrl = (accountType: AccountType) =>
  accountType === "individual"
    ? "https://api.githubcopilot.com"
    : `https://api.${accountType}.githubcopilot.com`
