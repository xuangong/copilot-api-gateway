import { useId } from "react"
import { useT } from "../../../state/i18n"
import { AZURE_SERVED_ENDPOINTS, CUSTOM_SERVED_ENDPOINTS } from "../upstream-form-state"
import type { FormState } from "../upstream-form-state"
import { FormHeading, sectionCls, sectionHeadingCls } from "./Field"

export function ServedEndpointsField({
  provider,
  form,
  toggleEndpoint,
}: {
  provider: "custom" | "azure"
  form: FormState
  toggleEndpoint: (ep: string) => void
}) {
  const t = useT()
  const id = useId()
  return (
    <div className={sectionCls}>
      <FormHeading offset={1} id={`${id}-title`} className={sectionHeadingCls}>{t("dash.servedEndpointsLabel")}</FormHeading>
      <p id={`${id}-hint`} className="mb-2 text-xs text-fg-subtle">
        {t("dash.servedEndpointsHint")}
      </p>
      <div
        role="group"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint`}
        className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-3"
      >
        {(provider === "azure" ? AZURE_SERVED_ENDPOINTS : CUSTOM_SERVED_ENDPOINTS).map((ep) => (
          <label key={ep} className="flex w-fit cursor-pointer items-center gap-2 text-fg">
            <input
              type="checkbox"
              className="accent-brand"
              checked={form.endpoints.includes(ep)}
              onChange={() => toggleEndpoint(ep)}
            />
            <span className="font-mono text-xs">{ep}</span>
          </label>
        ))}
      </div>
    </div>
  )
}
