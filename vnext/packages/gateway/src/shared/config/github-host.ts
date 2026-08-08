/**
 * GitHub host normalization for github.com and GHE-with-data-residency
 * tenants (SUBDOMAIN.ghe.com; REST at api.SUBDOMAIN.ghe.com).
 *
 * See: github/docs @ d19b6951 — content/admin/data-residency/about-github-enterprise-cloud-with-data-residency.md
 */
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
