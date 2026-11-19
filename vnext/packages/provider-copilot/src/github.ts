/**
 * GitHub side of a Copilot account: host normalization, the management-plane
 * REST calls, and the GitHub → Copilot token exchange.
 *
 * A Copilot account lives on github.com or on a GHE.com data-residency tenant
 * (SUBDOMAIN.ghe.com). The tenant root is the web/OAuth origin and its REST API
 * is api.SUBDOMAIN.ghe.com:
 * https://github.com/github/docs/blob/d19b6951e376efb7bd26fd1c0369158d1641d139/content/admin/data-residency/about-github-enterprise-cloud-with-data-residency.md#L96-L104
 *
 * Owned here, not in the gateway, so every caller (device-flow login, quota,
 * account listing, token cache, dev auth) derives URLs the same way; the
 * gateway's tests/architecture/github-host-boundary.test.ts forbids spelling a
 * github.com origin anywhere else.
 */
import type { Fetcher } from "@vibe-core/upstream"
import type { AccountType } from "./account-type"
import { GITHUB_API_VERSION, USER_AGENT } from "./account-type"

export const GITHUB_DOTCOM_HOST = "github.com"

const GHE_TENANT_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ghe\.com$/

export function normalizeGitHubHost(value: string): string {
  const host = value.trim().toLowerCase()
  if (host === GITHUB_DOTCOM_HOST || GHE_TENANT_HOST.test(host)) return host
  throw new Error("GitHub host must be github.com or a tenant hostname ending in .ghe.com")
}

export function githubWebOrigin(host: string): string {
  return `https://${normalizeGitHubHost(host)}`
}

export function githubApiOrigin(host: string): string {
  const normalized = normalizeGitHubHost(host)
  return normalized === GITHUB_DOTCOM_HOST ? "https://api.github.com" : `https://api.${normalized}`
}

/**
 * Headers for the GitHub REST management plane, including the
 * /copilot_internal/v2/token exchange.
 *
 * Deliberately carries no editor-* headers: the real client does not send them
 * on this plane either, and sending them here would expose that one code path
 * builds both planes from the same header set.
 */
export function createGithubHeaders(token: string): Record<string, string> {
  return {
    authorization: `token ${token}`,
    accept: "application/json",
    "user-agent": USER_AGENT,
    "x-github-api-version": GITHUB_API_VERSION,
    "x-vscode-user-agent-library-version": "electron-fetch",
  }
}

/** `host` is optional because accounts stored before GHE support carry none; they are github.com accounts. */
async function githubApiFetch(path: string, token: string, host: string | undefined, fetcher: Fetcher): Promise<Response> {
  return await fetcher(`${githubApiOrigin(host || GITHUB_DOTCOM_HOST)}${path}`, { headers: createGithubHeaders(token) })
}

/** GET /user — the token's GitHub identity; a non-2xx means the token is unusable. */
export function fetchGithubUser(token: string, host: string | undefined, fetcher: Fetcher = fetch): Promise<Response> {
  return githubApiFetch("/user", token, host, fetcher)
}

/** GET /copilot_internal/user — the Copilot plan and quota snapshot. */
export function fetchCopilotUser(token: string, host: string | undefined, fetcher: Fetcher = fetch): Promise<Response> {
  return githubApiFetch("/copilot_internal/user", token, host, fetcher)
}

export interface CopilotTokenResponse {
  expires_at: number
  refresh_in: number
  token: string
  /** `api` is the data-plane host GitHub routes this account to (per tenant for GHE.com). */
  endpoints?: { api?: string; "origin-tracker"?: string; proxy?: string; telemetry?: string }
}

/**
 * GET /copilot_internal/v2/token — pure exchange, no caching or retry.
 * GET, not POST: POST answers 404 (matches VS Code Copilot Chat).
 */
export async function exchangeCopilotToken(githubToken: string, host: string | undefined, fetcher: Fetcher = fetch): Promise<CopilotTokenResponse> {
  const resp = await githubApiFetch("/copilot_internal/v2/token", githubToken, host, fetcher)
  if (!resp.ok) {
    const text = await resp.text().catch(() => "")
    throw new Error(`Failed to exchange GitHub token (${resp.status}): ${text}`)
  }
  return (await resp.json()) as CopilotTokenResponse
}

/**
 * The account's Copilot plan from /copilot_internal/user, or "individual" when
 * it cannot be read. Best-effort metadata: on GHE.com and whenever the token
 * exchange advertises `endpoints.api`, the data-plane host comes from that
 * instead, so a wrong plan only changes the fallback base URL.
 */
export async function detectCopilotAccountType(githubToken: string, host: string | undefined, fetcher: Fetcher = fetch): Promise<AccountType> {
  try {
    const resp = await fetchCopilotUser(githubToken, host, fetcher)
    if (!resp.ok) return "individual"
    const plan = ((await resp.json()) as { copilot_plan?: unknown }).copilot_plan
    return plan === "business" || plan === "enterprise" ? plan : "individual"
  } catch {
    return "individual"
  }
}

// Device-flow OAuth. GitHub's device flow takes the public client id in the
// body and needs no secret; GHE.com tenants accept the same Copilot client id
// on their own origin.
// https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#device-flow
export const GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98"
export const GITHUB_SCOPES = "read:user"

/** POST /login/device/code on the account's GitHub host. The caller relays the JSON body. */
export async function requestGithubDeviceCode(host: string, fetcher: Fetcher = fetch): Promise<Response> {
  return await fetcher(`${githubWebOrigin(host)}/login/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: GITHUB_SCOPES }),
  })
}

export interface GithubDeviceTokenPoll {
  access_token?: string
  error?: string
  error_description?: string
  interval?: number
}

/**
 * POST /login/oauth/access_token for a device code. GitHub reports the
 * documented device-flow errors (authorization_pending, slow_down, …) in the
 * body with HTTP 200, so the body is returned as-is for the caller to branch on.
 */
export async function pollGithubDeviceToken(host: string, deviceCode: string, fetcher: Fetcher = fetch): Promise<GithubDeviceTokenPoll> {
  const resp = await fetcher(`${githubWebOrigin(host)}/login/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_id: GITHUB_CLIENT_ID,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  })
  return (await resp.json()) as GithubDeviceTokenPoll
}
