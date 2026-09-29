import { api } from "./client"
export type SetupPlatform = "posix" | "windows"
export type SetupEffort = "low" | "medium" | "high" | "xhigh" | "max"
export type SetupSelection = { client: "claude"; platform: SetupPlatform; settings: {
  model: string | null; smallModel: string | null; opusModel: string | null; sonnetModel: string | null; haikuModel: string | null; effort: SetupEffort | null; context1m: boolean
} } | { client: "codex"; platform: SetupPlatform; settings: { model: string | null } }
export interface SetupPreview { version: 1; client: SetupSelection["client"]; platform: SetupPlatform; configurationRevision: number; artifactDigest: string; redactedArtifact: unknown; touchedKeys: { target: string; key: string }[] }
export interface SetupLease { leaseId: string; leaseToken: string; expiresAt: string; artifactDigest: string }
const path = (keyId: string) => `/api/keys/${encodeURIComponent(keyId)}/setup`
export function previewSetup(keyId: string, selection: SetupSelection, signal?: AbortSignal): Promise<SetupPreview> {
  return api(path(keyId) + "/preview", { method: "POST", body: selection, signal })
}
export function mintSetup(keyId: string, selection: SetupSelection, preview: SetupPreview, signal?: AbortSignal): Promise<SetupLease> {
  return api(path(keyId) + "/leases", { method: "POST", body: { ...selection, expectedConfigurationRevision: preview.configurationRevision, expectedArtifactDigest: preview.artifactDigest }, signal })
}
export function revokeSetup(keyId: string, leaseId: string): Promise<{ ok: true }> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leaseId)) throw new Error("Invalid setup lease identifier")
  return api(path(keyId) + "/leases/" + encodeURIComponent(leaseId), { method: "DELETE" })
}
