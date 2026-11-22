// packages/gateway/src/quota-balance/credential.ts
export interface CopilotCredential { token: string; host: string | undefined }

/** Only Copilot upstreams have a quota this gateway can read: is this row a Copilot row? */
export const isCopilotUpstream = (upstream: { provider: string } | null | undefined): boolean => upstream?.provider === "copilot"

/** The stored GitHub credential of a Copilot upstream row (`config.githubToken`, `config.githubHost`), or null. Never log or return it to a client. */
export function copilotCredentialOf(upstream: { provider: string; config: Record<string, unknown> } | null | undefined): CopilotCredential | null {
  if (!upstream || !isCopilotUpstream(upstream)) return null
  const { githubToken, githubHost } = upstream.config
  return typeof githubToken === "string" && githubToken !== "" ? { token: githubToken, host: typeof githubHost === "string" ? githubHost : undefined } : null
}
