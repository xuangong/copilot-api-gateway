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
import { z } from 'zod'
import type { Env } from '../../app.ts'
import type { UpstreamKind, EndpointKey } from '@vibe-llm/protocols/common'
import { zValidator } from '../middleware/zod-validator.ts'
import { loadOwned } from '../shared/ownership.ts'
import { getRepo } from '../../repo/index.ts'
import type { UpstreamRecord } from '../../repo/types.ts'
import type { GitHubAccountId, UpstreamId, UserId } from '../../repo/branded-ids.ts'
import {
  getFlagCatalog,
  defaultsForUpstream,
} from '../../data-plane/flags/index.ts'
import { createProviderFromUpstream } from '../../data-plane/providers/registry.ts'
import { createPerRequestFetcher } from '../../data-plane/dial/per-request.ts'
import { getRuntimeLocation } from '@vibe-core/platform'
import type { Fetcher } from '@vibe-core/upstream'
import { clearRawModelsCache } from '@vibe-llm/provider-copilot'
import { CustomProvider } from '@vibe-llm/provider-custom'
import type { CustomProviderConfig as PkgCustomConfig } from '@vibe-llm/provider-custom'
import { AzureProvider } from '@vibe-llm/provider-azure'
import type { AzureProviderConfig as PkgAzureConfig } from '@vibe-llm/provider-azure'
import { SdfProvider } from '@vibe-llm/provider-sdf'
import type { SdfProviderConfig as PkgSdfConfig } from '@vibe-llm/provider-sdf'

export interface AuthCtx {
  isAdmin?: boolean
  isUser?: boolean
  userId?: UserId
}

type Vars = { auth: AuthCtx }

const KINDS = ['copilot', 'custom', 'azure', 'sdf'] as const satisfies readonly UpstreamKind[]

const ENDPOINTS = new Set<EndpointKey>([
  'chat_completions',
  'responses',
  'messages',
  'messages_count_tokens',
  'embeddings',
  'images_generations',
  'images_edits',
] as const satisfies readonly EndpointKey[])

// Zod schemas for probe + CRUD bodies. Deliberately lenient — the extensive
// per-provider config validation lives in normalize*Config helpers so we can
// keep detailed, user-facing error messages; zod just gives us shape + typed
// c.req.valid('json') for the trivial top-level fields.
const probeBody = z.object({
  kind: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
})

const upstreamBody = z.object({
  ownerId: z.string().optional(),
  provider: z.string().optional(),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  flagOverrides: z.record(z.string(), z.unknown()).optional(),
  disabledPublicModelIds: z.unknown().optional(),
})

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
  taxonomy?: PkgSdfConfig['taxonomy']
  cos?: PkgSdfConfig['cos']
  passport?: PkgSdfConfig['passport']
}

function isAdmin(c: { get: (k: 'auth') => AuthCtx | undefined }): boolean {
  return !!c.get('auth')?.isAdmin
}

function authUserId(c: { get: (k: 'auth') => AuthCtx | undefined }): UserId | undefined {
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
      const name = typeof e.name === 'string' ? e.name : undefined
      const ownedBy = typeof e.ownedBy === 'string' ? e.ownedBy : undefined
      out.push({
        id,
        name,
        ownedBy,
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
  const modelsEndpoint =
    typeof config.modelsEndpoint === 'string' && config.modelsEndpoint.trim()
      ? config.modelsEndpoint.trim()
      : undefined
  const defaultHeaders = normalizeStringRecord(config.defaultHeaders, 'defaultHeaders')
  const models = parseManualModels(config.models)
  return {
    name: config.name.trim(),
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey,
    endpoints: parseEndpoints(config.endpoints, ['chat_completions', 'embeddings']),
    modelsEndpoint,
    defaultHeaders,
    models,
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
  const defaultHeaders = normalizeStringRecord(config.defaultHeaders, 'defaultHeaders')
  const deployments = parseAzureDeployments(config.deployments)
  return {
    name: config.name.trim(),
    endpoint: config.endpoint.trim().replace(/\/+$/, ''),
    apiKey: config.apiKey,
    deployment: config.deployment.trim(),
    apiVersion: config.apiVersion.trim(),
    endpoints: parseEndpoints(config.endpoints, ['chat_completions']),
    defaultHeaders,
    deployments,
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

/**
 * Upstream rejects an unknown value with a 400 that names the legal set, so
 * mirror those sets here — a typo in the dashboard should fail at save time
 * rather than on the first image request.
 */
const SDF_EXPERIENCES = ['BizChat', 'WXPOAgents', 'AppCopilots', 'Cowork', 'Scout', 'WorkIQ']
const SDF_SERVICE_TIERS = ['async', 'async-express', 'flex', 'default', 'priority']
const SDF_TRAFFIC_TYPES = ['Production', 'Test']

function optionalEnum(
  value: unknown,
  allowed: readonly string[],
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`sdf config.${field} must be one of: ${allowed.join(', ')}`)
  }
  return value
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeSdfConfig(config: Record<string, unknown>): SdfProviderConfig {
  if (typeof config.name !== 'string' || !config.name.trim()) throw new Error('sdf config.name required')
  if (typeof config.substrateToken !== 'string' || !config.substrateToken) {
    throw new Error('sdf config.substrateToken required')
  }
  const taxonomy = (config.taxonomy ?? {}) as Record<string, unknown>
  const cos = (config.cos ?? {}) as Record<string, unknown>
  const passport = (config.passport ?? {}) as Record<string, unknown>

  const apiBase = optionalString(passport.apiBase)
  if (apiBase && !apiBase.startsWith('https://')) {
    throw new Error('sdf config.passport.apiBase must be https')
  }

  const out: SdfProviderConfig = {
    name: config.name.trim(),
    substrateToken: config.substrateToken,
  }
  const normalizedTaxonomy = stripUndefined({
    experience: optionalEnum(taxonomy.experience, SDF_EXPERIENCES, 'taxonomy.experience'),
    agent: optionalString(taxonomy.agent),
    inferenceStep: optionalString(taxonomy.inferenceStep),
    trafficType: optionalEnum(taxonomy.trafficType, SDF_TRAFFIC_TYPES, 'taxonomy.trafficType') as
      | 'Production'
      | 'Test'
      | undefined,
  })
  if (normalizedTaxonomy) out.taxonomy = normalizedTaxonomy
  const normalizedCos = stripUndefined({
    serviceTier: optionalEnum(cos.serviceTier, SDF_SERVICE_TIERS, 'cos.serviceTier'),
  })
  if (normalizedCos) out.cos = normalizedCos
  const normalizedPassport = stripUndefined({
    enabled: typeof passport.enabled === 'boolean' ? passport.enabled : undefined,
    apiBase,
  })
  if (normalizedPassport) out.passport = normalizedPassport
  return out
}

/** Drop unset keys so an all-empty form doesn't persist `{}` sub-objects. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T | undefined {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined)
  return entries.length ? (Object.fromEntries(entries) as T) : undefined
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
  upstream: UpstreamRecord<unknown>,
): Omit<UpstreamRecord<unknown>, 'config'> & { config: Record<string, unknown> } {
  return { ...upstream, config: redactConfig(upstream.config) as Record<string, unknown> }
}

/**
 * Drop caches that may now be serving stale state after every CRUD on
 * /api/upstreams. In vnext we only have the raw-models cache so far;
 * upstream-list cache and copilot-token cache are TODOs that will be
 * wired here once they land.
 */
async function invalidateUpstreamCaches(
  _before: UpstreamRecord<unknown> | null,
  _after: UpstreamRecord<unknown> | null,
): Promise<void> {
  clearRawModelsCache()
  // TODO(Week 5+): invalidateUpstreamListCache() once registry adds a list cache.
  // TODO(Week 5+): invalidateCopilotToken(token, accountType, cacheRepo) once
  //                copilot-token-cache module is ported.
}

/**
 * Egress fetcher for the single-upstream admin routes (test / models).
 *
 * Without it these routes dial direct while real traffic goes through the
 * upstream's proxy chain, so "Test" fails on a gateway whose only egress is a
 * proxy even though inference works. Returns undefined on failure so a broken
 * proxy row degrades to a direct dial instead of hiding the provider error.
 */
async function adminFetcher(
  upstream: UpstreamRecord<unknown>,
): Promise<((upstreamId: string) => Fetcher) | undefined> {
  try {
    return await createPerRequestFetcher(getRuntimeLocation(), [upstream])
  } catch {
    return undefined
  }
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

upstreamMiscRouter.post('/upstream-probe', zValidator('json', probeBody), async (c) => {
  if (!isAdmin(c)) return jsonError('Forbidden', 403)
  const body = c.req.valid('json')
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
      // Root behaviour: any provider validation/construction error surfaces
      // as a ProbeResult with status 200 so the dashboard's probe UI renders
      // the error inline instead of bailing on the request.
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  if (kind === 'sdf') {
    try {
      const provider = new SdfProvider(normalizeSdfConfig(config as Record<string, unknown>) as PkgSdfConfig)
      const result = await provider.probe()
      return c.json(result)
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
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
  const ownerId = admin ? ((url.searchParams.get('ownerId') ?? undefined) as UserId | undefined) : userId
  const includeDisabled = url.searchParams.get('includeDisabled') === '1'
  const upstreams = await getRepo().upstreams.list({ ownerId, includeDisabled })
  return c.json({ upstreams: upstreams.map(serializeUpstream) })
})

upstreamsRouter.post('/', zValidator('json', upstreamBody), async (c) => {
  const admin = isAdmin(c)
  const userId = authUserId(c)
  if (!admin && !userId) return jsonError('Forbidden', 403)
  try {
    const body = c.req.valid('json')
    const provider = normalizeProvider(body.provider)
    if (typeof body.name !== 'string' || !body.name.trim()) return jsonError('name required')
    const now = new Date().toISOString()
    // Admin can target any owner via body.ownerId (including '' for global).
    // When unset, default to the admin's own userId rather than '' so newly
    // created upstreams don't silently land in the read-only "global" bucket.
    const ownerId = admin
      ? (typeof body.ownerId === 'string' ? body.ownerId : (userId ?? ''))
      : userId
    if (ownerId === undefined) return jsonError('ownerId required', 400)
    const upstream: UpstreamRecord<unknown> = {
      id: upstreamId(provider, body.name),
      ownerId,
      provider,
      name: body.name.trim(),
      enabled: body.enabled !== false,
      sortOrder: Number.isFinite(body.sortOrder) ? Number(body.sortOrder) : 0,
      config: normalizeConfig(provider, body.config),
      flagOverrides: normalizeFlagOverrides(body.flagOverrides),
      disabledPublicModelIds: normalizeDisabledPublicModelIds(body.disabledPublicModelIds),
      state: null,
      proxyFallbackList: [],
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

upstreamsRouter.patch('/:id', zValidator('json', upstreamBody), async (c) => {
  const admin = isAdmin(c)
  const id = c.req.param('id') as UpstreamId
  const existing = await loadOwned(c.get('auth'), () => getRepo().upstreams.getById(id))
  if (!existing) return jsonError('upstream not found', 404)
  try {
    const body = c.req.valid('json')
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
    const nextOwnerId = admin && typeof body.ownerId === 'string' && body.ownerId ? body.ownerId : existing.ownerId
    const next: UpstreamRecord<unknown> = {
      ...existing,
      ownerId: nextOwnerId,
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
  const id = c.req.param('id') as UpstreamId
  const existing = await loadOwned(c.get('auth'), () => getRepo().upstreams.getById(id))
  if (!existing) return jsonError('upstream not found', 404)
  // For copilot upstreams, cascade-delete the github_accounts row so the
  // legacy token store doesn't keep a now-orphan account around.
  if (existing.provider === 'copilot') {
    const accountUserId = (existing.config as { user?: { id?: number } } | undefined)?.user?.id
    if (typeof accountUserId === 'number') {
      try {
        await getRepo().github.deleteAccount(accountUserId as GitHubAccountId, (existing.ownerId ?? '') as UserId)
      } catch {}
    }
  }
  const ok = await getRepo().upstreams.delete(id)
  if (!ok) return jsonError('upstream not found', 404)
  await invalidateUpstreamCaches(existing, null)
  return c.json({ ok: true })
})

upstreamsRouter.post('/:id/test', async (c) => {
  const upstream = await loadOwned(c.get('auth'), () =>
    getRepo().upstreams.getById(c.req.param('id') as UpstreamId),
  )
  if (!upstream) return jsonError('upstream not found', 404)
  // Provider constructors validate config (Azure hostname suffix, Custom apiKey,
  // etc.) and may throw. Probe-style contract: surface as `{ ok: false, error }`
  // with 200 so the dashboard's "Test" button shows the failure inline rather
  // than producing a 500 wire error. Matches root src/routes/control-plane.ts.
  try {
    const provider = await createProviderFromUpstream(upstream, undefined, await adminFetcher(upstream))
    if (!provider) {
      return c.json({ ok: false, error: `unable to construct ${upstream.provider} provider for upstream ${upstream.id}` })
    }
    return c.json(await provider.probe())
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) })
  }
})

upstreamsRouter.get('/:id/models', async (c) => {
  const upstream = await loadOwned(c.get('auth'), () =>
    getRepo().upstreams.getById(c.req.param('id') as UpstreamId),
  )
  if (!upstream) return jsonError('upstream not found', 404)
  try {
    const provider = await createProviderFromUpstream(upstream, undefined, await adminFetcher(upstream))
    if (!provider) {
      return jsonError(`unable to construct ${upstream.provider} provider for upstream ${upstream.id}`, 502)
    }
    const models = await provider.getModels()
    const list = (models.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }))
    return c.json({ models: list, disabledPublicModelIds: upstream.disabledPublicModelIds })
  } catch (err) {
    return jsonError(`failed to list models: ${err instanceof Error ? err.message : String(err)}`, 502)
  }
})
