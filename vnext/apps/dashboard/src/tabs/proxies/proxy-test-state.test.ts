import { expect, test } from "bun:test"
import { initialProxyTestState, reduceProxyTestState } from "./proxy-test-state"

test("draft edits clear test feedback and reject the previous in-flight result", () => {
  const pending = reduceProxyTestState(initialProxyTestState, { type: "start", revision: 1 })
  const edited = reduceProxyTestState(pending, { type: "invalidate", revision: 2 })
  expect(edited).toMatchObject({ pending: false, result: null })
  expect(reduceProxyTestState(edited, { type: "finish", revision: 1, result: { ok: true, egressIp: "127.0.0.1" } })).toBe(edited)
})

test("old failures cannot replace newer test state or clear its busy indicator", () => {
  const newer = reduceProxyTestState(initialProxyTestState, { type: "start", revision: 3 })
  expect(reduceProxyTestState(newer, { type: "finish", revision: 1, result: { ok: false, error: "old" } })).toBe(newer)
  expect(reduceProxyTestState(newer, { type: "finish", revision: 3, result: { ok: true, egressIp: "127.0.0.2" } })).toMatchObject({ pending: false, result: { ok: true } })
})
