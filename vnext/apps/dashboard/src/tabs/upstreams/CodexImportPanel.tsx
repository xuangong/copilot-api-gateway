import { useEffect, useReducer, useRef, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import * as api from "../../api/upstreams"
import { Button } from "../../ui/button"
import { cn } from "../../ui/cn"
import { Notice } from "../../ui/notice"
import { CodexImportDraft } from "./codex-import-draft"
import { FormHeading } from "./form/Field"

interface Props {
  targetId: string | null
  name: string
  ownerId?: string
  flagOverrides: Record<string, boolean>
  disabledPublicModelIds: string[]
  onImported: () => void
}

export function CodexImportPanel({ targetId, name, ownerId, flagOverrides, disabledPublicModelIds, onImported }: Props) {
  const t = useT()
  const { push: toast } = useToast()
  const draft = useRef(new CodexImportDraft(targetId))
  const [, render] = useReducer((value: number) => value + 1, 0)
  const pending = useRef<AbortController | null>(null)
  const [candidates, setCandidates] = useState<api.CodexPreviewCandidate[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState<"preview" | "import" | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const current = draft.current
    current.setTarget(targetId)
    pending.current?.abort()
    pending.current = null
    setCandidates(null)
    setSelected(null)
    setBusy(null)
    setError(null)
    render()
    return () => {
      pending.current?.abort()
      pending.current = null
      current.clear()
    }
  }, [targetId])

  const replaceDocument = (document: string) => {
    pending.current?.abort()
    pending.current = null
    draft.current.setDocument(document)
    setCandidates(null)
    setSelected(null)
    setBusy(null)
    setError(null)
    render()
  }

  const selectFile = async (file: File | undefined) => {
    if (!file) return
    pending.current?.abort()
    pending.current = null
    const ticket = draft.current.begin()
    setCandidates(null)
    setSelected(null)
    setBusy(null)
    setError(null)
    try {
      const document = await file.text()
      if (draft.current.accepts(ticket)) replaceDocument(document)
    } catch {
      if (draft.current.accepts(ticket)) setError(t("dash.codexFileError"))
    }
  }

  const preview = async () => {
    const ticket = draft.current.begin()
    if (!ticket.document.trim()) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setBusy("preview")
    setError(null)
    try {
      const result = await api.previewCodexDocument(ticket.document, controller.signal)
      if (!draft.current.accepts(ticket)) return
      setCandidates(result.candidates)
      setSelected(current => result.candidates.some(row => row.sourceIndex === current && row.importable)
        ? current : result.candidates.find(row => row.importable)?.sourceIndex ?? null)
    } catch (cause) {
      if (draft.current.accepts(ticket) && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("dash.codexPreviewFailed"))
    } finally {
      if (draft.current.accepts(ticket)) setBusy(null)
      if (pending.current === controller) pending.current = null
    }
  }

  const importSelected = async () => {
    const ticket = draft.current.begin()
    const source = candidates?.find(row => row.sourceIndex === selected && row.importable)
    if (!source || !ticket.document) return
    if (!targetId && !name.trim()) { toast(t("dash.errNameRequired"), "error"); return }
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setBusy("import")
    setError(null)
    const body: api.CodexImportRequest = targetId
      ? { document: ticket.document, sourceIndex: source.sourceIndex, upstreamId: targetId }
      : { document: ticket.document, sourceIndex: source.sourceIndex, name: name.trim(), ownerId,
          flagOverrides, disabledPublicModelIds }
    try {
      await api.importCodexDocument(body, controller.signal)
      if (!draft.current.accepts(ticket)) return
      draft.current.clear()
      render()
      setCandidates(null)
      setSelected(null)
      toast(t(targetId ? "dash.codexReimported" : "dash.codexImported"), "success")
      onImported()
    } catch (cause) {
      if (draft.current.accepts(ticket) && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : t("dash.codexImportFailed"))
    } finally {
      if (draft.current.accepts(ticket)) setBusy(null)
      if (pending.current === controller) pending.current = null
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div>
        <FormHeading offset={1} className="text-body font-medium text-fg">{t(targetId ? "dash.codexReimportTitle" : "dash.codexImportTitle")}</FormHeading>
        <p className="mt-1 text-xs text-fg-subtle">{t(targetId ? "dash.codexReimportHint" : "dash.codexImportHint")}</p>
      </div>
      <label className="block text-xs font-medium text-fg-muted">
        {t("dash.codexDocumentLabel")}
        <textarea
          value={draft.current.document}
          onChange={event => replaceDocument(event.target.value)}
          rows={6}
          className="mt-1 w-full font-mono text-xs font-normal"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="block text-xs font-medium text-fg-muted">
        {t("dash.codexFileLabel")}
        <input type="file" accept=".json,application/json" className="mt-1 block text-body font-normal text-fg-muted"
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ""
            void selectFile(file)
          }} />
      </label>
      <Button variant="secondary" size="sm" onClick={() => { void preview() }} disabled={!draft.current.document.trim() || busy !== null}>
        {busy === "preview" ? t("dash.loadingShort") : t("dash.codexPreview")}
      </Button>
      {error ? <Notice tone="danger" className="text-xs">{error}</Notice> : null}
      {candidates ? (
        <div className="space-y-2" role="group" aria-label={t("dash.codexPreviewRows")}>
          {candidates.length === 0 ? <p className="text-xs text-fg-subtle">{t("dash.codexNoCandidates")}</p> : null}
          {candidates.map(row => (
            <label key={row.sourceIndex} className={cn("block rounded-md border border-border p-3 text-xs", row.importable ? "text-fg" : "text-fg-subtle")}>
              <span className="flex items-center gap-2">
                <input type="radio" name="codex-import-source" className="accent-brand" checked={selected === row.sourceIndex} disabled={!row.importable || busy !== null}
                  onChange={() => setSelected(row.sourceIndex)} />
                <span className="font-medium">{row.name || row.email || row.chatgptAccountId || t("dash.codexUnnamedRow")}</span>
                <span className="text-fg-subtle">#{row.sourceIndex + 1}</span>
              </span>
              {row.importable ? (
                <span className="mt-1 ml-6 block text-fg-muted">
                  {row.chatgptAccountId} · {t(row.renewable ? "dash.codexRenewable" : "dash.codexAccessOnly")} · {row.expiresAt === null
                    ? t("dash.codexExpiryUnknown")
                    : t("dash.codexExpiresAt", { at: new Date(row.expiresAt).toLocaleString() })}
                </span>
              ) : (
                <span className="mt-1 ml-6 block text-xs text-danger">
                  {t("dash.codexCannotImport")}: {row.issues.join("; ")}
                </span>
              )}
            </label>
          ))}
        </div>
      ) : null}
      {candidates ? (
        <Button variant="primary" size="sm" disabled={selected === null || busy !== null}
          onClick={() => { void importSelected() }}>
          {busy === "import" ? t("dash.loadingShort") : t(targetId ? "dash.codexReimport" : "dash.codexImport")}
        </Button>
      ) : null}
    </div>
  )
}
