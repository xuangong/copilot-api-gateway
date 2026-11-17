// packages/gateway/tests/protection-defaults-parity.test.ts
import { expect, test } from "bun:test"
import { DEFAULT_PROTECTION_SETTINGS, PROTECTION_LIMITS } from "../src/repo/protection"
import { PROTECTION_DEFAULTS, PROTECTION_LIMITS as DASHBOARD_LIMITS } from "../../../apps/dashboard/src/tabs/upstreams/protection/protection-form"

test("the dashboard's copy of the protection defaults and limits matches the gateway's", () => {
  expect(PROTECTION_DEFAULTS).toEqual(DEFAULT_PROTECTION_SETTINGS)
  expect(DASHBOARD_LIMITS).toEqual(PROTECTION_LIMITS)
})
