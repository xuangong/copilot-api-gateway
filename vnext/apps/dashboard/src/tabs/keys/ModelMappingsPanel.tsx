import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp, GripVertical, X } from "lucide-react";
import type { ApiKeyDetail, ApiKeyModelMapping } from "../../api/keys";
import { Combobox } from "../../components/Combobox";
import { useT } from "../../state/i18n";
import type { ModelCatalog } from "../../state/models";
import { Button } from "../../ui/button";
import { Card, SectionHeading } from "../../ui/card";
import { cn } from "../../ui/cn";
import { Notice } from "../../ui/notice";
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
  moveDraftMappingTo,
  resetDraftInteractions,
  resetModelMappingsDraft,
  setDraftSaveAttempted,
  touchDraftMapping,
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
  const panelId = useId();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<ModelMappingsDraft>(() =>
    createModelMappingsDraft(keyRow),
  );
  const dragSnapshot = useRef<ModelMappingsDraft | null>(null);
  const pointerRowId = useRef<string | null>(null);
  const [dragRowId, setDragRowId] = useState<string | null>(null);
  const [dropRowId, setDropRowId] = useState<string | null>(null);

  useEffect(() => {
    if (!dragRowId) return;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dragSnapshot.current) setDraft(dragSnapshot.current);
      dragSnapshot.current = null;
      pointerRowId.current = null;
      setDragRowId(null);
      setDropRowId(null);
    };
    document.addEventListener("keydown", onEscape);
    return () => document.removeEventListener("keydown", onEscape);
  }, [dragRowId]);

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
    () =>
      catalogLoading
        ? []
        : validateModelMappings(draft.rows, availableDestinations),
    [catalogLoading, draft.rows, availableDestinations],
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
    dragSnapshot.current = null;
    pointerRowId.current = null;
    setDragRowId(null);
    setDropRowId(null);
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
      if (ok) {
        setDraft((current) => resetDraftInteractions(current));
        setEditing(false);
      }
    } finally {
      setSaving(false);
    }
  };
  const interactionDisabled = busy || saving;
  const rowAtPointer = (event: ReactPointerEvent<HTMLButtonElement>): string | null =>
    document.elementFromPoint(event.clientX, event.clientY)
      ?.closest<HTMLElement>("[data-mapping-row-id]")
      ?.dataset.mappingRowId ?? null;
  const cancelPointerMove = () => {
    if (dragSnapshot.current) setDraft(dragSnapshot.current);
    dragSnapshot.current = null;
    pointerRowId.current = null;
    setDragRowId(null);
    setDropRowId(null);
  };

  const status = keyRow.model_mappings_enabled
    ? t("dash.wsEnabledShort")
    : t("dash.wsDisabledShort");
  return (
    <Card aria-labelledby={`${panelId}-title`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <SectionHeading id={`${panelId}-title`}>
            {t("dash.modelMappingsLabel")}
          </SectionHeading>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
            <input
              type="checkbox"
              checked={editing ? draft.enabled : keyRow.model_mappings_enabled}
              disabled={!canEdit || interactionDisabled}
              onChange={(event) => toggleEnabled(event.target.checked)}
              aria-label={t("dash.modelMappingsToggleAria")}
              className="accent-brand disabled:cursor-not-allowed"
            />
            <span
              className={
                editing
                  ? draft.enabled
                    ? "text-success"
                    : "text-fg-subtle"
                  : keyRow.model_mappings_enabled
                    ? "text-success"
                    : "text-fg-subtle"
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
        <div className="flex shrink-0 items-center gap-2">
          {!editing && canEdit ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => startEdit()}
              disabled={interactionDisabled}
            >
              {t("dash.edit")}
            </Button>
          ) : null}
          {editing ? (
            <>
              <Button
                variant="primary"
                size="sm"
                onClick={save}
                disabled={interactionDisabled || !dirty || catalogLoading}
              >
                {interactionDisabled ? t("dash.savingShort") : t("dash.save")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={cancel}
                disabled={interactionDisabled}
              >
                {t("dash.cancel")}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {keyRow.model_mappings_invalid ? (
        <Notice tone="warn" className="mb-4">
          {t("dash.modelMappingsInvalidWarning")}
        </Notice>
      ) : null}

      {editing ? (
        <div className="space-y-3">
          <p className="text-xs text-fg-subtle">
            {t("dash.modelMappingsHint")}
          </p>
          {draft.rows.map((mapping, index) => {
            const sourceErrors = getVisibleFieldErrors(
              draft,
              mapping.rowId,
              "source",
              availableDestinations,
              catalogLoading,
            );
            const destinationErrors = getVisibleFieldErrors(
              draft,
              mapping.rowId,
              "destination",
              availableDestinations,
              catalogLoading,
            );
            const sourceErrorId = `model-mapping-source-error-${mapping.rowId}`;
            const destinationErrorId = `model-mapping-destination-error-${mapping.rowId}`;
            return (
              <div
                key={mapping.rowId}
                data-mapping-row-id={mapping.rowId}
                className={cn(
                  "space-y-2 rounded-lg border border-border bg-panel p-3",
                  dragRowId === mapping.rowId && "opacity-50",
                  dropRowId === mapping.rowId && "ring-2 ring-brand-text",
                )}
              >
                <div className="grid grid-cols-1 items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                  <div>
                    <label
                      htmlFor={`model-mapping-source-${mapping.rowId}`}
                      className="mb-1 block text-xs font-medium text-fg-muted"
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
                      onBlur={() =>
                        setDraft((current) =>
                          touchDraftMapping(current, index, "source"),
                        )
                      }
                    />
                    {sourceErrors.map((code) => (
                      <p
                        id={sourceErrorId}
                        key={code}
                        className="mt-1 text-xs text-danger"
                      >
                        {errorText({ index, field: "source", code }, t)}
                      </p>
                    ))}
                  </div>
                  <div>
                    <span
                      className="mb-1 block text-xs font-medium text-fg-muted"
                    >
                      {t("dash.modelMappingDestination")}
                    </span>
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
                      placeholder={t("dash.modelMappingSearchDestination")}
                      noMatchesText={t("dash.modelMappingNoMatches")}
                      onBlur={() =>
                        setDraft((current) =>
                          touchDraftMapping(current, index, "destination"),
                        )
                      }
                      onChange={(value) =>
                        updateRow(index, "destination", value)
                      }
                      options={choices.map((choice) => ({
                        value: choice.id,
                        label: choice.id,
                        badge:
                          !catalogLoading && choice.unavailable
                            ? t("dash.modelMappingUnavailableBadge")
                            : choice.upstreams.join(", ") ||
                              t("dash.modelMappingAvailable"),
                        keywords: choice.upstreams,
                        disabled: !catalogLoading && choice.unavailable,
                      }))}
                    />
                    {destinationErrors.map((code) => (
                      <p
                        id={destinationErrorId}
                        key={code}
                        className="mt-1 text-xs text-danger"
                      >
                        {errorText({ index, field: "destination", code }, t)}
                      </p>
                    ))}
                  </div>
                  <div className="flex gap-1 sm:pt-5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={interactionDisabled}
                      onPointerDown={(event) => {
                        if (event.button !== 0) return;
                        dragSnapshot.current = draft;
                        pointerRowId.current = mapping.rowId;
                        setDragRowId(mapping.rowId);
                        setDropRowId(null);
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                      onPointerMove={(event) => {
                        if (!dragSnapshot.current || !pointerRowId.current) return;
                        setDropRowId(rowAtPointer(event));
                      }}
                      onPointerUp={(event) => {
                        const snapshot = dragSnapshot.current;
                        const sourceId = pointerRowId.current;
                        const targetId = rowAtPointer(event);
                        if (snapshot && sourceId && targetId) {
                          setDraft(moveDraftMappingTo(snapshot, sourceId, targetId));
                          dragSnapshot.current = null;
                          pointerRowId.current = null;
                          setDragRowId(null);
                          setDropRowId(null);
                        } else cancelPointerMove();
                      }}
                      onPointerCancel={cancelPointerMove}
                      onLostPointerCapture={cancelPointerMove}
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                        event.preventDefault();
                        setDraft((current) => moveDraftMapping(current, index, event.key === "ArrowUp" ? -1 : 1));
                      }}
                      aria-label={t("dash.reorderMappingHandle", { n: index + 1 })}
                      title={t("dash.reorderMappingHandle", { n: index + 1 })}
                      className="cursor-grab touch-none active:cursor-grabbing"
                    >
                      <GripVertical aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        setDraft((current) =>
                          moveDraftMapping(current, index, -1),
                        )
                      }
                      disabled={interactionDisabled || index === 0}
                      aria-label={t("dash.modelMappingMoveUp", {
                        n: index + 1,
                      })}
                    >
                      <ChevronUp aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
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
                    >
                      <ChevronDown aria-hidden="true" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        setDraft((current) =>
                          deleteDraftMapping(current, index),
                        )
                      }
                      disabled={interactionDisabled}
                      aria-label={t("dash.modelMappingDelete", {
                        n: index + 1,
                      })}
                      className="text-danger hover:text-danger"
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
          {errors.find((error) => error.field === "mappings") ? (
            <p className="text-xs text-danger">
              {t("dash.modelMappingTooMany")}
            </p>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setDraft((current) => addDraftMapping(current))}
            disabled={interactionDisabled || draft.rows.length >= 100}
          >
            {t("dash.modelMappingAdd")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {keyRow.model_mappings.length === 0 ? (
            <p className="text-xs text-fg-subtle">
              {t("dash.modelMappingsEmpty")}
            </p>
          ) : (
            keyRow.model_mappings.map((mapping, index) => (
              <div
                key={`${mapping.source}-${index}`}
                className="flex min-w-0 items-center gap-2 font-mono text-xs"
              >
                <span className="truncate text-fg-muted">
                  {mapping.source}
                </span>
                <span className="text-fg-subtle">→</span>
                <span className="truncate text-fg">
                  {mapping.destination}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  );
}
