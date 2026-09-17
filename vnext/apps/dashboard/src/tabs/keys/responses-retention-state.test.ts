import { expect, test } from "bun:test"
import { retentionFromDraft } from "./responses-retention-state"

test("disabled retention saves zero even with an unfinished duration", () => {
  expect(retentionFromDraft(false, "")).toBe(0)
})
test.each([["1", 86400], ["3", 259200], ["7", 604800]])("converts day input %s to seconds", (input, seconds) => {
  expect(retentionFromDraft(true, String(input))).toBe(seconds)
})
test.each(["", "0", "-1", "1.5", "3651", "abc"])("rejects invalid enabled day input %s", (input) => {
  expect(retentionFromDraft(true, input)).toBeNull()
})
