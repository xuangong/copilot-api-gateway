import { expect, test } from "bun:test"
import { installDictionary } from "./i18n-fixture"
import { formatWeekLabel } from "./latency"

// formatWeekLabel reads the clock, so these check the wording, not the dates.
test("the performance week label reads in the interface language", () => {
  for (const [lang, current, previous, range] of [
    ["en", "This week (", "Last week (", /^[A-Z][a-z]{2} \d+ – [A-Z][a-z]{2} \d+$/],
    ["zh", "本周（", "上周（", /^\d+月\d+日 – \d+月\d+日$/],
  ] as const) {
    const restore = installDictionary(lang)
    try {
      expect(formatWeekLabel(0, "local")).toStartWith(current)
      expect(formatWeekLabel(-1, "local")).toStartWith(previous)
      expect(formatWeekLabel(-3, "local")).toMatch(range)
    } finally {
      restore()
    }
  }
})
