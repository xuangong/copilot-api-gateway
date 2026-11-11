import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { UserRow } from "./UserRow"
import type { AdminUser } from "../../api/users"

const user: AdminUser = { id: "u1", name: "Ada", createdAt: new Date().toISOString(), keyCount: 0, sharedKeyCount: 0 }
const noop = () => {}
const render = (isSelf: boolean) =>
  renderToStaticMarkup(<UserRow user={user} busy={false} isSelf={isSelf} quotas={{}} onAssign={noop} onToggle={noop} onDelete={noop} />)
const buttons = (html: string) => (html.match(/<button/g) ?? []).length

test("another user's row offers assign, disable and delete", () => {
  expect(buttons(render(false))).toBe(3)
})

test("the admin's own row offers no action that could lock them out", () => {
  expect(buttons(render(true))).toBe(0)
})
