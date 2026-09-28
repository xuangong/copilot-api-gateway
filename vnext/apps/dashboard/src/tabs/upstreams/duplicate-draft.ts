import type { ProxyFallbackEntry, UpstreamRecord } from "../../api/types"

export interface PortableUpstreamDraft {
  provider: "custom" | "azure" | "sdf"
  name: string
  config: Record<string, unknown>
  flagOverrides: Record<string, boolean>
  disabledPublicModelIds: string[]
  proxyFallbackList: ProxyFallbackEntry[]
}

const PORTABLE_CONFIG_FIELDS = {
  custom: ["baseUrl", "authStyle", "endpoints", "pathOverrides", "modelsEndpoint", "models"],
  azure: ["endpoint", "deployment", "apiVersion", "endpoints", "deployments"],
  sdf: ["taxonomy", "cos", "passport"],
} as const

const PRIVATE_FIELD = /(?:^|[_-])(?:token|secret|password|authorization|credential)(?:$|[_-])|api[-_]?key|(?:access|refresh|id|github|substrate|auth|session)token/i
const CREDENTIAL_QUERY_KEYS = new Set([
  "key", "apikey", "xapikey", "secretkey", "subscriptionkey", "token", "apitoken",
  "accesstoken", "refreshtoken", "idtoken", "authtoken", "sessiontoken",
  "githubtoken", "substratetoken", "authorization", "password", "passwd",
  "secret", "credential", "signature", "sig", "auth", "code",
  "xamzsignature", "xamzcredential", "xamzsecuritytoken",
  "xgoogsignature", "xgoogcredential",
])

function isCredentialQueryKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "")
  return CREDENTIAL_QUERY_KEYS.has(normalized)
    || /(?:secret|token|password|passwd|credential|signature)$/.test(normalized)
    || /(?:access|secret|api|client|consumer|subscription|private|shared|app|session|security|aws)key$/.test(normalized)
}

function withoutUrlCredentials(value: string, relative = false): string | undefined {
  let url: URL
  try {
    url = relative ? new URL(value, "https://draft.invalid") : new URL(value)
  } catch {
    return undefined
  }
  if (relative ? !value.startsWith("/") : !["http:", "https:"].includes(url.protocol)) return undefined
  let changed = Boolean(url.username || url.password)
  url.username = ""
  url.password = ""
  for (const key of [...new Set(url.searchParams.keys())]) {
    if (!isCredentialQueryKey(key)) continue
    url.searchParams.delete(key)
    changed = true
  }
  if (!changed) return value
  return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString()
}

function clonePortableValue(value: unknown): unknown {
  if (value === "***") return undefined
  if (Array.isArray(value)) {
    return value.map(clonePortableValue).filter((item) => item !== undefined)
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (PRIVATE_FIELD.test(key)) continue
      const copied = clonePortableValue(item)
      if (copied !== undefined) out[key] = copied
    }
    return out
  }
  return value
}

export function createPortableUpstreamDraft(source: UpstreamRecord, name: string): PortableUpstreamDraft {
  if (source.provider === "copilot") throw new Error("Copilot OAuth upstreams cannot be duplicated")
  const config: Record<string, unknown> = {}
  for (const key of PORTABLE_CONFIG_FIELDS[source.provider]) {
    const copied = clonePortableValue(source.config[key])
    if (copied !== undefined) config[key] = copied
  }
  for (const key of ["baseUrl", "modelsEndpoint", "endpoint"] as const) {
    if (typeof config[key] !== "string") continue
    const safe = withoutUrlCredentials(config[key])
    if (safe === undefined) delete config[key]
    else config[key] = safe
  }
  if (config.pathOverrides && typeof config.pathOverrides === "object" && !Array.isArray(config.pathOverrides)) {
    const paths = config.pathOverrides as Record<string, unknown>
    for (const [key, value] of Object.entries(paths)) {
      if (typeof value !== "string") continue
      const safe = withoutUrlCredentials(value, true)
      if (safe === undefined) delete paths[key]
      else paths[key] = safe
    }
  }
  if (config.passport && typeof config.passport === "object" && !Array.isArray(config.passport)) {
    const passport = config.passport as Record<string, unknown>
    if (typeof passport.apiBase === "string") {
      const safe = withoutUrlCredentials(passport.apiBase)
      if (safe === undefined) delete passport.apiBase
      else passport.apiBase = safe
    }
  }
  return {
    provider: source.provider,
    name,
    config,
    flagOverrides: { ...(source.flagOverrides ?? {}) },
    disabledPublicModelIds: [...source.disabledPublicModelIds],
    proxyFallbackList: (source.proxyFallbackList ?? []).map((entry) => ({
      id: entry.id,
      ...(entry.colos ? { colos: [...entry.colos] } : {}),
    })),
  }
}

export function isFreshCredential(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed !== "***"
}
