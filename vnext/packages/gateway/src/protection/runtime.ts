// packages/gateway/src/protection/runtime.ts
import { __registerPlatformReset, waitUntil } from "@vibe-core/platform"
import { getRepo } from "../repo/index.ts"
import type { Repo } from "../repo/types.ts"
import type { ApiKeyId, UpstreamId } from "../repo/branded-ids.ts"
import { PROTECTION_MESSAGE_MAX, SAMPLED_CLASSES, type ErrorClass, type NewPause, type PauseReason, type PauseRecord, type PauseResolver } from "../repo/protection.ts"
import { isRiskyClass } from "./classify.ts"
import { assess, cooldownMinutes, covered } from "./detect.ts"
import { resolveProtection } from "./settings.ts"

const PROTECTION_CODE_MAX = 100

/** One response (or network failure) of a request the gateway sent to an upstream. */
export interface UpstreamOutcome {
  upstreamId: string
  /** `''` when the request carried no API key. */
  keyId: string
  /** The public model. */
  model: string
  cls: ErrorClass
  /** HTTP status; 0 for a network failure. */
  status: number
  code: string
  message: string
}
export type OutcomeInput = UpstreamOutcome | Promise<UpstreamOutcome>

/** `waitUntil` where a background executor exists; a detached, error-swallowing promise otherwise (unit tests, scripts). */
export function scheduleBackground(work: Promise<unknown>): void {
  const safe = work.catch(() => {})
  try { waitUntil(safe) } catch { /* no background executor: the promise already runs */ }
}

export interface ProtectionRuntimeOptions {
  repo?: () => Repo
  /** Unix ms. */
  now?: () => number
  schedule?: (work: Promise<unknown>) => void
  /** How long the active-pause cache may be reused. */
  cacheTtlMs?: number
  /** Minimum gap between two evaluations of one upstream. */
  evalIntervalMs?: number
  /** How long to wait for a pending outcome (response body read) before giving up. */
  outcomeTimeoutMs?: number
}

const warn = (evt: string, error: unknown): void => {
  console.warn(JSON.stringify({ evt, error: error instanceof Error ? error.name : "unknown" }))
}

export class ProtectionRuntime {
  readonly now: () => number
  readonly cacheTtlMs: number
  readonly evalIntervalMs: number
  readonly outcomeTimeoutMs: number
  protected readonly repo: () => Repo
  protected readonly schedule: (work: Promise<unknown>) => void
  private readonly lastEvaluated = new Map<string, number>()
  private cache: { at: number; rows: PauseRecord[] } | null = null
  private inflight: Promise<void> | null = null
  /** Local create/resume edits, replayed over a load that started before them so it cannot overwrite them. */
  private seq = 0
  private edits: Array<{ seq: number; apply: (rows: PauseRecord[]) => PauseRecord[] }> = []

  constructor(options: ProtectionRuntimeOptions = {}) {
    this.repo = options.repo ?? getRepo
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? scheduleBackground
    this.cacheTtlMs = options.cacheTtlMs ?? 10_000
    this.evalIntervalMs = options.evalIntervalMs ?? 10_000
    this.outcomeTimeoutMs = options.outcomeTimeoutMs ?? 5_000
  }

  /** Fire and forget: never throws, never rejects, never delays the caller. */
  record(input: OutcomeInput): void {
    try {
      this.schedule(this.settle(input).then(outcome => this.recordNow(outcome)).catch(error => warn("protection_record_failed", error)))
    } catch (error) { warn("protection_schedule_failed", error) }
  }

  /** The outcome, or a rejection when a pending promise does not settle in time (releases the scheduled work). */
  private settle(input: OutcomeInput): Promise<UpstreamOutcome> {
    if (!(input instanceof Promise)) return Promise.resolve(input)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("outcome timeout")), this.outcomeTimeoutMs) })
    return Promise.race([input, timeout]).finally(() => clearTimeout(timer))
  }

  /** Writes one response: one upsert, plus the sample insert and trim in the same batch for the sampled classes. */
  async recordNow(outcome: UpstreamOutcome): Promise<void> {
    const nowMs = this.now()
    await this.repo().protection.recordResponse({
      minute: Math.floor(nowMs / 60_000) * 60,
      upstreamId: outcome.upstreamId, keyId: outcome.keyId, model: outcome.model, cls: outcome.cls,
      ...(SAMPLED_CLASSES.includes(outcome.cls) ? { sample: { status: outcome.status, at: nowMs, code: outcome.code.slice(0, PROTECTION_CODE_MAX), message: outcome.message.slice(0, PROTECTION_MESSAGE_MAX) } } : {}),
    })
    if (isRiskyClass(outcome.cls)) await this.maybeEvaluate(outcome.upstreamId)
  }

  /** At most one evaluation per `evalIntervalMs` per upstream (per isolate/process); failures are logged, never thrown. */
  protected async maybeEvaluate(upstreamId: string): Promise<void> {
    const nowMs = this.now()
    const last = this.lastEvaluated.get(upstreamId)
    if (last !== undefined && nowMs - last < this.evalIntervalMs) return
    for (const [id, at] of this.lastEvaluated) if (nowMs - at >= this.evalIntervalMs) this.lastEvaluated.delete(id)
    this.lastEvaluated.set(upstreamId, nowMs)
    try { await this.evaluate(upstreamId) } catch (error) { warn("protection_evaluate_failed", error) }
  }

  /**
   * Spec "Detection" steps 1-6. Returns the row it created, or null when protection is off, nothing triggers, an active
   * row already covers the target, or another isolate won the insert race.
   */
  async evaluate(upstreamId: string): Promise<PauseRecord | null> {
    const protection = this.repo().protection
    const settings = resolveProtection(await protection.getSettings(upstreamId))
    if (settings.mode === "off") return null
    const nowMs = this.now()
    const minute = Math.floor(nowMs / 60_000) * 60
    // Errors from before an owner resume must not pause the target again: the window starts after the resume minute.
    const windowStart = minute - (settings.windowMinutes - 1) * 60
    const resumedAt = await protection.lastOwnerResolvedAt(upstreamId, windowStart * 1000)
    const from = resumedAt === null ? windowStart : Math.max(windowStart, Math.floor(resumedAt / 60_000) * 60 + 60)
    const window = await protection.windowSummary(upstreamId, from, minute)
    const assessment = assess(upstreamId, settings, window)
    if (!assessment) return null
    if (covered(await protection.listActive(nowMs), upstreamId, assessment.attributedKey, settings.mode)) return null
    const earlier = await protection.countRecentPauses(assessment.target.kind, assessment.target.id, settings.mode, nowMs - 24 * 3_600_000)
    const names = await this.names(upstreamId, assessment.target)
    const pause: NewPause = {
      id: `pp_${crypto.randomUUID().replace(/-/g, "")}`,
      targetKind: assessment.target.kind, targetId: assessment.target.id, upstreamId, mode: settings.mode,
      reason: { ...assessment.reason, ...names },
      startedAt: nowMs, endsAt: nowMs + cooldownMinutes(settings, earlier) * 60_000,
    }
    if (!(await protection.insertPauseIfNone(pause, nowMs))) return null
    const created: PauseRecord = { ...pause, resolvedAt: null, resolvedBy: null }
    // This isolate enforces the new row at once; other isolates see it within `cacheTtlMs`.
    this.localEdit(rows => [...rows.filter(row => row.id !== created.id), created])
    return created
  }

  /**
   * Inserts a pause that was not detected from error counts (the quota hard line). Null when an unresolved, unexpired row
   * of the same target already covers it. This isolate enforces the new row at once; others see it within `cacheTtlMs`.
   */
  async insertExternal(pause: NewPause): Promise<PauseRecord | null> {
    if (!(await this.repo().protection.insertPauseIfNone(pause, this.now()))) return null
    const created: PauseRecord = { ...pause, resolvedAt: null, resolvedBy: null }
    this.localEdit(rows => [...rows.filter(row => row.id !== created.id), created])
    return created
  }

  /** Rewrites the reason of an active row in place (a provisional quota cut-off confirmed by a real read) and patches the local cache. */
  async updateReason(id: string, reason: PauseReason): Promise<boolean> {
    const updated = await this.repo().protection.updatePauseReason(id, reason)
    if (updated) this.localEdit(rows => rows.map(row => row.id === id ? { ...row, reason } : row))
    return updated
  }

  /**
   * Unresolved, unexpired rows of every mode. A cold cache waits for its first load; a stale one answers at once and is
   * refreshed in the background (one load in flight), so no request pays a D1 round trip. Never throws.
   */
  async activePauses(): Promise<readonly PauseRecord[]> {
    const nowMs = this.now()
    if (!this.cache) await this.refresh(nowMs)
    else if (nowMs - this.cache.at >= this.cacheTtlMs && !this.inflight) {
      try { this.schedule(this.refresh(nowMs)) } catch (error) { warn("protection_schedule_failed", error) }
    }
    return (this.cache?.rows ?? []).filter(row => row.resolvedAt === null && row.endsAt > nowMs)
  }

  /** Resolves when no cache load is in flight. */
  whenIdle(): Promise<void> { return this.inflight ?? Promise.resolve() }

  private refresh(nowMs: number): Promise<void> {
    if (this.inflight) return this.inflight
    const work: Promise<void> = this.load(nowMs).finally(() => { if (this.inflight === work) this.inflight = null })
    this.inflight = work
    return work
  }

  private localEdit(apply: (rows: PauseRecord[]) => PauseRecord[]): void {
    if (this.cache) this.cache = { ...this.cache, rows: apply(this.cache.rows) }
    if (this.inflight) this.edits.push({ seq: ++this.seq, apply })
  }

  /** Fail-open: on error the previous rows (or none) stay in force and the next attempt waits for the TTL. */
  private async load(nowMs: number): Promise<void> {
    const startSeq = this.seq
    try {
      let rows = await this.repo().protection.listActive(nowMs)
      for (const edit of this.edits) if (edit.seq > startSeq) rows = edit.apply(rows)
      this.cache = { at: nowMs, rows }
    } catch (error) {
      warn("protection_cache_refresh_failed", error)
      this.cache = { at: nowMs, rows: this.cache?.rows ?? [] }
    } finally {
      this.edits = []
    }
  }

  /** Paused upstreams (mode `pause` only), mapped to the row that ends last. */
  async pausedUpstreams(): Promise<Map<string, PauseRecord>> {
    const out = new Map<string, PauseRecord>()
    for (const row of await this.activePauses()) {
      if (row.mode !== "pause" || row.targetKind !== "upstream") continue
      const previous = out.get(row.targetId)
      if (!previous || row.endsAt > previous.endsAt) out.set(row.targetId, row)
    }
    return out
  }

  /** The pause-mode row that blocks an API key (the one ending last), or null. The empty key id is never paused. */
  async pausedKey(keyId: string): Promise<PauseRecord | null> {
    if (keyId === "") return null
    let found: PauseRecord | null = null
    for (const row of await this.activePauses()) {
      if (row.mode === "pause" && row.targetKind === "key" && row.targetId === keyId && (!found || row.endsAt > found.endsAt)) found = row
    }
    return found
  }

  /** Resolves a row (`owner` from the dashboard) and drops it from this isolate's cache at once. */
  async resume(id: string, by: PauseResolver): Promise<boolean> {
    const resolved = await this.repo().protection.resolvePause(id, by, this.now())
    if (resolved) this.localEdit(rows => rows.filter(row => row.id !== id))
    return resolved
  }

  /** Display names captured when the row is created; a failed lookup just leaves them out. */
  private async names(upstreamId: string, target: { kind: string; id: string }): Promise<{ upstreamName?: string; targetName?: string }> {
    const repo = this.repo()
    const out: { upstreamName?: string; targetName?: string } = {}
    try { out.upstreamName = (await repo.upstreams.getById(upstreamId as UpstreamId))?.name } catch { /* optional */ }
    if (target.kind === "key") {
      try { out.targetName = (await repo.apiKeys.getById(target.id as ApiKeyId))?.name } catch { /* optional */ }
    } else out.targetName = out.upstreamName
    return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined))
  }
}

let current: ProtectionRuntime | null = null
/** The process-wide runtime: real repo, wall clock and `waitUntil`. */
export function getProtection(): ProtectionRuntime { return current ??= new ProtectionRuntime() }
export function setProtectionForTests(runtime: ProtectionRuntime | null): void { current = runtime }
__registerPlatformReset(() => { current = null })
