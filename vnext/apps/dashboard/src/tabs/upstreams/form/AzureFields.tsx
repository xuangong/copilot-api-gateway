import { useT } from "../../../state/i18n"
import type { FormState, UpdateField } from "../upstream-form-state"
import { Field } from "./Field"

/** Azure connection fields. Deployment validation runs in the parent. */
export function AzureFields({
  form,
  update,
  editing,
  validateAzureDeployments,
}: {
  form: FormState
  update: UpdateField
  editing: boolean
  validateAzureDeployments: () => boolean
}) {
  const t = useT()
  return (
    <>
      <Field label={t("dash.endpointLabel")}>
        {({ id }) => (
          <input
            id={id}
            type="text"
            value={form.endpoint}
            onChange={(e) => update("endpoint", e.target.value)}
            onBlur={(e) => update("endpoint", e.target.value.trim().replace(/\/+$/, ""))}
            placeholder="https://x.openai.azure.com"
          />
        )}
      </Field>
      <Field label={t("dash.apiKeyLabel")}>
        {({ id }) => (
          <input
            id={id}
            value={form.azureApiKey}
            onChange={(e) => update("azureApiKey", e.target.value)}
            type="password"
            placeholder={editing ? t("dash.leaveBlankToKeep") : ""}
          />
        )}
      </Field>
      <Field label={t("dash.defaultDeploymentLabel")}>
        {({ id }) => (
          <input
            id={id}
            type="text"
            value={form.deployment}
            onChange={(e) => update("deployment", e.target.value)}
            placeholder="gpt-4o"
          />
        )}
      </Field>
      <Field label={t("dash.apiVersionLabel")}>
        {({ id }) => <input id={id} type="text" value={form.apiVersion} onChange={(e) => update("apiVersion", e.target.value)} />}
      </Field>
      <Field
        label={t("dash.additionalDeploymentsLabel")}
        hint={t("dash.additionalDeploymentsHint")}
        error={form.azureDeploymentsError || undefined}
      >
        {({ id, describedBy }) => (
          <textarea
            id={id}
            value={form.azureDeployments}
            onChange={(e) => update("azureDeployments", e.target.value)}
            onBlur={validateAzureDeployments}
            rows={3}
            placeholder={"gpt-4o = gpt-4o\ntext-embed = text-embedding-3-small"}
            aria-invalid={form.azureDeploymentsError ? true : undefined}
            aria-describedby={describedBy}
            className="w-full font-mono text-xs aria-invalid:border-danger"
          />
        )}
      </Field>
    </>
  )
}
