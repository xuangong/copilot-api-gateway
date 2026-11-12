import { expect, test } from "bun:test"
import { renderI18nScript } from "../src/shared/edge/ui-pages/i18n.ts"

type Translate = (key: string, vars?: Record<string, string | number>) => string

// Runs the page script against stand-ins for the browser globals it touches.
const loadT = (lang: "en" | "zh"): Translate => {
  const body = renderI18nScript().replace(/^<script>/, "").replace(/<\/script>$/, "")
  const run = new Function("window", "localStorage", "navigator", "document", `${body}\nreturn t`)
  return run({}, { getItem: () => lang }, { language: "en-US" }, { documentElement: { setAttribute() {} } }) as Translate
}

test("a value goes in exactly as written, $ patterns included", () => {
  expect(loadT("en")("dash.proxyDeleteConfirm", { name: "a$&b$'c$$d" })).toBe(`Delete proxy node "a$&b$'c$$d"?`)
})

test("every occurrence of a placeholder is filled", () => {
  expect(loadT("en")("{x} and {x}", { x: 1 })).toBe("1 and 1")
})

test("the chosen language wins, English fills the gaps", () => {
  expect(loadT("zh")("dash.delete")).toBe("删除")
  expect(loadT("en")("dash.delete")).toBe("Delete")
})

test("a value is never filled again, even if it looks like a placeholder", () => {
  expect(loadT("en")("{a} {b}", { a: "{b}", b: "x" })).toBe("{b} x")
  expect(loadT("en")("dash.probeFailedToast", { name: "x{error}", error: "boom" })).toBe("x{error}: boom")
})

test("a placeholder with no value stays as written", () => {
  expect(loadT("en")("{a} {b}", { a: 1 })).toBe("1 {b}")
})
