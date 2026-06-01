/**
 * Admin control-plane endpoints not yet covered by the main route surface.
 *
 *   GET  /api/upstream-flags            — flag catalog (id, label, description, defaults per kind)
 *   POST /api/upstream-probe            — connectivity probe for an inline provider config
 *
 * The probe accepts a provider kind + inline config (the same shape the
 * dashboard would persist) and reports whether the provider can answer a
 * lightweight call. Admin-only because configs include secrets.
 */

import { Elysia } from "elysia"

import { getFlagCatalog, defaultsForUpstream } from "~/flags"
import type { UpstreamKind, EndpointKey } from "~/protocols/common"
import { getRepo } from "~/repo"
import type { UpstreamRecord } from "~/repo"
import { AzureProvider, type AzureProviderConfig } from "~/providers/azure/provider"
import { CustomProvider, type CustomProviderConfig } from "~/providers/custom/provider"
import { createProviderFromUpstream, invalidateUpstreamListCache } from "~/providers/registry"
import type { ProbeResult } from "~/providers/types"
import { clearRawModelsCache } from "~/services/copilot/raw-models-cache"
import { invalidateCopilotToken } from "~/services/github/copilot-token-cache"

interface AuthCtx {
  isAdmin?: boolean
}

const KINDS: readonly UpstreamKind[] = ["copilot", "custom", "azure"]

interface ProbeBody {
  kind?: string
  config?: Record<string, unknown>
}

interface UpstreamBody {
  ownerId?: string
  provider?: string
  name?: string
  enabled?: boolean
  sortOrder?: number
  config?: Record<string, unknown>
  flagOverrides?: Record<string, unknown>
  disabledPublicModelIds?: unknown
}

const ENDPOINTS = new Set<EndpointKey>(["chat_completions", "responses", "messages", "messages_count_tokens", "embeddings"])

function adminGuard(ctx: unknown): Response | null {
  const { isAdmin } = ctx as AuthCtx
  if (!isAdmin) {
    return jsonError("Forbidden", 403)
  }
  return null
}

function jsonError(error: string, status = 400): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function sanitizeIdPart(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "upstream"
}

function upstreamId(provider: UpstreamKind, name: string): string {
  return `up_${provider}_${sanitizeIdPart(name)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`
}

function parseEndpoints(value: unknown, fallback: readonly EndpointKey[]): EndpointKey[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) throw new Error("endpoints must be an array")
  const endpoints = value.map((v) => {
    if (typeof v !== "string" || !ENDPOINTS.has(v as EndpointKey)) throw new Error(`unknown endpoint: ${String(v)}`)
    return v as EndpointKey
  })
  return [...new Set(endpoints)]
}

function normalizeDisabledPublicModelIds(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("disabledPublicModelIds must be an array of strings")
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string") throw new Error("disabledPublicModelIds entries must be strings")
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function normalizeFlagOverrides(value: unknown): Record<string, boolean> {
  if (value === undefined) return {}
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("flagOverrides must be an object")
  const known = new Set(getFlagCatalog().map((f) => f.id))
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!known.has(k)) throw new Error(`unknown flag override: ${k}`)
    if (typeof v !== "boolean") throw new Error(`flag override must be boolean: ${k}`)
    out[k] = v
  }
  return out
}

function normalizeProvider(provider: unknown): UpstreamKind {
  if (provider === "copilot" || provider === "custom" || provider === "azure") return provider
  throw new Error(`Unknown provider: ${String(provider)}`)
}

function normalizeCustomConfig(config: Record<string, unknown>): CustomProviderConfig {
  if (typeof config.name !== "string" || !config.name.trim()) throw new Error("custom config.name required")
  if (typeof config.baseUrl !== "string" || !config.baseUrl.trim()) throw new Error("custom config.baseUrl required")
  if (typeof config.apiKey !== "string" || !config.apiKey) throw new Error("custom config.apiKey required")
  return {
    name: config.name.trim(),
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
    apiKey: config.apiKey,
    endpoints: parseEndpoints(config.endpoints, ["chat_completions", "embeddings"]),
    modelsEndpoint: typeof config.modelsEndpoint === "string" && config.modelsEndpoint.trim() ? config.modelsEndpoint.trim() : undefined,
    defaultHeaders: normalizeStringRecord(config.defaultHeaders, "defaultHeaders"),
    models: parseManualModels(config.models),
  }
}

function parseManualModels(value: unknown): CustomProviderConfig["models"] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error("models must be an array of strings or { id, name?, ownedBy? }")
  const out: Array<{ id: string; name?: string; ownedBy?: string }> = []
  for (const entry of value) {
    if (typeof entry === "string") {
      const id = entry.trim()
      if (!id) throw new Error("models[] entry must be a non-empty string")
      out.push({ id })
      continue
    }
    if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
      const e = entry as { id: string; name?: unknown; ownedBy?: unknown }
      const id = e.id.trim()
      if (!id) throw new Error("models[].id must be a non-empty string")
      out.push({
        id,
        name: typeof e.name === "string" ? e.name : undefined,
        ownedBy: typeof e.ownedBy === "string" ? e.ownedBy : undefined,
      })
      continue
    }
    throw new Error("models[] entry must be a string or { id, name?, ownedBy? } object")
  }
  return out.length > 0 ? out : undefined
}

function normalizeAzureConfig(config: Record<string, unknown>): AzureProviderConfig {
  if (typeof config.name !== "string" || !config.name.trim()) throw new Error("azure config.name required")
  if (typeof config.endpoint !== "string" || !config.endpoint.trim()) throw new Error("azure config.endpoint required")
  if (typeof config.apiKey !== "string" || !config.apiKey) throw new Error("azure config.apiKey required")
  if (typeof config.deployment !== "string" || !config.deployment.trim()) throw new Error("azure config.deployment required")
  if (typeof config.apiVersion !== "string" || !config.apiVersion.trim()) throw new Error("azure config.apiVersion required")
  return {
    name: config.name.trim(),
    endpoint: config.endpoint.trim().replace(/\/+$/, ""),
    apiKey: config.apiKey,
    deployment: config.deployment.trim(),
    apiVersion: config.apiVersion.trim(),
    endpoints: parseEndpoints(config.endpoints, ["chat_completions"]),
    defaultHeaders: normalizeStringRecord(config.defaultHeaders, "defaultHeaders"),
    deployments: parseAzureDeployments(config.deployments),
  }
}

function parseAzureDeployments(value: unknown): AzureProviderConfig["deployments"] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error("deployments must be an array of { name, model }")
  const out: Array<{ name: string; model: string }> = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") throw new Error("deployments[] entry must be an object")
    const e = entry as { name?: unknown; model?: unknown }
    if (typeof e.name !== "string" || !e.name.trim()) throw new Error("deployments[].name required")
    if (typeof e.model !== "string" || !e.model.trim()) throw new Error("deployments[].model required")
    out.push({ name: e.name.trim(), model: e.model.trim() })
  }
  return out.length > 0 ? out : undefined
}

function normalizeCopilotConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.githubToken !== "string" || !config.githubToken) throw new Error("copilot config.githubToken required")
  if (typeof config.accountType !== "string" || !config.accountType) throw new Error("copilot config.accountType required")
  return config
}

function normalizeStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`)
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") throw new Error(`${field}.${k} must be a string`)
    out[k] = v
  }
  return out
}

function normalizeConfig(provider: UpstreamKind, config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("config must be an object")
  const raw = config as Record<string, unknown>
  if (provider === "custom") return normalizeCustomConfig(raw) as unknown as Record<string, unknown>
  if (provider === "azure") return normalizeAzureConfig(raw) as unknown as Record<string, unknown>
  return normalizeCopilotConfig(raw)
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (!value || typeof value !== "object") return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (/token|apikey|api_key|authorization|password|secret/i.test(k)) out[k] = v ? "***" : v
    else out[k] = redactConfig(v)
  }
  return out
}

function serializeUpstream(upstream: UpstreamRecord): Omit<UpstreamRecord, "config"> & { config: Record<string, unknown> } {
  return { ...upstream, config: redactConfig(upstream.config) as Record<string, unknown> }
}

/**
 * Drop caches that may now be serving stale state. Called after every CRUD
 * on /api/upstreams so the next request rediscovers the new config instead
 * of waiting out the per-cache TTL.
 *
 * - clearRawModelsCache(): the per-Copilot-token model list snapshot.
 * - invalidateCopilotToken(github,account): the exchanged session token —
 *   only needed when the GitHub credential or accountType themselves
 *   changed, since otherwise the existing session is still valid.
 */
async function invalidateUpstreamCaches(
  before: UpstreamRecord | null,
  after: UpstreamRecord | null,
): Promise<void> {
  invalidateUpstreamListCache()
  clearRawModelsCache()
  const repo = (() => { try { return getRepo().cache } catch { return undefined } })()
  for (const u of [before, after]) {
    if (!u || u.provider !== "copilot") continue
    const cfg = u.config
    const tok = typeof cfg.githubToken === "string" ? cfg.githubToken : undefined
    if (!tok) continue
    const acct = (typeof cfg.accountType === "string" ? cfg.accountType : "individual") as "individual" | "business" | "enterprise"
    await invalidateCopilotToken(tok, acct, repo)
  }
}

async function probeUpstream(upstream: UpstreamRecord): Promise<ProbeResult> {
  const provider = await createProviderFromUpstream(upstream)
  if (!provider) return { ok: false, error: `unable to construct ${upstream.provider} provider for upstream ${upstream.id}` }
  return provider.probe()
}

async function probeCustom(cfg: CustomProviderConfig): Promise<ProbeResult> {
  return new CustomProvider(cfg).probe()
}

async function probeAzure(cfg: AzureProviderConfig): Promise<ProbeResult> {
  return new AzureProvider(cfg).probe()
}

export const controlPlaneRoute = new Elysia()
  .get("/api/upstream-flags", (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const catalog = getFlagCatalog().map((f) => ({
      id: f.id,
      label: f.label,
      description: f.description,
      defaultFor: f.defaultFor,
    }))
    const defaults: Record<string, string[]> = {}
    for (const k of KINDS) defaults[k] = [...defaultsForUpstream(k)]
    return { catalog, defaults }
  })
  .post("/api/upstream-probe", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const body = (ctx.body ?? {}) as ProbeBody
    const kind = body.kind
    const config = body.config
    if (typeof kind !== "string" || !config) {
      return jsonError("kind and config required")
    }
    if (kind === "custom") return probeCustom(config as unknown as CustomProviderConfig)
    if (kind === "azure") return probeAzure(config as unknown as AzureProviderConfig)
    if (kind === "copilot") {
      return jsonError("Copilot probe uses /api/copilot-quota — not handled here")
    }
    return jsonError(`Unknown kind: ${kind}`)
  })
  .get("/api/upstreams", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const url = new URL(ctx.request.url)
    const ownerId = url.searchParams.get("ownerId") ?? undefined
    const includeDisabled = url.searchParams.get("includeDisabled") === "1"
    const upstreams = await getRepo().upstreams.list({ ownerId, includeDisabled })
    return { upstreams: upstreams.map(serializeUpstream) }
  })
  .post("/api/upstreams", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    try {
      const body = (ctx.body ?? {}) as UpstreamBody
      const provider = normalizeProvider(body.provider)
      if (typeof body.name !== "string" || !body.name.trim()) return jsonError("name required")
      const now = new Date().toISOString()
      const upstream: UpstreamRecord = {
        id: upstreamId(provider, body.name),
        ownerId: body.ownerId,
        provider,
        name: body.name.trim(),
        enabled: body.enabled !== false,
        sortOrder: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : 0,
        config: normalizeConfig(provider, body.config),
        flagOverrides: normalizeFlagOverrides(body.flagOverrides),
        disabledPublicModelIds: normalizeDisabledPublicModelIds(body.disabledPublicModelIds),
        createdAt: now,
        updatedAt: now,
      }
      await getRepo().upstreams.save(upstream)
      await invalidateUpstreamCaches(null, upstream)
      return new Response(JSON.stringify({ upstream: serializeUpstream(upstream) }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      })
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err))
    }
  })
  .patch("/api/upstreams/:id", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const id = ctx.params.id
    const existing = await getRepo().upstreams.getById(id)
    if (!existing) return jsonError("upstream not found", 404)
    try {
      const body = (ctx.body ?? {}) as UpstreamBody
      if (body.provider !== undefined && body.provider !== existing.provider) return jsonError("provider cannot be changed")
      // Copilot upstreams are token-managed via device flow; only allow the
      // admin to tweak name / enabled / sortOrder / flagOverrides here.
      if (existing.provider === "copilot" && body.config !== undefined) {
        return jsonError("config of copilot upstreams is managed by device-flow auth")
      }
      // For config PATCH, shallow-merge the supplied keys onto the existing
      // config and then run the strict normalizer. This lets the UI send
      // partial updates (e.g. just `{ name: ... }`) without having to repeat
      // baseUrl / apiKey / deployment. A literal '***' value means "keep
      // current" — the UI uses this sentinel when the admin left the
      // password field blank, since /api/upstreams/* redacts secrets.
      let mergedConfig: Record<string, unknown> | undefined
      if (body.config !== undefined) {
        const incoming = body.config as Record<string, unknown>
        mergedConfig = { ...existing.config }
        for (const [k, v] of Object.entries(incoming)) {
          if (v === "***") continue
          mergedConfig[k] = v
        }
      }
      const next: UpstreamRecord = {
        ...existing,
        ownerId: body.ownerId !== undefined ? body.ownerId : existing.ownerId,
        name: typeof body.name === "string" ? body.name.trim() : existing.name,
        enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
        sortOrder: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : existing.sortOrder,
        config: mergedConfig !== undefined ? normalizeConfig(existing.provider, mergedConfig) : existing.config,
        flagOverrides: body.flagOverrides !== undefined ? normalizeFlagOverrides(body.flagOverrides) : existing.flagOverrides,
        disabledPublicModelIds:
          body.disabledPublicModelIds === undefined
            ? existing.disabledPublicModelIds
            : normalizeDisabledPublicModelIds(body.disabledPublicModelIds),
        updatedAt: new Date().toISOString(),
      }
      if (!next.name) return jsonError("name required")
      await getRepo().upstreams.save(next)
      await invalidateUpstreamCaches(existing, next)
      return { upstream: serializeUpstream(next) }
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err))
    }
  })
  .delete("/api/upstreams/:id", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const existing = await getRepo().upstreams.getById(ctx.params.id)
    // For copilot upstreams, cascade-delete the github_accounts row so the
    // legacy token store doesn't keep a now-orphan account around.
    if (existing?.provider === "copilot") {
      const userId = (existing.config as { user?: { id?: number } } | undefined)?.user?.id
      if (typeof userId === "number") {
        try {
          await getRepo().github.deleteAccount(userId, existing.ownerId ?? "")
        } catch {}
      }
    }
    const ok = await getRepo().upstreams.delete(ctx.params.id)
    if (!ok) return jsonError("upstream not found", 404)
    await invalidateUpstreamCaches(existing, null)
    return { ok: true }
  })
  .post("/api/upstreams/:id/test", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const upstream = await getRepo().upstreams.getById(ctx.params.id)
    if (!upstream) return jsonError("upstream not found", 404)
    return probeUpstream(upstream)
  })
  .get("/api/upstreams/:id/models", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const upstream = await getRepo().upstreams.getById(ctx.params.id)
    if (!upstream) return jsonError("upstream not found", 404)
    const provider = await createProviderFromUpstream(upstream)
    if (!provider) return jsonError(`unable to construct ${upstream.provider} provider for upstream ${upstream.id}`, 502)
    try {
      const models = await provider.getModels()
      const list = (models.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
      return { models: list, disabledPublicModelIds: upstream.disabledPublicModelIds }
    } catch (err) {
      return jsonError(`failed to list models: ${err instanceof Error ? err.message : String(err)}`, 502)
    }
  })
