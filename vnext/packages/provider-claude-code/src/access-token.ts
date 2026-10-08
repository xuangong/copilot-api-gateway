import type { UpstreamWriteTarget } from "@vibe-core/upstream-repo"
import {
  ClaudeCodeOAuthSessionTerminatedError,
  refreshClaudeCodeAccessToken,
} from "./auth/oauth"
import {
  assertClaudeCodeCredentialTarget, claudeCodeBearerEffect, ignoreGoneClaudeCodeEffect,
  readClaudeCodeCredential, updateClaudeCodeCredential,
  type ClaudeCodeCredentialEffect, type ClaudeCodeCredentialSnapshot, type ClaudeCodeCredentialTarget,
} from "./credential-effects"
import type { Fetcher } from "./fetcher"
import { logInfo, logWarn } from "./log"
import type { ClaudeCodeAccessTokenEntry } from "./state"

export type { ClaudeCodeAccessTokenEntry }

export interface EnsuredAccessToken {
  readonly entry: Readonly<ClaudeCodeAccessTokenEntry>
  readonly freshlyMinted: boolean
  readonly credential: ClaudeCodeCredentialTarget
}

export interface EnsureClaudeCodeAccessTokenArgs {
  upstreamId: string
  fetcher: Fetcher
  force?: boolean
  expected?: UpstreamWriteTarget
  signal?: AbortSignal
  beforeMint?: (credential: Readonly<ClaudeCodeCredentialTarget>) => Promise<void>
  snapshot?: ClaudeCodeCredentialSnapshot
}

export class ClaudeCodeCredentialUnavailableError extends Error {
  constructor() {
    super("Claude Code credential has no usable current access token")
    this.name = "ClaudeCodeCredentialUnavailableError"
  }
}

const aborted = (): DOMException => new DOMException("Claude Code request aborted", "AbortError")
const assertNotAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw aborted()
}

// Even an injected fetcher/guard that ignores AbortSignal must not hold the
// caller open or publish an eventual response after cancellation.
const waitForOwnedOperation = async <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return await pending
  // Always observe pending, even if a synchronous guard just canceled it.
  // Throwing before Promise.race would leave its rejection unhandled.
  let onAbort: (() => void) | undefined
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
const freezeLease = (lease: EnsuredAccessToken): EnsuredAccessToken => Object.freeze({
  ...lease,
  entry: Object.freeze({ ...lease.entry }),
  credential: Object.isFrozen(lease.credential) ? lease.credential : Object.freeze({ ...lease.credential }),
})
const usableLease = (snapshot: ClaudeCodeCredentialSnapshot, skew = 0): EnsuredAccessToken | null => {
  const { credential, account } = snapshot
  return account.state === "active" && account.accessToken && account.accessToken.expiresAt > Date.now() + skew
    ? freezeLease({ entry: account.accessToken, freshlyMinted: false, credential }) : null
}

// Process-local coalescing is only an optimization. SQL epoch/CAS fencing
// decides the winner across isolates, including identical refresh tokens.
const inFlightEnsures = new Map<string, Promise<EnsuredAccessToken>>()
const scopes = new WeakMap<object, number>()
let nextScope = 1
const scopeNumber = (scope?: object): number => {
  if (!scope) return 0
  const existing = scopes.get(scope)
  if (existing !== undefined) return existing
  const value = nextScope++
  scopes.set(scope, value)
  return value
}

export const ensureClaudeCodeAccessToken = async (
  args: EnsureClaudeCodeAccessTokenArgs,
): Promise<EnsuredAccessToken> => {
  assertNotAborted(args.signal)
  return await waitForOwnedOperation((async () => {
    const snapshot = args.snapshot ?? await readClaudeCodeCredential(args.upstreamId, args.expected, args.force)
    assertNotAborted(args.signal)
    assertClaudeCodeCredentialTarget(snapshot.credential, args.expected)
    if (snapshot.credential.upstreamId !== args.upstreamId) throw new ClaudeCodeCredentialUnavailableError()
    const cached = usableLease(snapshot, REFRESH_SKEW_MS)
    if (cached && (!args.force || snapshot.account.tokenKind === "setup-token")) return cached
    const { credential, account } = snapshot
    const key = JSON.stringify([credential.upstreamId, credential.rowIncarnation, credential.ownerId,
      credential.credentialGeneration, credential.stateUpdatedAt, account.accountUuid, account.tokenKind,
      account.refreshToken, account.accessToken?.token, args.force === true,
      scopeNumber(args.fetcher), scopeNumber(args.beforeMint), scopeNumber(args.signal)])
    const existing = inFlightEnsures.get(key)
    if (existing) return await existing
    const pending = waitForOwnedOperation(ensureInner(snapshot, args, true, args.force === true && args.snapshot === undefined), args.signal)
    inFlightEnsures.set(key, pending)
    try { return await pending } finally { inFlightEnsures.delete(key) }
  })(), args.signal)
}

const ensureInner = async (
  snapshot: ClaudeCodeCredentialSnapshot,
  args: EnsureClaudeCodeAccessTokenArgs,
  recoveryAllowed: boolean,
  authoritative: boolean,
): Promise<EnsuredAccessToken> => {
  assertNotAborted(args.signal)
  if (!authoritative) snapshot = await readClaudeCodeCredential(args.upstreamId, snapshot.credential, true)
  assertNotAborted(args.signal)
  const { credential, account } = snapshot
  if (account.state !== "active") {
    throw new ClaudeCodeOAuthSessionTerminatedError({ code: account.state, message: account.stateMessage })
  }
  const cached = usableLease(snapshot, REFRESH_SKEW_MS)
  if (cached && (!args.force || account.tokenKind === "setup-token")) return cached
  if (account.tokenKind === "setup-token") {
    const message = "Setup token expired or absent; re-import to recover"
    await persistTerminalState({ credential, tokenKind: "access", token: account.accessToken?.token ?? null },
      message, "setup_token_expired", args.signal)
    throw new ClaudeCodeOAuthSessionTerminatedError({ code: "setup_token_expired", message })
  }
  const effect: ClaudeCodeCredentialEffect = {
    credential, tokenKind: "refresh", token: account.refreshToken, accessToken: account.accessToken?.token ?? null,
  }
  if (args.beforeMint) await args.beforeMint(credential)
  assertNotAborted(args.signal)
  let refreshed
  try {
    refreshed = await refreshClaudeCodeAccessToken(account.refreshToken, args.fetcher, args.signal)
  } catch (error) {
    assertNotAborted(args.signal)
    if (error instanceof ClaudeCodeOAuthSessionTerminatedError) {
      const current = await readClaudeCodeCredential(args.upstreamId, credential, true)
      assertNotAborted(args.signal)
      const changed = current.account.refreshToken !== account.refreshToken ||
        current.account.accessToken?.token !== account.accessToken?.token
      if (changed) {
        const winner = usableLease(current)
        if (winner) return winner
        if (error.code === "invalid_grant" && recoveryAllowed && current.account.state === "active") {
          return await ensureInner(current, { ...args, force: false }, false, true)
        }
      }
      // Without a visible winner invalid_grant cannot distinguish revocation
      // from a sibling whose successful rotation has not committed yet.
      if (error.code !== "invalid_grant") {
        await persistTerminalState(effect, error.upstreamMessage, error.code, args.signal)
      }
    }
    assertNotAborted(args.signal)
    throw error
  }
  assertNotAborted(args.signal)
  if (typeof refreshed.refresh_token !== "string" || refreshed.refresh_token === "") {
    throw new Error("Claude Code refresh response missing refresh_token")
  }
  const rotatedRefreshToken = refreshed.refresh_token
  const entry: ClaudeCodeAccessTokenEntry = {
    token: refreshed.access_token, expiresAt: Date.now() + refreshed.expires_in * 1000,
    refreshedAt: new Date().toISOString(),
  }
  await updateClaudeCodeCredential(effect, current => {
    assertNotAborted(args.signal)
    return current.tokenKind === "oauth" ? { ...current, refreshToken: rotatedRefreshToken, accessToken: entry } : current
  })
  assertNotAborted(args.signal)
  const current = await readClaudeCodeCredential(args.upstreamId, credential, true)
  assertNotAborted(args.signal)
  const winner = usableLease(current)
  if (winner) {
    const freshlyMinted = winner.entry.token === entry.token
    logInfo("claude_code_refresh_complete", { upstream_id: args.upstreamId, freshly_minted: freshlyMinted })
    return freezeLease({ ...winner, freshlyMinted })
  }
  if (recoveryAllowed && current.account.state === "active" && current.account.refreshToken !== account.refreshToken) {
    return await ensureInner(current, { ...args, force: false }, false, true)
  }
  throw new ClaudeCodeCredentialUnavailableError()
}

const persistTerminalState = async (
  effect: ClaudeCodeCredentialEffect,
  message: string,
  code: string,
  signal?: AbortSignal,
): Promise<void> => {
  assertNotAborted(signal)
  const stateUpdatedAt = new Date().toISOString()
  await ignoreGoneClaudeCodeEffect(updateClaudeCodeCredential(effect, account => {
    assertNotAborted(signal)
    return { ...account, state: "refresh_failed", stateMessage: message, stateUpdatedAt, accessToken: null }
  }))
  assertNotAborted(signal)
  logWarn("claude_code_credential_terminal_effect", { upstream_id: effect.credential.upstreamId, oauth_code: code })
}

export const invalidateClaudeCodeAccessToken = async (lease: EnsuredAccessToken, signal?: AbortSignal): Promise<void> => {
  assertNotAborted(signal)
  await ignoreGoneClaudeCodeEffect(updateClaudeCodeCredential(claudeCodeBearerEffect(lease), account => {
    assertNotAborted(signal)
    return { ...account, accessToken: null }
  }))
}

export const refreshClaudeCodeAccessTokenForRetry = async (
  failed: EnsuredAccessToken,
  args: EnsureClaudeCodeAccessTokenArgs,
): Promise<EnsuredAccessToken> => {
  assertNotAborted(args.signal)
  const current = await readClaudeCodeCredential(args.upstreamId, failed.credential, true)
  assertNotAborted(args.signal)
  assertClaudeCodeCredentialTarget(current.credential, args.expected)
  const winner = usableLease(current)
  if (winner && winner.entry.token !== failed.entry.token) return winner
  if (failed.credential.tokenKind === "setup-token") {
    const message = "Setup token rejected; re-import to recover"
    await persistTerminalState(claudeCodeBearerEffect(failed), message, "setup_token_rejected", args.signal)
    throw new ClaudeCodeOAuthSessionTerminatedError({ code: "setup_token_rejected", message })
  }
  await invalidateClaudeCodeAccessToken(failed, args.signal)
  assertNotAborted(args.signal)
  // Re-read after invalidation: a sibling may have committed between them.
  const snapshot = await readClaudeCodeCredential(args.upstreamId, failed.credential, true)
  assertNotAborted(args.signal)
  return await ensureClaudeCodeAccessToken({ ...args, force: false, snapshot, expected: failed.credential })
}
