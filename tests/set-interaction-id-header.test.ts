import { test, expect, describe } from "bun:test"

import { setInteractionIdHeader } from "~/transforms/set-interaction-id-header"
import type { AnthropicMessagesPayload } from "~/transforms/types"

const payloadWith = (userId: string | undefined): AnthropicMessagesPayload => ({
  model: "claude-test",
  max_tokens: 10,
  messages: [{ role: "user", content: "hi" }],
  ...(userId !== undefined ? { metadata: { user_id: userId } } : {}),
}) as unknown as AnthropicMessagesPayload

// Known SHA-256 → UUID v4 vectors, computed once by hand and stored here so
// any drift in the hashing or UUID-formatting logic surfaces as a clear
// regression. Lifted from copilot-gateway/Floway's interceptor tests.
const SESS_LEGACY_UUID = "d24fc06b-7a2c-4623-8a31-6ec796e11db4"
const SESS_JSON_UUID = "da2e7508-8445-4801-9283-91a8df330635"
const SESS_ALONE_UUID = "19be0c9e-9a65-43eb-be80-efb2770d4510"

describe("setInteractionIdHeader", () => {
  test("forwards SHA-256 UUID for legacy fingerprint with both halves", async () => {
    const headers: Record<string, string> = {}
    const ok = await setInteractionIdHeader(
      payloadWith("user_acct-1_account__session_sess-legacy"),
      headers,
    )
    expect(ok).toBe(true)
    expect(headers["x-interaction-id"]).toBe(SESS_LEGACY_UUID)
  })

  test("forwards SHA-256 UUID for JSON fingerprint carrying session_id", async () => {
    const headers: Record<string, string> = {}
    await setInteractionIdHeader(
      payloadWith(JSON.stringify({ device_id: "dev", session_id: "sess-json" })),
      headers,
    )
    expect(headers["x-interaction-id"]).toBe(SESS_JSON_UUID)
  })

  test("forwards UUID even when only sessionId half is parseable (OpenCode shape)", async () => {
    const headers: Record<string, string> = {}
    await setInteractionIdHeader(
      payloadWith(JSON.stringify({ session_id: "sess-alone" })),
      headers,
    )
    expect(headers["x-interaction-id"]).toBe(SESS_ALONE_UUID)
  })

  test("hashing is deterministic across repeated invocations", async () => {
    const a: Record<string, string> = {}
    const b: Record<string, string> = {}
    await setInteractionIdHeader(payloadWith(JSON.stringify({ session_id: "sess-alone" })), a)
    await setInteractionIdHeader(payloadWith(JSON.stringify({ session_id: "sess-alone" })), b)
    expect(a["x-interaction-id"]).toBe(b["x-interaction-id"])
  })

  test("UUID v4 shape (8-4-4-4-12 hex with version + variant bits)", async () => {
    const headers: Record<string, string> = {}
    await setInteractionIdHeader(
      payloadWith(JSON.stringify({ session_id: "sess-shape-check" })),
      headers,
    )
    expect(headers["x-interaction-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test("absent when metadata.user_id is missing", async () => {
    const headers: Record<string, string> = {}
    const ok = await setInteractionIdHeader(payloadWith(undefined), headers)
    expect(ok).toBe(false)
    expect("x-interaction-id" in headers).toBe(false)
  })

  test("absent when metadata.user_id has no session marker", async () => {
    const headers: Record<string, string> = {}
    const ok = await setInteractionIdHeader(payloadWith("user_acct-1_account"), headers)
    expect(ok).toBe(false)
    expect("x-interaction-id" in headers).toBe(false)
  })
})
