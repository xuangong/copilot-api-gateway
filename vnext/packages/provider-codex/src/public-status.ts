/**
 * The dashboard-safe view of a Codex upstream's stored credential: health,
 * renewability and expiry, never the tokens themselves.
 */
import { configRecord } from "@vibe-llm/provider-llm"

export interface PublicCodexCredentialStatus {
  health: "active" | "access_rejected" | "session_terminated" | "refresh_failed" | "credential_expired"
  renewable: boolean
  expiresAt: number | null
  expiryKnown: boolean
  quotaObservedAt: number | null
}

export function publicCodexCredentialStatus(value: unknown): PublicCodexCredentialStatus | undefined {
  const accounts = configRecord(value).accounts
  if (!Array.isArray(accounts) || accounts.length !== 1) return undefined
  const account = configRecord(accounts[0])
  const accessToken = configRecord(account.accessToken)
  const rawExpiry = accessToken.expiresAt
  const expiresAt = typeof rawExpiry === "number" && Number.isFinite(rawExpiry) ? rawExpiry : null
  const renewable = typeof account.refresh_token === "string" && account.refresh_token.length > 0
  const state = account.state
  const health = state === "access_rejected" || state === "session_terminated" || state === "refresh_failed"
    ? state
    : !renewable && (typeof accessToken.token !== "string" || (expiresAt !== null && expiresAt <= Date.now()))
      ? "credential_expired" : "active"
  const quota = configRecord(account.quotaSnapshot)
  const observations = Object.values(quota).map(entry => configRecord(entry).fetchedAt)
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time))
  return {
    health, renewable, expiresAt, expiryKnown: expiresAt !== null,
    quotaObservedAt: observations.length ? Math.max(...observations) : null,
  }
}

