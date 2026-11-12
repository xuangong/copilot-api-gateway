// Model catalog used by the Configuration panel. Replicates the legacy
// loadModels() logic from src/ui/dashboard/client.ts: expands composite
// claude ids (effort + 1m context) and groups every advertised model by
// its serving upstream.
import { useCallback, useEffect, useRef, useState } from "react"
import { api } from "../api/client"

export interface RawModel {
  id: string
  name?: string
  _upstream?: string
  _provider?: string
  /** Present only on key-specific aliases synthesized by the gateway. */
  _mapped_to?: string
  supported_endpoints?: string[]
  available_combinations?: Array<{ context1m?: boolean; effort?: string }>
}

export interface UpstreamModelEntry {
  id: string
  name: string
}
export interface UpstreamModelGroup {
  upstream: string
  provider: string
  models: UpstreamModelEntry[]
}

export interface ModelMappingDestination {
  id: string
  upstreams: string[]
}

export interface ModelCatalog {
  claudeBig: string[]
  claudeSmall: string[]
  codex: string[]
  gemini: string[]
  byUpstream: UpstreamModelGroup[]
  rawByUpstream: UpstreamModelGroup[]
  mappedModelIds: string[]
  mappingDestinations: ModelMappingDestination[]
}

const CLAUDE_TIER: Record<string, number> = { opus: 0, sonnet: 1, haiku: 2 }
function claudeTier(id: string): number {
  for (const t in CLAUDE_TIER) if (id.includes(t)) return CLAUDE_TIER[t]!
  return 99
}
function sortClaudeBig(a: string, b: string): number {
  const ta = claudeTier(a), tb = claudeTier(b)
  return ta !== tb ? ta - tb : b.localeCompare(a)
}
function sortClaudeSmall(a: string, b: string): number {
  const ta = claudeTier(a), tb = claudeTier(b)
  return ta !== tb ? tb - ta : b.localeCompare(a)
}
function sortCodex(a: string, b: string): number {
  const am = a.includes("mini") ? 1 : 0
  const bm = b.includes("mini") ? 1 : 0
  return am !== bm ? am - bm : b.localeCompare(a)
}

export function buildCatalog(data: RawModel[]): ModelCatalog {
  const claudeBase = data.filter(
    (m) => (m._mapped_to ?? m.id).startsWith("claude-") && m.supported_endpoints?.includes("/v1/messages"),
  )
  const claudeAll: string[] = []
  const destinationUpstreams = new Map<string, Set<string>>()
  const addDestination = (id: string, upstream: string) => {
    const upstreams = destinationUpstreams.get(id) ?? new Set<string>()
    upstreams.add(upstream)
    destinationUpstreams.set(id, upstreams)
  }
  for (const m of claudeBase) {
    if (m._mapped_to) {
      claudeAll.push(m.id)
      continue
    }
    const combos =
      Array.isArray(m.available_combinations) && m.available_combinations.length > 0
        ? m.available_combinations
        : [{ context1m: false, effort: undefined as string | undefined }]
    const effortCombinations = combos.filter((combination) => combination.effort)
    const supports1m = combos.some((combination) => combination.context1m)
    const destinationIds = new Set<string>()
    for (const combination of combos) {
      let id = m.id
      if (combination.effort) id += `-${combination.effort}`
      if (combination.context1m) id += "-1m"
      destinationIds.add(id)
    }
    // The gateway combines independent effort and 1M capabilities exposed by
    // sibling Copilot variants within one upstream; never across upstreams.
    if (supports1m) {
      for (const combination of effortCombinations) {
        destinationIds.add(`${m.id}-${combination.effort}-1m`)
      }
    }
    for (const id of destinationIds) {
      claudeAll.push(id)
      addDestination(id, m._upstream || "(legacy / unmanaged)")
    }
  }
  const claudeBig = [...new Set(claudeAll)].sort(sortClaudeBig)
  const claudeSmall = [...new Set(claudeAll)].sort(sortClaudeSmall)

  const codexIds = data
    .filter((m) => (m._mapped_to ?? m.id).startsWith("gpt-") && m.supported_endpoints?.includes("/responses"))
    .map((m) => m.id)
  const codex = [...new Set(codexIds)].sort(sortCodex)

  const gemini = [...new Set(data.filter((m) => (m._mapped_to ?? m.id).startsWith("gemini-")).map((m) => m.id))]

  const byUp = new Map<string, UpstreamModelGroup>()
  const rawByUp = new Map<string, UpstreamModelGroup>()
  for (const m of data) {
    const up = m._upstream || "(legacy / unmanaged)"
    const entry = { id: m.id, name: m.name || m.id }
    if (!m._mapped_to) {
      addDestination(m.id, up)
      const rawGroup = rawByUp.get(up) ?? { upstream: up, provider: m._provider || "?", models: [] }
      rawGroup.models.push(entry)
      rawByUp.set(up, rawGroup)
    }
    const group = byUp.get(up) ?? { upstream: up, provider: m._provider || "?", models: [] }
    group.models.push(entry)
    byUp.set(up, group)
  }
  const byUpstream = [...byUp.values()].sort((a, b) => a.upstream.localeCompare(b.upstream))
  const rawByUpstream = [...rawByUp.values()].sort((a, b) => a.upstream.localeCompare(b.upstream))
  const mappedModelIds = [...new Set(data.filter((model) => model._mapped_to).map((model) => model.id))]

  const mappingDestinations = [...destinationUpstreams.entries()]
    .map(([id, upstreams]) => ({ id, upstreams: [...upstreams].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { claudeBig, claudeSmall, codex, gemini, byUpstream, rawByUpstream, mappedModelIds, mappingDestinations }
}

const EMPTY: ModelCatalog = { claudeBig: [], claudeSmall: [], codex: [], gemini: [], byUpstream: [], rawByUpstream: [], mappedModelIds: [], mappingDestinations: [] }

/** A catalog and the key it was loaded for. */
export interface LoadedCatalog {
  key: string | undefined
  catalog: ModelCatalog
}

/**
 * What to show for `keyId`: the last loaded catalog, but only if it was loaded
 * for that key. `loaded` is null until anything has loaded.
 */
export function catalogFor(loaded: LoadedCatalog | null, keyId: string | undefined): { ready: boolean; catalog: ModelCatalog } {
  return loaded !== null && loaded.key === keyId
    ? { ready: true, catalog: loaded.catalog }
    : { ready: false, catalog: EMPTY }
}

export function useModelCatalog(keyId?: string) {
  // The last catalog that arrived, with its key. A refresh (focus, the minute
  // timer, empty-catalog retries) keeps it on show while it runs, so `ready`
  // tells a first load from those; another key shows an empty, not-ready
  // catalog until its own arrives. The caller keeps this hook across key
  // switches, hence per key.
  const [loaded, setLoaded] = useState<LoadedCatalog | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryCount = useRef(0)
  // Only the newest request for the key on show may write. Otherwise the
  // response for a key the user has just left can land last and put its
  // catalog, or its readiness, on the new key.
  const latestRequest = useRef(0)
  const shownKey = useRef(keyId)
  // Before the effect that loads, so a key switch is recorded first.
  useEffect(() => { shownKey.current = keyId }, [keyId])

  const refresh = useCallback(async () => {
    // A refresh for a key the user has since left (a save that finished after
    // the switch) has nothing to show, and must not cancel the new key's load.
    if (keyId !== shownKey.current) return
    const request = ++latestRequest.current
    const current = () => request === latestRequest.current
    setLoading(true)
    setError(null)
    try {
      // Upstreams belong to the key's owner, not the viewer, so a shared key
      // needs its own id here or the catalog comes back empty.
      const path = keyId ? `/api/models?keyId=${encodeURIComponent(keyId)}&dedupe=0` : "/api/models"
      const r = await api<{ data: RawModel[] }>(path)
      if (current()) setLoaded({ key: keyId, catalog: buildCatalog(r.data ?? []) })
    } catch (e) {
      if (current()) {
        setError(e instanceof Error ? e.message : String(e))
        // A failed first load shows this key as empty, not the last key's models.
        setLoaded((prev) => (prev?.key === keyId ? prev : { key: keyId, catalog: EMPTY }))
      }
    } finally {
      if (current()) setLoading(false)
    }
  }, [keyId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const { ready, catalog } = catalogFor(loaded, keyId)
  // Until this key's catalog is in, it counts as loading, so nothing judges
  // mappings or defaults against an empty stand-in.
  const busy = loading || !ready

  // Upstream model fetch can transiently fail (e.g. Copilot session token
  // refresh hits a flaky network). When that produces an empty catalog,
  // schedule a single debounced retry so the user doesn't have to refresh.
  // Cap at 3 attempts — if it's still empty, the user genuinely has no
  // upstream and further retries are pointless.
  useEffect(() => {
    if (busy) return
    const empty = catalog.claudeBig.length === 0 && catalog.codex.length === 0 && catalog.gemini.length === 0
    if (!empty) { retryCount.current = 0; return }
    if (retryCount.current >= 3) return
    if (retryTimer.current) clearTimeout(retryTimer.current)
    retryTimer.current = setTimeout(() => { retryCount.current += 1; refresh() }, 1500)
    return () => { if (retryTimer.current) clearTimeout(retryTimer.current) }
  }, [busy, catalog, refresh])

  // Periodic refresh to pick up upstream changes (model added/removed,
  // upstream enabled/disabled). 60s is rare enough not to spam, fast
  // enough that a user adding an upstream sees it without F5.
  useEffect(() => {
    const id = setInterval(() => { refresh() }, 60_000)
    const onFocus = () => { refresh() }
    window.addEventListener("focus", onFocus)
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus) }
  }, [refresh])

  return { catalog, loading: busy, ready, error, refresh }
}
