/**
 * GitHub management-plane calls for a Copilot account, addressed to the
 * account's own GitHub host: github.com → api.github.com, a GHE.com
 * data-residency tenant SUBDOMAIN.ghe.com → api.SUBDOMAIN.ghe.com.
 *
 * Every caller goes through here (or `githubApiOrigin`) instead of spelling a
 * URL, so a tenant token can never be sent to github.com by a route that
 * forgot about GHE. tests/architecture/github-host-boundary.test.ts enforces
 * that no other source file hardcodes a github.com origin.
 *
 * `host` is optional because accounts stored before GHE support carry none;
 * they are github.com accounts.
 */
import type { Fetcher } from '@vibe-core/upstream'
import { createGithubHeaders } from './config/constants.ts'
import { githubApiOrigin, GITHUB_DOTCOM_HOST } from './config/github-host.ts'

function githubApiFetch(path: string, token: string, host: string | undefined, fetcher: Fetcher): Promise<Response> {
  return fetcher(`${githubApiOrigin(host || GITHUB_DOTCOM_HOST)}${path}`, {
    headers: createGithubHeaders(token),
  })
}

/** GET /user — the token's GitHub identity; a non-2xx means the token is unusable. */
export function fetchGithubUser(token: string, host: string | undefined, fetcher: Fetcher = fetch): Promise<Response> {
  return githubApiFetch('/user', token, host, fetcher)
}

/** GET /copilot_internal/user — the Copilot plan and quota snapshot. */
export function fetchCopilotUser(token: string, host: string | undefined, fetcher: Fetcher = fetch): Promise<Response> {
  return githubApiFetch('/copilot_internal/user', token, host, fetcher)
}
