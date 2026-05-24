import { OAUTH_STATE_TTL_MS, EMAIL_CODE_TTL_MS, MAGIC_TOKEN_TTL_MS } from "./utils"

// KV-backed state store for CFW; falls back to in-memory Maps for local.
let oauthKV: KVNamespace | null = null
export function initOAuthKV(kv: KVNamespace) { oauthKV = kv }

// === Google OAuth state ===
const oauthStateStore = new Map<string, { inviteCode?: string; createdAt: number }>()

function cleanupOAuthStates() {
  const now = Date.now()
  for (const [key, val] of oauthStateStore) {
    if (now - val.createdAt > OAUTH_STATE_TTL_MS) oauthStateStore.delete(key)
  }
}

export async function saveOAuthState(state: string, data: { inviteCode?: string; createdAt: number }) {
  if (oauthKV) {
    await oauthKV.put(`oauth_state:${state}`, JSON.stringify(data), { expirationTtl: 600 })
  } else {
    cleanupOAuthStates()
    oauthStateStore.set(state, data)
  }
}

export async function getOAuthState(state: string): Promise<{ inviteCode?: string; createdAt: number } | null> {
  if (oauthKV) {
    const val = await oauthKV.get(`oauth_state:${state}`)
    if (val) {
      await oauthKV.delete(`oauth_state:${state}`)
      return JSON.parse(val)
    }
    return null
  }
  const data = oauthStateStore.get(state) ?? null
  if (data) oauthStateStore.delete(state)
  return data
}

// === Email verification code (for registration) ===
type EmailCodeEntry = { code: string; inviteCode: string; name: string; password: string; createdAt: number }
const emailCodeStore = new Map<string, EmailCodeEntry>()

export async function saveEmailCode(email: string, data: { code: string; inviteCode: string; name: string; password: string }) {
  const entry = { ...data, createdAt: Date.now() }
  if (oauthKV) {
    await oauthKV.put(`email_code:${email}`, JSON.stringify(entry), { expirationTtl: 600 })
  } else {
    const now = Date.now()
    for (const [k, v] of emailCodeStore) {
      if (now - v.createdAt > EMAIL_CODE_TTL_MS) emailCodeStore.delete(k)
    }
    emailCodeStore.set(email, entry)
  }
}

export async function getEmailCode(email: string): Promise<{ code: string; inviteCode: string; name: string; password: string } | null> {
  if (oauthKV) {
    const val = await oauthKV.get(`email_code:${email}`)
    if (val) {
      await oauthKV.delete(`email_code:${email}`)
      return JSON.parse(val)
    }
    return null
  }
  const data = emailCodeStore.get(email) ?? null
  if (data) {
    emailCodeStore.delete(email)
    if (Date.now() - data.createdAt > EMAIL_CODE_TTL_MS) return null
  }
  return data
}

// === Magic link token (for login) ===
const magicTokenStore = new Map<string, { email: string; createdAt: number }>()

export async function saveMagicToken(token: string, email: string) {
  if (oauthKV) {
    await oauthKV.put(`magic_token:${token}`, JSON.stringify({ email, createdAt: Date.now() }), { expirationTtl: 600 })
  } else {
    const now = Date.now()
    for (const [k, v] of magicTokenStore) {
      if (now - v.createdAt > MAGIC_TOKEN_TTL_MS) magicTokenStore.delete(k)
    }
    magicTokenStore.set(token, { email, createdAt: Date.now() })
  }
}

export async function getMagicToken(token: string): Promise<string | null> {
  if (oauthKV) {
    const val = await oauthKV.get(`magic_token:${token}`)
    if (val) {
      await oauthKV.delete(`magic_token:${token}`)
      const data = JSON.parse(val) as { email: string }
      return data.email
    }
    return null
  }
  const data = magicTokenStore.get(token) ?? null
  if (data) {
    magicTokenStore.delete(token)
    if (Date.now() - data.createdAt > MAGIC_TOKEN_TTL_MS) return null
    return data.email
  }
  return null
}
