/**
 * Upstreams control-plane router — Week 5a-impl.
 *
 * Ported 1:1 from old src/routes/control-plane.ts (Elysia → Hono). JSON
 * shapes, status codes, mount paths, and admin-only access match the old
 * project verbatim so the dashboard sees no diff.
 *
 * Auth: handlers read `c.get('auth')` (set by upstream middleware which
 * is not yet ported in vnext). Tests inject auth via a pre-middleware.
 *
 * Mount paths (preserved from old project):
 *   GET    /api/upstream-flags          → upstreamMiscRouter
 *   POST   /api/upstream-probe          → upstreamMiscRouter
 *   GET    /api/upstreams               → upstreamsRouter
 *   POST   /api/upstreams               → upstreamsRouter
 *   PATCH  /api/upstreams/:id           → upstreamsRouter
 *   DELETE /api/upstreams/:id           → upstreamsRouter
 *   POST   /api/upstreams/:id/test      → upstreamsRouter
 *   GET    /api/upstreams/:id/models    → upstreamsRouter
 *
 * Deferred (Azure/Custom providers not yet ported to vnext):
 *   - POST /api/upstream-probe with kind=azure/custom → 501
 *   - POST /api/upstreams with provider=azure/custom is accepted (config
 *     normalised + persisted), but /:id/test and /:id/models return 502
 *     because createProviderFromUpstream returns null.
 *   - invalidateUpstreamCaches only clears the raw-models cache; other
 *     caches (upstream-list, copilot-token) are not in vnext yet.
 */
import { Hono } from 'hono'
import type { Env } from '../../app.ts'
import type { UpstreamKind, EndpointKey } from '@vnext-llm/protocols/common'
import { getRepo } from '../../shared/repo/index.ts'
import type { UpstreamRecord } from '../../shared/repo/types.ts'
import {
  getFlagCatalog,
  defaultsForUpstream,
} from '../../data-plane/flags/index.ts'
import { createProviderFromUpstream } from '../../data-plane/providers/registry.ts'
import { clearRawModelsCache } from '@vnext-llm/provider-copilot'
import { CustomProvider } from '@vnext/provider-custom'
import type { CustomProviderConfig as PkgCustomConfig } from '@vnext/provider-custom'
import { AzureProvider } from '@vnext/provider-azure'
import type { AzureProviderConfig as PkgAzureConfig } from '@vnext/provider-azure'
import { SdfProvider } from '@vnext/provider-sdf'
import type { SdfProviderConfig as PkgSdfConfig } from '@vnext/provider-sdf'

export interface AuthCtx {
  isAdmin?: boolean
  isUser?: boolean
  userId?: string
}

type Vars = { auth: AuthCtx }

const KINDS: readonly UpstreamKind[] = ['copilot', 'custom', 'azure', 'sdf']

const ENDPOINTS = new Set<EndpointKey>([
  'chat_completions',
  'responses',
  'messages',
  'messages_count_tokens',
  'embeddings',
  'images_generations',
  'images_edits',
])

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

interface CustomProviderConfig {
  name: string
  baseUrl: string
  apiKey: string
  endpoints: EndpointKey[]
  modelsEndpoint?: string
  defaultHeaders?: Record<string, string>
  models?: Array<{ id: string; name?: string; ownedBy?: string }>
}

interface AzureProviderConfig {
  name: string
  endpoint: string
  apiKey: string
  deployment: string
  apiVersion: string
  endpoints: EndpointKey[]
  defaultHeaders?: Record<string, string>
  deployments?: Array<{ name: string; model: string }>
}

interface SdfProviderConfig {
  name: string
  substrateToken: string
}

function isAdmin(c: { get: (k: 'auth') => AuthCtx | undefined }): boolean {
  return !!c.get('auth')?.isAdmin
}

function authUserId(c: { get: (k: 'auth') => AuthCtx | undefined }): string | undefined {
  return c.get('auth')?.userId
}

function jsonError(message: string, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function sanitizeIdPart(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'upstream'
}

function upstreamId(provider: UpstreamKind, name: string): string {
  return `up_${provider}_${sanitizeIdPart(name)}_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
}

function parseEndpoints(value: unknown, fallback: readonly EndpointKey[]): EndpointKey[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) throw new Error('endpoints must be an array')
  const endpoints = value.map((v) => {
    if (typeof v !== 'string' || !ENDPOINTS.has(v as EndpointKey)) {
      throw new Error(`unknown endpoint: ${String(v)}`)
    }
    return v as EndpointKey
  })
  return [...new Set(endpoints)]
}

function normalizeDisabledPublicModelIds(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('disabledPublicModelIds must be an array of strings')
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') throw new Error('disabledPublicModelIds entries must be strings')
    const trimmed = item.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function normalizeFlagOverrides(value: unknown): Record<string, boolean> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('flagOverrides must be an object')
  }
  const known = new Set(getFlagCatalog().map((f) => f.id))
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(value)) {
    if (!known.has(k)) throw new Error(`unknown flag override: ${k}`)
    if (typeof v !== 'boolean') throw new Error(`flag override must be boolean: ${k}`)
    out[k] = v
  }
  return out
}

function normalizeProvider(provider: unknown): UpstreamKind {
  if (provider === 'copilot' || provider === 'custom' || provider === 'azure' || provider === 'sdf') return provider
  throw new Error(`Unknown provider: ${String(provider)}`)
}

function normalizeStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`)
  }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new Error(`${field}.${k} must be a string`)
    out[k] = v
  }
  return out
}

function parseManualModels(value: unknown): CustomProviderConfig['models'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) {
    throw new Error('models must be an array of strings or { id, name?, ownedBy? }')
  }
  const out: Array<{ id: string; name?: string; ownedBy?: string }> = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (!id) throw new Error('models[] entry must be a non-empty string')
      out.push({ id })
      continue
    }
    if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      const e = entry as { id: string; name?: unknown; ownedBy?: unknown }
      const id = e.id.trim()
      if (!id) throw new Error('models[].id must be a non-empty string')
      out.push({
        id,
        name: typeof e.name === 'string' ? e.name : undefined,
        ownedBy: typeof e.ownedBy === 'string' ? e.ownedBy : undefined,
      })
      continue
    }
    throw new Error('models[] entry must be a string or { id, name?, ownedBy? } object')
  }
  return out.length > 0 ? out : undefined
}

function parseAzureDeployments(value: unknown): AzureProviderConfig['deployments'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('deployments must be an array of { name, model }')
  const out: Array<{ name: string; model: string }> = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') throw new Error('deployments[] entry must be an object')
    const e = entry as { name?: unknown; model?: unknown }
    if (typeof e.name !== 'string' || !e.name.trim()) throw new Error('deployments[].name required')
    if (typeof e.model !== 'string' || !e.model.trim()) throw new Error('deployments[].model required')
    out.push({ name: e.name.trim(), model: e.model.trim() })
  }
  return out.length > 0 ? out : undefined
}

function normalizeCustomConfig(config: Record<string, unknown>): CustomProviderConfig {
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error('custom config.name required')
  if (typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) throw new Error('custom config.baseUrl required')
  if (typeof config.apiKey !== 'string' || !config.apiKey) throw new Error('custom config.apiKey required')
  return {
    name: config.name.trim(),
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey,
    endpoints: parseEndpoints(config.endpoints, ['chat_completions', 'embeddings']),
    modelsEndpoint:
      typeof config.modelsEndpoint === 'string' && config.modelsEndpoint.trim()
        ? config.modelsEndpoint.trim()
        : undefined,
    defaultHeaders: normalizeStringRecord(config.defaultHeaders, 'defaultHeaders'),
    models: parseManualModels(config.models),
  }
}

function normalizeAzureConfig(config: Record<string, unknown>): AzureProviderConfig {
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error('azure config.name required')
  if (typeof config.endpoint !== 'string' || !config.endpoint.trim()) throw new Error('azure config.endpoint required')
  if (typeof config.apiKey !== 'string' || !config.apiKey) throw new Error('azure config.apiKey required')
  if (typeof config.deployment !== 'string' || !config.deployment.trim()) {
    throw new Error('azure config.deployment required')
  }
  if (typeof config.apiVersion !== 'string' || !config.apiVersion.trim()) {
    throw new Error('azure config.apiVersion required')
  }
  return {
    name: config.name.trim(),
    endpoint: config.endpoint.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey,
    deployment: config.deployment.trim(),
    apiVersion: config.apiVersion.trim(),
    endpoints: parseEndpoints(config.endpoints, ['chat_completions']),
    defaultHeaders: normalizeStringRecord(config.defaultHeaders, 'defaultHeaders'),
    deployments: parseAzureDeployments(config.deployments),
  }
}

function normalizeCopilotConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof config.githubToken !== 'string' || !config.githubToken) {
    throw new Error('copilot config.githubToken required')
  }
  if (typeof config.accountType !== 'string' || !config.accountType) {
    throw new Error('copilot config.accountType required')
  }
  return config
}

function normalizeSdfConfig(config: Record<string, unknown>): SdfProviderConfig {
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error('sdf config.name required')
  if (typeof config.substrateToken !== 'string' || !config.substrateToken) {
    throw new Error('sdf config.substrateToken required')
  }
  return {
    name: config.name.trim(),
    substrateToken: config.substrateToken,
  }
}

function normalizeConfig(provider: UpstreamKind, config: unknown): Record<string, unknown> {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be an object')
  }
  const raw = config as Record<string, unknown>
  if (provider === 'custom') return normalizeCustomConfig(raw) as unknown as Record<string, unknown>
  if (provider === 'azure') return normalizeAzureConfig(raw) as unknown as Record<string, unknown>
  if (provider === 'sdf') return normalizeSdfConfig(raw) as unknown as Record<string, unknown>
  return normalizeCopilotConfig(raw)
}

function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value)) {
    if (/token|apikey|api_key|authorization|password|secret/i.test(k)) out[k] = v ? '***' : v
    else out[k] = redactConfig(v)
  }
  return out
}

function serializeUpstream(
  upstream: UpstreamRecord,
): Omit<UpstreamRecord, 'config'> & { config: Record<string, unknown> } {
  return { ...upstream, config: redactConfig(upstream.config) as Record<string, unknown> }
}

/**
 * Drop caches that may now be serving stale state after every CRUD on
 * /api/upstreams. In vnext we only have the raw-models cache so far;
 * upstream-list cache and copilot-token cache are TODOs that will be
 * wired here once they land.
 */
async function invalidateUpstreamCaches(
  _before: UpstreamRecord | null,
  _after: UpstreamRecord | null,
): Promise<void> {
  clearRawModelsCache()
  // TODO(Week 5+): invalidateUpstreamListCache() once registry adds a list cache.
  // TODO(Week 5+): invalidateCopilotToken(token, accountType, cacheRepo) once
  //                copilot-token-cache module is ported.
}

// ─────────────────────────────────────────────────────────────────────────────
// Router 1: upstream-flags / upstream-probe (mounted at controlPlane root)
// ─────────────────────────────────────────────────────────────────────────────
export const upstreamMiscRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

upstreamMiscRouter.get('/upstream-flags', (c) => {
  if (!isAdmin(c)) return jsonError('Forbidden', 403)
  const catalog = getFlagCatalog().map((f) => ({
    id: f.id,
    label: f.label,
    description: f.description,
    defaultFor: f.defaultFor,
  }))
  const defaults: Record<string, string[]> = {}
  for (const k of KINDS) defaults[k] = [...defaultsForUpstream(k)]
  return c.json({ catalog, defaults })
})

upstreamMiscRouter.post('/upstream-probe', async (c) => {
  if (!isAdmin(c)) return jsonError('Forbidden', 403)
  let body: ProbeBody
  try {
    body = (await c.req.json()) as ProbeBody
  } catch {
    body = {}
  }
  const kind = body.kind
  const config = body.config
  if (typeof kind !== 'string' || !config) {
    return jsonError('kind and config required')
  }
  if (kind === 'copilot') {
    return jsonError('Copilot probe uses /api/copilot-quota — not handled here')
  }
  if (kind === 'custom' || kind === 'azure') {
    try {
      const provider = kind === 'custom'
        ? new CustomProvider(normalizeCustomConfig(config as Record<string, unknown>) as PkgCustomConfig)
        : new AzureProvider(normalizeAzureConfig(config as Record<string, unknown>) as PkgAzureConfig)
      const result = await provider.probe()
      return c.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return jsonError(message, 400)
    }
  }
  if (kind === 'sdf') {
    try {
      const provider = new SdfProvider(normalizeSdfConfig(config as Record<string, unknown>) as PkgSdfConfig)
      const result = await provider.probe()
      return c.json(result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return jsonError(message, 400)
    }
  }
  return jsonError(`Unknown kind: ${kind}`)
})

// ─────────────────────────────────────────────────────────────────────────────
// Router 2: /api/upstreams (CRUD + test + models)
// ─────────────────────────────────────────────────────────────────────────────
export const upstreamsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

upstreamsRouter.get('/_health', (c) => c.json({ scope: 'control-plane:upstreams', status: 'scaffold' }))

upstreamsRouter.get('/', async (c) => {
  const admin = isAdmin(c)
  const userId = authUserId(c)
  if (!admin && !userId) return jsonError('Forbidden', 403)
  const url = new URL(c.req.url)
  const ownerId = admin ? (url.searchParams.get('ownerId') ?? undefined) : userId
  const includeDisabled = url.searchParams.get('includeDisabled') === '1'
  const upstreams = await getRepo().upstreams.list({ ownerId, includeDisabled })
  return c.json({ upstreams: upstreams.map(serializeUpstream) })
})

upstreamsRouter.post('/', async (c) => {
  const admin = isAdmin(c)
  const userId = authUserId(c)
  if (!admin && !userId) return jsonError('Forbidden', 403)
  try {
    let body: UpstreamBody
    try {
      body = (await c.req.json()) as UpstreamBody
    } catch {
      body = {}
    }
    const provider = normalizeProvider(body.provider)
    if (typeof body.name !== 'string' || !body.name.trim()) return jsonError('name required')
    const now = new Date().toISOString()
    const ownerId = admin
      ? (typeof body.ownerId === 'string' ? body.ownerId : '')
      : userId
    if (ownerId === undefined) return jsonError('ownerId required', 400)
    const upstream: UpstreamRecord = {
      id: upstreamId(provider, body.name),
      ownerId,
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
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err))
  }
})

upstreamsRouter.patch('/:id', async (c) => {
  const admin = isAdmin(c)
  const userId = authUserId(c)
  if (!admin && !userId) return jsonError('Forbidden', 403)
  const id = c.req.param('id')
  const existing = await getRepo().upstreams.getById(id)
  if (!existing) return jsonError('upstream not found', 404)
  if (!admin && existing.ownerId !== userId) return jsonError('Forbidden', 403)
  try {
    let body: UpstreamBody
    try {
      body = (await c.req.json()) as UpstreamBody
    } catch {
      body = {}
    }
    if (body.provider !== undefined && body.provider !== existing.provider) {
      return jsonError('provider cannot be changed')
    }
    // Copilot upstreams are token-managed via device flow; admin can only
    // tweak name / enabled / sortOrder / flagOverrides here.
    if (existing.provider === 'copilot' && body.config !== undefined) {
      return jsonError('config of copilot upstreams is managed by device-flow auth')
    }
    // Shallow-merge config keys onto existing, then re-normalise. The literal
    // '***' value means "keep current" — the UI uses this sentinel when the
    // admin left the password field blank, since list/get redact secrets.
    let mergedConfig: Record<string, unknown> | undefined
    if (body.config !== undefined) {
      const incoming = body.config as Record<string, unknown>
      const merged: Record<string, unknown> = { ...existing.config }
      for (const [k, v] of Object.entries(incoming)) {
        if (v === '***') continue
        merged[k] = v
      }
      mergedConfig = merged
    }
    const next: UpstreamRecord = {
      ...existing,
      ownerId: admin && typeof body.ownerId === 'string' && body.ownerId ? body.ownerId : existing.ownerId,
      name: typeof body.name === 'string' ? body.name.trim() : existing.name,
      enabled: typeof body.enabled === 'boolean' ? body.enabled : existing.enabled,
      sortOrder: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : existing.sortOrder,
      config: mergedConfig !== undefined ? normalizeConfig(existing.provider, mergedConfig) : existing.config,
      flagOverrides:
        body.flagOverrides !== undefined ? normalizeFlagOverrides(body.flagOverrides) : existing.flagOverrides,
      disabledPublicModelIds:
        body.disabledPublicModelIds === undefined
          ? existing.disabledPublicModelIds
          : normalizeDisabledPublicModelIds(body.disabledPublicModelIds),
      updatedAt: new Date().toISOString(),
    }
    if (!next.name) return jsonError('name required')
    await getRepo().upstreams.save(next)
    await invalidateUpstreamCaches(existing, next)
    return c.json({ upstream: serializeUpstream(next) })
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : String(err))
  }
})

upstreamsRouter.delete('/:id', async (c) => {
  const admin = isAdmin(c)
  const userId = authUserId(c)
  if (!admin && !userId) return jsonError('Forbidden', 403)
  const id = c.req.param('id')
  const existing = await getRepo().upstreams.getById(id)
  if (existing && !admin && existing.ownerId !== userId) return jsonError('Forbidden', 403)
  // For copilot upstreams, cascade-delete the github_accounts row so the
  // legacy token store doesn't keep a now-orphan account around.
  if (existing?.provider === 'copilot') {
    const userId = (existing.config as { user?: { id?: number } } | undefined)?.user?.id
    if (typeof userId === 'number') {
      try {
        await getRepo().github.deleteAccount(userId, existing.ownerId ?? '')
      } catch {}
    }
  }
  const ok = await getRepo().upstreams.delete(id)
  if (!ok) return jsonError('upstream not found', 404)
  await invalidateUpstreamCaches(existing, null)
  return c.json({ ok: true })
})

upstreamsRouter.post('/:id/test', async (c) => {
  const admin = isAdmin(c)
  const userId = authUserId(c)
  if (!admin && !userId) return jsonError('Forbidden', 403)
  const upstream = await getRepo().upstreams.getById(c.req.param('id'))
  if (!upstream) return jsonError('upstream not found', 404)
  if (!admin && upstream.ownerId !== userId) return jsonError('Forbidden', 403)
  const provider = await createProviderFromUpstream(upstream)
  if (!provider) {
    return jsonError(`unable to construct ${upstream.provider} provider for upstream ${upstream.id}`, 502)
  }
  return c.json(await provider.probe())
})

upstreamsRouter.get('/:id/models', async (c) => {
  const admin = isAdmin(c)
  const userId = authUserId(c)
  if (!admin && !userId) return jsonError('Forbidden', 403)
  const upstream = await getRepo().upstreams.getById(c.req.param('id'))
  if (!upstream) return jsonError('upstream not found', 404)
  if (!admin && upstream.ownerId !== userId) return jsonError('Forbidden', 403)
  const provider = await createProviderFromUpstream(upstream)
  if (!provider) {
    return jsonError(`unable to construct ${upstream.provider} provider for upstream ${upstream.id}`, 502)
  }
  try {
    const models = await provider.getModels()
    const list = (models.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
    return c.json({ models: list, disabledPublicModelIds: upstream.disabledPublicModelIds })
  } catch (err) {
    return jsonError(`failed to list models: ${err instanceof Error ? err.message : String(err)}`, 502)
  }
})
