import { expect, test } from "bun:test"
import { CodexImportDraft } from "./codex-import-draft"

test("document and target edits invalidate late preview/import responses", () => {
  const draft = new CodexImportDraft(null)
  draft.setDocument("fixture-one")
  const first = draft.begin()
  expect(draft.accepts(first)).toBe(true)
  draft.setDocument("fixture-two")
  expect(draft.accepts(first)).toBe(false)
  const second = draft.begin()
  draft.setTarget("up_codex_a")
  expect(draft.document).toBe("")
  expect(draft.accepts(second)).toBe(false)
  draft.setDocument("fixture-three")
  const third = draft.begin()
  draft.setTarget("up_codex_b")
  expect(draft.accepts(third)).toBe(false)
  expect(draft.document).toBe("")
})

test("success, cancel, and unmount clearing drop the raw document and pending responses", () => {
  const draft = new CodexImportDraft("up_codex_a")
  draft.setDocument("fixture-secret")
  const pending = draft.begin()
  draft.clear()
  expect(draft.document).toBe("")
  expect(draft.accepts(pending)).toBe(false)
})

test("newer preview wins even when the document is unchanged", () => {
  const draft = new CodexImportDraft(null)
  draft.setDocument("fixture")
  const earlier = draft.begin()
  const later = draft.begin()
  expect(draft.accepts(earlier)).toBe(false)
  expect(draft.accepts(later)).toBe(true)
})
