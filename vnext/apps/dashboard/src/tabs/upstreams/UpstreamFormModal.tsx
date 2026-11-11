import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useT } from "../../state/i18n"
import { useToast } from "../../state/toast"
import { useAuth } from "../../state/auth"
import * as api from "../../api/upstreams"
import { findPreset } from "./vendorPresets"
import { CatalogRequestGate, catalogDraftIdentity } from "./catalog-request-gate"
import { CodexImportPanel } from "./CodexImportPanel"
import { buildCreateConfig, buildEditConfig, buildInitial } from "./upstream-form-state"
import type { FormState, Provider, UpstreamFormMode } from "./upstream-form-state"
import { Field, FormHeading } from "./form/Field"
import { CustomFields, CustomModelFields } from "./form/CustomFields"
import { AzureFields } from "./form/AzureFields"
import { SdfFields } from "./form/SdfFields"
import { ServedEndpointsField } from "./form/ServedEndpointsField"
import { DisabledModelsSection } from "./form/DisabledModelsSection"
import { FeatureFlagsSection } from "./form/FeatureFlagsSection"
import { X } from "lucide-react"
import { Button } from "../../ui/button"
import { Notice } from "../../ui/notice"

interface Props {
  mode: UpstreamFormMode
  flagCatalog: api.FlagCatalog | null
  ensureFlagCatalog: () => Promise<api.FlagCatalog>
  onClose: () => void
  onSaved: () => void
}

export function UpstreamFormModal({ mode, flagCatalog, ensureFlagCatalog, onClose, onSaved }: Props) {
  const { push: toast } = useToast()
  const t = useT()
  const { session } = useAuth()
  const initial = useMemo(() => buildInitial(mode), [mode])
  const [provider] = useState<Provider>(initial.provider)
  const [form, setForm] = useState<FormState>(initial.form)
  const [saving, setSaving] = useState(false)
  const editing = mode.kind === "edit"
  const editingId = editing ? mode.row.id : null
  const preset = mode.kind === "create" ? findPreset(mode.presetId) : undefined

  const [catalog, setCatalog] = useState<{ id: string; name: string }[] | null>(null)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogRefreshing, setCatalogRefreshing] = useState(false)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const catalogGate = useRef(new CatalogRequestGate())
  const modeRef = useRef(mode)
  const catalogIdRef = useRef(editingId)
  const catalogDraftRef = useRef(catalogDraftIdentity(form))
  modeRef.current = mode
  catalogIdRef.current = editingId
  catalogDraftRef.current = catalogDraftIdentity(form)
  const catalogDraftChanged = catalogDraftRef.current !== catalogDraftIdentity(initial.form)
  const [disabledIds, setDisabledIds] = useState<string[]>(
    mode.kind === "edit" ? [...(mode.row.disabledPublicModelIds ?? [])] : [...(mode.draft?.disabledPublicModelIds ?? [])],
  )

  useEffect(() => {
    ensureFlagCatalog().catch((e) => toast(e instanceof Error ? e.message : String(e), "error"))
  }, [ensureFlagCatalog, toast])

  useEffect(() => {
    if (mode.kind === "create" && mode.draft) headingRef.current?.focus()
  }, [mode])

  useEffect(() => {
    const nextMode = modeRef.current
    setForm(buildInitial(nextMode).form)
    setDisabledIds(nextMode.kind === "edit" ? [...(nextMode.row.disabledPublicModelIds ?? [])] : [...(nextMode.draft?.disabledPublicModelIds ?? [])])
    setCatalog(null)
    setCatalogError(null)
    catalogGate.current.invalidate()
  }, [editingId])

  const loadCatalog = useCallback(async (id: string, refresh: boolean) => {
    const draft = catalogDraftRef.current
    const ticket = catalogGate.current.begin(id, draft)
    if (refresh) setCatalogRefreshing(true)
    else setCatalogLoading(true)
    try {
      const response = await api.getUpstreamCatalog(id, refresh)
      if (!catalogGate.current.accepts(ticket, catalogIdRef.current ?? '', catalogDraftRef.current)) return
      setCatalog(response.models)
      setCatalogError(null)
    } catch (error) {
      if (!catalogGate.current.accepts(ticket, catalogIdRef.current ?? '', catalogDraftRef.current)) return
      setCatalogError(error instanceof Error ? error.message : String(error))
    } finally {
      if (catalogGate.current.accepts(ticket, catalogIdRef.current ?? '', catalogDraftRef.current)) {
        setCatalogLoading(false)
        setCatalogRefreshing(false)
      }
    }
  }, [])

  useEffect(() => {
    const gate = catalogGate.current
    gate.invalidate()
    setCatalogLoading(false)
    setCatalogRefreshing(false)
    if (!editingId || catalogDraftChanged) return
    void loadCatalog(editingId, false)
    return () => { gate.invalidate() }
  }, [editingId, catalogDraftChanged, loadCatalog])

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }))

  const toggleEndpoint = (ep: string) =>
    setForm((f) => ({
      ...f,
      endpoints: f.endpoints.includes(ep) ? f.endpoints.filter((x) => x !== ep) : [...f.endpoints, ep],
    }))

  const setPathOverride = (key: string, value: string) =>
    setForm((f) => {
      const next = { ...f.pathOverrides }
      if (value.trim()) next[key] = value
      else delete next[key]
      return { ...f, pathOverrides: next }
    })

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
      if (provider === "copilot" || provider === "codex" || provider === "claude-code" || provider === "loki") {
        if (!editingId) {
          toast(t("dash.errAddCopilotViaDeviceFlow"), "error")
          return
        }
        await api.patchUpstream(editingId, { name: form.name.trim(), flagOverrides: form.flagOverrides, disabledPublicModelIds: disabledIds })
        toast(t("dash.toastUpdated"), "success")
        onSaved()
        return
      }
      if (provider === "azure" && !validateAzureDeployments()) return

      let config: Record<string, unknown>
      if (!editingId) {
        const built = buildCreateConfig(provider, form)
        if ("errorKey" in built) {
          toast(t(built.errorKey), "error")
          return
        }
        config = built.config
        await api.createUpstream({
          provider,
          name: form.name.trim(),
          config,
          flagOverrides: form.flagOverrides,
          disabledPublicModelIds: disabledIds,
          proxyFallbackList: mode.kind === "create" ? mode.draft?.proxyFallbackList : undefined,
          // Default new upstreams to the current user so admins don't
          // accidentally create read-only "global" rows. Backend also
          // defends against missing ownerId.
          ownerId: session?.userId != null ? String(session.userId) : undefined,
        })
        toast(t("dash.toastCreated"), "success")
      } else {
        config = buildEditConfig(provider, form)
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
      {editing ? t("dash.editUpstream") : mode.kind === "create" && mode.draft ? t("dash.duplicateUpstream") : t("dash.addUpstream")} <span className="capitalize">{provider}</span> {t("dash.upstreamSuffix")}
    </span>
  )

  return (
    <div className="mt-2 rounded-lg border border-border bg-panel p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <FormHeading ref={headingRef} className="text-sm font-semibold text-fg" tabIndex={mode.kind === "create" && mode.draft ? -1 : undefined}>{title}</FormHeading>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("dash.closeBtn")}>
          <X aria-hidden="true" />
        </Button>
      </div>
      <div className="space-y-3">
        {mode.kind === "create" && mode.draft ? (
          <Notice tone="info" className="text-xs">{t("dash.duplicateCredentialsHint")}</Notice>
        ) : null}
        {preset?.noteKey ? (
          <Notice tone="info" className="text-xs text-fg">{t(preset.noteKey)}</Notice>
        ) : null}
        <Field label={t("dash.nameLabel")}>
          {({ id }) => (
            <input
              id={id}
              type="text"
              value={form.name}
              onChange={(e) => update("name", e.target.value)}
              placeholder={t("dash.namePlaceholderUpstream")}
            />
          )}
        </Field>

        {provider === "custom" ? (
          <CustomFields form={form} update={update} editing={editing} />
        ) : null}

        {provider === "azure" ? (
          <AzureFields form={form} update={update} editing={editing} validateAzureDeployments={validateAzureDeployments} />
        ) : null}

        {provider === "sdf" ? (
          <SdfFields form={form} update={update} editing={editing} />
        ) : null}

        {provider === "copilot" ? (
          <div className="space-y-1 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <div className="text-fg-muted">{t("dash.githubLoginLabel")}</div>
            <div className="font-mono text-fg">{form.copilotLogin || "(unknown)"}</div>
            <div className="mt-2 text-fg-muted">
              {t("dash.copilotTokenHint")}
            </div>
          </div>
        ) : null}

        {provider === "codex" ? (
          <CodexImportPanel
            targetId={editingId}
            name={form.name}
            ownerId={session?.userId != null ? String(session.userId) : undefined}
            flagOverrides={form.flagOverrides}
            disabledPublicModelIds={disabledIds}
            onImported={onSaved}
          />
        ) : null}

        {(provider === "custom" || provider === "azure") ? (
          <ServedEndpointsField provider={provider} form={form} toggleEndpoint={toggleEndpoint} />
        ) : null}

        {provider === "custom" ? (
          <CustomModelFields form={form} update={update} setPathOverride={setPathOverride} />
        ) : null}

        {(provider === "custom" || provider === "azure") && (
          <DisabledModelsSection
            editing={editing}
            catalog={catalog}
            catalogError={catalogError}
            catalogLoading={catalogLoading}
            catalogRefreshing={catalogRefreshing}
            catalogDraftChanged={catalogDraftChanged}
            onRefresh={() => { if (editingId) void loadCatalog(editingId, true) }}
            disabledIds={disabledIds}
            setDisabledIds={setDisabledIds}
          />
        )}

        {flagCatalog?.catalog?.length ? (
          <FeatureFlagsSection
            catalog={flagCatalog.catalog}
            flagOverrideState={flagOverrideState}
            setFlagOverride={setFlagOverride}
            isFlagDefault={isFlagDefault}
          />
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2 border-t border-border pt-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("dash.cancel")}
        </Button>
        {(provider !== "codex" || editing) ? (
          <Button variant="primary" size="sm" onClick={submit} disabled={saving}>
            {editing ? t("dash.save") : t("dash.createBtnLong")}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
