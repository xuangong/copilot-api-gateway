import { upstreamConfiguration } from "./upstream-configuration.ts"
import { cachedProxyHealth } from "./proxy-health-cache.ts"
import { waitUntil } from '@vibe-core/platform'
import type { Repo, ApiKey, User, UserSession, UpstreamRecord } from './types.ts'
import type { UpstreamId } from './branded-ids.ts'
import type { ProxyRecord } from '@vibe-core/proxy-repo'

export const CONFIG_CHECK_MS = 30_000
export const CONFIG_AUTH_LEASE_MS = 120_000

type ConfigurationOperation = 'revision_before' | 'revision_after' | 'api_keys' | 'users' | 'upstreams' | 'proxies' | 'snapshot'
type ConfigurationFailureReason = 'schema_unavailable' | 'storage_busy' | 'timeout' | 'io_context' | 'invalid_data' | 'revision_unstable' | 'unknown'

export class ConfigurationUnavailableError extends Error {
  constructor(
    readonly operation: ConfigurationOperation = 'snapshot',
    readonly reason: ConfigurationFailureReason = 'revision_unstable',
    cause?: unknown,
  ) {
    super('Gateway configuration temporarily unavailable', { cause })
    this.name = 'ConfigurationUnavailableError'
  }
}

function configurationFailureReason(error: unknown): ConfigurationFailureReason {
  // Driver messages can include SQL values and credentials. Emit only a fixed
  // category; retain the original cause on the internal error for debugging.
  const message = error instanceof Error ? error.message : ''
  if (/no such (?:table|column)/i.test(message)) return 'schema_unavailable'
  if (/SQLITE_BUSY|database is locked|overloaded|too many (?:requests|subrequests)/i.test(message)) return 'storage_busy'
  if (/timed? ?out|timeout/i.test(message)) return 'timeout'
  if (/Cannot perform I\/O on behalf of a different request/i.test(message)) return 'io_context'
  if (error instanceof SyntaxError) return 'invalid_data'
  return 'unknown'
}

async function readConfiguration<T>(operation: ConfigurationOperation, read: () => Promise<T>): Promise<T> {
  try { return await read() }
  catch (cause) { throw new ConfigurationUnavailableError(operation, configurationFailureReason(cause), cause) }
}

interface Snapshot {
  revision: number
  keys: Map<string, ApiKey>
  rawKeys: Map<string, ApiKey>
  users: Map<string, User>
  userKeys: Map<string, User>
  upstreams: UpstreamRecord<unknown>[]
  upstreamById: Map<string, UpstreamRecord<unknown>>
  byOwner: Map<string, UpstreamRecord<unknown>[]>
  proxies: ProxyRecord[]
}

const copy = <T>(value: T): T => structuredClone(value)

/** One current configuration, independent of request cardinality. Unknown keys
 * and model names never allocate cache entries. Control-plane reads stay raw. */
export class ConfigurationCache {
  private snapshot?: Snapshot
  private pending?: Promise<Snapshot>
  private sessions = new Map<string, { revision: number; value: UserSession }>()
  private sessionLoads = new Map<string, Promise<UserSession | null>>()
  private epoch = 0
  private configurationEpoch = 0
  private rowLoads = new Map<string, object>()
  private rowCheckAfter = new Map<string, number>()
  private dirty = true
  private confirmedAt = 0
  private checkAfter = 0
  readonly view: Repo
  private readonly proxyHealth: Repo["proxyBackoffs"]

  constructor(private readonly raw: Repo, private readonly now = () => Date.now()) {
    this.proxyHealth = cachedProxyHealth(raw.proxyBackoffs)
    this.view = this.createView(() => this.get())
  }

  invalidate(): void { this.configurationEpoch++; this.epoch++; this.dirty = true; this.checkAfter = 0 }

  /** State writes (including response quota telemetry) refresh only their row.
   * Keep the old DB revision: a later check must still discover remote edits. */
  async refreshUpstream(id: string): Promise<UpstreamRecord<unknown> | null> {
    const configurationEpoch = this.configurationEpoch
    const marker = {}
    this.rowLoads.set(id, marker)
    try {
      // Provider-facing repo uses plain strings; this is the gateway repo boundary.
      const row = await this.raw.upstreams.getById(id as UpstreamId)
      if (this.rowLoads.get(id) !== marker || configurationEpoch !== this.configurationEpoch) return row
      const current = this.snapshot
      if (!current || this.dirty) return row
      const previous = current.upstreamById.get(id)
      const configuration = (value: UpstreamRecord<unknown>) => {
        const { state: _state, updatedAt: _updatedAt, ...rest } = value
        return JSON.stringify(rest)
      }
      if (!row || !previous || configuration(row) !== configuration(previous)) {
        // A row read can also discover remote owner/proxy/config edits. Those
        // require a complete snapshot so references never cross generations.
        this.invalidate()
        return row
      }
      const upstreams = current.upstreams.map(u => u.id === id ? row : u)
      const byOwner = new Map(current.byOwner)
      byOwner.set(row.ownerId ?? '', upstreams.filter(u => u.ownerId === row.ownerId))
      // Quota writes must not starve a full configuration load under traffic.
      // A concurrent full load may momentarily lag advisory quota, which is
      // refreshed separately; credential changes still protect load ordering.
      if (upstreamConfiguration(previous) !== upstreamConfiguration(row)) this.epoch++
      this.rowCheckAfter.set(id, this.now() + CONFIG_CHECK_MS)
      this.snapshot = { ...current, upstreams, upstreamById: new Map(upstreams.map(u => [u.id, u])), byOwner }
      return row
    } finally { if (this.rowLoads.get(id) === marker) this.rowLoads.delete(id) }
  }

  private async findSession(token: UserSession["token"], snapshot: Snapshot): Promise<UserSession | null> {
    const cached = this.sessions.get(token)
    if (cached?.revision === snapshot.revision && Date.parse(cached.value.expiresAt) > this.now()) {
      this.sessions.delete(token)
      this.sessions.set(token, cached)
      return copy(cached.value)
    }
    this.sessions.delete(token)
    const key = `${snapshot.revision}:${token}`
    let pending = this.sessionLoads.get(key)
    if (!pending) {
      const epoch = this.epoch
      pending = this.raw.sessions.findByToken(token).then(value => {
        if (value && Date.parse(value.expiresAt) > this.now() && epoch === this.epoch) {
          this.sessions.set(token, { revision: snapshot.revision, value: copy(value) })
          while (this.sessions.size > 512) {
            const oldest = this.sessions.keys().next().value
            if (oldest === undefined) break
            this.sessions.delete(oldest)
          }
        }
        return value
      }).finally(() => { this.sessionLoads.delete(key) })
      this.sessionLoads.set(key, pending)
    }
    return copy(await pending)
  }

  async get(): Promise<Snapshot> {
    if (!this.snapshot || this.dirty || this.now() - this.confirmedAt >= CONFIG_AUTH_LEASE_MS) {
      return this.refresh()
    }
    if (this.now() >= this.checkAfter && !this.pending) {
      this.checkAfter = this.now() + CONFIG_CHECK_MS
      const refresh = this.refresh().catch(() => { this.checkAfter = this.now() + 5_000 })
      try { waitUntil(refresh) } catch { void refresh }
    }
    return this.snapshot
  }

  async pinnedView(): Promise<Repo> {
    const snapshot = await this.get()
    return this.createView(async () => snapshot)
  }

  private refresh(): Promise<Snapshot> {
    if (this.pending) return this.pending
    this.pending = this.load().catch(cause => {
      const error = cause instanceof ConfigurationUnavailableError
        ? cause : new ConfigurationUnavailableError('snapshot', configurationFailureReason(cause), cause)
      // Log once per shared refresh, including failures hidden by a still-valid
      // authorization lease. Never serialize the error or its raw cause.
      console.warn({
        evt: 'configuration_refresh_failed', operation: error.operation, reason: error.reason,
        has_snapshot: Boolean(this.snapshot),
        snapshot_age_ms: this.snapshot ? Math.max(0, this.now() - this.confirmedAt) : null,
        dirty: this.dirty,
      })
      throw error
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async load(): Promise<Snapshot> {
    // Read revision around the batch: never publish a mixture observed across
    // a configuration mutation. A failed/moving load leaves the old value intact.
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = this.epoch
      const revision = await readConfiguration('revision_before', () => this.raw.configurationRevision!())
      if (epoch === this.epoch && this.snapshot && !this.dirty && revision === this.snapshot.revision) {
        this.confirmedAt = this.now()
        this.checkAfter = this.now() + CONFIG_CHECK_MS
        return this.snapshot
      }
      this.dirty = true
      const [keys, users, upstreams, proxies] = await Promise.all([
        readConfiguration('api_keys', () => this.raw.apiKeys.list()),
        readConfiguration('users', () => this.raw.users.list()),
        readConfiguration('upstreams', () => this.raw.upstreams.list({ includeDisabled: true })),
        readConfiguration('proxies', () => this.raw.proxies.list()),
      ])
      const after = await readConfiguration('revision_after', () => this.raw.configurationRevision!())
      if (epoch !== this.epoch || revision !== after) continue
      const byOwner = new Map<string, UpstreamRecord<unknown>[]>()
      for (const row of upstreams) {
        const owner = row.ownerId ?? ''
        const entries = byOwner.get(owner) ?? []
        entries.push(row); byOwner.set(owner, entries)
      }
      const next: Snapshot = {
        revision, keys: new Map(keys.map(k => [k.id, k])), rawKeys: new Map(keys.map(k => [k.key, k])),
        users: new Map(users.map(u => [u.id, u])), userKeys: new Map(users.filter(u => u.userKey).map(u => [u.userKey!, u])),
        upstreams, upstreamById: new Map(upstreams.map(u => [u.id, u])), byOwner, proxies,
      }
      this.snapshot = next
      this.configurationEpoch++
      this.rowCheckAfter = new Map(upstreams.map(u => [u.id, this.now() + CONFIG_CHECK_MS]))
      this.dirty = false
      this.confirmedAt = this.now()
      this.checkAfter = this.now() + CONFIG_CHECK_MS
      return next
    }
    throw new ConfigurationUnavailableError()
  }

  private createView(get: () => Promise<Snapshot>): Repo {
    const raw = this.raw
    // Proxy fallback methods stay bound to the authoritative repo, particularly
    // compare-and-swap credential writes. Never mutate a cached entity in place.
    const overlay = <T extends object>(target: T, overrides: Partial<T>): T => new Proxy(target, {
      get(obj, name) {
        if (name in overrides) return Reflect.get(overrides, name)
        const value = Reflect.get(obj, name)
        return typeof value === 'function' ? value.bind(obj) : value
      },
    })
    return overlay(raw, {
      proxyBackoffs: this.proxyHealth,
      apiKeys: overlay(raw.apiKeys, {
        findByRawKey: async key => copy((await get()).rawKeys.get(key) ?? null),
        getById: async id => copy((await get()).keys.get(id) ?? null),
        list: async () => copy([...(await get()).keys.values()]),
        listByOwner: async id => copy([...(await get()).keys.values()].filter(k => k.ownerId === id)),
      }),
      sessions: overlay(raw.sessions, {
        findByToken: async token => this.findSession(token, await get()),
      }),
      users: overlay(raw.users, {
        getById: async id => copy((await get()).users.get(id) ?? null),
        findByKey: async key => copy((await get()).userKeys.get(key) ?? null),
      }),
      upstreams: overlay(raw.upstreams, {
        list: async (opts = {}) => {
          const s = await get()
          const rows = opts.ownerId === undefined ? s.upstreams : (s.byOwner.get(opts.ownerId) ?? [])
          return copy(opts.includeDisabled ? rows : rows.filter(u => u.enabled))
        },
        getById: async <T>(id: string) => {
          const snapshot = await get()
          const row = snapshot.upstreamById.get(id)
          if (row && !this.rowLoads.has(id) && this.now() >= (this.rowCheckAfter.get(id) ?? 0)) {
            this.rowCheckAfter.set(id, this.now() + CONFIG_CHECK_MS)
            const refresh = this.refreshUpstream(id).catch(() => {})
            try { waitUntil(refresh) } catch { void refresh }
          }
          return copy(row ?? null) as UpstreamRecord<T> | null
        },
      }),
      proxies: overlay(raw.proxies, {
        list: async () => copy((await get()).proxies),
        getById: async id => copy((await get()).proxies.find(p => p.id === id) ?? null),
      }),
    })
  }
}

/** Decorate the actual mutation entry points, including provider OAuth writes.
 * The DB revision also catches writes made by other processes/direct SQL. */
export function observeConfigurationWrites(repo: Repo, changed: () => void, stateChanged?: (id: string) => Promise<unknown>): void {
  const saveState = repo.upstreams.saveState.bind(repo.upstreams)
  repo.upstreams.saveState = async (id, updater) => {
    try {
      await saveState(id, updater)
      if (stateChanged) await stateChanged(id)
      else changed()
    } catch (error) { changed(); throw error }
  }
  const methods = {
    apiKeys: ['save', 'patchModelMappings', 'delete', 'deleteAll'],
    users: ['create', 'update', 'delete'],
    sessions: ['create', 'deleteByUserId', 'deleteExpired'],
    upstreams: ['save', 'delete', 'deleteAll'],
    proxies: ['insert', 'save', 'patch', 'delete', 'deleteAll'],
  } as const
  for (const [group, names] of Object.entries(methods)) {
    const target = repo[group as keyof typeof methods] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    for (const name of names) {
      const original = target[name]
      if (!original) continue
      target[name] = async (...args) => {
        try { return await original.apply(target, args) }
        finally { changed() }
      }
    }
  }
}
