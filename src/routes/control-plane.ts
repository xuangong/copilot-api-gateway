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
import type { UpstreamKind, ModelEndpoint } from "~/protocols/common"
import { getRepo } from "~/repo"
import type { UpstreamRecord } from "~/repo"
import { AzureProvider, type AzureProviderConfig } from "~/providers/azure/provider"
import { CustomProvider, type CustomProviderConfig } from "~/providers/custom/provider"

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
}

const ENDPOINTS = new Set<ModelEndpoint>(["chat_completions", "responses", "messages", "messages_count_tokens", "embeddings"])

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

function parseEndpoints(value: unknown, fallback: readonly ModelEndpoint[]): ModelEndpoint[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) throw new Error("endpoints must be an array")
  const endpoints = value.map((v) => {
    if (typeof v !== "string" || !ENDPOINTS.has(v as ModelEndpoint)) throw new Error(`unknown endpoint: ${String(v)}`)
    return v as ModelEndpoint
  })
  return [...new Set(endpoints)]
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
  }
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
  }
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

async function probeUpstream(upstream: UpstreamRecord): Promise<{ ok: boolean; error?: string }> {
  if (upstream.provider === "custom") return probeCustom(upstream.config as unknown as CustomProviderConfig)
  if (upstream.provider === "azure") return probeAzure(upstream.config as unknown as AzureProviderConfig)
  return { ok: false, error: "Copilot probe uses /api/copilot-quota — not handled here" }
}

async function probeCustom(cfg: CustomProviderConfig): Promise<{ ok: boolean; error?: string }> {
  const provider = new CustomProvider(cfg)
  try {
    await provider.getModels()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function probeAzure(cfg: AzureProviderConfig): Promise<{ ok: boolean; error?: string }> {
  const provider = new AzureProvider(cfg)
  // Azure deployments don't expose a stable model-listing endpoint; the
  // provider returns a synthetic single-entry list. To make the probe
  // meaningful we hit the first declared endpoint with an empty body and
  // accept any non-network error response (the upstream's complaint about
  // the payload still proves connectivity + auth).
  const endpoint = provider.endpoints[0]
  if (!endpoint) return { ok: false, error: "no endpoints declared" }
  try {
    if (endpoint === "chat_completions") await provider.callChatCompletions({ messages: [] })
    else if (endpoint === "responses") await provider.callResponses({ input: [] })
    else if (endpoint === "messages") await provider.callMessages({ messages: [] })
    else if (endpoint === "embeddings") await provider.callEmbeddings({ input: "" })
    else await provider.callMessagesCountTokens({ messages: [] })
    return { ok: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 4xx from upstream proves connectivity; only network/auth errors are failures.
    if (/\b(4\d\d)\b/.test(msg) && !/401|403/.test(msg)) return { ok: true }
    return { ok: false, error: msg }
  }
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
        createdAt: now,
        updatedAt: now,
      }
      await getRepo().upstreams.save(upstream)
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
      const next: UpstreamRecord = {
        ...existing,
        ownerId: body.ownerId !== undefined ? body.ownerId : existing.ownerId,
        name: typeof body.name === "string" ? body.name.trim() : existing.name,
        enabled: typeof body.enabled === "boolean" ? body.enabled : existing.enabled,
        sortOrder: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : existing.sortOrder,
        config: body.config !== undefined ? normalizeConfig(existing.provider, body.config) : existing.config,
        flagOverrides: body.flagOverrides !== undefined ? normalizeFlagOverrides(body.flagOverrides) : existing.flagOverrides,
        updatedAt: new Date().toISOString(),
      }
      if (!next.name) return jsonError("name required")
      await getRepo().upstreams.save(next)
      return { upstream: serializeUpstream(next) }
    } catch (err) {
      return jsonError(err instanceof Error ? err.message : String(err))
    }
  })
  .delete("/api/upstreams/:id", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const ok = await getRepo().upstreams.delete(ctx.params.id)
    if (!ok) return jsonError("upstream not found", 404)
    return { ok: true }
  })
  .post("/api/upstreams/:id/test", async (ctx) => {
    const denied = adminGuard(ctx)
    if (denied) return denied
    const upstream = await getRepo().upstreams.getById(ctx.params.id)
    if (!upstream) return jsonError("upstream not found", 404)
    return probeUpstream(upstream)
  })
