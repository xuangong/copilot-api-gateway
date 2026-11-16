export interface LokiAccount {
  homeAccountId: string
  tenantId: string
}

export interface LokiCredential {
  accessToken: string
  tokenType: "Bearer"
  expiresAt: number
  account: LokiAccount
}

export type LokiAssistantStatus = "waiting" | "authorized" | "interaction_required" | "failed"
export type LokiErrorCode = "interaction_required" | "broker_unavailable" | "invalid_result" | "acquisition_failed"

export type LokiMirrorErrorCode = "mirror_revoked" | "account_mismatch"
export const LOKI_MAX_MIRRORS = 16
export const LOKI_MIRROR_ID_PATTERN = /^lkmid_[a-f0-9]{32}$/
export const LOKI_MIRROR_SECRET_PATTERN = /^lkm_[a-f0-9]{64}$/

export interface LokiMirror {
  id: string
  label: string
  secretHash: string
  createdAt: number
  lastPulledAt?: number
}

export interface LokiMirrorSource {
  kind: "mirror"
  origin: string
  upstreamId: string
  mirrorId: string
  mirrorSecret: string
}

export type LokiMirrorPullOutcome = { kind: "ok"; credential: LokiCredential } | { kind: "revoked" }

export interface LokiSyncUpdate {
  version: 1
  generation: string
  expectedRevision: number
  requestId: string
  status: Exclude<LokiAssistantStatus, "waiting">
  credential?: LokiCredential
  errorCode?: LokiErrorCode
}

export interface LokiState {
  version: 1
  profileId: "loki-df-v1"
  generation: string
  syncSecretHash: string
  revision: number
  assistantStatus: LokiAssistantStatus
  account?: LokiAccount
  credential?: LokiCredential
  errorCode?: LokiErrorCode | LokiMirrorErrorCode
  updatedAt?: number
  lastReceipt?: { requestId: string; payloadHash: string }
  mirrors?: LokiMirror[]
  source?: LokiMirrorSource
}

export class LokiSyncError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

const invalid = (): never => { throw new LokiSyncError("invalid_request", 400) }
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const text = (value: unknown, max = 512): string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    && Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) ? value : invalid()
const integer = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid()
function only(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid()
}

function parseAccount(value: unknown): LokiAccount {
  const account = record(value)
  only(account, ["homeAccountId", "tenantId"])
  const tenantId = text(account.tenantId)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) return invalid()
  return { homeAccountId: text(account.homeAccountId), tenantId: tenantId.toLowerCase() }
}

export function parseLokiCredential(value: unknown): LokiCredential {
  const credential = record(value)
  only(credential, ["accessToken", "tokenType", "expiresAt", "account"])
  if (credential.tokenType !== "Bearer") return invalid()
  return { accessToken: text(credential.accessToken, 48 * 1024), tokenType: "Bearer",
    expiresAt: integer(credential.expiresAt), account: parseAccount(credential.account) }
}

function parseMirror(value: unknown): LokiMirror {
  const mirror = record(value)
  only(mirror, ["id", "label", "secretHash", "createdAt", "lastPulledAt"])
  const id = text(mirror.id, 64)
  const secretHash = text(mirror.secretHash, 64)
  if (!LOKI_MIRROR_ID_PATTERN.test(id) || !/^[a-f0-9]{64}$/.test(secretHash)) return invalid()
  return { id, label: text(mirror.label, 64), secretHash, createdAt: integer(mirror.createdAt),
    ...(mirror.lastPulledAt === undefined ? {} : { lastPulledAt: integer(mirror.lastPulledAt) }) }
}

export function parseLokiMirrorSource(value: unknown): LokiMirrorSource {
  const source = record(value)
  only(source, ["kind", "origin", "upstreamId", "mirrorId", "mirrorSecret"])
  if (source.kind !== "mirror") return invalid()
  let url: URL
  try { url = new URL(text(source.origin, 2048)) } catch { return invalid() }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || /[?#]/.test(String(source.origin))) return invalid()
  const upstreamId = text(source.upstreamId, 256)
  const mirrorId = text(source.mirrorId, 64)
  const mirrorSecret = text(source.mirrorSecret, 128)
  if (!/^[a-zA-Z0-9_-]+$/.test(upstreamId) || !LOKI_MIRROR_ID_PATTERN.test(mirrorId)
    || !LOKI_MIRROR_SECRET_PATTERN.test(mirrorSecret)) return invalid()
  return { kind: "mirror", origin: url.origin, upstreamId, mirrorId, mirrorSecret }
}

export function parseLokiSyncUpdate(value: unknown): LokiSyncUpdate {
  const source = record(value)
  only(source, ["version", "generation", "expectedRevision", "requestId", "status", "credential", "errorCode"])
  if (source.version !== 1 || (source.status !== "authorized" && source.status !== "interaction_required" && source.status !== "failed")) return invalid()
  const status = source.status as LokiSyncUpdate["status"]
  if (status !== "authorized" && source.credential !== undefined) return invalid()
  if (status === "authorized" && source.errorCode !== undefined) return invalid()
  const errorCode = source.errorCode
  if (errorCode !== undefined && errorCode !== "interaction_required" && errorCode !== "broker_unavailable"
    && errorCode !== "invalid_result" && errorCode !== "acquisition_failed") return invalid()
  return {
    version: 1, generation: text(source.generation, 128), expectedRevision: integer(source.expectedRevision),
    requestId: text(source.requestId, 128), status,
    ...(status === "authorized" ? { credential: parseLokiCredential(source.credential) } : {}),
    ...(errorCode === undefined ? {} : { errorCode }),
  }
}

export function applyLokiSyncUpdate(state: LokiState, update: LokiSyncUpdate, payloadHash: string, now: number): LokiState {
  if (state.generation !== update.generation) throw new LokiSyncError("binding_replaced", 409)
  if (state.lastReceipt?.requestId === update.requestId) {
    if (state.lastReceipt.payloadHash !== payloadHash) throw new LokiSyncError("request_conflict", 409)
    return state
  }
  if (state.revision !== update.expectedRevision || state.revision >= Number.MAX_SAFE_INTEGER) throw new LokiSyncError("revision_conflict", 409)
  const credential = update.credential
  if (credential) {
    if (credential.expiresAt <= now + 60_000) throw new LokiSyncError("credential_expired", 400)
    if (state.account && (state.account.homeAccountId !== credential.account.homeAccountId
      || state.account.tenantId !== credential.account.tenantId)) throw new LokiSyncError("account_mismatch", 409)
  }
  const { errorCode: _previousError, ...current } = state
  return {
    ...current, revision: state.revision + 1, assistantStatus: update.status, updatedAt: now,
    ...(credential ? { credential, account: credential.account } : {}),
    ...(update.errorCode ? { errorCode: update.errorCode } : {}),
    lastReceipt: { requestId: update.requestId, payloadHash },
  }
}

export function publicLokiStatus(state: LokiState, now = Date.now()) {
  return {
    assistantStatus: state.assistantStatus,
    tokenStatus: !state.credential ? "missing" as const : state.credential.expiresAt <= now ? "expired" as const : "valid" as const,
    expiresAt: state.credential?.expiresAt ?? null,
    updatedAt: state.updatedAt ?? null,
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
  }
}

const STORED_ERROR_CODES = new Set(["interaction_required", "broker_unavailable", "invalid_result",
  "acquisition_failed", "mirror_revoked", "account_mismatch"])

export function readLokiState(value: unknown): LokiState {
  const source = record(value)
  if (source.version !== 1 || source.profileId !== "loki-df-v1"
    || (source.assistantStatus !== "waiting" && source.assistantStatus !== "authorized" && source.assistantStatus !== "interaction_required" && source.assistantStatus !== "failed")
    || typeof source.syncSecretHash !== "string") return invalid()
  const state: LokiState = {
    version: 1, profileId: "loki-df-v1", generation: text(source.generation, 128),
    syncSecretHash: source.syncSecretHash, revision: integer(source.revision),
    assistantStatus: source.assistantStatus as LokiAssistantStatus,
    ...(source.account === undefined ? {} : { account: parseAccount(source.account) }),
    ...(source.credential === undefined ? {} : { credential: parseLokiCredential(source.credential) }),
    ...(source.updatedAt === undefined ? {} : { updatedAt: integer(source.updatedAt) }),
  }
  if (source.lastReceipt !== undefined) {
    const receipt = record(source.lastReceipt)
    state.lastReceipt = { requestId: text(receipt.requestId, 128), payloadHash: text(receipt.payloadHash) }
  }
  if (source.mirrors !== undefined) {
    if (!Array.isArray(source.mirrors) || source.mirrors.length > LOKI_MAX_MIRRORS) return invalid()
    state.mirrors = source.mirrors.map(parseMirror)
  }
  if (source.source !== undefined) state.source = parseLokiMirrorSource(source.source)
  if (typeof source.errorCode === "string" && STORED_ERROR_CODES.has(source.errorCode)) {
    state.errorCode = source.errorCode as LokiErrorCode | LokiMirrorErrorCode
  }
  return state
}

const sameAccount = (a: LokiAccount, b: LokiAccount) => a.homeAccountId === b.homeAccountId && a.tenantId === b.tenantId

/** The stored credential, if it is unexpired and belongs to the bound account. */
export function usableLokiCredential(state: LokiState, now: number): LokiCredential | undefined {
  const credential = state.credential
  return credential && state.account && credential.expiresAt > now && sameAccount(credential.account, state.account)
    ? credential : undefined
}

export function addLokiMirror(state: LokiState, mirror: LokiMirror): LokiState {
  if (state.source) throw new LokiSyncError("mirror_unsupported", 400)
  const mirrors = state.mirrors ?? []
  if (mirrors.length >= LOKI_MAX_MIRRORS) throw new LokiSyncError("mirror_limit", 409)
  return { ...state, mirrors: [...mirrors, mirror] }
}

export function removeLokiMirror(state: LokiState, mirrorId: string): LokiState {
  const mirrors = state.mirrors ?? []
  if (!mirrors.some(mirror => mirror.id === mirrorId)) throw new LokiSyncError("mirror_not_found", 404)
  const { mirrors: _removed, ...rest } = state
  const remaining = mirrors.filter(mirror => mirror.id !== mirrorId)
  return remaining.length ? { ...rest, mirrors: remaining } : rest
}

export function touchLokiMirror(state: LokiState, mirrorId: string, now: number): LokiState {
  if (!state.mirrors?.some(mirror => mirror.id === mirrorId)) return state
  return { ...state, mirrors: state.mirrors.map(mirror => mirror.id === mirrorId ? { ...mirror, lastPulledAt: now } : mirror) }
}

export function newLokiMirrorState(source: LokiMirrorSource, credential: LokiCredential | undefined, now: number): LokiState {
  return { version: 1, profileId: "loki-df-v1", generation: crypto.randomUUID(), syncSecretHash: "", revision: 0,
    assistantStatus: credential ? "authorized" : "waiting", source,
    ...(credential ? { credential, account: credential.account, updatedAt: now } : {}) }
}

/** Applies a pull result; a result for a replaced source is ignored. */
export function applyLokiMirrorPull(state: LokiState, source: LokiMirrorSource, outcome: LokiMirrorPullOutcome, now: number): LokiState {
  if (!state.source || state.source.mirrorId !== source.mirrorId || state.source.mirrorSecret !== source.mirrorSecret) return state
  const { errorCode: _previous, ...rest } = state
  if (outcome.kind === "revoked") return { ...rest, errorCode: "mirror_revoked", updatedAt: now }
  if (state.account && !sameAccount(state.account, outcome.credential.account)) {
    return { ...rest, errorCode: "account_mismatch", updatedAt: now }
  }
  return { ...rest, credential: outcome.credential, account: outcome.credential.account, assistantStatus: "authorized", updatedAt: now }
}
