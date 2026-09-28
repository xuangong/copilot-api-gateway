import type { UpstreamRecord } from "../api/types"

type Move = { sourceId: string; ownerId: string } & (
  | { targetId: string; direction?: never }
  | { direction: "up" | "down"; targetId?: never }
)

function partition(row: UpstreamRecord, ownerId: string, enabled: boolean): boolean {
  return (row.ownerId ?? "") === ownerId && row.enabled === enabled
}

export function moveUpstream(
  rows: readonly UpstreamRecord[], sourceId: string, targetId: string, ownerId: string,
): UpstreamRecord[] {
  const source = rows.find((row) => row.id === sourceId)
  const target = rows.find((row) => row.id === targetId)
  if (!source || !target || sourceId === targetId ||
    !partition(source, ownerId, source.enabled) || !partition(target, ownerId, source.enabled)) return rows as UpstreamRecord[]
  const matching = rows.filter((row) => partition(row, ownerId, source.enabled))
  const from = matching.findIndex((row) => row.id === sourceId)
  const to = matching.findIndex((row) => row.id === targetId)
  if (from === to || from < 0 || to < 0) return rows as UpstreamRecord[]
  const moved = [...matching]
  moved.splice(from, 1)
  moved.splice(to, 0, source)
  let index = 0
  return rows.map((row) => partition(row, ownerId, source.enabled) ? moved[index++] ?? row : row)
}

export function sortValueForMove(
  rows: readonly UpstreamRecord[], sourceId: string, targetId: string, ownerId: string,
): number | null {
  const moved = moveUpstream(rows, sourceId, targetId, ownerId)
  if (moved === rows) return null
  const source = moved.find((row) => row.id === sourceId)
  if (!source) return null
  const group = moved.filter((row) => partition(row, ownerId, source.enabled))
  const index = group.findIndex((row) => row.id === sourceId)
  const before = group[index - 1]
  const after = group[index + 1]
  if (before && after) {
    const midpoint = (before.sortOrder + after.sortOrder) / 2
    return midpoint > before.sortOrder && midpoint < after.sortOrder ? midpoint : null
  }
  if (before) return before.sortOrder + 1
  if (after) return after.sortOrder - 1
  return null
}

function targetForMove(rows: readonly UpstreamRecord[], move: Move): string | null {
  if (move.targetId) return move.targetId
  const source = rows.find((row) => row.id === move.sourceId)
  if (!source) return null
  const group = rows.filter((row) => partition(row, move.ownerId, source.enabled))
  const index = group.findIndex((row) => row.id === move.sourceId)
  return group[index + (move.direction === "up" ? -1 : 1)]?.id ?? null
}

function applyMove(rows: readonly UpstreamRecord[], move: Move): UpstreamRecord[] {
  const targetId = targetForMove(rows, move)
  return targetId ? moveUpstream(rows, move.sourceId, targetId, move.ownerId) : rows as UpstreamRecord[]
}

export class ReorderController {
  private confirmed: UpstreamRecord[]
  private pending: Move[] = []
  private processing = false
  private listeners = new Set<() => void>()
  private waiters: Array<() => void> = []

  constructor(
    rows: UpstreamRecord[],
    private readonly patch: (id: string, sortOrder: number) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly onDrained: () => void = () => {},
    private readonly load?: () => Promise<UpstreamRecord[]>,
  ) { this.confirmed = rows }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit() { for (const listener of this.listeners) listener() }
  hasPending() { return this.pending.length > 0 || this.processing }

  snapshot(): UpstreamRecord[] {
    return this.pending.reduce<UpstreamRecord[]>(
      (rows, move) => applyMove(rows, move),
      this.confirmed,
    )
  }

  replace(rows: UpstreamRecord[]) {
    if (this.hasPending()) return
    this.confirmed = rows
    this.emit()
  }

  move(sourceId: string, targetId: string, ownerId: string): boolean {
    return this.enqueue({ sourceId, targetId, ownerId })
  }

  moveStep(sourceId: string, direction: "up" | "down", ownerId: string): boolean {
    return this.enqueue({ sourceId, direction, ownerId })
  }

  private enqueue(move: Move): boolean {
    const current = this.snapshot()
    if (applyMove(current, move) === current) return false
    this.pending.push(move)
    this.emit()
    void this.flush()
    return true
  }

  idle(): Promise<void> {
    if (!this.hasPending()) return Promise.resolve()
    return new Promise((resolve) => { this.waiters.push(resolve) })
  }

  private async flush() {
    if (this.processing) return
    this.processing = true
    while (this.pending.length > 0) {
      const move = this.pending[0]
      if (!move) break
      const targetId = targetForMove(this.confirmed, move)
      const value = targetId ? sortValueForMove(this.confirmed, move.sourceId, targetId, move.ownerId) : null
      const moved = applyMove(this.confirmed, move)
      if (moved !== this.confirmed) {
        const source = moved.find((row) => row.id === move.sourceId)
        const updates = value !== null
          ? [{ id: move.sourceId, sortOrder: value }]
          : source
            ? moved.filter((row) => partition(row, move.ownerId, source.enabled))
              .map((row, index) => ({ id: row.id, sortOrder: index * 10 }))
              .filter((update) => this.confirmed.find((row) => row.id === update.id)?.sortOrder !== update.sortOrder)
            : []
        const applied: typeof updates = []
        try {
          for (const update of updates) {
            await this.patch(update.id, update.sortOrder)
            applied.push(update)
          }
          const values = new Map(updates.map((update) => [update.id, update.sortOrder]))
          this.confirmed = moved.map((row) => {
            const sortOrder = values.get(row.id)
            return sortOrder === undefined ? row : { ...row, sortOrder }
          })
        } catch (error) {
          let compensationFailed = false
          for (const update of applied.reverse()) {
            const old = this.confirmed.find((row) => row.id === update.id)
            if (old) {
              try { await this.patch(update.id, old.sortOrder) } catch { compensationFailed = true }
            }
          }
          this.onError(error)
          if (compensationFailed && this.load) {
            // A failed compensation leaves the server order uncertain. Keep queued
            // intents intact until an authoritative read can rebase them.
            for (;;) {
              try {
                this.confirmed = await this.load()
                break
              } catch (loadError) {
                this.onError(loadError)
                await new Promise((resolve) => setTimeout(resolve, 1000))
              }
            }
          }
        }
      }
      this.pending.shift()
      this.emit()
    }
    this.processing = false
    this.emit()
    for (const resolve of this.waiters.splice(0)) resolve()
    this.onDrained()
  }
}
