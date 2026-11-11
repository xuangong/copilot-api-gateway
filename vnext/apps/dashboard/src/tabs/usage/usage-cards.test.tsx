import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { DistributionRow, UsageSummary } from "../../state/usage"
import { TooltipProvider } from "../../ui/tooltip"
import { UsageSummaryCards } from "./UsageSummary"
import { UsageDistributionTable } from "./UsageDistributionTable"

const summary: UsageSummary = { requests: 3, input: 100, output: 50, cacheRead: 400, cacheCreation: 20, costUSD: 0.12 }

const row: DistributionRow = {
  id: "claude-sonnet",
  label: "claude-sonnet",
  requests: 3,
  input: 100,
  output: 50,
  cacheRead: 400,
  cacheCreation: 20,
  costUSD: 0.12,
}

test("UsageSummaryCards puts the weighted-tokens popover on a labelled button", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <UsageSummaryCards summary={summary} />
    </TooltipProvider>,
  )
  expect(html).toMatch(/<button type="button" aria-label="[^"]+"[^>]*>/)
  // The old popover sat on a focusable span with an aria-label and no role.
  expect(html).not.toContain('<span tabindex="0"')
})

test("UsageDistributionTable renders a labelled table with a row header per row", () => {
  const html = renderToStaticMarkup(<UsageDistributionTable title="By key" ariaLabel="Usage by key" rows={[row]} />)
  expect(html).toContain('<table class="')
  expect(html).toMatch(/<table[^>]*aria-label="Usage by key"/)
  expect(html).toContain('scope="row"')
  expect(html).toContain(">By key</h3>")
})

test("UsageDistributionTable renders nothing without rows", () => {
  expect(renderToStaticMarkup(<UsageDistributionTable title="By key" rows={[]} />)).toBe("")
})
