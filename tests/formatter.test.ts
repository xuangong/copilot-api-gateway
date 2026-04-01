/**
 * Unit tests for web search formatter
 */
import { describe, test, expect } from "bun:test"

import { formatSearchResults } from "../src/services/web-search/formatter"

describe("formatSearchResults", () => {
  test("formats empty results", () => {
    const result = formatSearchResults([])

    expect(result).toBe("No search results found.")
  })

  test("formats single result", () => {
    const results = [
      {
        title: "Test Title",
        url: "https://example.com",
        snippet: "This is a test snippet.",
      },
    ]

    const result = formatSearchResults(results)

    expect(result).toBe(
      "[1] Test Title\nURL: https://example.com\nThis is a test snippet.",
    )
  })

  test("formats multiple results", () => {
    const results = [
      {
        title: "First Result",
        url: "https://example.com/1",
        snippet: "First snippet.",
      },
      {
        title: "Second Result",
        url: "https://example.com/2",
        snippet: "Second snippet.",
      },
    ]

    const result = formatSearchResults(results)

    expect(result).toContain("[1] First Result")
    expect(result).toContain("[2] Second Result")
    expect(result).toContain("URL: https://example.com/1")
    expect(result).toContain("URL: https://example.com/2")
  })

  test("uses correct separator between results", () => {
    const results = [
      { title: "A", url: "https://a.com", snippet: "a" },
      { title: "B", url: "https://b.com", snippet: "b" },
    ]

    const result = formatSearchResults(results)

    // Results should be separated by double newline
    expect(result).toContain("\n\n")
  })

  test("handles special characters in content", () => {
    const results = [
      {
        title: "Test <script>alert('xss')</script>",
        url: "https://example.com?foo=bar&baz=qux",
        snippet: "Contains \"quotes\" and 'apostrophes'.",
      },
    ]

    const result = formatSearchResults(results)

    expect(result).toContain("<script>")
    expect(result).toContain("&")
    expect(result).toContain('"quotes"')
  })

  test("handles unicode characters", () => {
    const results = [
      {
        title: "中文标题 日本語",
        url: "https://example.com/测试",
        snippet: "支持多语言 🎉",
      },
    ]

    const result = formatSearchResults(results)

    expect(result).toContain("中文标题")
    expect(result).toContain("🎉")
  })
})
