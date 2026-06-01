import type { AccountType } from "~/config/constants"
import type { D1Database } from "~/repo/d1"

export interface AppState {
  githubToken: string
  copilotToken: string
  copilotTokenExpires: number
  accountType: AccountType
  tokenMiss: boolean
  /** Provider-prefixed upstream id, e.g. "copilot:<user_id>". Used for usage/perf attribution. */
  upstream?: string | null
  /** Effective per-upstream flag set (provider defaults + per-account overrides). */
  enabledFlags?: ReadonlySet<string>

  // Search engine API keys
  langsearchKey?: string
  tavilyKey?: string
  msGroundingKey?: string
}

export interface Env {
  KV: KVNamespace
  DB?: D1Database
  GITHUB_TOKEN?: string
  ACCOUNT_TYPE?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  LANGSEARCH_API_KEY?: string
  TAVILY_API_KEY?: string
  MS_GROUNDING_API_KEY?: string
  RESEND_API_KEY?: string
}
