import { afterEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { COPILOT_PRICING_URL } from "../../constants"
import { installDictionary } from "../../state/i18n-fixture"
import { TooltipProvider } from "../../ui/tooltip"
import { CostInfo, CostInfoPanel } from "./CostInfo"
import { UsageSummaryCards } from "./UsageSummary"

let restore = () => {}
afterEach(() => restore())

test("the cost note links to GitHub's pricing page in a new tab, in English", () => {
  restore = installDictionary("en")
  const html = renderToStaticMarkup(<CostInfoPanel />)
  expect(html).toContain("Costs are estimated from GitHub Copilot&#x27;s published per-token prices.")
  expect(html).toContain(`href="${COPILOT_PRICING_URL}"`)
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noopener noreferrer"')
  expect(html).toContain(">GitHub Copilot models and pricing</a>")
  expect(html).not.toMatch(/\$\d/)
})

test("the cost note is translated to Chinese", () => {
  restore = installDictionary("zh")
  const html = renderToStaticMarkup(<CostInfoPanel />)
  expect(html).toContain("费用按 GitHub Copilot 公布的按 token 单价估算。")
  expect(html).toContain(">GitHub Copilot 模型与价格</a>")
})

test("the info button is a labelled, collapsed disclosure that does not rely on hover", () => {
  restore = installDictionary("en")
  const html = renderToStaticMarkup(<CostInfo />)
  expect(html).toMatch(/<button type="button" aria-label="About cost estimates" aria-expanded="false"/)
  expect(html).not.toContain("href=")
})

test("the Usage summary puts the cost info button beside the cost heading", () => {
  restore = installDictionary("en")
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <UsageSummaryCards summary={{ requests: 1, input: 1, output: 1, cacheRead: 0, cacheCreation: 0, costUSD: 0.5 }} />
    </TooltipProvider>,
  )
  expect(html).toMatch(/Cost \(USD\)<span[^>]*><button[^>]*aria-label="About cost estimates"/)
})
