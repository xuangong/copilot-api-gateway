import { useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import { timeAgo, type InviteCode } from "../../api/users"

interface Props {
  invites: InviteCode[]
  loading: boolean
  creating: boolean
  onCreate: (name: string) => Promise<boolean>
  onDelete: (id: string) => Promise<void>
}

export function InviteCodesPanel({ invites, loading, creating, onCreate, onDelete }: Props) {
  const { push: toast } = useToast()
  const t = useT()
  const [name, setName] = useState("")
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const submit = async () => {
    const ok = await onCreate(name)
    if (ok) setName("")
  }

  const copy = async (code: string, id: string) => {
    try {
      await navigator.clipboard.writeText(code)
      setCopiedId(id)
      setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1500)
    } catch {
      toast(t("dash.copyFailedShort"), "error")
    }
  }

  return (
    <div className="glass-card p-4 sm:p-6 mb-8 animate-in">
      <h3 className="text-themed font-medium mb-4">{t("dash.inviteCodesTitle")}</h3>
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit()
          }}
          placeholder={t("dash.inviteeNamePlaceholder")}
          className="flex-1 px-3 py-2 rounded bg-surface-800/60 border border-white/[0.06] text-themed text-sm"
        />
        <button
          onClick={submit}
          disabled={creating || !name.trim()}
          className="btn-primary text-sm"
        >
          {creating ? t("dash.creatingInviteShort") : t("dash.createInviteBtn")}
        </button>
      </div>

      {loading && invites.length === 0 ? (
        <p className="text-sm text-themed-dim">{t("dash.loadingShort")}</p>
      ) : null}
      {!loading && invites.length === 0 ? (
        <p className="text-sm text-themed-dim italic">{t("dash.noInviteCodesYet")}</p>
      ) : null}

      <div className="space-y-2">
        {invites.map((inv) => {
          const used = !!inv.usedAt
          return (
            <div
              key={inv.id}
              className="flex items-center gap-3 p-3 rounded-lg bg-surface-800/50 border border-white/[0.04] overflow-x-auto whitespace-nowrap"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm font-medium text-themed shrink-0">{inv.name}</span>
                {used ? (
                  <span className="px-2 py-0.5 rounded text-xs bg-accent-violet/10 text-accent-violet shrink-0">
                    {t("dash.usedLabel")}
                  </span>
                ) : (
                  <button
                    onClick={() => copy(inv.code, inv.id)}
                    className="px-2 py-0.5 rounded text-xs font-mono bg-accent-violet/10 text-accent-violet shrink-0 cursor-pointer"
                    title={t("dash.clickToCopy")}
                  >
                    {copiedId === inv.id ? t("dash.copiedShort") : inv.code}
                  </button>
                )}
              </div>
              <div className="flex items-center gap-3 ml-auto shrink-0">
                <span className="text-xs text-themed-dim">{timeAgo(inv.createdAt)}</span>
                <button
                  onClick={() => onDelete(inv.id)}
                  className="text-xs text-themed-dim hover:text-accent-red transition-colors"
                >
                  {t("dash.deleteLabel")}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
