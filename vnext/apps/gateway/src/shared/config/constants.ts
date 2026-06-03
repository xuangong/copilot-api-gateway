// Admin emails - these users get admin access when logging in via Google OAuth
export const ADMIN_EMAILS = ["zhangxian1124@gmail.com", "test@local.dev"]

// GitHub OAuth
export const GITHUB_BASE_URL = "https://github.com"
export const GITHUB_API_BASE_URL = "https://api.github.com"
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_APP_SCOPES = ["read:user"].join(" ")

// Copilot API
export const COPILOT_VERSION = "0.26.7"
export const EDITOR_PLUGIN_VERSION = `copilot-chat/${COPILOT_VERSION}`
export const USER_AGENT = `GitHubCopilotChat/${COPILOT_VERSION}`
export const API_VERSION = "2025-04-01"

// Resend email
export const RESEND_FROM_EMAIL = "noreply@xianliao.de5.net"

// Account types
export type AccountType = "individual" | "business" | "enterprise"

export const getCopilotBaseUrl = (accountType: AccountType) =>
  accountType === "individual"
    ? "https://api.githubcopilot.com"
    : `https://api.${accountType}.githubcopilot.com`

export function createGithubHeaders(token: string): Record<string, string> {
  return {
    authorization: `token ${token}`,
    accept: "application/json",
    "user-agent": USER_AGENT,
  }
}
