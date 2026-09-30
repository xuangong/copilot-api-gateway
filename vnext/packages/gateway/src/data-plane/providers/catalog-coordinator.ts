import type { UpstreamId } from "../../repo/branded-ids.ts"
import type { ProxyRecord } from "@vibe-core/proxy-repo"
import type { BackgroundExecutor } from "@vibe-core/platform"
import type { StoredUpstreamRecord } from "../../repo/types.ts"
import { validCatalogModels, type CatalogErrorCode, type CatalogIdentity, type CatalogLease, type CatalogModels, type CatalogObservation, type CatalogRepo, type CatalogSnapshot } from "../../repo/catalogs.ts"

export class CatalogUnavailableError extends Error {
  constructor(readonly code: CatalogErrorCode | "superseded-unavailable") { super(`Model catalog ${code}`) }
}
export interface CatalogRequest {
  expected: StoredUpstreamRecord
  mode: "automatic" | "cache-only" | "explicit"
  signal?: AbortSignal
  isVisible: (row: StoredUpstreamRecord) => boolean
  background: BackgroundExecutor
}
export interface CatalogResult {
  upstream: StoredUpstreamRecord
  proxies: readonly ProxyRecord[]
  snapshot: CatalogSnapshot
}
export interface CatalogCoordinatorDependencies {
  catalogs: CatalogRepo
  discover: (observation: CatalogObservation, signal: AbortSignal) => Promise<CatalogModels>
  catalogRevision: number
  policy?: { totalBudgetMs?: number; leaseMs?: number; freshnessMs?: number; pollMs?: number }
}

const sameTarget = (a: StoredUpstreamRecord, b: StoredUpstreamRecord) => a.id === b.id && a.rowIncarnation === b.rowIncarnation
  && (a.ownerId ?? "") === (b.ownerId ?? "") && a.provider === b.provider
export const sameCatalogIdentity = (a: CatalogIdentity, b: CatalogIdentity): boolean => a.upstreamId === b.upstreamId
  && a.rowIncarnation === b.rowIncarnation && a.configurationGeneration === b.configurationGeneration
  && a.configurationFingerprint === b.configurationFingerprint && a.catalogRevision === b.catalogRevision
  && (a.ownerId ?? "") === (b.ownerId ?? "") && a.provider === b.provider

/** Both actual I/O cancellation and bounded awaits are needed for uncooperative transports. */
export class CatalogDeadline {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly onAbort: () => void
  constructor(ms: number, private readonly parent?: AbortSignal) {
    this.signal = this.controller.signal
    this.onAbort = () => this.controller.abort(new CatalogUnavailableError("aborted"))
    this.timer = setTimeout(() => this.controller.abort(new CatalogUnavailableError("timeout")), ms)
    if (parent?.aborted) this.onAbort()
    else parent?.addEventListener("abort", this.onAbort, { once: true })
  }
  check(): void { if (this.signal.aborted) throw this.signal.reason }
  async wait<T>(work: Promise<T>): Promise<T> {
    // Attach the consumer even for a pre-aborted caller: work may already be running.
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(this.signal.reason)
      this.signal.addEventListener("abort", abort, { once: true })
      work.then(resolve, reject).finally(() => this.signal.removeEventListener("abort", abort))
      if (this.signal.aborted) abort()
    })
  }
  async pause(ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await this.wait(new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })) }
    finally { clearTimeout(timer) }
  }
  dispose(): void {
    clearTimeout(this.timer)
    this.parent?.removeEventListener("abort", this.onAbort)
    this.controller.abort(new CatalogUnavailableError("aborted"))
  }
}

interface Memo {
  result: CatalogResult | null
  identity: CatalogIdentity
  observed: number
  freshUntil: number
  retryAfter: number
}

export class CatalogCoordinator {
  private readonly memo = new Map<string, Memo>()
  private readonly refreshing = new Set<string>()
  private sequence = 0
  private installAfter = 0
  private readonly budget: number
  private readonly leaseMs: number
  private readonly freshnessMs: number
  private readonly pollMs: number
  constructor(private readonly dependencies: CatalogCoordinatorDependencies) {
    const bounded = (value: number, max: number) => {
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError("Invalid catalog policy")
      return value
    }
    this.budget = bounded(dependencies.policy?.totalBudgetMs ?? 20_000, 20_000)
    this.leaseMs = bounded(dependencies.policy?.leaseMs ?? 30_000, 300_000)
    this.freshnessMs = bounded(dependencies.policy?.freshnessMs ?? 120_000, 86_400_000)
    this.pollMs = bounded(dependencies.policy?.pollMs ?? 100, 1000)
  }
  clear(): void { this.memo.clear(); this.installAfter = ++this.sequence }

  private eligible(request: CatalogRequest, row: StoredUpstreamRecord): boolean {
    return sameTarget(request.expected, row) && request.isVisible(row)
  }
  private retained(request: CatalogRequest): Memo | undefined {
    const memo = this.memo.get(request.expected.id)
    if (!memo?.result || !this.eligible(request, memo.result.upstream)
      || request.expected.catalogGeneration !== memo.identity.configurationGeneration) return undefined
    // Filters are request configuration, deliberately outside discovery identity.
    memo.result = { ...memo.result, upstream: request.expected }
    return memo
  }
  private install(observation: CatalogObservation, ticket: number): Memo | null {
    if (ticket < this.installAfter) return null
    const old = this.memo.get(observation.upstream.id)
    if (old && (old.observed > ticket || (old.identity.rowIncarnation === observation.identity.rowIncarnation
      && old.identity.configurationGeneration > observation.identity.configurationGeneration))) return null
    const same = old && sameCatalogIdentity(old.identity, observation.identity)
    const snapshot = same && old.result && observation.snapshot
      && old.result.snapshot.publicationVersion > observation.snapshot.publicationVersion
      ? old.result.snapshot : observation.snapshot
    const memo: Memo = {
      identity: observation.identity, observed: ticket,
      result: snapshot ? { upstream: observation.upstream, proxies: observation.proxies, snapshot } : null,
      freshUntil: performance.now() + Math.max(0, (snapshot?.refreshAfterMs ?? 0) - observation.databaseNowMs),
      retryAfter: performance.now() + Math.max(0, observation.retryAtMs - observation.databaseNowMs),
    }
    this.memo.delete(observation.upstream.id)
    this.memo.set(observation.upstream.id, memo)
    while (this.memo.size > 512) {
      const first = this.memo.keys().next()
      if (!first.done) this.memo.delete(first.value)
      // A bounded global fence replaces per-evicted-identity tombstones.
      this.installAfter = this.sequence
    }
    return memo
  }
  private refresh(request: CatalogRequest): void {
    const key = JSON.stringify([request.expected.id, request.expected.rowIncarnation, request.expected.catalogGeneration])
    if (this.refreshing.has(key) || this.refreshing.size >= 512) return
    this.refreshing.add(key)
    const work = this.run({ ...request, signal: undefined }, true).then(() => {}, () => {}).finally(() => this.refreshing.delete(key))
    try { request.background.waitUntil(work) } catch { void work }
  }
  async read(request: CatalogRequest): Promise<CatalogResult | null> {
    if (request.signal?.aborted) throw new CatalogUnavailableError("aborted")
    const memo = this.retained(request)
    if (memo?.result && request.mode !== "explicit") {
      if (request.mode === "automatic" && memo.freshUntil <= performance.now() && memo.retryAfter <= performance.now()) this.refresh(request)
      return memo.result
    }
    return this.run(request, false)
  }
  private async run(request: CatalogRequest, refreshing: boolean): Promise<CatalogResult | null> {
    const deadline = new CatalogDeadline(this.budget, request.signal)
    let joined: CatalogLease | undefined
    try {
      for (;;) {
        deadline.check()
        const ticket = ++this.sequence
        let observation: CatalogObservation | null
        try { observation = await deadline.wait(this.dependencies.catalogs.read(request.expected.id as UpstreamId, this.dependencies.catalogRevision)) }
        catch (error) {
          if (error instanceof CatalogUnavailableError) throw error
          const stale = this.retained(request)?.result
          if (stale && request.mode !== "explicit") return stale
          throw new CatalogUnavailableError("unavailable")
        }
        if (!observation || !this.eligible(request, observation.upstream)) {
          this.memo.delete(request.expected.id)
          this.installAfter = this.sequence
          return null
        }
        const memo = this.install(observation, ticket)
        if (!memo) { await deadline.pause(this.pollMs); continue }
        if (joined) {
          if (!sameCatalogIdentity(joined.identity, observation.identity)) throw new CatalogUnavailableError("superseded-unavailable")
          if (observation.terminal?.token === joined.token) {
            if (observation.terminal.outcome === "failure") throw new CatalogUnavailableError(observation.terminal.code)
            if (memo.result?.snapshot.publicationVersion === observation.terminal.publicationVersion) return memo.result
            throw new CatalogUnavailableError("superseded-unavailable")
          }
          if (observation.lease?.token !== joined.token || observation.lease.leaseUntilMs <= observation.databaseNowMs) {
            throw new CatalogUnavailableError("superseded-unavailable")
          }
          await deadline.pause(this.pollMs)
          continue
        }
        if (request.mode === "cache-only") return memo.result
        if (request.mode === "automatic" && memo.result) {
          if (!refreshing) {
            if (memo.freshUntil <= performance.now() && memo.retryAfter <= performance.now()) this.refresh({ ...request, expected: observation.upstream })
            return memo.result
          }
          if (memo.freshUntil > performance.now() || observation.retryAtMs > observation.databaseNowMs) return memo.result
        }
        if (observation.lease && observation.lease.leaseUntilMs > observation.databaseNowMs) {
          if (request.mode === "explicit") joined = observation.lease
          await deadline.pause(this.pollMs)
          continue
        }
        if (request.mode !== "explicit" && observation.retryAtMs > observation.databaseNowMs) throw new CatalogUnavailableError(observation.lastErrorCode ?? "unavailable")
        const lease = await deadline.wait(this.dependencies.catalogs.tryAcquire(observation.identity, {
          explicit: request.mode === "explicit", leaseMs: this.leaseMs,
          // Reject an intervening publication before any automatic discovery starts.
          expectedPublicationVersion: request.mode === "explicit" ? undefined : observation.publicationVersion,
        }))
        if (!lease) { await deadline.pause(this.pollMs); continue }
        const published = await this.discover(observation, lease, deadline)
        if (published && request.mode === "explicit") joined = lease
        // Read authority again: filters, visibility, configuration and publication may have changed.
      }
    } catch (error) {
      if (error instanceof CatalogUnavailableError) throw error
      throw new CatalogUnavailableError("unavailable")
    } finally { deadline.dispose() }
  }
  private async discover(observation: CatalogObservation, lease: CatalogLease, deadline: CatalogDeadline): Promise<CatalogSnapshot | null> {
    try {
      deadline.check()
      const models = await deadline.wait(this.dependencies.discover(observation, deadline.signal))
      deadline.check()
      if (!validCatalogModels(models)) throw new CatalogUnavailableError("invalid_catalog")
      return await deadline.wait(this.dependencies.catalogs.publish(lease, models, { freshnessMs: this.freshnessMs }))
    } catch (error) {
      const code = error instanceof CatalogUnavailableError ? error.code : "upstream_error"
      const failure = this.dependencies.catalogs.recordFailure(lease, code === "superseded-unavailable" ? "unavailable" : code)
      // An expired caller must not await an unresponsive database to report its deadline.
      if (deadline.signal.aborted) void failure.catch(() => {})
      else await deadline.wait(failure).catch(() => {})
      throw new CatalogUnavailableError(code)
    }
  }
}
