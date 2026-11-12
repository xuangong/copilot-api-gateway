import { useCallback, useEffect, useRef, useState } from "react"
import { useToast } from "./toast"
import { useConfirm } from "./confirm"
import { useT } from "./i18n"
import * as api from "../api/upstreams"
import type { UpstreamRecord } from "../api/types"
import { ReorderController, partitionPosition } from "./reorder-upstreams"

function sortUpstreams(list: UpstreamRecord[]): UpstreamRecord[] {
  return [...list].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1
    return a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt)
  })
}

export function useUpstreams() {
  const { push: toast } = useToast()
  const confirm = useConfirm()
  const t = useT()
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
  const [modelsByUpstream, setModelsByUpstream] = useState<Map<string, api.UpstreamModelEntry[]>>(new Map())
  const [liveLokiModels, setLiveLokiModels] = useState<Record<string, { ids: string[]; total: number }>>({})
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
      if (u?.provider === "loki") setLiveLokiModels(previous => {
        const { [id]: _, ...rest } = previous
        return rest
      })
      try {
        const r = await api.probeUpstream(id)
        if (r.ok) {
          if (u?.provider === "loki") setLiveLokiModels(previous => ({ ...previous, [id]: { ids: r.models ?? [], total: r.modelCount ?? r.models?.length ?? 0 } }))
          toast(t("dash.probeModelsToast", { name, n: r.modelCount ?? 0 }), "success")
          // Awaited so the row's busy state covers the list refresh too: the
          // probe route repopulates the server-side models cache before
          // answering, so this re-read is what makes "Models served (N)" agree
          // with the count in the toast.
          await loadModels()
        } else {
          const error = `${r.error ?? t("dash.probeFailed")}${r.hint ? ` — ${r.hint}` : ""}`
          toast(t("dash.probeFailedToast", { name, error }), "error")
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        toast(t("dash.probeFailedToast", { name, error: msg }), "error")
      }
    })

  const refreshCredential = (id: string) =>
    withBusy(id, async () => {
      await api.refreshCodexCredential(id)
      toast(t("dash.codexRefreshed"), "success")
      await reload()
    })

  const remove = async (u: UpstreamRecord): Promise<boolean> => {
    if (u.provider === "copilot") {
      const userId = u.config?.user?.id
      // Orphan copilot rows (legacy / hand-created entries with no GitHub
      // user attached) can't go through DELETE /auth/github/:id — fall back
      // to the generic upstream delete, which still cascade-cleans github_accounts.
      if (!userId) {
        const sure = await confirm({
          title: t("dash.confirmDeleteUpstream", { name: u.name }),
          description: t("dash.confirmDeleteUpstreamNoAccount"),
          confirmLabel: t("dash.delete"),
          danger: true,
        })
        if (!sure) return false
        const ok = await withBusy(u.id, async () => {
          await api.deleteUpstream(u.id)
          toast(t("dash.deletedToast", { name: u.name }), "success")
          await reload()
          return true
        })
        return ok === true
      }
      const sure = await confirm({
        title: t("dash.confirmSignOutUpstream", { name: u.name }),
        description: t("dash.confirmSignOutUpstreamHint"),
        confirmLabel: t("dash.signOut"),
        danger: true,
      })
      if (!sure) return false
      const ok = await withBusy(u.id, async () => {
        await api.deleteGithubAccount(userId)
        toast(t("dash.signedOutToast", { name: u.name }), "success")
        await reload()
        return true
      })
      return ok === true
    }
    const sure = await confirm({
      title: t("dash.confirmDeleteUpstream", { name: u.name }),
      description: t("dash.confirmDeleteUpstreamUsage"),
      confirmLabel: t("dash.delete"),
      danger: true,
    })
    if (!sure) return false
    const ok = await withBusy(u.id, async () => {
      await api.deleteUpstream(u.id)
      toast(t("dash.deletedToast", { name: u.name }), "success")
      await reload()
      return true
    })
    return ok === true
  }

  return {
    upstreams,
    loading,
    busy,
    modelsByUpstream,
    liveLokiModels,
    flagCatalog,
    reload,
    ensureFlagCatalog,
    toggleEnabled,
    reorder,
    reorderTo,
    probe,
    refreshCredential,
    remove,
    /** Where a row now sits among its reorderable peers, counting moves still being saved. */
    positionOf: (id: string, ownerId: string) => partitionPosition(controller.snapshot(), id, ownerId),
  }
}
