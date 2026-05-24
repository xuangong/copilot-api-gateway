import { createGithubHeaders } from "~/config/constants"
import type { Env } from "~/lib/state"

export const GITHUB_SCOPES = "read:user"
export const SESSION_TTL_DAYS = 30
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000
export const MAGIC_TOKEN_TTL_MS = 10 * 60 * 1000

export interface AuthContext {
  env: Env
  isAdmin?: boolean
  isUser?: boolean
  userId?: string
}

// Resolve the public-facing origin when the server sits behind a TLS-terminating
// proxy (Cloudflare, Nginx). Google requires an exact string match against the
// registered redirect_uri, so we must reflect the scheme/host the browser used.
export function publicOrigin(req: Request, fallback: URL): string {
  const h = req.headers
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || fallback.protocol.replace(":", "")
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || fallback.host
  return `${proto}://${host}`
}

export function generateOAuthState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return "ses_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function generateInviteCode(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10).toUpperCase()
}

export function generateVerificationCode(): string {
  const bytes = new Uint8Array(3)
  crypto.getRandomValues(bytes)
  return String(((bytes[0]! << 16) | (bytes[1]! << 8) | bytes[2]!) % 1000000).padStart(6, "0")
}

export function generateMagicLinkToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

export function errorPage(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error</title><style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:2rem;max-width:400px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center}
h2{color:#d32f2f;margin:0 0 1rem}p{color:#666;margin:0 0 1.5rem}
a{display:inline-block;padding:.5rem 1.5rem;background:#1a73e8;color:#fff;border-radius:6px;text-decoration:none}</style></head>
<body><div class="card"><h2>Error</h2><p>${message}</p><a href="/">Back to Login</a></div></body></html>`
}

export async function detectAccountType(githubToken: string): Promise<string> {
  try {
    const resp = await fetch("https://api.github.com/copilot_internal/user", {
      headers: createGithubHeaders(githubToken),
    })
    if (!resp.ok) return "individual"
    const data = (await resp.json()) as { copilot_plan?: string }
    if (data.copilot_plan && ["individual", "business", "enterprise"].includes(data.copilot_plan)) {
      return data.copilot_plan
    }
    return "individual"
  } catch {
    return "individual"
  }
}

export function cookieFlags(url: URL, httpOnly: boolean): string {
  const isSecure = url.protocol === "https:"
  const securePart = isSecure ? "; Secure" : ""
  const httpOnlyPart = httpOnly ? "; HttpOnly" : ""
  return `Path=/${httpOnlyPart}; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
}
