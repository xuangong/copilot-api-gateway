import type { UsageDimensions, UsageFilters } from "../../state/usage"
import { useT } from "../../state/i18n"
import { Select } from "../../components/Select"

interface Props {
  isAdmin: boolean
  filters: UsageFilters
  dimensions: UsageDimensions
  onChange: (patch: Partial<UsageFilters>) => void
  onClear: () => void
}

export function UsageFiltersBar({ isAdmin, filters, dimensions, onChange, onClear }: Props) {
  const t = useT()
  const anyFilter = filters.user || filters.key || filters.client || filters.model
  return (
    <div className="flex flex-wrap items-center gap-3">
      {isAdmin && dimensions.users.length > 0 ? (
        <FilterField label={t("dash.user")}>
          <Select
            value={filters.user}
            onChange={(v) => onChange({ user: v })}
            options={[
              { value: "", label: t("dash.allUsers") },
              ...dimensions.users.map((u) => ({ value: u.id, label: u.name })),
            ]}
          />
        </FilterField>
      ) : null}
      <FilterField label={t("dash.key")}>
        <Select
          value={filters.key}
          onChange={(v) => onChange({ key: v })}
          options={[
            { value: "", label: t("dash.allKeys") },
            ...dimensions.keys.map((k) => ({ value: k.id, label: k.name })),
          ]}
        />
      </FilterField>
      <FilterField label={t("dash.client")}>
        <Select
          value={filters.client}
          onChange={(v) => onChange({ client: v })}
          options={[
            { value: "", label: t("dash.allClients") },
            ...dimensions.clients.map((c) => ({ value: c, label: c })),
          ]}
        />
      </FilterField>
      <FilterField label={t("dash.model")}>
        <Select
          value={filters.model}
          onChange={(v) => onChange({ model: v })}
          options={[
            { value: "", label: t("dash.allModels") },
            ...dimensions.models.map((m) => ({ value: m, label: m })),
          ]}
        />
      </FilterField>
      {anyFilter ? (
        <button
          onClick={onClear}
          className="text-[11px] text-themed-dim hover:text-themed-secondary transition-colors px-2 py-1"
        >
          {t("dash.clearFilters")}
        </button>
      ) : null}
    </div>
  )
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 min-w-0 w-full sm:w-auto sm:flex-none sm:min-w-[180px]">
      <label className="text-[11px] text-themed-dim uppercase tracking-wide shrink-0 w-12 sm:w-auto">
        {label}
      </label>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  )
}
