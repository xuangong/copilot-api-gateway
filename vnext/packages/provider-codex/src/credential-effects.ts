import {
  getAuthoritativeUpstreamRepo, getUpstreamRepo, UpstreamGoneError, UpstreamReplacedError,
  type UpstreamWriteTarget,
} from "@vibe-core/upstream-repo"
import {
  findCodexAccountIndex, readCodexUpstreamState, replaceCodexAccount,
  type CodexAccessTokenEntry, type CodexAccountCredential, type CodexUpstreamState,
} from "./state"

export interface CodexCredentialTarget extends UpstreamWriteTarget {
  upstreamId: string
  accountId: string
  provider: "codex"
  credentialRevision: string | null
}

export interface CodexCredentialSnapshot {
  credential: CodexCredentialTarget
  account: CodexAccountCredential
}

export interface CodexAccessTokenLease extends CodexAccessTokenEntry {
  credential: CodexCredentialTarget
}

export interface CodexCredentialEffect {
  credential: CodexCredentialTarget
  tokenKind: "access" | "refresh"
  token: string
}

export const readCodexCredential = async (
  upstreamId: string,
  accountId: string,
  expected?: UpstreamWriteTarget,
): Promise<CodexCredentialSnapshot> => {
  const row = await getAuthoritativeUpstreamRepo().getById(upstreamId)
  if (!row) throw new UpstreamGoneError(upstreamId)
  if (row.provider !== "codex" || (expected && (
    row.rowIncarnation !== expected.rowIncarnation ||
    row.ownerId !== expected.ownerId || row.provider !== expected.provider
  ))) throw new UpstreamReplacedError(upstreamId)
  const account = readCodexUpstreamState(row.state).accounts.find(value => value.chatgptAccountId === accountId)
  if (!account) throw new Error("Codex credential account not found")
  return {
    credential: {
      upstreamId, accountId, rowIncarnation: row.rowIncarnation,
      ownerId: row.ownerId, provider: "codex", credentialRevision: account.credentialRevision ?? null,
    },
    account,
  }
}

export const codexBearerEffect = (lease: CodexAccessTokenLease): CodexCredentialEffect => ({
  credential: lease.credential, tokenKind: "access", token: lease.token,
})

export const matchesCodexCredentialEffect = (
  account: CodexAccountCredential,
  effect: CodexCredentialEffect,
): boolean => account.chatgptAccountId === effect.credential.accountId &&
  (account.credentialRevision ?? null) === effect.credential.credentialRevision &&
  (effect.tokenKind === "refresh" ? account.refresh_token : account.accessToken?.token) === effect.token

// CAS may replay the pure updater. Row identity is checked even for a no-op.
export const updateCodexCredential = async (
  effect: CodexCredentialEffect,
  update: (account: CodexAccountCredential) => CodexAccountCredential,
): Promise<void> => {
  await getUpstreamRepo().saveState<CodexUpstreamState>(effect.credential.upstreamId, current => {
    const state = readCodexUpstreamState(current)
    const index = findCodexAccountIndex(state, effect.credential.accountId)
    const account = state.accounts[index]
    if (!account || account.state !== "active" || !matchesCodexCredentialEffect(account, effect)) return current
    return replaceCodexAccount(state, index, update)
  }, effect.credential)
}

export const ignoreGoneCodexEffect = async (effect: Promise<void>): Promise<void> => {
  try { await effect } catch (error) {
    if (!(error instanceof UpstreamGoneError) && !(error instanceof UpstreamReplacedError)) throw error
  }
}

export const persistCodexTerminalState = async (
  effect: CodexCredentialEffect,
  state: "session_terminated" | "refresh_failed",
  message: string,
): Promise<void> => {
  const updatedAt = new Date().toISOString()
  await ignoreGoneCodexEffect(updateCodexCredential(effect, account => ({
    ...account, state, state_message: message, state_updated_at: updatedAt, accessToken: null,
  })))
}
