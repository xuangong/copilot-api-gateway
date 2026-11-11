import { useId, useState } from "react"
import { X } from "lucide-react"
import { useT } from "../../../state/i18n"
import { Badge } from "../../../ui/badge"
import { Button } from "../../../ui/button"
import { Notice } from "../../../ui/notice"
import { FormHeading, sectionHeadingCls } from "./Field"

export function DisabledModelsSection({
  editing,
  catalog,
  catalogError,
  catalogLoading,
  catalogRefreshing,
  catalogDraftChanged,
  onRefresh,
  disabledIds,
  setDisabledIds,
}: {
  editing: boolean
  catalog: { id: string; name: string }[] | null
  catalogError: string | null
  catalogLoading: boolean
  catalogRefreshing: boolean
  catalogDraftChanged: boolean
  onRefresh: () => void
  disabledIds: string[]
  setDisabledIds: (ids: string[]) => void
}) {
  const t = useT()
  const id = useId()
  const [extraIdInput, setExtraIdInput] = useState("")
  const addExtraId = () => {
    const value = extraIdInput.trim()
    if (!value) return
    if (!disabledIds.includes(value)) setDisabledIds([...disabledIds, value])
    setExtraIdInput("")
  }
  return (
    <div className="mt-4 border-t border-border pt-3">
      <FormHeading offset={1} id={`${id}-title`} className={sectionHeadingCls}>
        {t("dash.disabledModelsLabel")}
      </FormHeading>
      <p id={`${id}-hint`} className="mb-2 text-xs text-fg-subtle">{t("dash.disabledModelsHint")}</p>
      {editing && (
        <Button
          variant="ghost"
          size="sm"
          className="mb-2"
          disabled={catalogRefreshing || catalogDraftChanged}
          onClick={onRefresh}
        >
          {catalogRefreshing ? t("dash.disabledModelsLoading") : t("dash.refreshLabel")}
        </Button>
      )}
      {editing && catalogDraftChanged && (
        <p className="text-xs text-fg-subtle">{t("dash.modelsSaveBeforeRefresh")}</p>
      )}
      {editing && catalog === null && catalogLoading && !catalogError && (
        <p className="text-xs text-fg-subtle">{t("dash.disabledModelsLoading")}</p>
      )}
      {catalogError && <Notice tone="danger" className="text-xs">{catalogError}</Notice>}
      {editing && catalog?.length === 0 && !catalogLoading && (
        <p className="text-xs text-fg-subtle">{t("dash.noCachedModels")}</p>
      )}
      {editing && catalog && (
        <select
          multiple
          size={Math.min(8, Math.max(3, catalog.length))}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-hint`}
          className="w-full rounded-md border border-input bg-background font-mono text-[13px]"
          value={disabledIds}
          onChange={(e) => {
            const selected = Array.from(e.target.selectedOptions).map((o) => o.value)
            const ids = new Set(catalog.map((m) => m.id))
            const stale = disabledIds.filter((x) => !ids.has(x))
            setDisabledIds([...new Set([...selected, ...stale])])
          }}
        >
          {catalog.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
              {m.name && m.name !== m.id ? ` — ${m.name}` : ""}
            </option>
          ))}
        </select>
      )}
      <div className="mt-2 flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <input
            type="text"
            aria-label={t("dash.disabledModelsAddPlaceholder")}
            placeholder={t("dash.disabledModelsAddPlaceholder")}
            value={extraIdInput}
            onChange={(e) => setExtraIdInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.nativeEvent.isComposing) return
              e.preventDefault()
              addExtraId()
            }}
          />
        </div>
        <Button variant="secondary" size="sm" onClick={addExtraId}>
          {t("dash.disabledModelsAdd")}
        </Button>
      </div>
      {disabledIds.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1">
          {disabledIds.map((disabledId) => (
            <li key={disabledId}>
              <Badge className="gap-1 pr-0.5">
                <span className="font-mono">{disabledId}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="size-5 hover:text-danger [&_svg]:size-3"
                  aria-label={t("dash.removeDisabledModelAria", { id: disabledId })}
                  onClick={() => setDisabledIds(disabledIds.filter((x) => x !== disabledId))}
                >
                  <X aria-hidden="true" />
                </Button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
