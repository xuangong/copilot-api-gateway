import { expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { createFixture, expectedCases, summarizeCorrectness } from "./correctness"
import { decodeWire, makeInput, verifySuccess } from "./correctness-contracts"

const headers = { authorization: "Bearer matched-sse-correctness-fixture-secret", "content-type": "application/json" }

test("population gate separates known gaps from common workload qualification", () => {
  const rows = expectedCases.map(row => ({ id: row.id, verdict: { ok: true, errors: [] as string[] } }))
  expect(rows).toHaveLength(61)
  const cancellation = rows.find(row => row.id === "B-responses-cancel-sse")
  if (!cancellation) throw new Error("Missing cancellation case")
  cancellation.verdict = { ok: false, errors: ["upstream did not close before cleanup"] }
  const summary = summarizeCorrectness(rows)
  expect(summary.qualified).toBe(false)
  expect(summary.commonWorkloadQualified).toBe(true)
  expect(summary.knownGaps).toHaveLength(1)
  expect(summarizeCorrectness(rows.filter(row => row.id !== "R-responses-opaque-replay-sse")).commonWorkloadQualified).toBe(false)
  expect(summarizeCorrectness(rows.filter(row => row.id !== "R-responses-opaque-replay-sse")).missing).toEqual(["R-responses-opaque-replay-sse"])
})

test("TCP fixture honors actual stream flag and emits complete split tool arguments", async () => {
  const fixture = await createFixture()
  try {
    const input = makeInput("chat", "canary-chat-tool", true, "fixture-sse", "tool")
    const response = await fetch(`${fixture.base}/primary/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(input) })
    const raw = await response.text()
    await fixture.refresh()
    expect(verifySuccess({ protocol: "chat", stream: true, status: response.status, contentType: response.headers.get("content-type"), raw }, "tool").errors).toEqual([])
    expect(fixture.dispatches[0]?.requestedStream).toBe(true)
    expect(fixture.dispatches[0]?.normalCompletionSent).toBe(true)
    expect(decodeWire(raw, true).events.filter(event => Array.isArray(event.choices) && JSON.stringify(event).includes("arguments"))).toHaveLength(2)
    const json = await fetch(`${fixture.base}/primary/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ ...input, stream: false }) })
    expect(json.headers.get("content-type")).toBe("application/json")
    expect(verifySuccess({ protocol: "chat", stream: false, status: json.status, contentType: json.headers.get("content-type"), raw: await json.text() }, "tool").errors).toEqual([])
    await fixture.refresh()
    expect(fixture.dispatches[1]?.requestedStream).toBe(false)
  } finally { await fixture.stop() }
})

test("fallback fixture really omits MIME on the HTTP wire", async () => {
  const fixture = await createFixture()
  try {
    const input = makeInput("chat", "canary-chat-fallback-untyped", true, "fixture-untyped", "tool")
    const response = await fetch(`${fixture.base}/primary/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(input) })
    expect(response.headers.get("content-type")).toBeNull()
    const body: unknown = await response.json()
    expect(body).toMatchObject({ choices: [{ message: { tool_calls: [{ function: { arguments: '{"city":"Oslo"}' } }] } }] })
    await fixture.refresh()
    expect(fixture.dispatches[0]?.requestedStream).toBe(true)
  } finally { await fixture.stop() }
})

test("cancel fixture records TCP closure while its normal terminal remains gated", async () => {
  const fixture = await createFixture()
  try {
    await new Promise<void>((done, reject) => {
      const request = httpRequest(`${fixture.base}/primary/v1/responses`, { method: "POST", headers }, response => {
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => { if (chunk.includes("Weather ")) { response.destroy(); request.destroy(); done() } })
        response.on("error", () => {})
      })
      request.on("error", reject)
      request.end(JSON.stringify(makeInput("responses", "canary-responses-cancel", true, "fixture-cancel")))
    })
    const until = Date.now() + 2000
    while (!fixture.dispatches[0]?.upstreamClosed && Date.now() < until) { await Bun.sleep(5); await fixture.refresh() }
    expect(fixture.dispatches[0]?.upstreamClosed).toBe(true)
    expect(fixture.dispatches[0]?.normalCompletionSent).toBe(false)
    expect(fixture.dispatches[0]?.gateReleased).toBe(false)
    expect(fixture.dispatches[0]?.sentFrames.join("")).not.toContain("response.completed")
  } finally { await fixture.stop() }
})
