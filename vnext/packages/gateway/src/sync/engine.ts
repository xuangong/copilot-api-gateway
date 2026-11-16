import { getRuntimeLocation } from "@vibe-core/platform"
import { directFetcher, type Fetcher } from "@vibe-core/upstream"
import { providerPlugin } from "../data-plane/providers/registry"
import { getRepo } from "../repo"
import type { UserId } from "../repo/branded-ids"
import type { SyncSourceRecord } from "../repo/sync"
import type { Repo } from "../repo/types"
import { applySnapshot, type ApplyResult } from "./apply"
import { fetchSnapshot } from "./fetch"
import { syncLock, withSyncLock } from "./lock"
import type { SyncDocument } from "./protocol"

export interface SyncDeps {
  repo?: Pick<Repo, "syncSources" | "upstreams">
  fetcher?: Fetcher
  now?: () => number
  isKnownProvider?: (provider: string) => boolean
}

/** Device sync runs only on Bun/Docker gateways; Workers never poll. */
export function deviceSyncAvailable(): boolean {
  try { return getRuntimeLocation() === "bun" } catch { return false }
}

export { syncLock, withSyncLock }

function resolveDeps(deps: SyncDeps) {
  return {
    repo: deps.repo ?? getRepo(),
    fetcher: deps.fetcher ?? directFetcher,
    now: deps.now ?? Date.now,
    isKnownProvider: deps.isKnownProvider ?? ((kind: string) => providerPlugin(kind) !== undefined),
  }
}

/** A snapshot with skipped entries is retried: its ETag is not stored and the first skip code is the recorded error. */
async function recordApplied(repo: Pick<Repo, "syncSources">, source: SyncSourceRecord, result: ApplyResult, etag: string, stamp: string): Promise<void> {
  const skipped = result.skipped[0]?.code ?? null
  await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, successAt: stamp, etag: skipped ? null : etag, error: skipped })
}

/** True while the stored source is still the one (same id and secret) a fetch was made for. */
async function sourceUnchanged(repo: Pick<Repo, "syncSources">, source: Pick<SyncSourceRecord, "id" | "secret">): Promise<boolean> {
  const current = await repo.syncSources.get()
  return current !== null && current.id === source.id && current.secret === source.secret
}

export type SyncRunResult = "idle" | "not_modified" | "applied" | "revoked" | "failed"

/** One poll of the stored source. The caller holds `syncLock`. */
export async function syncSource(deps: SyncDeps = {}): Promise<SyncRunResult> {
  const { repo, fetcher, now, isKnownProvider } = resolveDeps(deps)
  const source = await repo.syncSources.get()
  if (!source || source.status !== "active") return "idle"
  const stamp = new Date(now()).toISOString()
  const fetched = await fetchSnapshot(source, fetcher)
  switch (fetched.kind) {
    case "not_modified":
      await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, successAt: stamp, error: null })
      return "not_modified"
    case "revoked":
      await repo.upstreams.deleteSynced(source.id)
      await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, etag: null, error: null, status: "revoked" })
      return "revoked"
    case "failed":
      await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, error: fetched.code })
      return "failed"
    case "changed":
      // The source may have been deleted or replaced while the request was in flight; never re-create rows for it.
      if (!(await sourceUnchanged(repo, source))) return "idle"
      try {
        await recordApplied(repo, source, await applySnapshot(repo, source, fetched.snapshot, stamp, isKnownProvider), fetched.etag, stamp)
        return "applied"
      } catch {
        await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, etag: null, error: "apply_failed" }).catch(() => false)
        return "failed"
      }
  }
}

/** The scheduler's entry point: skips when another sync or a source change is running; never throws. */
export async function runScheduledSync(deps: SyncDeps = {}): Promise<SyncRunResult | "busy"> {
  const release = syncLock.tryAcquire()
  if (!release) return "busy"
  try { return await syncSource(deps) }
  catch {
    console.warn(JSON.stringify({ evt: "device_sync_failed" }))
    return "failed"
  } finally { release() }
}

export type ConnectOutcome =
  | { kind: "connected"; source: SyncSourceRecord }
  | { kind: "invalid_document" }
  | { kind: "exists" }
  | { kind: "unreachable" }
  | { kind: "not_found" }

/**
 * `create`: the first source. `replace`: swap the document of the existing source in place (same id, same owner), which
 * removes upstreams the new snapshot lacks. The fetch happens first, so a rejected or unreachable document changes nothing.
 * Throws only when applying the fetched snapshot fails (the source stays, `last_error = apply_failed`).
 */
export async function connectSource(input: { mode: "create" | "replace"; ownerId: UserId; document: SyncDocument }, deps: SyncDeps = {}): Promise<ConnectOutcome> {
  const { repo, fetcher, now, isKnownProvider } = resolveDeps(deps)
  return withSyncLock(async (): Promise<ConnectOutcome> => {
    const existing = await repo.syncSources.get()
    if (input.mode === "create" && existing) return { kind: "exists" }
    if (input.mode === "replace" && !existing) return { kind: "not_found" }
    const { document } = input
    const fetched = await fetchSnapshot({ origin: document.gatewayOrigin, deviceId: document.deviceId, secret: document.deviceSecret, etag: null }, fetcher)
    if (fetched.kind === "revoked") return { kind: "invalid_document" }
    if (fetched.kind !== "changed") return { kind: "unreachable" }
    // The lock is held, but re-check anyway: a source deleted or replaced while fetching must not be written to.
    const afterFetch = await repo.syncSources.get()
    if (existing ? !afterFetch || afterFetch.id !== existing.id || afterFetch.secret !== existing.secret : afterFetch) {
      return { kind: existing ? "not_found" : "exists" }
    }
    const stamp = new Date(now()).toISOString()
    const fields = { origin: document.gatewayOrigin, deviceId: document.deviceId, secret: document.deviceSecret }
    let source: SyncSourceRecord | null
    if (existing) source = await repo.syncSources.replaceDocument(existing.id, fields, stamp)
    else {
      const created: SyncSourceRecord = { id: `ssrc_${crypto.randomUUID().replaceAll("-", "")}`, ownerId: input.ownerId, ...fields, etag: null,
        lastAttemptAt: stamp, lastSuccessAt: null, status: "active", lastError: null }
      source = (await repo.syncSources.create(created)) ? created : null
    }
    if (!source) return { kind: existing ? "not_found" : "exists" }
    try {
      await recordApplied(repo, source, await applySnapshot(repo, source, fetched.snapshot, stamp, isKnownProvider), fetched.etag, stamp)
    } catch (error) {
      await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, etag: null, error: "apply_failed" }).catch(() => false)
      throw error
    }
    return { kind: "connected", source: (await repo.syncSources.get()) ?? source }
  })
}

/** Removes the source and every upstream it created. False when there was no source. */
export async function disconnectSource(deps: SyncDeps = {}): Promise<boolean> {
  const { repo } = resolveDeps(deps)
  return withSyncLock(async () => {
    const source = await repo.syncSources.get()
    if (!source) return false
    await repo.upstreams.deleteSynced(source.id)
    await repo.syncSources.delete(source.id)
    return true
  })
}
