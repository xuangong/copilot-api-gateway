import type { DumpMetadata } from "../api/dumps"

export function mergeRecords(current: DumpMetadata[], incoming: DumpMetadata[]): DumpMetadata[] {
  const byId = new Map<string, DumpMetadata>()
  for (const record of current) byId.set(record.id, record)
  for (const record of incoming) byId.set(record.id, record)
  return [...byId.values()].sort((a, b) => b.completedAt - a.completedAt || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0))
}

export interface DumpLiveView {
  records: DumpMetadata[]
  cursor: string | undefined
  hasMore: boolean
  snapshotSeen: boolean
  continuity: "unknown" | "overflow" | "refreshing" | "refreshed" | null
  omittedRows: number
}
export const initialDumpLiveView = (): DumpLiveView => ({
  records: [], cursor: undefined, hasMore: false, snapshotSeen: false, continuity: null, omittedRows: 0,
})
export type DumpLiveChange =
  | { type: "snapshot"; records: DumpMetadata[]; omittedRows: number; before?: string; hasMore: boolean }
  | { type: "page"; records: DumpMetadata[] }
  | { type: "appended"; record: DumpMetadata }
  | { type: "disconnected" | "overflow" | "refresh" }

export function reduceDumpLiveView(state: DumpLiveView, change: DumpLiveChange): DumpLiveView {
  switch (change.type) {
    case "refresh": return { ...initialDumpLiveView(), continuity: "refreshing" }
    case "disconnected": return { ...state, continuity: state.continuity === "overflow" ? "overflow" : "unknown" }
    case "overflow": return { ...state, continuity: "overflow" }
    case "appended": return { ...state, records: mergeRecords(state.records, [change.record]) }
    case "page": return { ...state, records: mergeRecords(state.records, change.records),
      cursor: change.records.at(-1)?.id, hasMore: change.records.length === 25 }
    case "snapshot": return { ...state,
      records: state.snapshotSeen ? mergeRecords(state.records, change.records) : mergeRecords([], change.records),
      cursor: state.snapshotSeen ? state.cursor : change.before,
      hasMore: state.snapshotSeen ? state.hasMore : change.hasMore,
      snapshotSeen: true,
      omittedRows: Math.max(state.omittedRows, change.omittedRows),
      continuity: state.continuity === "refreshing" ? "refreshed" : state.continuity,
    }
  }
}

interface LiveSource {
  close(): void
  addEventListener(type: string, listener: EventListener): void
}
interface PageOwner { generation: number; abort: AbortController }

// The hook and tests share the same source/page lifetime owner. No timers or
// automatic overflow reconnect; a user refresh starts a new generation.
export class DumpLiveSession {
  private generation = 0
  private source: LiveSource | null = null
  private page: PageOwner | null = null
  private active = false

  start(source: LiveSource, listeners: Record<string, EventListener>): void {
    this.close()
    this.active = true
    this.source = source
    const generation = this.generation
    for (const [type, listener] of Object.entries(listeners)) {
      source.addEventListener(type, event => {
        if (this.active && generation === this.generation && this.source === source) listener(event)
      })
    }
  }

  disconnect(): void {
    const source = this.source
    this.source = null
    source?.close()
  }

  beginPage(): PageOwner | null {
    if (!this.active || this.page) return null
    this.page = { generation: this.generation, abort: new AbortController() }
    return this.page
  }

  isCurrent(page: PageOwner): boolean {
    return this.active && page.generation === this.generation && !page.abort.signal.aborted
  }

  finishPage(page: PageOwner): boolean {
    if (this.page !== page) return false
    this.page = null
    return this.isCurrent(page)
  }

  close(): void {
    this.active = false
    this.generation++
    this.page?.abort.abort()
    this.page = null
    this.disconnect()
  }
}
