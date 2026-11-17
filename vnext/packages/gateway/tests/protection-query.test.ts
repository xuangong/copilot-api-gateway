// packages/gateway/tests/protection-query.test.ts
import { expect, test } from "bun:test"
import { parseErrorQuery } from "../src/control-plane/protection/query"

const NOW = 1_800_000_000
const q = (query: string) => parseErrorQuery(new URLSearchParams(query), NOW)

test("a one hour range defaults to minute buckets, a longer one to hour buckets", () => {
  expect(q(`from=${NOW - 3600}&to=${NOW}`)).toMatchObject({ bucketSeconds: 60 })
  expect(q(`from=${NOW - 86_400}&to=${NOW}`)).toMatchObject({ bucketSeconds: 60 }) // 1440 buckets <= 1500
  expect(q(`from=${NOW - 7 * 86_400}&to=${NOW}`)).toMatchObject({ bucketSeconds: 3600 })
})

test("from and to are aligned to whole buckets and default to the last hour", () => {
  expect(q(`from=${NOW - 3600 + 7}&to=${NOW - 7}&bucket=hour`)).toEqual({ from: Math.floor((NOW - 3600 + 7) / 3600) * 3600, to: Math.ceil((NOW - 7) / 3600) * 3600, bucketSeconds: 3600 })
  expect(q("")).toMatchObject({ from: Math.floor((NOW - 3600) / 60) * 60, to: Math.ceil(NOW / 60) * 60, bucketSeconds: 60 })
})

test("at most 30 days and 1500 buckets", () => {
  expect(q(`from=${NOW - 30 * 86_400}&to=${NOW}`)).toMatchObject({ bucketSeconds: 3600 })
  expect(q(`from=${NOW - 30 * 86_400 - 3600}&to=${NOW}`)).toEqual({ error: "range_too_long" })
  expect(q(`from=${NOW - 2 * 86_400}&to=${NOW}&bucket=minute`)).toEqual({ error: "too_many_buckets" })
  expect(q(`from=${NOW - 1500 * 3600}&to=${NOW}&bucket=hour`)).toEqual({ error: "range_too_long" }) // 1500 hours is 62.5 days
})

test("malformed input is refused with a code", () => {
  for (const [query, code] of [
    ["from=abc&to=10", "invalid_range"], ["from=10&to=10", "invalid_range"], ["from=20&to=10", "invalid_range"], ["from=-5&to=10", "invalid_range"],
    [`from=${NOW - 60}&to=${NOW}&bucket=day`, "invalid_bucket"], [`from=${NOW - 60}&to=${NOW}&keyId=${"k".repeat(129)}`, "invalid_key"],
  ] as const) expect(q(query), query).toEqual({ error: code })
  expect(q(`from=${NOW - 60}&to=${NOW}&keyId=key_test_1`)).toMatchObject({ keyId: "key_test_1" })
})

test("the default bucket is chosen after alignment: a range that rounds out past 1500 minutes uses hours", () => {
  const from = Math.floor(NOW / 3600) * 3600 // aligned
  expect(q(`from=${from}&to=${from + 1500 * 60}`)).toMatchObject({ bucketSeconds: 60 }) // exactly 1500 minute buckets
  expect(q(`from=${from + 30}&to=${from + 30 + 1500 * 60 - 60}`)).toMatchObject({ bucketSeconds: 60, from, to: from + 1500 * 60 }) // 1499 minutes, rounds out to exactly 1500
  expect(q(`from=${from + 30}&to=${from + 30 + 1500 * 60 - 20}`)).toMatchObject({ bucketSeconds: 3600 }) // rounds out to 1501 minutes
  expect(q(`from=${from}&to=${from + 1501 * 60}`)).toMatchObject({ bucketSeconds: 3600 })
})
