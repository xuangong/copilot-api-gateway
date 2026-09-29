import { expect, test } from "bun:test"
import { parseOpaqueCompatibilityDeclaration, parseAffinityExecutionTarget, affinityTargetMatch } from "../opaque-affinity.ts"

const target = { provider: "custom", upstreamId: "up", upstreamIncarnation: "inc", credentialSubject: "subject", credentialRevision: "rev", model: "raw-model" }
test("compatibility declarations are explicit, versioned and strictly validated", () => {
  expect(parseOpaqueCompatibilityDeclaration({ version: 1, key: "declared-v1", scope: "owner" })).toEqual({ version: 1, key: "declared-v1", scope: "owner" })
  for (const input of [{ key: "openai" }, { version: 2, key: "x", scope: "owner" }, { version: 1, key: "", scope: "owner" }, { version: 1, key: "x", scope: "global" }, { version: 1, key: "x", scope: "owner", arbitrary: true }]) expect(() => parseOpaqueCompatibilityDeclaration(input)).toThrow()
  expect(() => parseAffinityExecutionTarget({ ...target, requestedAlias: "alias" })).toThrow()
})
test("exact identity rejects replacements and aliases; widening requires matching declarations on both targets", () => {
  expect(affinityTargetMatch(target, target)).toBe("exact")
  for (const key of ["provider", "upstreamId", "upstreamIncarnation", "credentialSubject", "credentialRevision", "model"] as const) expect(affinityTargetMatch(target, { ...target, [key]: "changed" })).toBe("incompatible")
  const compatibility = { version: 1 as const, key: "provider-owned-contract-v1", scope: "credential" as const }
  expect(affinityTargetMatch({ ...target, compatibility }, { ...target, model: "other", compatibility })).toBe("compatible")
  expect(affinityTargetMatch({ ...target, compatibility }, { ...target, model: "other" })).toBe("incompatible")
  expect(affinityTargetMatch({ ...target, compatibility }, { ...target, credentialRevision: "new", compatibility })).toBe("incompatible")
})
