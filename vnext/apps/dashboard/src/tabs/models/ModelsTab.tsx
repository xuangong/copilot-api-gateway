import * as RadixDialog from "@radix-ui/react-dialog"
import { ArrowRight, ChevronDown, ChevronRight, ChevronUp, Search, X } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"
import { EmptyState } from "../../ui/empty-state"
import { Notice } from "../../ui/notice"
import { Select, type SelectOption } from "../../ui/select"
import { listKeys, type ApiKeyDetail } from "../../api/keys"
import { listPlaygroundModels, type PlaygroundModel } from "../../api/models"
import { ChatPanel } from "./ChatPanel"
import { DecisionPanel } from "./DecisionPanel"
import { EmbeddingPanel } from "./EmbeddingPanel"
import { visionSupport } from "./vision"
import { DEFAULT_IMAGE_PARAMS, playgroundMode, type ImageParams, type PlaygroundMode } from "./images"
import { formatTokens } from "./tokens"
import { playgroundModelOptions } from "./model-options"

const LS_KEY_ID = "playground.keyId"
const LS_OPEN_GROUPS = "playground.openGroups"
const LS_MODEL_ID = "playground.modelId"
const LS_SYSTEM_PROMPT = "playground.systemPrompt"
const LS_SYSTEM_OPEN = "playground.systemOpen"
const LS_WEB_SEARCH = "playground.webSearchEnabled"
const LS_IMAGE_PARAMS = "playground.imageParams"
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
  const [webSearchEnabled, setWebSearchEnabled] = useState(() => {
    const v = localStorage.getItem(LS_WEB_SEARCH)
    return v === null ? true : v === "1"
  })
  const [imageParams, setImageParams] = useState<ImageParams>(() => {
    try {
      const raw = localStorage.getItem(LS_IMAGE_PARAMS)
      // Merge over the defaults so a params field added later doesn't arrive
      // undefined from an older persisted blob.
      return raw ? { ...DEFAULT_IMAGE_PARAMS, ...(JSON.parse(raw) as ImageParams) } : DEFAULT_IMAGE_PARAMS
    } catch {
      return DEFAULT_IMAGE_PARAMS
    }
  })
  const [isMobile, setIsMobile] = useState(
    typeof window !== "undefined" ? window.innerWidth < MOBILE_BREAKPOINT : false,
  )
  const [drawerOpen, setDrawerOpen] = useState(false)
  const keyLabelId = useId()
  const keySelectId = useId()

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  useEffect(() => {
    listKeys()
      .then((all) => {
        // Every key is offered, oldest first; nothing is filtered out.
        const sorted = all.slice()
        sorted.sort((a, b) => a.created_at.localeCompare(b.created_at))
        setKeys(sorted)
        if (sorted.length === 0) return
        const first = sorted[0]!
        const remembered = sorted.find((k) => k.id === selectedKeyId)
        const initial = remembered?.id ?? first.id
        if (initial !== selectedKeyId) setSelectedKeyId(initial)
      })
      .catch((e: Error) => setKeyError(e.message))
    // Run once on mount: `selectedKeyId` here is the remembered key read from
    // storage, and re-running on every pick would refetch the key list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    localStorage.setItem(LS_IMAGE_PARAMS, JSON.stringify(imageParams))
  }, [imageParams])

  useEffect(() => {
    if (!selectedKeyId || !keys) return
    const key = keys.find((k) => k.id === selectedKeyId)
    if (!key) return
    setModels(null)
    setModelsError(null)
    let active = true
    listPlaygroundModels(key.key)
      .then((resp) => { if (active) setModels(resp.data) })
      .catch((e: Error) => { if (active) setModelsError(e.message) })
    return () => { active = false }
  }, [selectedKeyId, keys])

  const grouped = useMemo(() => {
    const groups = new Map<string, PlaygroundModel[]>()
    if (!models) return groups
    const needle = search.trim().toLowerCase()
    for (const m of models) {
      if (needle) {
        const hay = `${m.id} ${m.name ?? ""} ${m._mapped_to ?? ""}`.toLowerCase()
        if (!hay.includes(needle)) continue
      }
      const g = groups.get(m._upstream) ?? []
      g.push(m)
      groups.set(m._upstream, g)
    }
    for (const arr of groups.values()) arr.sort((a, b) => a.id.localeCompare(b.id))
    return groups
  }, [models, search])

  /**
   * Flat model list for the fullscreen picker inside ChatPanel. Built from
   * `models`, not from `grouped`: `grouped` is narrowed by the sidebar's search
   * box, and while fullscreen that box isn't on screen — a picker silently
   * missing most of its entries because of a filter the user can't see would be
   * worse than no picker.
   *
   * The label is the display name the sidebar uses, not the raw id, and the
   * upstream isn't shown at all: it's an opaque `up_copilot_<uuid>`, so as a
   * badge it was pure noise that also crowded the name out of the button. The
   * rest of this tab already treats a model id as globally unique (selection is
   * stored as a bare id and resolved with a flat `find`), so nothing needs
   * disambiguating here.
   */
  const mappedBadge = t("dash.playground.mappedModel")
  const modelOptions = useMemo<SelectOption[]>(() => {
    if (!models) return []
    return playgroundModelOptions(models, mappedBadge)
  }, [models, mappedBadge])

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

  function pickKey(id: string) {
    if (id === selectedKeyId) return
    setModels(null)
    setModelsError(null)
    setSelectedKeyId(id)
  }

  // The playground is a full-height workbench with no visible page header (the
  // breadcrumb already names it), so the page heading is for assistive tech only.
  const heading = <h1 className="sr-only">{t("dash.models")}</h1>

  if (keys && keys.length === 0) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] p-4">
        {heading}
        <div className="w-full max-w-sm">
          <EmptyState
            title={t("dash.playground.noKey")}
            description={
              <>
                {t("dash.playground.noKeyBody")}
                <span className="mt-4 block">
                  <Button variant="primary" onClick={() => { window.location.hash = "#keys" }}>
                    {t("dash.playground.createKey")}
                  </Button>
                </span>
              </>
            }
          />
        </div>
      </div>
    )
  }

  if (keyError) return <div className="p-4">{heading}<Notice tone="danger">{keyError}</Notice></div>
  if (!keys) return <div className="text-sm text-fg-subtle p-4">{heading}{t("dash.loadingShort")}</div>

  const selectedKey = keys.find((k) => k.id === selectedKeyId)
  const selectedModel = models?.find((m) => m.id === selectedModelId)
  // Each kind of model gets the test surface its endpoints need. Undefined
  // until the list has loaded; ChatPanel refuses to send until then.
  const mode = playgroundMode(selectedModel?.capabilities, selectedModel !== undefined, selectedModel?.supported_endpoints)

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
      {heading}
      {/* Top bar */}
      <div className="flex items-center gap-3 px-3 py-2 border-b border-border flex-wrap">
        {isMobile && (
          // A Radix dialog dropping from the top: focus is trapped inside, Esc
          // and a click on the backdrop close it, and focus returns to the trigger.
          <RadixDialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
            <RadixDialog.Trigger asChild>
              <Button variant="secondary" size="sm">
                {t("dash.playground.modelsDrawer")}
                <ChevronDown aria-hidden="true" />
              </Button>
            </RadixDialog.Trigger>
            <RadixDialog.Portal>
              <RadixDialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
              <RadixDialog.Content
                aria-describedby={undefined}
                className="fixed inset-x-0 top-0 z-50 flex max-h-[80vh] flex-col overflow-hidden border-b border-border bg-panel shadow-xl outline-none"
              >
                <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
                  <RadixDialog.Title className="text-sm font-medium text-fg">{t("dash.playground.modelsDrawer")}</RadixDialog.Title>
                  <RadixDialog.Close asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={t("dash.closeBtn")}>
                      <X aria-hidden="true" />
                    </Button>
                  </RadixDialog.Close>
                </div>
                {modelList}
              </RadixDialog.Content>
            </RadixDialog.Portal>
          </RadixDialog.Root>
        )}
        <label id={keyLabelId} htmlFor={keySelectId} className="text-xs text-fg-subtle">{t("dash.playground.sendWithKey")}:</label>
        <div className="min-w-[160px]">
          <Select
            id={keySelectId}
            value={selectedKeyId}
            onChange={pickKey}
            labelledBy={keyLabelId}
            size="sm"
            options={keys.map((k) => ({ value: k.id, label: k.name || k.id }))}
          />
        </div>
        {mode === "chat" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSystemOpen((v) => !v)}
            aria-expanded={systemOpen}
            className={cn("ml-2", systemOpen && "bg-muted text-fg")}
          >
            {t("dash.playground.system")}
            {systemOpen ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
          </Button>
        )}
        {mode === "chat" && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setWebSearchEnabled((v) => !v)}
            aria-pressed={webSearchEnabled}
            title={t("dash.playground.webSearchTitle")}
            className={cn(webSearchEnabled && "bg-muted text-fg")}
          >
            <Search aria-hidden="true" />
            {t("dash.playground.webSearch")}
          </Button>
        )}
        {isMobile && selectedModel && (
          <span className="flex items-center gap-1.5 min-w-0 max-w-[40%] text-xs text-fg-subtle">
            <span className="font-mono truncate">{selectedModel.name ?? selectedModel.id}</span>
            {selectedModel._mapped_to && <MappedModelBadge target={selectedModel._mapped_to} />}
          </span>
        )}
      </div>

      {mode === "chat" && systemOpen && (
        <div className="border-b border-border p-3">
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            placeholder={t("dash.playground.systemPlaceholder")}
            aria-label={t("dash.playground.system")}
            className="w-full min-h-[60px] rounded-md border border-input bg-background px-2 py-1 text-sm text-fg placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
          />
        </div>
      )}

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {!isMobile && (
          <div className="w-72 shrink-0 border-r border-border flex flex-col min-h-0 overflow-hidden">
            {modelList}
          </div>
        )}

        <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
          {selectedModelId && selectedKey ? (
            mode === "decision" ? (
              <DecisionPanel modelId={selectedModelId} apiKey={selectedKey.key} supportedEndpoints={selectedModel?.supported_endpoints} />
            ) : mode === "embedding" ? (
              <EmbeddingPanel modelId={selectedModelId} apiKey={selectedKey.key} />
            ) : (
              <ChatPanel modelId={selectedModelId} apiKey={selectedKey.key} systemPrompt={systemPrompt} webSearchEnabled={webSearchEnabled} vision={visionSupport(selectedModel?._mapped_to ?? selectedModelId, selectedModel?.capabilities?.supports)} contextWindow={selectedModel?.capabilities?.limits?.max_context_window_tokens} modelOptions={modelOptions} onPickModel={pickModel} mode={mode} imageParams={imageParams} onImageParamsChange={setImageParams} />
            )
          ) : (
            <div className="flex items-center justify-center h-full text-fg-subtle text-sm">
              {t("dash.playground.selectModel")}
            </div>
          )}
        </div>
      </div>
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

function MappedModelBadge({ target }: { target: string }) {
  const t = useT()
  return (
    <span className="shrink-0" title={t("dash.playground.mappedTo", { model: target })}>
      <Badge tone="brand">{t("dash.playground.mappedModel")}</Badge>
    </span>
  )
}

const KIND_LABELS: Partial<Record<PlaygroundMode, string>> = {
  image: "dash.playground.kindImage",
  embedding: "dash.playground.kindEmbedding",
  decision: "dash.playground.kindDecision",
}

/** Marks models that are not tested in a chat box, so picking one is no surprise. */
function ModelKindBadge({ model }: { model: PlaygroundModel }) {
  const t = useT()
  const mode = playgroundMode(model.capabilities, true, model.supported_endpoints)
  const key = mode ? KIND_LABELS[mode] : undefined
  return key ? <Badge className="shrink-0">{t(key)}</Badge> : null
}

export function ModelList({
  grouped, modelsError, models, search, onSearch, selectedModelId, onPick, openGroups, onToggleGroup,
}: ListProps) {
  const t = useT()
  return (
    <>
      <div className="p-2 border-b border-border">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={t("dash.playground.searchModels")}
          aria-label={t("dash.playground.searchModels")}
          className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs text-fg placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
        />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {modelsError && <Notice tone="danger" className="m-2 text-xs">{modelsError}</Notice>}
        {!modelsError && !models && <div className="text-xs text-fg-subtle p-3">{t("dash.loadingShort")}</div>}
        {Array.from(grouped.entries()).map(([upstream, arr]) => {
          const isOpen = openGroups[upstream] !== false
          return (
            <div key={upstream} className="border-b border-border">
              <button
                type="button"
                onClick={() => onToggleGroup(upstream)}
                aria-expanded={isOpen}
                className="w-full flex items-center justify-between px-3 py-1.5 text-xs text-fg-subtle hover:bg-muted hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-text"
              >
                <span>{upstream} ({arr.length})</span>
                {isOpen
                  ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                  : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
              </button>
              {isOpen && arr.map((m) => {
                const ctx = m.capabilities?.limits?.max_context_window_tokens
                const out = m.capabilities?.limits?.max_output_tokens
                const isSelected = m.id === selectedModelId
                return (
                <button
                  type="button"
                  key={m.id}
                  onClick={() => onPick(m.id)}
                  aria-pressed={isSelected}
                  // The class attribute is a test contract (exactly "pg-model-item is-selected"
                  // when selected): style these two classes in CSS, don't add utilities here.
                  className={"pg-model-item" + (isSelected ? " is-selected" : "")}
                >
                  <div className="pg-model-item-name flex items-center gap-1.5">
                    <span className="min-w-0 truncate" title={m.id}>{m.name ?? m.id}</span>
                    <ModelKindBadge model={m} />
                    {m._mapped_to && <MappedModelBadge target={m._mapped_to} />}
                  </div>
                  {m._mapped_to && (
                    <div
                      className="flex items-center gap-1 font-mono text-xs text-fg-subtle mt-0.5 min-w-0"
                      title={t("dash.playground.mappedTo", { model: m._mapped_to })}
                    >
                      <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
                      <span className="truncate">{m._mapped_to}</span>
                    </div>
                  )}
                  <div className="pg-model-item-meta">
                    <div className="font-mono truncate">{m.id}</div>
                    {(ctx || out) && (
                      <div className="font-mono text-xs mt-0.5">
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
