import { afterEach, expect, spyOn, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { resolveBinding } from "../src/data-plane/routing/binding-resolver.ts"
import { ModelCatalogUnavailableError } from "../src/data-plane/errors/model-catalog.ts"
import { UpstreamPausedError } from "../src/data-plane/errors/upstream-paused.ts"
import { NOW, enforcementFixture } from "./protection-enforcement-fixture"

const closers: Array<() => void> = []
afterEach(() => { for (const close of closers.splice(0)) close(); __resetPlatformForTests() })
const OWNER = "user_test_owner"
const own = { ownerId: OWNER }
const fixture = async (ids?: readonly string[], owned = true) => { const f = await enforcementFixture(ids, owned ? { ownerId: OWNER } : {}); closers.push(f.close); return f }

test("a paused upstream is skipped and the next one serves the endpoint", async () => {
  const f = await fixture()
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  expect((await resolveBinding("shared", "embeddings", own))?.upstream).toBe("up_test_second")
})

test("when every candidate is paused a 503 with Retry-After and the upstream_paused code is thrown", async () => {
  const f = await fixture(["up_test_first"])
  await f.pause({ targetId: "up_test_first", endsAt: NOW + 90_000 })
  await f.tick()
  const error = await resolveBinding("shared", "embeddings", own).catch(e => e)
  expect(error).toBeInstanceOf(UpstreamPausedError)
  const response = (error as UpstreamPausedError).getResponse()
  expect(response.status).toBe(503)
  expect(response.headers.get("retry-after")).toBe("80")
  const body = await response.json() as { error: { type: string; code: string; message: string } }
  expect(body.error).toMatchObject({ type: "api_error", code: "upstream_paused" })
  expect(body.error.message).toContain('"up_test_first"')
})

test("the Gemini error format keeps the Google RPC body and adds the header", async () => {
  const f = await fixture(["up_test_first"])
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  const error = await resolveBinding("shared", "embeddings", { ...own, errorFormat: "gemini" }).catch(e => e) as UpstreamPausedError
  const response = error.getResponse()
  expect(response.headers.get("retry-after")).not.toBeNull()
  expect(((await response.json()) as { error: { code: number } }).error.code).toBe(503)
})

test("a missing model is still null, and a warning row never blocks", async () => {
  const f = await fixture(["up_test_first"])
  await f.pause({ targetId: "up_test_first", mode: "notify" })
  await f.tick()
  expect(await resolveBinding("nope", "embeddings", own)).toBeNull()
  expect((await resolveBinding("shared", "embeddings", own))?.upstream).toBe("up_test_first")
})

test("an upstream the caller does not own is not named", async () => {
  const f = await fixture(["up_test_first"], false)
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  const error = await resolveBinding("shared", "embeddings", own).catch(e => e) as UpstreamPausedError
  const body = await error.getResponse().json() as { error: { message: string } }
  expect(body.error.message).not.toContain("up_test_first")
  expect(body.error.message).toContain("An upstream is paused")
})

test("the Anthropic error format adds the top-level error type", async () => {
  const f = await fixture(["up_test_first"])
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  const error = await resolveBinding("shared", "embeddings", { ...own, errorFormat: "anthropic" } as never).catch(e => e) as UpstreamPausedError
  const response = error.getResponse()
  expect(response.headers.get("retry-after")).not.toBeNull()
  expect(await response.json()).toMatchObject({ type: "error", error: { type: "api_error", code: "upstream_paused" } })
})

test("a paused candidate wins over an unrelated failed catalog", async () => {
  const f = await fixture(["up_test_first"])
  await f.repo.upstreams.save({ ...(await f.repo.upstreams.list({ ownerId: OWNER as never }))[0]!, id: "up_test_broken", name: "up_test_broken", config: { name: "up_test_broken", baseUrl: "https://up_test_broken.invalid", authStyle: "none", endpoints: ["embeddings"], models: 5 } } as never)
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    expect(await resolveBinding("nope", "embeddings", own).catch(e => e)).toBeInstanceOf(ModelCatalogUnavailableError) // the broken catalog is a real failure
    await f.pause({ targetId: "up_test_first" })
    await f.tick()
    expect(await resolveBinding("shared", "embeddings", own).catch(e => e)).toBeInstanceOf(UpstreamPausedError)
  } finally { warn.mockRestore() }
})
