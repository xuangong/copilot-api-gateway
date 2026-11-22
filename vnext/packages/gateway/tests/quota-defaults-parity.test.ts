import { expect, test } from "bun:test"
import { DEFAULT_GROUP_SETTINGS, GROUP_SETTINGS_LIMITS } from "../src/repo/quota-balance"
import { GROUP_DEFAULTS, GROUP_LIMITS } from "../../../apps/dashboard/src/tabs/upstreams/groups/group-form"

test("the dashboard's copy of the group defaults and limits matches the gateway's", () => {
  expect(GROUP_DEFAULTS).toEqual(DEFAULT_GROUP_SETTINGS)
  expect(GROUP_LIMITS).toEqual(GROUP_SETTINGS_LIMITS)
})
