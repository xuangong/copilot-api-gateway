// Codex quota snapshot types. Full parser/persister lives in F3 slice.

export interface CodexQuotaSnapshot {
  observed_at: string
  active_limit?: string
  plan_type?: string

  primary_used_percent?: number
  primary_window_minutes?: number
  primary_reset_after_at?: string

  secondary_used_percent?: number
  secondary_window_minutes?: number
  secondary_reset_after_at?: string

  credits_has_credits?: boolean
  credits_balance?: number

  // Present only when this snapshot was written as a result of a 429.
  ratelimited_until?: string
}

export type CodexQuotaSnapshotMap = Record<string, CodexQuotaSnapshot>

export const CODEX_QUOTA_UNKNOWN_ACTIVE_LIMIT = 'unknown'
