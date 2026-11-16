import { expect, test } from "bun:test"
import { ApiError } from "../../api/client"
import { mirrorImportErrorKey, mirrorIssueErrorKey, settingsError } from "./loki-errors"
import { lokiRowStatusKey } from "./loki-status"

test("settingsError reads the server error code", () => {
  expect(settingsError(new ApiError(409, { error: { code: "mirror_limit" } }, "x"))).toBe("mirror_limit")
  expect(settingsError(new Error("x"))).toBeUndefined()
})

test("issue errors map to copy, with not-found refetching silently", () => {
  expect(mirrorIssueErrorKey("mirror_limit")).toBe("dash.lokiMirrorLimit")
  expect(mirrorIssueErrorKey("https_required")).toBe("dash.lokiHttpsRequired")
  expect(mirrorIssueErrorKey("mirror_not_found")).toBeNull()
  expect(mirrorIssueErrorKey("boom")).toBe("dash.lokiMirrorError")
  expect(mirrorIssueErrorKey(undefined)).toBe("dash.lokiMirrorError")
})

test("import errors map to copy with endpoint and model fallbacks", () => {
  expect(mirrorImportErrorKey("invalid_mirror")).toBe("dash.lokiMirrorInvalid")
  expect(mirrorImportErrorKey("invalid_mirror_document")).toBe("dash.lokiMirrorDocumentInvalid")
  expect(mirrorImportErrorKey("mirror_unreachable")).toBe("dash.lokiMirrorUnreachable")
  expect(mirrorImportErrorKey("invalid_endpoint")).toBe("dash.lokiEndpointInvalid")
  expect(mirrorImportErrorKey("invalid_static_models")).toBe("dash.lokiStaticModelsInvalid")
  expect(mirrorImportErrorKey("mirror_unsupported")).toBe("dash.lokiMirrorImportError")
  expect(mirrorImportErrorKey(undefined)).toBe("dash.lokiMirrorImportError")
})

const mirror = { kind: "mirror", origin: "https://c.example" } as const
const st = (over: Partial<NonNullable<Parameters<typeof lokiRowStatusKey>[0]>> = {}) =>
  ({ assistantStatus: "authorized", tokenStatus: "valid", expiresAt: null, updatedAt: null, ...over }) as const

test("row status key covers every branch", () => {
  expect(lokiRowStatusKey(st({ errorCode: "mirror_revoked" }), mirror)).toBe("dash.lokiMirrorRevoked")
  expect(lokiRowStatusKey(st({ errorCode: "account_mismatch" }), mirror)).toBe("dash.lokiMirrorAccountMismatch")
  expect(lokiRowStatusKey(st({ tokenStatus: "expired" }), mirror)).toBe("dash.lokiMirrorExpired")
  expect(lokiRowStatusKey(st({ tokenStatus: "expired" }), undefined)).toBe("dash.lokiExpired")
  expect(lokiRowStatusKey(st({ tokenStatus: "missing", assistantStatus: "waiting" }), mirror)).toBe("dash.lokiMirrorWaiting")
  expect(lokiRowStatusKey(st({ tokenStatus: "missing", assistantStatus: "waiting" }), undefined)).toBe("dash.lokiWaiting")
  expect(lokiRowStatusKey(st({ assistantStatus: "waiting" }), undefined)).toBe("dash.lokiWaiting")
  expect(lokiRowStatusKey(st(), undefined)).toBe("dash.lokiAuthorized")
  expect(lokiRowStatusKey(st({ assistantStatus: "interaction_required" }), undefined)).toBe("dash.lokiInteractionRequired")
  expect(lokiRowStatusKey(st({ assistantStatus: "failed" }), undefined)).toBe("dash.lokiFailed")
})
