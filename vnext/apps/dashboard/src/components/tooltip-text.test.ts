import { describe, expect, test } from "bun:test"
import { sortTooltipRows, tooltipValueText, type TooltipRow } from "./TimeSeriesChart"

describe("sortTooltipRows", () => {
  test("lists the largest value first without changing the input", () => {
    const rows: TooltipRow[] = [
      { label: "a", value: 1, color: "#000" },
      { label: "b", value: 30, color: "#000" },
      { label: "c", value: 7, color: "#000" },
    ]
    expect(sortTooltipRows(rows).map((r) => r.label)).toEqual(["b", "c", "a"])
    expect(rows.map((r) => r.label)).toEqual(["a", "b", "c"])
  })
})

describe("tooltipValueText", () => {
  const cache = (n: number) => `incl. ${n.toLocaleString("en-US")} cache`

  test("names the cache share when a formatter is given and there is cache", () => {
    expect(tooltipValueText(1200, " tokens", 900, cache)).toBe(`${(1200).toLocaleString()} tokens (incl. 900 cache)`)
  })

  test("is the bare value without cache or without a formatter", () => {
    expect(tooltipValueText(1200, " tokens", 0, cache)).toBe(`${(1200).toLocaleString()} tokens`)
    expect(tooltipValueText(1200, " tokens", 900)).toBe(`${(1200).toLocaleString()} tokens`)
    expect(tooltipValueText(3, " req", undefined, cache)).toBe("3 req")
  })
})
