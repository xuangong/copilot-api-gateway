/**
 * The configuration identity of an upstream ignores advisory quota telemetry
 * (`accounts[].quotaSnapshot`), so a quota refresh does not look like a
 * configuration change — for any provider whose state carries accounts, not a
 * hard-coded list of kinds.
 */
import { expect, test } from "bun:test"
import { upstreamConfiguration } from "../../src/repo/upstream-configuration.ts"
import type { UpstreamRecord } from "../../src/repo/types.ts"

const row = (provider: string, quota: unknown, updatedAt = "t1") => ({
  id: "up", provider, name: "up", enabled: true, sortOrder: 0, config: { a: 1 }, flagOverrides: {}, disabledPublicModelIds: [],
  proxyFallbackList: [], createdAt: "t0", updatedAt, state: { accounts: [{ id: "acc", quotaSnapshot: quota }] },
}) as unknown as UpstreamRecord<unknown>

test.each(["codex", "claude-code", "custom"])("%s: quota snapshots and updatedAt do not change the configuration identity", provider => {
  expect(upstreamConfiguration(row(provider, { used: 1 }, "t1"))).toBe(upstreamConfiguration(row(provider, { used: 99 }, "t2")))
})

test("other state still changes the configuration identity", () => {
  const changed = { ...row("codex", {}), state: { accounts: [{ id: "other" }] } } as UpstreamRecord<unknown>
  expect(upstreamConfiguration(changed)).not.toBe(upstreamConfiguration(row("codex", {})))
})
