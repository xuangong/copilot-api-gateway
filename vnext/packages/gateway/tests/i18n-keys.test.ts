import { test, expect } from "bun:test"
import { readdirSync, statSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { renderI18nScript } from "../src/shared/edge/ui-pages/i18n.ts"

// A missing key is not an error at runtime: lookup() falls through and renders
// the raw key ("dash.shareUnshareFirst") to the user.
const DASHBOARD_SRC = join(import.meta.dir, "../../../apps/dashboard/src")

const collectKeys = (dir: string, into: Set<string>) => {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== "node_modules" && entry !== "dist") collectKeys(path, into)
    } else if (/\.tsx?$/.test(entry)) {
      for (const m of readFileSync(path, "utf8").matchAll(/\bt\(\s*"([^"]+)"/g)) into.add(m[1]!)
    }
  }
}

const dictionaries = () => {
  const lines = renderI18nScript().split("\n")
  const starts = lines.flatMap((l, i) => (/^\s{4}(en|zh):\s*\{/.test(l) ? [i] : []))
  const [en, zh] = starts
  const slice = (from: number, to: number) =>
    new Set(
      lines
        .slice(from, to)
        .map((l) => l.match(/^\s+"([^"]+)":/)?.[1])
        .filter((k): k is string => !!k),
    )
  return { en: slice(en!, zh!), zh: slice(zh!, lines.length) }
}

test("every key the dashboard asks for exists in both locales", () => {
  const used = new Set<string>()
  collectKeys(DASHBOARD_SRC, used)
  expect(used.size).toBeGreaterThan(100)

  const { en, zh } = dictionaries()
  expect([...used].filter((k) => !en.has(k))).toEqual([])
  expect([...used].filter((k) => !zh.has(k))).toEqual([])
})

test("the two locales define the same keys", () => {
  const { en, zh } = dictionaries()
  expect([...en].filter((k) => !zh.has(k))).toEqual([])
  expect([...zh].filter((k) => !en.has(k))).toEqual([])
})
