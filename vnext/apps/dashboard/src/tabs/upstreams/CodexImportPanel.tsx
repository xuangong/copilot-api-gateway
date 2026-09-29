import { useEffect, useReducer, useRef, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import * as api from "../../api/upstreams"
import type { ProxyFallbackEntry } from "../../api/types"
import { CodexImportDraft } from "./codex-import-draft"

interface Props {
  targetId: string | null
  name: string
  ownerId?: string
  flagOverrides: Record<string, boolean>
  disabledPublicModelIds: string[]
  proxyFallbackList?: ProxyFallbackEntry[]
  onImported: () => void
}

export function CodexImportPanel({ targetId, name, ownerId, flagOverrides, disabledPublicModelIds, proxyFallbackList, onImported }: Props) {
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
          flagOverrides, disabledPublicModelIds, proxyFallbackList }
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
    <div className="border-t border-themed pt-3 space-y-3">
      <div>
        <h4 className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t(targetId ? "dash.codexReimportTitle" : "dash.codexImportTitle")}</h4>
        <p className="text-xs text-themed-dim mt-1">{t(targetId ? "dash.codexReimportHint" : "dash.codexImportHint")}</p>
      </div>
      <label className="block text-xs text-themed-dim">
        {t("dash.codexDocumentLabel")}
        <textarea
          value={draft.current.document}
          onChange={event => replaceDocument(event.target.value)}
          rows={6}
          className="w-full mt-1 text-xs font-mono"
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <label className="block text-xs text-themed-dim">
        {t("dash.codexFileLabel")}
        <input type="file" accept=".json,application/json" className="block mt-1 text-xs"
          onChange={event => {
            const file = event.target.files?.[0]
            event.target.value = ""
            void selectFile(file)
          }} />
      </label>
      <button type="button" onClick={() => { void preview() }} disabled={!draft.current.document.trim() || busy !== null} className="btn-ghost text-xs">
        {busy === "preview" ? t("dash.loadingShort") : t("dash.codexPreview")}
      </button>
      {error ? <p role="alert" className="text-xs text-accent-red">{error}</p> : null}
      {candidates ? (
        <div className="space-y-2" role="group" aria-label={t("dash.codexPreviewRows")}>
          {candidates.length === 0 ? <p className="text-xs text-themed-dim">{t("dash.codexNoCandidates")}</p> : null}
          {candidates.map(row => (
            <label key={row.sourceIndex} className={`block rounded border p-3 text-xs ${row.importable ? "border-surface-600 text-themed" : "border-[color:var(--danger-edge)] text-themed-dim"}`}>
              <span className="flex items-center gap-2">
                <input type="radio" name="codex-import-source" checked={selected === row.sourceIndex} disabled={!row.importable || busy !== null}
                  onChange={() => setSelected(row.sourceIndex)} />
                <span className="font-medium">{row.name || row.email || row.chatgptAccountId || t("dash.codexUnnamedRow")}</span>
                <span className="text-themed-dim">#{row.sourceIndex + 1}</span>
              </span>
              {row.importable ? (
                <span className="block mt-1 ml-6 text-themed-dim">
                  {row.chatgptAccountId} · {t(row.renewable ? "dash.codexRenewable" : "dash.codexAccessOnly")} · {row.expiresAt === null
                    ? t("dash.codexExpiryUnknown")
                    : t("dash.codexExpiresAt", { at: new Date(row.expiresAt).toLocaleString() })}
                </span>
              ) : (
                <span className="block mt-1 ml-6 text-accent-red">
                  {t("dash.codexCannotImport")}: {row.issues.join("; ")}
                </span>
              )}
            </label>
          ))}
        </div>
      ) : null}
      {candidates ? (
        <button type="button" className="btn-primary text-sm" disabled={selected === null || busy !== null}
          onClick={() => { void importSelected() }}>
          {busy === "import" ? t("dash.loadingShort") : t(targetId ? "dash.codexReimport" : "dash.codexImport")}
        </button>
      ) : null}
    </div>
  )
}
