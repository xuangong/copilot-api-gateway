import type { ApiKeyModelMapping } from "../../api/keys";
import {
  validateModelMappings,
  type MappingValidationCode,
} from "./model-mappings-state";

export type MappingField = "source" | "destination";

export interface ModelMappingsDraftRow extends ApiKeyModelMapping {
  rowId: string;
  touched: Record<MappingField, boolean>;
}

export interface ModelMappingsDraft {
  enabled: boolean;
  rows: ModelMappingsDraftRow[];
  saveAttempted: boolean;
}

export type ModelMappingsServer = {
  model_mappings_enabled: boolean;
  model_mappings: ApiKeyModelMapping[];
};

let nextRowId = 0;

function createRow(mapping: ApiKeyModelMapping): ModelMappingsDraftRow {
  nextRowId += 1;
  return {
    ...mapping,
    rowId: `model-mapping-${nextRowId}`,
    touched: { source: false, destination: false },
  };
}

export function createModelMappingsDraft(
  server: ModelMappingsServer,
): ModelMappingsDraft {
  return {
    enabled: server.model_mappings_enabled,
    rows: server.model_mappings.map(createRow),
    saveAttempted: false,
  };
}

export function resetModelMappingsDraft(
  _draft: ModelMappingsDraft,
  server: ModelMappingsServer,
): ModelMappingsDraft {
  return createModelMappingsDraft(server);
}

export function touchDraftMapping(
  draft: ModelMappingsDraft,
  index: number,
  field: MappingField,
): ModelMappingsDraft {
  return {
    ...draft,
    rows: draft.rows.map((row, rowIndex) =>
      rowIndex === index
        ? { ...row, touched: { ...row.touched, [field]: true } }
        : row,
    ),
  };
}

export function updateDraftMapping(
  draft: ModelMappingsDraft,
  index: number,
  field: MappingField,
  value: string,
): ModelMappingsDraft {
  return {
    ...draft,
    rows: draft.rows.map((row, rowIndex) =>
      rowIndex === index
        ? { ...row, [field]: value, touched: { ...row.touched, [field]: true } }
        : row,
    ),
  };
}

export function addDraftMapping(draft: ModelMappingsDraft): ModelMappingsDraft {
  return {
    ...draft,
    rows: [...draft.rows, createRow({ source: "", destination: "" })],
  };
}

export function deleteDraftMapping(
  draft: ModelMappingsDraft,
  index: number,
): ModelMappingsDraft {
  if (index < 0 || index >= draft.rows.length) return draft;
  return {
    ...draft,
    rows: draft.rows.filter((_, rowIndex) => rowIndex !== index),
  };
}

export function moveDraftMapping(
  draft: ModelMappingsDraft,
  index: number,
  delta: number,
): ModelMappingsDraft {
  const target = index + delta;
  if (
    index < 0 ||
    target < 0 ||
    index >= draft.rows.length ||
    target >= draft.rows.length
  )
    return draft;
  const rows = [...draft.rows];
  const current = rows[index];
  const replacement = rows[target];
  if (!current || !replacement) return draft;
  rows[index] = replacement;
  rows[target] = current;
  return { ...draft, rows };
}

export function setDraftSaveAttempted(
  draft: ModelMappingsDraft,
): ModelMappingsDraft {
  return { ...draft, saveAttempted: true };
}

export function getVisibleFieldErrors(
  draft: ModelMappingsDraft,
  rowId: string,
  field: MappingField,
  availableDestinations: ReadonlySet<string>,
  catalogLoading = false,
): MappingValidationCode[] {
  const index = draft.rows.findIndex((row) => row.rowId === rowId);
  const row = draft.rows[index];
  const destination = row?.destination.trim() ?? "";
  const hasUnavailableDestination =
    !catalogLoading &&
    field === "destination" &&
    destination.length > 0 &&
    !availableDestinations.has(destination);
  if (
    !row ||
    (!hasUnavailableDestination && !draft.saveAttempted && !row.touched[field])
  )
    return [];
  return validateModelMappings(draft.rows, availableDestinations)
    .filter(
      (error) =>
        error.index === index &&
        error.field === field &&
        !(catalogLoading && error.code === "unavailable"),
    )
    .map((error) => error.code);
}
