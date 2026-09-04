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
    (m) => m.id.startsWith("claude-") && m.supported_endpoints?.includes("/v1/messages"),
  )
  const claudeAll: string[] = []
  const destinationUpstreams = new Map<string, Set<string>>()
  const addDestination = (id: string, upstream: string) => {
    const upstreams = destinationUpstreams.get(id) ?? new Set<string>()
    upstreams.add(upstream)
    destinationUpstreams.set(id, upstreams)
  }
  for (const m of claudeBase) {
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
    .filter((m) => m.id.startsWith("gpt-") && m.supported_endpoints?.includes("/responses"))
    .map((m) => m.id)
  const codex = [...new Set(codexIds)].sort(sortCodex)

  const gemini = [...new Set(data.filter((m) => m.id.startsWith("gemini-")).map((m) => m.id))]

  const byUp = new Map<string, UpstreamModelGroup>()
  for (const m of data) {
    const up = m._upstream || "(legacy / unmanaged)"
    addDestination(m.id, up)
    if (!byUp.has(up)) byUp.set(up, { upstream: up, provider: m._provider || "?", models: [] })
    byUp.get(up)!.models.push({ id: m.id, name: m.name || m.id })
  }
  const byUpstream = [...byUp.values()].sort((a, b) => a.upstream.localeCompare(b.upstream))

  const mappingDestinations = [...destinationUpstreams.entries()]
    .map(([id, upstreams]) => ({ id, upstreams: [...upstreams].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.id.localeCompare(b.id))
  return { claudeBig, claudeSmall, codex, gemini, byUpstream, mappingDestinations }
}

const EMPTY: ModelCatalog = { claudeBig: [], claudeSmall: [], codex: [], gemini: [], byUpstream: [], mappingDestinations: [] }

export function useModelCatalog(keyId?: string) {
  const [catalog, setCatalog] = useState<ModelCatalog>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryCount = useRef(0)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // Upstreams belong to the key's owner, not the viewer, so a shared key
      // needs its own id here or the catalog comes back empty.
      const path = keyId ? `/api/models?keyId=${encodeURIComponent(keyId)}&dedupe=0` : "/api/models"
      const r = await api<{ data: RawModel[] }>(path)
      setCatalog(buildCatalog(r.data ?? []))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [keyId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // Upstream model fetch can transiently fail (e.g. Copilot session token
  // refresh hits a flaky network). When that produces an empty catalog,
  // schedule a single debounced retry so the user doesn't have to refresh.
  // Cap at 3 attempts — if it's still empty, the user genuinely has no
  // upstream and further retries are pointless.
  useEffect(() => {
    if (loading) return
    const empty = catalog.claudeBig.length === 0 && catalog.codex.length === 0 && catalog.gemini.length === 0
    if (!empty) { retryCount.current = 0; return }
    if (retryCount.current >= 3) return
    if (retryTimer.current) clearTimeout(retryTimer.current)
    retryTimer.current = setTimeout(() => { retryCount.current += 1; refresh() }, 1500)
    return () => { if (retryTimer.current) clearTimeout(retryTimer.current) }
  }, [loading, catalog, refresh])

  // Periodic refresh to pick up upstream changes (model added/removed,
  // upstream enabled/disabled). 60s is rare enough not to spam, fast
  // enough that a user adding an upstream sees it without F5.
  useEffect(() => {
    const id = setInterval(() => { refresh() }, 60_000)
    const onFocus = () => { refresh() }
    window.addEventListener("focus", onFocus)
    return () => { clearInterval(id); window.removeEventListener("focus", onFocus) }
  }, [refresh])

  return { catalog, loading, error, refresh }
}
