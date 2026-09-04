import { describe, expect, test } from "bun:test";
import {
  addDraftMapping,
  createModelMappingsDraft,
  deleteDraftMapping,
  getVisibleFieldErrors,
  moveDraftMapping,
  resetModelMappingsDraft,
  setDraftSaveAttempted,
  updateDraftMapping,
} from "./model-mappings-draft";

const server = {
  model_mappings_enabled: true,
  model_mappings: [
    { source: "friendly-opus", destination: "claude-opus" },
    { source: "fast", destination: "gpt-5" },
  ],
};
const available = new Set(["claude-opus", "gpt-5"]);

describe("model mappings draft", () => {
  test("does not show errors for a newly added untouched row", () => {
    const draft = addDraftMapping(createModelMappingsDraft(server));
    const newRow = draft.rows.at(-1);
    expect(newRow).toBeDefined();
    if (!newRow) throw new Error("test setup requires new draft row");
    expect(
      getVisibleFieldErrors(draft, newRow.rowId, "source", available),
    ).toEqual([]);
    expect(
      getVisibleFieldErrors(draft, newRow.rowId, "destination", available),
    ).toEqual([]);
  });

  test("shows an unavailable saved destination immediately and only once", () => {
    const draft = createModelMappingsDraft({
      model_mappings_enabled: true,
      model_mappings: [{ source: "alias", destination: "retired-model" }],
    });
    const row = draft.rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("test setup requires an initial draft row");
    expect(
      getVisibleFieldErrors(draft, row.rowId, "destination", available),
    ).toEqual(["unavailable"]);
  });

  test("shows only a touched field's local error", () => {
    const draft = updateDraftMapping(
      createModelMappingsDraft(server),
      0,
      "source",
      " ",
    );
    const row = draft.rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("test setup requires an initial draft row");
    expect(
      getVisibleFieldErrors(draft, row.rowId, "source", available),
    ).toEqual(["blank"]);
    expect(
      getVisibleFieldErrors(draft, row.rowId, "destination", available),
    ).toEqual([]);
  });

  test("reveals a destination error once after save is attempted", () => {
    const initial = updateDraftMapping(
      createModelMappingsDraft(server),
      0,
      "destination",
      "missing",
    );
    const row = initial.rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("test setup requires an initial draft row");
    expect(
      getVisibleFieldErrors(initial, row.rowId, "destination", available),
    ).toEqual(["unavailable"]);
    const afterSave = setDraftSaveAttempted(initial);
    expect(
      getVisibleFieldErrors(afterSave, row.rowId, "destination", available),
    ).toEqual(["unavailable"]);
  });

  test("preserves touched field state by stable row identity through structural operations", () => {
    const edited = updateDraftMapping(
      createModelMappingsDraft(server),
      0,
      "source",
      " ",
    );
    const first = edited.rows[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("test setup requires an initial draft row");
    const moved = moveDraftMapping(edited, 0, 1);
    expect(moved.rows[1]?.rowId).toBe(first.rowId);
    expect(
      getVisibleFieldErrors(moved, first.rowId, "source", available),
    ).toEqual(["blank"]);
    const deleted = deleteDraftMapping(moved, 0);
    expect(deleted.rows[0]?.rowId).toBe(first.rowId);
    expect(
      getVisibleFieldErrors(deleted, first.rowId, "source", available),
    ).toEqual(["blank"]);
  });

  test("resets rows, touched fields, and save attempt from server state", () => {
    const dirty = setDraftSaveAttempted(
      updateDraftMapping(
        createModelMappingsDraft(server),
        0,
        "source",
        "alias",
      ),
    );
    const reset = resetModelMappingsDraft(dirty, server);
    expect(reset.saveAttempted).toBe(false);
    expect(
      reset.rows.map(({ source, destination }) => ({ source, destination })),
    ).toEqual(server.model_mappings);
    expect(
      getVisibleFieldErrors(
        reset,
        reset.rows[0]?.rowId ?? "",
        "source",
        available,
      ),
    ).toEqual([]);
  });
});
