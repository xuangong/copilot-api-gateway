import { useCallback, useEffect, useState } from "react"
import { useToast } from "./toast"
import * as api from "../api/upstreams"
import type { UpstreamRecord } from "../api/types"

function sortUpstreams(list: UpstreamRecord[]): UpstreamRecord[] {
  return [...list].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
  })
}

export function useUpstreams() {
  const { push: toast } = useToast()
  const [upstreams, setUpstreams] = useState<UpstreamRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [probeResults, setProbeResults] = useState<Record<string, api.ProbeResult>>({})
  const [modelsByUpstream, setModelsByUpstream] = useState<Map<string, api.UpstreamModelEntry[]>>(new Map())
  const [flagCatalog, setFlagCatalog] = useState<api.FlagCatalog | null>(null)

  const loadModels = useCallback(async () => {
    try {
      const m = await api.listModelsByUpstream()
      setModelsByUpstream(m)
    } catch (e) {
      console.error("loadModels:", e)
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const { upstreams } = await api.listUpstreams()
      setUpstreams(sortUpstreams(upstreams))
      loadModels()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setLoading(false)
    }
  }, [toast, loadModels])

  useEffect(() => {
    reload()
  }, [reload])

  const ensureFlagCatalog = useCallback(async () => {
    if (flagCatalog) return flagCatalog
    const c = await api.getFlagCatalog()
    setFlagCatalog(c)
    return c
  }, [flagCatalog])

  const withBusy = async <T,>(id: string, fn: () => Promise<T>): Promise<T | null> => {
    setBusy((b) => ({ ...b, [id]: true }))
    try {
      return await fn()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
      return null
    } finally {
      setBusy((b) => {
        const { [id]: _, ...rest } = b
        return rest
      })
    }
  }

  const toggleEnabled = (u: UpstreamRecord) =>
    withBusy(u.id, async () => {
      await api.patchUpstream(u.id, { enabled: !u.enabled })
      await reload()
    })

  const reorder = (id: string, direction: "up" | "down") =>
    withBusy(id, async () => {
      const target = upstreams.find((u) => u.id === id)
      if (!target) return
      // Reorder within the same owner-group only — the UI groups by owner
      // and the global list mixes them, so cross-group neighbors give wrong
      // sortOrder values.
      const group = sortUpstreams(upstreams.filter((u) => (u.ownerId ?? "") === (target.ownerId ?? "")))
      const idx = group.findIndex((u) => u.id === id)
      if (idx === -1) return
      let newSort: number
      if (direction === "up") {
        if (idx === 0) return
        const above = group[idx - 1]
        if (!above) return
        const aboveAbove = idx >= 2 ? group[idx - 2] : null
        // If neighbor has same sortOrder, force a strictly smaller value so
        // the row actually moves (avoids the "(0+0)/2 = 0" no-op).
        if (aboveAbove && aboveAbove.sortOrder !== above.sortOrder) {
          newSort = (above.sortOrder + aboveAbove.sortOrder) / 2
        } else {
          newSort = above.sortOrder - 1
        }
      } else {
        if (idx === group.length - 1) return
        const below = group[idx + 1]
        if (!below) return
        const belowBelow = idx + 2 < group.length ? group[idx + 2] : null
        if (belowBelow && belowBelow.sortOrder !== below.sortOrder) {
          newSort = (below.sortOrder + belowBelow.sortOrder) / 2
        } else {
          newSort = below.sortOrder + 1
        }
      }
      await api.patchUpstream(id, { sortOrder: newSort })
      await reload()
    })

  const probe = (id: string) =>
    withBusy(id, async () => {
      const u = upstreams.find((x) => x.id === id)
      const name = u?.name ?? id
      try {
        const r = await api.probeUpstream(id)
        setProbeResults((p) => ({ ...p, [id]: r }))
        if (r.ok) {
          toast(`${name}: ${r.modelCount ?? 0} models`, "success")
          loadModels()
        } else {
          toast(`${name}: ${r.error ?? "probe failed"}${r.hint ? ` — ${r.hint}` : ""}`, "error")
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setProbeResults((p) => ({ ...p, [id]: { ok: false, error: msg } }))
        toast(`${name}: ${msg}`, "error")
      }
    })

  const remove = async (u: UpstreamRecord): Promise<boolean> => {
    if (u.provider === "copilot") {
      const userId = u.config?.user?.id
      // Orphan copilot rows (legacy / hand-created entries with no GitHub
      // user attached) can't go through DELETE /auth/github/:id — fall back
      // to the generic upstream delete, which still cascade-cleans github_accounts.
      if (!userId) {
        if (!confirm(`Delete upstream "${u.name}"? (No GitHub account attached.)`)) return false
        const ok = await withBusy(u.id, async () => {
          await api.deleteUpstream(u.id)
          toast(`Deleted ${u.name}`, "success")
          await reload()
          return true
        })
        return ok === true
      }
      if (!confirm(`Sign out "${u.name}"? This removes the GitHub token from the gateway.`)) return false
      const ok = await withBusy(u.id, async () => {
        await api.deleteGithubAccount(userId)
        toast(`Signed out ${u.name}`, "success")
        await reload()
        return true
      })
      return ok === true
    }
    if (!confirm(`Delete upstream "${u.name}"? Existing usage rows stay attributed.`)) return false
    const ok = await withBusy(u.id, async () => {
      await api.deleteUpstream(u.id)
      toast(`Deleted ${u.name}`, "success")
      await reload()
      return true
    })
    return ok === true
  }

  return {
    upstreams,
    loading,
    busy,
    probeResults,
    modelsByUpstream,
    flagCatalog,
    reload,
    ensureFlagCatalog,
    toggleEnabled,
    reorder,
    probe,
    remove,
    setProbeResult: (id: string, r: api.ProbeResult) => setProbeResults((p) => ({ ...p, [id]: r })),
  }
}
