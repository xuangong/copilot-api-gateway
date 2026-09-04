import { describe, expect, test } from "bun:test";
import {
  addDraftMapping,
  createModelMappingsDraft,
  deleteDraftMapping,
  getVisibleFieldErrors,
  moveDraftMapping,
  resetDraftInteractions,
  resetModelMappingsDraft,
  setDraftSaveAttempted,
  touchDraftMapping,
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

  test("keeps fields hidden until blur and reveals only destination once on save", () => {
    const draft = createModelMappingsDraft({
      model_mappings_enabled: true,
      model_mappings: [{ source: "alias", destination: "" }],
    });
    const row = draft.rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("test setup requires an initial draft row");
    expect(
      getVisibleFieldErrors(draft, row.rowId, "source", available),
    ).toEqual([]);
    expect(
      getVisibleFieldErrors(draft, row.rowId, "destination", available),
    ).toEqual([]);
    expect(
      getVisibleFieldErrors(
        setDraftSaveAttempted(draft),
        row.rowId,
        "source",
        available,
      ),
    ).toEqual([]);
    expect(
      getVisibleFieldErrors(
        setDraftSaveAttempted(draft),
        row.rowId,
        "destination",
        available,
      ),
    ).toEqual(["blank"]);
  });

  test("hides availability errors while the model catalog is loading", () => {
    const draft = createModelMappingsDraft({
      model_mappings_enabled: true,
      model_mappings: [{ source: "alias", destination: "retired-model" }],
    });
    const row = draft.rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("test setup requires an initial draft row");
    expect(
      getVisibleFieldErrors(draft, row.rowId, "destination", available, true),
    ).toEqual([]);
  });

  test("shows blank source and destination errors independently after their blur", () => {
    const draft = createModelMappingsDraft({
      model_mappings_enabled: true,
      model_mappings: [{ source: "", destination: "" }],
    });
    const row = draft.rows[0];
    expect(row).toBeDefined();
    if (!row) throw new Error("test setup requires an initial draft row");
    const sourceBlurred = touchDraftMapping(draft, 0, "source");
    expect(
      getVisibleFieldErrors(sourceBlurred, row.rowId, "source", available),
    ).toEqual(["blank"]);
    expect(
      getVisibleFieldErrors(sourceBlurred, row.rowId, "destination", available),
    ).toEqual([]);
    const destinationBlurred = touchDraftMapping(
      sourceBlurred,
      0,
      "destination",
    );
    expect(
      getVisibleFieldErrors(
        destinationBlurred,
        row.rowId,
        "destination",
        available,
      ),
    ).toEqual(["blank"]);
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

  test("clears draft interaction state while preserving the saved rows and enabled state", () => {
    const saved = setDraftSaveAttempted(
      updateDraftMapping(
        createModelMappingsDraft(server),
        0,
        "source",
        "new-alias",
      ),
    );
    const reset = resetDraftInteractions(saved);
    expect(reset.saveAttempted).toBe(false);
    expect(reset.enabled).toBe(saved.enabled);
    expect(
      reset.rows.map(({ source, destination }) => ({ source, destination })),
    ).toEqual([
      { source: "new-alias", destination: "claude-opus" },
      { source: "fast", destination: "gpt-5" },
    ]);
    expect(
      reset.rows.every(
        (row) => !row.touched.source && !row.touched.destination,
      ),
    ).toBe(true);
  });

  test("normalizes saved row fields while clearing interactions", () => {
    const saved = updateDraftMapping(
      createModelMappingsDraft(server),
      0,
      "source",
      " trimmed-alias ",
    );
    expect(resetDraftInteractions(saved).rows[0]?.source).toBe("trimmed-alias");
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
