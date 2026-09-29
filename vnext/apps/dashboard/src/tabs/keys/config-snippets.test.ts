import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildCatalog } from "../../state/models"
import { availableClaudeTierSelection, claudeCodeSettingsSnippet, claudeCodeShellSnippet, codexTomlSnippet } from "./configSnippets"

test("Claude configuration snippets preserve exact mapped aliases with composite-looking suffixes", () => {
  const catalog = buildCatalog([
    { id: "claude-personal-high-1m", _mapped_to: "claude-sonnet-4.6", supported_endpoints: ["/v1/messages"] },
    { id: "claude-small-xhigh", _mapped_to: "claude-haiku-4.5", supported_endpoints: ["/v1/messages"] },
  ])
  const big = catalog.claudeBig.find((id) => id === "claude-personal-high-1m") ?? ""
  const small = catalog.claudeSmall.find((id) => id === "claude-small-xhigh") ?? ""
  const shell = claudeCodeShellSnippet(big, small, "http://gateway", "test-key", catalog.mappedModelIds)
  expect(shell.split("\n")).toContain("export ANTHROPIC_MODEL=claude-personal-high-1m")
  expect(shell.split("\n")).toContain("export ANTHROPIC_SMALL_FAST_MODEL=claude-small-xhigh")
  expect(shell).not.toContain("ANTHROPIC_CUSTOM_HEADERS")

  const settings = JSON.parse(claudeCodeSettingsSnippet(big, small, "http://gateway", "test-key", catalog.mappedModelIds)) as { env: Record<string, string> }
  expect(settings.env.ANTHROPIC_MODEL).toBe("claude-personal-high-1m")
  expect(settings.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-small-xhigh")
  expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined()
})

test("ordinary Claude composite ids still decompose when another model is mapped", () => {
  const settings = JSON.parse(claudeCodeSettingsSnippet(
    "claude-sonnet-4.6-high-1m", "claude-small-xhigh", "http://gateway", "test-key", ["claude-small-xhigh"],
  )) as { env: Record<string, string>; effortLevel: string }
  expect(settings.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4.6")
  expect(settings.env.ANTHROPIC_SMALL_FAST_MODEL).toBe("claude-small-xhigh")
  expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("anthropic-beta: context-1m-2025-08-07\nx-copilot-reasoning-effort: high")
  expect(settings.effortLevel).toBe("high")
})

test("optional Claude tier defaults remain independent and preserve mapped aliases", () => {
  const mapped = ["claude-personal-high-1m", "claude-small-xhigh"]
  const tiers = {
    opus: "claude-personal-high-1m",
    sonnet: "claude-sonnet-4.6-high-1m",
    haiku: "claude-small-xhigh",
  }
  const settings = JSON.parse(claudeCodeSettingsSnippet(
    "claude-opus-4.7-xhigh-1m", "claude-haiku-4.5", "http://gateway", "test-key", mapped, tiers,
  )) as { env: Record<string, string>; effortLevel: string }
  expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-personal-high-1m")
  expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-sonnet-4.6-high-1m")
  expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-small-xhigh")
  expect(settings.env.ANTHROPIC_MODEL).toBe("claude-opus-4.7")
  expect(settings.env.ANTHROPIC_CUSTOM_HEADERS).toBe("anthropic-beta: context-1m-2025-08-07\nx-copilot-reasoning-effort: xhigh")
  expect(settings.effortLevel).toBe("xhigh")
})

test("omitted and cleared Claude tier defaults leave existing positional snippets unchanged", () => {
  const baseline = JSON.parse(claudeCodeSettingsSnippet("claude-sonnet-4.6", "claude-haiku-4.5", "http://gateway", "test-key")) as { env: Record<string, string> }
  const cleared = JSON.parse(claudeCodeSettingsSnippet("claude-sonnet-4.6", "claude-haiku-4.5", "http://gateway", "test-key", [], { opus: "", haiku: "" })) as { env: Record<string, string> }
  expect(cleared).toEqual(baseline)
  expect(baseline.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
  expect(baseline.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
  expect(baseline.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBeUndefined()
})

test("Claude shell snippet round-trips metacharacters without executing them", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-snippet-"))
  const path = join(dir, "config.sh")
  const values = {
    url: "https://gateway.example/a path?x=$HOME;$(printf wrong)",
    key: "synthetic'key\\line\nsecond",
    opus: "claude-alias '$(printf wrong)'",
    sonnet: "claude-sonnet-4.6-high-1m",
    haiku: "claude-haiku-4.5; printf wrong",
  }
  try {
    writeFileSync(path, claudeCodeShellSnippet(
      "claude-opus-4.7-xhigh", "claude-haiku-4.5", values.url, values.key, [],
      { opus: values.opus, sonnet: values.sonnet, haiku: values.haiku },
    ))
    const result = Bun.spawnSync(["bash", "-c", 'source "$1"; printf "%s\\0" "$ANTHROPIC_BASE_URL" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_DEFAULT_OPUS_MODEL" "$ANTHROPIC_DEFAULT_SONNET_MODEL" "$ANTHROPIC_DEFAULT_HAIKU_MODEL" "$ANTHROPIC_CUSTOM_HEADERS"', "bash", path], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    })
    expect(result.exitCode).toBe(0)
    expect(new TextDecoder().decode(result.stdout).split("\0")).toEqual([
      values.url, values.key, values.opus, values.sonnet, values.haiku,
      "x-copilot-reasoning-effort: xhigh", "",
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("optional tier selection clears values unavailable in the current key catalog", () => {
  const catalog = buildCatalog([{ id: "claude-current", _mapped_to: "claude-sonnet-4.6", supported_endpoints: ["/v1/messages"] }])
  expect(availableClaudeTierSelection("claude-current", catalog.claudeBig)).toBe("claude-current")
  expect(availableClaudeTierSelection("claude-old", catalog.claudeBig)).toBe("")
  expect(availableClaudeTierSelection("", catalog.claudeBig)).toBe("")
})

test("generated Codex provider explicitly uses supported HTTP Responses transport", () => {
  const snippet = codexTomlSnippet("test-model", "https://gateway.example")
  const config = Bun.TOML.parse(snippet)
  expect(config).toMatchObject({
    model: "test-model",
    model_providers: { copilot_gateway: { wire_api: "responses", supports_websockets: false } },
  })
})

test("confirmed ingress enables Codex WebSockets and TOML strings round-trip", () => {
  const model = "quoted \"model\"\\path\n雪\u007f"
  const origin = "https://gateway.example/a\\path/\"name\"\n雪"
  const config = Bun.TOML.parse(codexTomlSnippet(model, origin, true)) as {
    model: string
    model_providers: { copilot_gateway: { base_url: string; supports_websockets: boolean } }
  }
  expect(config.model).toBe(model)
  expect(config.model_providers.copilot_gateway.base_url).toBe(origin + "/")
  expect(config.model_providers.copilot_gateway.supports_websockets).toBe(true)
})
