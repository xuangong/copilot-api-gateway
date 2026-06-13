// Snippet builders for Claude Code / Codex / Gemini CLI configurations.
// Ported verbatim from src/ui/dashboard/client.ts (legacy Alpine dashboard).
// Keep this in sync with parseCompositeModelId on the server: composite
// claude ids like 'claude-opus-4.7-xhigh-1m' decompose into a base id plus
// effort/context modifiers that Claude Code passes via custom headers.

export interface ClaudeDecomposed {
  baseId: string
  effort?: string
  context1m: boolean
}

export function decomposeClaudeId(id: string): ClaudeDecomposed {
  if (!id || !id.startsWith("claude-")) return { baseId: id || "", context1m: false }
  let rest = id
  let effort: string | undefined
  let context1m = false
  const EFFORTS = new Set(["high", "xhigh"])
  for (let i = 0; i < 2; i++) {
    const dash = rest.lastIndexOf("-")
    if (dash < 0) break
    const suffix = rest.slice(dash + 1)
    if (suffix === "1m" && !context1m) {
      context1m = true
      rest = rest.slice(0, dash)
    } else if (EFFORTS.has(suffix) && !effort) {
      effort = suffix
      rest = rest.slice(0, dash)
    } else break
  }
  return { baseId: rest, effort, context1m }
}

export function claudeCodeShellSnippet(big: string, small: string, baseUrl: string, key: string): string {
  const b = decomposeClaudeId(big)
  const s = decomposeClaudeId(small)
  const lines = [
    "export ANTHROPIC_BASE_URL=" + baseUrl,
    "export ANTHROPIC_AUTH_TOKEN=" + key,
    "export ANTHROPIC_MODEL=" + b.baseId,
    "export ANTHROPIC_SMALL_FAST_MODEL=" + s.baseId,
  ]
  const headerParts: string[] = []
  if (b.context1m) headerParts.push("anthropic-beta: context-1m-2025-08-07")
  if (b.effort) headerParts.push("x-copilot-reasoning-effort: " + b.effort)
  if (headerParts.length > 0) {
    // Bash $'...' (ANSI-C quoting) interprets \n as a real newline.
    lines.push("export ANTHROPIC_CUSTOM_HEADERS=$'" + headerParts.join("\\n") + "'")
  }
  return lines.join("\n")
}

export function claudeCodeSettingsSnippet(big: string, small: string, baseUrl: string, key: string): string {
  const b = decomposeClaudeId(big)
  const s = decomposeClaudeId(small)
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: key,
    ANTHROPIC_MODEL: b.baseId,
    ANTHROPIC_SMALL_FAST_MODEL: s.baseId,
  }
  const headerParts: string[] = []
  if (b.context1m) headerParts.push("anthropic-beta: context-1m-2025-08-07")
  if (b.effort) headerParts.push("x-copilot-reasoning-effort: " + b.effort)
  if (headerParts.length > 0) env.ANTHROPIC_CUSTOM_HEADERS = headerParts.join("\n")
  // effortLevel overrides Claude Code's built-in default of "high" for 4.7+
  // models. Fall back to "medium" when the composite id carries no effort.
  const snippet: { env: Record<string, string>; effortLevel?: string } = { env }
  const effortLevel = b.effort || (b.baseId.startsWith("claude-") ? "medium" : undefined)
  if (effortLevel) snippet.effortLevel = effortLevel
  return JSON.stringify(snippet, null, 2)
}

export function codexTomlSnippet(model: string, baseUrl: string): string {
  return [
    'model = "' + model + '"',
    'model_provider = "copilot_gateway"',
    "",
    "[model_providers.copilot_gateway]",
    'name = "Copilot Gateway"',
    'base_url = "' + baseUrl + '/"',
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
  ].join("\n")
}

export function codexEnvSnippet(key: string): string {
  return "export OPENAI_API_KEY=" + key
}

export function codexStartSnippet(model: string): string {
  return "codex -c model_provider=copilot_gateway -m " + model
}

export function geminiSnippet(model: string, baseUrl: string, key: string): string {
  return [
    "export GEMINI_API_KEY=" + key,
    "# DEPRECATED: GEMINI_API_BASE_URL was renamed to GOOGLE_GEMINI_BASE_URL in gemini-cli v0.13.0+",
    "# ref: https://github.com/google-gemini/gemini-cli/blob/3bc56d0ef55050c29d8479eeb81b4e273b8101c8/docs/changelogs/preview.md",
    "export GEMINI_API_BASE_URL=" + baseUrl,
    "export GOOGLE_GEMINI_BASE_URL=" + baseUrl,
    "export GEMINI_MODEL=" + model,
  ].join("\n")
}
