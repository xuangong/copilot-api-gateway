# Loki Device Mirror Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each local gateway pull the central gateway's Loki access token through a per-device, read-only mirror secret, so clients call Loki and Copilot directly instead of through the VM-hosted proxy.

**Architecture:** The central Loki upstream's state gains a `mirrors` list (hashed secrets). A new unauthenticated `GET /api/loki/mirror/:id` returns the current credential to a holder of a mirror secret. A device's Loki upstream state gains a `source`; its `LokiProvider.credential()` lazily pulls from the central gateway when the stored token has five minutes or less left, with single-flight, stale-token fallback and a 30-second failure backoff. Session-guarded management routes and dashboard UI issue, list, revoke and import mirror documents.

**Tech Stack:** Bun workspaces, TypeScript, Hono, zod, bun:test with in-memory SQLite (`BunSqliteRepo`), React dashboard rendered with `react-dom/server` in tests.

**Spec:** `vnext/docs/superpowers/specs/2026-11-16-loki-device-mirror-design.md`

All paths below are relative to `vnext/`. Run commands from `vnext/`.

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/provider-loki/src/state.ts` (modify) | `LokiMirror`, `LokiMirrorSource` types; strict parsing in `readLokiState`; pure transitions (`addLokiMirror`, `removeLokiMirror`, `touchLokiMirror`, `newLokiMirrorState`, `applyLokiMirrorPull`, `usableLokiCredential`) |
| `packages/provider-loki/src/mirror.ts` (create) | Mirror document build/parse; `pullLokiMirror` HTTP client |
| `packages/provider-loki/src/provider.ts` (modify) | Mirror path in `credential()`; `LokiProviderOptions` |
| `packages/provider-loki/src/plugin.ts` (modify) | Pass `save` to the provider |
| `packages/provider-loki/src/index.ts` (modify) | Export `mirror.ts` |
| `packages/gateway/src/control-plane/loki/mirror.ts` (create) | `lokiMirrorRouter`: `GET /mirror/:id` |
| `packages/gateway/src/control-plane/loki/common.ts` (modify) | `randomHex`, `newMirror`, `publicMirror` |
| `packages/gateway/src/control-plane/loki/routes.ts` (modify) | Mirror management routes; create/re-import from a mirror document; pair rules |
| `packages/gateway/src/app.ts` (modify) | Mount `lokiMirrorRouter` before session auth |
| `packages/gateway/src/control-plane/upstreams/public-dto.ts` (modify) | `lokiSource` (origin only) |
| `packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts` (create) | Endpoint, management, import, export and end-to-end tests |
| `apps/dashboard/src/tabs/upstreams/loki-mirror.ts` (create) | Client-side mirror document validation/formatting |
| `apps/dashboard/src/tabs/upstreams/LokiMirrorsSection.tsx` (create) | Central "Device mirrors" UI |
| `apps/dashboard/src/tabs/upstreams/LokiPairingPanel.tsx` (modify) | Source choice on create; mirror upstream view |
| `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx` (modify) | Mirror status text |
| `apps/dashboard/src/api/types.ts` (modify) | `lokiStatus.errorCode`, `lokiSource` |
| `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (modify) | en + zh strings |
| `docs/loki-sync-v1.md` (modify) | "Device mirror" section |

---

### Task 1: Mirror state model and pure transitions

**Files:**
- Modify: `packages/provider-loki/src/state.ts`
- Test: `packages/provider-loki/src/__tests__/mirror-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/provider-loki/src/__tests__/mirror-state.test.ts`:

```ts
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
    "https://central.example?q=1", "https://central.example#f", "not a url"]) {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/provider-loki/src/__tests__/mirror-state.test.ts`
Expected: FAIL — `addLokiMirror` (and the other new exports) not found.

- [ ] **Step 3: Implement**

In `packages/provider-loki/src/state.ts`:

1. Replace the `LokiState` interface's `errorCode` line and add two optional fields:

```ts
  errorCode?: LokiErrorCode | LokiMirrorErrorCode
  updatedAt?: number
  lastReceipt?: { requestId: string; payloadHash: string }
  mirrors?: LokiMirror[]
  source?: LokiMirrorSource
```

2. Add after the `LokiErrorCode` type:

```ts
export type LokiMirrorErrorCode = "mirror_revoked" | "account_mismatch"
export const LOKI_MAX_MIRRORS = 16
export const LOKI_MIRROR_ID_PATTERN = /^lkmid_[a-f0-9]{32}$/
export const LOKI_MIRROR_SECRET_PATTERN = /^lkm_[a-f0-9]{64}$/

export interface LokiMirror {
  id: string
  label: string
  secretHash: string
  createdAt: number
  lastPulledAt?: number
}

export interface LokiMirrorSource {
  kind: "mirror"
  origin: string
  upstreamId: string
  mirrorId: string
  mirrorSecret: string
}

export type LokiMirrorPullOutcome = { kind: "ok"; credential: LokiCredential } | { kind: "revoked" }
```

3. Rename `function parseCredential` to `export function parseLokiCredential` and update its one caller in `parseLokiSyncUpdate` and `readLokiState`.

4. Add parsers after `parseLokiCredential`:

```ts
function parseMirror(value: unknown): LokiMirror {
  const mirror = record(value)
  only(mirror, ["id", "label", "secretHash", "createdAt", "lastPulledAt"])
  const id = text(mirror.id, 64)
  const secretHash = text(mirror.secretHash, 64)
  if (!LOKI_MIRROR_ID_PATTERN.test(id) || !/^[a-f0-9]{64}$/.test(secretHash)) return invalid()
  return { id, label: text(mirror.label, 64), secretHash, createdAt: integer(mirror.createdAt),
    ...(mirror.lastPulledAt === undefined ? {} : { lastPulledAt: integer(mirror.lastPulledAt) }) }
}

export function parseLokiMirrorSource(value: unknown): LokiMirrorSource {
  const source = record(value)
  only(source, ["kind", "origin", "upstreamId", "mirrorId", "mirrorSecret"])
  if (source.kind !== "mirror") return invalid()
  let url: URL
  try { url = new URL(text(source.origin, 2048)) } catch { return invalid() }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || /[?#]/.test(String(source.origin))) return invalid()
  const upstreamId = text(source.upstreamId, 256)
  const mirrorId = text(source.mirrorId, 64)
  const mirrorSecret = text(source.mirrorSecret, 128)
  if (!/^[a-zA-Z0-9_-]+$/.test(upstreamId) || !LOKI_MIRROR_ID_PATTERN.test(mirrorId)
    || !LOKI_MIRROR_SECRET_PATTERN.test(mirrorSecret)) return invalid()
  return { kind: "mirror", origin: url.origin, upstreamId, mirrorId, mirrorSecret }
}
```

5. In `readLokiState`, replace the final `errorCode` assignment with the set below and parse the new fields before `return state`:

```ts
  if (source.mirrors !== undefined) {
    if (!Array.isArray(source.mirrors) || source.mirrors.length > LOKI_MAX_MIRRORS) return invalid()
    state.mirrors = source.mirrors.map(parseMirror)
  }
  if (source.source !== undefined) state.source = parseLokiMirrorSource(source.source)
  if (typeof source.errorCode === "string" && STORED_ERROR_CODES.has(source.errorCode)) {
    state.errorCode = source.errorCode as LokiErrorCode | LokiMirrorErrorCode
  }
  return state
```

with, at module level:

```ts
const STORED_ERROR_CODES = new Set(["interaction_required", "broker_unavailable", "invalid_result",
  "acquisition_failed", "mirror_revoked", "account_mismatch"])
```

6. Append the pure transitions:

```ts
const sameAccount = (a: LokiAccount, b: LokiAccount) => a.homeAccountId === b.homeAccountId && a.tenantId === b.tenantId

/** The stored credential, if it is unexpired and belongs to the bound account. */
export function usableLokiCredential(state: LokiState, now: number): LokiCredential | undefined {
  const credential = state.credential
  return credential && state.account && credential.expiresAt > now && sameAccount(credential.account, state.account)
    ? credential : undefined
}

export function addLokiMirror(state: LokiState, mirror: LokiMirror): LokiState {
  if (state.source) throw new LokiSyncError("mirror_unsupported", 400)
  const mirrors = state.mirrors ?? []
  if (mirrors.length >= LOKI_MAX_MIRRORS) throw new LokiSyncError("mirror_limit", 409)
  return { ...state, mirrors: [...mirrors, mirror] }
}

export function removeLokiMirror(state: LokiState, mirrorId: string): LokiState {
  const mirrors = state.mirrors ?? []
  if (!mirrors.some(mirror => mirror.id === mirrorId)) throw new LokiSyncError("mirror_not_found", 404)
  const { mirrors: _removed, ...rest } = state
  const remaining = mirrors.filter(mirror => mirror.id !== mirrorId)
  return remaining.length ? { ...rest, mirrors: remaining } : rest
}

export function touchLokiMirror(state: LokiState, mirrorId: string, now: number): LokiState {
  if (!state.mirrors?.some(mirror => mirror.id === mirrorId)) return state
  return { ...state, mirrors: state.mirrors.map(mirror => mirror.id === mirrorId ? { ...mirror, lastPulledAt: now } : mirror) }
}

export function newLokiMirrorState(source: LokiMirrorSource, credential: LokiCredential | undefined, now: number): LokiState {
  return { version: 1, profileId: "loki-df-v1", generation: crypto.randomUUID(), syncSecretHash: "", revision: 0,
    assistantStatus: credential ? "authorized" : "waiting", source,
    ...(credential ? { credential, account: credential.account, updatedAt: now } : {}) }
}

/** Applies a pull result; a result for a replaced source is ignored. */
export function applyLokiMirrorPull(state: LokiState, source: LokiMirrorSource, outcome: LokiMirrorPullOutcome, now: number): LokiState {
  if (!state.source || state.source.mirrorId !== source.mirrorId || state.source.mirrorSecret !== source.mirrorSecret) return state
  const { errorCode: _previous, ...rest } = state
  if (outcome.kind === "revoked") return { ...rest, errorCode: "mirror_revoked", updatedAt: now }
  if (state.account && !sameAccount(state.account, outcome.credential.account)) {
    return { ...rest, errorCode: "account_mismatch", updatedAt: now }
  }
  return { ...rest, credential: outcome.credential, account: outcome.credential.account, assistantStatus: "authorized", updatedAt: now }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/provider-loki`
Expected: PASS, including the existing `state.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add packages/provider-loki/src/state.ts packages/provider-loki/src/__tests__/mirror-state.test.ts
git commit -m "feat(vnext/loki): model device mirrors in Loki state"
```

---

### Task 2: Mirror document and pull client

**Files:**
- Create: `packages/provider-loki/src/mirror.ts`
- Modify: `packages/provider-loki/src/index.ts`
- Test: `packages/provider-loki/src/__tests__/mirror.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/provider-loki/src/__tests__/mirror.test.ts`:

```ts
import { expect, test } from "bun:test"
import { lokiMirrorDocument, parseLokiMirrorDocument, pullLokiMirror } from "../mirror"

const now = 1_800_000_000_000
const mirrorId = `lkmid_${"b".repeat(32)}`
const mirrorSecret = `lkm_${"c".repeat(64)}`
const doc = lokiMirrorDocument("https://central.example", "up_loki_central", mirrorId, mirrorSecret)
const source = parseLokiMirrorDocument(doc)
const credential = { accessToken: "token", tokenType: "Bearer", expiresAt: now + 3_600_000,
  account: { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" } }

test("documents round-trip and reject tampering", () => {
  expect(doc).toEqual({ version: 1, kind: "loki-mirror", gatewayOrigin: "https://central.example",
    upstreamId: "up_loki_central", profileId: "loki-df-v1", mirrorId, mirrorSecret })
  expect(source).toEqual({ kind: "mirror", origin: "https://central.example", upstreamId: "up_loki_central", mirrorId, mirrorSecret })
  for (const bad of [null, [], { ...doc, extra: 1 }, { ...doc, version: 2 }, { ...doc, kind: "pairing" },
    { ...doc, profileId: "other" }, { ...doc, mirrorSecret: `lks_${"c".repeat(64)}` }, { ...doc, gatewayOrigin: "http://x" }]) {
    expect(() => parseLokiMirrorDocument(bad)).toThrow("invalid_mirror_document")
  }
})

test("pull sends the secret as a bearer to the central mirror path without following redirects", async () => {
  let seen: { url: string; init: RequestInit } | undefined
  const result = await pullLokiMirror(source, async (url, init) => {
    seen = { url, init }
    return Response.json({ version: 1, profileId: "loki-df-v1", mirrorId, credential })
  }, now)
  expect(result).toEqual({ kind: "ok", credential })
  expect(seen?.url).toBe("https://central.example/api/loki/mirror/up_loki_central")
  expect(seen?.init.redirect).toBe("manual")
  expect(new Headers(seen?.init.headers).get("authorization")).toBe(`Bearer ${mirrorSecret}`)
})

test("pull classifies central responses", async () => {
  const reply = (response: Response | Error) => pullLokiMirror(source, async () => {
    if (response instanceof Error) throw response
    return response
  }, now)
  expect(await reply(Response.json({ error: { code: "invalid_mirror" } }, { status: 401 }))).toEqual({ kind: "revoked" })
  expect(await reply(Response.json({ error: { code: "credential_unavailable" } }, { status: 503 }))).toEqual({ kind: "unavailable" })
  expect(await reply(Response.json({ error: { code: "temporarily_unavailable" } }, { status: 503 }))).toEqual({ kind: "failed" })
  expect(await reply(new Response(null, { status: 302, headers: { location: "https://evil.example" } }))).toEqual({ kind: "failed" })
  expect(await reply(new Error("network"))).toEqual({ kind: "failed" })
  expect(await reply(Response.json({ version: 1, profileId: "loki-df-v1", mirrorId: "lkmid_" + "e".repeat(32), credential }))).toEqual({ kind: "failed" })
  expect(await reply(Response.json({ version: 1, profileId: "loki-df-v1", mirrorId,
    credential: { ...credential, expiresAt: now + 30_000 } }))).toEqual({ kind: "failed" })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/provider-loki/src/__tests__/mirror.test.ts`
Expected: FAIL — cannot resolve `../mirror`.

- [ ] **Step 3: Implement**

Create `packages/provider-loki/src/mirror.ts`:

```ts
import type { Fetcher } from "@vibe-core/upstream"
import { LOKI_PROFILE_ID } from "./profile"
import { LokiSyncError, parseLokiCredential, parseLokiMirrorSource, type LokiMirrorPullOutcome, type LokiMirrorSource } from "./state"

export interface LokiMirrorDocument {
  version: 1
  kind: "loki-mirror"
  gatewayOrigin: string
  upstreamId: string
  profileId: typeof LOKI_PROFILE_ID
  mirrorId: string
  mirrorSecret: string
}

export type LokiMirrorPull = LokiMirrorPullOutcome | { kind: "unavailable" } | { kind: "failed" }

const DOCUMENT_KEYS = ["version", "kind", "gatewayOrigin", "upstreamId", "profileId", "mirrorId", "mirrorSecret"]

export function lokiMirrorDocument(gatewayOrigin: string, upstreamId: string, mirrorId: string, mirrorSecret: string): LokiMirrorDocument {
  return { version: 1, kind: "loki-mirror", gatewayOrigin, upstreamId, profileId: LOKI_PROFILE_ID, mirrorId, mirrorSecret }
}

export function parseLokiMirrorDocument(value: unknown): LokiMirrorSource {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    const doc = value as Record<string, unknown>
    if (Object.keys(doc).some(key => !DOCUMENT_KEYS.includes(key)) || doc.version !== 1
      || doc.kind !== "loki-mirror" || doc.profileId !== LOKI_PROFILE_ID) throw new Error()
    return parseLokiMirrorSource({ kind: "mirror", origin: doc.gatewayOrigin, upstreamId: doc.upstreamId,
      mirrorId: doc.mirrorId, mirrorSecret: doc.mirrorSecret })
  } catch { throw new LokiSyncError("invalid_mirror_document", 400) }
}

/** One pull from the central gateway. Never throws; never follows redirects. */
export async function pullLokiMirror(source: LokiMirrorSource, fetcher: Fetcher, now = Date.now()): Promise<LokiMirrorPull> {
  let response: Response
  try {
    response = await fetcher(`${source.origin}/api/loki/mirror/${encodeURIComponent(source.upstreamId)}`, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${source.mirrorSecret}`, accept: "application/json" },
    })
  } catch { return { kind: "failed" } }
  try {
    if (response.status === 401) return { kind: "revoked" }
    const body = await response.json().catch(() => undefined) as Record<string, unknown> | undefined
    if (response.status !== 200) {
      const code = (body?.error as { code?: unknown } | undefined)?.code
      return response.status === 503 && code === "credential_unavailable" ? { kind: "unavailable" } : { kind: "failed" }
    }
    if (!body || body.version !== 1 || body.profileId !== LOKI_PROFILE_ID || body.mirrorId !== source.mirrorId) return { kind: "failed" }
    const credential = parseLokiCredential(body.credential)
    return credential.expiresAt > now + 60_000 ? { kind: "ok", credential } : { kind: "failed" }
  } catch { return { kind: "failed" } }
  finally { await response.body?.cancel().catch(() => {}) }
}
```

Add to `packages/provider-loki/src/index.ts`:

```ts
export * from "./mirror"
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/provider-loki`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/provider-loki/src/mirror.ts packages/provider-loki/src/index.ts packages/provider-loki/src/__tests__/mirror.test.ts
git commit -m "feat(vnext/loki): mirror documents and the device pull client"
```

---

### Task 3: Provider pulls mirror credentials lazily

**Files:**
- Modify: `packages/provider-loki/src/provider.ts`
- Modify: `packages/provider-loki/src/plugin.ts`
- Test: `packages/provider-loki/src/__tests__/provider-mirror.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/provider-loki/src/__tests__/provider-mirror.test.ts`:

```ts
import { beforeEach, expect, test } from "bun:test"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { __resetLokiMirrorPullsForTests, LokiProvider } from "../provider"
import { newLokiMirrorState, type LokiState } from "../state"

const start = 1_800_000_000_000
const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const mirrorId = `lkmid_${"b".repeat(32)}`
const source = { kind: "mirror" as const, origin: "https://central.example", upstreamId: "up_loki_central",
  mirrorId, mirrorSecret: `lkm_${"c".repeat(64)}` }
const credential = (token: string, expiresAt: number, acct = account) => ({ accessToken: token, tokenType: "Bearer" as const, expiresAt, account: acct })

let clock = start
let central: () => Response | Promise<Response>
let pulls = 0
let lokiBearers: string[] = []

function device(initial: ReturnType<typeof credential> | undefined) {
  const row: StoredUpstreamRecord<LokiState> = { id: "up_loki_device", rowIncarnation: "i", ownerId: "owner", provider: "loki",
    name: "Loki", enabled: true, sortOrder: 0, config: { profileId: "loki-df-v1" }, state: newLokiMirrorState(source, initial, start),
    catalogGeneration: 0, credentialGeneration: 0, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "", updatedAt: "" }
  const provider = new LokiProvider(row, async () => row,
    async (_url, init) => { lokiBearers.push(new Headers(init.headers).get("authorization") ?? ""); return Response.json({ data: [] }) },
    undefined,
    { now: () => clock,
      save: async updater => { row.state = updater(row.state) as LokiState },
      mirrorFetcher: async () => { pulls++; return central() } })
  return { row, provider }
}
const ok = (token: string, expiresAt = clock + 3_600_000) =>
  () => Response.json({ version: 1, profileId: "loki-df-v1", mirrorId, credential: credential(token, expiresAt) })

beforeEach(() => { __resetLokiMirrorPullsForTests(); clock = start; pulls = 0; lokiBearers = []; central = ok("fresh") })

test("a token with more than five minutes left is used without pulling", async () => {
  const { provider } = device(credential("stored", start + 600_000))
  await provider.getLiveModels()
  expect(pulls).toBe(0)
  expect(lokiBearers).toEqual(["Bearer stored"])
})

test("a near-expiry token is refreshed once for concurrent callers and persisted", async () => {
  const { provider, row } = device(credential("stored", start + 120_000))
  await Promise.all([provider.getLiveModels(), provider.getLiveModels(), provider.getLiveModels()])
  expect(pulls).toBe(1)
  expect(lokiBearers).toEqual(["Bearer fresh", "Bearer fresh", "Bearer fresh"])
  expect(row.state.credential?.accessToken).toBe("fresh")
})

test("a missing token is pulled on first use", async () => {
  const { provider, row } = device(undefined)
  await provider.getLiveModels()
  expect(lokiBearers).toEqual(["Bearer fresh"])
  expect(row.state.account).toEqual(account)
})

test("failures keep the unexpired token and back off for 30 seconds", async () => {
  const { provider } = device(credential("stored", start + 120_000))
  central = () => new Response(null, { status: 502 })
  await provider.getLiveModels()
  await provider.getLiveModels()
  expect(pulls).toBe(1)
  expect(lokiBearers).toEqual(["Bearer stored", "Bearer stored"])
  clock += 31_000
  central = ok("fresh")
  await provider.getLiveModels()
  expect(pulls).toBe(2)
  expect(lokiBearers.at(-1)).toBe("Bearer fresh")
})

test("an expired token with a failed pull is unavailable", async () => {
  const { provider } = device(credential("stored", start - 1))
  central = () => Response.json({ error: { code: "credential_unavailable" } }, { status: 503 })
  await expect(provider.getLiveModels()).rejects.toThrow("loki_credential_unavailable")
})

test("revocation is recorded and stops automatic pulls", async () => {
  const { provider, row } = device(credential("stored", start + 120_000))
  central = () => Response.json({ error: { code: "invalid_mirror" } }, { status: 401 })
  await provider.getLiveModels()
  expect(row.state.errorCode).toBe("mirror_revoked")
  clock += 60_000
  await provider.getLiveModels()
  expect(pulls).toBe(1)
  clock = start + 120_000
  await expect(provider.getLiveModels()).rejects.toThrow("loki_credential_unavailable")
})

test("a token for another account is refused and stops automatic pulls", async () => {
  const { provider, row } = device(credential("stored", start + 120_000))
  central = () => Response.json({ version: 1, profileId: "loki-df-v1", mirrorId,
    credential: credential("other", clock + 3_600_000, { homeAccountId: "other", tenantId: account.tenantId }) })
  await provider.getLiveModels()
  expect(row.state.errorCode).toBe("account_mismatch")
  expect(lokiBearers).toEqual(["Bearer stored"])
  clock += 60_000
  await provider.getLiveModels()
  expect(pulls).toBe(1)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/provider-loki/src/__tests__/provider-mirror.test.ts`
Expected: FAIL — `__resetLokiMirrorPullsForTests` not exported.

- [ ] **Step 3: Implement**

In `packages/provider-loki/src/provider.ts`:

1. Replace the `./state` import and add the mirror import:

```ts
import { applyLokiMirrorPull, readLokiState, usableLokiCredential, type LokiCredential, type LokiMirrorSource, type LokiState } from "./state"
import { pullLokiMirror } from "./mirror"
```

2. Add module-level declarations above the class:

```ts
const LOKI_MIRROR_REFRESH_MARGIN_MS = 5 * 60 * 1000
const LOKI_MIRROR_RETRY_MS = 30 * 1000
/** Per-process single-flight and failure backoff, keyed by upstream and mirror. */
const mirrorPulls = new Map<string, Promise<void>>()
const mirrorRetryAt = new Map<string, number>()
export function __resetLokiMirrorPullsForTests(): void { mirrorPulls.clear(); mirrorRetryAt.clear() }

export interface LokiProviderOptions {
  /** Atomic state write for this upstream; mirror pulls are not persisted without it. */
  save?: (updater: (current: unknown) => unknown) => Promise<void>
  /** Fetcher for the central gateway; defaults to a direct fetch, never the upstream's proxy chain. */
  mirrorFetcher?: Fetcher
  now?: () => number
}
```

3. Add a fifth constructor parameter:

```ts
    private readonly executionFetcher?: ExecutionFetcherForRequest,
    private readonly options: LokiProviderOptions = {}) {
```

4. Replace the existing `credential()` method with:

```ts
  private now(): number { return this.options.now?.() ?? Date.now() }

  private async boundRow(forInference: boolean): Promise<StoredUpstreamRecord> {
    const row = await this.load()
    if (!row || row.provider !== "loki" || row.rowIncarnation !== this.expected.rowIncarnation
      || row.ownerId !== this.expected.ownerId || row.credentialGeneration !== this.expected.credentialGeneration
      || row.catalogGeneration !== this.expected.catalogGeneration || (forInference && !row.enabled)
      || row.config.profileId !== LOKI_PROFILE_ID
      || lokiBaseUrl(row.config.baseUrl) !== this.baseUrl) throw new Error("loki_binding_replaced")
    return row
  }

  private async credential(forInference = false): Promise<LokiCredential> {
    const state = readLokiState((await this.boundRow(forInference)).state)
    if (state.source) return this.mirrorCredential(state, forInference)
    const credential = state.syncSecretHash ? usableLokiCredential(state, this.now()) : undefined
    if (!credential) throw new Error("loki_credential_unavailable")
    return credential
  }

  private async mirrorCredential(state: LokiState, forInference: boolean): Promise<LokiCredential> {
    const source = state.source as LokiMirrorSource
    const current = usableLokiCredential(state, this.now())
    if (current && current.expiresAt - this.now() > LOKI_MIRROR_REFRESH_MARGIN_MS) return current
    const stopped = state.errorCode === "mirror_revoked" || state.errorCode === "account_mismatch"
    const key = `${this.expected.id}:${source.mirrorId}`
    if (!stopped && this.options.save && (mirrorRetryAt.get(key) ?? 0) <= this.now()) {
      let pending = mirrorPulls.get(key)
      if (!pending) {
        pending = this.pullMirror(key, source).finally(() => mirrorPulls.delete(key))
        mirrorPulls.set(key, pending)
      }
      await pending
      const fresh = usableLokiCredential(readLokiState((await this.boundRow(forInference)).state), this.now())
      if (fresh) return fresh
    }
    if (current) return current
    throw new Error("loki_credential_unavailable")
  }

  private async pullMirror(key: string, source: LokiMirrorSource): Promise<void> {
    const result = await pullLokiMirror(source, this.options.mirrorFetcher ?? directFetcher, this.now())
    let stored = false
    if (result.kind === "ok" || result.kind === "revoked") {
      try {
        await this.options.save!(current => applyLokiMirrorPull(readLokiState(current), source, result, this.now()))
        stored = result.kind === "ok"
      } catch { /* A failed write backs off like a failed pull. */ }
    }
    if (stored) mirrorRetryAt.delete(key)
    else mirrorRetryAt.set(key, this.now() + LOKI_MIRROR_RETRY_MS)
  }
```

In `packages/provider-loki/src/plugin.ts`, replace the `return new LokiProvider(...)` statement with:

```ts
    const record = upstream as StoredUpstreamRecord
    return new LokiProvider(record, () => getAuthoritativeUpstreamRepo().getById(upstream.id), fetcher,
      execution ? request => execution(upstream.id, request) : undefined,
      { save: updater => getAuthoritativeUpstreamRepo().saveState<unknown>(upstream.id, updater, record) })
```

- [ ] **Step 4: Run tests and typecheck**

Run: `bun test packages/provider-loki && bun run --filter '@vibe-llm/provider-loki' typecheck`
Expected: PASS. Existing `provider.test.ts` still passes (paired upstreams unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/provider-loki/src/provider.ts packages/provider-loki/src/plugin.ts packages/provider-loki/src/__tests__/provider-mirror.test.ts
git commit -m "feat(vnext/loki): devices refresh mirrored credentials on demand"
```

---

### Task 4: Central mirror endpoint

**Files:**
- Create: `packages/gateway/src/control-plane/loki/mirror.ts`
- Modify: `packages/gateway/src/control-plane/loki/common.ts`
- Modify: `packages/gateway/src/control-plane/loki/routes.ts` (re-export)
- Modify: `packages/gateway/src/app.ts`
- Test: `packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`

- [ ] **Step 1: Write the failing test (file scaffold + endpoint tests)**

Create `packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initRuntimeLocation, initEnv } from "@vibe-core/platform"
import { addLokiMirror, readLokiState } from "@vibe-llm/provider-loki"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { lokiManagementRouter, lokiMirrorRouter, lokiSyncRouter } from "../src/control-plane/loki/routes"
import { digest } from "../src/control-plane/loki/common"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "loki-owner" as UserId
const other = "loki-other" as UserId
const session = "ses_loki_owner" as SessionToken
const otherSession = "ses_loki_other" as SessionToken
const stamp = "2026-11-16T00:00:00.000Z"
const account = { homeAccountId: "fixture-home", tenantId: "11111111-1111-4111-8111-111111111111" }
interface Pairing { upstreamId: string; generation: string; syncSecret: string }
interface Issued { mirror: { id: string; label: string; createdAt: number; lastPulledAt: number | null }
  document: { mirrorId: string; mirrorSecret: string; upstreamId: string; gatewayOrigin: string } }
let db: Database
let repo: BunSqliteRepo
let app: Hono
const realFetch = globalThis.fetch

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  for (const [token, userId] of [[session, owner], [otherSession, other]] as const) {
    await repo.sessions.create({ token, userId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  app = new Hono()
  app.route("/api/loki", lokiSyncRouter)
  app.route("/api/loki", lokiMirrorRouter)
  app.use("*", sessionAuthMiddleware)
  app.route("/api/loki", lokiManagementRouter)
  // Device-side pulls reach the central gateway through global fetch; route them into this app.
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => app.request(String(input), init)) as typeof fetch
})

afterEach(() => { globalThis.fetch = realFetch; db.close(); __resetPlatformForTests() })

function request(path: string, body: unknown, bearer: string = session, method = "POST") {
  return app.request(`https://gateway.example/api/loki${path}`, { method,
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const pull = (upstreamId: string, secret: string) =>
  app.request(`https://gateway.example/api/loki/mirror/${upstreamId}`, { headers: { authorization: `Bearer ${secret}` } })

async function central(expiresAt = Date.now() + 3_600_000): Promise<Pairing> {
  const created = await request("/upstreams", { name: "Central" })
  const pairing = ((await created.json()) as { pairing: Pairing }).pairing
  const upload = await request(`/sync/${pairing.upstreamId}`, { version: 1, generation: pairing.generation, expectedRevision: 0,
    requestId: "upload-one", status: "authorized",
    credential: { accessToken: "central-token", tokenType: "Bearer", expiresAt, account } }, pairing.syncSecret)
  expect(upload.status).toBe(200)
  return pairing
}
// saveState updaters are synchronous, so tests hash the secret before seeding a mirror.

test("the mirror endpoint returns the credential only to a valid mirror secret", async () => {
  const p = await central()
  const secret = `lkm_${"1".repeat(64)}`
  const hash = await digest(secret)
  await repo.upstreams.saveState<unknown>(p.upstreamId, current => addLokiMirror(readLokiState(current),
    { id: `lkmid_${"a".repeat(32)}`, label: "Seeded", secretHash: hash, createdAt: 1 }))
  const response = await pull(p.upstreamId, secret)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toMatchObject({ version: 1, profileId: "loki-df-v1", mirrorId: `lkmid_${"a".repeat(32)}`,
    credential: { accessToken: "central-token", account } })
  for (const bad of [`lkm_${"2".repeat(64)}`, p.syncSecret, "lkm_short"]) expect((await pull(p.upstreamId, bad)).status).toBe(401)
  expect((await pull(`${p.upstreamId}x`, secret)).status).toBe(401)
  await repo.users.update(owner, { disabled: true })
  expect((await pull(p.upstreamId, secret)).status).toBe(401)
})

test("the mirror endpoint reports an unusable central credential and throttles pull stamps", async () => {
  const p = await central(Date.now() + 30_000)
  const secret = `lkm_${"1".repeat(64)}`
  const hash = await digest(secret)
  await repo.upstreams.saveState<unknown>(p.upstreamId, current => addLokiMirror(readLokiState(current),
    { id: `lkmid_${"a".repeat(32)}`, label: "Seeded", secretHash: hash, createdAt: 1 }))
  const unavailable = await pull(p.upstreamId, secret)
  expect(unavailable.status).toBe(503)
  expect(await unavailable.json()).toEqual({ error: { code: "credential_unavailable" } })

  const q = await central()
  const recent = Date.now() - 60_000
  await repo.upstreams.saveState<unknown>(q.upstreamId, current => addLokiMirror(readLokiState(current),
    { id: `lkmid_${"a".repeat(32)}`, label: "Seeded", secretHash: hash, createdAt: 1, lastPulledAt: recent }))
  expect((await pull(q.upstreamId, secret)).status).toBe(200)
  expect(readLokiState((await repo.upstreams.getById(q.upstreamId))!.state).mirrors?.[0]?.lastPulledAt).toBe(recent)
  const stale = Date.now() - 700_000
  await repo.upstreams.saveState<unknown>(q.upstreamId, current => {
    const state = readLokiState(current)
    return { ...state, mirrors: state.mirrors!.map(m => ({ ...m, lastPulledAt: stale })) }
  })
  expect((await pull(q.upstreamId, secret)).status).toBe(200)
  expect(readLokiState((await repo.upstreams.getById(q.upstreamId))!.state).mirrors?.[0]?.lastPulledAt).toBeGreaterThan(stale)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`
Expected: FAIL — `lokiMirrorRouter` is not exported from `routes`.

- [ ] **Step 3: Implement**

In `packages/gateway/src/control-plane/loki/common.ts`, add (and make `newBinding` use `randomHex(32)` for its secret):

```ts
import type { LokiMirror } from "@vibe-llm/provider-loki"

export const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("")

export async function newMirror(label: string, now: number): Promise<{ mirror: LokiMirror; mirrorSecret: string }> {
  const mirrorSecret = `lkm_${randomHex(32)}`
  return { mirrorSecret, mirror: { id: `lkmid_${randomHex(16)}`, label, secretHash: await digest(mirrorSecret), createdAt: now } }
}

export const publicMirror = (mirror: LokiMirror) =>
  ({ id: mirror.id, label: mirror.label, createdAt: mirror.createdAt, lastPulledAt: mirror.lastPulledAt ?? null })
```

Create `packages/gateway/src/control-plane/loki/mirror.ts`:

```ts
import { Hono } from "hono"
import { LokiSyncError, readLokiState, touchLokiMirror } from "@vibe-llm/provider-loki"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import { digest, json, ownerId, safeError, upstreamId } from "./common"

const PULL_STAMP_INTERVAL_MS = 10 * 60 * 1000

export const lokiMirrorRouter = new Hono<{ Bindings: Env }>()

lokiMirrorRouter.get("/mirror/:id", async c => {
  try {
    const invalid = () => new LokiSyncError("invalid_mirror", 401)
    const raw = c.req.header("authorization")?.match(/^Bearer (lkm_[a-f0-9]{64})$/)?.[1]
    const parsedId = upstreamId.safeParse(c.req.param("id"))
    if (!raw || !parsedId.success) throw invalid()
    const secretHash = await digest(raw)
    const repo = getRepo()
    const row = await repo.upstreams.getById(parsedId.data)
    if (!row || row.provider !== "loki" || !row.ownerId) throw invalid()
    let state
    try { state = readLokiState(row.state) } catch { throw invalid() }
    const mirror = state.mirrors?.find(entry => entry.secretHash === secretHash)
    if (!mirror) throw invalid()
    const owner = await repo.users.getById(ownerId.parse(row.ownerId))
    if (!owner || owner.disabled) throw invalid()
    const now = Date.now()
    const credential = state.credential
    if (!credential || credential.expiresAt <= now + 60_000) throw new LokiSyncError("credential_unavailable", 503)
    if (mirror.lastPulledAt === undefined || now - mirror.lastPulledAt >= PULL_STAMP_INTERVAL_MS) {
      await repo.upstreams.saveState<unknown>(parsedId.data, current => touchLokiMirror(readLokiState(current), mirror.id, now), row)
        .catch(() => { /* The stamp is advisory; the pull still succeeds. */ })
    }
    return json({ version: 1, profileId: state.profileId, mirrorId: mirror.id, credential })
  } catch (error) { return safeError(error) }
})
```

In `packages/gateway/src/control-plane/loki/routes.ts`, next to the existing re-export:

```ts
export { lokiMirrorRouter } from "./mirror"
```

In `packages/gateway/src/app.ts`, import and mount it beside the sync router (before `sessionAuthMiddleware`):

```ts
import { lokiMirrorRouter } from './control-plane/loki/mirror.ts'
// …
app.route('/api/loki', lokiSyncRouter)
app.route('/api/loki', lokiMirrorRouter)
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts packages/gateway/tests/control-plane-loki.sqlite.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/control-plane/loki packages/gateway/src/app.ts packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts
git commit -m "feat(vnext/loki): central endpoint serving credentials to device mirrors"
```

---

### Task 5: Mirror management and pairing rules

**Files:**
- Modify: `packages/gateway/src/control-plane/loki/routes.ts`
- Test: `packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```ts
async function issue(upstreamId: string, label = "MacBook", bearer: string = session) {
  return request(`/upstreams/${upstreamId}/mirrors`, { label }, bearer)
}

test("owners issue, list and revoke mirrors; secrets appear once and are never stored", async () => {
  const p = await central()
  expect((await issue(p.upstreamId, "MacBook", otherSession)).status).toBe(404)
  const response = await issue(p.upstreamId)
  expect(response.status).toBe(201)
  const issued = await response.json() as Issued
  expect(issued.document).toMatchObject({ version: 1, kind: "loki-mirror", gatewayOrigin: "https://gateway.example",
    upstreamId: p.upstreamId, profileId: "loki-df-v1", mirrorId: issued.mirror.id })
  expect(issued.document.mirrorSecret).toMatch(/^lkm_[a-f0-9]{64}$/)
  expect(JSON.stringify(await repo.upstreams.list({ includeDisabled: true }))).not.toContain(issued.document.mirrorSecret)
  expect((await pull(p.upstreamId, issued.document.mirrorSecret)).status).toBe(200)

  const listed = await request(`/upstreams/${p.upstreamId}/mirrors`, undefined, session, "GET")
  const raw = await listed.text()
  expect(JSON.parse(raw).mirrors).toHaveLength(1)
  expect(raw).not.toContain("secretHash")
  expect(JSON.parse(raw).mirrors[0].lastPulledAt).toBeGreaterThan(0)

  expect((await request(`/upstreams/${p.upstreamId}/mirrors/lkmid_${"f".repeat(32)}`, undefined, session, "DELETE")).status).toBe(404)
  const revoked = await request(`/upstreams/${p.upstreamId}/mirrors/${issued.mirror.id}`, undefined, session, "DELETE")
  expect(revoked.status).toBe(200)
  expect((await revoked.json() as { mirrors: unknown[] }).mirrors).toEqual([])
  expect((await pull(p.upstreamId, issued.document.mirrorSecret)).status).toBe(401)
})

test("labels are validated, issuance is limited and needs HTTPS", async () => {
  const p = await central()
  for (const label of ["", " ", "x".repeat(65)]) expect((await issue(p.upstreamId, label)).status).toBe(400)
  for (let n = 0; n < 16; n++) expect((await issue(p.upstreamId, `Device ${n}`)).status).toBe(201)
  const full = await issue(p.upstreamId, "One too many")
  expect(full.status).toBe(409)
  expect(await full.json()).toEqual({ error: { code: "mirror_limit" } })
  const http = await app.request(`http://gateway.example/api/loki/upstreams/${p.upstreamId}/mirrors`, { method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" }, body: JSON.stringify({ label: "Plain" }) })
  expect(http.status).toBe(400)
  expect(await http.json()).toEqual({ error: { code: "https_required" } })
})

test("re-pairing keeps mirrors; disconnecting the assistant revokes them", async () => {
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  const repaired = await request(`/upstreams/${p.upstreamId}/pair`, {})
  expect(repaired.status).toBe(200)
  const next = ((await repaired.json()) as { pairing: Pairing }).pairing
  await request(`/sync/${p.upstreamId}`, { version: 1, generation: next.generation, expectedRevision: 0, requestId: "after-repair",
    status: "authorized", credential: { accessToken: "central-token-2", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, account } }, next.syncSecret)
  const after = await pull(p.upstreamId, issued.document.mirrorSecret)
  expect(after.status).toBe(200)
  expect((await after.json() as { credential: { accessToken: string } }).credential.accessToken).toBe("central-token-2")
  expect((await request(`/upstreams/${p.upstreamId}/pair`, undefined, session, "DELETE")).status).toBe(200)
  expect((await pull(p.upstreamId, issued.document.mirrorSecret)).status).toBe(401)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`
Expected: FAIL — `/upstreams/:id/mirrors` returns 404.

- [ ] **Step 3: Implement**

In `packages/gateway/src/control-plane/loki/routes.ts`:

1. Extend imports:

```ts
import { addLokiMirror, LokiSyncError, LOKI_PROFILE_ID, lokiBaseUrl, lokiMirrorDocument, normalizeLokiStaticModels,
  readLokiState, removeLokiMirror, type LokiState } from "@vibe-llm/provider-loki"
import { boundedJson, json, newBinding, newMirror, publicMirror, safeError, upstreamId } from "./common"
```

2. Add a helper and schemas below the existing schemas:

```ts
const mirrorBody = z.object({ label: z.string().trim().min(1).max(64) }).strict()
const mirrorId = z.string().regex(/^lkmid_[a-f0-9]{32}$/)

async function ownedLoki(auth: FullAuthCtx, rawId: string) {
  const parsedId = upstreamId.safeParse(rawId)
  if (!parsedId.success) throw new LokiSyncError("upstream_not_found", 404)
  const row = await loadOwned(auth, () => getRepo().upstreams.getById(parsedId.data))
  if (!row || row.provider !== "loki") throw new LokiSyncError("upstream_not_found", 404)
  return row
}
const currentState = (state: unknown): LokiState | undefined => { try { return readLokiState(state) } catch { return undefined } }
```

3. Add the routes:

```ts
lokiManagementRouter.get("/upstreams/:id/mirrors", async c => {
  try {
    const row = await ownedLoki(c.get("auth"), c.req.param("id"))
    return json({ mirrors: (currentState(row.state)?.mirrors ?? []).map(publicMirror) })
  } catch (error) { return safeError(error) }
})

lokiManagementRouter.post("/upstreams/:id/mirrors", async c => {
  try {
    const row = await ownedLoki(c.get("auth"), c.req.param("id"))
    const origin = new URL(c.req.url)
    if (origin.protocol !== "https:") throw new LokiSyncError("https_required", 400)
    const parsed = mirrorBody.safeParse(await boundedJson(c.req.raw))
    if (!parsed.success) throw new LokiSyncError("invalid_request", 400)
    const { mirror, mirrorSecret } = await newMirror(parsed.data.label, Date.now())
    await getRepo().upstreams.saveState<unknown>(row.id, current => addLokiMirror(readLokiState(current), mirror), row)
    return json({ mirror: publicMirror(mirror), document: lokiMirrorDocument(origin.origin, row.id, mirror.id, mirrorSecret) }, 201)
  } catch (error) { return safeError(error) }
})

lokiManagementRouter.delete("/upstreams/:id/mirrors/:mirrorId", async c => {
  try {
    const row = await ownedLoki(c.get("auth"), c.req.param("id"))
    const parsedMirror = mirrorId.safeParse(c.req.param("mirrorId"))
    if (!parsedMirror.success) throw new LokiSyncError("mirror_not_found", 404)
    await getRepo().upstreams.saveState<unknown>(row.id, current => removeLokiMirror(readLokiState(current), parsedMirror.data), row)
    const saved = await getRepo().upstreams.getById(row.id)
    return json({ mirrors: (currentState(saved?.state)?.mirrors ?? []).map(publicMirror) })
  } catch (error) { return safeError(error) }
})
```

4. In the existing `POST`/`DELETE /upstreams/:id/pair` handler, replace `const { state, syncSecret } = await newBinding()` and the following `if (method === "DELETE") …` line with:

```ts
    const previous = currentState(row.state)
    if (previous?.source) throw new LokiSyncError("mirror_unsupported", 400)
    const { state, syncSecret } = await newBinding()
    if (method === "DELETE") state.syncSecretHash = ""
    else if (previous?.mirrors?.length) state.mirrors = previous.mirrors
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts packages/gateway/tests/control-plane-loki.sqlite.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/control-plane/loki/routes.ts packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts
git commit -m "feat(vnext/loki): issue, list and revoke device mirrors"
```

---

### Task 6: Create and re-import mirror upstreams on a device; public DTO

**Files:**
- Modify: `packages/gateway/src/control-plane/loki/routes.ts`
- Modify: `packages/gateway/src/control-plane/upstreams/public-dto.ts`
- Test: `packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`

- [ ] **Step 1: Write the failing tests**

Append:

```ts
async function device(document: unknown, extra: Record<string, unknown> = {}) {
  // Devices run over plain HTTP on localhost; creation must not require HTTPS.
  return app.request("http://localhost:41414/api/loki/upstreams", { method: "POST",
    headers: { authorization: `Bearer ${session}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "Device Loki", mirror: document, ...extra }) })
}

test("a device creates a mirror upstream from a document and pulls immediately", async () => {
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  const response = await device(issued.document)
  expect(response.status).toBe(201)
  const body = await response.json() as { upstream: { id: string; lokiStatus: { tokenStatus: string }; lokiSource: unknown }; pairing?: unknown; warning?: string }
  expect(body.pairing).toBeUndefined()
  expect(body.warning).toBeUndefined()
  expect(body.upstream.lokiStatus.tokenStatus).toBe("valid")
  expect(body.upstream.lokiSource).toEqual({ kind: "mirror", origin: "https://gateway.example" })
  const state = readLokiState((await repo.upstreams.getById(body.upstream.id))!.state)
  expect(state.credential?.accessToken).toBe("central-token")
  expect(state.syncSecretHash).toBe("")
  expect(JSON.stringify(body)).not.toContain(issued.document.mirrorSecret)
  expect((await request(`/upstreams/${body.upstream.id}/pair`, {})).status).toBe(400)
  expect((await issue(body.upstream.id)).status).toBe(400)
})

test("invalid or revoked documents create nothing; an empty central still creates with a warning", async () => {
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  const bad = await device({ ...issued.document, mirrorSecret: "lks_" + "0".repeat(64) })
  expect(bad.status).toBe(400)
  expect(await bad.json()).toEqual({ error: { code: "invalid_mirror_document" } })
  await request(`/upstreams/${p.upstreamId}/mirrors/${issued.mirror.id}`, undefined, session, "DELETE")
  const revoked = await device(issued.document)
  expect(revoked.status).toBe(400)
  expect(await revoked.json()).toEqual({ error: { code: "invalid_mirror" } })
  expect((await repo.upstreams.list({ includeDisabled: true })).filter(row => row.name === "Device Loki")).toHaveLength(0)

  const empty = await central(Date.now() + 30_000)
  const later = await (await issue(empty.upstreamId)).json() as Issued
  const pending = await device(later.document)
  expect(pending.status).toBe(201)
  expect((await pending.json() as { warning?: string }).warning).toBe("credential_unavailable")
})

test("re-importing replaces the source and clears the bound account", async () => {
  const p = await central()
  const first = await (await issue(p.upstreamId, "Old")).json() as Issued
  const created = await (await device(first.document)).json() as { upstream: { id: string } }
  const second = await (await issue(p.upstreamId, "New")).json() as Issued
  await repo.upstreams.saveState<unknown>(created.upstream.id, current => ({ ...readLokiState(current), errorCode: "account_mismatch" }))
  const response = await request(`/upstreams/${created.upstream.id}/mirror-source`, { mirror: second.document }, session, "PUT")
  expect(response.status).toBe(200)
  const state = readLokiState((await repo.upstreams.getById(created.upstream.id))!.state)
  expect(state.source?.mirrorId).toBe(second.mirror.id)
  expect(state.errorCode).toBeUndefined()
  expect(state.credential?.accessToken).toBe("central-token")
  expect((await request(`/upstreams/${p.upstreamId}/mirror-source`, { mirror: second.document }, session, "PUT")).status).toBe(400)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`
Expected: FAIL — `mirror` is rejected by the strict create schema (400 `invalid_request`).

- [ ] **Step 3: Implement**

In `routes.ts`:

1. Extend imports:

```ts
import { directFetcher } from "@vibe-core/upstream"
import { newLokiMirrorState, parseLokiMirrorDocument, pullLokiMirror, type LokiMirrorSource } from "@vibe-llm/provider-loki"
```

2. Change `createBody` to accept a document:

```ts
const createBody = z.object({ name: z.string().trim().min(1).max(120), baseUrl: endpoint.optional(), staticModels,
  mirror: z.unknown().optional() }).strict()
const mirrorSourceBody = z.object({ mirror: z.unknown() }).strict()
```

3. Add a helper:

```ts
/** Validates a document and pulls once. A revoked secret is a client error; an empty central is not. */
async function mirrorStateFrom(document: unknown): Promise<{ state: LokiState; warning?: "credential_unavailable" }> {
  const source: LokiMirrorSource = parseLokiMirrorDocument(document)
  const now = Date.now()
  const pull = await pullLokiMirror(source, directFetcher, now)
  if (pull.kind === "revoked") throw new LokiSyncError("invalid_mirror", 400)
  return pull.kind === "ok" ? { state: newLokiMirrorState(source, pull.credential, now) }
    : { state: newLokiMirrorState(source, undefined, now), warning: "credential_unavailable" }
}
```

4. In `POST /upstreams`, replace `const { state, syncSecret } = await newBinding()` with:

```ts
    const fromMirror = parsed.data.mirror === undefined ? undefined : await mirrorStateFrom(parsed.data.mirror)
    const binding = fromMirror ? undefined : await newBinding()
    const state = fromMirror?.state ?? binding!.state
```

and replace the final `return` with:

```ts
    const created = { upstream: serializeUpstream(saved) }
    return json(fromMirror
      ? { ...created, ...(fromMirror.warning ? { warning: fromMirror.warning } : {}) }
      : { ...created, pairing: pairing(new URL(c.req.url).origin, id, state, binding!.syncSecret) }, 201)
```

5. Add the re-import route:

```ts
lokiManagementRouter.put("/upstreams/:id/mirror-source", async c => {
  try {
    const row = await ownedLoki(c.get("auth"), c.req.param("id"))
    if (!currentState(row.state)?.source) throw new LokiSyncError("mirror_unsupported", 400)
    const parsed = mirrorSourceBody.safeParse(await boundedJson(c.req.raw))
    if (!parsed.success) throw new LokiSyncError("invalid_request", 400)
    const { state, warning } = await mirrorStateFrom(parsed.data.mirror)
    const saved = await getRepo().upstreams.replaceCredentials(row, { config: row.config, state })
    return json({ upstream: serializeUpstream(saved), ...(warning ? { warning } : {}) })
  } catch (error) { return safeError(error) }
})
```

In `public-dto.ts`, add to `PublicUpstream`:

```ts
    lokiSource?: { kind: "mirror"; origin: string }
```

and replace the Loki block in `serializeUpstream`:

```ts
  if (upstream.provider === "loki") {
    try {
      const state = readLokiState(upstream.state)
      dto.lokiStatus = publicLokiStatus(state)
      if (state.source) dto.lokiSource = { kind: "mirror", origin: state.source.origin }
    } catch { /* Invalid private state grants no public data. */ }
  }
```

- [ ] **Step 4: Run tests**

Run: `bun test packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts packages/gateway/tests/control-plane-loki.sqlite.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/control-plane packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts
git commit -m "feat(vnext/loki): devices create and re-import mirror upstreams"
```

---

### Task 7: End-to-end inference and backup stripping

**Files:**
- Test: `packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`

- [ ] **Step 1: Write the tests**

Add imports at the top of the test file:

```ts
import { __resetLokiMirrorPullsForTests, LokiProvider } from "@vibe-llm/provider-loki"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { exportConfig, parseConfigBundle } from "../src/control-plane/lib/import-export"
```

Append:

```ts
test("a device mirror completes inference against Loki with the central token", async () => {
  __resetLokiMirrorPullsForTests()
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  const created = await (await device(issued.document, { staticModels: ["claude-opus-5.5"] })).json() as { upstream: { id: string } }
  const row = (await repo.upstreams.getById(created.upstream.id)) as StoredUpstreamRecord
  // Force a refresh path: the stored token is near expiry, the central one is fresh.
  await repo.upstreams.saveState<unknown>(row.id, current => {
    const state = readLokiState(current)
    return { ...state, credential: { ...state.credential!, accessToken: "stale-token", expiresAt: Date.now() + 60_000 } }
  })
  const bearers: string[] = []
  const provider = new LokiProvider(row, () => repo.upstreams.getById(row.id), async (_url, init) => {
    bearers.push(new Headers(init.headers).get("authorization") ?? "")
    return Response.json({ id: "msg", type: "message", content: [] })
  }, undefined, { save: updater => repo.upstreams.saveState<unknown>(row.id, updater, row) })
  await provider.getModels()
  const result = await provider.fetch({ endpoint: "messages", sourceApi: "anthropic", headers: new Headers(),
    payload: { model: "claude-opus-5.5", messages: [{ role: "user", content: "hello" }], max_tokens: 10 } })
  expect(result.status).toBe(200)
  expect(bearers).toEqual(["Bearer central-token"])
})

test("backups never carry mirror secrets, hashes or sources", async () => {
  const p = await central()
  const issued = await (await issue(p.upstreamId)).json() as Issued
  await device(issued.document)
  const rows = await repo.upstreams.list({ includeDisabled: true })
  const centralHash = readLokiState(rows.find(row => row.id === p.upstreamId)!.state).mirrors![0]!.secretHash
  for (const redactSecrets of [true, false]) {
    const raw = JSON.stringify(exportConfig({ apiKeys: [], githubAccounts: [], upstreams: rows }, { redactSecrets }))
    for (const value of [issued.document.mirrorSecret, centralHash, issued.mirror.id, "central-token"]) expect(raw).not.toContain(value)
    for (const restored of parseConfigBundle(JSON.parse(raw)).bundle.upstreams) {
      expect(restored.state).toMatchObject({ assistantStatus: "waiting", syncSecretHash: "" })
      expect(JSON.stringify(restored.state)).not.toContain("mirror")
    }
  }
})
```

- [ ] **Step 2: Run tests**

Run: `bun test packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`
Expected: PASS without production changes (`withoutLokiAuthority` already replaces the whole state). If the backup test fails, make `withoutLokiAuthority` in `packages/gateway/src/control-plane/lib/import-export.ts` build its state without spreading the input state, as it does today, and rerun.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts
git commit -m "test(vnext/loki): mirror inference end to end and backup stripping"
```

---

### Task 8: Dashboard mirror document helper and types

**Files:**
- Create: `apps/dashboard/src/tabs/upstreams/loki-mirror.ts`
- Modify: `apps/dashboard/src/api/types.ts`
- Test: `apps/dashboard/src/tabs/upstreams/loki-mirror.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/tabs/upstreams/loki-mirror.test.ts`:

```ts
import { expect, test } from "bun:test"
import { formatLokiMirrorDocument, parseLokiMirrorText } from "./loki-mirror"

const doc = { version: 1, kind: "loki-mirror", gatewayOrigin: "https://central.example", upstreamId: "up_loki_central",
  profileId: "loki-df-v1", mirrorId: `lkmid_${"b".repeat(32)}`, mirrorSecret: `lkm_${"c".repeat(64)}` }

test("issued documents format only for this gateway's HTTPS origin", () => {
  expect(JSON.parse(formatLokiMirrorDocument(doc, "https://central.example"))).toEqual(doc)
  expect(() => formatLokiMirrorDocument(doc, "https://other.example")).toThrow()
  expect(() => formatLokiMirrorDocument({ ...doc, mirrorSecret: "lks_x" }, "https://central.example")).toThrow()
})

test("pasted text parses to a document or a null for invalid input", () => {
  expect(parseLokiMirrorText(` ${JSON.stringify(doc)}\n`)).toEqual(doc)
  for (const text of ["", "{", "[]", JSON.stringify({ ...doc, kind: "pairing" }), JSON.stringify({ ...doc, extra: 1 }),
    JSON.stringify({ ...doc, gatewayOrigin: "http://central.example" })]) expect(parseLokiMirrorText(text)).toBeNull()
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/dashboard/src/tabs/upstreams/loki-mirror.test.ts`
Expected: FAIL — cannot resolve `./loki-mirror`.

- [ ] **Step 3: Implement**

Create `apps/dashboard/src/tabs/upstreams/loki-mirror.ts`:

```ts
export interface LokiMirrorDocument {
  version: 1
  kind: "loki-mirror"
  gatewayOrigin: string
  upstreamId: string
  profileId: "loki-df-v1"
  mirrorId: string
  mirrorSecret: string
}

export interface LokiMirrorRow { id: string; label: string; createdAt: number; lastPulledAt: number | null }

const KEYS = ["version", "kind", "gatewayOrigin", "upstreamId", "profileId", "mirrorId", "mirrorSecret"]

function validDocument(value: unknown): value is LokiMirrorDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const doc = value as Record<string, unknown>
  if (Object.keys(doc).some(key => !KEYS.includes(key)) || doc.version !== 1 || doc.kind !== "loki-mirror"
    || doc.profileId !== "loki-df-v1" || typeof doc.gatewayOrigin !== "string"
    || typeof doc.upstreamId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(doc.upstreamId)
    || typeof doc.mirrorId !== "string" || !/^lkmid_[a-f0-9]{32}$/.test(doc.mirrorId)
    || typeof doc.mirrorSecret !== "string" || !/^lkm_[a-f0-9]{64}$/.test(doc.mirrorSecret)) return false
  try {
    const url = new URL(doc.gatewayOrigin)
    return url.protocol === "https:" && url.origin === doc.gatewayOrigin
  } catch { return false }
}

/** Formats a freshly issued document, refusing one that names another gateway. */
export function formatLokiMirrorDocument(value: unknown, expectedOrigin: string): string {
  if (!validDocument(value) || value.gatewayOrigin !== expectedOrigin) throw new Error("Invalid mirror document")
  const { version, kind, gatewayOrigin, upstreamId, profileId, mirrorId, mirrorSecret } = value
  return JSON.stringify({ version, kind, gatewayOrigin, upstreamId, profileId, mirrorId, mirrorSecret }, null, 2)
}

/** Parses pasted text; the server re-validates. */
export function parseLokiMirrorText(text: string): LokiMirrorDocument | null {
  try {
    const value: unknown = JSON.parse(text.trim())
    return validDocument(value) ? value : null
  } catch { return null }
}
```

In `apps/dashboard/src/api/types.ts`, extend the `lokiStatus` object type and add `lokiSource` after it:

```ts
  lokiStatus?: {
    assistantStatus: "waiting" | "authorized" | "interaction_required" | "failed"
    tokenStatus: "missing" | "valid" | "expired"
    expiresAt: number | null
    updatedAt: number | null
    errorCode?: string
  }
  lokiSource?: { kind: "mirror"; origin: string }
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/dashboard/src/tabs/upstreams/loki-mirror.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/tabs/upstreams/loki-mirror.ts apps/dashboard/src/tabs/upstreams/loki-mirror.test.ts apps/dashboard/src/api/types.ts
git commit -m "feat(vnext/dashboard): validate Loki mirror documents"
```

---

### Task 9: Dashboard UI and copy

**Files:**
- Create: `apps/dashboard/src/tabs/upstreams/LokiMirrorsSection.tsx`
- Modify: `apps/dashboard/src/tabs/upstreams/LokiPairingPanel.tsx`
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx:183-191`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (en block after `"dash.lokiExpired"` ≈ line 951; zh block after its `"dash.lokiExpired"`)
- Test: `apps/dashboard/src/tabs/upstreams/loki-settings.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `apps/dashboard/src/tabs/upstreams/loki-settings.test.tsx`:

```tsx
function withWindow<T>(protocol: string, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { protocol, origin: `${protocol}//host` } } })
  try { return run() } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

test("a paired Loki upstream shows device mirror management", () => {
  const html = withWindow("https:", () => renderToStaticMarkup(<LokiPairingPanel row={row} onChanged={noop} onClose={noop} />))
  expect(html).toContain("dash.lokiMirrorsTitle")
  expect(html).toContain("dash.lokiMirrorIssue")
})

test("a mirror upstream shows its source and re-import, not pairing or mirror issuance", () => {
  const mirrorRow: UpstreamRecord = { ...row, lokiSource: { kind: "mirror", origin: "https://central.example" } }
  const html = withWindow("http:", () => renderToStaticMarkup(<LokiPairingPanel row={mirrorRow} onChanged={noop} onClose={noop} />))
  expect(html).toContain("https://central.example")
  expect(html).toContain("dash.lokiMirrorReimport")
  expect(html).not.toContain("dash.lokiNewPairing")
  expect(html).not.toContain("dash.lokiMirrorsTitle")
})

test("creating Loki over plain HTTP offers only the mirror source", () => {
  const html = withWindow("http:", () => renderToStaticMarkup(<LokiPairingPanel onChanged={noop} onClose={noop} />))
  expect(html).toContain("dash.lokiSourceMirror")
  expect(html).toContain("dash.lokiMirrorDocument")
})

test("rows describe a revoked mirror", () => {
  const revoked: UpstreamRecord = { ...row, lokiSource: { kind: "mirror", origin: "https://central.example" },
    lokiStatus: { assistantStatus: "authorized", tokenStatus: "valid", expiresAt: null, updatedAt: null, errorCode: "mirror_revoked" } }
  const html = renderToStaticMarkup(<ToastProvider><UpstreamRow row={revoked} index={0} total={1} busy={false} models={[]}
    onToggleEnabled={noop} onReorder={noop} onEdit={noop} onDuplicate={noop} onRefreshModels={noop}
    onRefreshCredential={noop} onReauth={noop} onDelete={noop} /></ToastProvider>)
  expect(html).toContain("dash.lokiMirrorRevoked")
})
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/dashboard/src/tabs/upstreams/loki-settings.test.tsx`
Expected: FAIL — keys `dash.lokiMirrorsTitle` etc. not rendered.

- [ ] **Step 3: Implement**

Create `apps/dashboard/src/tabs/upstreams/LokiMirrorsSection.tsx`:

```tsx
import { useEffect, useState } from "react"
import { api } from "../../api/client"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Notice } from "../../ui/notice"
import { FormHeading } from "./form/Field"
import { formatLokiMirrorDocument, type LokiMirrorRow } from "./loki-mirror"

export function LokiMirrorsSection({ upstreamId }: { upstreamId: string }) {
  const t = useT()
  const base = `/api/loki/upstreams/${encodeURIComponent(upstreamId)}/mirrors`
  const [mirrors, setMirrors] = useState<LokiMirrorRow[]>([])
  const [label, setLabel] = useState("")
  const [document, setDocument] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const secureOrigin = window.location.protocol === "https:"

  useEffect(() => {
    let live = true
    api<{ mirrors: LokiMirrorRow[] }>(base).then(result => { if (live) setMirrors(result.mirrors) })
      .catch(() => { if (live) setError(t("dash.lokiMirrorError")) })
    return () => { live = false }
  }, [base])

  const issue = async () => {
    setBusy(true); setError(""); setCopied(false); setDocument("")
    try {
      const result = await api<{ mirror: LokiMirrorRow; document: unknown }>(base, { method: "POST", body: { label: label.trim() } })
      setDocument(formatLokiMirrorDocument(result.document, window.location.origin))
      setMirrors(current => [...current, result.mirror])
      setLabel("")
    } catch { setError(t("dash.lokiMirrorError")) }
    finally { setBusy(false) }
  }
  const revoke = async (mirrorId: string) => {
    setBusy(true); setError("")
    try {
      const result = await api<{ mirrors: LokiMirrorRow[] }>(`${base}/${encodeURIComponent(mirrorId)}`, { method: "DELETE" })
      setMirrors(result.mirrors)
    } catch { setError(t("dash.lokiMirrorError")) }
    finally { setBusy(false) }
  }
  const time = (value: number | null) => value ? new Date(value).toLocaleString() : t("dash.lokiMirrorNever")

  return <div className="space-y-3 border-t border-border pt-3">
    <FormHeading offset={1} className="text-body font-medium text-fg">{t("dash.lokiMirrorsTitle")}</FormHeading>
    <p className="text-body text-fg-muted">{t("dash.lokiMirrorsDescription")}</p>
    {!secureOrigin ? <Notice tone="warn" role="status">{t("dash.lokiHttpsRequired")}</Notice> : null}
    <div className="flex flex-wrap items-center gap-2">
      <input type="text" value={label} maxLength={64} placeholder={t("dash.lokiMirrorLabel")} aria-label={t("dash.lokiMirrorLabel")}
        onChange={event => setLabel(event.target.value)} disabled={busy} />
      <Button variant="primary" size="sm" disabled={busy || !secureOrigin || !label.trim()} onClick={issue}>
        {t("dash.lokiMirrorIssue")}
      </Button>
    </div>
    {mirrors.length ? <ul className="space-y-1 text-xs">
      {mirrors.map(mirror => <li key={mirror.id} className="flex items-center justify-between gap-2">
        <span>{mirror.label} · {t("dash.lokiMirrorIssued", { at: time(mirror.createdAt) })} · {t("dash.lokiMirrorLastPull", { at: time(mirror.lastPulledAt) })}</span>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void revoke(mirror.id)}>{t("dash.lokiMirrorRevoke")}</Button>
      </li>)}
    </ul> : null}
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {document ? <div className="space-y-2">
      <p className="text-xs text-fg-subtle">{t("dash.lokiMirrorSecretHint")}</p>
      <textarea readOnly spellCheck={false} aria-label={t("dash.lokiMirrorDocument")} value={document}
        className="w-full bg-muted font-mono text-xs" rows={10} onFocus={event => event.target.select()} />
      <Button variant="secondary" size="sm" onClick={async () => {
        try { await navigator.clipboard.writeText(document); setCopied(true) }
        catch { setError(t("dash.lokiCopyError")) }
      }}>{t(copied ? "dash.lokiMirrorCopied" : "dash.lokiMirrorCopy")}</Button>
    </div> : null}
  </div>
}
```

In `apps/dashboard/src/tabs/upstreams/LokiPairingPanel.tsx`:

1. Imports:

```tsx
import { LokiMirrorsSection } from "./LokiMirrorsSection"
import { parseLokiMirrorText } from "./loki-mirror"
```

2. State, after `const secureOrigin = …`:

```tsx
  const isMirror = row?.lokiSource?.kind === "mirror"
  const [source, setSource] = useState<"pairing" | "mirror">(secureOrigin ? "pairing" : "mirror")
  const [mirrorText, setMirrorText] = useState("")
  const [notice, setNotice] = useState("")
  const mirrorError = (error: unknown) => t(settingsError(error) === "invalid_mirror" ? "dash.lokiMirrorInvalid"
    : settingsError(error) === "invalid_mirror_document" ? "dash.lokiMirrorDocumentInvalid" : "dash.lokiMirrorError")
```

3. Add the create-from-mirror and re-import actions after `revoke`:

```tsx
  const importMirror = async () => {
    const parsedDoc = parseLokiMirrorText(mirrorText)
    if (!parsedDoc) { setError(t("dash.lokiMirrorDocumentInvalid")); return }
    setBusy(true); setError(""); setNotice("")
    try {
      const result = await api<{ upstream: UpstreamRecord; warning?: string }>(id
        ? `/api/loki/upstreams/${encodeURIComponent(id)}/mirror-source` : "/api/loki/upstreams",
      { method: id ? "PUT" : "POST", body: id ? { mirror: parsedDoc }
        : { name, baseUrl: baseUrl.trim(), staticModels: parseLokiModelNames(modelsText), mirror: parsedDoc } })
      setId(result.upstream.id); setMirrorText("")
      setNotice(t(result.warning === "credential_unavailable" ? "dash.lokiMirrorPending" : "dash.lokiMirrorImported"))
      onChanged()
    } catch (error) { setError(mirrorError(error)) }
    finally { setBusy(false) }
  }
  const mirrorInput = <textarea value={mirrorText} rows={8} spellCheck={false} className="w-full font-mono text-xs"
    aria-label={t("dash.lokiMirrorDocument")} placeholder={'{ "kind": "loki-mirror", … }'}
    onChange={event => { setMirrorText(event.target.value); setError("") }} disabled={busy} />
```

4. Form: before the Name field, when creating, render the source choice:

```tsx
      {!id ? <fieldset className="flex flex-wrap gap-4 text-body">
        <legend className="sr-only">{t("dash.lokiSource")}</legend>
        <label><input type="radio" name="loki-source" checked={source === "pairing"} disabled={busy || !secureOrigin}
          onChange={() => setSource("pairing")} /> {t("dash.lokiSourcePairing")}</label>
        <label><input type="radio" name="loki-source" checked={source === "mirror"} disabled={busy}
          onChange={() => setSource("mirror")} /> {t("dash.lokiSourceMirror")}</label>
      </fieldset> : null}
```

After the static-models `Field`, when creating from a mirror:

```tsx
      {!id && source === "mirror" ? <Field label={t("dash.lokiMirrorDocument")} hint={t("dash.lokiMirrorPasteHint")}>
        {() => mirrorInput}
      </Field> : null}
```

Change the form's `onSubmit` and the submit button's `disabled` to account for the mirror source:

```tsx
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void (id ? save() : source === "mirror" ? importMirror() : pair()) }}>
```

```tsx
        disabled={busy || (id ? baseUrl === savedBaseUrl && modelsText === savedModelsText
          : !name.trim() || (source === "mirror" ? !mirrorText.trim() : !secureOrigin))}>
```

5. Replace everything from the pairing `FormHeading` line through the pairing buttons block (the lines rendering `dash.lokiPairTitle`, `dash.lokiPairDescription`, `dash.lokiReplaceHint`, `dash.lokiHttpsRequired`, and the New pairing/Revoke buttons) with:

```tsx
    {isMirror ? <div className="space-y-2 border-t border-border pt-3">
      <FormHeading offset={1} className="text-body font-medium text-fg">{t("dash.lokiMirrorSourceTitle")}</FormHeading>
      <p className="text-body text-fg-muted">{t("dash.lokiMirrorSourceFrom", { origin: row?.lokiSource?.origin ?? "" })}</p>
      {mirrorInput}
      <Button variant="primary" size="sm" disabled={busy || !mirrorText.trim()} onClick={importMirror}>{t("dash.lokiMirrorReimport")}</Button>
    </div> : !id && source === "mirror" ? null : <>
      {id ? <FormHeading offset={1} className="border-t border-border pt-3 text-body font-medium text-fg">{t("dash.lokiPairTitle")}</FormHeading> : null}
      <p className="text-body text-fg-muted">{t("dash.lokiPairDescription")}</p>
      {id ? <p className="text-xs text-fg-subtle">{t("dash.lokiReplaceHint")}</p> : null}
      {!secureOrigin ? <Notice tone="warn" role="status">{t("dash.lokiHttpsRequired")}</Notice> : null}
      {id ? <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={busy || !secureOrigin || !name.trim()} onClick={pair}>
          {busy ? "…" : t("dash.lokiNewPairing")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={revoke}>{t("dash.lokiRevoke")}</Button>
      </div> : null}
    </>}
    {notice ? <p role="status" className="text-xs text-fg-subtle">{notice}</p> : null}
```

6. Just before the closing `</section>`, add:

```tsx
    {id && !isMirror ? <LokiMirrorsSection upstreamId={id} /> : null}
```

In `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx`, inside the Loki status `<span>`, replace the `t(...)` expression with:

```tsx
                {t(u.lokiStatus.errorCode === "mirror_revoked" ? "dash.lokiMirrorRevoked"
                  : u.lokiStatus.errorCode === "account_mismatch" ? "dash.lokiMirrorAccountMismatch"
                  : u.lokiStatus.tokenStatus === "expired" ? (u.lokiSource ? "dash.lokiMirrorExpired" : "dash.lokiExpired") : {
                  waiting: "dash.lokiWaiting", authorized: "dash.lokiAuthorized",
                  interaction_required: "dash.lokiInteractionRequired", failed: "dash.lokiFailed",
                }[u.lokiStatus.assistantStatus])}
```

and give revoked/mismatched mirrors the danger tone by changing `lokiTone`:

```tsx
  const lokiTone: HealthTone | null = u.provider === "loki" && u.lokiStatus
    ? u.lokiStatus.tokenStatus === "expired" || u.lokiStatus.errorCode === "mirror_revoked"
      || u.lokiStatus.errorCode === "account_mismatch" ? "danger" : LOKI_TONE[u.lokiStatus.assistantStatus]
    : null
```

(Keep the existing trailing `: null` or equivalent from the current expression.)

In `packages/gateway/src/shared/edge/ui-pages/i18n.ts`, add to the English block after `"dash.lokiExpired"`:

```ts
      "dash.lokiSource": "Token source",
      "dash.lokiSourcePairing": "Windows assistant pairing",
      "dash.lokiSourceMirror": "Sync from another gateway",
      "dash.lokiMirrorPasteHint": "Paste the mirror document issued by the central gateway's Loki upstream.",
      "dash.lokiMirrorDocument": "Loki mirror document",
      "dash.lokiMirrorDocumentInvalid": "This is not a valid Loki mirror document.",
      "dash.lokiMirrorInvalid": "The central gateway rejected this document. It may have been revoked; issue a new one.",
      "dash.lokiMirrorError": "Could not update device mirrors. Refresh and try again.",
      "dash.lokiMirrorImported": "Mirror imported. Token received.",
      "dash.lokiMirrorPending": "Mirror imported. The central gateway has no valid token yet; it will be pulled automatically.",
      "dash.lokiMirrorsTitle": "Device mirrors",
      "dash.lokiMirrorsDescription": "Each device's local gateway can pull this upstream's token with its own mirror document. Revoking a device stops new pulls; a token it already holds lasts until it expires.",
      "dash.lokiMirrorLabel": "Device name",
      "dash.lokiMirrorIssue": "Issue mirror",
      "dash.lokiMirrorIssued": "issued {at}",
      "dash.lokiMirrorLastPull": "last pull {at}",
      "dash.lokiMirrorNever": "never",
      "dash.lokiMirrorRevoke": "Revoke",
      "dash.lokiMirrorSecretHint": "Shown once. Paste it into the device's local gateway under Add Loki → Sync from another gateway. Keep it private.",
      "dash.lokiMirrorCopy": "Copy mirror document",
      "dash.lokiMirrorCopied": "Mirror document copied",
      "dash.lokiMirrorSourceTitle": "Token source",
      "dash.lokiMirrorSourceFrom": "Synced from {origin}. Paste a new mirror document to replace it.",
      "dash.lokiMirrorReimport": "Re-import mirror document",
      "dash.lokiMirrorRevoked": "Mirror revoked; import a new document",
      "dash.lokiMirrorAccountMismatch": "Central account changed; import a new document",
      "dash.lokiMirrorExpired": "Token expired; waiting for the central gateway",
```

and to the Chinese block after its `"dash.lokiExpired"`:

```ts
      "dash.lokiSource": "Token 来源",
      "dash.lokiSourcePairing": "Windows 助手配对",
      "dash.lokiSourceMirror": "从其他网关同步",
      "dash.lokiMirrorPasteHint": "粘贴中心网关 Loki upstream 签发的 mirror 文档。",
      "dash.lokiMirrorDocument": "Loki mirror 文档",
      "dash.lokiMirrorDocumentInvalid": "这不是有效的 Loki mirror 文档。",
      "dash.lokiMirrorInvalid": "中心网关拒绝了这份文档，可能已被吊销，请重新签发。",
      "dash.lokiMirrorError": "无法更新设备 mirror，请刷新后重试。",
      "dash.lokiMirrorImported": "已导入 mirror，已获取 token。",
      "dash.lokiMirrorPending": "已导入 mirror。中心网关暂无有效 token，稍后会自动拉取。",
      "dash.lokiMirrorsTitle": "设备 mirror",
      "dash.lokiMirrorsDescription": "每台设备的本地网关可以用各自的 mirror 文档拉取这个 upstream 的 token。吊销后设备无法再拉取，已拿到的 token 会在过期前继续有效。",
      "dash.lokiMirrorLabel": "设备名称",
      "dash.lokiMirrorIssue": "签发 mirror",
      "dash.lokiMirrorIssued": "签发于 {at}",
      "dash.lokiMirrorLastPull": "最近拉取 {at}",
      "dash.lokiMirrorNever": "从未",
      "dash.lokiMirrorRevoke": "吊销",
      "dash.lokiMirrorSecretHint": "只显示一次。请粘贴到设备本地网关的「添加 Loki → 从其他网关同步」。请妥善保管。",
      "dash.lokiMirrorCopy": "复制 mirror 文档",
      "dash.lokiMirrorCopied": "已复制 mirror 文档",
      "dash.lokiMirrorSourceTitle": "Token 来源",
      "dash.lokiMirrorSourceFrom": "同步自 {origin}。粘贴新的 mirror 文档可替换。",
      "dash.lokiMirrorReimport": "重新导入 mirror 文档",
      "dash.lokiMirrorRevoked": "Mirror 已被吊销，请导入新文档",
      "dash.lokiMirrorAccountMismatch": "中心账号已变更，请导入新文档",
      "dash.lokiMirrorExpired": "Token 已过期，等待中心网关",
```

- [ ] **Step 4: Run tests and build**

Run: `bun test apps/dashboard && bun run build:ui`
Expected: PASS; build succeeds. If an i18n completeness test exists, it passes with both blocks updated.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(vnext/dashboard): issue device mirrors and import them on devices"
```

---

### Task 10: Protocol documentation

**Files:**
- Modify: `docs/loki-sync-v1.md`

- [ ] **Step 1: Append a section**

Append to `docs/loki-sync-v1.md`:

```markdown
## Device mirror

A device mirror lets another gateway (typically a local Docker gateway on one of the owner's devices) use this upstream's
current Loki token, so the device can call Loki directly. This is a deliberate, scoped exception to "never return tokens":
the token leaves the gateway only to the holder of a mirror secret issued for this upstream by its owner.

Management (real session, same Origin rules as pairing): `GET /api/loki/upstreams/{id}/mirrors`,
`POST /api/loki/upstreams/{id}/mirrors` with `{ "label": "MacBook" }` (HTTPS gateways only; at most 16), and
`DELETE /api/loki/upstreams/{id}/mirrors/{mirrorId}`. Issuing returns the document once:

```json
{ "version": 1, "kind": "loki-mirror", "gatewayOrigin": "https://gateway.example", "upstreamId": "up_loki_example",
  "profileId": "loki-df-v1", "mirrorId": "lkmid_<32 hex>", "mirrorSecret": "lkm_<64 hex>" }
```

Only the SHA-256 of the secret is stored. Re-pairing the assistant keeps mirrors; disconnecting it revokes them all.
Backups never contain mirrors or mirror sources.

Pull: `GET /api/loki/mirror/{upstreamId}` with `Authorization: Bearer lkm_…`. 200 returns
`{ version, profileId, mirrorId, credential }` only for a credential with more than 60 seconds left;
`401 invalid_mirror` for an unknown or revoked secret, missing upstream or disabled owner;
`503 credential_unavailable` when no such credential exists. Responses are `no-store`.

A device creates a mirror upstream with `POST /api/loki/upstreams` and `{ name, mirror: <document> }` (HTTP is allowed
on the device), or replaces its source with `PUT /api/loki/upstreams/{id}/mirror-source`. Either pulls once; a revoked
document fails with `400 invalid_mirror` and creates nothing. A mirror upstream refreshes when its token has five minutes
or less left, uses an unexpired token if a pull fails, retries after 30 seconds, and stops automatic pulls after
`invalid_mirror` or an account change until the document is re-imported. Pairing and mirror issuance are unavailable on
mirror upstreams.
```

- [ ] **Step 2: Commit**

```bash
git add docs/loki-sync-v1.md
git commit -m "docs(vnext/loki): document device mirrors"
```

---

### Task 11: Full verification

- [ ] **Step 1: Run the full local CI**

Run: `bun run ci:local`
Expected: all stages pass (purity check, typecheck, tests, lint, Cloudflare deploy dry-run). Fix any failures in the task that introduced them and commit the fix there.

- [ ] **Step 2: Manual smoke on this Mac (after deploying the Worker)**

1. `wrangler deploy` from `apps/platform-cloudflare` (owner action).
2. On `https://token.xianliao.de5.net`, open the Loki upstream → Device mirrors → issue "MacBook", copy the document.
3. `docker compose -f docker-compose.vnext.yml up -d --build`; open `http://localhost:41414`, Add Loki → Sync from another gateway, paste, save. Expect "Token received".
4. Point Claude Code at `http://localhost:41414` with a local API key and send a short prompt using a Loki model. Expect success.
5. Confirm no new `tunneling to …githubcopilot.com` / `…loki.delve.office.com` entries for this device in the VM's trojan log.
