import { expect, test } from "bun:test"
import { buildSetupArtifact, canonicalJson, canonicalSettings, redactArtifact, setupSelectionSchema, sha256, touchedKeys } from "../src/control-plane/setup/artifact.ts"

test("canonical digest has deterministic sorted JSON and includes the private credential and ingress boolean", async () => {
  expect(canonicalJson({ z: "value", a: { b: 2, a: true }, q: null })).toBe('{"a":{"a":true,"b":2},"q":null,"z":"value"}')
  expect(await sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  const selection = setupSelectionSchema.parse({ client: "codex", platform: "posix", settings: {} })
  const plain = buildSetupArtifact(selection, "sk_fixture_a", "https://example.invalid", false)
  const websocket = buildSetupArtifact(selection, "sk_fixture_a", "https://example.invalid", true)
  const rotated = buildSetupArtifact(selection, "sk_fixture_b", "https://example.invalid", false)
  expect(await sha256(canonicalJson(plain))).not.toBe(await sha256(canonicalJson(websocket)))
  expect(await sha256(canonicalJson(plain))).not.toBe(await sha256(canonicalJson(rotated)))
  expect(redactArtifact(plain.artifact)).toMatchObject({ credential: { value: "[REDACTED]" } })
  expect(touchedKeys(plain.artifact)).not.toContainEqual({ target: "codex-config", key: "/model" })
  expect(touchedKeys(plain.artifact)).toContainEqual({ target: "codex-config", key: "/model_providers/copilot_gateway/auth" })
})

test("unset Claude optional values never create defaults, custom headers, or model rewrites", () => {
  const selection = setupSelectionSchema.parse({ client: "claude", platform: "windows", settings: { model: "claude-mapped-xhigh-1m" } })
  const result = buildSetupArtifact(selection, "sk_fixture", "https://example.invalid", true)
  expect(result.artifact).toEqual({ kind: "claude-settings", settings: { env: {
    ANTHROPIC_BASE_URL: "https://example.invalid", ANTHROPIC_AUTH_TOKEN: "sk_fixture", ANTHROPIC_MODEL: "claude-mapped-xhigh-1m",
  } } })
  expect(canonicalSettings(setupSelectionSchema.parse({ client: "claude", platform: "posix", settings: {} })))
    .toBe('{"context1m":false,"effort":null,"haikuModel":null,"model":null,"opusModel":null,"smallModel":null,"sonnetModel":null}')
  expect(touchedKeys(result.artifact)).toEqual([
    { target: "claude-settings", key: "/env/ANTHROPIC_BASE_URL" },
    { target: "claude-settings", key: "/env/ANTHROPIC_AUTH_TOKEN" },
    { target: "claude-settings", key: "/env/ANTHROPIC_MODEL" },
  ])
})

test("strict selection accepts boundary UTF-8 models without changing quotes, newlines, or Unicode", () => {
  const model = "😀".repeat(256)
  const valid = setupSelectionSchema.parse({ client: "codex", platform: "windows", settings: { model } })
  expect(valid.settings.model).toBe(model)
  for (const invalid of ["", "\0", "\ud800", "\udc00", model + "x"]) {
    expect(setupSelectionSchema.safeParse({ client: "codex", platform: "posix", settings: { model: invalid } }).success).toBe(false)
  }
  for (const invalid of [{ command: "write" }, { model: ["a"] }, { effort: "high" }]) {
    expect(setupSelectionSchema.safeParse({ client: "codex", platform: "posix", settings: invalid }).success).toBe(false)
  }
})
