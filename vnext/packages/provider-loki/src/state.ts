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
  errorCode?: LokiErrorCode
  updatedAt?: number
  lastReceipt?: { requestId: string; payloadHash: string }
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

function parseCredential(value: unknown): LokiCredential {
  const credential = record(value)
  only(credential, ["accessToken", "tokenType", "expiresAt", "account"])
  if (credential.tokenType !== "Bearer") return invalid()
  return { accessToken: text(credential.accessToken, 48 * 1024), tokenType: "Bearer",
    expiresAt: integer(credential.expiresAt), account: parseAccount(credential.account) }
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
    ...(status === "authorized" ? { credential: parseCredential(source.credential) } : {}),
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
    ...(source.credential === undefined ? {} : { credential: parseCredential(source.credential) }),
    ...(source.updatedAt === undefined ? {} : { updatedAt: integer(source.updatedAt) }),
  }
  if (source.lastReceipt !== undefined) {
    const receipt = record(source.lastReceipt)
    state.lastReceipt = { requestId: text(receipt.requestId, 128), payloadHash: text(receipt.payloadHash) }
  }
  if (source.errorCode === "interaction_required" || source.errorCode === "broker_unavailable"
    || source.errorCode === "invalid_result" || source.errorCode === "acquisition_failed") state.errorCode = source.errorCode
  return state
}
