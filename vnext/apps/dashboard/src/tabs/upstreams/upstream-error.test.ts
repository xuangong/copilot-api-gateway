import { expect, test } from "bun:test"
import { ApiError } from "../../api/client"
import { installDictionary } from "../../state/i18n-fixture"
import { upstreamErrorText } from "./upstream-error"

const t = (key: string) => `<${key}>`

test("a synced_upstream_read_only error maps to its own copy; others keep their message", () => {
  expect(upstreamErrorText(new ApiError(409, { error: { code: "synced_upstream_read_only" } }, "conflict"), t)).toBe("<dash.syncedUpstreamReadOnly>")
  expect(upstreamErrorText(new ApiError(400, { error: { code: "other" } }, "bad"), t)).toBe("bad")
  expect(upstreamErrorText(new Error("network"), t)).toBe("network")
  expect(upstreamErrorText("oops", t)).toBe("oops")
})

test("the copy exists in English and Chinese", () => {
  for (const lang of ["en", "zh"] as const) {
    const restore = installDictionary(lang)
    try {
      const text = (window as unknown as { t: (key: string) => string }).t
      expect(text("dash.syncedUpstreamReadOnly")).not.toBe("dash.syncedUpstreamReadOnly")
    } finally { restore() }
  }
})
