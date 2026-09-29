import { isAbsolute } from "node:path"
import { fail, sha256, validateEnvelope } from "./contract"
import type { Client, Envelope, Target } from "./contract"
import { targetPath } from "./paths"
import { editJson } from "./json"
import { editToml } from "./toml"
export interface CurrentFile { kind: Target; bytes: Uint8Array | null; expectedSha256: string | null }
export interface PlannedFile { kind: Target; bytes: Uint8Array; expectedSha256: string | null; writtenSha256: string }
export interface SetupPlan { client: Client; allowedHome: string; artifactDigest: string; files: PlannedFile[]; touchedKeys: { target: Target; key: string }[]; redactedDiff: string }
export interface Installation { allowedHome: string; bunExecutable: string; runnerBytes: Uint8Array }
const decode = (value: Uint8Array | null): string | null => {
  try { return value === null ? null : new TextDecoder("utf-8", { fatal: true }).decode(value) } catch { return fail("encoding", "Configuration must be valid UTF-8") }
}
export async function planSetup(input: { artifact: Envelope; currentFiles: CurrentFile[]; installation: Installation }): Promise<SetupPlan> {
  const envelope = await validateEnvelope(input.artifact)
  const { allowedHome, bunExecutable, runnerBytes } = input.installation
  if (!isAbsolute(allowedHome) || !isAbsolute(bunExecutable) || runnerBytes.length === 0 || runnerBytes.length > 4_000_000) fail("installation", "Invalid local installation inputs")
  const required: Target[] = envelope.client === "claude" ? ["claude-settings"] : ["codex-runner", "codex-token", "codex-config"]
  if (input.currentFiles.length !== required.length || new Set(input.currentFiles.map(file => file.kind)).size !== required.length || input.currentFiles.some(file => !required.includes(file.kind))) fail("plan", "Unexpected setup file snapshot")
  const files: PlannedFile[] = []
  for (const kind of required) {
    const original = input.currentFiles.find(file => file.kind === kind)
    if (!original || (original.bytes === null ? original.expectedSha256 !== null : await sha256(original.bytes) !== original.expectedSha256)) fail("digest", "Current file snapshot digest mismatch")
    let bytes: Uint8Array
    if (kind === "codex-runner") bytes = new Uint8Array(runnerBytes)
    else if (kind === "codex-token" && envelope.artifact.kind === "codex-config") bytes = new TextEncoder().encode(envelope.artifact.credential.value + "\n")
    else if (kind === "codex-config" && envelope.artifact.kind === "codex-config") bytes = new TextEncoder().encode(editToml(decode(original.bytes), envelope.artifact, {
      command: bunExecutable, args: [targetPath(allowedHome, "codex-runner"), "credential-read", targetPath(allowedHome, "codex-token")],
    }))
    else if (kind === "claude-settings" && envelope.artifact.kind === "claude-settings") bytes = new TextEncoder().encode(editJson(decode(original.bytes), envelope.artifact))
    else return fail("plan", "Mismatched setup target")
    files.push({ kind, bytes, expectedSha256: original.expectedSha256, writtenSha256: await sha256(bytes) })
  }
  const touchedKeys: SetupPlan["touchedKeys"] = envelope.artifact.kind === "claude-settings" ? [
    ...Object.keys(envelope.artifact.settings.env).map(key => ({ target: "claude-settings" as const, key: "/env/" + key })),
    ...(envelope.artifact.settings.effortLevel === undefined ? [] : [{ target: "claude-settings" as const, key: "/effortLevel" }]),
  ] : [
    ...(envelope.artifact.config.model === undefined ? [] : [{ target: "codex-config" as const, key: "/model" }]),
    { target: "codex-config", key: "/model_provider" },
    ...["name", "base_url", "wire_api", "supports_websockets", "auth"].map(key => ({ target: "codex-config" as const, key: "/model_providers/copilot_gateway/" + key })),
    { target: "codex-token", key: "/" }, { target: "codex-runner", key: "/" },
  ]
  const pointerValue = (bytes: Uint8Array | null, target: Target, key: string, previous: boolean): unknown => {
    if (bytes === null) return "[UNSET]"
    if (target === "codex-token" || key === "/env/ANTHROPIC_AUTH_TOKEN") return "[REDACTED]"
    if (target === "codex-runner") return "[STATIC RUNNER]"
    const text = decode(bytes)
    if (text === null) return "[UNSET]"
    let value: unknown = target === "claude-settings" ? JSON.parse(text) : Bun.TOML.parse(text)
    for (const part of key.slice(1).split("/")) {
      if (value === null || typeof value !== "object") return "[UNSET]"
      value = (value as Record<string, unknown>)[part]
    }
    if (value === undefined) return "[UNSET]"
    // Existing custom headers are arbitrary private input; only validated new headers are displayable.
    return previous && key === "/env/ANTHROPIC_CUSTOM_HEADERS" ? "[REDACTED]" : value
  }
  const changes = touchedKeys.map(({ target, key }) => ({ target, key,
    before: pointerValue(input.currentFiles.find(file => file.kind === target)?.bytes ?? null, target, key, true),
    after: pointerValue(files.find(file => file.kind === target)?.bytes ?? null, target, key, false),
  }))
  return { client: envelope.client, allowedHome, files, touchedKeys, artifactDigest: envelope.artifactDigest,
    redactedDiff: "Managed changes (other values preserved):\n" + JSON.stringify(changes, null, 2) }
}
