import { beforeEach, describe, expect, test } from "bun:test"

import {
  __test,
  applySpottedConnectionFixes,
  collectAndFixConnectionMismatch,
  isConnectionMismatchErrorBody,
  withConnectionMismatchRetry,
} from "../src/services/copilot/connection-mismatch"

beforeEach(() => {
  __test.clearSpotted()
})

const longB64 = "aGVsbG8td29ybGQtdGhpcy1pcy1iYXNlNjQtZW5jb2RlZA==" // > 20 chars decodable

describe("connection-mismatch helpers", () => {
  test("isBase64Id rejects short and undecodable IDs", () => {
    expect(__test.isBase64Id("short")).toBe(false)
    expect(__test.isBase64Id("not-base-64-!!!@@@@@@@@@@@")).toBe(false)
    expect(__test.isBase64Id(longB64)).toBe(true)
  })

  test("isConnectionMismatchErrorBody matches known phrasings", () => {
    expect(isConnectionMismatchErrorBody({ error: { message: "input item ID does not belong to this connection" } })).toBe(true)
    expect(isConnectionMismatchErrorBody({ error: { message: "INPUT ITEM does not belong to this connection." } })).toBe(true)
    expect(isConnectionMismatchErrorBody({ error: { message: "some other error" } })).toBe(false)
    expect(isConnectionMismatchErrorBody({})).toBe(false)
  })

  test("collectAndFixConnectionMismatch replaces base64 IDs with hash-derived ones", async () => {
    const payload = {
      input: [
        { id: longB64, type: "message" },
        { id: "msg_keep", type: "message" },
      ],
    }
    const changed = await collectAndFixConnectionMismatch(payload)
    expect(changed).toBe(true)
    const items = payload.input as Array<{ id: string; type: string }>
    expect(items[0].id).toMatch(/^msg_[0-9a-f]{16}$/)
    expect(items[1].id).toBe("msg_keep")
  })

  test("collectAndFixConnectionMismatch drops item_reference items with base64 IDs", async () => {
    const payload = {
      input: [
        { id: longB64, type: "item_reference" },
        { id: "fc_keep", type: "function_call" },
      ],
    }
    await collectAndFixConnectionMismatch(payload)
    const items = payload.input as Array<{ id: string }>
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe("fc_keep")
  })

  test("applySpottedConnectionFixes uses prior spots without re-detecting", async () => {
    __test.spotMark(longB64)
    const payload = { input: [{ id: longB64, type: "reasoning" }] }
    const changed = await applySpottedConnectionFixes(payload)
    expect(changed).toBe(true)
    const items = payload.input as Array<{ id: string }>
    expect(items[0].id).toMatch(/^rs_[0-9a-f]{16}$/)
  })
})

describe("withConnectionMismatchRetry", () => {
  test("returns success response unchanged", async () => {
    const payload = { input: [{ id: "msg_a", type: "message" }] }
    let calls = 0
    const result = await withConnectionMismatchRetry(payload, async () => {
      calls++
      return new Response("ok", { status: 200 })
    })
    expect(calls).toBe(1)
    expect(await result.text()).toBe("ok")
  })

  test("retries once on connection-mismatch error after fixing payload", async () => {
    const payload = { input: [{ id: longB64, type: "message" }] }
    let calls = 0
    const result = await withConnectionMismatchRetry(payload, async (p) => {
      calls++
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { message: "input item ID does not belong to this connection" } }),
          { status: 400 },
        )
      }
      const items = (p.input as Array<{ id: string }>) ?? []
      expect(items[0].id).toMatch(/^msg_[0-9a-f]{16}$/)
      return new Response("recovered", { status: 200 })
    })
    expect(calls).toBe(2)
    expect(await result.text()).toBe("recovered")
  })

  test("does not retry on unrelated 4xx errors", async () => {
    const payload = { input: [{ id: longB64, type: "message" }] }
    let calls = 0
    const result = await withConnectionMismatchRetry(payload, async () => {
      calls++
      return new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 429 })
    })
    expect(calls).toBe(1)
    expect(result.status).toBe(429)
  })

  test("does not retry when payload has no base64 IDs to fix", async () => {
    const payload = { input: [{ id: "msg_short", type: "message" }] }
    let calls = 0
    await withConnectionMismatchRetry(payload, async () => {
      calls++
      return new Response(
        JSON.stringify({ error: { message: "input item ID does not belong to this connection" } }),
        { status: 400 },
      )
    })
    expect(calls).toBe(1)
  })
})
