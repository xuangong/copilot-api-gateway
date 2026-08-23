import { describe, expect, test } from "bun:test"
import { tooltipPlacement } from "./TimeSeriesChart"

// Tooltip box and canvas used throughout; the numbers only have to be
// self-consistent.
const TIP = { width: 160, height: 90 }
const CANVAS = { width: 800, height: 320 }

const place = (anchorX: number, anchorY: number) =>
  tooltipPlacement({ anchorX, anchorY, tip: TIP, canvas: CANVAS, gap: 10 })

describe("tooltipPlacement", () => {
  test("centres above the point, clear of it by the gap", () => {
    const p = place(400, 200)
    expect(p.left).toBe(400 - TIP.width / 2)
    expect(p.top).toBe(200 - TIP.height - 10)
    expect(p.below).toBe(false)
  })

  // The whole point of anchoring: the same point must always place the box in
  // the same spot, or moving toward the link moves the link.
  test("is a pure function of the anchor", () => {
    expect(place(400, 200)).toEqual(place(400, 200))
  })

  test("keeps the box inside the canvas at both edges", () => {
    expect(place(4, 200).left).toBe(0)
    expect(place(CANVAS.width - 4, 200).left).toBe(CANVAS.width - TIP.width)
  })

  // A point near the top has no room above it; the box would be clipped by the
  // chart container and the link would be unreachable.
  test("flips below the point when there is no room above", () => {
    const p = place(400, 40)
    expect(p.below).toBe(true)
    expect(p.top).toBe(40 + 10)
  })

  test("stays above when there is exactly enough room", () => {
    expect(place(400, TIP.height + 10).below).toBe(false)
  })

  // A tooltip taller than the plot area must not be pushed off the top; the
  // clamp wins over the preference for placing it above.
  test("never positions the box above the canvas top", () => {
    const p = tooltipPlacement({
      anchorX: 400,
      anchorY: 10,
      tip: { width: 160, height: 400 },
      canvas: CANVAS,
      gap: 10,
    })
    expect(p.top).toBeGreaterThanOrEqual(0)
  })

  test("a canvas narrower than the tooltip pins it to the left", () => {
    const p = tooltipPlacement({
      anchorX: 50,
      anchorY: 200,
      tip: { width: 300, height: 90 },
      canvas: { width: 200, height: 320 },
      gap: 10,
    })
    expect(p.left).toBe(0)
  })
})

// A bucket usually has one active series; the rest sit at zero. Listing them
// buries the number you came to read — "Cache 0 tokens" especially.
describe("visibleTooltipRows", () => {
  const rows = [
    { label: "Admin", value: 0, color: "#111" },
    { label: "Xian Zhang", value: 23, color: "#222" },
    { label: "Cache", value: 0, color: "#333" },
  ]

  test("drops the zero rows and keeps the order of the rest", async () => {
    const { visibleTooltipRows } = await import("./TimeSeriesChart")
    expect(visibleTooltipRows(rows).map((r) => r.label)).toEqual(["Xian Zhang"])
  })

  // An all-zero bucket still gets a tooltip with its date, so hovering never
  // looks broken — it just has nothing to list.
  test("returns nothing when every series is zero", async () => {
    const { visibleTooltipRows } = await import("./TimeSeriesChart")
    expect(visibleTooltipRows([{ label: "a", value: 0, color: "#1" }])).toEqual([])
  })

  // Negative values are not something these charts produce, but "non-zero" is
  // the rule, not "positive" — silently hiding one would lose real data.
  test("keeps a negative value", async () => {
    const { visibleTooltipRows } = await import("./TimeSeriesChart")
    expect(visibleTooltipRows([{ label: "a", value: -5, color: "#1" }])).toHaveLength(1)
  })
})
