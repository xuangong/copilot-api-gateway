/**
 * Detect client software from User-Agent header.
 *
 * Returns a short, stable identifier like "claude-code", "cursor", "vscode", etc.
 * Unknown clients fall back to the first UA product token (e.g. "python-requests").
 */

interface ClientPattern {
  pattern: RegExp
  name: string
}

// Ordered by specificity — first match wins
const CLIENT_PATTERNS: ClientPattern[] = [
  // AI coding tools / agents
  { pattern: /claude-code/i, name: "claude-code" },
  { pattern: /Claude\//i, name: "claude-code" },
  { pattern: /codex-cli/i, name: "codex-cli" },
  { pattern: /Codex\//i, name: "codex-cli" },
  { pattern: /gemini-cli/i, name: "gemini-cli" },
  { pattern: /cursor/i, name: "cursor" },
  { pattern: /Windsurf/i, name: "windsurf" },
  { pattern: /Cline/i, name: "cline" },
  { pattern: /Continue/i, name: "continue" },
  { pattern: /Aider/i, name: "aider" },
  { pattern: /Copilot/i, name: "copilot" },
  { pattern: /openclaw/i, name: "openclaw" },
  { pattern: /antigravity/i, name: "antigravity" },

  // IDEs
  { pattern: /JetBrains/i, name: "jetbrains" },
  { pattern: /VSCode/i, name: "vscode" },
  { pattern: /Visual Studio Code/i, name: "vscode" },
  { pattern: /Neovim/i, name: "neovim" },
  { pattern: /Vim/i, name: "vim" },

  // SDKs
  { pattern: /anthropic-typescript/i, name: "anthropic-sdk-ts" },
  { pattern: /anthropic-python/i, name: "anthropic-sdk-py" },
  { pattern: /Anthropic/i, name: "anthropic-sdk" },
  { pattern: /openai-node/i, name: "openai-sdk-ts" },
  { pattern: /openai-python/i, name: "openai-sdk-py" },
  { pattern: /OpenAI\//i, name: "openai-sdk" },

  // HTTP libraries / runtimes
  { pattern: /python-requests/i, name: "python-requests" },
  { pattern: /python-httpx/i, name: "python-httpx" },
  { pattern: /node-fetch/i, name: "node-fetch" },
  { pattern: /axios/i, name: "axios" },
  { pattern: /curl/i, name: "curl" },
  { pattern: /Wget/i, name: "wget" },
]

export function detectClient(userAgent: string | null | undefined): string {
  if (!userAgent) return ""

  for (const { pattern, name } of CLIENT_PATTERNS) {
    if (pattern.test(userAgent)) return name
  }

  // Fallback: first product token (e.g. "MyApp/1.0" → "myapp")
  const firstToken = userAgent.match(/^([A-Za-z][\w.-]*)/)
  if (firstToken && firstToken[1]) {
    return firstToken[1].toLowerCase()
  }

  return ""
}
