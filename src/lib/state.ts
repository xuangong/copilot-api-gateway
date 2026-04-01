import type { AccountType } from "~/config/constants"
import type { D1Database } from "~/repo/d1"

export interface AppState {
  githubToken: string
  copilotToken: string
  copilotTokenExpires: number
  accountType: AccountType
  tokenMiss: boolean

  // Search engine API keys
  langsearchKey?: string
  tavilyKey?: string
}

export interface Env {
  KV: KVNamespace
  DB?: D1Database
  GITHUB_TOKEN?: string
  ACCOUNT_TYPE?: string
  ADMIN_KEY?: string
  LANGSEARCH_API_KEY?: string
  TAVILY_API_KEY?: string
}
