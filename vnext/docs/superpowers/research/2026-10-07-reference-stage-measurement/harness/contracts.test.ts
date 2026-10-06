import { describe, expect, test } from "bun:test"
import { balancedOrders, makeRequest, verifyChat, validatePopulation, cells } from "./contracts"

describe("reference measurement contracts", () => {
  test("balances all three positions and retains diagnostic comparison labels", () => {
    expect(balancedOrders).toHaveLength(6)
    for (const arm of ["A", "B", "R"]) for (let position = 0; position < 3; position++) {
      expect(balancedOrders.filter(order => order[position] === arm)).toHaveLength(2)
    }
    expect(cells.filter(cell => cell.comparison === "complete-behavior")).toHaveLength(4)
    expect(cells.filter(cell => cell.comparison === "common-behavior")).toHaveLength(2)
  })
  test("matches exact wire bytes for every input shape and preserves a correlation marker", () => {
    expect(cells).toHaveLength(6)
    for (const cell of cells) {
      const request = makeRequest("case_123", cell)
      expect(Buffer.byteLength(request)).toBe(65536)
      const body = JSON.parse(request) as { model: string; messages: {role:string;content:string}[] }
      expect(body.model).toBe("bench-chat-ok")
      expect(request).toContain("BENCH_ID:case_123")
      expect(body.messages.every((message: {role:string;content:string}) => message.role === "user" && typeof message.content === "string")).toBe(true)
      expect(body.messages.length > 1).toBe(cell.shape === "containers")
    }
  })
  test("rejects markers and byte sizes that cannot form a valid fixture", () => {
    const cell = { id: "example", stream: true, shape: "string" as const, bytes: 65536, dump: true, comparison: "complete-behavior" as const }
    expect(() => makeRequest("bad\"id", cell)).toThrow()
    expect(() => makeRequest("good", { ...cell, bytes: 8 })).toThrow()
  })
  test("requires correct final content and terminal rather than accepting HTTP 200", () => {
    const chunk = (delta: unknown, finish_reason: string | null) => ({ choices: [{ index: 0, delta, finish_reason }], ...(finish_reason === "stop" ? { usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } } : {}) })
    expect(verifyChat(200, [chunk({ role: "assistant", content: "BENCH_OK:65536" }, null), chunk({}, "stop")], true, true).ok).toBe(true)
    expect(verifyChat(200, [chunk({ role: "assistant", content: "BENCH_OK:65536" }, null)], true, true).ok).toBe(false)
    expect(verifyChat(200, [chunk({ role: "assistant", content: "BENCH_OK:65536" }, null), chunk({}, "stop")], false, true).ok).toBe(false)
    expect(verifyChat(200, [{ choices: [{ message: { content: "wrong" }, finish_reason: "stop" }] }], false, false).ok).toBe(false)
  })
  test("population rejects incomplete, duplicate and wrong-arm rows", () => {
    const row = { id: "one", arm: "A" as const, cell: "sse-string-full" }
    const expected = [row]
    expect(() => validatePopulation(expected, [])).toThrow("population")
    expect(() => validatePopulation(expected, [{ ...row, ok: true }, { ...row, ok: true }])).toThrow("population")
    expect(() => validatePopulation(expected, [{ ...row, arm: "R", ok: true }])).toThrow("identity")
    expect(() => validatePopulation(expected, [{ ...row, ok: false }])).toThrow("unsuccessful")
    expect(() => validatePopulation(expected, [{ ...row, ok: true }])).not.toThrow()
  })
})

const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 }
const contentChunk = { choices: [{ index: 0, delta: { role: "assistant", content: "BENCH_OK:65536" }, finish_reason: null }] }
const terminalChunk = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage }

describe("chat qualification oracle", () => {
  test("accepts fixture usage on the terminal or a final usage-only frame", () => {
    expect(verifyChat(200, [contentChunk, terminalChunk], true, true, { donePositions: [2] }).ok).toBe(true)
    expect(verifyChat(200, [contentChunk, { choices: terminalChunk.choices }, { choices: [], usage }], true, true, { donePositions: [3] }).ok).toBe(true)
    expect(verifyChat(200, [{ choices: [{ index: 0, message: { role: "assistant", content: "BENCH_OK:65536" }, finish_reason: "stop" }], usage }], false, false).ok).toBe(true)
  })

  test.each([1, -1, 0.5, undefined])("rejects a nonzero or absent choice index: %s", index => {
    expect(verifyChat(200, [{ choices: [{ index, delta: { role: "assistant", content: "BENCH_OK:65536" }, finish_reason: null }] }, terminalChunk], true, true).ok).toBe(false)
  })

  test.each(["user", "tool", null, undefined])("requires the assistant role: %s", role => {
    expect(verifyChat(200, [{ choices: [{ index: 0, delta: { role, content: "BENCH_OK:65536" }, finish_reason: null }] }, terminalChunk], true, true).ok).toBe(false)
    expect(verifyChat(200, [{ choices: [{ index: 0, message: { role, content: "BENCH_OK:65536" }, finish_reason: "stop" }], usage }], false, false).ok).toBe(false)
  })

  test.each([
    undefined,
    null,
    {},
    { prompt_tokens: 7, completion_tokens: 3, total_tokens: 11 },
    { prompt_tokens: -1, completion_tokens: 3, total_tokens: 2 },
    { prompt_tokens: 7, completion_tokens: 3.5, total_tokens: 10.5 },
    { prompt_tokens: Number.NaN, completion_tokens: 3, total_tokens: 10 },
  ])("rejects missing or corrupted fixture usage: %j", observedUsage => {
    expect(verifyChat(200, [contentChunk, { choices: terminalChunk.choices, usage: observedUsage }], true, true).ok).toBe(false)
  })

  test("rejects choice data after stop, an early stop and duplicate terminal", () => {
    expect(verifyChat(200, [contentChunk, terminalChunk, { choices: [{ index: 0, delta: {}, finish_reason: null }] }], true, true).ok).toBe(false)
    expect(verifyChat(200, [terminalChunk, contentChunk], true, true).ok).toBe(false)
    expect(verifyChat(200, [contentChunk, terminalChunk, terminalChunk], true, true).ok).toBe(false)
    expect(verifyChat(200, [contentChunk, terminalChunk, { choices: [] }], true, true).ok).toBe(false)
  })

  test("rejects extra choices instead of combining their output", () => {
    expect(verifyChat(200, [{ choices: [contentChunk.choices[0], { index: 1, delta: {}, finish_reason: null }] }, terminalChunk], true, true).ok).toBe(false)
  })

  test.each([[], [1], [0, 2], [2, 2], [3], [Number.NaN]].map(donePositions => ({ donePositions })))("rejects missing, repeated or misplaced DONE markers: %j", evidence => {
    expect(verifyChat(200, [contentChunk, terminalChunk], true, true, evidence).ok).toBe(false)
  })

  test("DONE evidence must agree with the parser flag and JSON cannot contain DONE", () => {
    expect(verifyChat(200, [contentChunk, terminalChunk], false, true, { donePositions: [2] }).ok).toBe(false)
    expect(verifyChat(200, [{ choices: [{ index: 0, message: { role: "assistant", content: "BENCH_OK:65536" }, finish_reason: "stop" }], usage }], true, false, { donePositions: [1] }).ok).toBe(false)
  })
})
