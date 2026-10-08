import { resolve } from "node:path"
import type { FileIdentity } from "../../2026-10-02-workerd-deployed-comparison/harness/manifest"
import type { MatchedContext } from "./coordinator"

/** Bind observed executable bytes to the requested frozen B/R arm without reading A. */
export function verifyMatchedBundleIdentity(context: MatchedContext, arm: string, actual: unknown): FileIdentity {
  if (arm !== "B" && arm !== "R") throw new Error("Matched bundle identity requires arm B or R")
  const bundle = arm === "B" ? context.manifest.variants.B.bundle : context.reference.bundle
  const artifacts = context.manifest.artifacts.filter(file => file.path === resolve(bundle))
  if (artifacts.length !== 1) throw new Error(`Matched ${arm} bundle identity requires one frozen artifact`)
  const expected = artifacts[0]
  if (!expected) throw new Error("Missing frozen bundle artifact")
  const observed = actual as Partial<FileIdentity> | null | undefined
  if (!Number.isSafeInteger(expected.bytes) || expected.bytes < 0 || !/^[a-f0-9]{64}$/.test(expected.sha256) || !observed || observed.path !== expected.path || observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256) throw new Error(`Matched ${arm} bundle identity mismatch`)
  return expected
}
