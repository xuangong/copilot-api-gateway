/** Only trusted provider code or validated owner configuration may set this.
 * Remote model JSON is not a compatibility declaration authority. */
export interface OpaqueCompatibilityDeclaration {
  readonly version: 1
  readonly key: string
  readonly scope: "credential" | "owner"
}

/** Resolved after provider credential/model selection, never from a public alias. */
export interface AffinityExecutionTarget {
  readonly provider: string
  readonly upstreamId: string
  readonly upstreamIncarnation: string
  readonly credentialSubject: string
  readonly credentialRevision: string
  readonly model: string
  readonly compatibility?: OpaqueCompatibilityDeclaration
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new TypeError("Invalid opaque affinity metadata")
  return value as Record<string, unknown>
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.trim() !== value) throw new TypeError("Invalid opaque affinity identifier")
  return value
}

export function parseOpaqueCompatibilityDeclaration(value: unknown): OpaqueCompatibilityDeclaration {
  const data = record(value, ["version", "key", "scope"])
  if (data.version !== 1 || (data.scope !== "credential" && data.scope !== "owner")) throw new TypeError("Invalid opaque compatibility declaration")
  return Object.freeze({ version: 1, key: identifier(data.key), scope: data.scope })
}

export function parseAffinityExecutionTarget(value: unknown): AffinityExecutionTarget {
  const data = record(value, ["provider", "upstreamId", "upstreamIncarnation", "credentialSubject", "credentialRevision", "model", "compatibility"])
  return Object.freeze({ provider: identifier(data.provider), upstreamId: identifier(data.upstreamId),
    upstreamIncarnation: identifier(data.upstreamIncarnation), credentialSubject: identifier(data.credentialSubject),
    credentialRevision: identifier(data.credentialRevision), model: identifier(data.model),
    ...(data.compatibility === undefined ? {} : { compatibility: parseOpaqueCompatibilityDeclaration(data.compatibility) }),
  })
}

/** Caller must first restrict candidates to the authenticated owner/key policy. */
export function affinityTargetMatch(origin: AffinityExecutionTarget, candidate: AffinityExecutionTarget): "exact" | "compatible" | "incompatible" {
  const sameCredential = origin.provider === candidate.provider && origin.upstreamId === candidate.upstreamId
    && origin.upstreamIncarnation === candidate.upstreamIncarnation && origin.credentialSubject === candidate.credentialSubject
    && origin.credentialRevision === candidate.credentialRevision
  if (sameCredential && origin.model === candidate.model) return "exact"
  const a = origin.compatibility
  const b = candidate.compatibility
  if (a && b && a.version === b.version && a.key === b.key && a.scope === b.scope
    && (a.scope === "owner" || sameCredential)) return "compatible"
  return "incompatible"
}
