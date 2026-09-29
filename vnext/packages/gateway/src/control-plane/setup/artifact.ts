import { z } from "zod"

export const SETUP_VERSION = 1
export const MAX_SETUP_BODY_BYTES = 16_384
export const MAX_SETUP_SETTINGS_BYTES = 8_192
const encoder = new TextEncoder()

function validModel(value: string): boolean {
  if (encoder.encode(value).byteLength > 1024 || value.includes("\0")) return false
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false
  }
  return true
}

const model = z.string().min(1).refine(validModel).nullable().optional().default(null)
const effort = z.enum(["low", "medium", "high", "xhigh", "max"])
const claudeSettings = z.strictObject({
  model, smallModel: model, opusModel: model, sonnetModel: model, haikuModel: model,
  effort: effort.nullable().optional().default(null), context1m: z.boolean().optional().default(false),
})
const codexSettings = z.strictObject({ model })
const platform = z.enum(["posix", "windows"])
const claudeSelection = z.strictObject({ client: z.literal("claude"), platform, settings: claudeSettings })
const codexSelection = z.strictObject({ client: z.literal("codex"), platform, settings: codexSettings })
export const setupSelectionSchema = z.discriminatedUnion("client", [claudeSelection, codexSelection])
const expected = {
  expectedConfigurationRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  expectedArtifactDigest: z.string().regex(/^[0-9a-f]{64}$/),
}
export const setupMintSchema = z.discriminatedUnion("client", [claudeSelection.extend(expected), codexSelection.extend(expected)])
export type SetupSelection = z.infer<typeof setupSelectionSchema>
export type ClaudeEffort = z.infer<typeof effort>

export interface ClaudeArtifact {
  kind: "claude-settings"
  settings: {
    env: {
      ANTHROPIC_BASE_URL: string
      ANTHROPIC_AUTH_TOKEN: string
      ANTHROPIC_MODEL?: string
      ANTHROPIC_SMALL_FAST_MODEL?: string
      ANTHROPIC_DEFAULT_OPUS_MODEL?: string
      ANTHROPIC_DEFAULT_SONNET_MODEL?: string
      ANTHROPIC_DEFAULT_HAIKU_MODEL?: string
      ANTHROPIC_CUSTOM_HEADERS?: string
    }
    effortLevel?: ClaudeEffort
  }
}
export interface CodexArtifact {
  kind: "codex-config"
  config: {
    model?: string
    model_provider: "copilot_gateway"
    model_providers: { copilot_gateway: {
      name: "Copilot Gateway"
      base_url: string
      wire_api: "responses"
      supports_websockets: boolean
    } }
  }
  credential: { kind: "gateway-api-key"; value: string }
}
export type SetupArtifact = ClaudeArtifact | CodexArtifact
export interface SetupEnvelope {
  version: 1
  client: SetupSelection["client"]
  platform: SetupSelection["platform"]
  artifact: SetupArtifact
}
export interface SetupTouchedKey {
  target: "claude-settings" | "codex-config" | "codex-token" | "codex-runner"
  key: string
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  if (typeof value === "object" && value !== null) {
    return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}"
  }
  throw new Error("Invalid canonical value")
}

export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value)
  const hash = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")
}

export function canonicalSettings(selection: SetupSelection): string {
  const settings = canonicalJson(selection.settings)
  if (encoder.encode(settings).byteLength > MAX_SETUP_SETTINGS_BYTES) throw new Error("Setup settings are too large")
  return settings
}

export function buildSetupArtifact(selection: SetupSelection, gatewayKey: string, trustedOrigin: string, supportsWebSockets: boolean): SetupEnvelope {
  if (selection.client === "codex") return {
    version: SETUP_VERSION, client: selection.client, platform: selection.platform,
    artifact: {
      kind: "codex-config",
      config: {
        ...(selection.settings.model === null ? {} : { model: selection.settings.model }),
        model_provider: "copilot_gateway", model_providers: { copilot_gateway: {
          name: "Copilot Gateway", base_url: trustedOrigin + "/azure-api.codex/", wire_api: "responses", supports_websockets: supportsWebSockets,
        } },
      }, credential: { kind: "gateway-api-key", value: gatewayKey },
    },
  }
  const selected = selection.settings
  const env: ClaudeArtifact["settings"]["env"] = { ANTHROPIC_BASE_URL: trustedOrigin, ANTHROPIC_AUTH_TOKEN: gatewayKey }
  if (selected.model !== null) env.ANTHROPIC_MODEL = selected.model
  if (selected.smallModel !== null) env.ANTHROPIC_SMALL_FAST_MODEL = selected.smallModel
  if (selected.opusModel !== null) env.ANTHROPIC_DEFAULT_OPUS_MODEL = selected.opusModel
  if (selected.sonnetModel !== null) env.ANTHROPIC_DEFAULT_SONNET_MODEL = selected.sonnetModel
  if (selected.haikuModel !== null) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = selected.haikuModel
  const headers: string[] = []
  if (selected.context1m) headers.push("anthropic-beta: context-1m-2025-08-07")
  if (selected.effort !== null) headers.push("x-copilot-reasoning-effort: " + selected.effort)
  if (headers.length) env.ANTHROPIC_CUSTOM_HEADERS = headers.join("\n")
  return { version: SETUP_VERSION, client: selection.client, platform: selection.platform,
    artifact: { kind: "claude-settings", settings: { env, ...(selected.effort === null ? {} : { effortLevel: selected.effort }) } } }
}

export function redactArtifact(artifact: SetupArtifact): SetupArtifact {
  if (artifact.kind === "codex-config") return { ...artifact, credential: { ...artifact.credential, value: "[REDACTED]" } }
  return { ...artifact, settings: { ...artifact.settings, env: { ...artifact.settings.env, ANTHROPIC_AUTH_TOKEN: "[REDACTED]" } } }
}

export function touchedKeys(artifact: SetupArtifact): SetupTouchedKey[] {
  if (artifact.kind === "claude-settings") return [
    ...Object.keys(artifact.settings.env).map(key => ({ target: "claude-settings" as const, key: "/env/" + key })),
    ...(artifact.settings.effortLevel === undefined ? [] : [{ target: "claude-settings" as const, key: "/effortLevel" }]),
  ]
  return [
    ...(artifact.config.model === undefined ? [] : [{ target: "codex-config" as const, key: "/model" }]),
    { target: "codex-config", key: "/model_provider" },
    ...["name", "base_url", "wire_api", "supports_websockets", "auth"].map(key => ({ target: "codex-config" as const, key: "/model_providers/copilot_gateway/" + key })),
    { target: "codex-token", key: "/" }, { target: "codex-runner", key: "/" },
  ]
}
