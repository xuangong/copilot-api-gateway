import { expect, test } from "bun:test"
import { ApiError } from "../../api/client"
import { installDictionary } from "../../state/i18n-fixture"
import { syncDeviceErrorKey, syncLastErrorKey, syncSourceErrorKey } from "./sync-errors"

const fail = (code: string) => new ApiError(400, { error: { code } }, code)

test("device errors map to specific copy", () => {
  expect(syncDeviceErrorKey(fail("https_required"))).toBe("dash.syncDeviceHttpsRequired")
  expect(syncDeviceErrorKey(fail("device_limit"))).toBe("dash.syncDeviceLimit")
  expect(syncDeviceErrorKey(fail("invalid_upstreams"))).toBe("dash.syncDeviceInvalidUpstreams")
  expect(syncDeviceErrorKey(fail("boom"))).toBe("dash.syncDeviceError")
  expect(syncDeviceErrorKey(new Error("network"))).toBe("dash.syncDeviceError")
})

test("source errors map to specific copy", () => {
  expect(syncSourceErrorKey(fail("invalid_sync_document"))).toBe("dash.syncSourceRejected")
  expect(syncSourceErrorKey(fail("sync_unreachable"))).toBe("dash.syncSourceUnreachable")
  expect(syncSourceErrorKey(fail("sync_source_exists"))).toBe("dash.syncSourceExists")
  expect(syncSourceErrorKey(fail("sync_source_not_found"))).toBe("dash.syncSourceGone")
  expect(syncSourceErrorKey(fail("device_sync_unavailable"))).toBe("dash.syncSourceUnavailable")
  expect(syncSourceErrorKey(fail("invalid_request"))).toBe("dash.syncSourceError")
  expect(syncSourceErrorKey(undefined)).toBe("dash.syncSourceError")
})

test("stored sync error codes map to copy", () => {
  expect(syncLastErrorKey(null)).toBeNull()
  expect(syncLastErrorKey("unreachable")).toBe("dash.syncErrorUnreachable")
  expect(syncLastErrorKey("id_conflict")).toBe("dash.syncErrorIdConflict")
  expect(syncLastErrorKey("something_new")).toBe("dash.syncErrorUnknown")
})

test("every key these helpers can return has English and Chinese copy", () => {
  const keys = new Set<string>()
  for (const code of ["https_required", "device_limit", "invalid_upstreams", "x"]) keys.add(syncDeviceErrorKey(fail(code)))
  for (const code of ["invalid_sync_document", "sync_unreachable", "sync_source_exists", "sync_source_not_found", "device_sync_unavailable", "x"]) keys.add(syncSourceErrorKey(fail(code)))
  for (const code of ["unreachable", "http_error", "bad_response", "id_conflict", "unsupported_provider", "apply_failed", "x"]) keys.add(syncLastErrorKey(code)!)
  for (const lang of ["en", "zh"] as const) {
    const restore = installDictionary(lang)
    try {
      // The dictionary lookup is the global window.t installed by the fixture.
      const t = (window as unknown as { t: (key: string) => string }).t
      for (const key of keys) expect(t(key), `${lang} ${key}`).not.toBe(key)
    } finally { restore() }
  }
})
