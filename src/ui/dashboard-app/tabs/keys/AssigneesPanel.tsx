import { useState } from "react"
import type { ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"

interface Props {
  keyRow: ApiKeyDetail
  onAssign: (email: string) => Promise<boolean>
  onUnassign: (userId: string) => Promise<boolean>
}

export function AssigneesPanel({ keyRow, onAssign, onUnassign }: Props) {
  const [email, setEmail] = useState("")
  const [sharing, setSharing] = useState(false)
  const t = useT()

  const submit = async () => {
    const trimmed = email.trim()
    if (!trimmed || !trimmed.includes("@")) return
    setSharing(true)
    try {
      const ok = await onAssign(trimmed)
      if (ok) setEmail("")
    } finally {
      setSharing(false)
    }
  }

  return (
    <div className="glass-card p-4 sm:p-6 mb-6 animate-in delay-1">
      <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t("dash.sharedWith")}</span>
      <div className="flex flex-wrap gap-2 mt-3">
        {(keyRow.assignees ?? []).map((a) => (
          <span
            key={a.user_id}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-accent-violet/10 text-accent-violet border border-accent-violet/20"
          >
            <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
            <span>{a.user_name || t("dash.unknown")}</span>
            <button
              type="button"
              onClick={() => onUnassign(a.user_id)}
              className="ml-1 -mr-0.5 hover:text-accent-red transition-colors"
              title={t("dash.unshareTip")}
            >
              <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </span>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={t("dash.shareEmailPlaceholderLong")}
          disabled={sharing}
          className="w-full mt-1 text-sm flex-1"
        />
        <button
          type="button"
          onClick={submit}
          disabled={sharing || !email}
          className="btn-primary text-xs py-1.5 px-3"
        >
          {t("dash.share")}
        </button>
      </div>
    </div>
  )
}

export function SharedByOwnerPanel({ keyRow }: { keyRow: ApiKeyDetail }) {
  const t = useT()
  return (
    <div className="glass-card p-4 sm:p-6 mb-6 animate-in delay-1">
      <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t("dash.sharedByLabel")}</span>
      <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-accent-violet/10 text-accent-violet border border-accent-violet/20">
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
          <circle cx="12" cy="7" r="4" />
        </svg>
        <span>{keyRow.owner_name ?? t("dash.unknown")}</span>
      </div>
    </div>
  )
}
