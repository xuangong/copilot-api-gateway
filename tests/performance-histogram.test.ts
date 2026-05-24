import { test, expect, describe } from "bun:test"
import {
  latencyBucketForMs,
  percentileFromHistogramBuckets,
  type HistogramBucket,
} from "~/lib/performance-histogram"

describe("latencyBucketForMs", () => {
  test("anything ≤100ms lands in the base bucket", () => {
    expect(latencyBucketForMs(0)).toEqual({ lowerMs: 0, upperMs: 100 })
    expect(latencyBucketForMs(50)).toEqual({ lowerMs: 0, upperMs: 100 })
    expect(latencyBucketForMs(100)).toEqual({ lowerMs: 0, upperMs: 100 })
  })

  test("just above base steps into the next √2 bucket", () => {
    const b = latencyBucketForMs(101)
    expect(b.lowerMs).toBe(100)
    expect(b.upperMs).toBe(Math.ceil(100 * Math.SQRT2))
  })

  test("buckets grow geometrically", () => {
    const a = latencyBucketForMs(1000)
    const b = latencyBucketForMs(10000)
    expect(b.upperMs).toBeGreaterThan(a.upperMs)
  })

  test("ceils fractional durations", () => {
    expect(latencyBucketForMs(50.4)).toEqual({ lowerMs: 0, upperMs: 100 })
  })

  test("clamps negatives", () => {
    expect(latencyBucketForMs(-5)).toEqual({ lowerMs: 0, upperMs: 100 })
  })
})

describe("percentileFromHistogramBuckets", () => {
  test("returns null when no observations", () => {
    expect(percentileFromHistogramBuckets([], 0.5)).toBe(null)
    expect(
      percentileFromHistogramBuckets([{ lowerMs: 0, upperMs: 100, count: 0 }], 0.5),
    ).toBe(null)
  })

  test("p50 of a single bucket is the upper bound", () => {
    const buckets: HistogramBucket[] = [{ lowerMs: 0, upperMs: 100, count: 10 }]
    expect(percentileFromHistogramBuckets(buckets, 0.5)).toBe(100)
  })

  test("p95 falls in the heaviest tail bucket", () => {
    const buckets: HistogramBucket[] = [
      { lowerMs: 0, upperMs: 100, count: 80 },
      { lowerMs: 100, upperMs: 142, count: 15 },
      { lowerMs: 142, upperMs: 200, count: 5 },
    ]
    expect(percentileFromHistogramBuckets(buckets, 0.95)).toBe(142)
    expect(percentileFromHistogramBuckets(buckets, 0.99)).toBe(200)
  })
})
