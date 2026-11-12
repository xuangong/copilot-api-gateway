import { expect, test } from "bun:test"
import { formatLokiModelNames, parseLokiModelNames } from "./loki-static-models"

test("Loki names accept lines and commas, trim whitespace and keep the first occurrence", () => {
  expect(parseLokiModelNames(" claude-opus-5.5\r\n\ngpt-6-luna, claude-sonnet-5.5\nclaude-opus-5.5, "))
    .toEqual(["claude-opus-5.5", "gpt-6-luna", "claude-sonnet-5.5"])
  expect(parseLokiModelNames(" \n,\r\n ")).toEqual([])
})

test("stored names are edited one per line, including older upstreams without this setting", () => {
  expect(formatLokiModelNames(undefined)).toBe("")
  expect(formatLokiModelNames(["claude-opus-5.5", "gpt-6-luna"])).toBe("claude-opus-5.5\ngpt-6-luna")
  expect(parseLokiModelNames(formatLokiModelNames(["one", "two"]))).toEqual(["one", "two"])
})
