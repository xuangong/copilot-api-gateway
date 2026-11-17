// packages/gateway/tests/protection-classify.test.ts
import { expect, test } from "bun:test"
import { classifyStatus, classifyThrown, extractErrorDetail, isRiskyClass, isSampledClass } from "../src/protection/classify"

test("statuses map to the spec's classes", () => {
  const table: Array<[number, string]> = [
    [200, "ok"], [204, "ok"], [299, "ok"], [429, "rate_limited"],
    [400, "rejected"], [404, "rejected"], [409, "rejected"], [413, "rejected"], [422, "rejected"],
    [401, "auth"], [403, "auth"], [500, "upstream"], [502, "upstream"], [503, "upstream"], [599, "upstream"],
    [100, "other"], [302, "other"], [402, "other"], [405, "other"], [408, "other"], [418, "other"], [600, "other"],
  ]
  for (const [status, cls] of table) expect(classifyStatus(status), String(status)).toBe(cls as never)
})

test("only rate-limit, rejected and auth are risky; ok and other are not sampled", () => {
  expect(["rate_limited", "rejected", "auth"].every(c => isRiskyClass(c as never))).toBe(true)
  expect(["ok", "upstream", "network", "other"].some(c => isRiskyClass(c as never))).toBe(false)
  expect(["rate_limited", "rejected", "auth", "upstream", "network"].every(c => isSampledClass(c as never))).toBe(true)
  expect(isSampledClass("ok")).toBe(false)
  expect(isSampledClass("other")).toBe(false)
})

test("thrown errors are network only when they look like transport failures, and never when the caller aborted", () => {
  expect(classifyThrown(new TypeError("fetch failed"))).toBe("network")
  expect(classifyThrown(Object.assign(new Error("slow"), { name: "TimeoutError" }))).toBe("network")
  expect(classifyThrown(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("network")
  expect(classifyThrown(new Error("outer", { cause: Object.assign(new Error("inner"), { code: "ETIMEDOUT" }) }))).toBe("network")
  expect(classifyThrown(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBeNull()
  expect(classifyThrown(new Error("affinity routing unavailable"))).toBeNull()
  expect(classifyThrown("string")).toBeNull()
  const controller = new AbortController()
  controller.abort()
  expect(classifyThrown(new TypeError("fetch failed"), controller.signal)).toBeNull()
})

test("error details come from the common JSON shapes", () => {
  expect(extractErrorDetail(JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded", type: "requests" } })))
    .toEqual({ code: "rate_limit_exceeded", message: "Rate limit reached" })
  expect(extractErrorDetail(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Slow down" } })))
    .toEqual({ code: "rate_limit_error", message: "Slow down" })
  expect(extractErrorDetail(JSON.stringify({ error: "plain string" }))).toEqual({ code: "", message: "plain string" })
  expect(extractErrorDetail(JSON.stringify({ message: "top level", code: 42 }))).toEqual({ code: "42", message: "top level" })
  expect(extractErrorDetail(JSON.stringify({ detail: "d" }))).toEqual({ code: "", message: "d" })
})

test("details are trimmed to 300 characters, whitespace collapsed, tokens (and any 40+ character blob) redacted, HTML dropped", () => {
  const long = extractErrorDetail(JSON.stringify({ error: { message: "word ".repeat(100) } }))
  expect(long.message).toHaveLength(300)
  expect(extractErrorDetail(JSON.stringify({ error: { message: "a \n\n  b\tc" } })).message).toBe("a b c")
  const redacted = extractErrorDetail(JSON.stringify({ error: { message: "Incorrect API key sk-FAKEFAKEFAKE0000 and Bearer FAKEFAKEFAKE0000abc and ghp_FAKEFAKEFAKE0000" } })).message
  expect(redacted).toBe("Incorrect API key [redacted] and [redacted] and [redacted]")
  expect(extractErrorDetail("<html><body>Bad gateway</body></html>")).toEqual({ code: "", message: "" })
  expect(extractErrorDetail("  upstream said no \n")).toEqual({ code: "", message: "upstream said no" })
  expect(extractErrorDetail("")).toEqual({ code: "", message: "" })
  // truncated JSON never stores raw text: only message/code fields are pulled out
  expect(extractErrorDetail('{"error":{"message":"cut off')).toEqual({ code: "", message: "" })
  expect(extractErrorDetail('{"error":{"message":"closed one","code":"c1"},"input":"echoed user prompt that is trunc')).toEqual({ code: "c1", message: "closed one" })
  expect(extractErrorDetail('[{"error":{"type":"t1","message":"m \\"q\\" x"}, "x": "tru')).toEqual({ code: "t1", message: 'm "q" x' })
})

test("redaction covers Google keys, JWTs, hex, base64-ish blobs and key/value secrets", () => {
  const msg = (m: string) => extractErrorDetail(JSON.stringify({ error: { message: m } })).message
  expect(msg(`bad key AIza${"A".repeat(35)} here`)).toBe("bad key [redacted] here")
  expect(msg("jwt eyJhbGciOiJGQUtF.eyJmYWtlIjoxfQ.sig_FAKE end")).toBe("jwt [redacted] end")
  expect(msg(`id ${"ab12".repeat(8)} end`)).toBe("id [redacted] end")
  expect(msg(`blob ${"Zm9v+/=".repeat(8)} end`)).toBe("blob [redacted] end")
  expect(msg("api_key: fake-value-1 next")).toBe("api_key: [redacted] next")
  expect(msg("password=fakepass and token = fake2")).toBe("password=[redacted] and token = [redacted]")
  expect(msg("Authorization: Bearer fakefakefake1")).toBe("Authorization: [redacted]")
  expect(msg("quota exceeded for project")).toBe("quota exceeded for project")
})

test("one-element arrays are unwrapped and Google string status wins over a numeric code", () => {
  expect(extractErrorDetail(JSON.stringify([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota" } }])))
    .toEqual({ code: "RESOURCE_EXHAUSTED", message: "Quota" })
  expect(extractErrorDetail(JSON.stringify({ error: { code: 400, message: "no status" } }))).toEqual({ code: "400", message: "no status" })
  expect(extractErrorDetail(JSON.stringify({ error: { code: "named", status: "X", message: "m" } }))).toEqual({ code: "named", message: "m" })
})

test("input is capped before parsing and the code is capped at 100 characters", () => {
  const huge = JSON.stringify({ pad: "x".repeat(20000), error: { message: "ok" } })
  expect(extractErrorDetail(huge).message).toBe("")
  expect(extractErrorDetail(JSON.stringify({ error: { code: "cd ".repeat(200), message: "m" } })).code).toHaveLength(100)
})

test("scraping a truncated body only reads inside the error object", () => {
  expect(extractErrorDetail('{"input":[{"message":"FAKE PROMPT"}],"error":{"message":"real"')).toEqual({ code: "", message: "real" })
  expect(extractErrorDetail('{"input":[{"message":"FAKE PROMPT"}],"error":{"message":"real","code":"c9"')).toEqual({ code: "c9", message: "real" })
  expect(extractErrorDetail('{"input":[{"message":"FAKE PROMPT"}],"other":"tru')).toEqual({ code: "", message: "" })
  expect(extractErrorDetail('{"message":"FAKE TOP LEVEL","code":"x"')).toEqual({ code: "", message: "" })
})

test("quoted key/value secrets are fully redacted; short lowercase words are kept", () => {
  const msg = (m: string) => extractErrorDetail(JSON.stringify({ error: { message: m } })).message
  expect(msg('password="fake two words" end')).toBe("password=[redacted] end")
  expect(msg("secret='fake two' end")).toBe("secret=[redacted] end")
  expect(msg('{"api_key": "FAKEVALUE123"} end')).toBe('{"api_key": [redacted]} end')
  expect(msg("Invalid token: expired")).toBe("Invalid token: expired")
  expect(msg("Invalid token: Expired1")).toBe("Invalid token: [redacted]")
})

test("the long-blob rule leaves URLs and resource paths alone but catches random base64", () => {
  const msg = (m: string) => extractErrorDetail(JSON.stringify({ error: { message: m } })).message
  const url = "see https://docs.example.com/guides/rate-limits-and-quotas-for-the-fake-service-overview/page"
  expect(msg(url)).toBe(url)
  const path = "not found /v1/projects/fake-project-one/locations/global/publishers/google/models/fake-model-name"
  expect(msg(path)).toBe(path)
  expect(msg(`blob ${"aB3+x/Yz9=".repeat(5)} end`)).toBe("blob [redacted] end")
  expect(msg(`blob ${"aB3x_Yz9-".repeat(5)} end`)).toBe("blob [redacted] end")
  expect(msg(`blob ${"aB3/xYz9Q/".repeat(5)}= end`)).toBe("blob [redacted] end")
})

test("only socket-style ECONN codes and the transport phrases count as network, not words that contain them", () => {
  expect(classifyThrown(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe("network")
  expect(classifyThrown(new Error("Network connection lost."))).toBe("network")
  expect(classifyThrown(new Error("please reconnect to the account"))).toBeNull()
  expect(classifyThrown(new Error("econnection settings invalid"))).toBeNull()
})
