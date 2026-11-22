import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { installDictionary } from "../../../state/i18n-fixture"
import { GroupFields } from "./GroupSettingsForm"
import { GROUP_DEFAULTS, toForm } from "./group-form"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())
const noop = () => {}
const render = (over: Partial<Parameters<typeof GroupFields>[0]> = {}) => renderToStaticMarkup(
  <GroupFields form={toForm(GROUP_DEFAULTS)} errors={{}} dirty={false} saving={false} disabled={false} onPolicy={noop} onValue={noop} onReset={noop} onSave={noop} {...over} />)

test("every setting has a labelled input with its default and range, shares shown as percentages", () => {
  const out = render()
  for (const label of ["Balance tolerance (%)", "Soft line (%)", "Hard line (%)", "Idle rebalance (minutes)", "Move gap (%)", "Burn horizon (hours)", "Heavy session (USD per hour)", "Minimum time between moves (hours)", "Read interval (hours)", "Confirming read at (%)", "Drift that triggers a read (%)", "Session memory (hours)"]) {
    expect(out).toContain(label)
  }
  expect(out).toContain("Default 90, from 50 to 100")
  expect(out).toContain('value="90"')
  expect(out).toContain("Stop: skip the group")
  expect(out).toContain("Allow overage")
})

test("errors are shown in place of the hint and Save is disabled until something changed and is valid", () => {
  const bad = render({ errors: { softShare: "order", readIntervalHours: "range", confirmShare: "confirmOrder" }, dirty: true })
  expect(bad).toContain("The soft line must not exceed the hard line")
  expect(bad).toContain("Must be between 1 and 48")
  expect(bad).toContain("The confirming read must not exceed the soft line")
  expect(bad).toMatch(/<button[^>]*\sdisabled=""[^>]*>Save</)
  expect(render({ dirty: true })).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Save</)
  expect(render()).toMatch(/<button[^>]*\sdisabled=""[^>]*>Save</)
})
