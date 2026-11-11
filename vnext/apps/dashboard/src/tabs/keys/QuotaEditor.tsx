import { useId, useState } from "react"
import type { ApiKeyDetail } from "../../api/keys"
import { WEIGHTED_FORMULA_PARTS, formatWeight } from "../../components/weighted-formula"
import { useT } from "../../state/i18n"
import type { QuotaLoad, QuotaUsage } from "../../state/key-quota"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { cn } from "../../ui/cn"
import { Meter, meterTone } from "../../ui/meter"
import { Notice } from "../../ui/notice"

interface Props {
  keyRow: ApiKeyDetail
  usage: QuotaUsage | null
  load: QuotaLoad
  onRetry: () => void
  canEdit: boolean
  busy: boolean
  onSave: (req: number | null, token: number | null, cost: number | null) => Promise<boolean>
}

// For unlimited quotas, scale usage logarithmically so the bar still moves
// noticeably as usage grows but never fills. 0 → 0%, 1k → ~30%, 1M → ~75%.
export function unlimitedFillPercent(used: number): number {
  if (used <= 0) return 0
  const pct = Math.log10(used + 1) * 12
  return Math.max(3, Math.min(95, pct))
}

/** How one usage dimension prints its numbers. */
export interface UsageFormat {
  /** Used and remaining amounts against a limit. */
  amount: (n: number) => string
  /** The limit itself. */
  limit: (n: number) => string
  /** The used amount when there is no limit. */
  unlimited: (n: number) => string
}

export const REQUESTS_FORMAT: UsageFormat = {
  amount: (n) => String(n),
  limit: (n) => String(n),
  unlimited: (n) => n.toLocaleString(),
}

export const TOKENS_FORMAT: UsageFormat = {
  amount: (n) => Math.round(n).toLocaleString(),
  limit: (n) => n.toLocaleString(),
  unlimited: (n) => Math.round(n).toLocaleString(),
}

export const COST_FORMAT: UsageFormat = {
  amount: (n) => `$${n.toFixed(4)}`,
  limit: (n) => `$${n}`,
  unlimited: (n) => `$${n.toFixed(4)}`,
}

interface UsageRowProps {
  label: string
  used: number
  limit: number | null
  /** Rounded percent of the limit (0 when there is no limit). */
  percent: number
  format: UsageFormat
}

export function UsageRow({ label, used, limit, percent, format }: UsageRowProps) {
  const t = useT()
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-xs text-fg-muted">{label}</span>
        <span className={cn("text-xs tabular-nums", limit ? "text-fg" : "text-fg-subtle")}>
          {limit ? `${format.amount(used)} / ${format.limit(limit)}` : `${format.amount(used)} / ∞`}
        </span>
      </div>
      {limit ? (
        <>
          <Meter percent={Math.min(percent, 100)} tone={meterTone(percent)} />
          <p className="mt-1 text-xs text-fg-subtle">
            <span className="tabular-nums">{format.amount(Math.max(0, limit - used))}</span> {t("dash.remaining")}
            {percent >= 100 ? <span className="ml-1 font-medium text-danger">{t("dash.quotaExceeded")}</span> : null}
          </p>
        </>
      ) : (
        <>
          <Meter percent={unlimitedFillPercent(used)} tone="muted" />
          <p className="mt-1 text-xs text-fg-subtle">{t("dash.unlimitedUsedThisMonth", { n: format.unlimited(used) })}</p>
        </>
      )}
    </div>
  )
}

function QuotaField({
  label,
  value,
  onChange,
  step,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  step?: string
}) {
  const t = useT()
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min="0"
        step={step}
        placeholder={t("dash.placeholderUnlimited")}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <p className="mt-1 text-xs text-fg-subtle">{t("dash.leaveEmptyForUnlimited")}</p>
    </div>
  )
}

export function QuotaEditor({ keyRow, usage, load, onRetry, canEdit, busy, onSave }: Props) {
  const [editing, setEditing] = useState(false)
  const [reqInput, setReqInput] = useState<string>("")
  const [tokenInput, setTokenInput] = useState<string>("")
  const [costInput, setCostInput] = useState<string>("")
  const t = useT()

  const startEdit = () => {
    setReqInput(keyRow.quota_requests_per_month ? String(keyRow.quota_requests_per_month) : "")
    setTokenInput(keyRow.quota_tokens_per_month ? String(keyRow.quota_tokens_per_month) : "")
    setCostInput(keyRow.quota_cost_per_month ? String(keyRow.quota_cost_per_month) : "")
    setEditing(true)
  }

  // Blank / zero / non-numeric all mean "unlimited" — the server stores NULL.
  const positiveOrNull = (raw: string): number | null => {
    if (raw.trim() === "") return null
    const n = Number(raw)
    return Number.isFinite(n) && n > 0 ? n : null
  }

  const save = async () => {
    const ok = await onSave(positiveOrNull(reqInput), positiveOrNull(tokenInput), positiveOrNull(costInput))
    if (ok) setEditing(false)
  }

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-2">
        <SectionHeading>{t("dash.monthlyQuotaLabel")}</SectionHeading>
        <div className="flex items-center gap-2">
          {!editing && canEdit ? (
            <Button variant="ghost" size="sm" onClick={startEdit}>
              {t("dash.edit")}
            </Button>
          ) : null}
          {editing ? (
            <>
              <Button variant="primary" size="sm" onClick={save} disabled={busy}>
                {busy ? t("dash.savingShort") : t("dash.save")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                {t("dash.cancel")}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {editing ? (
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <QuotaField label={t("dash.requestsPerMonthLabel")} value={reqInput} onChange={setReqInput} />
          <QuotaField label={t("dash.weightedTokensPerMonthLabel")} value={tokenInput} onChange={setTokenInput} />
          <QuotaField label={t("dash.costPerMonthLabel")} value={costInput} onChange={setCostInput} step="0.01" />
        </div>
      ) : null}

      {load.status === "loading" ? (
        <Notice role="status" className="mb-3">
          {t(usage ? "dash.quotaRefreshingStale" : "dash.quotaLoading")}
        </Notice>
      ) : null}
      {load.status === "error" ? (
        <Notice tone="danger" className="mb-3 flex items-center gap-3">
          <span>{t(usage ? "dash.quotaErrorStale" : "dash.quotaError")}: {load.error}</span>
          <Button variant="ghost" size="sm" onClick={onRetry}>
            {t("dash.quotaRetry")}
          </Button>
        </Notice>
      ) : null}
      {usage ? (
        <div className="mb-4 space-y-4">
          <UsageRow
            label={t("dash.requestsPerMonthLabel")}
            used={usage.reqUsed}
            limit={usage.reqLimit}
            percent={usage.reqPercent}
            format={REQUESTS_FORMAT}
          />
          <UsageRow
            label={t("dash.weightedTokensPerMonthLabel")}
            used={usage.tokenUsed}
            limit={usage.tokenLimit}
            percent={usage.tokenPercent}
            format={TOKENS_FORMAT}
          />
          <UsageRow
            label={t("dash.costPerMonthLabel")}
            used={usage.costUsed}
            limit={usage.costLimit}
            percent={usage.costPercent}
            format={COST_FORMAT}
          />
        </div>
      ) : (
        <div className="mb-4 grid grid-cols-1 gap-3 text-xs text-fg-subtle sm:grid-cols-3">
          <p>{t("dash.requestsPerMonthLabel")}: — / {keyRow.quota_requests_per_month ?? "∞"}</p>
          <p>{t("dash.weightedTokensPerMonthLabel")}: — / {keyRow.quota_tokens_per_month ?? "∞"}</p>
          <p>{t("dash.costPerMonthLabel")}: — / {keyRow.quota_cost_per_month ?? "∞"}</p>
        </div>
      )}
      {usage && usage.unpricedDimensionRows > 0 ? (
        <p className="mb-3 text-xs text-fg-subtle">{t("dash.quotaUnpriced", { rows: usage.unpricedDimensionRows })}</p>
      ) : null}
      <p className="mb-3 text-xs text-fg-subtle">{t("dash.quotaRecordedCost")}</p>
      <div className="rounded-lg border border-border bg-muted p-3">
        <p className="text-xs leading-relaxed text-fg-subtle">
          <span className="font-medium text-fg-muted">{t("dash.tokenQuotaFormulaLabel")}</span>
          {WEIGHTED_FORMULA_PARTS.map((part, i) => (
            <span key={part.labelKey}>
              {i > 0 ? " + " : " "}
              <code className="text-fg">
                {t(part.labelKey)} {formatWeight(part.weight)}
              </code>
            </span>
          ))}
        </p>
      </div>
    </Card>
  )
}
