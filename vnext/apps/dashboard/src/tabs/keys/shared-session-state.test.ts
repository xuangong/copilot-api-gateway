import { expect, test } from "bun:test"
import { generateSharedSessionSecret, sharedSessionDraft } from "./shared-session-state"

test("shared drafts retain saved secrets and validate generated or pasted secrets", () => {
  expect(sharedSessionDraft(false, false, "")).toEqual({ enabled: false })
  expect(sharedSessionDraft(false, true, "invalid draft")).toEqual({ enabled: false })
  expect(sharedSessionDraft(true, false, "")).toBeNull()
  expect(sharedSessionDraft(true, true, "")).toEqual({ enabled: true })
  expect(sharedSessionDraft(true, true, "password")).toBeNull()
  expect(sharedSessionDraft(true, false, ` ${"AB".repeat(32)} `)).toEqual({ enabled: true, secret: "ab".repeat(32) })
  const generated = generateSharedSessionSecret()
  expect(generated).toMatch(/^[0-9a-f]{64}$/)
  expect(generateSharedSessionSecret()).not.toBe(generated)
})
