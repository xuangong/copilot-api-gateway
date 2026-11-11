import { useId, type ReactNode } from "react"
import type { UsageDimensions, UsageFilters } from "../../state/usage"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Notice } from "../../ui/notice"
import { Select, type SelectOption } from "../../ui/select"
import {
  ALL_INCOMING_MODEL_OPTION,
  decodeIncomingModelOption,
  incomingModelFilterValue,
  incomingModelSelectOptions,
} from "../../state/usage-model-dimensions"

interface Props {
  isAdmin: boolean
  filters: UsageFilters
  dimensions: UsageDimensions
  onChange: (patch: Partial<UsageFilters>) => void
  onClear: () => void
}

/**
 * Options come from the period's data, so a filter set in one period can name
 * a value the next period never saw. Without an option for it the trigger has
 * nothing readable to show (an incoming model would read "model:…"), so keep
 * one for the current value until the filter is cleared.
 */
export function withCurrentOption(options: SelectOption[], value: string, label: string): SelectOption[] {
  if (value === "" || options.some((o) => o.value === value)) return options
  // Right after the leading "all" option, so the current choice sits at the top
  // of the list rather than past every value the period did see.
  const at = options[0] && isAllOption(options[0].value) ? 1 : 0
  return [...options.slice(0, at), { value, label }, ...options.slice(at)]
}

/** "" is "all" for every filter except incoming model, which uses its own token. */
function isAllOption(value: string): boolean {
  return value === "" || value === ALL_INCOMING_MODEL_OPTION
}

export function UsageFiltersBar({ isAdmin, filters, dimensions, onChange, onClear }: Props) {
  const t = useT()
  // Labels for a stale current value (see withCurrentOption). A stale key or
  // user is by definition missing from dimensions, the only place this
  // component could learn its name, so those fall back to the short id the way
  // FilterHint does. An incoming model shows its bare name.
  const incomingValue = incomingModelFilterValue(filters.incomingModel)
  const incomingName = decodeIncomingModelOption(incomingValue)
  const anyFilter = filters.user || filters.key || filters.client || filters.model || filters.incomingModel !== null
  return (
    <div className="flex flex-wrap items-center gap-3">
      {isAdmin && dimensions.users.length > 0 ? (
        <FilterField label={t("dash.user")}>
          {(labelId) => (
            <Select
              labelledBy={labelId}
              value={filters.user}
              onChange={(v) => onChange({ user: v })}
              options={withCurrentOption(
                [{ value: "", label: t("dash.allUsers") }, ...dimensions.users.map((u) => ({ value: u.id, label: u.name }))],
                filters.user,
                filters.user.slice(0, 8),
              )}
            />
          )}
        </FilterField>
      ) : null}
      <FilterField label={t("dash.key")}>
        {(labelId) => (
          <Select
            labelledBy={labelId}
            value={filters.key}
            onChange={(v) => onChange({ key: v })}
            options={withCurrentOption(
              [
                { value: "", label: t("dash.allKeys") },
                ...dimensions.keys.map((k) => ({
                  value: k.id,
                  label: k.name,
                  ...(k.shared ? { badge: t("dash.sharedBadge") } : {}),
                })),
              ],
              filters.key,
              filters.key.slice(0, 8),
            )}
          />
        )}
      </FilterField>
      <FilterField label={t("dash.client")}>
        {(labelId) => (
          <Select
            labelledBy={labelId}
            value={filters.client}
            onChange={(v) => onChange({ client: v })}
            options={withCurrentOption(
              [{ value: "", label: t("dash.allClients") }, ...dimensions.clients.map((c) => ({ value: c, label: c }))],
              filters.client,
              filters.client,
            )}
          />
        )}
      </FilterField>
      <FilterField label={t("dash.routedModel")}>
        {(labelId) => (
          <Select
            labelledBy={labelId}
            value={filters.model}
            onChange={(v) => onChange({ model: v })}
            options={withCurrentOption(
              [{ value: "", label: t("dash.allModels") }, ...dimensions.models.map((m) => ({ value: m, label: m }))],
              filters.model,
              filters.model,
            )}
          />
        )}
      </FilterField>
      <FilterField label={t("dash.incomingModel")}>
        {(labelId) => (
          <Select
            labelledBy={labelId}
            value={incomingValue}
            onChange={(value) => onChange({ incomingModel: decodeIncomingModelOption(value) })}
            options={withCurrentOption(
              incomingModelSelectOptions(dimensions.incomingModels, { all: t("dash.all") }),
              incomingValue,
              incomingName || t("dash.unknown"),
            )}
          />
        )}
      </FilterField>
      {/* Before the full-width notice, so it stays in the row of selects it
          clears instead of wrapping onto a line of its own below the notice. */}
      {anyFilter ? (
        <Button variant="ghost" size="sm" onClick={onClear}>
          {t("dash.clearFilters")}
        </Button>
      ) : null}
      {/* Usage is recorded per key only, so a shared key's traffic counts in
          full for every user who can reach it. Say so rather than let the
          numbers imply a per-person split. */}
      {isAdmin && dimensions.sharedInScope ? (
        <Notice tone="info" className="w-full">
          {t("dash.sharedUsageNote")}
        </Notice>
      ) : null}
    </div>
  )
}

/**
 * A visible label beside its select. The label's id names the select's
 * trigger (with the current value), so what is read out matches what is shown.
 */
function FilterField({ label, children }: { label: string; children: (labelId: string) => ReactNode }) {
  const labelId = useId()
  return (
    <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto sm:flex-none sm:min-w-[180px]">
      <span id={labelId} className="text-xs font-medium text-fg-muted shrink-0 w-24 sm:w-auto">
        {label}
      </span>
      <div className="flex-1 min-w-0">{children(labelId)}</div>
    </div>
  )
}
