import { useState } from "react"
import { useAuth } from "../../state/auth"
import { useToast } from "../../state/toast"
import { useT } from "../../state/i18n"

export function SettingsTab() {
  const { session } = useAuth()
  const { push: toast } = useToast()
  const t = useT()
  const [exporting, setExporting] = useState(false)

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

  return (
    <div className="glass-card p-4 sm:p-6 mb-6 animate-in">
      <h3 className="text-themed font-semibold mb-1">{t("dash.exportDataTitle")}</h3>
      <p className="text-sm text-themed-secondary mb-4">
        {t("dash.exportDataDesc")}
        {!isAdmin && " " + t("dash.adminOnlyParen")}
      </p>
      <button
        onClick={onExport}
        className="btn-primary"
        disabled={exporting || !isAdmin}
      >
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
  )
}
