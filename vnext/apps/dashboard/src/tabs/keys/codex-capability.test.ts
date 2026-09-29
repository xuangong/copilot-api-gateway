import { expect, test } from "bun:test"
import { CodexCapabilityRequestGate, hasConfirmedCodexWebSocketCapability, readCodexWebSocketCapability } from "./codex-capability"

const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { "content-type": "application/json" },
})
const confirmed = { codex: { responsesWebSocket: {
  available: true, mode: "single_turn", multiplex: false, fork: false,
  reconnectHistory: false, maxConnectionOutboundBytes: null,
} } }

test("capability read confirms only a valid same-origin authenticated response", async () => {
  const calls: Array<{ url: unknown; init?: RequestInit }> = []
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url, init })
    return response(confirmed)
  }
  expect(await readCodexWebSocketCapability("https://gateway.example", new AbortController().signal, fetcher)).toBe(true)
  expect(calls[0]?.url).toBe("https://gateway.example/api/capabilities")
  expect(calls[0]?.init?.credentials).toBe("include")
  expect(calls[0]?.init?.cache).toBe("no-store")
  expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
})

test.each([
  [{ codex: { responsesWebSocket: { available: "true" } } }, 200],
  [{ codex: { responsesWebSocket: { available: true } } }, 200],
  [{ codex: { responsesWebSocket: { available: false } } }, 200],
  [{ codex: {} }, 200],
  [confirmed, 401],
])("unknown, false, malformed and unauthorized capability reads stay false", async (body, status) => {
  expect(await readCodexWebSocketCapability("https://gateway.example", new AbortController().signal, async () => response(body, status))).toBe(false)
})

test("active capability fetch rejection stays false", async () => {
  let calls = 0
  const signal = new AbortController().signal
  expect(await readCodexWebSocketCapability("https://gateway.example", signal, async () => {
    calls++
    throw new Error("offline")
  })).toBe(false)
  expect(calls).toBe(1)
})

test("pre-aborted capability read stays false without fetching", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  expect(await readCodexWebSocketCapability("https://gateway.example", controller.signal, async () => {
    calls++
    return response(confirmed)
  })).toBe(false)
  expect(calls).toBe(0)
})

test("scope switch aborts the old request and rejects its late result", () => {
  const gate = new CodexCapabilityRequestGate()
  const first = gate.begin("origin-a|session-a|key-a")
  expect(gate.accepts(first.ticket, "origin-a|session-a|key-a")).toBe(true)
  const second = gate.begin("origin-b|session-b|key-b")
  expect(first.signal.aborted).toBe(true)
  expect(gate.accepts(first.ticket, "origin-a|session-a|key-a")).toBe(false)
  expect(gate.accepts(first.ticket, "origin-b|session-b|key-b")).toBe(false)
  expect(gate.accepts(second.ticket, "origin-b|session-b|key-b")).toBe(true)
  gate.invalidate()
  expect(second.signal.aborted).toBe(true)
  expect(gate.accepts(second.ticket, "origin-b|session-b|key-b")).toBe(false)
})

test("same-document session or key switch hides a previously confirmed true immediately", () => {
  const confirmed = { scope: "origin-a|session-a|key-a", available: true }
  expect(hasConfirmedCodexWebSocketCapability(confirmed, "origin-a|session-a|key-a")).toBe(true)
  expect(hasConfirmedCodexWebSocketCapability(confirmed, "origin-a|session-a|key-b")).toBe(false)
  expect(hasConfirmedCodexWebSocketCapability(confirmed, "origin-a|session-b|key-a")).toBe(false)
  expect(hasConfirmedCodexWebSocketCapability(confirmed, "origin-b|session-a|key-a")).toBe(false)
})
