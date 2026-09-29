import type { CodexAccountIdentity } from "../config"
import { parseCodexTokenClaims, tryParseCodexAccessTokenClaims, type CodexTokenClaims } from "./jwt"

export interface CodexCredentialInput {
  accessToken?: string | null
  refreshToken?: string | null
  idToken?: string | null
  chatgptAccountId?: string | null
  email?: string | null
  chatgptUserId?: string | null
  planType?: string | null
  expiresAt?: number | null
}

export interface NormalizedCodexCredential {
  accessToken: string | null
  refreshToken: string | null
  expiresAt: number | null
  identity: CodexAccountIdentity
}

const optionalString = (value: unknown, name: string): string | null => {
  if (value === undefined || value === null || value === "") return null
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string when present`)
  return value
}

const EMPTY_CLAIMS: CodexTokenClaims = {
  email: null, chatgptAccountId: null, chatgptUserId: null, planType: null, expiresAt: null,
}

export const normalizeCodexCredential = (input: CodexCredentialInput): NormalizedCodexCredential => {
  const accessToken = optionalString(input.accessToken, "access token")
  const refreshToken = optionalString(input.refreshToken, "refresh token")
  const idToken = optionalString(input.idToken, "id token")
  if (!accessToken && !refreshToken) throw new TypeError("Codex credential needs an access or refresh token")
  const idClaims = idToken ? parseCodexTokenClaims(idToken, "id_token") : EMPTY_CLAIMS
  const accessClaims = accessToken ? (tryParseCodexAccessTokenClaims(accessToken) ?? EMPTY_CLAIMS) : EMPTY_CLAIMS
  const explicitAccountId = optionalString(input.chatgptAccountId, "account ID")
  const knownIds = [idClaims.chatgptAccountId, accessClaims.chatgptAccountId].filter((id): id is string => id !== null)
  if (knownIds.length === 2 && knownIds[0] !== knownIds[1]) throw new TypeError("Codex token account IDs conflict")
  const claimedId = knownIds[0] ?? null
  if (claimedId && explicitAccountId && claimedId !== explicitAccountId) throw new TypeError("Codex token and export account IDs conflict")
  const chatgptAccountId = claimedId ?? explicitAccountId
  if (!chatgptAccountId) throw new TypeError("Codex account ID is required")
  const sourceExpiry = input.expiresAt ?? null
  if (sourceExpiry !== null && (!Number.isFinite(sourceExpiry) || sourceExpiry <= 0)) throw new TypeError("Codex expiry is invalid")
  const expiresAt = accessClaims.expiresAt ?? sourceExpiry
  if (accessToken && !refreshToken && expiresAt !== null && expiresAt <= Date.now()) {
    throw new TypeError("Codex access credential is expired")
  }
  return {
    accessToken, refreshToken, expiresAt,
    identity: {
      chatgptAccountId,
      email: idClaims.email ?? accessClaims.email ?? optionalString(input.email, "email"),
      chatgptUserId: idClaims.chatgptUserId ?? accessClaims.chatgptUserId ?? optionalString(input.chatgptUserId, "user ID"),
      planType: idClaims.planType ?? accessClaims.planType ?? optionalString(input.planType, "plan"),
    },
  }
}
