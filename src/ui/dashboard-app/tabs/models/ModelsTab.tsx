import { useEffect, useMemo, useState } from "react"
import { useT } from "../../state/i18n"
import { Select } from "../../components/Select"
import { listKeys, type ApiKeyDetail } from "../../api/keys"
import { listPlaygroundModels, type PlaygroundModel } from "../../api/models"
import { ChatPanel } from "./ChatPanel"

const LS_KEY_ID = "playground.keyId"
const LS_OPEN_GROUPS = "playground.openGroups"
const LS_MODEL_ID = "playground.modelId"
const LS_SYSTEM_PROMPT = "playground.systemPrompt"
const LS_SYSTEM_OPEN = "playground.systemOpen"
const LS_WEB_SEARCH = "playground.webSearchEnabled"
const MOBILE_BREAKPOINT = 768

export function ModelsTab() {
  const t = useT()
  const [keys, setKeys] = useState<ApiKeyDetail[] | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [selectedKeyId, setSelectedKeyId] = useState<string>(() => localStorage.getItem(LS_KEY_ID) ?? "")
  const [models, setModels] = useState<PlaygroundModel[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [selectedModelId, setSelectedModelId] = useState<string>(() => localStorage.getItem(LS_MODEL_ID) ?? "")
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(LS_OPEN_GROUPS)
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
    } catch {
      return {}
    }
  })
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem(LS_SYSTEM_PROMPT) ?? "")
  const [systemOpen, setSystemOpen] = useState(() => localStorage.getItem(LS_SYSTEM_OPEN) === "1")
  const [webSearchEnabled, setWebSearchEnabled] = useState(() => localStorage.getItem(LS_WEB_SEARCH) === "1")
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < MOBILE_BREAKPOINT : false,
  )
  const [drawerOpen, setDrawerOpen] = useState(false)

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    listKeys()
      .then((all) => {
        const enabled = all.slice()
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

  useEffect(() => {
    if (selectedKeyId) localStorage.setItem(LS_KEY_ID, selectedKeyId)
  }, [selectedKeyId])

  useEffect(() => {
    if (selectedModelId) localStorage.setItem(LS_MODEL_ID, selectedModelId)
  }, [selectedModelId])

  useEffect(() => {
    localStorage.setItem(LS_SYSTEM_PROMPT, systemPrompt)
  }, [systemPrompt])

  useEffect(() => {
    localStorage.setItem(LS_SYSTEM_OPEN, systemOpen ? "1" : "0")
  }, [systemOpen])

  useEffect(() => {
    localStorage.setItem(LS_WEB_SEARCH, webSearchEnabled ? "1" : "0")
  }, [webSearchEnabled])

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

  useEffect(() => {
    if (!models) return
    // Keep remembered selection if still available; otherwise fall back to the first model.
    const exists = selectedModelId && models.some((m) => m.id === selectedModelId)
    if (exists) return
    for (const arr of grouped.values()) {
      if (arr.length) {
        setSelectedModelId(arr[0]!.id)
        return
      }
    }
  }, [grouped, models, selectedModelId])

  function toggleGroup(g: string) {
    setOpenGroups((prev) => {
      const next = { ...prev, [g]: prev[g] === false ? true : false }
      localStorage.setItem(LS_OPEN_GROUPS, JSON.stringify(next))
      return next
    })
  }

  function pickModel(id: string) {
    setSelectedModelId(id)
    if (isMobile) setDrawerOpen(false)
  }

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
  const selectedModel = models?.find((m) => m.id === selectedModelId)

  const modelList = (
    <ModelList
      grouped={grouped}
      modelsError={modelsError}
      models={models}
      search={search}
      onSearch={setSearch}
      selectedModelId={selectedModelId}
      onPick={pickModel}
      openGroups={openGroups}
      onToggleGroup={toggleGroup}
    />
  )

  return (
    <div className="flex flex-col flex-1 min-h-0 h-full">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-themed flex-wrap">
        {isMobile && (
          <button
            onClick={() => setDrawerOpen(true)}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-surface-800 text-themed-secondary hover:text-themed transition-all"
          >
            {t("dash.playground.modelsDrawer")} ▾
          </button>
        )}
        <label className="text-xs text-themed-dim">{t("dash.playground.sendWithKey")}:</label>
        <Select
          value={selectedKeyId}
          onChange={setSelectedKeyId}
          className="min-w-[160px]"
          options={keys.map((k) => ({ value: k.id, label: k.name || k.id }))}
        />
        <button
          onClick={() => setSystemOpen((v) => !v)}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ml-2 ${
            systemOpen
              ? "bg-surface-600 text-themed"
              : "bg-surface-800 text-themed-dim hover:text-themed-secondary"
          }`}
        >
          {t("dash.playground.system")} {systemOpen ? "▴" : "▾"}
        </button>
        <button
          onClick={() => setWebSearchEnabled((v) => !v)}
          title={t("dash.playground.webSearchTitle")}
          className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
            webSearchEnabled
              ? "bg-surface-600 text-themed"
              : "bg-surface-800 text-themed-dim hover:text-themed-secondary"
          }`}
        >
          🔍 {t("dash.playground.webSearch")}
        </button>
        {isMobile && selectedModel && (
          <span className="text-xs text-themed-dim font-mono truncate max-w-[40%]">
            {selectedModel.name ?? selectedModel.id}
          </span>
        )}
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

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isMobile && (
          <div className="w-72 shrink-0 border-r border-themed flex flex-col min-h-0 overflow-hidden">
            {modelList}
          </div>
        )}

        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          {selectedModelId && selectedKey ? (
            <ChatPanel modelId={selectedModelId} apiKey={selectedKey.key} systemPrompt={systemPrompt} webSearchEnabled={webSearchEnabled} onRevertModel={setSelectedModelId} />
          ) : (
            <div className="flex items-center justify-center h-full text-themed-dim text-sm">
              {t("dash.playground.selectModel")}
            </div>
          )}
        </div>
      </div>

      {isMobile && drawerOpen && (
        <>
          <div className="pg-drawer-backdrop" onClick={() => setDrawerOpen(false)} />
          <div className="pg-drawer flex flex-col">
            <div className="flex items-center justify-between px-3 py-2 border-b border-themed">
              <span className="text-sm font-medium">{t("dash.playground.modelsDrawer")}</span>
              <button
                onClick={() => setDrawerOpen(false)}
                className="px-3 py-1 rounded-md text-xs font-medium bg-surface-800 text-themed-secondary hover:text-themed transition-all"
              >
                ✕
              </button>
            </div>
            {modelList}
          </div>
        </>
      )}
    </div>
  )
}

interface ListProps {
  grouped: Map<string, PlaygroundModel[]>
  modelsError: string | null
  models: PlaygroundModel[] | null
  search: string
  onSearch: (v: string) => void
  selectedModelId: string
  onPick: (id: string) => void
  openGroups: Record<string, boolean>
  onToggleGroup: (g: string) => void
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function ModelList({
  grouped, modelsError, models, search, onSearch, selectedModelId, onPick, openGroups, onToggleGroup,
}: ListProps) {
  const t = useT()
  return (
    <>
      <div className="p-2 border-b border-themed">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t("dash.playground.searchModels")}
          className="w-full text-xs border border-themed rounded px-2 py-1 bg-transparent"
        />
      </div>
      <div className="flex-1 overflow-auto">
        {modelsError && <div className="text-xs text-accent-red p-3">{modelsError}</div>}
        {!modelsError && !models && <div className="text-xs text-themed-dim p-3">Loading…</div>}
        {Array.from(grouped.entries()).map(([upstream, arr]) => {
          const isOpen = openGroups[upstream] !== false
          return (
            <div key={upstream} className="border-b border-themed">
              <button
                onClick={() => onToggleGroup(upstream)}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-themed-dim hover:bg-themed-soft"
              >
                <span>{upstream} ({arr.length})</span>
                <span>{isOpen ? "▾" : "▸"}</span>
              </button>
              {isOpen && arr.map((m) => {
                const ctx = m.capabilities?.limits?.max_context_window_tokens
                const out = m.capabilities?.limits?.max_output_tokens
                const isSelected = m.id === selectedModelId
                return (
                <button
                  key={m.id}
                  onClick={() => onPick(m.id)}
                  className={"pg-model-item" + (isSelected ? " is-selected" : "")}
                >
                  <div className="pg-model-item-name">{m.name ?? m.id}</div>
                  <div className="pg-model-item-meta">
                    <div className="font-mono truncate">{m.id}</div>
                    {(ctx || out) && (
                      <div className="font-mono opacity-70 text-[10px] mt-0.5">
                        {ctx ? `ctx ${formatTokens(ctx)}` : ""}
                        {ctx && out ? " · " : ""}
                        {out ? `out ${formatTokens(out)}` : ""}
                      </div>
                    )}
                  </div>
                </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </>
  )
}
