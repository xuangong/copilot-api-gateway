import { useRef, useState } from "react"
import { useAuth } from "../../state/auth"
import { useToast } from "../../state/toast"
import { useT } from "../../state/i18n"

interface ImportPreview {
  mode: "merge" | "replace"
  parsed: {
    version: number
    apiKeys: number
    githubAccounts: number
    upstreams: number
    redactedCount: number
  }
  payload: unknown
}

interface ImportResponse {
  ok: boolean
  sourceVersion: 1 | 2
  imported: { apiKeys: number; githubAccounts: number; upstreams: number }
  redactedCount: number
}

export function SettingsTab() {
  const { session } = useAuth()
  const { push: toast } = useToast()
  const t = useT()
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const isAdmin = session?.isAdmin ?? false

  async function onExport() {
    setExporting(true)
    try {
      const resp = await fetch("/api/export", { credentials: "same-origin" })
      if (resp.status === 401) {
        window.location.href = "/"
        return
      }
      if (!resp.ok) {
        let err = `HTTP ${resp.status}`
        try {
          const j = (await resp.json()) as { error?: string }
          if (j?.error) err = j.error
        } catch {
          // ignore
        }
        toast(t("dash.exportFailedToast", { error: err }), "error")
        return
      }
      const data = await resp.json()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `copilot-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      URL.revokeObjectURL(url)
      toast(t("dash.exportDownloadedToast"), "success")
    } catch (e) {
      toast(t("dash.exportFailedToast", { error: e instanceof Error ? e.message : String(e) }), "error")
    } finally {
      setExporting(false)
    }
  }

  async function onFilePicked(file: File) {
    try {
      const text = await file.text()
      const payload = JSON.parse(text) as Record<string, unknown>
      const version = Number(payload.version ?? 0)
      const apiKeys = Array.isArray(payload.apiKeys) ? payload.apiKeys.length : 0
      const githubAccounts = Array.isArray(payload.githubAccounts) ? payload.githubAccounts.length : 0
      const upstreams = Array.isArray(payload.upstreams) ? payload.upstreams.length : 0
      // Best-effort secret counter for the preview (server is authoritative).
      const redactedCount = countRedacted(payload)
      setPreview({
        mode: "merge",
        parsed: { version, apiKeys, githubAccounts, upstreams, redactedCount },
        payload,
      })
    } catch (e) {
      toast(t("dash.importParseFailed", { error: e instanceof Error ? e.message : String(e) }), "error")
    }
  }

  async function onConfirmImport() {
    if (!preview) return
    setImporting(true)
    try {
      const resp = await fetch("/api/import", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: preview.mode, bundle: preview.payload }),
      })
      if (!resp.ok) {
        let err = `HTTP ${resp.status}`
        try {
          const j = (await resp.json()) as { error?: string }
          if (j?.error) err = j.error
        } catch {
          // ignore
        }
        toast(t("dash.importFailedToast", { error: err }), "error")
        return
      }
      const result = (await resp.json()) as ImportResponse
      toast(
        t("dash.importDoneToast", {
          apiKeys: String(result.imported.apiKeys),
          githubAccounts: String(result.imported.githubAccounts),
          upstreams: String(result.imported.upstreams),
        }),
        "success",
      )
      setPreview(null)
    } catch (e) {
      toast(t("dash.importFailedToast", { error: e instanceof Error ? e.message : String(e) }), "error")
    } finally {
      setImporting(false)
    }
  }

  return (
    <>
      <div className="glass-card p-4 sm:p-6 mb-6 animate-in">
        <h3 className="text-themed font-semibold mb-1">{t("dash.exportDataTitle")}</h3>
        <p className="text-sm text-themed-secondary mb-4">
          {t("dash.exportDataDesc")}
          {!isAdmin && " " + t("dash.adminOnlyParen")}
        </p>
        <button onClick={onExport} className="btn-primary" disabled={exporting || !isAdmin}>
          {exporting ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity="0.25" />
                <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" opacity="0.75" />
              </svg>
              {t("dash.exportingLabel")}
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              {t("dash.exportJsonBtn")}
            </span>
          )}
        </button>
      </div>

      <div className="glass-card p-4 sm:p-6 mb-6 animate-in">
        <h3 className="text-themed font-semibold mb-1">{t("dash.importDataTitle")}</h3>
        <p className="text-sm text-themed-secondary mb-4">
          {t("dash.importDataDesc")}
          {!isAdmin && " " + t("dash.adminOnlyParen")}
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void onFilePicked(f)
            e.target.value = ""
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="btn-secondary"
          disabled={importing || !isAdmin}
        >
          {t("dash.importChooseFile")}
        </button>

        {preview ? (
          <div className="mt-4 rounded border border-themed p-3 text-sm space-y-3">
            <div className="text-themed">
              {t("dash.importPreviewSummary", {
                version: String(preview.parsed.version),
                apiKeys: String(preview.parsed.apiKeys),
                githubAccounts: String(preview.parsed.githubAccounts),
                upstreams: String(preview.parsed.upstreams),
                redacted: String(preview.parsed.redactedCount),
              })}
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  checked={preview.mode === "merge"}
                  onChange={() => setPreview({ ...preview, mode: "merge" })}
                />
                <span>{t("dash.importModeMerge")}</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  checked={preview.mode === "replace"}
                  onChange={() => setPreview({ ...preview, mode: "replace" })}
                />
                <span className="text-red-500">{t("dash.importModeReplace")}</span>
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={onConfirmImport}
                className="btn-primary"
                disabled={importing}
              >
                {importing ? t("dash.importingLabel") : t("dash.importConfirm")}
              </button>
              <button onClick={() => setPreview(null)} className="btn-secondary" disabled={importing}>
                {t("dash.importCancel")}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </>
  )
}

function countRedacted(value: unknown): number {
  if (value === "__REDACTED__") return 1
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countRedacted(v), 0)
  if (value && typeof value === "object") {
    let n = 0
    for (const v of Object.values(value as Record<string, unknown>)) n += countRedacted(v)
    return n
  }
  return 0
}
