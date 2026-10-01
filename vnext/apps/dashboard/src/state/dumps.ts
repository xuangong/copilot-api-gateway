import { useCallback, useEffect, useRef, useState } from "react"
import {
  downloadRedactedDump, dumpStreamUrl, getDumpRecord, listDumpRecords,
  type DumpMetadata, type DumpRecord,
} from "../api/dumps"

export type { DumpMetadata } from "../api/dumps"

export { mergeRecords } from "./dump-live-session"
import { DumpLiveSession, initialDumpLiveView, reduceDumpLiveView } from "./dump-live-session"
import type { DumpLiveChange } from "./dump-live-session"

const message = (error: unknown): string => error instanceof Error ? error.message : "Request failed"

export function useDumps(keyId: string) {
  const [view, setView] = useState(initialDumpLiveView)
  const [session] = useState(() => new DumpLiveSession())
  const updateView = useCallback((change: DumpLiveChange) => setView(current => reduceDumpLiveView(current, change)), [])
  const [detail, setDetail] = useState<DumpRecord | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const active = useRef(false)
  const detailAbort = useRef<AbortController | null>(null)
  const exportAbort = useRef<AbortController | null>(null)

  const loadPage = useCallback(async (before: string): Promise<void> => {
    const page = session.beginPage()
    if (!page) return
    setLoadingMore(true)
    try {
      const result = await listDumpRecords(keyId, before, page.abort.signal)
      if (!session.isCurrent(page)) return
      updateView({ type: "page", records: result.records })
      setListError(null)
    } catch (error) {
      if (session.isCurrent(page)) setListError(message(error))
    } finally {
      if (session.finishPage(page)) setLoadingMore(false)
    }
  }, [keyId, session, updateView])

  const startStream = useCallback(() => {
    setLoading(true)
    setLoadingMore(false)
    setLiveError(null)
    setListError(null)
    session.start(new EventSource(dumpStreamUrl(keyId)), {
      snapshot: event => {
        try {
          const parsed: unknown = JSON.parse((event as MessageEvent).data)
          if (parsed && typeof parsed === "object" && "records" in parsed && Array.isArray(parsed.records)
            && "view" in parsed && parsed.view === "latest" && "omittedRows" in parsed
            && typeof parsed.omittedRows === "number" && "hasMore" in parsed && typeof parsed.hasMore === "boolean"
            && (!("before" in parsed) || typeof parsed.before === "string")) {
            updateView({ type: "snapshot", records: parsed.records as DumpMetadata[], omittedRows: parsed.omittedRows, hasMore: parsed.hasMore,
              ...("before" in parsed && typeof parsed.before === "string" ? { before: parsed.before } : {}) })
            setLoading(false)
            setLiveError(null)
          } else { setLiveError("Live snapshot could not be read."); setLoading(false) }
        } catch { setLiveError("Live snapshot could not be read."); setLoading(false) }
      },
      appended: event => {
        try {
          const record = JSON.parse((event as MessageEvent).data) as DumpMetadata
          if (typeof record.id === "string") {
            updateView({ type: "appended", record })
            setLiveError(null)
          }
        } catch { setLiveError("Live record could not be read.") }
      },
      reconciliation_required: () => {
        session.disconnect()
        updateView({ type: "overflow" })
        setLoading(false)
        setLiveError(null)
      },
      error: () => {
        updateView({ type: "disconnected" })
        setLoading(false)
        setLiveError("Live updates disconnected. Reconnecting…")
      },
    })
  }, [keyId, session, updateView])

  const refreshLatest = useCallback(() => {
    updateView({ type: "refresh" })
    startStream()
  }, [startStream, updateView])

  useEffect(() => {
    active.current = true
    setView(initialDumpLiveView())
    setDetail(null)
    setSelectedId(null)
    setListError(null)
    setDetailError(null)
    startStream()
    return () => {
      active.current = false
      session.close()
      detailAbort.current?.abort()
      detailAbort.current = null
      exportAbort.current?.abort()
      exportAbort.current = null
    }
  }, [session, startStream])

  const openDetail = useCallback(async (recordId: string) => {
    exportAbort.current?.abort()
    exportAbort.current = null
    setDownloading(false)
    detailAbort.current?.abort()
    const abort = new AbortController()
    detailAbort.current = abort
    setSelectedId(recordId)
    setDetail(null)
    setDetailError(null)
    setDetailLoading(true)
    try {
      const record = await getDumpRecord(keyId, recordId, abort.signal)
      if (active.current && !abort.signal.aborted) setDetail(record)
    } catch (error) {
      if (active.current && !abort.signal.aborted) setDetailError(message(error))
    } finally {
      if (active.current && !abort.signal.aborted) setDetailLoading(false)
      if (detailAbort.current === abort) detailAbort.current = null
    }
  }, [keyId])

  const download = useCallback(async () => {
    if (!selectedId) return
    exportAbort.current?.abort()
    const abort = new AbortController()
    exportAbort.current = abort
    setDownloading(true)
    setDetailError(null)
    try {
      await downloadRedactedDump(keyId, selectedId, abort.signal)
    } catch (error) {
      if (active.current && !abort.signal.aborted) setDetailError(message(error))
    } finally {
      if (active.current && !abort.signal.aborted) setDownloading(false)
      if (exportAbort.current === abort) exportAbort.current = null
    }
  }, [keyId, selectedId])

  return {
    records: view.records, continuity: view.continuity, omittedRows: view.omittedRows, refreshLatest, detail, selectedId, listError, liveError, detailError, loading, loadingMore, detailLoading,
    downloading, hasMore: view.hasMore, openDetail, download,
    loadMore: () => { if (view.cursor) void loadPage(view.cursor) },
  }
}
