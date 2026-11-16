import { expect, test } from "bun:test"
import { ApiError } from "../../api/client"
import { settingsError } from "./loki-errors"

test("settingsError reads the server error code", () => {
  expect(settingsError(new ApiError(409, { error: { code: "revision_conflict" } }, "x"))).toBe("revision_conflict")
  expect(settingsError(new ApiError(500, { error: "text" }, "x"))).toBeUndefined()
  expect(settingsError(new Error("x"))).toBeUndefined()
})
