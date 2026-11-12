import { expect, test } from "bun:test"
import { withToast, type Toast } from "./toast"

const error = (id: number, message = "boom"): Toast => ({ id, kind: "error", message })
const info = (id: number, message = "ok"): Toast => ({ id, kind: "info", message })

test("an error already on screen is not stacked again", () => {
  const list = [error(1)]
  expect(withToast(list, error(2))).toBe(list)
  expect(withToast(list, error(3, "other"))).toEqual([error(1), error(3, "other")])
})

test("other kinds can repeat; they leave on their own", () => {
  expect(withToast([info(1)], info(2))).toEqual([info(1), info(2)])
})

test("at most five toasts, the oldest leaves first", () => {
  let list: Toast[] = []
  for (let i = 1; i <= 6; i++) list = withToast(list, error(i, `e${i}`))
  expect(list.map((t) => t.id)).toEqual([2, 3, 4, 5, 6])
})

test("over the cap, a passing toast leaves before an error waiting to be read", () => {
  let list: Toast[] = [error(1)]
  for (let i = 2; i <= 6; i++) list = withToast(list, info(i, `i${i}`))
  expect(list.map((t) => t.id)).toEqual([1, 3, 4, 5, 6])
})
