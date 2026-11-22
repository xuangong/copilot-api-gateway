import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { installDictionary } from "../../../state/i18n-fixture"
import { NewGroupControl } from "./NewGroupControl"
import { AddMemberControl } from "./AddMemberControl"
import { CalibrateForm } from "./CalibrateForm"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())
const noop = () => {}

test("the calibration form has four labelled inputs, Save and Cancel, and shows a server error as an alert", () => {
  const out = renderToStaticMarkup(<CalibrateForm name="Alpha" lastReadAt={null} busy={false} onSave={noop} onCancel={noop} error="The time must be after the last read" />)
  for (const label of ["Used", "Entitlement", "or used share (%)", "Taken how many minutes ago (0 to 1440)"]) expect(out).toContain(label)
  expect(out).toContain('role="alert"')
  expect(out).toContain("The time must be after the last read")
  expect(out).toContain(">Save<")
  expect(out).toContain(">Cancel<")
  expect(out).toContain("Enter the current usage of Alpha")
  expect(out).toMatch(/role="group"[^>]*aria-label="Enter the current usage of Alpha"/)
})

test("the add-member control renders only when there is a candidate", () => {
  expect(renderToStaticMarkup(<AddMemberControl candidates={[]} busy={false} onAdd={noop} />)).toBe("")
  const out = renderToStaticMarkup(<AddMemberControl candidates={[{ id: "up_a", name: "A", config: { user: { id: 1, login: "alice" } } } as never]} busy={false} onAdd={noop} />)
  expect(out).toContain("Add upstream")
})

test("the new-group control starts as a button", () => {
  expect(renderToStaticMarkup(<NewGroupControl busy={false} onCreate={async () => true} />)).toContain(">New group<")
})
