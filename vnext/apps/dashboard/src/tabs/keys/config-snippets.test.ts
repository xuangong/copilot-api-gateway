import { expect, test } from "bun:test"
import { buildCatalog } from "../../state/models"
import { claudeCodeSettingsSnippet, claudeCodeShellSnippet } from "./configSnippets"

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
