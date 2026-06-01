import { useMemo, useState } from "react"
import type { ApiKeyDetail, KeyPatchBody, KeyRefDescriptor, WebSearchRange, WebSearchUsage } from "../../api/keys"
import { useT, t as tStatic } from "../../state/i18n"
import { DEFAULT_WS_PRIORITY } from "./helpers"
import { Select } from "../../components/Select"

type Engine = "langsearch" | "tavily" | "msGrounding"

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
}

interface EditState {
  enabled: boolean
  langsearch: string
  tavily: string
  msGrounding: string
  langsearchRef: string
  tavilyRef: string
  msGroundingRef: string
  langsearchReplacing: boolean
  tavilyReplacing: boolean
  msGroundingReplacing: boolean
  priority: string[]
  copySourceId: string
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
    langsearchRef: key.web_search_langsearch_ref?.id ?? "",
    tavilyRef: key.web_search_tavily_ref?.id ?? "",
    msGroundingRef: key.web_search_ms_grounding_ref?.id ?? "",
    langsearchReplacing: false,
    tavilyReplacing: false,
    msGroundingReplacing: false,
    priority,
    copySourceId: "",
  }
}

function borrowName(id: string, keys: ApiKeyDetail[]): string {
  if (!id) return ""
  const k = keys.find((x) => x.id === id)
  return k?.name ?? id
}

function refLabel(ref: KeyRefDescriptor | null, fallbackId: string, keys: ApiKeyDetail[]): string {
  if (ref?.broken) return tStatic("dash.wsLinkUnavailable")
  if (ref) return `↗ ${ref.name ?? ref.id}`
  return `↗ ${borrowName(fallbackId, keys)}`
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
}: Props) {
  const [editing, setEditing] = useState(false)
  const [edit, setEdit] = useState<EditState>(() => initialEdit(keyRow))
  const [borrowPickerEngine, setBorrowPickerEngine] = useState<Engine | "">("")
  const t = useT()

  const startEdit = () => {
    setEdit(initialEdit(keyRow))
    setEditing(true)
  }

  const candidatesFor = (engine: Engine): ApiKeyDetail[] => {
    const field = engine === "langsearch"
      ? "web_search_langsearch_key"
      : engine === "tavily"
        ? "web_search_tavily_key"
        : "web_search_ms_grounding_key"
    return allKeys.filter((k) => k.id !== keyRow.id && k[field])
  }

  const currentBorrowCandidates = useMemo(
    () => (borrowPickerEngine ? candidatesFor(borrowPickerEngine) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      bing: { id: "bing", label: "Bing", ref: null, key: null, builtin: true },
      copilot: { id: "copilot", label: "Copilot", ref: null, key: null, builtin: true },
    }
    const priority = keyRow.web_search_priority ?? [...DEFAULT_WS_PRIORITY]
    return priority.map((id) => all[id]).filter(Boolean) as Array<typeof all[string]>
  })()

  return (
    <div className="glass-card p-4 sm:p-6 mb-6 animate-in delay-1">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t("dash.webSearchLabel")}</span>
        <div className="flex items-center gap-2">
          {!editing && canEdit ? (
            <button type="button" onClick={startEdit} className="btn-ghost text-xs">
              {t("dash.edit")}
            </button>
          ) : null}
          {editing ? (
            <>
              <button type="button" onClick={save} disabled={busy} className="btn-primary text-xs py-1 px-3">
                {busy ? t("dash.savingShort") : t("dash.save")}
              </button>
              <button type="button" onClick={() => setEditing(false)} className="btn-ghost text-xs">
                {t("dash.cancel")}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="space-y-4 mb-4">
          <div className="flex items-center gap-6 flex-wrap">
            <label className="flex items-center gap-2 text-xs text-themed-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={edit.enabled}
                onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })}
                className="accent-accent-violet"
              />
              {t("dash.webSearchEnableLabel")}
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <EngineEditorRow
              label={t("dash.wsLangSearchKey")}
              engine="langsearch"
              refId={edit.langsearchRef}
              refDescriptor={keyRow.web_search_langsearch_ref}
              existingMasked={keyRow.web_search_langsearch_key}
              replacing={edit.langsearchReplacing}
              value={edit.langsearch}
              allKeys={allKeys}
              onUnlinkRef={() => setEdit({ ...edit, langsearchRef: "" })}
              onStartReplace={() => setEdit({ ...edit, langsearchReplacing: true, langsearch: "" })}
              onChangeValue={(v) => setEdit({ ...edit, langsearch: v })}
              onBorrowOpen={() => setBorrowPickerEngine("langsearch")}
            />
            <EngineEditorRow
              label={t("dash.wsTavilyKey")}
              engine="tavily"
              refId={edit.tavilyRef}
              refDescriptor={keyRow.web_search_tavily_ref}
              existingMasked={keyRow.web_search_tavily_key}
              replacing={edit.tavilyReplacing}
              value={edit.tavily}
              allKeys={allKeys}
              onUnlinkRef={() => setEdit({ ...edit, tavilyRef: "" })}
              onStartReplace={() => setEdit({ ...edit, tavilyReplacing: true, tavily: "" })}
              onChangeValue={(v) => setEdit({ ...edit, tavily: v })}
              onBorrowOpen={() => setBorrowPickerEngine("tavily")}
            />
            <div className="sm:col-span-2">
              <EngineEditorRow
                label={t("dash.wsMsGroundingKey")}
                engine="msGrounding"
                refId={edit.msGroundingRef}
                refDescriptor={keyRow.web_search_ms_grounding_ref}
                existingMasked={keyRow.web_search_ms_grounding_key}
                replacing={edit.msGroundingReplacing}
                value={edit.msGrounding}
                allKeys={allKeys}
                onUnlinkRef={() => setEdit({ ...edit, msGroundingRef: "" })}
                onStartReplace={() => setEdit({ ...edit, msGroundingReplacing: true, msGrounding: "" })}
                onChangeValue={(v) => setEdit({ ...edit, msGrounding: v })}
                onBorrowOpen={() => setBorrowPickerEngine("msGrounding")}
              />
            </div>
          </div>

          {isAdmin ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs text-themed-dim">{t("dash.wsEnginePriority")}</label>
                <button type="button" onClick={resetPriority} className="btn-ghost text-[10px]">
                  {t("dash.wsResetLabel")}
                </button>
              </div>
              <p className="text-[10px] text-themed-dim">{t("dash.wsPriorityWinner")}</p>
              <div className="space-y-1">
                {edit.priority.map((eng, idx) => (
                  <div
                    key={eng}
                    className="flex items-center gap-2 px-2 py-1 rounded bg-surface-700/50"
                  >
                    <span className="text-[10px] text-themed-dim w-4">{idx + 1}.</span>
                    <span className="text-xs font-mono text-themed flex-1">{eng}</span>
                    <button
                      type="button"
                      onClick={() => movePriority(idx, -1)}
                      disabled={idx === 0}
                      className="btn-ghost text-xs px-1.5 py-0.5 disabled:opacity-30"
                      title={t("dash.wsUpTitle")}
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() => movePriority(idx, 1)}
                      disabled={idx === edit.priority.length - 1}
                      className="btn-ghost text-xs px-1.5 py-0.5 disabled:opacity-30"
                      title={t("dash.wsDownTitle")}
                    >
                      ▼
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <Select
              value={edit.copySourceId}
              onChange={(v) => setEdit({ ...edit, copySourceId: v })}
              className="flex-1 mt-1"
              options={[
                { value: "", label: t("dash.wsCopyFromKeyPlaceholder") },
                ...allKeys
                  .filter((k) => k.id !== keyRow.id && k.web_search_enabled)
                  .map((k) => ({ value: k.id, label: t("dash.wsEnabledOption", { name: k.name }) })),
              ]}
            />
            <button
              type="button"
              onClick={copyFrom}
              disabled={!edit.copySourceId || busy}
              className="btn-ghost text-xs"
            >
              {t("dash.copy")}
            </button>
          </div>
        </div>
      ) : null}

      {borrowPickerEngine ? (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setBorrowPickerEngine("")
          }}
        >
          <div className="glass-card rounded-xl p-4 sm:p-6 w-full max-w-sm space-y-4">
            <h3 className="text-sm font-semibold text-themed">{t("dash.wsBorrowFromTitle")}</h3>
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {currentBorrowCandidates.length === 0 ? (
                <p className="text-xs text-themed-dim">{t("dash.wsNoAvailableKeys")}</p>
              ) : (
                currentBorrowCandidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => confirmBorrow(c.id)}
                    className="w-full text-left px-3 py-2 rounded-lg hover:bg-white/5 transition-colors"
                  >
                    <span className="text-xs font-medium text-themed block">{c.name || c.id}</span>
                    <span className="text-[10px] text-themed-dim">{c.owner_name ?? c.owner_id ?? ""}</span>
                  </button>
                ))
              )}
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={() => setBorrowPickerEngine("")} className="btn-ghost text-xs">
                {t("dash.cancel")}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {!editing ? (
        <div className="space-y-3">
          <div className="flex items-center gap-4">
            <span className="text-xs text-themed-secondary">{t("dash.wsStatusLabel")}</span>
            <span
              className={`text-xs font-medium ${keyRow.web_search_enabled ? "text-accent-teal" : "text-themed-dim"}`}
            >
              {keyRow.web_search_enabled ? t("dash.wsEnabledShort") : t("dash.wsDisabledShort")}
            </span>
          </div>
          {keyRow.web_search_enabled ? (
            <div className="space-y-2">
              <div className="flex items-start gap-3">
                <span className="text-xs text-themed-secondary shrink-0 mt-0.5">{t("dash.wsEnginesLabel")}</span>
                <div className="flex flex-wrap gap-1.5">
                  {engineSlots.map((slot) => (
                    <span
                      key={slot.id}
                      className={`text-[10px] px-2 py-0.5 rounded inline-flex items-center gap-1 ${
                        slot.ref
                          ? slot.ref.broken
                            ? "bg-accent-red/15 text-accent-red"
                            : "bg-accent-violet/15 text-accent-violet"
                          : slot.key
                            ? "bg-accent-teal/15 text-accent-teal"
                            : slot.builtin
                              ? "bg-surface-700 text-themed-secondary"
                              : "bg-surface-700 text-themed-dim"
                      }`}
                    >
                      <span className="font-medium">{slot.label}</span>
                      {slot.ref ? (
                        <span className="font-mono opacity-80">{refLabel(slot.ref, slot.ref.id, allKeys)}</span>
                      ) : null}
                      {!slot.ref && slot.key ? (
                        <span className="font-mono opacity-80">{slot.key}</span>
                      ) : null}
                      {!slot.ref && !slot.key && slot.builtin ? (
                        <span className="opacity-70">{t("dash.wsBuiltinTag")}</span>
                      ) : null}
                      {!slot.ref && !slot.key && !slot.builtin ? <span className="opacity-60">—</span> : null}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <div className="inline-flex items-center gap-0.5 bg-surface-800 rounded-md p-0.5">
                  {(["1d", "7d", "30d"] as const).map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => onUsageRangeChange(r)}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all ${
                        usageRange === r
                          ? "bg-surface-600 text-themed"
                          : "text-themed-dim hover:text-themed-secondary"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
                <span className="text-xs font-mono text-themed">{usage.searches} searches</span>
                <span className="text-[10px] text-accent-teal">{usage.successes} ok</span>
                {usage.failures > 0 ? (
                  <span className="text-[10px] text-accent-red">{usage.failures} failed</span>
                ) : null}
              </div>

              {usage.engines.length > 0 ? (
                <div className="space-y-1.5 mt-1">
                  {usage.engines.map((eng) => (
                    <div key={eng.engineId} className="flex items-center gap-1.5 flex-wrap text-[10px]">
                      <span className="font-mono text-themed-secondary w-20 shrink-0">{eng.engineId}</span>
                      <span className="px-1.5 py-0.5 rounded bg-accent-teal/15 text-accent-teal">
                        {eng.successes} ok
                      </span>
                      {eng.emptyResults > 0 ? (
                        <span className="px-1.5 py-0.5 rounded bg-accent-amber/15 text-accent-amber">
                          {eng.emptyResults} empty · {Math.round((eng.emptyResults * 100) / Math.max(eng.successes, 1))}%
                        </span>
                      ) : null}
                      {eng.failures > 0 ? (
                        <span className="px-1.5 py-0.5 rounded bg-accent-red/15 text-accent-red">
                          {eng.failures} fail
                        </span>
                      ) : null}
                      {eng.successes > 0 ? (
                        <span className="px-1.5 py-0.5 rounded bg-surface-700 text-themed-dim">
                          ok ~{eng.avgSuccessMs}ms
                        </span>
                      ) : null}
                      {eng.failures > 0 ? (
                        <span className="px-1.5 py-0.5 rounded bg-surface-700 text-themed-dim">
                          fail ~{eng.avgFailureMs}ms
                        </span>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

interface RowProps {
  label: string
  engine: Engine
  refId: string
  refDescriptor: KeyRefDescriptor | null
  existingMasked: string | null
  replacing: boolean
  value: string
  allKeys: ApiKeyDetail[]
  onUnlinkRef: () => void
  onStartReplace: () => void
  onChangeValue: (v: string) => void
  onBorrowOpen: () => void
}

function EngineEditorRow({
  label,
  refId,
  refDescriptor,
  existingMasked,
  replacing,
  value,
  allKeys,
  onUnlinkRef,
  onStartReplace,
  onChangeValue,
  onBorrowOpen,
}: RowProps) {
  const t = useT()
  return (
    <div>
      <label className="text-xs text-themed-dim block mb-1">{label}</label>
      {refId ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-themed-secondary truncate">
            {refLabel(refDescriptor, refId, allKeys)}
          </span>
          <button type="button" onClick={onUnlinkRef} className="btn-ghost text-xs shrink-0">
            {t("dash.unlinkBtn")}
          </button>
        </div>
      ) : existingMasked && !replacing ? (
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-themed-secondary truncate">{existingMasked}</span>
          <button type="button" onClick={onStartReplace} className="btn-ghost text-xs shrink-0">
            {t("dash.replaceBtn")}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={value}
            onChange={(e) => onChangeValue(e.target.value)}
            placeholder={replacing ? t("dash.wsBlankToClearPlaceholder") : t("dash.wsNotSetPlaceholder")}
            className="w-full mt-1 text-sm flex-1 font-mono"
          />
          <button type="button" onClick={onBorrowOpen} className="btn-ghost text-xs shrink-0">
            {t("dash.wsBorrowFromLabel")}
          </button>
        </div>
      )}
    </div>
  )
}
