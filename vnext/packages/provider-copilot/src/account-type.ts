/**
 * Copilot account-type + base-URL helpers.
 *
 * Verbatim copy of the subset of apps/gateway/src/shared/config/constants.ts
 * that the Copilot data-plane (provider, forward, headers) depends on. The
 * gateway-side original stays in place because the control-plane reuses the
 * same symbols; duplicating ~15 LOC here keeps the package self-contained
 * without dragging in unrelated admin/email config.
 */

import type { AccountType } from "@vibe-llm/protocols/common"
export type { AccountType }

// Copilot API
//
// The five values below were captured together from one real GitHub Copilot
// Chat client. They must move as one set. Bumping any single one on its own
// assembles a client that has never existed — an editor plugin claiming
// 0.52.0 while speaking a 2025 API version is a sharper signal than a client
// that is uniformly a few releases behind.
//
// Source: copilot-gateway/packages/provider-copilot/src/auth.ts
export const COPILOT_VERSION = "0.52.0"
export const VSCODE_VERSION = "1.124.2"
export const EDITOR_VERSION = `vscode/${VSCODE_VERSION}`
export const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
export const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`

/** Copilot data plane (api.githubcopilot.com). */
export const COPILOT_API_VERSION = "2026-06-01"
/**
 * GitHub REST management plane (api.github.com). Not the same calendar as
 * COPILOT_API_VERSION — do not collapse the two back into one constant.
 */
export const GITHUB_API_VERSION = "2025-04-01"

// Account types
export const getCopilotBaseUrl = (accountType: AccountType) =>
  accountType === "individual"
    ? "https://api.githubcopilot.com"
    : `https://api.${accountType}.githubcopilot.com`
