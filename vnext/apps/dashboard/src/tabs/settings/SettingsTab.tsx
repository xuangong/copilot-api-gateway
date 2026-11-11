import { useRef, useState } from "react"
import { useAuth } from "../../state/auth"
import { useToast } from "../../state/toast"
import { useT } from "../../state/i18n"
import { Download, Loader2 } from "lucide-react"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { PageHeader } from "../../ui/page-header"
import { SegmentedControl } from "../../ui/segmented-control"

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
    <div>
      <PageHeader title={t("dash.settings")} />

      <Card className="mb-4">
        <SectionHeading className="mb-1">{t("dash.exportDataTitle")}</SectionHeading>
        <p className="mb-4 text-[13px] text-fg-muted">
          {t("dash.exportDataDesc")}
          {!isAdmin && " " + t("dash.adminOnlyParen")}
        </p>
        <Button variant="primary" size="sm" onClick={onExport} disabled={exporting || !isAdmin}>
          {exporting ? (
            <>
              <Loader2 className="animate-spin" aria-hidden="true" />
              {t("dash.exportingLabel")}
            </>
          ) : (
            <>
              <Download aria-hidden="true" />
              {t("dash.exportJsonBtn")}
            </>
          )}
        </Button>
      </Card>

      <Card className="mb-4">
        <SectionHeading className="mb-1">{t("dash.importDataTitle")}</SectionHeading>
        <p className="mb-4 text-[13px] text-fg-muted">
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
        <Button
          variant="secondary"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={importing || !isAdmin}
        >
          {t("dash.importChooseFile")}
        </Button>

        {preview ? (
          <div className="mt-4 space-y-3 rounded-md border border-border bg-panel p-3 text-[13px]">
            <div className="text-fg">
              {t("dash.importPreviewSummary", {
                version: String(preview.parsed.version),
                apiKeys: String(preview.parsed.apiKeys),
                githubAccounts: String(preview.parsed.githubAccounts),
                upstreams: String(preview.parsed.upstreams),
                redacted: String(preview.parsed.redactedCount),
              })}
            </div>
            <SegmentedControl
              ariaLabel={t("dash.importModeAria")}
              value={preview.mode}
              onChange={(mode) => setPreview({ ...preview, mode })}
              options={[
                { value: "merge", label: t("dash.importModeMerge") },
                { value: "replace", label: <span className="text-danger">{t("dash.importModeReplace")}</span> },
              ]}
            />
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" onClick={onConfirmImport} disabled={importing}>
                {importing ? t("dash.importingLabel") : t("dash.importConfirm")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setPreview(null)} disabled={importing}>
                {t("dash.importCancel")}
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
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
