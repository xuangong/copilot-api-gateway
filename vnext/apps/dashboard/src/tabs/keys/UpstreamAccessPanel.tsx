import { useEffect, useId, useRef, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { getKeyUpstreams, type ApiKeyDetail } from "../../api/keys"
import type { KeyUpstreamChoice } from "../../api/types"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { cn } from "../../ui/cn"
import { Notice } from "../../ui/notice"
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
    <Card aria-labelledby={`${panelId}-title`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <SectionHeading id={`${panelId}-title`}>{t("dash.upstreamAccessLabel")}</SectionHeading>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={current.mode === "custom"}
              disabled={!canEdit || interactionDisabled}
              onChange={(event) => toggleEnabled(event.target.checked)}
              aria-label={t("dash.upstreamAccessToggleAria")}
              className="accent-brand disabled:cursor-not-allowed"
            />
            <span className={current.mode === "custom" ? "text-success" : "text-fg-subtle"}>
              {t(current.mode === "custom" ? "dash.wsEnabledShort" : "dash.wsDisabledShort")}
            </span>
          </label>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!editing && canEdit ? (
            <Button variant="ghost" size="sm" onClick={() => startEdit()} disabled={interactionDisabled}>{t("dash.edit")}</Button>
          ) : null}
          {editing ? (
            <>
              <Button variant="primary" size="sm" onClick={save} disabled={interactionDisabled || !dirty || customBlocked}>
                {saving ? t("dash.savingShort") : t("dash.save")}
              </Button>
              <Button variant="ghost" size="sm" onClick={cancel} disabled={interactionDisabled}>{t("dash.cancel")}</Button>
            </>
          ) : null}
        </div>
      </div>

      <p className="mb-3 text-xs text-fg-muted">{t("dash.upstreamAccessSharedHint")}</p>
      {keyRow.upstream_ids_invalid ? (
        <Notice tone="warn" role="alert" className="mb-3">{t("dash.upstreamAccessInvalid")}</Notice>
      ) : null}

      {editing ? (
        <div className="space-y-3">
          <Button variant="ghost" size="sm" onClick={restoreDefault} disabled={interactionDisabled || draft.mode === "inherit"}>
            {t("dash.upstreamAccessRestore")}
          </Button>
          <p className="text-xs text-fg-subtle">{t("dash.upstreamAccessOrderHint")}</p>
          {loading ? <p role="status" className="text-xs text-fg-subtle">{t("dash.loadingShort")}</p> : null}
          {loadError ? (
            <Notice tone="danger" className="flex flex-wrap items-center gap-2">
              <span>{t("dash.upstreamAccessLoadFailed", { error: loadError })}</span>
              <Button variant="ghost" size="sm" onClick={() => void loadChoices()} disabled={interactionDisabled || loading}>{t("dash.upstreamAccessRetry")}</Button>
            </Notice>
          ) : null}
          {draft.mode === "custom" ? (
            <>
              <ul className="space-y-2" aria-label={t("dash.upstreamAccessChoices")}>
                {rows.map((row) => {
                  const selectedIndex = draft.ids.indexOf(row.id)
                  return (
                    <li key={row.id} className={cn("flex items-center justify-between gap-3 rounded-lg border border-border p-3", row.selected && "bg-muted")}>
                      <label className="flex min-w-0 cursor-pointer items-center gap-3">
                        <input type="checkbox" checked={row.selected} disabled={interactionDisabled || loading || !loaded || (!row.selected && row.unavailable)} onChange={(event) => setDraft((value) => setUpstreamSelected(value, row.id, event.target.checked))} className="shrink-0 accent-brand" />
                        <span className="min-w-0 space-y-0.5">
                          <span className="block break-all text-[13px] text-fg">{row.selected ? `${selectedIndex + 1}. ` : ""}{row.name}</span>
                          <span className="block break-all font-mono text-xs text-fg-subtle">{row.id}{row.provider ? ` · ${row.provider}` : ""}</span>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Badge tone={row.selected ? "success" : "neutral"}>
                              {t(row.selected ? "dash.upstreamAccessKeyEnabled" : "dash.upstreamAccessKeyDisabled")}
                            </Badge>
                            {loaded && !loading && (row.unavailable || !row.enabled) ? (
                              <span className="text-xs text-warn-text">
                                {t(row.unavailable ? "dash.upstreamAccessUnavailable" : "dash.upstreamAccessDisabled")}
                              </span>
                            ) : null}
                          </span>
                        </span>
                      </label>
                      {row.selected ? (
                        <div className="flex shrink-0 gap-1">
                          <Button variant="ghost" size="icon-sm" onClick={() => setDraft((value) => moveSelectedUpstream(value, selectedIndex, -1))} disabled={interactionDisabled || selectedIndex === 0} aria-label={t("dash.upstreamAccessMoveUp", { name: row.name })}><ChevronUp aria-hidden="true" /></Button>
                          <Button variant="ghost" size="icon-sm" onClick={() => setDraft((value) => moveSelectedUpstream(value, selectedIndex, 1))} disabled={interactionDisabled || selectedIndex === draft.ids.length - 1} aria-label={t("dash.upstreamAccessMoveDown", { name: row.name })}><ChevronDown aria-hidden="true" /></Button>
                        </div>
                      ) : null}
                    </li>
                  )
                })}
              </ul>
              {loaded && rows.length === 0 ? <p className="text-xs text-fg-subtle">{t("dash.upstreamAccessNoChoices")}</p> : null}
              {missing ? <Notice tone="warn" role="alert">{t("dash.upstreamAccessRemoveUnavailable")}</Notice> : null}
            </>
          ) : null}
          {saveError ? <Notice tone="danger">{saveError}</Notice> : null}
        </div>
      ) : current.mode === "custom" && current.ids.length > 0 ? (
        <p className="break-all text-xs text-fg-muted">
          {t("dash.upstreamAccessSelected", { n: current.ids.length })} · {current.ids.join(" → ")}
        </p>
      ) : null}

      {current.mode === "inherit" ? (
        <p className="mt-3 text-xs text-fg-subtle">{t("dash.upstreamAccessInheritHint")}</p>
      ) : current.customInitialized && current.ids.length === 0 ? (
        <Notice tone="warn" role="status" className="mt-3">{t("dash.upstreamAccessEmpty")}</Notice>
      ) : null}
    </Card>
  )
}
