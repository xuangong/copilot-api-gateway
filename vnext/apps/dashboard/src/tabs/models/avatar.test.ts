import { expect, test } from "bun:test"
import { avatarAccent, avatarLabel, FALLBACK_AVATAR } from "./avatar"

test("a display name yields its leading word", () => {
  expect(avatarLabel("Claude Opus 5")).toBe("Claude")
  expect(avatarLabel("Grok 4.5")).toBe("Grok")
})

test("a hyphenated name stops at the first hyphen", () => {
  expect(avatarLabel("GPT-5.5")).toBe("GPT")
  expect(avatarLabel("MAI-Code-1-Flash")).toBe("MAI")
})

test("a name with no separator stops at the first digit", () => {
  // Otherwise "GPT4o" would fill the badge with a version nobody reads there.
  expect(avatarLabel("GPT4o")).toBe("GPT")
})

test("a vendor-prefixed id names the model, not the route", () => {
  expect(avatarLabel("openai/gpt-5.5")).toBe("gpt")
  expect(avatarLabel("copilot:claude-opus-5")).toBe("claude")
})

test("casing is left exactly as the catalog wrote it", () => {
  // No rule capitalises both "gpt" → GPT and "grok" → Grok correctly, so the
  // badge never invents a spelling the vendor doesn't use.
  expect(avatarLabel("gpt-5.5")).toBe("gpt")
})

test("an over-long word is cut to fit the badge", () => {
  expect(avatarLabel("Superlongvendorname 2")).toBe("Superlongv")
})

test("history with no recorded model falls back", () => {
  expect(avatarLabel(undefined)).toBe(FALLBACK_AVATAR)
  expect(avatarLabel("")).toBe(FALLBACK_AVATAR)
})

test("a name that opens with a digit falls back rather than showing a number", () => {
  expect(avatarLabel("4o-mini")).toBe(FALLBACK_AVATAR)
})

test("each family gets its own accent, so a mixed thread reads at a glance", () => {
  const claude = avatarAccent("Claude")
  const gpt = avatarAccent("GPT")
  const gemini = avatarAccent("Gemini")
  expect(new Set([claude, gpt, gemini]).size).toBe(3)
})

test("the accent ignores the casing the catalog happened to use", () => {
  expect(avatarAccent("gpt")).toBe(avatarAccent("GPT"))
})

test("an unlisted family falls back to the dashboard's own violet", () => {
  expect(avatarAccent("Someothermodel")).toBe(avatarAccent(FALLBACK_AVATAR))
})

test("an accent is always three space-separated channel values", () => {
  for (const name of ["Claude", "GPT", "Grok", "MAI", "Whatever"]) {
    const channels = avatarAccent(name).split(" ")
    expect(channels).toHaveLength(3)
    for (const c of channels) expect(Number(c)).toBeGreaterThanOrEqual(0)
  }
})
