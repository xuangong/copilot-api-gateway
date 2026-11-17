import { afterEach, expect, spyOn, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { selectBindingForChatCompletions } from "../src/data-plane/chat-flow/shared/select-binding.ts"
import { NOW, enforcementFixture } from "./protection-enforcement-fixture"

const closers: Array<() => void> = []
afterEach(() => { for (const close of closers.splice(0)) close(); __resetPlatformForTests() })
const OWNER = "user_test_owner"
/** Upstreams are owned by the caller unless `owned` is false (then they are global, i.e. shared by an admin). */
const fixture = async (ids?: readonly string[], owned = true) => { const f = await enforcementFixture(ids, owned ? { ownerId: OWNER } : {}); closers.push(f.close); return f }
const select = (model = "shared", extra: Record<string, unknown> = {}) => selectBindingForChatCompletions({ model, auth: { ownerId: OWNER }, ...extra })

test("a paused upstream is skipped and the next upstream serves the model", async () => {
  const f = await fixture()
  expect((await select())).toMatchObject({ kind: "ok", binding: { upstream: "up_test_first" } })
  await f.pause({ targetId: "up_test_first" })
  await f.tick() // the other isolate's row is visible after the cache TTL
  expect((await select())).toMatchObject({ kind: "ok", binding: { upstream: "up_test_second" } })
})

test("when every upstream that serves the model is paused the answer is upstream-paused with the earliest resume time", async () => {
  const f = await fixture()
  await f.pause({ targetId: "up_test_first", endsAt: NOW + 600_000 })
  await f.pause({ targetId: "up_test_second", endsAt: NOW + 90_000 })
  await f.tick()
  const result = await select()
  expect(result.kind).toBe("upstream-paused")
  if (result.kind !== "upstream-paused") throw new Error("expected upstream-paused")
  expect(result.retryAfterSeconds).toBe(80) // the earlier end is 90 s after NOW and 10 s have passed
  expect(result.message).toContain('"up_test_first"')
  expect(result.message).toContain('"up_test_second"')
  expect(result.message).toContain(new Date(NOW + 90_000).toISOString())
})

test("a model pinned to a paused upstream is answered as paused, not as missing", async () => {
  const f = await fixture()
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  expect((await select("up_test_first/shared")).kind).toBe("upstream-paused")
  expect((await select("up_test_second/shared")).kind).toBe("ok")
})

test("warnings never block, and an unknown model is still model-not-found", async () => {
  const f = await fixture()
  await f.pause({ targetId: "up_test_first", mode: "notify" })
  await f.tick()
  expect((await select())).toMatchObject({ kind: "ok", binding: { upstream: "up_test_first" } })
  expect((await select("nope")).kind).toBe("model-not-found")
})

test("resuming restores service at once on this isolate; a fresh pause is enforced only after the cache TTL elsewhere", async () => {
  const f = await fixture(["up_test_first"])
  expect((await select()).kind).toBe("ok") // warms the cache with no rows
  const row = await f.pause({ targetId: "up_test_first" })
  expect((await select()).kind).toBe("ok") // not refreshed yet: within 10 s
  await f.tick()
  expect((await select()).kind).toBe("upstream-paused")
  expect(await f.runtime.resume(row.id, "owner")).toBe(true)
  expect((await select()).kind).toBe("ok")
})

test("paused-upstream selection does not hide the upstream's models from listings", async () => {
  const f = await fixture(["up_test_first"], false)
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  const { listProviderBindings } = await import("../src/data-plane/providers/registry.ts")
  expect((await listProviderBindings()).map(b => b.upstream)).toContain("up_test_first")
})

test("a paused upstream the caller does not own is not named", async () => {
  const f = await fixture(["up_test_first"], false)
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  const result = await select()
  expect(result.kind).toBe("upstream-paused")
  if (result.kind !== "upstream-paused") throw new Error("expected upstream-paused")
  expect(result.message).not.toContain("up_test_first")
  expect(result.message).toContain("An upstream is paused")
  expect(result.message).toContain(new Date(NOW + 600_000).toISOString())
})

test("a mix of owned and shared paused upstreams names only the owned one", async () => {
  const f = await fixture(["up_test_first"])
  await f.repo.upstreams.save({ ...(await f.repo.upstreams.list({ ownerId: OWNER as never }))[0]!, id: "up_test_shared", ownerId: undefined, name: "up_test_shared" } as never)
  await f.pause({ targetId: "up_test_first" })
  await f.pause({ targetId: "up_test_shared" })
  await f.tick()
  const result = await select()
  if (result.kind !== "upstream-paused") throw new Error(`expected upstream-paused, got ${result.kind}`)
  expect(result.message).toContain('"up_test_first"')
  expect(result.message).not.toContain("up_test_shared")
})

/** A route-constrained request whose state is bound to `allowed` only; everything else fails proof. */
const boundTo = (allowed: string) => ({
  analysis: {
    hasRouteConstraints: true, hasRequiredOwned: false,
    prepareSource: () => ({ messages: [{ role: "user", content: "hi" }] }),
    rankAuthorizedCandidates: (prepared: Array<{ candidate: { binding: { upstream: string } }; target: unknown }>) => prepared.filter(item => item.candidate.binding.upstream === allowed),
    materialize: () => ({}),
  },
  execution: { protocol: "chat_completions", plaintextCompactions: new Set() },
})

test("an affinity bound to a paused upstream is answered as paused", async () => {
  const f = await fixture()
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  const result = await select("shared", { affinity: boundTo("up_test_first") })
  if (result.kind !== "upstream-paused") throw new Error(`expected upstream-paused, got ${result.kind}`)
  expect(result.message).toContain('"up_test_first"')
})

test("an affinity that fails for an unrelated reason keeps its error although another candidate is paused", async () => {
  const f = await fixture()
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  await expect(select("shared", { affinity: boundTo("up_test_gone") })).rejects.toThrow("opaque state")
  await expect(select("shared", { affinity: boundTo("up_test_second") })).resolves.toMatchObject({ kind: "ok", binding: { upstream: "up_test_second" } })
})

test("an unprovable affinity with nothing paused keeps its error", async () => {
  await fixture(["up_test_first"])
  await expect(select("shared", { affinity: {} })).rejects.toThrow("opaque state")
})

test("a paused candidate wins over an unrelated failed catalog", async () => {
  const f = await fixture(["up_test_first"])
  await f.repo.upstreams.save({ ...(await f.repo.upstreams.list({ ownerId: OWNER as never }))[0]!, id: "up_test_broken", name: "up_test_broken", config: { name: "up_test_broken", baseUrl: "https://up_test_broken.invalid", authStyle: "none", endpoints: ["chat_completions"], models: 5 } } as never)
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  try {
    expect((await select("nope")).kind).toBe("catalog-unavailable") // the broken catalog is a real failure
    await f.pause({ targetId: "up_test_first" })
    await f.tick()
    expect((await select()).kind).toBe("upstream-paused")
  } finally { warn.mockRestore() }
})
