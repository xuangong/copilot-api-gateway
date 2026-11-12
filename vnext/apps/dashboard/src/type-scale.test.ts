import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = import.meta.dir

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === "__snapshots__" ? [] : sources(path)
    return /\.(tsx?|css)$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : []
  })
}

function offenders(patterns: RegExp[]): string[] {
  return sources(SRC).flatMap((path) => {
    const text = readFileSync(path, "utf8")
    return patterns.flatMap((re) => [...text.matchAll(re)].map((m) => `${relative(SRC, path)}: ${m[0]}`))
  })
}

// Spec ("字体"): small text is 12px; 10px and 11px are not mixed in.
test("no 10px or 11px text", () => {
  expect(offenders([/text-\[1[01](?:\.\d+)?px\]/g, /font-size:\s*1[01](?:\.\d+)?px/g])).toEqual([])
})

// Body copy goes through the text-body token, so its size and line height live in one place.
test("body size uses text-body, not a hard-coded 13px", () => {
  expect(offenders([/text-\[13px\]/g])).toEqual([])
})
