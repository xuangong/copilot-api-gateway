import { useCallback, useEffect, useRef, useState } from "react"
import { useToast } from "./toast"
import * as api from "../api/upstreams"
import type { UpstreamRecord } from "../api/types"
import { ReorderController } from "./reorder-upstreams"

function sortUpstreams(list: UpstreamRecord[]): UpstreamRecord[] {
  return [...list].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
  })
}

export function useUpstreams() {
  const { push: toast } = useToast()
  const [upstreams, setUpstreams] = useState<UpstreamRecord[]>([])
  const toastRef = useRef(toast)
  toastRef.current = toast
  const reloadRef = useRef<() => Promise<void>>(async () => {})
  const controllerRef = useRef<ReorderController | null>(null)
  if (!controllerRef.current) {
    controllerRef.current = new ReorderController(
      [],
      (id, sortOrder) => api.patchUpstream(id, { sortOrder }).then(() => {}),
      (error) => toastRef.current(error instanceof Error ? error.message : String(error), "error"),
      () => { void reloadRef.current() },
      async () => sortUpstreams((await api.listUpstreams()).upstreams),
    )
  }
  const controller = controllerRef.current
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

  useEffect(() => controller.subscribe(() => setUpstreams(controller.snapshot())), [controller])

  const reloadGeneration = useRef(0)

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current
    setLoading(true)
    try {
      const { upstreams } = await api.listUpstreams()
      if (generation === reloadGeneration.current) controller.replace(sortUpstreams(upstreams))
      loadModels()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      if (generation === reloadGeneration.current) setLoading(false)
    }
  }, [toast, loadModels, controller])
  reloadRef.current = reload

  useEffect(() => {
    reload()
  }, [reload])

  // The `flagCatalog` state guard can't stop concurrent first callers — they
  // all read null before any of them has set it. Hold the in-flight promise so
  // they share one request, and keep the callback identity stable so mounting
  // a form doesn't re-run its effect.
  const flagCatalogPromise = useRef<Promise<api.FlagCatalog> | null>(null)
  const ensureFlagCatalog = useCallback(async () => {
    if (!flagCatalogPromise.current) {
      flagCatalogPromise.current = api.getFlagCatalog().then(
        (c) => {
          setFlagCatalog(c)
          return c
        },
        (e) => {
          flagCatalogPromise.current = null
          throw e
        },
      )
    }
    return flagCatalogPromise.current
  }, [])

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

  const reorderTo = (id: string, targetId: string, ownerId: string) => controller.move(id, targetId, ownerId)
  const reorder = (id: string, direction: "up" | "down", ownerId: string) =>
    controller.moveStep(id, direction, ownerId)

  const probe = (id: string) =>
    withBusy(id, async () => {
      const u = upstreams.find((x) => x.id === id)
      const name = u?.name ?? id
      try {
        const r = await api.probeUpstream(id)
        setProbeResults((p) => ({ ...p, [id]: r }))
        if (r.ok) {
          toast(`${name}: ${r.modelCount ?? 0} models`, "success")
          // Awaited so the row's busy state covers the list refresh too: the
          // probe route repopulates the server-side models cache before
          // answering, so this re-read is what makes "Models served (N)" agree
          // with the count in the toast.
          await loadModels()
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
    reorderTo,
    probe,
    remove,
    setProbeResult: (id: string, r: api.ProbeResult) => setProbeResults((p) => ({ ...p, [id]: r })),
  }
}
