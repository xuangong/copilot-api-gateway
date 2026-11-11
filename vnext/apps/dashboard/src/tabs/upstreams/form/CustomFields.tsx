import { useId } from "react"
import { ChevronRight } from "lucide-react"
import { useT } from "../../../state/i18n"
import { Select } from "../../../ui/select"
import { PATH_OVERRIDE_KEYS } from "../upstream-form-state"
import type { FormState, UpdateField } from "../upstream-form-state"
import { Field, FormHeading, sectionCls, sectionHeadingCls } from "./Field"

/** Base URL, API key and auth style for a custom upstream. */
export function CustomFields({ form, update, editing }: { form: FormState; update: UpdateField; editing: boolean }) {
  const t = useT()
  return (
    <>
      <Field label={t("dash.baseUrlLabel")}>
        {({ id }) => (
          <input
            id={id}
            type="text"
            value={form.baseUrl}
            onChange={(e) => update("baseUrl", e.target.value)}
            onBlur={(e) => update("baseUrl", e.target.value.trim().replace(/\/+$/, ""))}
            placeholder="https://api.deepseek.com/v1"
          />
        )}
      </Field>
      <Field label={t("dash.apiKeyLabel")}>
        {({ id }) => (
          <input
            id={id}
            value={form.apiKey}
            onChange={(e) => update("apiKey", e.target.value)}
            type="password"
            placeholder={editing ? t("dash.leaveBlankToKeep") : "sk-..."}
          />
        )}
      </Field>
      <Field label={t("dash.authStyleLabel")} hint={t("dash.authStyleHint")} labelledBy>
        {({ labelId, describedBy }) => (
          <Select
            value={form.authStyle}
            onChange={(v) => update("authStyle", v)}
            labelledBy={labelId}
            describedBy={describedBy}
            options={[
              { value: "bearer", label: t("dash.authStyleBearer") },
              { value: "anthropic", label: t("dash.authStyleAnthropic") },
              { value: "none", label: t("dash.authStyleNone") },
            ]}
          />
        )}
      </Field>
    </>
  )
}

/**
 * Manual model list, models endpoint and path overrides for a custom
 * upstream. Rendered after the served-endpoints section, so it is a separate
 * component from {@link CustomFields}.
 */
export function CustomModelFields({
  form,
  update,
  setPathOverride,
}: {
  form: FormState
  update: UpdateField
  setPathOverride: (key: string, value: string) => void
}) {
  const t = useT()
  const id = useId()
  return (
    <>
      <div className={sectionCls}>
        <FormHeading offset={1} id={`${id}-models`} className={sectionHeadingCls}>
          {t("dash.manualModelListLabel")}
        </FormHeading>
        <p id={`${id}-models-hint`} className="mb-2 text-xs text-fg-subtle">
          {t("dash.manualModelListHint")}
        </p>
        <textarea
          value={form.modelsText}
          onChange={(e) => update("modelsText", e.target.value)}
          rows={4}
          placeholder={"deepseek-chat\ndeepseek-coder # DeepSeek Coder"}
          aria-labelledby={`${id}-models`}
          aria-describedby={`${id}-models-hint`}
          className="w-full font-mono text-xs"
        />
        <Field label={t("dash.modelsEndpointLabel")} hint={t("dash.modelsEndpointHint")} className="mt-3">
          {({ id: inputId, describedBy }) => (
            <div className="font-mono">
              <input
                id={inputId}
                type="text"
                value={form.modelsEndpoint}
                onChange={(e) => update("modelsEndpoint", e.target.value)}
                onBlur={(e) => update("modelsEndpoint", e.target.value.trim())}
                placeholder={form.baseUrl ? `${form.baseUrl}/models` : "https://api.example.com/v1/models"}
                aria-describedby={describedBy}
              />
            </div>
          )}
        </Field>
      </div>

      <details className={`group ${sectionCls}`}>
        <summary className="mb-2 flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-[13px] font-medium text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-open:rotate-90" aria-hidden="true" />
          {t("dash.pathOverridesLabel")}
        </summary>
        <p className="mb-2 text-xs text-fg-subtle">{t("dash.pathOverridesHint")}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {PATH_OVERRIDE_KEYS.map(([key, fallback]) => (
            <Field key={key} label={key}>
              {({ id: inputId }) => (
                <div className="font-mono">
                  <input
                    id={inputId}
                    type="text"
                    value={form.pathOverrides[key] ?? ""}
                    onChange={(e) => setPathOverride(key, e.target.value)}
                    onBlur={(e) => setPathOverride(key, e.target.value.trim())}
                    placeholder={fallback}
                  />
                </div>
              )}
            </Field>
          ))}
        </div>
      </details>
    </>
  )
}
