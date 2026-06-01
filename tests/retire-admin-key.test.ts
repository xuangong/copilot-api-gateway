import { test, expect, describe } from "bun:test"
import { getServerSecret } from "~/lib/redact-shared-view"

describe("getServerSecret", () => {
  test("returns SERVER_SECRET when set", () => {
    expect(getServerSecret({ SERVER_SECRET: "abc" })).toBe("abc")
  })

  test("throws when SERVER_SECRET unset (CFW shape)", () => {
    expect(() => getServerSecret({})).toThrow("SERVER_SECRET must be set")
  })

  test("ignores ADMIN_KEY entirely (legacy gone)", () => {
    // Old behavior would have fallen back to ADMIN_KEY; new behavior must throw.
    expect(() => getServerSecret({ ADMIN_KEY: "legacy" })).toThrow("SERVER_SECRET must be set")
  })
})
