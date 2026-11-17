import { expect, test } from "bun:test"
import { planFocus } from "./focus"

const rows = [{ id: "up_mine", ownerId: "7" }, { id: "up_other", ownerId: "9" }, { id: "up_global", ownerId: null }]

test("an upstream the viewer owns is opened and its group expanded", () => {
  expect(planFocus(rows, "up_mine", { isAdmin: false, myOwnerId: "7" })).toEqual({ id: "up_mine", groupKey: "7" })
})

test("admins may open any upstream; global rows use the global group key", () => {
  expect(planFocus(rows, "up_other", { isAdmin: true, myOwnerId: "7" })).toEqual({ id: "up_other", groupKey: "9" })
  expect(planFocus(rows, "up_global", { isAdmin: true, myOwnerId: "7" })).toEqual({ id: "up_global", groupKey: "__global__" })
})

test("other people's upstreams and unknown ids are not opened", () => {
  expect(planFocus(rows, "up_other", { isAdmin: false, myOwnerId: "7" })).toBeNull()
  expect(planFocus(rows, "up_missing", { isAdmin: true, myOwnerId: "7" })).toBeNull()
})
