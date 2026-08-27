import { describe, expect, test } from "bun:test"
import {
  COST_ANCHOR_WINDOW,
  MIN_DAY_FILL,
  STRIP_CELLS,
  STRIP_WINDOW,
  buildRollingStrip,
  computeStripRange,
  costShadeLevel,
  dayFillRatio,
} from "./usage-strip"
import { zoneOps } from "./timezone"

const LOCAL = zoneOps("local")

// Wed 12 Aug 2026, 15:30 local — the same fixed clock the range tests use.
const NOW = new Date(2026, 7, 12, 15, 30, 0, 0)
const HOUR = 3600_000

const day = (k: string) => k
/** Daily totals for a run of days ending on `last`, newest value first. */
function dailyFrom(last: Date, values: Array<{ cost: number; tokens: number }>) {
  const m = new Map<string, { cost: number; tokens: number }>()
  values.forEach((v, i) => {
    const d = new Date(last.getFullYear(), last.getMonth(), last.getDate() - i)
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
    m.set(k, v)
  })
  return m
}

describe("strip shape", () => {
  test("90 squares over a 28-day window", () => {
    expect(STRIP_CELLS).toBe(90)
    expect(STRIP_WINDOW).toBe(28)
  })
})

// Each cell answers "what did the 28 days ending on this day add up to", so the
// earliest cell still needs 27 days behind it: 90 + 27 = 117 days in all.
describe("computeStripRange", () => {
  test("reaches back far enough that the first cell has a full window", () => {
    const r = computeStripRange(NOW, LOCAL)
    expect(r.start).toBe(new Date(2026, 3, 18).toISOString().slice(0, 13))
    expect(r.end).toBe(new Date(NOW.getTime() + HOUR).toISOString().slice(0, 13))
  })
})

describe("buildRollingStrip", () => {
  test("ends on the chosen day and holds one cell per day back from it", () => {
    const cells = buildRollingStrip(new Map(), new Date(2026, 7, 12), LOCAL)
    expect(cells).toHaveLength(90)
    expect(cells[89]!.endKey).toBe("2026-08-12")
    expect(cells[0]!.endKey).toBe("2026-05-15")
  })

  // The whole point of the strip: a cell is a window total, not a day's total.
  test("each cell totals both metrics over the window ending on it", () => {
    const daily = dailyFrom(
      new Date(2026, 7, 12),
      Array.from({ length: 120 }, () => ({ cost: 2, tokens: 1000 })),
    )
    const cells = buildRollingStrip(daily, new Date(2026, 7, 12), LOCAL)
    for (const c of cells) {
      expect(c.costUSD).toBeCloseTo(56, 6)
      expect(c.tokens).toBe(28000)
    }
  })

  // A sliding window is only right if it drops the day that fell out as well as
  // adding the day that came in — uniform data would hide a bug in either half.
  test("slides the window rather than re-reading a fixed span", () => {
    // 1 on the last day, 0 everywhere else.
    const daily = new Map([[day("2026-08-12"), { cost: 1, tokens: 10 }]])
    const cells = buildRollingStrip(daily, new Date(2026, 7, 12), LOCAL)
    // Only the windows that still contain Aug 12 see it — that is the last one.
    expect(cells[89]!.costUSD).toBe(1)
    expect(cells[88]!.costUSD).toBe(0)
    // And a day at the very start of the earliest window shows up there only:
    // the first square closes 2026-05-15, so its window opens on Apr 18.
    const daily2 = new Map([[day("2026-04-18"), { cost: 1, tokens: 10 }]])
    const cells2 = buildRollingStrip(daily2, new Date(2026, 7, 12), LOCAL)
    expect(cells2[0]!.costUSD).toBe(1)
    // One day later the window has already slid past it.
    expect(cells2.find((c) => c.endKey === "2026-05-16")!.costUSD).toBe(0)
  })

  test("days with no usage count as zero", () => {
    const daily = new Map([
      [day("2026-08-12"), { cost: 5, tokens: 50 }],
      [day("2026-08-01"), { cost: 3, tokens: 30 }],
    ])
    const cells = buildRollingStrip(daily, new Date(2026, 7, 12), LOCAL)
    expect(cells[89]!.costUSD).toBe(8)
    expect(cells[89]!.tokens).toBe(80)
    // The window closing 2026-07-31 covers Jul 4 – Jul 31, which holds neither.
    expect(cells.find((c) => c.endKey === "2026-07-31")!.costUSD).toBe(0)
  })

  test("labels the cell by its closing day", () => {
    const cells = buildRollingStrip(new Map(), new Date(2026, 7, 12), LOCAL)
    expect(cells[89]!.label).toBe("Aug 12")
  })

  // The square carries two readings at once: the outline is the window total,
  // the fill is what the closing day itself contributed.
  test("carries the closing day's own totals alongside the window's", () => {
    const daily = new Map([
      [day("2026-08-12"), { cost: 5, tokens: 50 }],
      [day("2026-08-01"), { cost: 3, tokens: 30 }],
    ])
    const cells = buildRollingStrip(daily, new Date(2026, 7, 12), LOCAL)
    const last = cells[89]!
    expect(last.costUSD).toBe(8)
    expect(last.dayCostUSD).toBe(5)
    expect(last.dayTokens).toBe(50)
    // A day inside the window but not closing it contributes nothing to the fill.
    const quiet = cells.find((c) => c.endKey === "2026-08-11")!
    expect(quiet.costUSD).toBe(3)
    expect(quiet.dayCostUSD).toBe(0)
  })
})

// The fill is deliberately relative where the shade is absolute: it answers
// "how big was this day next to the biggest one here", which only has meaning
// against the days on screen.
describe("dayFillRatio", () => {
  test("the busiest day fills the square", () => {
    expect(dayFillRatio(40, 40)).toBe(1)
  })

  test("an empty day fills nothing", () => {
    expect(dayFillRatio(0, 40)).toBe(0)
    expect(dayFillRatio(-1, 40)).toBe(0)
  })

  test("a day with no busiest day to measure against fills nothing", () => {
    expect(dayFillRatio(5, 0)).toBe(0)
    expect(dayFillRatio(0, 0)).toBe(0)
  })

  test("an ordinary day fills in proportion", () => {
    expect(dayFillRatio(20, 40)).toBeCloseTo(0.5, 6)
  })

  // Without a floor a real but tiny day renders as nothing at all, which reads
  // as "no usage" — a different fact entirely.
  test("a tiny day still shows a sliver rather than vanishing", () => {
    expect(dayFillRatio(0.001, 40)).toBe(MIN_DAY_FILL)
    expect(dayFillRatio(0.001, 40)).toBeGreaterThan(0)
  })

  test("never overflows the square", () => {
    expect(dayFillRatio(80, 40)).toBe(1)
  })
})

// The shade carries an absolute meaning — a $7,000 window is the darkest — so
// that a colour means the same thing after the user changes a filter. GitHub
// ranks against the busiest cell instead, which would make the scale slide about.
describe("costShadeLevel", () => {
  test("no spend is the empty shade", () => {
    expect(costShadeLevel(0)).toBe(0)
    expect(costShadeLevel(-1)).toBe(0)
  })

  test("the anchor and anything above it is the darkest", () => {
    expect(COST_ANCHOR_WINDOW).toBe(7000)
    expect(costShadeLevel(7000)).toBe(4)
    expect(costShadeLevel(70000)).toBe(4)
  })

  // Quartered steps down from the anchor, so the scale spans two orders of
  // magnitude instead of collapsing everything ordinary into one shade.
  test("steps down by quarters from the anchor", () => {
    expect(costShadeLevel(1750)).toBe(3)
    expect(costShadeLevel(437.5)).toBe(2)
    expect(costShadeLevel(437.49)).toBe(1)
  })

  test("any spend at all is at least the faintest shade", () => {
    expect(costShadeLevel(0.0001)).toBe(1)
  })
})
