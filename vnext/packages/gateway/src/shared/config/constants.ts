import type { AccountType } from "@vibe-llm/protocols/common"
export type { AccountType }

// Admin emails - these users get admin access when logging in via Google OAuth
export const ADMIN_EMAILS: readonly string[] = ["zhangxian1124@gmail.com", "test@local.dev"] as const

// GitHub OAuth
export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_API_BASE_URL = "https://api.github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")

// Copilot API — single source of truth lives in @vibe-llm/provider-copilot so
// the data plane and the control plane can never drift into claiming two
// different client versions.
export {
  COPILOT_VERSION,
  VSCODE_VERSION,
  EDITOR_VERSION,
  EDITOR_PLUGIN_VERSION,
  USER_AGENT,
  COPILOT_API_VERSION,
  GITHUB_API_VERSION,
} from "@vibe-llm/provider-copilot"
import { USER_AGENT, GITHUB_API_VERSION } from "@vibe-llm/provider-copilot"

// Resend email
export const RESEND_FROM_EMAIL = "noreply@xianliao.de5.net"

// Account types
export const getCopilotBaseUrl = (accountType: AccountType) =>
  accountType === "individual"
    ? "https://api.githubcopilot.com"
    : `https://api.${accountType}.githubcopilot.com`

/**
 * Headers for the GitHub REST management plane (api.github.com), including the
 * /copilot_internal/v2/token exchange.
 *
 * Deliberately carries no editor-* headers: the real client does not send them
 * on this plane either, and sending them here would expose that one code path
 * builds both planes from the same header set.
 */
export function createGithubHeaders(token: string): Record<string, string> {
  return {
    authorization: `token ${token}`,
    accept: "application/json",
    "user-agent": USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
    "x-vscode-user-agent-library-version": "electron-fetch",
  }
}
