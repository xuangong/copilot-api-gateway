// apps/dashboard/src/tabs/upstreams/protection/ErrorBarChart.test.tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ErrorBarChart } from "./ErrorBarChart"

test("the chart is a canvas in a sized box (Chart.js draws into it after mount)", () => {
  const html = renderToStaticMarkup(<ErrorBarChart labels={["a"]} bars={[{ key: "rate_limited", label: "Rate limited", data: [1] }]} requests={{ label: "Requests", data: [3] }} height={240} />)
  expect(html).toContain("<canvas")
  expect(html).toContain("height:240px")
})

test("the canvas is an image with a text alternative", () => {
  const html = renderToStaticMarkup(<ErrorBarChart labels={["a"]} bars={[]} requests={{ label: "Requests", data: [3] }} ariaLabel="Last 24 h: 3 requests, 1 error" />)
  expect(html).toContain('role="img"')
  expect(html).toContain('aria-label="Last 24 h: 3 requests, 1 error"')
})
