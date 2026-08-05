// Pinned mimicry header surface for the Anthropic /v1/messages?beta=true call
// on a Claude Code subscription OAuth bearer. Lifted byte-for-byte from real
// Claude Code traffic at v2.1.181 on 2026-06-19; bump together with the
// CLI version whenever we refresh the mimicry constants.
//
// Anthropic's "third-party" detector keys on the full surface (UA, X-App,
// X-Stainless-*, anthropic-beta, anthropic-version,
// anthropic-dangerous-direct-browser-access) plus the body shape; missing any
// one is sufficient to downgrade a Sonnet/Opus call to extra-usage billing.
//
// vNext note: ported verbatim from
// copilot-gateway/packages/provider-claude-code/src/headers.ts. No semicolons
// per vNext lint config.

export const CLAUDE_CLI_VERSION = '2.1.181'

const STAINLESS_PACKAGE_VERSION = '0.94.0'

const STAINLESS_BASE = {
  'X-Stainless-Lang': 'js',
  'X-Stainless-Package-Version': STAINLESS_PACKAGE_VERSION,
  'X-Stainless-OS': 'Linux',
  'X-Stainless-Arch': 'arm64',
  'X-Stainless-Runtime': 'node',
  'X-Stainless-Runtime-Version': 'v24.3.0',
  'X-Stainless-Retry-Count': '0',
  'X-Stainless-Timeout': '600',
  'X-Stainless-Helper-Method': 'stream',
} as const

const BASE_HEADERS = {
  'User-Agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
  'x-app': 'cli',
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-version': '2023-06-01',
  Accept: 'application/json',
  'Content-Type': 'application/json',
  ...STAINLESS_BASE,
} as const

const ANTHROPIC_BETA_SONNET_OPUS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
  'context-management-2025-06-27',
  'extended-cache-ttl-2025-04-11',
  'mid-conversation-system-2026-04-07',
].join(',')

const ANTHROPIC_BETA_HAIKU = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'fine-grained-tool-streaming-2025-05-14',
].join(',')

export const CLAUDE_CODE_HEADERS_SONNET_OPUS: Record<string, string> = {
  ...BASE_HEADERS,
  'anthropic-beta': ANTHROPIC_BETA_SONNET_OPUS,
}

export const CLAUDE_CODE_HEADERS_HAIKU: Record<string, string> = {
  ...BASE_HEADERS,
  'anthropic-beta': ANTHROPIC_BETA_HAIKU,
}

export const pickClaudeCodeHeaders = (modelId: string): Record<string, string> =>
  modelId.includes('haiku') ? CLAUDE_CODE_HEADERS_HAIKU : CLAUDE_CODE_HEADERS_SONNET_OPUS
