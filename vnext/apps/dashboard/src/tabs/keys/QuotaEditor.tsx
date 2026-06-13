import { useState } from "react"
import type { ApiKeyDetail } from "../../api/keys"
import { useT } from "../../state/i18n"
import type { QuotaUsage } from "../../state/keys"

interface Props {
  keyRow: ApiKeyDetail
  usage: QuotaUsage
  canEdit: boolean
  busy: boolean
  onSave: (req: number | null, token: number | null) => Promise<boolean>
}

function progressClass(percent: number): string {
  if (percent > 90) return "bg-accent-red"
  if (percent > 70) return "bg-gradient-to-r from-accent-amber to-accent-red"
  return "bg-gradient-to-r from-accent-violet to-accent-teal"
}

// For unlimited quotas, scale usage logarithmically so the bar still moves
// noticeably as usage grows but never fills. 0 → 0%, 1k → ~30%, 1M → ~75%.
function unlimitedFillPercent(used: number): number {
  if (used <= 0) return 0
  const pct = Math.log10(used + 1) * 12
  return Math.max(3, Math.min(95, pct))
}

export function QuotaEditor({ keyRow, usage, canEdit, busy, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [reqInput, setReqInput] = useState<string>("")
  const [tokenInput, setTokenInput] = useState<string>("")
  const t = useT()

  const startEdit = () => {
    setReqInput(keyRow.quota_requests_per_day ? String(keyRow.quota_requests_per_day) : "")
    setTokenInput(keyRow.quota_tokens_per_day ? String(keyRow.quota_tokens_per_day) : "")
    setEditing(true)
  }

  const save = async () => {
    const reqNum = reqInput.trim() === "" ? null : Number(reqInput)
    const tokenNum = tokenInput.trim() === "" ? null : Number(tokenInput)
    const reqVal = typeof reqNum === "number" && Number.isFinite(reqNum) && reqNum > 0 ? reqNum : null
    const tokenVal = typeof tokenNum === "number" && Number.isFinite(tokenNum) && tokenNum > 0 ? tokenNum : null
    const ok = await onSave(reqVal, tokenVal)
    if (ok) setEditing(false)
  }

  return (
    <div className="glass-card p-4 sm:p-6 mb-6 animate-in delay-1">
      <div className="flex items-center justify-between mb-4">
        <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t("dash.dailyQuotaLabel")}</span>
        <div className="flex items-center gap-2">
          {!editing && canEdit ? (
            <button type="button" onClick={startEdit} className="btn-ghost text-xs">
              {t("dash.edit")}
            </button>
          ) : null}
          {editing ? (
            <>
              <button
                type="button"
                onClick={save}
                disabled={busy}
                className="btn-primary text-xs py-1 px-3"
              >
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="text-xs text-themed-dim block mb-1">{t("dash.requestsPerDayLabel")}</label>
            <input
              type="number"
              min="0"
              placeholder={t("dash.placeholderUnlimited")}
              value={reqInput}
              onChange={(e) => setReqInput(e.target.value)}
              className="w-full mt-1 text-sm"
            />
            <p className="text-[10px] text-themed-dim mt-1">{t("dash.leaveEmptyForUnlimited")}</p>
          </div>
          <div>
            <label className="text-xs text-themed-dim block mb-1">{t("dash.weightedTokensPerDayLabel")}</label>
            <input
              type="number"
              min="0"
              placeholder={t("dash.placeholderUnlimited")}
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              className="w-full mt-1 text-sm"
            />
            <p className="text-[10px] text-themed-dim mt-1">{t("dash.leaveEmptyForUnlimited")}</p>
          </div>
        </div>
      ) : null}

      <div className="mb-5">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-themed-secondary">{t("dash.requestsPerDayLabel")}</span>
          <span
            className={`text-xs font-mono ${usage.reqLimit ? "text-themed" : "text-themed-dim"}`}
          >
            {usage.reqLimit
              ? `${usage.reqUsed} / ${usage.reqLimit}`
              : `${usage.reqUsed} / ∞`}
          </span>
        </div>
        {usage.reqLimit ? (
          <>
            <div className="progress-track">
              <div
                className={`progress-fill ${progressClass(usage.reqPercent)}`}
                style={{ width: `${Math.min(usage.reqPercent, 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-themed-dim mt-1">
              {Math.max(0, usage.reqLimit - usage.reqUsed)} {t("dash.remaining")}
              {usage.reqPercent >= 100 ? (
                <span className="text-accent-red font-medium ml-1">{t("dash.quotaExceeded")}</span>
              ) : null}
            </p>
          </>
        ) : (
          <>
            <div className="progress-track">
              <div
                className="progress-fill bg-gradient-to-r from-accent-violet/40 to-accent-teal/40"
                style={{ width: `${unlimitedFillPercent(usage.reqUsed)}%` }}
              />
            </div>
            <p className="text-[10px] text-themed-dim mt-1">{t("dash.unlimitedUsedToday", { n: usage.reqUsed.toLocaleString() })}</p>
          </>
        )}
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-themed-secondary">{t("dash.weightedTokensPerDayLabel")}</span>
          <span
            className={`text-xs font-mono ${usage.tokenLimit ? "text-themed" : "text-themed-dim"}`}
          >
            {usage.tokenLimit
              ? `${Math.round(usage.tokenUsed).toLocaleString()} / ${usage.tokenLimit.toLocaleString()}`
              : `${Math.round(usage.tokenUsed).toLocaleString()} / ∞`}
          </span>
        </div>
        {usage.tokenLimit ? (
          <>
            <div className="progress-track">
              <div
                className={`progress-fill ${progressClass(usage.tokenPercent)}`}
                style={{ width: `${Math.min(usage.tokenPercent, 100)}%` }}
              />
            </div>
            <p className="text-[10px] text-themed-dim mt-1">
              {Math.max(0, Math.round(usage.tokenLimit - usage.tokenUsed)).toLocaleString()} {t("dash.remaining")}
              {usage.tokenPercent >= 100 ? (
                <span className="text-accent-red font-medium ml-1">{t("dash.quotaExceeded")}</span>
              ) : null}
            </p>
          </>
        ) : (
          <>
            <div className="progress-track">
              <div
                className="progress-fill bg-gradient-to-r from-accent-violet/40 to-accent-teal/40"
                style={{ width: `${unlimitedFillPercent(usage.tokenUsed)}%` }}
              />
            </div>
            <p className="text-[10px] text-themed-dim mt-1">
              {t("dash.unlimitedUsedToday", { n: Math.round(usage.tokenUsed).toLocaleString() })}
            </p>
          </>
        )}
      </div>

      <div className="rounded-lg bg-surface-800/60 border border-white/[0.04] p-3">
        <p className="text-[10px] text-themed-dim leading-relaxed">
          <span className="text-themed-secondary font-medium">{t("dash.tokenQuotaFormulaLabel")}</span>
          <code className="text-accent-violet ml-1">Cache Read × 10%</code> +{" "}
          <code className="text-accent-teal">Uncached Input × 100%</code> +{" "}
          <code className="text-accent-amber">Output × 500%</code>
        </p>
      </div>
    </div>
  )
}
