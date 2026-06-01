import { useCallback, useEffect, useMemo, useState } from "react"
import { useToast } from "./toast"
import * as api from "../api/keys"
import type { ApiKeyDetail, WebSearchRange, WebSearchUsage } from "../api/keys"

export interface QuotaUsage {
  reqLimit: number | null
  reqUsed: number
  reqPercent: number
  tokenLimit: number | null
  tokenUsed: number
  tokenPercent: number
}

const ZERO_QUOTA: QuotaUsage = {
  reqLimit: null,
  reqUsed: 0,
  reqPercent: 0,
  tokenLimit: null,
  tokenUsed: 0,
  tokenPercent: 0,
}

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

  const [quotaUsage, setQuotaUsage] = useState<QuotaUsage>(ZERO_QUOTA)
  const [wsUsage, setWsUsage] = useState<WebSearchUsage>(ZERO_WS_USAGE)
  const [wsUsageRange, setWsUsageRangeState] = useState<WebSearchRange>("1d")

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.listKeys()
      setKeys(list)
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

  // Recompute quota usage whenever the selected key changes.
  useEffect(() => {
    let cancelled = false
    if (!selectedKey) {
      setQuotaUsage(ZERO_QUOTA)
      return
    }
    const reqLimit = selectedKey.quota_requests_per_day ?? null
    const tokenLimit = selectedKey.quota_tokens_per_day ?? null
    api
      .getTodayTokenUsage(selectedKey.id)
      .then((records) => {
        if (cancelled) return
        let reqUsed = 0
        let weightedTokens = 0
        for (const r of records) {
          reqUsed += r.requests
          weightedTokens +=
            (r.cacheReadTokens ?? 0) * 0.1 + (r.inputTokens ?? 0) * 1.0 + (r.outputTokens ?? 0) * 5.0
        }
        setQuotaUsage({
          reqLimit,
          reqUsed,
          reqPercent: reqLimit ? Math.round((reqUsed / reqLimit) * 100) : 0,
          tokenLimit,
          tokenUsed: weightedTokens,
          tokenPercent: tokenLimit ? Math.round((weightedTokens / tokenLimit) * 100) : 0,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setQuotaUsage({
            reqLimit,
            reqUsed: 0,
            reqPercent: 0,
            tokenLimit,
            tokenUsed: 0,
            tokenPercent: 0,
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [selectedKey])

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
