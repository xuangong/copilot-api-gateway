export type Client = "claude" | "codex"
export type Platform = "posix" | "windows"
export type Target = "claude-settings" | "codex-config" | "codex-token" | "codex-runner"
export type Effort = "low" | "medium" | "high" | "xhigh" | "max"
export interface ClaudeArtifact { kind: "claude-settings"; settings: { env: Record<string, string>; effortLevel?: Effort } }
export interface CodexArtifact {
  kind: "codex-config"
  config: { model?: string; model_provider: "copilot_gateway"; model_providers: { copilot_gateway: {
    name: "Copilot Gateway"; base_url: string; wire_api: "responses"; supports_websockets: boolean
  } } }
  credential: { kind: "gateway-api-key"; value: string }
}
export interface Envelope { version: 1; client: Client; platform: Platform; artifact: ClaudeArtifact | CodexArtifact; artifactDigest: string }
export class SetupError extends Error {
  constructor(public code: string, message: string) { super(message) }
}
export function fail(code: string, message: string): never { throw new SetupError(code, message) }
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("artifact", "Invalid setup artifact")
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail("artifact", "Invalid setup artifact fields")
}
export function validString(value: unknown, maximum = 1024): value is string {
  return typeof value === "string" && value.length > 0 && new TextEncoder().encode(value).length <= maximum && !value.includes("\0") && value.isWellFormed()
}
export const validCredential = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value)
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]"
  if (value && typeof value === "object") return "{" + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item)).join(",") + "}"
  return fail("artifact", "Invalid canonical value")
}
export async function sha256(bytes: string | Uint8Array): Promise<string> {
  const value = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), byte => byte.toString(16).padStart(2, "0")).join("")
}
export function originUrl(value: unknown): string {
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\@\s]+$/.test(value)) return fail("origin", "Invalid gateway origin")
  try {
    const url = new URL(value)
    if (url.origin !== value || url.username || url.password) return fail("origin", "Invalid gateway origin")
    return url.origin
  } catch { return fail("origin", "Invalid gateway origin") }
}
const modelKeys = ["ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]
const efforts = ["low", "medium", "high", "xhigh", "max"]
export async function validateEnvelope(input: unknown, expectedOrigin?: string): Promise<Envelope> {
  const envelope = record(input)
  keys(envelope, ["version", "client", "platform", "artifact", "artifactDigest"])
  if (envelope.version !== 1 || typeof envelope.client !== "string" || !["claude", "codex"].includes(envelope.client) || typeof envelope.platform !== "string" || !["posix", "windows"].includes(envelope.platform) || typeof envelope.artifactDigest !== "string" || !/^[0-9a-f]{64}$/.test(envelope.artifactDigest)) fail("artifact", "Unsupported setup envelope")
  const artifact = record(envelope.artifact)
  let origin: string
  if (envelope.client === "claude") {
    keys(artifact, ["kind", "settings"])
    if (artifact.kind !== "claude-settings") fail("artifact", "Invalid client artifact")
    const settings = record(artifact.settings)
    keys(settings, ["env"], ["effortLevel"])
    const env = record(settings.env)
    keys(env, ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"], [...modelKeys, "ANTHROPIC_CUSTOM_HEADERS"])
    origin = originUrl(env.ANTHROPIC_BASE_URL)
    if (!validCredential(env.ANTHROPIC_AUTH_TOKEN)) fail("credential", "Invalid gateway credential")
    for (const key of modelKeys) if (key in env && !validString(env[key])) fail("artifact", "Invalid model override")
    if ("effortLevel" in settings && (typeof settings.effortLevel !== "string" || !efforts.includes(settings.effortLevel))) fail("artifact", "Invalid effort override")
    const context = "anthropic-beta: context-1m-2025-08-07"
    const effort = settings.effortLevel === undefined ? undefined : "x-copilot-reasoning-effort: " + settings.effortLevel
    const permitted = effort ? [effort, context + "\n" + effort] : [context]
    if (("ANTHROPIC_CUSTOM_HEADERS" in env && (typeof env.ANTHROPIC_CUSTOM_HEADERS !== "string" || !permitted.includes(env.ANTHROPIC_CUSTOM_HEADERS))) || (effort && !("ANTHROPIC_CUSTOM_HEADERS" in env))) fail("artifact", "Invalid managed headers")
  } else {
    keys(artifact, ["kind", "config", "credential"])
    if (artifact.kind !== "codex-config") fail("artifact", "Invalid client artifact")
    const config = record(artifact.config)
    keys(config, ["model_provider", "model_providers"], ["model"])
    if (config.model_provider !== "copilot_gateway" || ("model" in config && !validString(config.model))) fail("artifact", "Invalid Codex configuration")
    const providers = record(config.model_providers)
    keys(providers, ["copilot_gateway"])
    const provider = record(providers.copilot_gateway)
    keys(provider, ["name", "base_url", "wire_api", "supports_websockets"])
    if (provider.name !== "Copilot Gateway" || provider.wire_api !== "responses" || typeof provider.supports_websockets !== "boolean" || typeof provider.base_url !== "string" || !provider.base_url.endsWith("/azure-api.codex/")) fail("artifact", "Invalid Codex provider")
    origin = originUrl(provider.base_url.slice(0, -"/azure-api.codex/".length))
    const credential = record(artifact.credential)
    keys(credential, ["kind", "value"])
    if (credential.kind !== "gateway-api-key" || !validCredential(credential.value)) fail("credential", "Invalid gateway credential")
  }
  if (expectedOrigin !== undefined && origin !== originUrl(expectedOrigin)) fail("origin", "Setup artifact origin mismatch")
  const { artifactDigest, ...body } = envelope
  if (await sha256(canonicalJson(body)) !== artifactDigest) fail("digest", "Setup artifact digest mismatch")
  return input as Envelope
}
export function redactArtifact(artifact: Envelope["artifact"]): unknown {
  if (artifact.kind === "codex-config") return { ...artifact, credential: { kind: artifact.credential.kind, value: "[REDACTED]" } }
  return { ...artifact, settings: { ...artifact.settings, env: { ...artifact.settings.env, ANTHROPIC_AUTH_TOKEN: "[REDACTED]" } } }
}
