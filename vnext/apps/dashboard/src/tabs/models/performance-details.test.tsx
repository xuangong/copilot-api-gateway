import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { PerformanceDetails } from "./PerformanceDetails"
import type { BrowserPerformanceSnapshot } from "./browser-performance"

test("browser metrics identify observation source, cancellation and unavailable values", () => {
  const html = renderToStaticMarkup(<PerformanceDetails snapshot={{ outcome: "cancelled", responses: 1, outputChunks: 1, metrics: { totalMs: 1400, ttftMs: 500, cachedInputTokens: 0 } }} />)
  expect(html).toContain("dash.perf.browser")
  expect(html).toContain("dash.perf.cancelled")
  expect(html).toContain("dash.perf.unknown")
  expect(html).toContain("500 ms")
  expect(html).toContain("1.4 s")
  expect(html).toContain("dash.perf.browserNote")
  expect(html).not.toContain("0 tok/s")
  expect(html).not.toContain("dash.perf.upstreamMs")
})

test("previously saved generation rates never reappear in browser details", () => {
  const snapshot = JSON.parse('{"outcome":"success","responses":1,"outputChunks":2,"metrics":{"totalMs":12000,"generationMs":1,"outputTps":19567.9,"overallTps":25}}') as BrowserPerformanceSnapshot
  const html = renderToStaticMarkup(<PerformanceDetails snapshot={snapshot} />)
  expect(html).toContain("dash.perf.overallTps")
  expect(html).toContain("25 tok/s")
  expect(html).not.toContain("dash.perf.outputTps")
  expect(html).not.toContain("19,567")
  expect(html).not.toContain("dash.perf.upstreamTps")
})
