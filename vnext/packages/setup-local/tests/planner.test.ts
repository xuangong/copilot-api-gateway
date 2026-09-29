import { expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { envelope, plan, temporaryHome, credential } from "./fixtures"
import { planSetup } from "../src/planner"
import { editToml, tomlString } from "../src/toml"
import { validateEnvelope, canonicalJson, sha256 } from "../src/contract"
import { readCurrentFiles } from "../src/executor"
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

for (const previous of ["Authorization: Bearer previous-authorization-secret", "x-api-key: previous-api-key-secret"]) {
  for (const selection of ["effort", "context"] as const) test(`redacts previous ${previous.split(":")[0]} custom headers for ${selection} selection`, async () => {
    const fixture = temporaryHome()
    try {
      mkdirSync(join(fixture.home, ".claude"))
      writeFileSync(join(fixture.home, ".claude/settings.json"), JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: previous, KEEP: "unmanaged" }, nested: { keep: true } }))
      const item = await envelope("claude")
      if (item.artifact.kind !== "claude-settings") throw new Error("fixture")
      const next = selection === "effort" ? "x-copilot-reasoning-effort: high" : "anthropic-beta: context-1m-2025-08-07"
      item.artifact.settings.env.ANTHROPIC_CUSTOM_HEADERS = next
      if (selection === "effort") item.artifact.settings.effortLevel = "high"
      const { artifactDigest: _digest, ...body } = item
      item.artifactDigest = await sha256(canonicalJson(body))
      const result = await planSetup({ artifact: item, currentFiles: readCurrentFiles(fixture.home, "claude"), installation: { allowedHome: fixture.home, bunExecutable: process.execPath, runnerBytes: new Uint8Array([1]) } })
      expect(result.redactedDiff.includes(previous)).toBe(false)
      expect(result.redactedDiff.includes(credential)).toBe(false)
      expect(result.redactedDiff).toContain(next)
      const changes = JSON.parse(result.redactedDiff.split("\n").slice(1).join("\n")) as { key: string; before: unknown }[]
      expect(changes.find(change => change.key === "/env/ANTHROPIC_CUSTOM_HEADERS")?.before).toBe("[REDACTED]")
      expect(JSON.parse(decode(result.files[0]?.bytes ?? new Uint8Array()))).toMatchObject({ env: { KEEP: "unmanaged", ANTHROPIC_CUSTOM_HEADERS: next }, nested: { keep: true } })
    } finally { fixture.cleanup() }
  })
}

test("Claude merges owned fields, preserving unrelated env, effort and nested JSON", async () => {
  const fixture = temporaryHome()
  try {
    mkdirSync(join(fixture.home, ".claude"))
    writeFileSync(join(fixture.home, ".claude/settings.json"), JSON.stringify({ env: { KEEP: "private", ANTHROPIC_MODEL: "old" }, effortLevel: "low", nested: { keep: true } }))
    const result = await plan(fixture.home, "claude")
    expect(JSON.parse(decode(result.files[0]?.bytes ?? new Uint8Array()))).toMatchObject({ env: { KEEP: "private", ANTHROPIC_MODEL: "old", ANTHROPIC_AUTH_TOKEN: credential }, effortLevel: "low", nested: { keep: true } })
    expect(result.redactedDiff).not.toContain(credential)
    expect(result.redactedDiff).not.toContain("private")
  } finally { fixture.cleanup() }
})
for (const input of ["{", "[]", '{"env":null}', '{"env":[]}']) test(`rejects malformed Claude configuration ${input}`, async () => {
  const fixture = temporaryHome()
  try {
    mkdirSync(join(fixture.home, ".claude")); writeFileSync(join(fixture.home, ".claude/settings.json"), input)
    await expect(plan(fixture.home, "claude")).rejects.toThrow()
  } finally { fixture.cleanup() }
})
test("Codex preserves unrelated raw spans and unset model with native command auth", async () => {
  const fixture = temporaryHome()
  try {
    mkdirSync(join(fixture.home, ".codex"))
    const unrelated = '# Other provider stays byte-for-byte.\n[model_providers.other]\nbase_url = "https://other.invalid" # comment\n'
    writeFileSync(join(fixture.home, ".codex/config.toml"), '# lead\nmodel = "old" # model comment\n' + unrelated)
    const result = await plan(fixture.home)
    const config = result.files.find(file => file.kind === "codex-config")
    const text = decode(config?.bytes ?? new Uint8Array())
    expect(text).toContain(unrelated)
    expect(text).toContain('model = "old" # model comment')
    const parsed = Bun.TOML.parse(text)
    expect(parsed).toMatchObject({ model: "old", model_provider: "copilot_gateway", model_providers: { copilot_gateway: { supports_websockets: false, auth: { command: process.execPath, args: [join(fixture.home, ".codex/copilot-gateway/runner.mjs"), "credential-read", join(fixture.home, ".codex/copilot-gateway-token")] } } } })
    expect(text).not.toContain(credential)
  } finally { fixture.cleanup() }
})
test("opaque model and TOML strings preserve Unicode, quotes, CR/LF and Windows separators", async () => {
  const value = '模型 "quoted"\r\nC:\\Users\\user\tend'
  expect(Bun.TOML.parse("value = " + tomlString(value))).toEqual({ value })
  const fixture = temporaryHome()
  try {
    const result = await plan(fixture.home, "codex", value)
    const config = result.files.find(file => file.kind === "codex-config")
    expect(Bun.TOML.parse(decode(config?.bytes ?? new Uint8Array()))).toMatchObject({ model: value })
  } finally { fixture.cleanup() }
})
for (const source of [
  '[model_providers.copilot_gateway]\nenv_key = "OLD"\n',
  '[model_providers.copilot_gateway.auth]\ncommand = "sh"\nargs = ["-c", "bad"]\n',
  'model_providers = { copilot_gateway = {} }',
  '["model_providers"."copilot_gateway"]\nname = "old"',
  'model_provider = "old"\nmodel_provider = "duplicate"',
  'note = """\nmultiline\n"""',
  '[[model_providers.copilot_gateway]]\nname = "array"',
  'model_providers.copilot_gateway.name = "dotted"',
  'model = [',
]) test("rejects ambiguous TOML or conflicting provider auth: " + source.split("\n")[0], async () => {
  const artifact = (await envelope()).artifact
  if (artifact.kind !== "codex-config") throw new Error("fixture")
  expect(() => editToml(source, artifact, { command: process.execPath, args: ["/fixed/runner.mjs", "credential-read", "/fixed/token"] })).toThrow()
})
test("digest and snapshot conflicts are rejected before planning", async () => {
  const fixture = temporaryHome()
  try {
    await expect(planSetup({ artifact: await envelope("claude"), currentFiles: [{ kind: "claude-settings", bytes: new TextEncoder().encode("{}"), expectedSha256: "0".repeat(64) }], installation: { allowedHome: fixture.home, bunExecutable: process.execPath, runnerBytes: new Uint8Array([1]) } })).rejects.toThrow("digest")
    for (const model of ["", "nul\0", "\ud800", "x".repeat(1025)]) {
      const item = await envelope("codex", model)
      const { artifactDigest: _digest, ...body } = item
      await expect(validateEnvelope({ ...item, artifactDigest: await sha256(canonicalJson(body)) })).rejects.toThrow()
    }
  } finally { fixture.cleanup() }
})
