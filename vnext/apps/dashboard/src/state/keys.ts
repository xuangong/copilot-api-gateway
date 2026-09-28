import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useToast } from "./toast"
import * as api from "../api/keys"
import type { ApiKeyDetail, WebSearchRange, WebSearchUsage } from "../api/keys"
import { beginQuotaLoad, failQuotaLoad, finishQuotaLoad, IDLE_QUOTA, projectQuotaUsage, type QuotaLoad } from "./key-quota"

const ZERO_WS_USAGE: WebSearchUsage = {
  range: "1d",
  days: 1,
  searches: 0,
  successes: 0,
  failures: 0,
  engines: [],
}

export interface JustCreatedKey {
  id: string
  name: string
  key: string
  baseUrl: string
}

export function useKeys() {
  const { push: toast } = useToast()
  const [keys, setKeys] = useState<ApiKeyDetail[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [creating, setCreating] = useState(false)
  const [justCreated, setJustCreated] = useState<JustCreatedKey | null>(null)

  const [quotaLoad, setQuotaLoad] = useState<QuotaLoad>(IDLE_QUOTA)
  const [quotaRetry, setQuotaRetry] = useState(0)
  const [quotaReload, setQuotaReload] = useState(0)
  const quotaRequestId = useRef(0)
  const [wsUsage, setWsUsage] = useState<WebSearchUsage>(ZERO_WS_USAGE)
  const [wsUsageRange, setWsUsageRangeState] = useState<WebSearchRange>("1d")

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.listKeys()
      setKeys(list)
      setQuotaReload((n) => n + 1)
      setSelectedKeyId((cur) => (cur && list.some((k) => k.id === cur) ? cur : cur))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    reload()
  }, [reload])

  // Drop selection if it disappears.
  useEffect(() => {
    if (selectedKeyId && !keys.some((k) => k.id === selectedKeyId)) {
      setSelectedKeyId(null)
    }
  }, [keys, selectedKeyId])

  const selectedKey = useMemo(
    () => keys.find((k) => k.id === selectedKeyId) ?? null,
    [keys, selectedKeyId],
  )

  const withBusy = useCallback(
    async <T,>(id: string, fn: () => Promise<T>): Promise<T | null> => {
      setBusy((b) => ({ ...b, [id]: true }))
      try {
        return await fn()
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error")
        return null
      } finally {
        setBusy((b) => {
          const { [id]: _omit, ...rest } = b
          return rest
        })
      }
    },
    [toast],
  )

  const createKey = useCallback(
    async (name: string): Promise<JustCreatedKey | null> => {
      const trimmed = name.trim()
      if (!trimmed) return null
      setCreating(true)
      try {
        const created = await api.createKey(trimmed)
        const surface: JustCreatedKey = {
          id: created.id,
          name: created.name || trimmed,
          key: created.key,
          baseUrl: window.location.origin,
        }
        setJustCreated(surface)
        setSelectedKeyId(created.id)
        await reload()
        return surface
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error")
        return null
      } finally {
        setCreating(false)
      }
    },
    [reload, toast],
  )

  const deleteKey = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      if (!confirm(`Delete API key "${name}"? This cannot be undone.`)) return false
      const ok = await withBusy(id, async () => {
        await api.deleteKey(id)
        toast(`Deleted ${name}`, "success")
        await reload()
        return true
      })
      return ok === true
    },
    [reload, toast, withBusy],
  )

  const patchKey = useCallback(
    async (id: string, body: api.KeyPatchBody): Promise<boolean> => {
      const ok = await withBusy(id, async () => {
        await api.patchKey(id, body)
        await reload()
        return true
      })
      return ok === true
    },
    [reload, withBusy],
  )

  const copyWebSearchFrom = useCallback(
    async (id: string, sourceId: string): Promise<boolean> => {
      const ok = await withBusy(id, async () => {
        await api.copyWebSearchFrom(id, sourceId)
        toast("Web search config copied", "success")
        await reload()
        return true
      })
      return ok === true
    },
    [reload, toast, withBusy],
  )

  const assignKey = useCallback(
    async (id: string, email: string): Promise<boolean> => {
      try {
        await api.assignKey(id, { email })
        toast(`Shared with ${email}`, "success")
        await reload()
        return true
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error")
        return false
      }
    },
    [reload, toast],
  )

  const unassignKey = useCallback(
    async (id: string, userId: string): Promise<boolean> => {
      try {
        await api.unassignKey(id, userId)
        toast("Removed share", "success")
        await reload()
        return true
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error")
        return false
      }
    },
    [reload, toast],
  )

  const retryQuota = useCallback(() => setQuotaRetry((n) => n + 1), [])
  const selectedQuotaKeyId = selectedKey?.id

  // Keep the last successful total only while the same key is selected.
  useEffect(() => {
    const requestId = ++quotaRequestId.current
    if (!selectedQuotaKeyId) {
      setQuotaLoad(IDLE_QUOTA)
      return
    }
    const controller = new AbortController()
    const keyId = selectedQuotaKeyId
    setQuotaLoad((previous) => beginQuotaLoad(previous, keyId, requestId))
    api
      .getMonthUsageTotal(keyId, new Date(), controller.signal)
      .then((total) => {
        if (!controller.signal.aborted && quotaRequestId.current === requestId) {
          setQuotaLoad((previous) => finishQuotaLoad(previous, keyId, requestId, total))
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && quotaRequestId.current === requestId) {
          setQuotaLoad((previous) => failQuotaLoad(previous, keyId, requestId, error instanceof Error ? error.message : String(error)))
        }
      })
    return () => {
      controller.abort()
    }
  }, [selectedQuotaKeyId, quotaRetry, quotaReload])

  const selectedQuotaLoad = quotaLoad.keyId === selectedKey?.id ? quotaLoad : IDLE_QUOTA
  const quotaUsage = selectedKey && selectedQuotaLoad.total
    ? projectQuotaUsage(selectedKey, selectedQuotaLoad.total)
    : null

  // Recompute web-search usage when selected key or range changes.
  useEffect(() => {
    let cancelled = false
    if (!selectedKey) {
      setWsUsage(ZERO_WS_USAGE)
      return
    }
    api
      .getWebSearchUsage(selectedKey.id, wsUsageRange)
      .then((u) => {
        if (!cancelled) setWsUsage(u)
      })
      .catch(() => {
        if (!cancelled) setWsUsage({ ...ZERO_WS_USAGE, range: wsUsageRange })
      })
    return () => {
      cancelled = true
    }
  }, [selectedKey, wsUsageRange])

  const setWsUsageRange = useCallback((range: WebSearchRange) => {
    setWsUsageRangeState(range)
  }, [])

  return {
    keys,
    loading,
    busy,
    creating,
    justCreated,
    setJustCreated,
    selectedKeyId,
    setSelectedKeyId,
    selectedKey,
    quotaUsage,
    quotaLoad: selectedQuotaLoad,
    retryQuota,
    wsUsage,
    wsUsageRange,
    setWsUsageRange,
    reload,
    createKey,
    deleteKey,
    patchKey,
    copyWebSearchFrom,
    assignKey,
    unassignKey,
  }
}
