import { parseAffinityExecutionTarget, type AffinityExecutionTarget } from "@vibe-llm/provider-llm"
import type { UpstreamWriteTarget } from "@vibe-core/upstream-repo"
import type { ClaudeCodeCredentialTarget } from "./credential-effects"

export interface ClaudeCodeExecutionAuthority extends UpstreamWriteTarget {
  upstreamId: string
  provider: "claude-code"
  credentialGeneration?: number
  configurationGeneration?: number
  accountUuid: string
  tokenKind: "oauth" | "setup-token"
}

export class ClaudeCodeAffinityChangedError extends Error {
  readonly code = "affinity_execution_changed"
  constructor() {
    super("Selected Claude Code execution target is no longer available")
    this.name = "ClaudeCodeAffinityChangedError"
  }
}

export function assertClaudeCodeExecutionAuthority(expected: ClaudeCodeExecutionAuthority, current: ClaudeCodeCredentialTarget): void {
  if (current.upstreamId !== expected.upstreamId || current.provider !== expected.provider
    || current.rowIncarnation !== expected.rowIncarnation || current.ownerId !== expected.ownerId
    || current.accountUuid !== expected.accountUuid || current.tokenKind !== expected.tokenKind
    || current.credentialGeneration !== expected.credentialGeneration
    || current.configurationGeneration !== expected.configurationGeneration) throw new ClaudeCodeAffinityChangedError()
}

export function claudeCodeAffinityTarget(credential: ClaudeCodeCredentialTarget, model: string): AffinityExecutionTarget | undefined {
  const { configurationGeneration, credentialGeneration } = credential
  if (configurationGeneration === undefined || !Number.isSafeInteger(configurationGeneration) || configurationGeneration < 0
    || credentialGeneration === undefined || !Number.isSafeInteger(credentialGeneration) || credentialGeneration < 0) return undefined
  return parseAffinityExecutionTarget({
    provider: "claude-code", upstreamId: credential.upstreamId, upstreamIncarnation: credential.rowIncarnation,
    credentialSubject: `upstream:${credential.upstreamId}`,
    credentialRevision: JSON.stringify([configurationGeneration, credentialGeneration]), model,
  })
}
