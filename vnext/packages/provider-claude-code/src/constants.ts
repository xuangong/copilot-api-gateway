// All Claude Code OAuth + data-plane upstream constants. Pinned to the same
// public OAuth client the official `claude` CLI ships with, as independent
// reimplementations of the Claude Code OAuth flow use:
//   https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/cli/lib/claude_max.go
//   https://github.com/decolua/9router/blob/0c47c891e7a6c1a47c35b286235a132c0a5aa0a8/open-sse/providers/registry/claude.js
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

export const CLAUDE_CODE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize'
export const CLAUDE_CODE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

// Fixed redirect URI registered against CLAUDE_CODE_CLIENT_ID at Anthropic.
export const CLAUDE_CODE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback'

// Full OAuth flow scope set (matches the official CLI).
export const CLAUDE_CODE_OAUTH_SCOPE = 'org:create_api_key user:profile user:inference'

// Setup-Token scope: inference only. Used by Anthropic's "Create a
// Long-Lived Token" UI to mint a ~1 year bearer with no refresh_token.
export const CLAUDE_CODE_OAUTH_SETUP_TOKEN_SCOPE = 'user:inference'

// 1 year in seconds — sent in the setup-token authorization_code exchange.
export const CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60

// User-Agent on /v1/oauth/token — matches axios (the CLI's HTTP layer).
// Source: https://github.com/Menci/copilot-gateway/blob/ab7d27239d6b4726e6758d4d4af9ff7aede90890/packages/provider-claude-code/src/constants.ts#L58-L61
export const CLAUDE_CODE_OAUTH_USER_AGENT = 'axios/1.13.6'

// Identity endpoint that derives email + account/organization UUIDs from a
// fresh access token.
export const CLAUDE_CODE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'

// Live quota probe Anthropic exposes for the OAuth bearer.
export const CLAUDE_CODE_USAGE_PROBE_URL = 'https://api.anthropic.com/api/oauth/usage'

// Data-plane API base for /v1/messages.
export const CLAUDE_CODE_API_BASE = 'https://api.anthropic.com'
export const CLAUDE_CODE_MESSAGES_PATH = '/v1/messages'
export const CLAUDE_CODE_MODELS_PATH = '/v1/models'
