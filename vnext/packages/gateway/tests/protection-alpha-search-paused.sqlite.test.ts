import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { resolveAlphaSearchDispatcher } from "../src/data-plane/tools/web-search/alpha-search/upstream.ts"
import { UpstreamPausedError } from "../src/data-plane/errors/upstream-paused.ts"
import { enforcementFixture } from "./protection-enforcement-fixture"

let close: () => void = () => {}
afterEach(() => { close(); __resetPlatformForTests() })
const OWNER = "user_test_owner"

test("a paused pinned upstream answers 503 upstream_paused with Retry-After instead of a scope error", async () => {
  const f = await enforcementFixture(["up_test_first"], { ownerId: OWNER })
  close = f.close
  await f.pause({ targetId: "up_test_first" })
  await f.tick()
  const error = await resolveAlphaSearchDispatcher({ config: { upstreamId: "up_test_first", model: "shared" }, auth: { userId: OWNER } as never }).catch(e => e)
  expect(error).toBeInstanceOf(UpstreamPausedError)
  const response = (error as UpstreamPausedError).getResponse()
  expect([response.status, response.headers.get("retry-after")]).toEqual([503, "590"])
  expect(await response.json()).toMatchObject({ error: { code: "upstream_paused" } })
})

test("an unpaused or warned upstream still resolves", async () => {
  const f = await enforcementFixture(["up_test_first"], { ownerId: OWNER })
  close = f.close
  await f.pause({ targetId: "up_test_first", mode: "notify" })
  await f.tick()
  const dispatch = await resolveAlphaSearchDispatcher({ config: { upstreamId: "up_test_first", model: "shared" }, auth: { userId: OWNER } as never })
  expect(typeof dispatch).toBe("function")
})
