import { describe, expect, test } from "bun:test"
import { applyLokiSyncUpdate, parseLokiSyncUpdate, publicLokiStatus, readLokiState, type LokiState } from "../state"

const now = 1_800_000_000_000
const account = { homeAccountId: "test-home-account", tenantId: "11111111-1111-4111-8111-111111111111" }
const empty = (): LokiState => ({ version: 1, profileId: "loki-df-v1", generation: "generation-one", syncSecretHash: "test-secret-hash", revision: 0, assistantStatus: "waiting" })
const update = (overrides: Record<string, unknown> = {}) => parseLokiSyncUpdate({
  version: 1, generation: "generation-one", expectedRevision: 0, requestId: "request-one", status: "authorized",
  credential: { accessToken: "test-access-token", tokenType: "Bearer", expiresAt: now + 3_600_000, account }, ...overrides,
})

describe("Loki synchronization state", () => {
  test("first accepted upload binds identity and advances revision", () => {
    const initial = empty()
    const accepted = applyLokiSyncUpdate(initial, update(), "payload-one", now)
    expect(accepted.revision).toBe(1)
    expect(accepted.account).toEqual(account)
    expect(accepted.credential?.accessToken).toBe("test-access-token")
    expect(initial.revision).toBe(0)
  })

  test("an old generation cannot change a replacement binding", () => {
    expect(() => applyLokiSyncUpdate({ ...empty(), generation: "replacement" }, update(), "hash", now)).toThrow("binding_replaced")
  })

  test("a concurrent result cannot overwrite a newer revision", () => {
    const accepted = applyLokiSyncUpdate(empty(), update(), "payload-one", now)
    expect(() => applyLokiSyncUpdate(accepted, update({ requestId: "request-two" }), "payload-two", now)).toThrow("revision_conflict")
  })

  test("identical retry returns the same accepted state even after expiry", () => {
    const accepted = applyLokiSyncUpdate(empty(), update(), "payload-one", now)
    expect(applyLokiSyncUpdate(accepted, update(), "payload-one", now + 4_000_000)).toBe(accepted)
    expect(() => applyLokiSyncUpdate(accepted, update(), "different-payload", now)).toThrow("request_conflict")
  })

  test("silent renewal cannot change the bound account", () => {
    const accepted = applyLokiSyncUpdate(empty(), update(), "payload-one", now)
    const switched = update({ requestId: "request-two", expectedRevision: 1, credential: {
      accessToken: "other-token", tokenType: "Bearer", expiresAt: now + 7_200_000,
      account: { ...account, homeAccountId: "other-account" },
    } })
    expect(() => applyLokiSyncUpdate(accepted, switched, "payload-two", now)).toThrow("account_mismatch")
  })

  test("rejects credentials with less than a minute remaining", () => {
    const expiring = update({ credential: { accessToken: "test", tokenType: "Bearer", expiresAt: now + 59_999, account } })
    expect(() => applyLokiSyncUpdate(empty(), expiring, "hash", now)).toThrow("credential_expired")
  })

  test("reauthentication status retains an already accepted valid token", () => {
    const accepted = applyLokiSyncUpdate(empty(), update(), "payload-one", now)
    const status = parseLokiSyncUpdate({ version: 1, generation: "generation-one", expectedRevision: 1,
      requestId: "request-two", status: "interaction_required", errorCode: "interaction_required" })
    const waiting = applyLokiSyncUpdate(accepted, status, "payload-two", now)
    expect(waiting.credential).toEqual(accepted.credential)
    expect(publicLokiStatus(waiting, now)).toMatchObject({ assistantStatus: "interaction_required", tokenStatus: "valid" })
    expect(publicLokiStatus(waiting, now + 4_000_000)).toMatchObject({ tokenStatus: "expired" })
  })

  test("public status never contains credential, identity or synchronization secret", () => {
    const accepted = applyLokiSyncUpdate(empty(), update(), "payload-one", now)
    const serialized = JSON.stringify(publicLokiStatus(accepted, now))
    for (const value of ["test-access-token", "test-secret-hash", "test-home-account", account.tenantId]) expect(serialized).not.toContain(value)
  })

  test("wire parser rejects malformed or ambiguous credentials", () => {
    for (const credential of [undefined, {}, { accessToken: "", tokenType: "Bearer", expiresAt: now + 3_600_000, account },
      { accessToken: "test", tokenType: "PoP", expiresAt: now + 3_600_000, account },
      { accessToken: "test", tokenType: "Bearer", expiresAt: "tomorrow", account }]) {
      expect(() => update({ credential })).toThrow("invalid_request")
    }
    expect(() => update({ expectedRevision: -1 })).toThrow("invalid_request")
    expect(() => update({ status: "failed" })).toThrow("invalid_request")
    expect(() => update({ extra: "not-in-contract" })).toThrow("invalid_request")
    for (const status of [["authorized"], {}, 1, null]) {
      expect(() => update({ status })).toThrow("invalid_request")
      expect(() => readLokiState({ ...empty(), assistantStatus: status })).toThrow("invalid_request")
    }
  })
})
