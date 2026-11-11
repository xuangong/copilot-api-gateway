import { useId } from "react"
import { Link2 } from "lucide-react"
import type { ApiKeyDetail, KeyRefDescriptor } from "../../api/keys"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { linkedKeyName } from "./web-search-borrow"

interface Props {
  label: string
  refId: string
  refDescriptor: KeyRefDescriptor | null
  existingMasked: string | null
  replacing: boolean
  value: string
  allKeys: ApiKeyDetail[]
  onUnlinkRef: () => void
  onStartReplace: () => void
  onChangeValue: (v: string) => void
  onBorrowOpen: () => void
}

/** One engine's key in edit mode: linked to another key, an existing masked key, or a field to type one. */
export function WebSearchEngineRow({
  label,
  refId,
  refDescriptor,
  existingMasked,
  replacing,
  value,
  allKeys,
  onUnlinkRef,
  onStartReplace,
  onChangeValue,
  onBorrowOpen,
}: Props) {
  const t = useT()
  const inputId = useId()
  const showInput = !refId && !(existingMasked && !replacing)
  return (
    <div className="space-y-1">
      <label htmlFor={showInput ? inputId : undefined} className="block text-xs font-medium text-fg-muted">
        {label}
      </label>
      {refId ? (
        <div className="flex items-center gap-2">
          {refDescriptor?.broken ? (
            <span className="min-w-0 truncate text-xs text-danger">{t("dash.wsLinkUnavailable")}</span>
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
              <Link2 className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
              <span className="truncate font-mono">{linkedKeyName(refDescriptor, refId, allKeys)}</span>
            </span>
          )}
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onUnlinkRef}>
            {t("dash.unlinkBtn")}
          </Button>
        </div>
      ) : existingMasked && !replacing ? (
        <div className="flex items-center gap-2">
          <span className="min-w-0 truncate font-mono text-xs text-fg-muted">{existingMasked}</span>
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onStartReplace}>
            {t("dash.replaceBtn")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          {/* The global input rule fixes width and font-family: inherit, so the wrapper sizes it and sets the mono face. */}
          <div className="min-w-0 flex-1 font-mono">
            <input
              id={inputId}
              type="text"
              value={value}
              onChange={(e) => onChangeValue(e.target.value)}
              placeholder={replacing ? t("dash.wsBlankToClearPlaceholder") : t("dash.wsNotSetPlaceholder")}
            />
          </div>
          <Button variant="ghost" size="sm" className="shrink-0" onClick={onBorrowOpen}>
            {t("dash.wsBorrowFromLabel")}
          </Button>
        </div>
      )}
    </div>
  )
}
