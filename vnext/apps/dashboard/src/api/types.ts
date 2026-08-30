// Shared API response types. Keep these in sync with src/routes/control-plane.ts
// and src/routes/auth/*. When a route shape changes, update here too.

export interface SessionInfo {
  ok: true
  isAdmin: boolean
  isUser: boolean
  userId?: number | string
  userName?: string
  email?: string
  avatarUrl?: string
  hasPassword?: boolean
}

export interface ProxyFallbackEntry {
  id: string
  colos?: string[]
}

export interface UpstreamRecord {
  id: string
  ownerId: string
  provider: "copilot" | "azure" | "custom" | "sdf"
  name: string
  enabled: boolean
  sortOrder: number
  config: Record<string, unknown> & {
    githubToken?: string
    accountType?: string
    user?: { id: number; login: string; name?: string; avatar_url?: string }
    baseUrl?: string
    apiKey?: string
    endpoint?: string
    azureApiKey?: string
    deployment?: string
    apiVersion?: string
    endpoints?: string[]
    models?: string[]
    azureDeployments?: string
  }
  flagOverrides?: Record<string, boolean>
  disabledPublicModelIds: string[]
  proxyFallbackList?: ProxyFallbackEntry[]
  // Set by the server only for sdf upstreams whose Substrate token's `exp` has
  // already passed — the token itself is redacted, so we cannot work this out
  // here. Present means expired; absent means "not expired, or unknowable", and
  // deliberately not a health signal (a live-looking token can still be revoked).
  tokenExpiredAt?: string
  createdAt: string
  updatedAt: string
}

export interface ApiKey {
  id: string
  name: string
  ownerId?: string
  hint: string
  createdAt: string
  lastUsedAt?: string
}
