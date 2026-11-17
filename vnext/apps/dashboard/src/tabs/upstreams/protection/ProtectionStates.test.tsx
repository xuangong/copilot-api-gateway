import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { installDictionary } from "../../../state/i18n-fixture"
import type { BannerItem } from "../../../components/protection-banner-model"
import { ProtectionStates } from "./ProtectionStates"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())

const item = (over: Partial<BannerItem> = {}): BannerItem => ({ id: "pp_1", tone: "danger", text: "Paused", canResume: true, upstreamId: "up_a", targetKind: "upstream", ...over })
const render = (items: BannerItem[], resuming: string[] = []) =>
  renderToStaticMarkup(<ProtectionStates items={items} resuming={new Set(resuming)} onResume={() => {}} />)
const resumeButton = (html: string) => html.match(/<button[^>]*>Resume now<\/button>/)?.[0] ?? ""

test("no items reads as normal", () => {
  expect(render([])).toContain("Normal: no pause or warning is active.")
})

test("Resume appears only when the server allows it and is disabled while the request is in flight", () => {
  expect(resumeButton(render([item()]))).not.toBe("")
  expect(resumeButton(render([item()]))).not.toContain('disabled=""')
  expect(resumeButton(render([item({ canResume: false })]))).toBe("")
  expect(resumeButton(render([item()], ["pp_1"]))).toContain('disabled=""')
})
