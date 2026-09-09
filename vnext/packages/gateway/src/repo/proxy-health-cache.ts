import { waitUntil } from '@vibe-core/platform'
import type { BackoffRow, ProxyBackoffRepo } from '@vibe-core/proxy-repo'

/** Advisory proxy health, unlike authorization, can safely keep its last good
 * value while refreshing. Dial fallback still tries every transport. */
export function cachedProxyHealth(raw: ProxyBackoffRepo): ProxyBackoffRepo {
  const cache = new Map<string, { rows: BackoffRow[]; refreshAt: number }>()
  const pending = new Map<string, Promise<BackoffRow[]>>()
  let epoch = 0
  const load = (id: string): Promise<BackoffRow[]> => {
    const existing = pending.get(id)
    if (existing) return existing
    const generation = epoch
    const promise = raw.listForUpstream(id).then(rows => {
      if (epoch === generation) {
        cache.delete(id)
        cache.set(id, { rows, refreshAt: Date.now() + 30_000 })
        while (cache.size > 512) cache.delete(cache.keys().next().value!)
      }
      return rows
    }).finally(() => { if (pending.get(id) === promise) pending.delete(id) })
    pending.set(id, promise)
    return promise
  }
  // Include admin resets and provider failure writes in local invalidation.
  for (const name of ['recordDialFailure', 'recordDialSuccess', 'resetForProxy', 'resetForUpstream', 'reset', 'deleteAll'] as const) {
    const original = raw[name].bind(raw) as (...args: string[]) => Promise<void>
    raw[name] = async (...args: string[]) => {
      try { await original(...args) } finally { epoch++; cache.clear(); pending.clear() }
    }
  }
  const background = (promise: Promise<unknown>) => {
    const handled = promise.catch(() => {})
    try { waitUntil(handled) } catch { void handled }
  }
  return new Proxy(raw, {
    get(target, name) {
      if (name === 'listForUpstream') return async (id: string) => {
        const entry = cache.get(id)
        if (!entry) return structuredClone(await load(id))
        cache.delete(id); cache.set(id, entry)
        if (Date.now() >= entry.refreshAt) {
          entry.refreshAt = Date.now() + 30_000
          background(load(id))
        }
        return structuredClone(entry.rows)
      }
      if (name === 'recordDialSuccess') return async (proxyId: string, upstreamId: string) => {
        const entry = cache.get(upstreamId)
        if (entry && !entry.rows.some(row => row.proxyId === proxyId)) return
        // Bookkeeping must not hold a healthy upstream response before TTFT.
        background(raw.recordDialSuccess(proxyId, upstreamId))
      }
      const value = Reflect.get(target, name)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}
