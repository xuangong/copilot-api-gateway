import { expect, test } from "bun:test"
import { verifyObserverLifecycle, verifyProcessOwnership, frozenIdentity } from "./analyze"
import type { ObserverReceipt } from "./observer"
const receipt = (): ObserverReceipt => ({ mode: "none", completed: true, prepared: true, started: true, stopped: true, closeAttempted: true, closed: true, inspector: null, intervalUs: null, startCommand: null, stopCommand: null, v8: null, profile: null, errors: [], scope: "test" })
test("accepts complete none lifecycle without interpreting it as a CPU profile", () => expect(() => verifyObserverLifecycle(receipt(), "none")).not.toThrow())
for (const flag of ["completed", "prepared", "started", "stopped", "closeAttempted", "closed"] as const) test(`requires ${flag} to qualify`, () => expect(() => verifyObserverLifecycle({ ...receipt(), [flag]: false }, "none")).toThrow("lifecycle"))
test("rejects hidden observer failure and wrong requested mode", () => {
  expect(() => verifyObserverLifecycle({ ...receipt(), errors: ["close failed"] }, "none")).toThrow()
  expect(() => verifyObserverLifecycle(receipt(), "cpu")).toThrow()
})
test("CPU mode requires exact target and ordered command envelope", () => {
  const cpu: ObserverReceipt = { ...receipt(), mode: "cpu", inspector: { inspectorURL: "ws://127.0.0.1:9900", target: { id: "core:user:reference-stage-B-control", webSocketDebuggerUrl: "ws://127.0.0.1:9900/core:user:reference-stage-B-control" } }, intervalUs: 1000, startCommand: { beginMs: 1, endMs: 2 }, stopCommand: { beginMs: 3, endMs: 4 }, v8: { startTime: 99, endTime: 999 }, profile: { path: "/profile", bytes: 1, sha256: "a".repeat(64) } }
  expect(() => verifyObserverLifecycle(cpu, "cpu")).not.toThrow()
  expect(() => verifyObserverLifecycle({ ...cpu, stopCommand: { beginMs: 1, endMs: 4 } }, "cpu")).toThrow("ordering")
  const inspector = cpu.inspector
  if (!inspector) throw new Error("Missing fixture Inspector")
  expect(() => verifyObserverLifecycle({ ...cpu, inspector: { ...inspector, target: { id: "different", webSocketDebuggerUrl: "ws://127.0.0.1:9900/different" } } }, "cpu")).toThrow()
})

const resource = { pid: 303, startIdentity: "darwin-abstime:123", executableName: "workerd", userUs: 100, systemUs: 50, rssBytes: 1024, observedAtMs: 2, scope: "darwin-process-libproc-rusage-v2" }
test("binds child and workerd samples to recorded outer ownership and discovery", () => {
  const child = { pid: 202, parentPid: 101, parentGroup: 101 }
  expect(() => verifyProcessOwnership(101, child, resource, { ...resource, observedAtMs: 3 })).not.toThrow()
  expect(() => verifyProcessOwnership(999, child, resource, resource)).toThrow("outer")
  expect(() => verifyProcessOwnership(101, { ...child, pid: 101 }, resource, resource)).toThrow("outer")
  expect(() => verifyProcessOwnership(101, child, resource, { ...resource, pid: 404 })).toThrow("identities")
  expect(() => verifyProcessOwnership(101, child, resource, { ...resource, startIdentity: "darwin-abstime:124" })).toThrow("identities")
  expect(() => verifyProcessOwnership(101, child, { ...resource, executableName: "bun" }, { ...resource, executableName: "bun" })).toThrow("workerd")
})
test("requires exact frozen artifact identity rather than trusting a current self-hash", () => {
  const file = { path: "/saved/bundle.map", bytes: 10, sha256: "a".repeat(64) }
  expect(frozenIdentity([file], file.path)).toEqual(file)
  expect(() => frozenIdentity([], file.path)).toThrow("frozen")
  expect(() => frozenIdentity([file, { ...file, sha256: "b".repeat(64) }], file.path)).toThrow("Conflicting")
})
