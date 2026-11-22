import { afterEach, beforeEach, expect, test } from "bun:test"
import { ApiError } from "../api/client"
import { groupErrorText } from "./group-errors"

let restore: () => void = () => {}
beforeEach(async () => { const { installDictionary } = await import("./i18n-fixture"); restore = installDictionary("en") })
afterEach(() => restore())
const NOW = Date.UTC(2026, 10, 22, 12, 0)
const fail = (status: number, code: string, message?: string, extra: Record<string, unknown> = {}) => new ApiError(status, { error: { code, ...(message ? { message } : {}) }, ...extra }, `HTTP ${status}`)
const text = (error: unknown) => groupErrorText(error, window.t!, NOW)

test("known server codes get their own wording", () => {
  expect(text(fail(409, "group_limit"))).toBe("At most 16 groups are allowed per owner")
  expect(text(fail(400, "invalid_owner"))).toBe("The owner of the group does not exist")
  expect(text(fail(400, "owner_mismatch"))).toBe("The upstream and the group must have the same owner")
  expect(text(fail(400, "invalid_name"))).toBe("Enter a group name")
  expect(text(fail(404, "not_found"))).toBe("The group or upstream no longer exists. The list was reloaded.")
  expect(text(fail(400, "invalid_settings", "settings.softShare must be below hardShare"))).toBe("The server refused the settings: settings.softShare must be below hardShare")
})

test("a too-soon manual read says how long to wait", () => {
  expect(text(fail(429, "too_soon", "x", { blockedUntil: NOW + 4 * 60_000 }))).toBe("A manual read is allowed every 10 minutes (next in 4 min)")
  expect(text(fail(429, "too_soon"))).toBe("A manual read is allowed every 10 minutes")
})

test("calibration refusals are explained", () => {
  expect(text(fail(400, "invalid_calibration", "used must not exceed 1.5 times the entitlement"))).toBe("Used must not exceed 1.5 times the entitlement")
  expect(text(fail(400, "invalid_calibration", "at must be in the current month, after its first 30 minutes"))).toBe("The time must be in the current month, after its first 30 minutes")
  expect(text(fail(400, "invalid_calibration", "at must be within the last 24 hours"))).toBe("The time must be within the last 24 hours")
  expect(text(fail(400, "invalid_calibration", "at must be after the last read"))).toBe("The time must be after the last read")
  expect(text(fail(400, "invalid_calibration", "something else"))).toBe("Enter valid numbers")
})

test("membership, provider, read and body errors have wording; a failed read keeps its status detail", () => {
  expect(text(fail(400, "not_a_member"))).toBe("The upstream is not in a group")
  expect(text(fail(400, "unsupported_provider"))).toBe("Only Copilot upstreams can join a group or be read")
  expect(text(fail(400, "invalid_body"))).toBe("The request was not understood")
  expect(text(fail(502, "read_failed", "HTTP 503"))).toBe("Could not read the quota: HTTP 503")
})

test("anything else falls back to the error message", () => {
  expect(text(new Error("boom"))).toBe("boom")
  expect(text(fail(500, "weird"))).toBe("weird")
  expect(text(fail(500, "weird", "it broke"))).toBe("it broke")
  expect(text(new ApiError(502, "<html>", "HTTP 502"))).toBe("HTTP 502")
})
