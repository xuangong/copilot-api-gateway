import { useEffect, useMemo, useState } from "react"
import type { ApiKeyDetail, ApiKeyModelMapping } from "../../api/keys"
import { Select } from "../../components/Select"
import { useT } from "../../state/i18n"
import { useModelCatalog } from "../../state/models"
import {
  addMapping,
  buildDestinationChoices,
  deleteMapping,
  initialModelMappingsState,
  isModelMappingsDirty,
  moveMapping,
  setModelMappingsEnabled,
  validateModelMappings,
  type MappingValidationError,
  type ModelMappingsState,
} from "./model-mappings-state"

interface Props {
  keyRow: ApiKeyDetail
  canEdit: boolean
  busy: boolean
  onSave: (body: { model_mappings_enabled: boolean; model_mappings: ApiKeyModelMapping[] }) => Promise<boolean>
}

function errorText(error: MappingValidationError, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (error.code === "blank") return t("dash.modelMappingBlank")
  if (error.code === "too_long") return t("dash.modelMappingTooLong")
  if (error.code === "unavailable") return t("dash.modelMappingUnavailable")
  return t("dash.modelMappingTooMany")
}

export function ModelMappingsPanel({ keyRow, canEdit, busy, onSave }: Props) {
  const t = useT()
  const [editing, setEditing] = useState(false)
  const [state, setState] = useState<ModelMappingsState>(() => initialModelMappingsState(keyRow))
  const { catalog, loading } = useModelCatalog(keyRow.id)

  useEffect(() => {
    setState(initialModelMappingsState(keyRow))
    setEditing(false)
  }, [keyRow])

  const choices = useMemo(
    () => buildDestinationChoices(catalog.mappingDestinations, state.mappings.map((mapping) => mapping.destination).filter(Boolean)),
    [catalog.mappingDestinations, state.mappings],
  )
  const availableDestinations = useMemo(
    () => new Set(catalog.mappingDestinations.map((destination) => destination.id)),
    [catalog.mappingDestinations],
  )
  const errors = useMemo(
    () => validateModelMappings(state.mappings, availableDestinations),
    [state.mappings, availableDestinations],
  )
  const errorsByRow = useMemo(() => {
    const indexed = new Map<number, MappingValidationError[]>()
    for (const error of errors) indexed.set(error.index, [...(indexed.get(error.index) ?? []), error])
    return indexed
  }, [errors])
  const dirty = isModelMappingsDirty(state, keyRow)

  const startEdit = (enabled = keyRow.model_mappings_enabled) => {
    setState(setModelMappingsEnabled(initialModelMappingsState(keyRow), enabled))
    setEditing(true)
  }
  const toggleEnabled = (enabled: boolean) => {
    if (editing) setState((current) => setModelMappingsEnabled(current, enabled))
    else startEdit(enabled)
  }
  const cancel = () => {
    setState(initialModelMappingsState(keyRow))
    setEditing(false)
  }
  const updateRow = (index: number, field: keyof ApiKeyModelMapping, value: string) => {
    setState((current) => ({
      ...current,
      mappings: current.mappings.map((mapping, rowIndex) => rowIndex === index ? { ...mapping, [field]: value } : mapping),
    }))
  }
  const save = async () => {
    if (!dirty || errors.length > 0 || busy) return
    const ok = await onSave({ model_mappings_enabled: state.enabled, model_mappings: state.mappings })
    if (ok) setEditing(false)
  }

  const status = keyRow.model_mappings_enabled ? t("dash.wsEnabledShort") : t("dash.wsDisabledShort")
  return (
    <div className="glass-card p-4 sm:p-6 mb-6 animate-in delay-1">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0 flex items-center gap-3">
          <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">{t("dash.modelMappingsLabel")}</span>
          <label className="flex items-center gap-1.5 text-[10px] text-themed-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={editing ? state.enabled : keyRow.model_mappings_enabled}
              disabled={!canEdit || busy}
              onChange={(event) => toggleEnabled(event.target.checked)}
              aria-label={t("dash.modelMappingsToggleAria")}
              className="accent-accent-violet disabled:cursor-not-allowed"
            />
            <span className={editing ? (state.enabled ? "text-accent-teal" : "text-themed-dim") : (keyRow.model_mappings_enabled ? "text-accent-teal" : "text-themed-dim")}>{editing ? (state.enabled ? t("dash.wsEnabledShort") : t("dash.wsDisabledShort")) : status}</span>
          </label>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!editing && canEdit ? <button type="button" onClick={() => startEdit()} className="btn-ghost text-xs">{t("dash.edit")}</button> : null}
          {editing ? <>
            <button type="button" onClick={save} disabled={busy || !dirty || errors.length > 0 || loading} className="btn-primary text-xs py-1 px-3">{busy ? t("dash.savingShort") : t("dash.save")}</button>
            <button type="button" onClick={cancel} disabled={busy} className="btn-ghost text-xs">{t("dash.cancel")}</button>
          </> : null}
        </div>
      </div>

      {keyRow.model_mappings_invalid ? <div className="rounded-md bg-accent-amber/10 text-accent-amber text-xs p-3 mb-4">{t("dash.modelMappingsInvalidWarning")}</div> : null}

      {editing ? <div className="space-y-3">
        <p className="text-[10px] text-themed-dim">{t("dash.modelMappingsHint")}</p>
        {state.mappings.map((mapping, index) => {
          const rowErrors = errorsByRow.get(index) ?? []
          const destination = choices.find((choice) => choice.id === mapping.destination)
          return <div key={index} className="rounded-lg bg-surface-700/50 p-3 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-start">
              <div>
                <label className="text-[10px] text-themed-dim block mb-1">{t("dash.modelMappingSource")}</label>
                <input type="text" value={mapping.source} onChange={(event) => updateRow(index, "source", event.target.value)} className="w-full text-xs font-mono" aria-label={t("dash.modelMappingSourceAria", { n: index + 1 })} />
              </div>
              <div>
                <label className="text-[10px] text-themed-dim block mb-1">{t("dash.modelMappingDestination")}</label>
                <Select value={mapping.destination} onChange={(value) => updateRow(index, "destination", value)} options={[
                  { value: "", label: t("dash.modelMappingPickDestination") },
                  ...choices.map((choice) => ({ value: choice.id, label: choice.id, badge: choice.unavailable ? t("dash.modelMappingUnavailableBadge") : choice.upstreams.join(", ") || t("dash.modelMappingAvailable") })),
                ]} />
                {destination?.unavailable ? <p className="text-[10px] text-accent-red mt-1">{t("dash.modelMappingUnavailable")}</p> : null}
              </div>
              <div className="flex sm:pt-5 gap-1">
                <button type="button" onClick={() => setState((current) => ({ ...current, mappings: moveMapping(current.mappings, index, -1) }))} disabled={index === 0} aria-label={t("dash.modelMappingMoveUp", { n: index + 1 })} className="btn-ghost text-xs px-2 disabled:opacity-30">▲</button>
                <button type="button" onClick={() => setState((current) => ({ ...current, mappings: moveMapping(current.mappings, index, 1) }))} disabled={index === state.mappings.length - 1} aria-label={t("dash.modelMappingMoveDown", { n: index + 1 })} className="btn-ghost text-xs px-2 disabled:opacity-30">▼</button>
                <button type="button" onClick={() => setState((current) => ({ ...current, mappings: deleteMapping(current.mappings, index) }))} aria-label={t("dash.modelMappingDelete", { n: index + 1 })} className="btn-ghost text-xs px-2 text-accent-red">×</button>
              </div>
            </div>
            {rowErrors.map((error) => <p key={`${error.field}-${error.code}`} className="text-[10px] text-accent-red">{errorText(error, t)}</p>)}
          </div>
        })}
        {errors.find((error) => error.field === "mappings") ? <p className="text-[10px] text-accent-red">{t("dash.modelMappingTooMany")}</p> : null}
        <button type="button" onClick={() => setState((current) => ({ ...current, mappings: addMapping(current.mappings) }))} disabled={state.mappings.length >= 100} className="btn-ghost text-xs">{t("dash.modelMappingAdd")}</button>
      </div> : <div className="space-y-2">
        {keyRow.model_mappings.length === 0 ? <p className="text-xs text-themed-dim">{t("dash.modelMappingsEmpty")}</p> : keyRow.model_mappings.map((mapping, index) => <div key={`${mapping.source}-${index}`} className="flex items-center gap-2 text-xs font-mono min-w-0"><span className="truncate text-themed-secondary">{mapping.source}</span><span className="text-themed-dim">→</span><span className="truncate text-themed">{mapping.destination}</span></div>)}
      </div>}
    </div>
  )
}
