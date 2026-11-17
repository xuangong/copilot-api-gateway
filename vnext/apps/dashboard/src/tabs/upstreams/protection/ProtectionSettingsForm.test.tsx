// apps/dashboard/src/tabs/upstreams/protection/ProtectionSettingsForm.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { installDictionary } from "../../../state/i18n-fixture"
import { ProtectionFields } from "./ProtectionSettingsForm"
import { PROTECTION_DEFAULTS, toForm } from "./protection-form"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())

const render = (over: Partial<Parameters<typeof ProtectionFields>[0]> = {}) =>
  renderToStaticMarkup(<ProtectionFields form={toForm(PROTECTION_DEFAULTS)} errors={{}} dirty={false} saving={false} disabled={false} onMode={() => {}} onValue={() => {}} onReset={() => {}} onSave={() => {}} {...over} />)

test("the mode selector and every threshold are shown with their default and allowed range", () => {
  const html = render()
  for (const text of ["Off", "Warn only", "Warn and pause", "Window (minutes)", "Minimum risky errors", "Minimum failure ratio", "Authentication burst", "Key attribution share", "Cooldown (minutes)", "Maximum cooldown (minutes)"]) {
    expect(html, text).toContain(text)
  }
  expect(html).toContain("Default 5, allowed 1 to 60.")
  expect(html).toContain("Default 0.5, allowed 0 to 1.")
  expect(html).toContain("Default 360, allowed 1 to 10080.")
})

test("a field error replaces its hint, and Save is disabled while the form has errors, is unchanged, or is saving", () => {
  const withError = render({ errors: { windowMinutes: "range", maxCooldownMinutes: "order" } })
  expect(withError).toContain("Must be between 1 and 60.")
  expect(withError).toContain("Must not be below the cooldown.")
  expect(withError).not.toContain("Default 5, allowed 1 to 60.")
  const save = (html: string) => html.match(/<button[^>]*>Save protection settings<\/button>/)?.[0] ?? ""
  // `disabled=""` is the attribute; the class list also contains Tailwind's `disabled:` variants, so match the attribute exactly.
  expect(save(render({ dirty: true }))).not.toContain('disabled=""')
  expect(save(render({ dirty: false }))).toContain('disabled=""')
  expect(save(render({ dirty: true, errors: { authBurst: "number" } }))).toContain('disabled=""')
  expect(save(render({ dirty: true, saving: true }))).toContain('disabled=""')
  expect(save(render({ dirty: true, disabled: true }))).toContain('disabled=""')
})
