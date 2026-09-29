import { expect, test } from "bun:test"
import { canSetup, SetupRequestGate, setupScope, staticSetupCommand } from "./setup-state"
test("assigned-only viewers never receive setup controls", () => {
  const session = { ok: true as const, isAdmin: false, isUser: true, userId: "owner" }
  expect(canSetup({ owner_id: "owner", is_owner: true }, session)).toBe(true)
  expect(canSetup({ owner_id: "other", is_owner: false }, session)).toBe(false)
  expect(canSetup({ owner_id: null, is_owner: true }, session)).toBe(false)
  expect(canSetup({ owner_id: "other", is_owner: true }, session)).toBe(false)
  expect(canSetup({ owner_id: null, is_owner: false }, { ...session, isAdmin: true })).toBe(true)
  expect(canSetup({ owner_id: "owner", is_owner: true }, null)).toBe(false)
})
test("stale preview requests cannot re-enable mint for changed selection", () => {
  const gate = new SetupRequestGate()
  const ticket = gate.begin()
  gate.invalidate()
  expect(gate.accepts(ticket)).toBe(false)
  expect(gate.accepts(gate.begin())).toBe(true)
  expect(setupScope("key", { client: "codex", platform: "posix", settings: { model: null } })).not.toBe(setupScope("key", { client: "codex", platform: "posix", settings: { model: "new" } }))
})
test("static commands contain only the fixed URL and safely quoted public origin", () => {
  expect(staticSetupCommand("https://gateway.invalid", "posix")).toContain("https://gateway.invalid/setup/setup.sh")
  const windows = staticSetupCommand("https://gateway.invalid", "windows")
  expect(windows).toContain("https://gateway.invalid/setup/setup.ps1")
  expect(windows).not.toMatch(/iex|leaseToken|stl_/)
  expect(() => staticSetupCommand("https://gateway.invalid/path", "posix")).toThrow()
})

test("a delayed mint retains its original selection and revoke ID after the active model changes", async () => {
  const { bindMintedLease } = await import("./setup-state")
  const selection = { client: "codex" as const, platform: "posix" as const, settings: { model: "old" } }
  const scope = setupScope("key", selection)
  const active = setupScope("key", { ...selection, settings: { model: "new" } })
  const lease = bindMintedLease(scope, selection, { version: 1, client: "codex", platform: "posix", configurationRevision: 4, artifactDigest: "d".repeat(64), redactedArtifact: { model: "old" }, touchedKeys: [] }, { leaseId: "11111111-2222-4333-8444-555555555555", leaseToken: "stl_" + "a".repeat(64), expiresAt: "2099-01-01", artifactDigest: "d".repeat(64) })
  selection.settings.model = "new"
  expect(lease.scope).not.toBe(active)
  expect(lease.selection.settings.model).toBe("old")
  expect(lease.preview.redactedArtifact).toEqual({ model: "old" })
  expect(lease.leaseId).toBe("11111111-2222-4333-8444-555555555555")
})
