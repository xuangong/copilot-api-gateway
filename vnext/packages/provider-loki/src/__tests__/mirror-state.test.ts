import { expect, test } from "bun:test"
import { addLokiMirror, applyLokiMirrorPull, LOKI_MAX_MIRRORS, newLokiMirrorState, parseLokiMirrorSource,
  readLokiState, removeLokiMirror, touchLokiMirror, usableLokiCredential, type LokiMirror, type LokiState } from "../state"

const now = 1_800_000_000_000
const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const credential = (expiresAt = now + 3_600_000, acct = account) =>
  ({ accessToken: "token", tokenType: "Bearer" as const, expiresAt, account: acct })
const central = (): LokiState => ({ version: 1, profileId: "loki-df-v1", generation: "g", syncSecretHash: "h",
  revision: 1, assistantStatus: "authorized", account, credential: credential() })
const mirror = (n: number): LokiMirror => ({ id: `lkmid_${n.toString(16).padStart(32, "0")}`, label: `Device ${n}`,
  secretHash: "a".repeat(64), createdAt: now })
const source = { kind: "mirror" as const, origin: "https://central.example", upstreamId: "up_loki_central",
  mirrorId: `lkmid_${"b".repeat(32)}`, mirrorSecret: `lkm_${"c".repeat(64)}` }

test("mirrors and source survive a state round-trip and reject unknown fields", () => {
  const state = { ...addLokiMirror(central(), mirror(1)) }
  expect(readLokiState(JSON.parse(JSON.stringify(state))).mirrors).toEqual([mirror(1)])
  const device = newLokiMirrorState(source, credential(), now)
  expect(readLokiState(JSON.parse(JSON.stringify(device))).source).toEqual(source)
  expect(() => readLokiState({ ...state, mirrors: [{ ...mirror(1), extra: 1 }] })).toThrow("invalid_request")
  expect(() => readLokiState({ ...device, source: { ...source, mirrorSecret: "lks_" + "c".repeat(64) } })).toThrow("invalid_request")
  expect(readLokiState({ ...device, errorCode: "mirror_revoked" }).errorCode).toBe("mirror_revoked")
})

test("mirror source origins must be bare HTTPS origins", () => {
  expect(parseLokiMirrorSource({ ...source, origin: "https://central.example/" }).origin).toBe("https://central.example")
  for (const origin of ["http://central.example", "https://u:p@central.example", "https://central.example/path",
    "https://central.example?q=1", "https://central.example#f", "https://central.example?", "https://central.example#", "not a url"]) {
    expect(() => parseLokiMirrorSource({ ...source, origin })).toThrow("invalid_request")
  }
})

test("issuing is limited, unsupported on mirror upstreams, and revocation needs a known id", () => {
  let state = central()
  for (let n = 0; n < LOKI_MAX_MIRRORS; n++) state = addLokiMirror(state, mirror(n))
  expect(() => addLokiMirror(state, mirror(99))).toThrow("mirror_limit")
  expect(() => addLokiMirror(newLokiMirrorState(source, undefined, now), mirror(1))).toThrow("mirror_unsupported")
  expect(() => removeLokiMirror(state, mirror(99).id)).toThrow("mirror_not_found")
  expect(removeLokiMirror(addLokiMirror(central(), mirror(1)), mirror(1).id).mirrors).toBeUndefined()
})

test("touch records the pull time only for an existing mirror", () => {
  const state = addLokiMirror(central(), mirror(1))
  expect(touchLokiMirror(state, mirror(1).id, now + 5).mirrors?.[0]?.lastPulledAt).toBe(now + 5)
  expect(touchLokiMirror(state, mirror(2).id, now + 5)).toBe(state)
})

test("pull outcomes bind the account, record revocation and refuse another account", () => {
  const device = newLokiMirrorState(source, undefined, now)
  expect(device).toMatchObject({ syncSecretHash: "", assistantStatus: "waiting", source })
  const bound = applyLokiMirrorPull(device, source, { kind: "ok", credential: credential() }, now)
  expect(bound).toMatchObject({ assistantStatus: "authorized", account, updatedAt: now })
  expect(usableLokiCredential(bound, now)?.accessToken).toBe("token")
  const other = { homeAccountId: "other", tenantId: account.tenantId }
  const mismatch = applyLokiMirrorPull(bound, source, { kind: "ok", credential: credential(now + 7_200_000, other) }, now)
  expect(mismatch.errorCode).toBe("account_mismatch")
  expect(mismatch.credential?.account).toEqual(account)
  expect(applyLokiMirrorPull(bound, source, { kind: "revoked" }, now).errorCode).toBe("mirror_revoked")
  const reimported = { ...source, mirrorId: `lkmid_${"d".repeat(32)}` }
  expect(applyLokiMirrorPull(bound, reimported, { kind: "revoked" }, now)).toBe(bound)
})

test("usable credentials must be unexpired and match the bound account", () => {
  const bound = applyLokiMirrorPull(newLokiMirrorState(source, undefined, now), source, { kind: "ok", credential: credential() }, now)
  expect(usableLokiCredential(bound, now + 3_600_000)).toBeUndefined()
  expect(usableLokiCredential({ ...bound, account: { ...account, homeAccountId: "x" } }, now)).toBeUndefined()
})

test("state parsing rejects too many, duplicate, or mixed mirrors and sources", () => {
  const base = central()
  const many = Array.from({ length: LOKI_MAX_MIRRORS + 1 }, (_, n) => mirror(n))
  expect(() => readLokiState({ ...base, mirrors: many })).toThrow("invalid_request")
  expect(() => readLokiState({ ...base, mirrors: [mirror(1)], source })).toThrow("invalid_request")
  expect(() => readLokiState({ ...base, mirrors: [mirror(1), mirror(1)] })).toThrow("invalid_request")
})

test("a successful pull clears a previous revocation and short-lived credentials are ignored", () => {
  const device = newLokiMirrorState(source, undefined, now)
  const revoked = applyLokiMirrorPull(device, source, { kind: "revoked" }, now)
  expect(revoked.errorCode).toBe("mirror_revoked")
  const ok = applyLokiMirrorPull(revoked, source, { kind: "ok", credential: credential() }, now + 1)
  expect(ok.errorCode).toBeUndefined()
  expect(ok.assistantStatus).toBe("authorized")
  expect(applyLokiMirrorPull(device, source, { kind: "ok", credential: credential(now + 60_000) }, now)).toBe(device)
})
