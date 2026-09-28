import { useCallback, useEffect, useRef, useState } from "react"
import {
  downloadRedactedDump, dumpStreamUrl, getDumpRecord, listDumpRecords,
  type DumpMetadata, type DumpRecord,
} from "../api/dumps"

export type { DumpMetadata } from "../api/dumps"

export function mergeRecords(current: DumpMetadata[], incoming: DumpMetadata[]): DumpMetadata[] {
  const byId = new Map<string, DumpMetadata>()
  for (const record of current) byId.set(record.id, record)
  for (const record of incoming) byId.set(record.id, record)
  return [...byId.values()].sort((a, b) => b.completedAt - a.completedAt || (b.id > a.id ? 1 : b.id < a.id ? -1 : 0))
}

const message = (error: unknown): string => error instanceof Error ? error.message : "Request failed"

export function useDumps(keyId: string) {
  const [records, setRecords] = useState<DumpMetadata[]>([])
  const [detail, setDetail] = useState<DumpRecord | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [liveError, setLiveError] = useState<string | null>(null)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const cursor = useRef<string | undefined>(undefined)
  const active = useRef(false)
  const pageAbort = useRef<AbortController | null>(null)
  const detailAbort = useRef<AbortController | null>(null)
  const exportAbort = useRef<AbortController | null>(null)

  const loadPage = useCallback(async (before?: string): Promise<boolean> => {
    if (!active.current || pageAbort.current) return false
    const abort = new AbortController()
    pageAbort.current = abort
    if (before) setLoadingMore(true)
    else setLoading(true)
    try {
      const result = await listDumpRecords(keyId, before, abort.signal)
      if (!active.current || abort.signal.aborted) return false
      setRecords((current) => mergeRecords(current, result.records))
      cursor.current = result.records.at(-1)?.id
      setHasMore(result.records.length === 25)
      setListError(null)
      return true
    } catch (error) {
      if (!abort.signal.aborted && active.current) setListError(message(error))
      return false
    } finally {
      if (pageAbort.current === abort) {
        pageAbort.current = null
        if (active.current) { setLoading(false); setLoadingMore(false) }
      }
    }
  }, [keyId])

  useEffect(() => {
    let currentStream = true
    let source: EventSource | null = null
    active.current = true
    cursor.current = undefined
    setRecords([])
    setDetail(null)
    setSelectedId(null)
    setListError(null)
    setLiveError(null)
    setDetailError(null)
    setHasMore(false)
    void loadPage().then((loaded) => {
      if (!loaded || !currentStream) return
      source = new EventSource(dumpStreamUrl(keyId))
      source.addEventListener("snapshot", (event) => {
        if (!currentStream) return
        try {
          const parsed: unknown = JSON.parse((event as MessageEvent).data)
          if (parsed && typeof parsed === "object" && "records" in parsed && Array.isArray(parsed.records)) {
            setRecords((current) => mergeRecords(current, parsed.records as DumpMetadata[]))
            setLiveError(null)
          }
        } catch { setLiveError("Live snapshot could not be read.") }
      })
      source.addEventListener("appended", (event) => {
        if (!currentStream) return
        try {
          const record = JSON.parse((event as MessageEvent).data) as DumpMetadata
          if (typeof record.id === "string") {
            setRecords((current) => mergeRecords(current, [record]))
            setLiveError(null)
          }
        } catch { setLiveError("Live record could not be read.") }
      })
      source.addEventListener("error", () => {
        if (currentStream) setLiveError("Live updates disconnected. Reconnecting…")
      })
    })
    return () => {
      currentStream = false
      active.current = false
      pageAbort.current?.abort()
      pageAbort.current = null
      detailAbort.current?.abort()
      detailAbort.current = null
      exportAbort.current?.abort()
      exportAbort.current = null
      source?.close()
    }
  }, [keyId, loadPage])

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
    records, detail, selectedId, listError, liveError, detailError, loading, loadingMore, detailLoading,
    downloading, hasMore, openDetail, download,
    loadMore: () => { if (cursor.current) void loadPage(cursor.current) },
  }
}
