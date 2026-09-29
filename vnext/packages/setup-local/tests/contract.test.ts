import { expect, test } from "bun:test"
import { validateEnvelope, canonicalJson, sha256 } from "../src/contract"
import type { Envelope } from "../src/contract"
import { envelope as fixtureEnvelope, temporaryHome } from "./fixtures"
import { planSetup } from "../src/planner"

const artifact = { kind: "codex-config", config: { model_provider: "copilot_gateway", model_providers: {
  copilot_gateway: { name: "Copilot Gateway", base_url: "https://gateway.invalid/azure-api.codex/", wire_api: "responses", supports_websockets: false },
} }, credential: { kind: "gateway-api-key", value: "a".repeat(64) } } as const

test("validates the exact envelope and credential-inclusive canonical digest", async () => {
  const body = { version: 1, client: "codex", platform: "posix", artifact }
  const envelope = { ...body, artifactDigest: await sha256(canonicalJson(body)) }
  expect((await validateEnvelope(envelope)).artifact).toEqual(artifact)
  await expect(validateEnvelope({ ...envelope, artifactDigest: "0".repeat(64) })).rejects.toThrow("digest")
  await expect(validateEnvelope({ ...envelope, path: "/tmp/arbitrary" })).rejects.toThrow()
  await expect(validateEnvelope({ ...envelope, client: "claude" })).rejects.toThrow()
})

for (const field of ["client", "platform", "effortLevel", "ANTHROPIC_CUSTOM_HEADERS"] as const) {
  for (const shape of ["array", "object", "null", "number"] as const) test(`rejects ${shape} ${field} with a valid digest before planning`, async () => {
    const item = await fixtureEnvelope(field === "client" || field === "platform" ? "codex" : "claude")
    const text = { client: "codex", platform: "posix", effortLevel: "high", ANTHROPIC_CUSTOM_HEADERS: "anthropic-beta: context-1m-2025-08-07" }[field]
    const value = shape === "array" ? [text] : shape === "object" ? { value: text } : shape === "null" ? null : 1
    const body: Record<string, unknown> = { version: item.version, client: item.client, platform: item.platform, artifact: item.artifact }
    if (field === "client" || field === "platform") body[field] = value
    else if (item.artifact.kind === "claude-settings") {
      if (field === "effortLevel") {
        Object.assign(item.artifact.settings, { effortLevel: value })
        item.artifact.settings.env.ANTHROPIC_CUSTOM_HEADERS = "x-copilot-reasoning-effort: high"
      } else Object.assign(item.artifact.settings.env, { ANTHROPIC_CUSTOM_HEADERS: value })
    }
    const invalid = { ...body, artifactDigest: await sha256(canonicalJson(body)) }
    await expect(validateEnvelope(invalid)).rejects.toThrow()
    const fixture = temporaryHome()
    try {
      // Runtime artifact input deliberately violates the declared protocol type.
      await expect(planSetup({ artifact: invalid as unknown as Envelope, currentFiles: [], installation: { allowedHome: fixture.home, bunExecutable: process.execPath, runnerBytes: new Uint8Array([1]) } })).rejects.toThrow(/envelope|override|headers/)
    } finally { fixture.cleanup() }
  })
}
