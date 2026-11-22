// packages/gateway/tests/quota-balance-session.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { __resetPlatformForTests, initRuntimeLocation } from "@vibe-core/platform"
import { withBalanceSession } from "../src/data-plane/chat-flow/shared/balance-session"
import { kitDeps } from "../src/data-plane/chat-flow/shared/kit-deps"
import { resolveSessionKey } from "../src/quota-balance/session-key"

beforeEach(() => { initRuntimeLocation("bun") })
afterEach(() => { __resetPlatformForTests() })

test("withBalanceSession reads the identity from the body and headers and keeps the rest of the auth context", async () => {
  const auth = { userId: "user_test_1" as never, apiKeyId: "key_test_1" as never, routingPolicy: undefined }
  const out = withBalanceSession(auth, "chat_completions", { prompt_cache_key: "conv-7", messages: [{ role: "user", content: "x" }] }, new Headers())
  expect(out).toMatchObject({ userId: "user_test_1", apiKeyId: "key_test_1" })
  expect(out.balanceSession?.input).toEqual({ apiKeyId: "key_test_1", explicitId: "conv-7", fingerprint: expect.any(String) })
  expect(await resolveSessionKey(out.balanceSession!)).toMatch(/^[0-9a-f]{32}$/)
  expect(auth).not.toHaveProperty("balanceSession") // the original context is not mutated
})

test("a body that cannot be read leaves the context alone", () => {
  const auth = { apiKeyId: "key_test_1" as never }
  expect(withBalanceSession(auth, "messages", { messages: [] }, undefined).balanceSession?.input.explicitId).toBeNull()
})

test("the telemetry context carries the session, which is how the cost hook finds it", () => {
  const session = { input: { apiKeyId: "k", explicitId: "e", fingerprint: null } }
  const ctx = kitDeps.buildTelemetryCtx({
    auth: { apiKeyId: "key_test_1", balanceSession: session } as never, obsCtx: {} as never, extra: { incomingModel: "m" }, isStreaming: false, requestStartedAt: 0, endpointTag: "chat_completions",
  } as never)
  expect(ctx.quotaSession).toBe(session)
})
