import { useEffect, useMemo, useState } from "react"
import { useT } from "../../state/i18n"
import { listKeys, type ApiKeyDetail } from "../../api/keys"
import { listPlaygroundModels, type PlaygroundModel } from "../../api/models"
import { ChatPanel } from "./ChatPanel"

const LS_KEY_ID = "playground.keyId"
const LS_OPEN_GROUPS = "playground.openGroups"

export function ModelsTab() {
  const t = useT()
  const [keys, setKeys] = useState<ApiKeyDetail[] | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [selectedKeyId, setSelectedKeyId] = useState<string>(() => localStorage.getItem(LS_KEY_ID) ?? "")
  const [models, setModels] = useState<PlaygroundModel[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [selectedModelId, setSelectedModelId] = useState<string>("")
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(LS_OPEN_GROUPS)
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })
  const [systemPrompt, setSystemPrompt] = useState("")
  const [systemOpen, setSystemOpen] = useState(false)

  // Load user keys (only owned + enabled — same source as KeysTab).
  useEffect(() => {
    listKeys()
      .then((all) => {
        const enabled = all.filter((k) => k.is_owner)
        enabled.sort((a, b) => a.created_at.localeCompare(b.created_at))
        setKeys(enabled)
        if (enabled.length === 0) return
        const first = enabled[0]!
        const remembered = enabled.find((k) => k.id === selectedKeyId)
        const initial = remembered?.id ?? first.id
        if (initial !== selectedKeyId) setSelectedKeyId(initial)
      })
      .catch((e: Error) => setKeyError(e.message))
  }, [])

  // Persist key selection.
  useEffect(() => {
    if (selectedKeyId) localStorage.setItem(LS_KEY_ID, selectedKeyId)
  }, [selectedKeyId])

  // Load models when key changes.
  useEffect(() => {
    if (!selectedKeyId || !keys) return
    const key = keys.find((k) => k.id === selectedKeyId)
    if (!key) return
    setModels(null)
    setModelsError(null)
    listPlaygroundModels(key.key)
      .then((resp) => setModels(resp.data))
      .catch((e: Error) => setModelsError(e.message))
  }, [selectedKeyId, keys])

  // Group models by _upstream.
  const grouped = useMemo(() => {
    const groups = new Map<string, PlaygroundModel[]>()
    if (!models) return groups
    const needle = search.trim().toLowerCase()
    for (const m of models) {
      if (needle) {
        const hay = `${m.id} ${m.name ?? ""}`.toLowerCase()
        if (!hay.includes(needle)) continue
      }
      const g = groups.get(m._upstream) ?? []
      g.push(m)
      groups.set(m._upstream, g)
    }
    for (const arr of groups.values()) arr.sort((a, b) => a.id.localeCompare(b.id))
    return groups
  }, [models, search])

  // Auto-select first model on first render with data.
  useEffect(() => {
    if (selectedModelId) return
    for (const arr of grouped.values()) {
      if (arr.length) {
        setSelectedModelId(arr[0]!.id)
        return
      }
    }
  }, [grouped, selectedModelId])

  function toggleGroup(g: string) {
    setOpenGroups((prev) => {
      const next = { ...prev, [g]: prev[g] === false ? true : false }
      localStorage.setItem(LS_OPEN_GROUPS, JSON.stringify(next))
      return next
    })
  }

  // Empty state: no keys at all.
  if (keys && keys.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="border border-themed rounded-lg p-6 text-center max-w-sm">
          <div className="text-lg font-medium mb-2">{t("dash.playground.noKey")}</div>
          <div className="text-sm text-themed-dim mb-4">{t("dash.playground.noKeyBody")}</div>
          <button
            onClick={() => { window.location.hash = "#keys" }}
            className="px-4 py-2 bg-accent-cyan text-black text-sm rounded"
          >
            {t("dash.playground.createKey")}
          </button>
        </div>
      </div>
    )
  }

  if (keyError) return <div className="text-sm text-accent-red p-4">{keyError}</div>
  if (!keys) return <div className="text-sm text-themed-dim p-4">Loading…</div>

  const selectedKey = keys.find((k) => k.id === selectedKeyId)

  return (
    <div className="flex flex-col h-[calc(100vh-140px)] min-h-[560px]">
      {/* Top bar: key dropdown + system toggle */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-themed">
        <label className="text-xs text-themed-dim">{t("dash.playground.sendWithKey")}:</label>
        <select
          value={selectedKeyId}
          onChange={(e) => setSelectedKeyId(e.target.value)}
          className="text-xs border border-themed rounded px-2 py-1 bg-transparent"
        >
          {keys.map((k) => (
            <option key={k.id} value={k.id}>{k.name || k.id}</option>
          ))}
        </select>
        <button
          onClick={() => setSystemOpen((v) => !v)}
          className="text-xs px-2 py-1 border border-themed rounded ml-2"
        >
          {t("dash.playground.system")} {systemOpen ? "▴" : "▾"}
        </button>
      </div>

      {systemOpen && (
        <div className="border-b border-themed p-3">
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t("dash.playground.systemPlaceholder")}
            className="w-full text-sm border border-themed rounded px-2 py-1 bg-transparent min-h-[60px]"
          />
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Left: search + grouped model list */}
        <div className="w-72 shrink-0 border-r border-themed flex flex-col min-h-0">
          <div className="p-2 border-b border-themed">
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("dash.playground.searchModels")}
              className="w-full text-xs border border-themed rounded px-2 py-1 bg-transparent"
            />
          </div>
          <div className="flex-1 overflow-auto">
            {modelsError && <div className="text-xs text-accent-red p-3">{modelsError}</div>}
            {!modelsError && !models && <div className="text-xs text-themed-dim p-3">Loading…</div>}
            {Array.from(grouped.entries()).map(([upstream, arr]) => {
              const isOpen = openGroups[upstream] !== false  // default open
              return (
                <div key={upstream} className="border-b border-themed">
                  <button
                    onClick={() => toggleGroup(upstream)}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-themed-dim hover:bg-themed-soft"
                  >
                    <span>{upstream} ({arr.length})</span>
                    <span>{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && arr.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setSelectedModelId(m.id)}
                      className={
                        "w-full text-left px-4 py-2 text-xs border-l-2 " +
                        (m.id === selectedModelId
                          ? "bg-accent-cyan/10 border-l-accent-cyan text-accent-cyan"
                          : "border-l-transparent text-themed hover:bg-themed-soft")
                      }
                    >
                      <div className="truncate">{m.name ?? m.id}</div>
                      <div className="font-mono opacity-60 truncate">{m.id}</div>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </div>

        {/* Right: chat panel */}
        <div className="flex-1 min-w-0">
          {selectedModelId && selectedKey ? (
            <ChatPanel modelId={selectedModelId} apiKey={selectedKey.key} systemPrompt={systemPrompt} />
          ) : (
            <div className="flex items-center justify-center h-full text-themed-dim text-sm">
              {t("dash.playground.selectModel")}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
