// Imported JWT claims are decode-only metadata. Upstream authentication is
// decided by OpenAI; these claims never authorize a gateway user or owner.
export interface CodexTokenClaims {
  email: string | null
  chatgptAccountId: string | null
  chatgptUserId: string | null
  planType: string | null
  expiresAt: number | null
}

export interface CodexIdTokenIdentity {
  email: string
  chatgptAccountId: string
  chatgptUserId: string
  planType: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const optionalClaim = (source: Record<string, unknown>, key: string, label: string): string | null => {
  const value = source[key]
  if (value === undefined || value === null) return null
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} has invalid ${key} claim`)
  return value
}

const decodePayload = (token: string, label: string): Record<string, unknown> => {
  const segments = token.split(".")
  if (segments.length !== 3) throw new TypeError(`${label} is not a JWT`)
  const segment = segments[1]
  if (!segment || !/^[A-Za-z0-9_-]+$/.test(segment)) throw new TypeError(`${label} has invalid JWT payload`)
  let payload: unknown
  try {
    const standard = segment.replace(/-/g, "+").replace(/_/g, "/")
    const binary = atob(standard + "=".repeat((4 - standard.length % 4) % 4))
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
  } catch {
    throw new TypeError(`${label} has invalid JWT payload`)
  }
  if (!isRecord(payload)) throw new TypeError(`${label} has invalid JWT payload`)
  return payload
}

export const parseCodexTokenClaims = (token: string, label = "token"): CodexTokenClaims => {
  const payload = decodePayload(token, label)
  const rawAuth = payload["https://api.openai.com/auth"]
  const rawProfile = payload["https://api.openai.com/profile"]
  if (rawAuth !== undefined && !isRecord(rawAuth)) throw new TypeError(`${label} has invalid auth claim`)
  if (rawProfile !== undefined && !isRecord(rawProfile)) throw new TypeError(`${label} has invalid profile claim`)
  const auth = isRecord(rawAuth) ? rawAuth : {}
  const profile = isRecord(rawProfile) ? rawProfile : {}
  const rawExpiry = payload.exp
  let expiresAt: number | null = null
  if (rawExpiry !== undefined && rawExpiry !== 0) {
    if (typeof rawExpiry !== "number" || !Number.isFinite(rawExpiry) || rawExpiry < 0 || !Number.isFinite(rawExpiry * 1000)) {
      throw new TypeError(`${label} has invalid exp claim`)
    }
    expiresAt = rawExpiry * 1000
  }
  return {
    email: optionalClaim(profile, "email", label) ?? optionalClaim(payload, "email", label),
    chatgptAccountId: optionalClaim(auth, "chatgpt_account_id", label),
    chatgptUserId: optionalClaim(auth, "chatgpt_user_id", label),
    planType: optionalClaim(auth, "chatgpt_plan_type", label),
    expiresAt,
  }
}

export const tryParseCodexAccessTokenClaims = (accessToken: string): CodexTokenClaims | null =>
  accessToken.split(".").length === 3 ? parseCodexTokenClaims(accessToken, "access_token") : null

// OAuth callback tokens must still carry the complete identity that the
// existing callback has always required.
export const parseCodexIdTokenClaims = (idToken: string): CodexIdTokenIdentity => {
  const claims = parseCodexTokenClaims(idToken, "id_token")
  if (!claims.email || !claims.chatgptAccountId || !claims.chatgptUserId || !claims.planType) {
    throw new TypeError("id_token is missing required identity claims")
  }
  return {
    email: claims.email,
    chatgptAccountId: claims.chatgptAccountId,
    chatgptUserId: claims.chatgptUserId,
    planType: claims.planType,
  }
}
