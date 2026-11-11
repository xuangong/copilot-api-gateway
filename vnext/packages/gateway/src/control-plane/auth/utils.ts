/**
 * Auth shared utils — Week 5b port of src/routes/auth/utils.ts.
 *
 * Cookie / TTL constants, generator helpers, and the error HTML page used by
 * email magic links + OAuth callbacks. Pure functions; no I/O.
 */
import { createGithubHeaders } from '../../shared/config/constants.ts'
import { githubApiOrigin, GITHUB_DOTCOM_HOST } from '../../shared/config/github-host.ts'
import type { Fetcher } from '@vibe-core/upstream'

export const GITHUB_SCOPES = 'read:user'
export const SESSION_TTL_DAYS = 30
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000
export const MAGIC_TOKEN_TTL_MS = 10 * 60 * 1000

export function publicOrigin(req: Request, fallback: URL): string {
  const h = req.headers
  const proto =
    h.get('x-forwarded-proto')?.split(',')[0]?.trim() ||
    fallback.protocol.replace(':', '')
  const host =
    h.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    h.get('host') ||
    fallback.host
  return `${proto}://${host}`
}

export function generateOAuthState(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function generateSessionToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return 'ses_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function generateInviteCode(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 10)
    .toUpperCase()
}

export function generateVerificationCode(): string {
  const bytes = new Uint8Array(3)
  crypto.getRandomValues(bytes)
  return String(
    ((bytes[0]! << 16) | (bytes[1]! << 8) | bytes[2]!) % 1000000,
  ).padStart(6, '0')
}

export function generateMagicLinkToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]!)
}

// `message` reaches here from OAuth callback query params and raw upstream
// response bodies, so it is attacker-influenced and must be escaped.
export function errorPage(message: string): string {
  // Colours mirror the dashboard tokens (apps/dashboard/src/styles.css); the
  // saved theme is applied before paint, falling back to the system setting.
  return `<!DOCTYPE html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Error</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<script>(function(){var t=null;try{t=localStorage.getItem('theme')}catch(e){}if(!t)t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';document.documentElement.setAttribute('data-theme',t)})()</script>
<style>:root,[data-theme=light]{color-scheme:light;--bg:#fafafa;--panel:#fff;--border:#ebebeb;--fg:#0a0a0a;--fg-muted:#525252;--danger-text:#b91c1c;--brand:#7c3aed;--brand-hover:#6d28d9;--brand-text:#7c3aed}
[data-theme=dark]{color-scheme:dark;--bg:#0a0a0a;--panel:#111;--border:#262626;--fg:#ededed;--fg-muted:#a1a1a1;--danger-text:#f87171;--brand:#7c3aed;--brand-hover:#6d28d9;--brand-text:#a78bfa}
body{font-family:Geist,ui-sans-serif,system-ui,sans-serif;font-size:14px;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:1rem;box-sizing:border-box;background:var(--bg);color:var(--fg);-webkit-font-smoothing:antialiased}
.card{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:2rem;max-width:400px;width:100%;box-sizing:border-box;text-align:center}
h2{color:var(--danger-text);font-size:18px;font-weight:600;margin:0 0 .75rem}p{color:var(--fg-muted);line-height:1.5;margin:0 0 1.5rem;overflow-wrap:anywhere}
a{display:inline-block;padding:.5rem 1.25rem;background:var(--brand);color:#fff;border-radius:6px;font-weight:500;text-decoration:none;transition:background-color .15s}
a:hover{background:var(--brand-hover)}a:focus-visible{outline:2px solid var(--brand-text);outline-offset:2px}</style></head>
<body><div class="card" role="main"><h2>Error</h2><p>${escapeHtml(message)}</p><a href="/">Back to Login</a></div></body></html>`
}

export async function detectAccountType(
  githubToken: string,
  githubHost: string = GITHUB_DOTCOM_HOST,
  fetcher: Fetcher = fetch,
): Promise<string> {
  try {
    const resp = await fetcher(`${githubApiOrigin(githubHost)}/copilot_internal/user`, {
      headers: createGithubHeaders(githubToken),
    })
    if (!resp.ok) return 'individual'
    const data = (await resp.json()) as { copilot_plan?: string }
    if (
      data.copilot_plan &&
      ['individual', 'business', 'enterprise'].includes(data.copilot_plan)
    ) {
      return data.copilot_plan
    }
    return 'individual'
  } catch {
    // Deliberately swallowed, unlike the other proxy-egress paths in this
    // work item, which fail loud. copilot_internal/user is best-effort
    // metadata: a wrong value only changes the derived default base URL.
    // But it is written once when the account is added and never recomputed,
    // and endpoints.api only overrides the derived default where the session
    // is built from the upstream token exchange (copilot-token-cache.ts:99 →
    // provider-copilot/plugin.ts). The session-auth fallback drops
    // apiEndpoint (session-auth.ts:117, registry.ts:61), so there a
    // misclassified tenant keeps the wrong base URL until it is re-added.
    // Both production call sites — the device-flow poll and the paste-token
    // route in github-routes.ts — now pass the request's resolved fetcher, so
    // on a proxy-only host the probe reaches GitHub instead of failing here.
    // The `fetcher = fetch` default is left reachable only from tests
    // (control-plane-auth-utils.test.ts). What this swallow still hides is a
    // failure of the passed fetcher itself: a dead proxy chain yields
    // 'individual', so a business tenant is still misclassified whenever the
    // egress it was given is broken.
    return 'individual'
  }
}

export function cookieFlags(url: URL, httpOnly: boolean): string {
  const isSecure = url.protocol === 'https:'
  const securePart = isSecure ? '; Secure' : ''
  const httpOnlyPart = httpOnly ? '; HttpOnly' : ''
  return `Path=/${httpOnlyPart}; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS * 24 * 60 * 60}${securePart}`
}
