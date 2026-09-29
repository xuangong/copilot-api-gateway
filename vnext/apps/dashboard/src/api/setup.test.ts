import { afterEach, expect, spyOn, test } from "bun:test"
import { mintSetup, previewSetup, revokeSetup } from "./setup"
import type { SetupSelection } from "./setup"
const original = globalThis.fetch
const selection: SetupSelection = { client: "codex", platform: "posix", settings: { model: 'mapped-"模型"\nline' } }
afterEach(() => { globalThis.fetch = original })
test("setup calls preserve selection, use preview revision/digest, and revoke only a UUID", async () => {
  const calls: { path: string; options?: RequestInit }[] = []
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(async (input: URL | RequestInfo, options?: RequestInit) => {
    calls.push({ path: String(input), options })
    return Response.json({ ok: true })
  }, { preconnect: fetch.preconnect }))
  await previewSetup("key/id", selection)
  await mintSetup("key/id", selection, { version: 1, client: "codex", platform: "posix", artifactDigest: "a".repeat(64), configurationRevision: 12, redactedArtifact: {}, touchedKeys: [] })
  await revokeSetup("key/id", "11111111-2222-4333-8444-555555555555")
  expect(calls[0]?.path).toBe("/api/keys/key%2Fid/setup/preview")
  expect(JSON.parse(String(calls[0]?.options?.body))).toEqual(selection)
  expect(JSON.parse(String(calls[1]?.options?.body))).toEqual({ ...selection, expectedConfigurationRevision: 12, expectedArtifactDigest: "a".repeat(64) })
  expect(calls[2]).toMatchObject({ path: "/api/keys/key%2Fid/setup/leases/11111111-2222-4333-8444-555555555555", options: { method: "DELETE", credentials: "include" } })
  expect(calls[2]?.options?.body).toBeUndefined()
  expect(() => revokeSetup("key/id", "stl_" + "a".repeat(64))).toThrow()
})
