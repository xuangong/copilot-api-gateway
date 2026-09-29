import type { UpstreamWriteTarget } from "@vibe-core/upstream-repo"
import { CodexOAuthSessionTerminatedError, refreshCodexAccessToken } from "./auth/oauth"
import type { Fetcher } from "./fetcher"
import type { CodexAccessTokenEntry } from "./state"
import {
  codexBearerEffect, ignoreGoneCodexEffect, persistCodexTerminalState,
  readCodexCredential, updateCodexCredential,
  type CodexAccessTokenLease, type CodexCredentialSnapshot, type CodexCredentialTarget,
} from "./credential-effects"

export type { CodexAccessTokenEntry, CodexAccessTokenLease }

export interface CodexMintResult {
  accessToken: CodexAccessTokenEntry
  refreshToken: string
}

/** Per-request fence for the exact snapshot whose refresh token will be sent.
 * Runs at every mint, including internal invalid-grant/CAS recovery. */
export type CodexBeforeMint = (credential: Readonly<CodexCredentialTarget>) => Promise<void>

export type CodexTokenMint = (refreshToken: string, signal?: AbortSignal) => Promise<CodexMintResult>

const aborted = (): DOMException => new DOMException("Codex request aborted", "AbortError")
const assertNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw aborted()
}

const waitForOwnedOperation = async <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return await pending
  assertNotAborted(signal)
  let onAbort: (() => void) | null = null
  const canceled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(aborted())
    signal.addEventListener("abort", onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try { return await Promise.race([pending, canceled]) } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

const REFRESH_SKEW_MS = 5 * 60 * 1000
const isAccessTokenFresh = (entry: CodexAccessTokenEntry): boolean =>
  entry.expiresAt !== null && entry.expiresAt > Date.now() + REFRESH_SKEW_MS
const usableLease = (snapshot: CodexCredentialSnapshot): CodexAccessTokenLease | null => {
  const entry = snapshot.account.accessToken
  return snapshot.account.state === "active" && entry &&
    ((entry.expiresAt === null && snapshot.account.refresh_token === null) || (entry.expiresAt !== null && entry.expiresAt > Date.now()))
    ? { ...entry, credential: snapshot.credential, renewable: snapshot.account.refresh_token !== null } : null
}

export class CodexCredentialUnavailableError extends Error {
  constructor() {
    super("Codex credential has no usable current access token")
    this.name = "CodexCredentialUnavailableError"
  }
}

export class CodexNonrenewableCredentialError extends Error {
  constructor() {
    super("Codex credential cannot be refreshed")
    this.name = "CodexNonrenewableCredentialError"
  }
}

export class CodexCredentialExpiredError extends Error {
  constructor() {
    super("Codex access credential has expired")
    this.name = "CodexCredentialExpiredError"
  }
}

export class CodexAccessRejectedError extends Error {
  constructor() {
    super("Codex access credential was rejected")
    this.name = "CodexAccessRejectedError"
  }
}

export const invalidateCodexAccessToken = async (lease: CodexAccessTokenLease): Promise<void> => {
  await ignoreGoneCodexEffect(updateCodexCredential(codexBearerEffect(lease), account => ({ ...account, accessToken: null })))
}

export const rejectCodexAccessToken = async (lease: CodexAccessTokenLease): Promise<void> => {
  const updatedAt = new Date().toISOString()
  await ignoreGoneCodexEffect(updateCodexCredential(codexBearerEffect(lease), account => ({
    ...account, state: "access_rejected", state_message: "access_rejected", state_updated_at: updatedAt,
  })))
}

// Coalescing reduces duplicate work for the exact stored credential. CAS, not
// this process-local map, decides which cross-instance mint may commit.
const inFlightEnsures = new Map<string, Promise<CodexAccessTokenLease>>()
const coalescingScopes = new WeakMap<object, number>()
let nextCoalescingScope = 1

const scopeNumber = (scope?: object): number => {
  if (!scope) return 0
  const existing = coalescingScopes.get(scope)
  if (existing !== undefined) return existing
  const next = nextCoalescingScope++
  coalescingScopes.set(scope, next)
  return next
}

export const ensureCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
  mint: CodexTokenMint,
  force = false,
  expected?: UpstreamWriteTarget,
  signal?: AbortSignal,
  coalescingScope?: object,
  beforeMint?: CodexBeforeMint,
): Promise<CodexAccessTokenLease> => {
  assertNotAborted(signal)
  if (signal) {
    const owned = new AbortController()
    const cancel = () => owned.abort()
    signal.addEventListener("abort", cancel, { once: true })
    try {
      if (signal.aborted) cancel()
      assertNotAborted(owned.signal)
      const lease = await waitForOwnedOperation((async () => {
        const snapshot = await readCodexCredential(upstreamId, accountId, expected)
        assertNotAborted(owned.signal)
        return await ensureInner(snapshot, mint, force, true, owned.signal, beforeMint)
      })(), owned.signal)
      assertNotAborted(owned.signal)
      return lease
    } finally {
      signal.removeEventListener("abort", cancel)
    }
  }
  const snapshot = await readCodexCredential(upstreamId, accountId, expected)
  const { credential, account } = snapshot
  const key = JSON.stringify([upstreamId, accountId, credential.rowIncarnation, credential.ownerId,
    credential.credentialRevision, account.refresh_token, account.accessToken?.token, force, scopeNumber(coalescingScope ?? beforeMint)])
  const existing = inFlightEnsures.get(key)
  if (existing) return await existing
  const promise = ensureInner(snapshot, mint, force, true, undefined, beforeMint)
  inFlightEnsures.set(key, promise)
  try { return await promise } finally { inFlightEnsures.delete(key) }
}

const ensureInner = async (
  snapshot: CodexCredentialSnapshot,
  mint: CodexTokenMint,
  force: boolean,
  recoveryAllowed: boolean,
  signal?: AbortSignal,
  beforeMint?: CodexBeforeMint,
): Promise<CodexAccessTokenLease> => {
  assertNotAborted(signal)
  const { credential, account } = snapshot
  if (account.state === "access_rejected") throw new CodexAccessRejectedError()
  if (account.state !== "active") throw new CodexCredentialUnavailableError()
  if (account.refresh_token === null) {
    if (force) throw new CodexNonrenewableCredentialError()
    const lease = usableLease(snapshot)
    if (lease) return lease
    if (account.accessToken?.expiresAt !== null && account.accessToken?.expiresAt !== undefined) {
      throw new CodexCredentialExpiredError()
    }
    throw new CodexCredentialUnavailableError()
  }
  if (!force && account.accessToken && isAccessTokenFresh(account.accessToken)) {
    return { ...account.accessToken, credential, renewable: true }
  }
  const effect = { credential, tokenKind: "refresh" as const, token: account.refresh_token }
  let minted: CodexMintResult
  if (beforeMint) {
    await beforeMint(credential)
    assertNotAborted(signal)
  }
  try {
    minted = await waitForOwnedOperation(signal ? mint(account.refresh_token, signal) : mint(account.refresh_token), signal)
  } catch (error) {
    if (error instanceof CodexOAuthSessionTerminatedError) {
      const current = await readCodexCredential(credential.upstreamId, credential.accountId, credential)
      assertNotAborted(signal)
      const changed = current.credential.credentialRevision !== credential.credentialRevision ||
        current.account.refresh_token !== account.refresh_token
      if (changed) {
        const winner = usableLease(current)
        if (winner) {
          assertNotAborted(signal)
          return winner
        }
        // Preserve the existing single invalid_grant recovery with the current
        // refresh token and a newly captured effect identity.
        if (error.code === "invalid_grant" && recoveryAllowed && current.account.state === "active") {
          return await ensureInner(current, mint, false, false, signal, beforeMint)
        }
      }
      assertNotAborted(signal)
      await persistCodexTerminalState(effect, "refresh_failed", error.upstreamMessage, signal)
      assertNotAborted(signal)
    }
    assertNotAborted(signal)
    throw error
  }
  assertNotAborted(signal)
  await updateCodexCredential(effect, current => signal?.aborted ? current : ({
    ...current, refresh_token: minted.refreshToken, accessToken: minted.accessToken,
    state_updated_at: minted.accessToken.refreshedAt,
  }))
  assertNotAborted(signal)
  // A losing CAS can be a no-op when reimport/rotation won. Never return the
  // local mint in place of the authoritative row's current usable token.
  const current = await readCodexCredential(credential.upstreamId, credential.accountId, credential)
  assertNotAborted(signal)
  const winner = usableLease(current)
  if (!winner) {
    const changed = current.credential.credentialRevision !== credential.credentialRevision ||
      current.account.refresh_token !== account.refresh_token
    if (changed && recoveryAllowed && current.account.state === "active" && current.account.refresh_token !== null) {
      return await ensureInner(current, mint, false, false, signal, beforeMint)
    }
    throw new CodexCredentialUnavailableError()
  }
  assertNotAborted(signal)
  return winner
}

export const refreshCodexAccessTokenForRetry = async (
  failed: CodexAccessTokenLease,
  mint: CodexTokenMint,
  signal?: AbortSignal,
  beforeMint?: CodexBeforeMint,
): Promise<CodexAccessTokenLease> => {
  assertNotAborted(signal)
  if (!failed.renewable) {
    await rejectCodexAccessToken(failed)
    throw new CodexAccessRejectedError()
  }
  const target = failed.credential
  const current = await readCodexCredential(target.upstreamId, target.accountId, target)
  assertNotAborted(signal)
  const winner = usableLease(current)
  if (winner && (winner.token !== failed.token || winner.credential.credentialRevision !== target.credentialRevision)) return winner
  await invalidateCodexAccessToken(failed)
  // A sibling can rotate between the first read and invalidation CAS.
  return await ensureCodexAccessToken(target.upstreamId, target.accountId, mint, false, target, signal, undefined, beforeMint)
}

export const mintCodexAccessToken = async (refreshToken: string, fetcher: Fetcher, signal?: AbortSignal): Promise<CodexMintResult> => {
  const scopedFetcher: Fetcher = signal ? (url, init) => fetcher(url, { ...init, signal }) : fetcher
  const tokens = await refreshCodexAccessToken(refreshToken, scopedFetcher)
  return {
    refreshToken: tokens.refresh_token,
    accessToken: { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000, refreshedAt: new Date().toISOString() },
  }
}
