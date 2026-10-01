import { expect, test } from "bun:test"
import { DumpLiveSession, initialDumpLiveView, reduceDumpLiveView } from "./dump-live-session"
import type { DumpMetadata } from "../api/dumps"
const row = (id: string): DumpMetadata => ({ id, startedAt: 0, completedAt: 1, path: "/", method: "POST",
  status: 200, upstream: null, model: null, inputTokens: null, outputTokens: null, requestBytes: 0,
  responseBytes: 0, durationMs: 1, error: null })
class Source {
  closed = false
  listeners = new Map<string, EventListener>()
  close() { this.closed = true }
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (typeof listener !== "function") throw new Error("expected function listener")
    this.listeners.set(type, listener)
  }
  emit(type: string) { this.listeners.get(type)?.(new Event(type)) }
}

test("refresh cancels old page/stream and invalidates stale source and page callbacks", () => {
  const session = new DumpLiveSession()
  const old = new Source()
  let calls = 0
  session.start(old, { snapshot: () => calls++ })
  const page = session.beginPage()
  if (!page) throw new Error("missing page")
  expect(session.isCurrent(page)).toBe(true)
  const fresh = new Source()
  session.start(fresh, { snapshot: () => calls++ })
  expect(old.closed).toBe(true)
  expect(page.abort.signal.aborted).toBe(true)
  expect(session.isCurrent(page)).toBe(false)
  old.emit("snapshot")
  fresh.emit("snapshot")
  expect(calls).toBe(1)
  session.disconnect()
  expect(fresh.closed).toBe(true)
  fresh.emit("snapshot")
  expect(calls).toBe(1)
  session.close()
})

test("explicit refresh replaces latest records/cursor while older browsing and continuity remain honest", () => {
  let state = initialDumpLiveView()
  state = reduceDumpLiveView(state, { type: "snapshot", records: [row("A")], omittedRows: 2, before: "A", hasMore: true })
  state = reduceDumpLiveView(state, { type: "page", records: [row("older")] })
  state = reduceDumpLiveView(state, { type: "disconnected" })
  state = reduceDumpLiveView(state, { type: "appended", record: row("B") })
  expect(state.continuity).toBe("unknown")
  expect(state.omittedRows).toBe(2)
  state = reduceDumpLiveView(state, { type: "snapshot", records: [row("C")], omittedRows: 0, before: "C", hasMore: false })
  expect(state.records.map(record => record.id)).toContain("older")
  expect(state.cursor).toBe("older")
  expect(state.continuity).toBe("unknown")
  state = reduceDumpLiveView(state, { type: "overflow" })
  state = reduceDumpLiveView(state, { type: "refresh" })
  expect(state.records).toEqual([])
  expect(state.cursor).toBeUndefined()
  state = reduceDumpLiveView(state, { type: "snapshot", records: [row("latest")], omittedRows: 0, before: "latest", hasMore: false })
  expect(state.records.map(record => record.id)).toEqual(["latest"])
  expect(state.cursor).toBe("latest")
  expect(state.continuity).toBe("refreshed")
})


test("all-omitted snapshot preserves the server page cursor for actual session page work", () => {
  const session = new DumpLiveSession()
  let view = initialDumpLiveView()
  const source = new Source()
  session.start(source, { snapshot: () => {
    view = reduceDumpLiveView(view, { type: "snapshot", records: [], omittedRows: 100, before: "sql-oldest", hasMore: true })
  } })
  source.emit("snapshot")
  expect(view.cursor).toBe("sql-oldest")
  expect(view.hasMore).toBe(true)
  const page = session.beginPage()
  if (!page) throw new Error("page was not admitted")
  if (session.isCurrent(page)) view = reduceDumpLiveView(view, { type: "page", records: [row("older")] })
  expect(view.cursor).toBe("older")
  expect(view.omittedRows).toBe(100)
  session.finishPage(page)
  session.close()
})
