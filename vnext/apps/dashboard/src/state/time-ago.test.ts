import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { installDictionary } from "./i18n-fixture"
import { timeAgo } from "./time-ago"

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const ago = (ms: number) => new Date(NOW - ms).toISOString()

describe("in English", () => {
  let restore = () => {}
  beforeEach(() => {
    restore = installDictionary("en")
  })
  afterEach(() => restore())

  test("short style stays compact", () => {
    expect(timeAgo(ago(30_000), NOW)).toBe("just now")
    expect(timeAgo(ago(5 * MIN), NOW)).toBe("5m ago")
    expect(timeAgo(ago(3 * HOUR), NOW)).toBe("3h ago")
    expect(timeAgo(ago(30 * DAY), NOW)).toBe("30d ago")
  })

  test("long style spells it out, singular for one", () => {
    expect(timeAgo(ago(MIN), NOW, "long")).toBe("1 minute ago")
    expect(timeAgo(ago(5 * MIN), NOW, "long")).toBe("5 minutes ago")
    expect(timeAgo(ago(HOUR), NOW, "long")).toBe("1 hour ago")
    expect(timeAgo(ago(2 * DAY), NOW, "long")).toBe("2 days ago")
  })

  test("past 30 days it shows the date", () => {
    expect(timeAgo("2026-09-01T12:00:00Z", NOW)).toBe("Sep 1, 2026")
  })

  test("missing, unparseable and future times", () => {
    expect(timeAgo(null, NOW)).toBe("")
    expect(timeAgo("not a date", NOW)).toBe("")
    expect(timeAgo(new Date(NOW + 5 * MIN).toISOString(), NOW)).toBe("just now")
  })
})

test("in Chinese both styles read the same", () => {
  const restore = installDictionary("zh")
  try {
    expect(timeAgo(ago(30_000), NOW)).toBe("刚刚")
    expect(timeAgo(ago(5 * MIN), NOW)).toBe("5 分钟前")
    expect(timeAgo(ago(5 * MIN), NOW, "long")).toBe("5 分钟前")
    expect(timeAgo(ago(3 * HOUR), NOW)).toBe("3 小时前")
    expect(timeAgo(ago(2 * DAY), NOW, "long")).toBe("2 天前")
    expect(timeAgo("2026-09-01T12:00:00Z", NOW)).toBe("2026年9月1日")
  } finally {
    restore()
  }
})
