import type { UpstreamWriteTarget } from "@vibe-core/upstream-repo"
import { CodexOAuthSessionTerminatedError, refreshCodexAccessToken } from "./auth/oauth"
import type { Fetcher } from "./fetcher"
import type { CodexAccessTokenEntry } from "./state"
import {
  codexBearerEffect, ignoreGoneCodexEffect, persistCodexTerminalState,
  readCodexCredential, updateCodexCredential,
  type CodexAccessTokenLease, type CodexCredentialSnapshot,
} from "./credential-effects"

export type { CodexAccessTokenEntry, CodexAccessTokenLease }

export interface CodexMintResult {
  accessToken: CodexAccessTokenEntry
  refreshToken: string
}

export type CodexTokenMint = (refreshToken: string) => Promise<CodexMintResult>

const REFRESH_SKEW_MS = 5 * 60 * 1000
const isAccessTokenFresh = (entry: CodexAccessTokenEntry): boolean => entry.expiresAt > Date.now() + REFRESH_SKEW_MS
const usableLease = (snapshot: CodexCredentialSnapshot): CodexAccessTokenLease | null => {
  const entry = snapshot.account.accessToken
  return snapshot.account.state === "active" && entry && entry.expiresAt > Date.now()
    ? { ...entry, credential: snapshot.credential } : null
}

export class CodexCredentialUnavailableError extends Error {
  constructor() {
    super("Codex credential has no usable current access token")
    this.name = "CodexCredentialUnavailableError"
  }
}

export const invalidateCodexAccessToken = async (lease: CodexAccessTokenLease): Promise<void> => {
  await ignoreGoneCodexEffect(updateCodexCredential(codexBearerEffect(lease), account => ({ ...account, accessToken: null })))
}

// Coalescing reduces duplicate work for the exact stored credential. CAS, not
// this process-local map, decides which cross-instance mint may commit.
const inFlightEnsures = new Map<string, Promise<CodexAccessTokenLease>>()

export const ensureCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
  mint: CodexTokenMint,
  force = false,
  expected?: UpstreamWriteTarget,
): Promise<CodexAccessTokenLease> => {
  const snapshot = await readCodexCredential(upstreamId, accountId, expected)
  const { credential, account } = snapshot
  const key = JSON.stringify([upstreamId, accountId, credential.rowIncarnation, credential.ownerId,
    credential.credentialRevision, account.refresh_token, account.accessToken?.token, force])
  const existing = inFlightEnsures.get(key)
  if (existing) return await existing
  const promise = ensureInner(snapshot, mint, force, true)
  inFlightEnsures.set(key, promise)
  try { return await promise } finally { inFlightEnsures.delete(key) }
}

const ensureInner = async (
  snapshot: CodexCredentialSnapshot,
  mint: CodexTokenMint,
  force: boolean,
  recoveryAllowed: boolean,
): Promise<CodexAccessTokenLease> => {
  const { credential, account } = snapshot
  if (account.state !== "active") throw new CodexCredentialUnavailableError()
  if (!force && account.accessToken && isAccessTokenFresh(account.accessToken)) {
    return { ...account.accessToken, credential }
  }
  const effect = { credential, tokenKind: "refresh" as const, token: account.refresh_token }
  let minted: CodexMintResult
  try {
    minted = await mint(account.refresh_token)
  } catch (error) {
    if (error instanceof CodexOAuthSessionTerminatedError) {
      const current = await readCodexCredential(credential.upstreamId, credential.accountId, credential)
      const changed = current.credential.credentialRevision !== credential.credentialRevision ||
        current.account.refresh_token !== account.refresh_token
      if (changed) {
        const winner = usableLease(current)
        if (winner) return winner
        // Preserve the existing single invalid_grant recovery with the current
        // refresh token and a newly captured effect identity.
        if (error.code === "invalid_grant" && recoveryAllowed && current.account.state === "active") {
          return await ensureInner(current, mint, false, false)
        }
      }
      await persistCodexTerminalState(effect, "refresh_failed", error.upstreamMessage)
    }
    throw error
  }
  await updateCodexCredential(effect, current => ({
    ...current, refresh_token: minted.refreshToken, accessToken: minted.accessToken,
    state_updated_at: minted.accessToken.refreshedAt,
  }))
  // A losing CAS can be a no-op when reimport/rotation won. Never return the
  // local mint in place of the authoritative row's current usable token.
  const current = await readCodexCredential(credential.upstreamId, credential.accountId, credential)
  const winner = usableLease(current)
  if (!winner) throw new CodexCredentialUnavailableError()
  return winner
}

export const refreshCodexAccessTokenForRetry = async (
  failed: CodexAccessTokenLease,
  mint: CodexTokenMint,
): Promise<CodexAccessTokenLease> => {
  const target = failed.credential
  const current = await readCodexCredential(target.upstreamId, target.accountId, target)
  const winner = usableLease(current)
  if (winner && (winner.token !== failed.token || winner.credential.credentialRevision !== target.credentialRevision)) return winner
  await invalidateCodexAccessToken(failed)
  // A sibling can rotate between the first read and invalidation CAS.
  return await ensureCodexAccessToken(target.upstreamId, target.accountId, mint, false, target)
}

export const mintCodexAccessToken = async (refreshToken: string, fetcher: Fetcher): Promise<CodexMintResult> => {
  const tokens = await refreshCodexAccessToken(refreshToken, fetcher)
  return {
    refreshToken: tokens.refresh_token,
    accessToken: { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000, refreshedAt: new Date().toISOString() },
  }
}
