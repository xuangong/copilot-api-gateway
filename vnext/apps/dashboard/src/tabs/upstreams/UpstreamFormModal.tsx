import { useEffect, useMemo, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import * as api from "../../api/upstreams"
import type { UpstreamRecord } from "../../api/types"

type Provider = "copilot" | "azure" | "custom" | "sdf"

interface Props {
  mode: { kind: "create"; provider: Exclude<Provider, "copilot"> } | { kind: "edit"; row: UpstreamRecord }
  flagCatalog: api.FlagCatalog | null
  ensureFlagCatalog: () => Promise<api.FlagCatalog>
  onClose: () => void
  onSaved: () => void
}

interface FormState {
  name: string
  baseUrl: string
  apiKey: string
  endpoint: string
  azureApiKey: string
  deployment: string
  apiVersion: string
  endpoints: string[]
  modelsText: string
  azureDeployments: string
  azureDeploymentsError: string
  flagOverrides: Record<string, boolean>
  copilotLogin: string
  substrateToken: string
}

const EMPTY: FormState = {
  name: "",
  baseUrl: "",
  apiKey: "",
  endpoint: "",
  azureApiKey: "",
  deployment: "",
  apiVersion: "2024-08-01-preview",
  endpoints: ["chat_completions", "embeddings"],
  modelsText: "",
  azureDeployments: "",
  azureDeploymentsError: "",
  flagOverrides: {},
  copilotLogin: "",
  substrateToken: "",
}

const SERVED_ENDPOINTS = ["chat_completions", "responses", "messages", "messages_count_tokens", "embeddings"] as const

function buildInitial(mode: Props["mode"]): { provider: Provider; form: FormState } {
  if (mode.kind === "create") {
    return {
      provider: mode.provider,
      form: {
        ...EMPTY,
        endpoints:
          mode.provider === "azure"
            ? ["chat_completions"]
            : mode.provider === "sdf"
              ? ["images_generations", "images_edits"]
              : ["chat_completions", "embeddings"],
      },
    }
  }
  const u = mode.row
  const cfg = u.config ?? {}
  type ModelEntry = string | { id: string; name?: string }
  const modelsList: ModelEntry[] = Array.isArray((cfg as { models?: ModelEntry[] }).models)
    ? (cfg as { models: ModelEntry[] }).models
    : []
  const modelsText = modelsList
    .map((m) => (typeof m === "string" ? m : `${m.id}${m.name ? ` # ${m.name}` : ""}`))
    .join("\n")
  const azureDepsText =
    (Array.isArray((cfg as { deployments?: { name: string; model?: string }[] }).deployments)
      ? (cfg as { deployments: { name: string; model?: string }[] }).deployments
      : [])
      .map((d) => `${d.name}${d.model ? ` = ${d.model}` : ""}`)
      .join("\n")
  return {
    provider: u.provider,
    form: {
      name: u.name,
      baseUrl: u.provider === "custom" ? cfg.baseUrl ?? "" : "",
      apiKey: "",
      endpoint: u.provider === "azure" ? cfg.endpoint ?? "" : "",
      azureApiKey: "",
      deployment: u.provider === "azure" ? cfg.deployment ?? "" : "",
      apiVersion: u.provider === "azure" ? cfg.apiVersion ?? "2024-08-01-preview" : "2024-08-01-preview",
      endpoints: Array.isArray(cfg.endpoints)
        ? [...cfg.endpoints]
        : u.provider === "custom"
          ? ["chat_completions", "embeddings"]
          : u.provider === "sdf"
            ? ["images_generations", "images_edits"]
            : ["chat_completions"],
      modelsText,
      azureDeployments: azureDepsText,
      azureDeploymentsError: "",
      flagOverrides: { ...(u.flagOverrides ?? {}) },
      copilotLogin: u.provider === "copilot" ? cfg.user?.login ?? "" : "",
      substrateToken: "",
    },
  }
}

function parseModelsText(txt: string): (string | { id: string; name: string })[] | undefined {
  if (!txt.trim()) return undefined
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const hashAt = line.indexOf("#")
      if (hashAt === -1) return line
      return { id: line.slice(0, hashAt).trim(), name: line.slice(hashAt + 1).trim() }
    })
}

function parseAzureDeployments(txt: string): { name: string; model: string }[] | undefined {
  if (!txt.trim()) return undefined
  return txt
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const eqAt = line.indexOf("=")
      if (eqAt === -1) return { name: line, model: line }
      return { name: line.slice(0, eqAt).trim(), model: line.slice(eqAt + 1).trim() }
    })
}

export function UpstreamFormModal({ mode, flagCatalog, ensureFlagCatalog, onClose, onSaved }: Props) {
  const { push: toast } = useToast()
  const t = useT()
  const initial = useMemo(() => buildInitial(mode), [mode])
  const [provider] = useState<Provider>(initial.provider)
  const [form, setForm] = useState<FormState>(initial.form)
  const [saving, setSaving] = useState(false)
  const editing = mode.kind === "edit"
  const editingId = editing ? mode.row.id : null

  const [catalog, setCatalog] = useState<{ id: string; name: string }[] | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [disabledIds, setDisabledIds] = useState<string[]>(
    mode.kind === "edit" ? [...(mode.row.disabledPublicModelIds ?? [])] : [],
  )
  const [extraIdInput, setExtraIdInput] = useState("")

  useEffect(() => {
    ensureFlagCatalog().catch((e) => toast(e instanceof Error ? e.message : String(e), "error"))
  }, [ensureFlagCatalog, toast])

  useEffect(() => {
    if (mode.kind !== "edit") return
    let cancelled = false
    api.getUpstreamCatalog(mode.row.id).then(
      (c) => {
        if (!cancelled) setCatalog(c.models)
      },
      (err) => {
        if (!cancelled) setCatalogError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      cancelled = true
    }
  }, [mode])

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const toggleEndpoint = (ep: string) =>
    setForm((f) => ({
      ...f,
      endpoints: f.endpoints.includes(ep) ? f.endpoints.filter((x) => x !== ep) : [...f.endpoints, ep],
    }))

  const flagOverrideState = (id: string): "inherit" | "on" | "off" => {
    const v = form.flagOverrides[id]
    return v === undefined ? "inherit" : v ? "on" : "off"
  }
  const setFlagOverride = (id: string, value: boolean | null) =>
    setForm((f) => {
      const next = { ...f.flagOverrides }
      if (value === null) delete next[id]
      else next[id] = value
      return { ...f, flagOverrides: next }
    })

  const isFlagDefault = (flagId: string) =>
    !!flagCatalog?.defaults?.[provider]?.includes(flagId)

  const validateAzureDeployments = (): boolean => {
    const txt = form.azureDeployments
    if (!txt.trim()) {
      update("azureDeploymentsError", "")
      return true
    }
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      const eqAt = line.indexOf("=")
      if (eqAt === -1) {
        update("azureDeploymentsError", t("dash.errAzureDepFormat"))
        return false
      }
      const name = line.slice(0, eqAt).trim()
      const model = line.slice(eqAt + 1).trim()
      if (!name || !model) {
        update("azureDeploymentsError", t("dash.errAzureDepBoth", { line }))
        return false
      }
    }
    update("azureDeploymentsError", "")
    return true
  }

  const submit = async () => {
    if (!form.name.trim()) {
      toast(t("dash.errNameRequired"), "error")
      return
    }
    setSaving(true)
    try {
      if (provider === "copilot") {
        if (!editingId) {
          toast(t("dash.errAddCopilotViaDeviceFlow"), "error")
          return
        }
        await api.patchUpstream(editingId, { name: form.name.trim(), flagOverrides: form.flagOverrides })
        toast(t("dash.toastUpdated"), "success")
        onSaved()
        return
      }
      if (provider === "azure" && !validateAzureDeployments()) return

      let config: Record<string, unknown>
      if (!editingId) {
        if (provider === "custom") {
          if (!form.baseUrl.trim() || !form.apiKey.trim()) {
            toast(t("dash.errBaseUrlApiKeyRequired"), "error")
            return
          }
          config = {
            name: form.name.trim(),
            baseUrl: form.baseUrl.trim(),
            apiKey: form.apiKey.trim(),
            endpoints: form.endpoints,
          }
          const models = parseModelsText(form.modelsText)
          if (models) (config as { models: unknown }).models = models
        } else if (provider === "sdf") {
          if (!form.substrateToken.trim()) {
            toast(t("dash.errSubstrateTokenRequired"), "error")
            return
          }
          config = {
            name: form.name.trim(),
            substrateToken: form.substrateToken.trim(),
          }
        } else {
          if (!form.endpoint.trim() || !form.azureApiKey.trim() || !form.deployment.trim()) {
            toast(t("dash.errEndpointApiKeyDeploymentRequired"), "error")
            return
          }
          config = {
            name: form.name.trim(),
            endpoint: form.endpoint.trim(),
            apiKey: form.azureApiKey.trim(),
            deployment: form.deployment.trim(),
            apiVersion: form.apiVersion.trim() || "2024-08-01-preview",
            endpoints: form.endpoints,
          }
          const deps = parseAzureDeployments(form.azureDeployments)
          if (deps) (config as { deployments: unknown }).deployments = deps
        }
        await api.createUpstream({
          provider,
          name: form.name.trim(),
          config,
          flagOverrides: form.flagOverrides,
          disabledPublicModelIds: disabledIds,
        })
        toast(t("dash.toastCreated"), "success")
      } else {
        config = { name: form.name.trim() }
        if (provider === "custom") {
          if (form.baseUrl.trim()) (config as { baseUrl: string }).baseUrl = form.baseUrl.trim()
          if (form.apiKey.trim()) (config as { apiKey: string }).apiKey = form.apiKey.trim()
          ;(config as { endpoints: string[] }).endpoints = form.endpoints
          const models = parseModelsText(form.modelsText)
          ;(config as { models: unknown }).models = models ?? []
        } else if (provider === "sdf") {
          if (form.substrateToken.trim()) {
            (config as { substrateToken: string }).substrateToken = form.substrateToken.trim()
          }
        } else {
          if (form.endpoint.trim()) (config as { endpoint: string }).endpoint = form.endpoint.trim()
          if (form.azureApiKey.trim()) (config as { apiKey: string }).apiKey = form.azureApiKey.trim()
          if (form.deployment.trim()) (config as { deployment: string }).deployment = form.deployment.trim()
          if (form.apiVersion.trim()) (config as { apiVersion: string }).apiVersion = form.apiVersion.trim()
          ;(config as { endpoints: string[] }).endpoints = form.endpoints
          const deps = parseAzureDeployments(form.azureDeployments)
          ;(config as { deployments: unknown }).deployments = deps ?? []
        }
        await api.patchUpstream(editingId, {
          name: form.name.trim(),
          config,
          flagOverrides: form.flagOverrides,
          disabledPublicModelIds: disabledIds,
        })
        toast(t("dash.toastUpdated"), "success")
      }
      onSaved()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error")
    } finally {
      setSaving(false)
    }
  }

  const title = (
    <span>
      {editing ? t("dash.editUpstream") : t("dash.addUpstream")} <span className="capitalize">{provider}</span> {t("dash.upstreamSuffix")}
    </span>
  )

  return (
    <div
      className="rounded-lg p-4 sm:p-5 mt-2"
      style={{ background: "var(--surface-800)", border: "1px solid var(--border-color)" }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-themed font-semibold text-sm">{title}</div>
        <button
          onClick={onClose}
          className="text-themed-dim hover:text-themed text-xs"
          aria-label={t("dash.closeBtn")}
        >
          ×
        </button>
      </div>
      <div className="space-y-3">
        <Field label={t("dash.nameLabel")}>
          <input
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
            placeholder={t("dash.namePlaceholderUpstream")}
            className={inputCls}
          />
        </Field>

        {provider === "custom" ? (
          <>
            <Field label={t("dash.baseUrlLabel")}>
              <input
                value={form.baseUrl}
                onChange={(e) => update("baseUrl", e.target.value)}
                onBlur={(e) => update("baseUrl", e.target.value.trim().replace(/\/+$/, ""))}
                placeholder="https://api.deepseek.com/v1"
                className={inputCls}
              />
            </Field>
            <Field label={t("dash.apiKeyLabel")}>
              <input
                value={form.apiKey}
                onChange={(e) => update("apiKey", e.target.value)}
                type="password"
                placeholder={editing ? t("dash.leaveBlankToKeep") : "sk-..."}
                className={inputCls}
              />
            </Field>
          </>
        ) : null}

        {provider === "azure" ? (
          <>
            <Field label={t("dash.endpointLabel")}>
              <input
                value={form.endpoint}
                onChange={(e) => update("endpoint", e.target.value)}
                onBlur={(e) => update("endpoint", e.target.value.trim().replace(/\/+$/, ""))}
                placeholder="https://x.openai.azure.com"
                className={inputCls}
              />
            </Field>
            <Field label={t("dash.apiKeyLabel")}>
              <input
                value={form.azureApiKey}
                onChange={(e) => update("azureApiKey", e.target.value)}
                type="password"
                placeholder={editing ? t("dash.leaveBlankToKeep") : ""}
                className={inputCls}
              />
            </Field>
            <Field label={t("dash.defaultDeploymentLabel")}>
              <input
                value={form.deployment}
                onChange={(e) => update("deployment", e.target.value)}
                placeholder="gpt-4o"
                className={inputCls}
              />
            </Field>
            <Field label={t("dash.apiVersionLabel")}>
              <input value={form.apiVersion} onChange={(e) => update("apiVersion", e.target.value)} className={inputCls} />
            </Field>
            <Field label={t("dash.additionalDeploymentsLabel")}>
              <textarea
                value={form.azureDeployments}
                onChange={(e) => update("azureDeployments", e.target.value)}
                onBlur={validateAzureDeployments}
                rows={3}
                placeholder={"gpt-4o = gpt-4o\ntext-embed = text-embedding-3-small"}
                className={`${inputCls} font-mono text-xs ${form.azureDeploymentsError ? "border-red-500" : ""}`}
              />
              {form.azureDeploymentsError ? (
                <span className="text-xs text-accent-red block mt-1">{form.azureDeploymentsError}</span>
              ) : (
                <span className="text-xs text-themed-dim block mt-1">
                  {t("dash.additionalDeploymentsHint")}
                </span>
              )}
            </Field>
          </>
        ) : null}

        {provider === "sdf" ? (
          <>
            <Field label={t("dash.substrateTokenLabel")}>
              <input
                value={form.substrateToken}
                onChange={(e) => update("substrateToken", e.target.value)}
                type="password"
                placeholder={editing ? t("dash.leaveBlankToKeep") : ""}
                className={inputCls}
              />
            </Field>
            <p className="text-xs text-themed-dim">{t("dash.substrateTokenHint")}</p>
          </>
        ) : null}

        {provider === "copilot" ? (
          <div className="bg-surface-800 border border-surface-600 rounded p-3 text-xs space-y-1">
            <div className="text-themed-dim">{t("dash.githubLoginLabel")}</div>
            <div className="text-themed font-mono">{form.copilotLogin || "(unknown)"}</div>
            <div className="text-themed-dim mt-2">
              {t("dash.copilotTokenHint")}
            </div>
          </div>
        ) : null}

        {provider !== "copilot" && provider !== "sdf" ? (
          <div className="border-t border-themed pt-3 mt-3">
            <h4 className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-2">{t("dash.servedEndpointsLabel")}</h4>
            <p className="text-xs text-themed-dim mb-2">
              {t("dash.servedEndpointsHint")}
            </p>
            <div className="flex flex-wrap gap-3 text-xs">
              {SERVED_ENDPOINTS.map((ep) => (
                <label key={ep} className="flex items-center gap-1 cursor-pointer text-themed">
                  <input
                    type="checkbox"
                    checked={form.endpoints.includes(ep)}
                    onChange={() => toggleEndpoint(ep)}
                  />
                  <span>{ep}</span>
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {provider === "custom" ? (
          <div className="border-t border-themed pt-3 mt-3">
            <h4 className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-2">
              {t("dash.manualModelListLabel")}
            </h4>
            <p className="text-xs text-themed-dim mb-2">
              {t("dash.manualModelListHint")}
            </p>
            <textarea
              value={form.modelsText}
              onChange={(e) => update("modelsText", e.target.value)}
              rows={4}
              placeholder={"deepseek-chat\ndeepseek-coder # DeepSeek Coder"}
              className={`${inputCls} font-mono text-xs`}
            />
          </div>
        ) : null}

        {provider !== "copilot" && provider !== "sdf" && (
          <div className="border-t border-themed pt-3 mt-4">
            <h4 className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-2">
              {t("dash.disabledModelsLabel")}
            </h4>
            <p className="text-xs text-themed-dim mb-2">{t("dash.disabledModelsHint")}</p>
            {editing && catalog === null && !catalogError && (
              <p className="text-xs text-themed-dim">{t("dash.disabledModelsLoading")}</p>
            )}
            {catalogError && <p className="text-xs text-accent-red">{catalogError}</p>}
            {editing && catalog && (
              <select
                multiple
                size={Math.min(8, Math.max(3, catalog.length))}
                className="w-full text-sm font-mono"
                value={disabledIds}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions).map((o) => o.value)
                  const ids = new Set(catalog.map((m) => m.id))
                  const stale = disabledIds.filter((id) => !ids.has(id))
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
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                className="flex-1 text-sm"
                placeholder={t("dash.disabledModelsAddPlaceholder")}
                value={extraIdInput}
                onChange={(e) => setExtraIdInput(e.target.value)}
              />
              <button
                type="button"
                className="btn-ghost text-sm"
                onClick={() => {
                  const id = extraIdInput.trim()
                  if (!id) return
                  if (!disabledIds.includes(id)) setDisabledIds([...disabledIds, id])
                  setExtraIdInput("")
                }}
              >
                {t("dash.disabledModelsAdd")}
              </button>
            </div>
            {disabledIds.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1">
                {disabledIds.map((id) => (
                  <li
                    key={id}
                    className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded"
                    style={{ background: "var(--surface-700)" }}
                  >
                    <span className="font-mono">{id}</span>
                    <button
                      type="button"
                      className="text-themed-dim hover:text-accent-red"
                      onClick={() => setDisabledIds(disabledIds.filter((x) => x !== id))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {flagCatalog?.catalog?.length ? (
          <div className="border-t border-themed pt-3 mt-4">
            <h4 className="text-xs font-medium text-themed-dim uppercase tracking-widest mb-2">{t("dash.featureFlagsLabel")}</h4>
            <p className="text-xs text-themed-dim mb-3">{t("dash.featureFlagsHint")}</p>
            {groupFlags(flagCatalog.catalog).map((group) => (
              <div key={group.key} className="mb-4 last:mb-0">
                <div className="text-[11px] font-semibold text-themed-dim uppercase tracking-wider mb-2">
                  {t(group.labelKey)}
                </div>
                <div className="space-y-3">
                  {group.flags.map((flag) => {
                    const state = flagOverrideState(flag.id)
                    return (
                      <div key={flag.id} className="text-xs">
                        <div className="text-themed font-medium">{flag.label}</div>
                        <div className="text-themed-dim mb-1">{flag.description}</div>
                        <div className="flex gap-3">
                          <FlagRadio
                            checked={state === "inherit"}
                            onChange={() => setFlagOverride(flag.id, null)}
                            label={t("dash.inheritLabel", { val: isFlagDefault(flag.id) ? t("dash.onLabel") : t("dash.offLabel") })}
                            tone="dim"
                          />
                          <FlagRadio
                            checked={state === "on"}
                            onChange={() => setFlagOverride(flag.id, true)}
                            label={t("dash.flagOn")}
                            tone="teal"
                          />
                          <FlagRadio
                            checked={state === "off"}
                            onChange={() => setFlagOverride(flag.id, false)}
                            label={t("dash.flagOff")}
                            tone="red"
                          />
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="flex justify-end gap-2 mt-4 pt-3" style={{ borderTop: "1px solid var(--border-color)" }}>
        <button onClick={onClose} className="btn-ghost text-sm">
          {t("dash.cancel")}
        </button>
        <button onClick={submit} disabled={saving} className="btn-primary text-sm">
          {editing ? t("dash.save") : t("dash.createBtnLong")}
        </button>
      </div>
    </div>
  )
}

const inputCls = "w-full mt-1 text-sm"

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-themed-dim">{label}</span>
      {children}
    </label>
  )
}

function FlagRadio({
  checked,
  onChange,
  label,
  tone,
}: {
  checked: boolean
  onChange: () => void
  label: string
  tone: "dim" | "teal" | "red"
}) {
  const color = tone === "teal" ? "text-emerald-400" : tone === "red" ? "text-accent-red" : "text-themed-dim"
  return (
    <label className="flex items-center gap-1 cursor-pointer">
      <input type="radio" checked={checked} onChange={onChange} />
      <span className={color}>{label}</span>
    </label>
  )
}

interface FlagGroup {
  key: string
  labelKey: string
  flags: api.FlagCatalog["catalog"]
}

function groupFlags(catalog: api.FlagCatalog["catalog"]): FlagGroup[] {
  const vendor: typeof catalog = []
  const transform: typeof catalog = []
  const behavior: typeof catalog = []
  for (const f of catalog) {
    if (f.id.startsWith("vendor-")) vendor.push(f)
    else if (f.id.startsWith("transform-")) transform.push(f)
    else behavior.push(f)
  }
  const groups: FlagGroup[] = []
  if (vendor.length) groups.push({ key: "vendor", labelKey: "dash.flagGroupVendor", flags: vendor })
  if (behavior.length) groups.push({ key: "behavior", labelKey: "dash.flagGroupBehavior", flags: behavior })
  if (transform.length) groups.push({ key: "transform", labelKey: "dash.flagGroupTransform", flags: transform })
  return groups
}
