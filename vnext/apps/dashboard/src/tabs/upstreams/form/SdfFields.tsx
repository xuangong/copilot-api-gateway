import { useId } from "react"
import { useT } from "../../../state/i18n"
import { Select } from "../../../ui/select"
import { SDF_EXPERIENCES, SDF_SERVICE_TIERS, SDF_TRAFFIC_TYPES } from "../upstream-form-state"
import type { FormState, UpdateField } from "../upstream-form-state"
import { Field, FormHeading, sectionCls, sectionHeadingCls } from "./Field"

const toOptions = (values: string[]) => values.map((v) => ({ value: v, label: v }))

export function SdfFields({ form, update, editing }: { form: FormState; update: UpdateField; editing: boolean }) {
  const t = useT()
  const id = useId()
  return (
    <>
      <Field label={t("dash.substrateTokenLabel")} hint={t("dash.substrateTokenHint")}>
        {({ id: inputId, describedBy }) => (
          <input
            id={inputId}
            value={form.substrateToken}
            onChange={(e) => update("substrateToken", e.target.value)}
            type="password"
            placeholder={editing ? t("dash.leaveBlankToKeep") : ""}
            aria-describedby={describedBy}
          />
        )}
      </Field>

      <div className={`${sectionCls} space-y-3`}>
        <div>
          <FormHeading offset={1} className={sectionHeadingCls}>{t("dash.sdfTaxonomyLabel")}</FormHeading>
          <p className="text-xs text-fg-subtle">{t("dash.sdfTaxonomyHint")}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label={t("dash.sdfExperienceLabel")}>
            {({ id, labelId }) => (
              <Select
                id={id}
                value={form.sdfExperience}
                onChange={(v) => update("sdfExperience", v)}
                labelledBy={labelId}
                options={toOptions(SDF_EXPERIENCES)}
              />
            )}
          </Field>
          <Field label={t("dash.sdfAgentLabel")}>
            {({ id: inputId }) => (
              <input id={inputId} type="text" value={form.sdfAgent} onChange={(e) => update("sdfAgent", e.target.value)} />
            )}
          </Field>
          <Field label={t("dash.sdfInferenceStepLabel")}>
            {({ id: inputId }) => (
              <input
                id={inputId}
                type="text"
                value={form.sdfInferenceStep}
                onChange={(e) => update("sdfInferenceStep", e.target.value)}
              />
            )}
          </Field>
          <Field label={t("dash.sdfTrafficTypeLabel")}>
            {({ id, labelId }) => (
              <Select
                id={id}
                value={form.sdfTrafficType}
                onChange={(v) => update("sdfTrafficType", v)}
                labelledBy={labelId}
                options={toOptions(SDF_TRAFFIC_TYPES)}
              />
            )}
          </Field>
          <Field label={t("dash.sdfServiceTierLabel")}>
            {({ id, labelId }) => (
              <Select
                id={id}
                value={form.sdfServiceTier}
                onChange={(v) => update("sdfServiceTier", v)}
                labelledBy={labelId}
                options={toOptions(SDF_SERVICE_TIERS)}
              />
            )}
          </Field>
          <Field label={t("dash.sdfPassportApiBaseLabel")}>
            {({ id: inputId }) => (
              <input
                id={inputId}
                type="text"
                value={form.sdfPassportApiBase}
                onChange={(e) => update("sdfPassportApiBase", e.target.value)}
              />
            )}
          </Field>
        </div>
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-fg">
          <input
            type="checkbox"
            className="accent-brand"
            checked={form.sdfPassportEnabled}
            onChange={(e) => update("sdfPassportEnabled", e.target.checked)}
            aria-describedby={`${id}-passport-hint`}
          />
          <span>{t("dash.sdfPassportEnabledLabel")}</span>
        </label>
        <p id={`${id}-passport-hint`} className="text-xs text-fg-subtle">{t("dash.sdfPassportHint")}</p>
      </div>
    </>
  )
}
