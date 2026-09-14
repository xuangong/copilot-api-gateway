import { expect, test, spyOn } from "bun:test"
import { RemoteRateWindow, remoteSecurityEvent } from "../src/control-plane/agent-remote/security.ts"

test("bounded rate windows deny saturation and expire without eviction bypass", () => {
  const window = new RemoteRateWindow(2)
  expect(window.allow("one", 1, 100)).toBe(true)
  expect(window.allow("one", 1, 101)).toBe(false)
  expect(window.allow("two", 1, 101)).toBe(true)
  expect(window.allow("three", 1, 101)).toBe(false)
  expect(window.allow("one", 1, 101)).toBe(false)
  expect(window.allow("three", 1, 60_101)).toBe(true)
}, 5000)

test("Gateway security events contain only fixed action and outcome fields", () => {
  const log = spyOn(console, "info").mockImplementation(() => {})
  try {
    remoteSecurityEvent("reauthentication", "denied")
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "agent_remote_security", action: "reauthentication", outcome: "denied" }))
  } finally { log.mockRestore() }
}, 5000)
