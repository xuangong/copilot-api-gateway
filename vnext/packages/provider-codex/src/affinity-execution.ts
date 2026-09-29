import { parseAffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { CodexCredentialTarget } from "./credential-effects"

/** Revision is deliberately conservative: configuration changes invalidate
 * opaque state even when the account's imported credential is unchanged. */
export function codexAffinityTarget(credential: CodexCredentialTarget, model: string): AffinityExecutionTarget | undefined {
  if (credential.configurationGeneration === undefined || !credential.credentialRevision) return undefined
  return parseAffinityExecutionTarget({
    provider: "codex", upstreamId: credential.upstreamId,
    upstreamIncarnation: credential.rowIncarnation,
    credentialSubject: credential.accountId,
    credentialRevision: JSON.stringify([credential.configurationGeneration, credential.credentialRevision]),
    model,
  })
}

export class CodexAffinityChangedError extends Error {
  readonly code = "affinity_execution_changed"
  constructor() {
    super("Selected opaque-state execution target is no longer available")
    this.name = "CodexAffinityChangedError"
  }
}
