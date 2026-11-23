import { afterAll, afterEach, expect, test } from "bun:test"
import { createTelemetrySource, rotateTelemetryKey } from "./telemetry"

const realFetch = globalThis.fetch
const seen: Array<{ url: string; body: unknown }> = []
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  seen.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
  return new Response(JSON.stringify({ key: "k", install: "i", source: {} }), { status: 200, headers: { "content-type": "application/json" } })
}) as unknown as typeof fetch
afterEach(() => { seen.length = 0 })
afterAll(() => { globalThis.fetch = realFetch })

test("creating sends the agent source only when one is given", async () => {
  await createTelemetrySource("a")
  await createTelemetrySource("b", "museum")
  await createTelemetrySource("c", "  ")
  expect(seen.map(call => call.body)).toEqual([{ name: "a" }, { name: "b", agentSource: "museum" }, { name: "c" }])
})

test("rotating puts the agent source in the query only when one is given", async () => {
  await rotateTelemetryKey("tls_x")
  await rotateTelemetryKey("tls_x", "my-site")
  expect(seen.map(call => call.url)).toEqual(["/api/telemetry/sources/tls_x/rotate-key", "/api/telemetry/sources/tls_x/rotate-key?agentSource=my-site"])
})
