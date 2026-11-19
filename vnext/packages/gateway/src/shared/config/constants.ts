import type { AccountType } from "@vibe-llm/protocols/common"
export type { AccountType }

// Admin emails - these users get admin access when logging in via Google OAuth
export const ADMIN_EMAILS: readonly string[] = ["zhangxian1124@gmail.com", "test@local.dev"] as const

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

// Resend email
export const RESEND_FROM_EMAIL = "noreply@xianliao.de5.net"
