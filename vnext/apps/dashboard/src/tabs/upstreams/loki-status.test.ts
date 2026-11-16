import { expect, test } from "bun:test"
import { installDictionary } from "../../state/i18n-fixture"
import { lokiRowStatusKey } from "./loki-status"

const status = (over: Record<string, unknown> = {}) =>
  ({ assistantStatus: "authorized", tokenStatus: "valid", expiresAt: null, updatedAt: null, ...over }) as Parameters<typeof lokiRowStatusKey>[0]

test("a Loki row's status line depends on where its token comes from", () => {
  expect(lokiRowStatusKey(status({ tokenStatus: "expired" }), false)).toBe("dash.lokiExpired")
  expect(lokiRowStatusKey(status({ tokenStatus: "expired" }), true)).toBe("dash.syncedLokiExpired")
  expect(lokiRowStatusKey(status({ tokenStatus: "missing", assistantStatus: "waiting" }), true)).toBe("dash.syncedLokiWaiting")
  expect(lokiRowStatusKey(status({ tokenStatus: "missing", assistantStatus: "waiting" }), false)).toBe("dash.lokiWaiting")
  expect(lokiRowStatusKey(status(), false)).toBe("dash.lokiAuthorized")
  expect(lokiRowStatusKey(status(), true)).toBe("dash.lokiAuthorized")
  expect(lokiRowStatusKey(status({ assistantStatus: "interaction_required" }), false)).toBe("dash.lokiInteractionRequired")
  expect(lokiRowStatusKey(status({ assistantStatus: "failed" }), false)).toBe("dash.lokiFailed")
})

test("every status key has English and Chinese copy", () => {
  const keys = ["dash.lokiExpired", "dash.syncedLokiExpired", "dash.syncedLokiWaiting", "dash.lokiWaiting", "dash.lokiAuthorized",
    "dash.lokiInteractionRequired", "dash.lokiFailed"]
  for (const lang of ["en", "zh"] as const) {
    const restore = installDictionary(lang)
    try {
      const t = (window as unknown as { t: (key: string) => string }).t
      for (const key of keys) expect(t(key), `${lang} ${key}`).not.toBe(key)
    } finally { restore() }
  }
})
