import { useEffect, useMemo, useState } from "react";
import type { ApiKeyDetail, ApiKeyModelMapping } from "../../api/keys";
import { Combobox } from "../../components/Combobox";
import { useT } from "../../state/i18n";
import type { ModelCatalog } from "../../state/models";
import {
  buildDestinationChoices,
  isModelMappingsDirty,
  normalizeModelMappings,
  validateModelMappings,
  type MappingValidationError,
} from "./model-mappings-state";
import {
  addDraftMapping,
  createModelMappingsDraft,
  deleteDraftMapping,
  getVisibleFieldErrors,
  moveDraftMapping,
  resetModelMappingsDraft,
  setDraftSaveAttempted,
  updateDraftMapping,
  type MappingField,
  type ModelMappingsDraft,
} from "./model-mappings-draft";

interface Props {
  keyRow: ApiKeyDetail;
  canEdit: boolean;
  busy: boolean;
  catalog: ModelCatalog;
  catalogLoading: boolean;
  onSave: (body: {
    model_mappings_enabled: boolean;
    model_mappings: ApiKeyModelMapping[];
  }) => Promise<boolean>;
}

function errorText(
  error: MappingValidationError,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (error.code === "blank") return t("dash.modelMappingBlank");
  if (error.code === "too_long") return t("dash.modelMappingTooLong");
  if (error.code === "unavailable") return t("dash.modelMappingUnavailable");
  return t("dash.modelMappingTooMany");
}

export function ModelMappingsPanel({
  keyRow,
  canEdit,
  busy,
  catalog,
  catalogLoading,
  onSave,
}: Props) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ModelMappingsDraft>(() =>
    createModelMappingsDraft(keyRow),
  );

  useEffect(() => {
    setDraft((current) => resetModelMappingsDraft(current, keyRow));
    setEditing(false);
  }, [keyRow]);

  const choices = useMemo(
    () =>
      buildDestinationChoices(
        catalog.mappingDestinations,
        draft.rows.map((mapping) => mapping.destination).filter(Boolean),
      ),
    [catalog.mappingDestinations, draft.rows],
  );
  const availableDestinations = useMemo(
    () =>
      new Set(catalog.mappingDestinations.map((destination) => destination.id)),
    [catalog.mappingDestinations],
  );
  const errors = useMemo(
    () => validateModelMappings(draft.rows, availableDestinations),
    [draft.rows, availableDestinations],
  );
  const dirty = isModelMappingsDirty(
    { enabled: draft.enabled, mappings: draft.rows },
    keyRow,
  );

  const startEdit = (enabled = keyRow.model_mappings_enabled) => {
    setDraft({ ...createModelMappingsDraft(keyRow), enabled });
    setEditing(true);
  };
  const toggleEnabled = (enabled: boolean) => {
    if (editing) setDraft((current) => ({ ...current, enabled }));
    else startEdit(enabled);
  };
  const cancel = () => {
    setDraft((current) => resetModelMappingsDraft(current, keyRow));
    setEditing(false);
  };
  const updateRow = (index: number, field: MappingField, value: string) => {
    setDraft((current) => updateDraftMapping(current, index, field, value));
  };
  const save = async () => {
    if (!dirty || busy || saving) return;
    if (errors.length > 0) {
      setDraft((current) => setDraftSaveAttempted(current));
      return;
    }
    setSaving(true);
    try {
      const ok = await onSave({
        model_mappings_enabled: draft.enabled,
        model_mappings: normalizeModelMappings(draft.rows),
      });
      if (ok) setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  const interactionDisabled = busy || saving;

  const status = keyRow.model_mappings_enabled
    ? t("dash.wsEnabledShort")
    : t("dash.wsDisabledShort");
  return (
    <div className="glass-card p-4 sm:p-6 mb-6 animate-in delay-1">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="min-w-0 flex items-center gap-3">
          <span className="text-xs font-medium text-themed-dim uppercase tracking-widest">
            {t("dash.modelMappingsLabel")}
          </span>
          <label className="flex items-center gap-1.5 text-[10px] text-themed-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={editing ? draft.enabled : keyRow.model_mappings_enabled}
              disabled={!canEdit || interactionDisabled}
              onChange={(event) => toggleEnabled(event.target.checked)}
              aria-label={t("dash.modelMappingsToggleAria")}
              className="accent-accent-violet disabled:cursor-not-allowed"
            />
            <span
              className={
                editing
                  ? draft.enabled
                    ? "text-accent-teal"
                    : "text-themed-dim"
                  : keyRow.model_mappings_enabled
                    ? "text-accent-teal"
                    : "text-themed-dim"
              }
            >
              {editing
                ? draft.enabled
                  ? t("dash.wsEnabledShort")
                  : t("dash.wsDisabledShort")
                : status}
            </span>
          </label>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!editing && canEdit ? (
            <button
              type="button"
              onClick={() => startEdit()}
              disabled={interactionDisabled}
              className="btn-ghost text-xs"
            >
              {t("dash.edit")}
            </button>
          ) : null}
          {editing ? (
            <>
              <button
                type="button"
                onClick={save}
                disabled={interactionDisabled || !dirty || catalogLoading}
                className="btn-primary text-xs py-1 px-3"
              >
                {interactionDisabled ? t("dash.savingShort") : t("dash.save")}
              </button>
              <button
                type="button"
                onClick={cancel}
                disabled={interactionDisabled}
                className="btn-ghost text-xs"
              >
                {t("dash.cancel")}
              </button>
            </>
          ) : null}
        </div>
      </div>

      {keyRow.model_mappings_invalid ? (
        <div className="rounded-md bg-accent-amber/10 text-accent-amber text-xs p-3 mb-4">
          {t("dash.modelMappingsInvalidWarning")}
        </div>
      ) : null}

      {editing ? (
        <div className="space-y-3">
          <p className="text-[10px] text-themed-dim">
            {t("dash.modelMappingsHint")}
          </p>
          {draft.rows.map((mapping, index) => {
            const sourceErrors = getVisibleFieldErrors(
              draft,
              mapping.rowId,
              "source",
              availableDestinations,
            );
            const destinationErrors = getVisibleFieldErrors(
              draft,
              mapping.rowId,
              "destination",
              availableDestinations,
            );
            const sourceErrorId = `model-mapping-source-error-${mapping.rowId}`;
            const destinationErrorId = `model-mapping-destination-error-${mapping.rowId}`;
            return (
              <div
                key={mapping.rowId}
                className="rounded-lg bg-surface-700/50 p-3 space-y-2"
              >
                <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 items-start">
                  <div>
                    <label
                      htmlFor={`model-mapping-source-${mapping.rowId}`}
                      className="text-[10px] text-themed-dim block mb-1"
                    >
                      {t("dash.modelMappingSource")}
                    </label>
                    <input
                      id={`model-mapping-source-${mapping.rowId}`}
                      type="text"
                      value={mapping.source}
                      disabled={interactionDisabled}
                      aria-invalid={sourceErrors.length > 0 || undefined}
                      aria-describedby={
                        sourceErrors.length > 0 ? sourceErrorId : undefined
                      }
                      onChange={(event) =>
                        updateRow(index, "source", event.target.value)
                      }
                      className="w-full text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-themed-dim block mb-1">
                      {t("dash.modelMappingDestination")}
                    </label>
                    <Combobox
                      value={mapping.destination}
                      disabled={interactionDisabled}
                      ariaLabel={t("dash.modelMappingDestinationAria", {
                        n: index + 1,
                      })}
                      ariaInvalid={destinationErrors.length > 0}
                      ariaDescribedBy={
                        destinationErrors.length > 0
                          ? destinationErrorId
                          : undefined
                      }
                      placeholder={t("dash.modelMappingPickDestination")}
                      noMatchesText={t("dash.modelMappingNoMatches")}
                      onChange={(value) =>
                        updateRow(index, "destination", value)
                      }
                      options={choices.map((choice) => ({
                        value: choice.id,
                        label: choice.id,
                        badge: choice.unavailable
                          ? t("dash.modelMappingUnavailableBadge")
                          : choice.upstreams.join(", ") ||
                            t("dash.modelMappingAvailable"),
                        keywords: choice.upstreams,
                        disabled: choice.unavailable,
                      }))}
                    />
                  </div>
                  <div className="flex sm:pt-5 gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((current) =>
                          moveDraftMapping(current, index, -1),
                        )
                      }
                      disabled={interactionDisabled || index === 0}
                      aria-label={t("dash.modelMappingMoveUp", {
                        n: index + 1,
                      })}
                      className="btn-ghost text-xs px-2 disabled:opacity-30"
                    >
                      ▲
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((current) =>
                          moveDraftMapping(current, index, 1),
                        )
                      }
                      disabled={
                        interactionDisabled || index === draft.rows.length - 1
                      }
                      aria-label={t("dash.modelMappingMoveDown", {
                        n: index + 1,
                      })}
                      className="btn-ghost text-xs px-2 disabled:opacity-30"
                    >
                      ▼
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setDraft((current) =>
                          deleteDraftMapping(current, index),
                        )
                      }
                      disabled={interactionDisabled}
                      aria-label={t("dash.modelMappingDelete", {
                        n: index + 1,
                      })}
                      className="btn-ghost text-xs px-2 text-accent-red"
                    >
                      ×
                    </button>
                  </div>
                </div>
                {sourceErrors.map((code) => (
                  <p
                    id={sourceErrorId}
                    key={code}
                    className="text-[10px] text-accent-red"
                  >
                    {errorText({ index, field: "source", code }, t)}
                  </p>
                ))}
                {destinationErrors.map((code) => (
                  <p
                    id={destinationErrorId}
                    key={code}
                    className="text-[10px] text-accent-red"
                  >
                    {errorText({ index, field: "destination", code }, t)}
                  </p>
                ))}
              </div>
            );
          })}
          {errors.find((error) => error.field === "mappings") ? (
            <p className="text-[10px] text-accent-red">
              {t("dash.modelMappingTooMany")}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setDraft((current) => addDraftMapping(current))}
            disabled={interactionDisabled || draft.rows.length >= 100}
            className="btn-ghost text-xs"
          >
            {t("dash.modelMappingAdd")}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {keyRow.model_mappings.length === 0 ? (
            <p className="text-xs text-themed-dim">
              {t("dash.modelMappingsEmpty")}
            </p>
          ) : (
            keyRow.model_mappings.map((mapping, index) => (
              <div
                key={`${mapping.source}-${index}`}
                className="flex items-center gap-2 text-xs font-mono min-w-0"
              >
                <span className="truncate text-themed-secondary">
                  {mapping.source}
                </span>
                <span className="text-themed-dim">→</span>
                <span className="truncate text-themed">
                  {mapping.destination}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
