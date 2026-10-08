import {
  getAuthoritativeUpstreamRepo, getUpstreamRepo, UpstreamGoneError, UpstreamReplacedError,
  type UpstreamWriteTarget,
} from "@vibe-core/upstream-repo"
import type { EnsuredAccessToken } from "./access-token"
import {
  readClaudeCodeUpstreamState, replaceSoleAccount,
  type ClaudeCodeAccountCredential, type ClaudeCodeUpstreamState,
} from "./state"

export interface ClaudeCodeCredentialTarget extends UpstreamWriteTarget {
  readonly upstreamId: string
  readonly rowIncarnation: string
  readonly ownerId?: string
  readonly provider: "claude-code"
  readonly credentialGeneration?: number
  readonly configurationGeneration?: number
  readonly accountUuid: string
  readonly tokenKind: "oauth" | "setup-token"
  readonly stateUpdatedAt: string
}

export interface ClaudeCodeCredentialSnapshot {
  readonly credential: ClaudeCodeCredentialTarget
  readonly account: ClaudeCodeAccountCredential
}

type ExpectedCredential = UpstreamWriteTarget & Partial<Pick<ClaudeCodeCredentialTarget,
  "upstreamId" | "accountUuid" | "tokenKind" | "stateUpdatedAt">>

export const assertClaudeCodeCredentialTarget = (
  credential: ClaudeCodeCredentialTarget,
  expected?: ExpectedCredential,
): void => {
  if (expected && (
    credential.rowIncarnation !== expected.rowIncarnation ||
    credential.ownerId !== expected.ownerId || credential.provider !== expected.provider ||
    (expected.upstreamId !== undefined && credential.upstreamId !== expected.upstreamId) ||
    (expected.credentialGeneration !== undefined && credential.credentialGeneration !== expected.credentialGeneration) ||
    (expected.accountUuid !== undefined && credential.accountUuid !== expected.accountUuid) ||
    (expected.tokenKind !== undefined && credential.tokenKind !== expected.tokenKind) ||
    // Legacy adapters have no credential epoch. Preserve their health/import
    // timestamp fence without adding fields older strict state readers reject.
    (expected.credentialGeneration === undefined && expected.stateUpdatedAt !== undefined &&
      credential.stateUpdatedAt !== expected.stateUpdatedAt)
  )) throw new UpstreamReplacedError(credential.upstreamId)
}

export const readClaudeCodeCredential = async (
  upstreamId: string,
  expected?: ExpectedCredential,
  authoritative = false,
): Promise<ClaudeCodeCredentialSnapshot> => {
  const repo = authoritative ? getAuthoritativeUpstreamRepo() : getUpstreamRepo()
  const row = await repo.getById(upstreamId)
  if (!row) throw new UpstreamGoneError(upstreamId)
  if (row.provider !== "claude-code") throw new UpstreamReplacedError(upstreamId)
  const account = readClaudeCodeUpstreamState(row.state).accounts[0]
  if (!account) throw new UpstreamReplacedError(upstreamId)
  const credential: ClaudeCodeCredentialTarget = Object.freeze({
    upstreamId, rowIncarnation: row.rowIncarnation, ownerId: row.ownerId,
    provider: "claude-code", accountUuid: account.accountUuid, tokenKind: account.tokenKind,
    stateUpdatedAt: account.stateUpdatedAt,
    ...(typeof row.credentialGeneration === "number" && Number.isSafeInteger(row.credentialGeneration) && row.credentialGeneration >= 0
      ? { credentialGeneration: row.credentialGeneration } : {}),
    ...(typeof row.catalogGeneration === "number" && Number.isSafeInteger(row.catalogGeneration) && row.catalogGeneration >= 0
      ? { configurationGeneration: row.catalogGeneration } : {}),
  })
  assertClaudeCodeCredentialTarget(credential, expected)
  return { credential, account }
}

export type ClaudeCodeCredentialEffect = {
  credential: ClaudeCodeCredentialTarget
} & ({ tokenKind: "access"; token: string | null } | {
  tokenKind: "refresh"
  token: string
  // A server may retain the refresh token. In that case the access token
  // still identifies which competing refresh won publication.
  accessToken: string | null
})

export const claudeCodeBearerEffect = (lease: EnsuredAccessToken): ClaudeCodeCredentialEffect => ({
  credential: lease.credential, tokenKind: "access", token: lease.entry.token,
})

const matchesEffect = (account: ClaudeCodeAccountCredential, effect: ClaudeCodeCredentialEffect): boolean =>
  account.state === "active" && account.accountUuid === effect.credential.accountUuid &&
  account.tokenKind === effect.credential.tokenKind &&
  (effect.credential.credentialGeneration !== undefined || account.stateUpdatedAt === effect.credential.stateUpdatedAt) &&
  (effect.tokenKind === "access" ? (account.accessToken?.token ?? null) === effect.token :
    account.refreshToken === effect.token && (account.accessToken?.token ?? null) === effect.accessToken)

/** CAS can replay the updater. Effects own only the exact credential used. */
export const updateClaudeCodeCredential = async (
  effect: ClaudeCodeCredentialEffect,
  update: (account: ClaudeCodeAccountCredential) => ClaudeCodeAccountCredential,
): Promise<void> => {
  await getUpstreamRepo().saveState<ClaudeCodeUpstreamState>(effect.credential.upstreamId, current => {
    const state = readClaudeCodeUpstreamState(current)
    const account = state.accounts[0]
    return account && matchesEffect(account, effect) ? replaceSoleAccount(state, update) : current
  }, effect.credential)
}

export const ignoreGoneClaudeCodeEffect = async (effect: Promise<void>): Promise<void> => {
  try { await effect } catch (error) {
    if (!(error instanceof UpstreamGoneError) && !(error instanceof UpstreamReplacedError)) throw error
  }
}
