// packages/gateway/tests/protection-embeddings-images.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { HTTPError } from "@vibe-llm/provider-llm"
import { runEmbeddingsAttempt } from "../src/data-plane/observability/attempts/embeddings-attempt"
import { runImagesAttempt } from "../src/data-plane/observability/attempts/images-attempt"
import { ProtectionRuntime, setProtectionForTests, type UpstreamOutcome } from "../src/protection/runtime"

const recorded: Array<UpstreamOutcome | Promise<UpstreamOutcome>> = []
beforeEach(() => {
  recorded.length = 0
  setProtectionForTests({ record: (o: UpstreamOutcome | Promise<UpstreamOutcome>) => { recorded.push(o) } } as unknown as ProtectionRuntime)
})
afterEach(() => __resetPlatformForTests())

const base = {
  apiKeyId: undefined, incomingModel: "alias", model: "m-1", modelKey: "m-1", pricing: null, upstream: "up_test_e",
  userAgent: undefined, requestId: undefined, dump: null,
}
const outcomes = () => Promise.all(recorded)

test("embeddings: success, non-2xx and thrown failures are each recorded once; the response is unchanged", async () => {
  const ok = await runEmbeddingsAttempt({ ...base, call: async () => new Response(JSON.stringify({ data: [], usage: { prompt_tokens: 1 } })) })
  expect(ok.ok).toBe(true)
  const limited = await runEmbeddingsAttempt({ ...base, call: async () => new Response(JSON.stringify({ error: { message: "slow down", code: "rate_limit_exceeded" } }), { status: 429 }) })
  expect(limited).toMatchObject({ ok: false, status: 429 })
  if (!limited.ok && "response" in limited) expect(await limited.response.json()).toMatchObject({ error: { message: "slow down" } })
  const httpError = new HTTPError("x", new Response("{}", { status: 401 }))
  await expect(runEmbeddingsAttempt({ ...base, call: async () => { throw httpError } })).rejects.toBe(httpError)
  await expect(runEmbeddingsAttempt({ ...base, call: async () => { throw new TypeError("fetch failed") } })).rejects.toBeInstanceOf(TypeError)
  expect((await outcomes()).map(o => [o.upstreamId, o.keyId, o.model, o.cls, o.status])).toEqual([
    ["up_test_e", "", "m-1", "ok", 200], ["up_test_e", "", "m-1", "rate_limited", 429],
    ["up_test_e", "", "m-1", "auth", 401], ["up_test_e", "", "m-1", "network", 0]])
})

test("images: the same, and success bodies are not disturbed", async () => {
  const ok = await runImagesAttempt({ ...base, call: async () => new Response(JSON.stringify({ data: [] })) })
  expect(ok.ok).toBe(true)
  const rejected = await runImagesAttempt({ ...base, call: async () => new Response(JSON.stringify({ error: { message: "content policy", code: "content_policy_violation" } }), { status: 400 }) })
  expect(rejected).toMatchObject({ ok: false, status: 400 })
  await expect(runImagesAttempt({ ...base, call: async () => { throw new Error("gateway bug") } })).rejects.toThrow("gateway bug")
  expect((await outcomes()).map(o => [o.cls, o.code])).toEqual([["ok", ""], ["rejected", "content_policy_violation"]])
})
