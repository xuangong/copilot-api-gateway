import { useId, useMemo, useState } from "react"
import { ChevronDown, ChevronUp, Link2 } from "lucide-react"
import type { ApiKeyDetail, KeyPatchBody, KeyRefDescriptor, WebSearchRange, WebSearchUsage } from "../../api/keys"
import { useT } from "../../state/i18n"
import { DEFAULT_WS_PRIORITY } from "./helpers"
import type { ModelCatalog } from "../../state/models"
import { testKeyWebSearch, type WebSearchTestResult } from "../../api/keys"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { SegmentedControl } from "../../ui/segmented-control"
import { Select } from "../../ui/select"
import { WebSearchBorrowDialog } from "./WebSearchBorrowDialog"
import { WebSearchEngineRow } from "./WebSearchEngineRow"
import { borrowCandidates, linkedKeyName, type WebSearchEngine as Engine } from "./web-search-borrow"

const USAGE_RANGES = [
  { value: "1d", label: "1d" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
] as const satisfies ReadonlyArray<{ value: WebSearchRange; label: string }>

interface Props {
  keyRow: ApiKeyDetail
  allKeys: ApiKeyDetail[]
  isAdmin: boolean
  canEdit: boolean
  busy: boolean
  usage: WebSearchUsage
  usageRange: WebSearchRange
  onUsageRangeChange: (r: WebSearchRange) => void
  onSave: (body: KeyPatchBody) => Promise<boolean>
  onCopyFrom: (sourceId: string) => Promise<boolean>
  catalog: ModelCatalog
}

interface EditState {
  enabled: boolean
  langsearch: string
  tavily: string
  msGrounding: string
  jina: string
  langsearchRef: string
  tavilyRef: string
  msGroundingRef: string
  jinaRef: string
  langsearchReplacing: boolean
  tavilyReplacing: boolean
  msGroundingReplacing: boolean
  jinaReplacing: boolean
  priority: string[]
  copySourceId: string
  passthroughUpstream: string
  passthroughModel: string
}

function initialEdit(key: ApiKeyDetail): EditState {
  const stored = Array.isArray(key.web_search_priority)
    ? key.web_search_priority.filter((e) => (DEFAULT_WS_PRIORITY as readonly string[]).includes(e))
    : []
  const missing = DEFAULT_WS_PRIORITY.filter((e) => !stored.includes(e))
  const priority = stored.length ? [...stored, ...missing] : [...DEFAULT_WS_PRIORITY]
  return {
    enabled: key.web_search_enabled ?? false,
    langsearch: "",
    tavily: "",
    msGrounding: "",
    jina: "",
    langsearchRef: key.web_search_langsearch_ref?.id ?? "",
    tavilyRef: key.web_search_tavily_ref?.id ?? "",
    msGroundingRef: key.web_search_ms_grounding_ref?.id ?? "",
    jinaRef: key.web_search_jina_ref?.id ?? "",
    langsearchReplacing: false,
    tavilyReplacing: false,
    msGroundingReplacing: false,
    jinaReplacing: false,
    priority,
    copySourceId: "",
    passthroughUpstream: key.web_search_passthrough_upstream ?? "",
    passthroughModel: key.web_search_passthrough_model ?? "",
  }
}

export function WebSearchPanel({
  keyRow,
  allKeys,
  isAdmin,
  canEdit,
  busy,
  usage,
  usageRange,
  onUsageRangeChange,
  onSave,
  onCopyFrom,
  catalog,
}: Props) {
  const [editing, setEditing] = useState(false)
  const [edit, setEdit] = useState<EditState>(() => initialEdit(keyRow))
  const [borrowPickerEngine, setBorrowPickerEngine] = useState<Engine | "">("")
  const t = useT()
  const panelId = useId()

  const startEdit = () => {
    setEdit(initialEdit(keyRow))
    setEditing(true)
  }

  // Only codex and custom upstreams can serve alpha_search — the same check
  // the gateway's dispatcher makes. Filtering here stops the pair being
  // configured into a state the gateway would only reject at request time.
  // Passthrough addresses an upstream directly and does not apply key mappings.
  const passthroughUpstreams = useMemo(
    () => (catalog?.rawByUpstream ?? []).filter((g) => g.provider === "codex" || g.provider === "custom"),
    [catalog],
  )
  const passthroughModels = useMemo(
    () => passthroughUpstreams.find((g) => g.upstream === edit.passthroughUpstream)?.models ?? [],
    [passthroughUpstreams, edit.passthroughUpstream],
  )

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<WebSearchTestResult | null>(null)
  const runTest = async () => {
    setTesting(true)
    setTestResult(await testKeyWebSearch(keyRow.id))
    setTesting(false)
  }

  const currentBorrowCandidates = useMemo(
    () => (borrowPickerEngine ? borrowCandidates(borrowPickerEngine, allKeys, keyRow.id) : []),
    [borrowPickerEngine, allKeys, keyRow.id],
  )

  const movePriority = (idx: number, delta: number) => {
    const j = idx + delta
    if (j < 0 || j >= edit.priority.length) return
    const arr = [...edit.priority]
    ;[arr[idx], arr[j]] = [arr[j]!, arr[idx]!]
    setEdit({ ...edit, priority: arr })
  }

  const resetPriority = () => setEdit({ ...edit, priority: [...DEFAULT_WS_PRIORITY] })

  const confirmBorrow = (id: string) => {
    if (borrowPickerEngine === "langsearch") setEdit({ ...edit, langsearchRef: id })
    else if (borrowPickerEngine === "tavily") setEdit({ ...edit, tavilyRef: id })
    else if (borrowPickerEngine === "msGrounding") setEdit({ ...edit, msGroundingRef: id })
    else if (borrowPickerEngine === "jina") setEdit({ ...edit, jinaRef: id })
    setBorrowPickerEngine("")
  }

  const save = async () => {
    const body: KeyPatchBody = { web_search_enabled: edit.enabled }
    if (isAdmin) {
      const isDefault =
        edit.priority.length === DEFAULT_WS_PRIORITY.length &&
        edit.priority.every((e, i) => e === DEFAULT_WS_PRIORITY[i])
      body.web_search_priority = isDefault ? null : edit.priority
    }

    // For each engine: ref wins, else literal, else if "replacing" submit
    // null to clear literal, else if we *had* a ref but are no longer
    // referencing one, submit null to drop the ref.
    if (edit.langsearchRef) {
      body.web_search_langsearch_ref = edit.langsearchRef
    } else if (edit.langsearch.trim()) {
      body.web_search_langsearch_key = edit.langsearch.trim()
    } else if (edit.langsearchReplacing) {
      body.web_search_langsearch_key = null
    } else if (keyRow.web_search_langsearch_ref) {
      body.web_search_langsearch_ref = null
    }

    if (edit.tavilyRef) {
      body.web_search_tavily_ref = edit.tavilyRef
    } else if (edit.tavily.trim()) {
      body.web_search_tavily_key = edit.tavily.trim()
    } else if (edit.tavilyReplacing) {
      body.web_search_tavily_key = null
    } else if (keyRow.web_search_tavily_ref) {
      body.web_search_tavily_ref = null
    }

    if (edit.msGroundingRef) {
      body.web_search_ms_grounding_ref = edit.msGroundingRef
    } else if (edit.msGrounding.trim()) {
      body.web_search_ms_grounding_key = edit.msGrounding.trim()
    } else if (edit.msGroundingReplacing) {
      body.web_search_ms_grounding_key = null
    } else if (keyRow.web_search_ms_grounding_ref) {
      body.web_search_ms_grounding_ref = null
    }

    // Both halves or neither: a lone upstream cannot name a model to relay to,
    // and `null` is how the API clears a field.
    const wantsPassthrough = edit.passthroughUpstream !== "" && edit.passthroughModel !== ""
    body.web_search_passthrough_upstream = wantsPassthrough ? edit.passthroughUpstream : null
    body.web_search_passthrough_model = wantsPassthrough ? edit.passthroughModel : null

    if (edit.jinaRef) {
      body.web_search_jina_ref = edit.jinaRef
    } else if (edit.jina.trim()) {
      body.web_search_jina_key = edit.jina.trim()
    } else if (edit.jinaReplacing) {
      body.web_search_jina_key = null
    } else if (keyRow.web_search_jina_ref) {
      body.web_search_jina_ref = null
    }

    const ok = await onSave(body)
    if (ok) setEditing(false)
  }

  const copyFrom = async () => {
    if (!edit.copySourceId) return
    const ok = await onCopyFrom(edit.copySourceId)
    if (ok) setEditing(false)
  }

  // Engine display chips.
  const engineSlots = (() => {
    const all: Record<string, { id: string; label: string; ref: KeyRefDescriptor | null; key: string | null; builtin: boolean }> = {
      langsearch: { id: "langsearch", label: "LangSearch", ref: keyRow.web_search_langsearch_ref, key: keyRow.web_search_langsearch_key, builtin: false },
      tavily: { id: "tavily", label: "Tavily", ref: keyRow.web_search_tavily_ref, key: keyRow.web_search_tavily_key, builtin: false },
      msGrounding: { id: "msGrounding", label: "MS Grounding", ref: keyRow.web_search_ms_grounding_ref, key: keyRow.web_search_ms_grounding_key, builtin: false },
      jina: { id: "jina", label: "Jina", ref: keyRow.web_search_jina_ref, key: keyRow.web_search_jina_key, builtin: false },
      bing: { id: "bing", label: "Bing", ref: null, key: null, builtin: true },
      copilot: { id: "copilot", label: "Copilot", ref: null, key: null, builtin: true },
    }
    const priority = keyRow.web_search_priority ?? [...DEFAULT_WS_PRIORITY]
    return priority.map((id) => all[id]).filter(Boolean) as Array<typeof all[string]>
  })()


  const engineRow = (
    engine: Engine,
    label: string,
    refKey: "langsearchRef" | "tavilyRef" | "msGroundingRef" | "jinaRef",
    valueKey: "langsearch" | "tavily" | "msGrounding" | "jina",
    replacingKey: "langsearchReplacing" | "tavilyReplacing" | "msGroundingReplacing" | "jinaReplacing",
    refDescriptor: KeyRefDescriptor | null,
    existingMasked: string | null,
  ) => (
    <WebSearchEngineRow
      label={label}
      refId={edit[refKey]}
      refDescriptor={refDescriptor}
      existingMasked={existingMasked}
      replacing={edit[replacingKey]}
      value={edit[valueKey]}
      allKeys={allKeys}
      onUnlinkRef={() => setEdit({ ...edit, [refKey]: "" })}
      onStartReplace={() => setEdit({ ...edit, [replacingKey]: true, [valueKey]: "" })}
      onChangeValue={(v) => setEdit({ ...edit, [valueKey]: v })}
      onBorrowOpen={() => setBorrowPickerEngine(engine)}
    />
  )

  return (
    <Card aria-labelledby={`${panelId}-title`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SectionHeading id={`${panelId}-title`}>{t("dash.webSearchLabel")}</SectionHeading>
        <div className="flex items-center gap-2">
          {!editing && canEdit ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => void runTest()} disabled={testing}>
                {testing ? t("dash.wsTesting") : t("dash.wsTest")}
              </Button>
              <Button variant="ghost" size="sm" onClick={startEdit}>
                {t("dash.edit")}
              </Button>
            </>
          ) : null}
          {editing ? (
            <>
              <Button variant="primary" size="sm" onClick={save} disabled={busy}>
                {busy ? t("dash.savingShort") : t("dash.save")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                {t("dash.cancel")}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="mb-4 space-y-4">
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={edit.enabled}
              onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
              className="accent-brand"
            />
            {t("dash.webSearchEnableLabel")}
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {engineRow("langsearch", t("dash.wsLangSearchKey"), "langsearchRef", "langsearch", "langsearchReplacing", keyRow.web_search_langsearch_ref, keyRow.web_search_langsearch_key)}
            {engineRow("tavily", t("dash.wsTavilyKey"), "tavilyRef", "tavily", "tavilyReplacing", keyRow.web_search_tavily_ref, keyRow.web_search_tavily_key)}
            {engineRow("jina", t("dash.wsJinaKey"), "jinaRef", "jina", "jinaReplacing", keyRow.web_search_jina_ref, keyRow.web_search_jina_key)}
            <div className="sm:col-span-2">
              {engineRow("msGrounding", t("dash.wsMsGroundingKey"), "msGroundingRef", "msGrounding", "msGroundingReplacing", keyRow.web_search_ms_grounding_ref, keyRow.web_search_ms_grounding_key)}
            </div>
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <span id={`${panelId}-passthrough`} className="block text-xs font-medium text-fg-muted">{t("dash.wsPassthrough")}</span>
            <p className="text-xs text-fg-subtle">{t("dash.wsPassthroughHint")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-[200px]">
                <Select
                  labelledBy={`${panelId}-passthrough`}
                  value={edit.passthroughUpstream}
                  onChange={(v) => setEdit({ ...edit, passthroughUpstream: v, passthroughModel: "" })}
                  options={[
                    { value: "", label: t("dash.wsPassthroughOff") },
                    ...passthroughUpstreams.map((g) => ({ value: g.upstream, label: g.upstream })),
                  ]}
                />
              </div>
              <div className="min-w-[180px]">
                <Select
                  labelledBy={`${panelId}-passthrough`}
                  value={edit.passthroughModel}
                  onChange={(v) => setEdit({ ...edit, passthroughModel: v })}
                  options={[
                    { value: "", label: t("dash.wsPassthroughPickModel") },
                    ...passthroughModels.map((m) => ({ value: m.id, label: m.id })),
                  ]}
                />
              </div>
            </div>
            {passthroughUpstreams.length === 0 ? (
              <Notice tone="warn">{t("dash.wsPassthroughNoUpstream")}</Notice>
            ) : null}
          </div>

          {isAdmin ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span id={`${panelId}-priority`} className="text-xs font-medium text-fg-muted">{t("dash.wsEnginePriority")}</span>
                <Button variant="ghost" size="sm" onClick={resetPriority}>
                  {t("dash.wsResetLabel")}
                </Button>
              </div>
              <p className="text-xs text-fg-subtle">{t("dash.wsPriorityWinner")}</p>
              <ol aria-labelledby={`${panelId}-priority`}>
                {edit.priority.map((eng, idx) => (
                  <li key={eng} className="flex items-center gap-2 border-b border-border px-2 py-1">
                    <span className="w-4 text-xs tabular-nums text-fg-subtle">{idx + 1}.</span>
                    <span className="flex-1 font-mono text-xs text-fg">{eng}</span>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => movePriority(idx, -1)}
                      disabled={idx === 0}
                      title={t("dash.wsUpTitle")}
                      aria-label={`${t("dash.wsUpTitle")} ${eng}`}
                    >
                      <ChevronUp aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => movePriority(idx, 1)}
                      disabled={idx === edit.priority.length - 1}
                      title={t("dash.wsDownTitle")}
                      aria-label={`${t("dash.wsDownTitle")} ${eng}`}
                    >
                      <ChevronDown aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <Select
                ariaLabel={t("dash.wsCopyFromKeyPlaceholder")}
                value={edit.copySourceId}
                onChange={(v) => setEdit({ ...edit, copySourceId: v })}
                options={[
                  { value: "", label: t("dash.wsCopyFromKeyPlaceholder") },
                  ...allKeys
                    .filter((k) => k.id !== keyRow.id && k.web_search_enabled)
                    .map((k) => ({ value: k.id, label: t("dash.wsEnabledOption", { name: k.name }) })),
                ]}
              />
            </div>
            <Button variant="secondary" size="sm" onClick={copyFrom} disabled={!edit.copySourceId || busy}>
              {t("dash.copy")}
            </Button>
          </div>
        </div>
      ) : null}

      <WebSearchBorrowDialog
        open={borrowPickerEngine !== ""}
        candidates={currentBorrowCandidates}
        onPick={confirmBorrow}
        onClose={() => setBorrowPickerEngine("")}
      />

      {!editing ? (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <span className="text-xs text-fg-muted">{t("dash.wsStatusLabel")}</span>
            <Badge tone={keyRow.web_search_enabled ? "success" : "neutral"}>
              {keyRow.web_search_enabled ? t("dash.wsEnabledShort") : t("dash.wsDisabledShort")}
            </Badge>
          </div>
          {testResult ? (
            // The one job of a test button is to say whether search works. Lead
            // with the verdict and label the evidence — a bare engine name and
            // a page title read as neither.
            <Notice tone={testResult.ok ? "success" : "danger"} className="space-y-1">
              <div className="font-medium">
                {testResult.ok
                  ? t("dash.wsTestOk", {
                      engine: testResult.provider,
                      n: testResult.results?.length ?? 0,
                    })
                  : t("dash.wsTestFailed", { reason: testResult.error?.message ?? testResult.error?.code ?? "" })}
              </div>
              {testResult.ok && testResult.results?.[0] ? (
                <div className="text-xs text-fg-muted">
                  {t("dash.wsTestSample", { query: testResult.query })}
                  <span className="block truncate">{testResult.results[0].title}</span>
                </div>
              ) : null}
            </Notice>
          ) : null}
          {keyRow.web_search_passthrough_upstream && keyRow.web_search_passthrough_model ? (
            <div className="flex items-start gap-3">
              <span className="mt-0.5 shrink-0 text-xs text-fg-muted">{t("dash.wsPassthrough")}</span>
              <span className="font-mono text-xs text-fg-muted">
                {keyRow.web_search_passthrough_upstream} · {keyRow.web_search_passthrough_model}
              </span>
            </div>
          ) : null}
          {keyRow.web_search_enabled ? (
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0 text-xs text-fg-muted">{t("dash.wsEnginesLabel")}</span>
                <div className="flex flex-wrap gap-1.5">
                  {engineSlots.map((slot) => (
                    <Badge
                      key={slot.id}
                      tone={slot.ref ? (slot.ref.broken ? "danger" : "brand") : slot.key ? "success" : "neutral"}
                      className={!slot.ref && !slot.key && !slot.builtin ? "gap-1 opacity-60" : "gap-1"}
                    >
                      <span className="font-medium">{slot.label}</span>
                      {slot.ref ? (
                        slot.ref.broken ? (
                          <span className="font-mono opacity-80">{t("dash.wsLinkUnavailable")}</span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5 font-mono opacity-80">
                            <Link2 className="size-3" aria-hidden="true" />
                            {linkedKeyName(slot.ref, slot.ref.id, allKeys)}
                          </span>
                        )
                      ) : null}
                      {!slot.ref && slot.key ? <span className="font-mono opacity-80">{slot.key}</span> : null}
                      {!slot.ref && !slot.key && slot.builtin ? <span className="opacity-70">{t("dash.wsBuiltinTag")}</span> : null}
                      {!slot.ref && !slot.key && !slot.builtin ? <span>—</span> : null}
                    </Badge>
                  ))}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <SegmentedControl
                  size="sm"
                  options={USAGE_RANGES}
                  value={usageRange}
                  onChange={onUsageRangeChange}
                  ariaLabel={t("dash.wsUsageRangeAria")}
                />
                <span className="text-xs tabular-nums text-fg">{usage.searches} searches</span>
                <span className="text-xs tabular-nums text-success">{usage.successes} ok</span>
                {usage.failures > 0 ? (
                  <span className="text-xs tabular-nums text-danger">{usage.failures} failed</span>
                ) : null}
              </div>

              {usage.engines.length > 0 ? (
                <div className="mt-1">
                  {usage.engines.map((eng) => (
                    <div key={eng.engineId} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border py-1.5 text-xs tabular-nums">
                      <span className="w-20 shrink-0 font-mono text-fg-muted">{eng.engineId}</span>
                      <span className="text-success">{eng.successes} ok</span>
                      {eng.emptyResults > 0 ? (
                        <span className="text-warn-text">
                          {eng.emptyResults} empty · {Math.round((eng.emptyResults * 100) / Math.max(eng.successes, 1))}%
                        </span>
                      ) : null}
                      {eng.failures > 0 ? <span className="text-danger">{eng.failures} fail</span> : null}
                      {eng.successes > 0 ? <span className="text-fg-subtle">ok ~{eng.avgSuccessMs}ms</span> : null}
                      {eng.failures > 0 ? <span className="text-fg-subtle">fail ~{eng.avgFailureMs}ms</span> : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  )
}
