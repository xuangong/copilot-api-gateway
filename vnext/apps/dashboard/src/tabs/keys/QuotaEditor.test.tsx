import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { COST_FORMAT, REQUESTS_FORMAT, TOKENS_FORMAT, UsageRow, unlimitedFillPercent, type UsageFormat } from "./QuotaEditor"

// Text only: tags stripped, so the assertions pin what the user reads.
function row(used: number, limit: number | null, format: UsageFormat = REQUESTS_FORMAT) {
  const percent = limit ? Math.round((used / limit) * 100) : 0
  const html = renderToStaticMarkup(<UsageRow label="L" used={used} limit={limit} percent={percent} format={format} />)
  return { html, text: html.replace(/<[^>]+>/g, "") }
}

test("a limited row shows used / limit and what is left", () => {
  expect(row(0, 1000).text).toBe("L0 / 10001000 dash.remaining")
  expect(row(700, 1000).text).toBe("L700 / 1000300 dash.remaining")
  expect(row(900, 1000).text).toBe("L900 / 1000100 dash.remaining")
})

test("at or over the limit, nothing is left and the row says so", () => {
  expect(row(1000, 1000).text).toBe("L1000 / 10000 dash.remainingdash.quotaExceeded")
  expect(row(1234, 1000).text).toBe("L1234 / 10000 dash.remainingdash.quotaExceeded")
})

test("the bar colour escalates above 70% and 90%, and caps at full width", () => {
  expect(row(700, 1000).html).toContain('bg-brand" style="width:70%')
  expect(row(900, 1000).html).toContain('bg-warn" style="width:90%')
  expect(row(1000, 1000).html).toContain('bg-danger" style="width:100%')
  expect(row(1234, 1000).html).toContain('bg-danger" style="width:100%')
})

test("an unlimited row shows ∞ and a muted log-scale bar", () => {
  const { html, text } = row(12345, null)
  expect(text).toBe("L12345 / ∞dash.unlimitedUsedThisMonth")
  expect(html).toContain('bg-fg-subtle" style="width:49.09')
  expect(unlimitedFillPercent(0)).toBe(0)
  expect(unlimitedFillPercent(1)).toBe(3.612359947967774)
  expect(unlimitedFillPercent(1e12)).toBe(95)
})

test("tokens and cost keep their own number formats", () => {
  expect(row(1800000.4, 2000000, TOKENS_FORMAT).text).toBe("L1,800,000 / 2,000,000200,000 dash.remaining")
  expect(row(61.23456, 50, COST_FORMAT).text).toBe("L$61.2346 / $50$0.0000 dash.remainingdash.quotaExceeded")
  expect(row(1.5, null, COST_FORMAT).text).toBe("L$1.5000 / ∞dash.unlimitedUsedThisMonth")
})
