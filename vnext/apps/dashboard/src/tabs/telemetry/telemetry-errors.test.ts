import { expect, test } from "bun:test"
import { ApiError } from "../../api/client"
import { telemetryErrorKey } from "./telemetry-errors"

const failure = (status: number, code: string) => new ApiError(status, { error: { code } }, code)

test("known server codes map to their own copy and everything else to the generic message", () => {
  expect(telemetryErrorKey(failure(400, "https_required"))).toBe("dash.tlmHttpsRequired")
  expect(telemetryErrorKey(failure(409, "source_limit"))).toBe("dash.tlmLimit")
  expect(telemetryErrorKey(failure(400, "invalid_request"))).toBe("dash.tlmInvalid")
  expect(telemetryErrorKey(failure(404, "source_not_found"))).toBe("dash.tlmGone")
  expect(telemetryErrorKey(failure(503, "temporarily_unavailable"))).toBe("dash.tlmError")
  expect(telemetryErrorKey(new Error("network"))).toBe("dash.tlmError")
})
