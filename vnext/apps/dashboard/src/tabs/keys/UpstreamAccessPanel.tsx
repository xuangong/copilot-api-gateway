import { useEffect, useId, useRef, useState } from "react"
import { getKeyUpstreams, type ApiKeyDetail } from "../../api/keys"
import type { KeyUpstreamChoice } from "../../api/types"
import { useT } from "../../state/i18n"
import {
  buildUpstreamAccessRows,
  initialUpstreamAccessDraft,
  isUpstreamAccessDirty,
  moveSelectedUpstream,
  setUpstreamAccessMode,
  setUpstreamSelected,
  upstreamAccessPatch,
} from "./upstream-access-state"

interface Props {
  keyRow: Pick<ApiKeyDetail, "id" | "upstream_ids" | "upstreamIds" | "upstream_ids_invalid">
  canEdit: boolean
  busy: boolean
  onSave: (body: { upstream_ids: string[] | null }) => Promise<boolean>
}

export function UpstreamAccessPanel({ keyRow, canEdit, busy, onSave }: Props) {
  const t = useT()
  const panelId = useId()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState(() => initialUpstreamAccessDraft(keyRow))
  const [choices, setChoices] = useState<KeyUpstreamChoice[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const savedIdentity = `${keyRow.id}:${JSON.stringify(upstreamAccessPatch(initialUpstreamAccessDraft(keyRow)))}:${keyRow.upstream_ids_invalid}`
  const previousIdentity = useRef(savedIdentity)

  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (previousIdentity.current === savedIdentity) return
    previousIdentity.current = savedIdentity
    setDraft(initialUpstreamAccessDraft(keyRow))
    setEditing(false)
    setSaveError(null)
  }, [keyRow, savedIdentity])

  const loadChoices = async () => {
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setLoading(true)
    setLoadError(null)
    try {
      const upstreams = await getKeyUpstreams(keyRow.id, controller.signal)
      if (controller.signal.aborted) return
      setChoices(upstreams)
      setLoaded(true)
      setDraft((current) => current.mode === "custom" ? setUpstreamAccessMode(current, "custom", upstreams) : current)
    } catch (error) {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }
  const startEdit = (mode = initialUpstreamAccessDraft(keyRow).mode) => {
    setDraft(setUpstreamAccessMode(initialUpstreamAccessDraft(keyRow), mode))
    setSaveError(null)
    setEditing(true)
    void loadChoices()
  }
  const toggleEnabled = (enabled: boolean) => {
    const mode = enabled ? "custom" : "inherit"
    if (editing) {
      setDraft((current) => setUpstreamAccessMode(current, mode, loaded && !loading && loadError === null ? choices : undefined))
      setSaveError(null)
    } else startEdit(mode)
  }
  const cancel = () => {
    request.current?.abort()
    setLoading(false)
    setDraft(initialUpstreamAccessDraft(keyRow))
    setEditing(false)
    setSaveError(null)
  }
  const restoreDefault = () => {
    setDraft((current) => setUpstreamAccessMode(current, "inherit", choices))
    setSaveError(null)
  }
  const current = editing ? draft : initialUpstreamAccessDraft(keyRow)
  const rows = buildUpstreamAccessRows(choices, current.ids)
  const missing = loaded && rows.some((row) => row.selected && row.unavailable)
  const dirty = isUpstreamAccessDirty(draft, keyRow)
  const interactionDisabled = busy || saving
  const customBlocked = draft.mode === "custom" && (!draft.customInitialized || !loaded || loading || loadError !== null || missing)
  const save = async () => {
    if (!canEdit || interactionDisabled || !dirty || customBlocked) return
    setSaving(true)
    setSaveError(null)
    try {
      if (await onSave(upstreamAccessPatch(draft))) setEditing(false)
      else setSaveError(t("dash.upstreamAccessSaveFailed"))
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="glass-card p-4 sm:p-6 mb-6 animate-in delay-1" aria-labelledby={`${panelId}-title`}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="min-w-0 flex items-center gap-3">
          <h3 id={`${panelId}-title`} className="text-xs font-medium text-themed-dim uppercase tracking-widest">
            {t("dash.upstreamAccessLabel")}
          </h3>
          <label className="flex items-center gap-1.5 text-[10px] text-themed-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={current.mode === "custom"}
              disabled={!canEdit || interactionDisabled}
              onChange={(event) => toggleEnabled(event.target.checked)}
              aria-label={t("dash.upstreamAccessToggleAria")}
              className="accent-accent-violet disabled:cursor-not-allowed"
            />
            <span className={current.mode === "custom" ? "text-accent-teal" : "text-themed-dim"}>
              {t(current.mode === "custom" ? "dash.wsEnabledShort" : "dash.wsDisabledShort")}
            </span>
          </label>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!editing && canEdit ? (
            <button type="button" onClick={() => startEdit()} disabled={interactionDisabled} className="btn-ghost text-xs">
              {t("dash.edit")}
            </button>
          ) : null}
          {editing ? (
            <>
              <button type="button" onClick={save} disabled={interactionDisabled || !dirty || customBlocked} className="btn-primary text-xs py-1 px-3">
                {saving ? t("dash.savingShort") : t("dash.save")}
              </button>
              <button type="button" onClick={cancel} disabled={interactionDisabled} className="btn-ghost text-xs">
                {t("dash.cancel")}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <p className="text-xs text-themed-secondary mb-3">{t("dash.upstreamAccessSharedHint")}</p>
      {keyRow.upstream_ids_invalid ? (
        <p role="alert" className="rounded-md bg-accent-amber/10 text-accent-amber text-xs p-3 mb-3">
          {t("dash.upstreamAccessInvalid")}
        </p>
      ) : null}

      {editing ? (
        <div className="space-y-3">
          <button type="button" onClick={restoreDefault} disabled={interactionDisabled || draft.mode === "inherit"} className="btn-ghost text-xs">
            {t("dash.upstreamAccessRestore")}
          </button>
          <p className="text-[10px] text-themed-dim">{t("dash.upstreamAccessOrderHint")}</p>
          {loading ? <p role="status" className="text-xs text-themed-dim">{t("dash.loadingShort")}</p> : null}
          {loadError ? (
            <div role="alert" className="rounded-md bg-accent-amber/10 text-accent-amber text-xs p-3 flex flex-wrap items-center gap-2">
              <span>{t("dash.upstreamAccessLoadFailed", { error: loadError })}</span>
              <button type="button" onClick={() => void loadChoices()} disabled={interactionDisabled || loading} className="btn-ghost text-xs">{t("dash.upstreamAccessRetry")}</button>
            </div>
          ) : null}
          {draft.mode === "custom" ? (
            <>
              <ul className="space-y-2" aria-label={t("dash.upstreamAccessChoices")}>
                {rows.map((row) => {
                  const selectedIndex = draft.ids.indexOf(row.id)
                  return (
                    <li key={row.id} className="rounded-lg bg-surface-700/50 p-3 flex items-center justify-between gap-3">
                      <label className="min-w-0 flex items-center gap-3 cursor-pointer">
                        <input type="checkbox" checked={row.selected} disabled={interactionDisabled || loading || !loaded || (!row.selected && row.unavailable)} onChange={(event) => setDraft((value) => setUpstreamSelected(value, row.id, event.target.checked))} className="accent-accent-violet shrink-0" />
                        <span className="min-w-0">
                          <span className="text-xs text-themed break-all">{row.selected ? `${selectedIndex + 1}. ` : ""}{row.name}</span>
                          <span className="block text-[10px] text-themed-dim break-all">{row.id}{row.provider ? ` · ${row.provider}` : ""}</span>
                          <span className={`block text-[10px] ${row.selected ? "text-accent-teal" : "text-themed-dim"}`}>
                            {t(row.selected ? "dash.upstreamAccessKeyEnabled" : "dash.upstreamAccessKeyDisabled")}
                          </span>
                          {loaded && !loading && (row.unavailable || !row.enabled) ? (
                            <span className="block text-[10px] text-accent-amber">
                              {t(row.unavailable ? "dash.upstreamAccessUnavailable" : "dash.upstreamAccessDisabled")}
                            </span>
                          ) : null}
                        </span>
                      </label>
                      {row.selected ? (
                        <div className="flex gap-1 shrink-0">
                          <button type="button" onClick={() => setDraft((value) => moveSelectedUpstream(value, selectedIndex, -1))} disabled={interactionDisabled || selectedIndex === 0} aria-label={t("dash.upstreamAccessMoveUp", { name: row.name })} className="btn-ghost text-xs px-2">↑</button>
                          <button type="button" onClick={() => setDraft((value) => moveSelectedUpstream(value, selectedIndex, 1))} disabled={interactionDisabled || selectedIndex === draft.ids.length - 1} aria-label={t("dash.upstreamAccessMoveDown", { name: row.name })} className="btn-ghost text-xs px-2">↓</button>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              {loaded && rows.length === 0 ? <p className="text-xs text-themed-dim">{t("dash.upstreamAccessNoChoices")}</p> : null}
              {missing ? <p role="alert" className="text-xs text-accent-amber">{t("dash.upstreamAccessRemoveUnavailable")}</p> : null}
            </>
          ) : null}
          {saveError ? <p role="alert" className="text-xs text-accent-red">{saveError}</p> : null}
        </div>
      ) : current.mode === "custom" && current.ids.length > 0 ? (
        <p className="text-xs text-themed-secondary break-all">
          {t("dash.upstreamAccessSelected", { n: current.ids.length })} · {current.ids.join(" → ")}
        </p>
      ) : null}

      {current.mode === "inherit" ? (
        <p className="text-xs text-themed-dim mt-3">{t("dash.upstreamAccessInheritHint")}</p>
      ) : current.customInitialized && current.ids.length === 0 ? (
        <p role="status" className="rounded-md bg-accent-amber/10 text-accent-amber text-xs p-3 mt-3">{t("dash.upstreamAccessEmpty")}</p>
      ) : null}
    </section>
  )
}
