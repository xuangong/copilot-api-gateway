# Gateway Upstream Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner select upstreams on the central gateway, hand a device a one-time sync document, and have the device's local gateway pull identical copies of those upstreams every 60 seconds, replacing the Loki-only device mirror.

**Architecture:** The central gateway gains a `sync_devices` table, session-guarded device management routes and an unauthenticated `GET /api/sync/snapshot` (bearer `sds_` secret, `ETag`/`304`) that serves the selected, owned, `syncable` upstreams through each provider's `syncView`. A Bun/Docker device gateway stores at most one `sync_sources` row, fetches snapshots directly (no proxy chain), and applies them with a provider-agnostic repository upsert that keeps `enabled`, `sort_order` and the proxy list device-local, tags rows with `upstreams.sync_source_id`, and creates their providers with `credentialsReadOnly: true`. The Loki device mirror (state fields, pull logic, routes, UI, tests) is removed first.

**Tech Stack:** Bun workspaces, TypeScript, Hono, zod, bun:test with in-memory SQLite (`BunSqliteRepo`) and Miniflare D1, React dashboard rendered with `react-dom/server` in tests.

**Spec:** `vnext/docs/superpowers/specs/2026-11-16-gateway-upstream-sync-design.md` (supersedes `2026-11-16-loki-device-mirror-design.md`).

All paths below are relative to `vnext/`. Run commands from `vnext/` (`/Users/xian/projects/copilot-api-gateway/vnext`). Gateway test paths need the `./` prefix, e.g. `bun test ./packages/gateway/tests/<file>`.

---

## Repository rules for every task

- **Never run plain `bun install`.** A local registry mirror rewrites `bun.lock`. When a dependency is removed or added, edit `bun.lock` by hand, then verify `grep -c mirrors.cloud.tencent bun.lock` prints `0` and `bun install --frozen-lockfile --dry-run` succeeds (Task 1 and Task 15 do this).
- **Never `git add -A` or `git add .`.** Stage the exact files listed in each commit step. Do not touch the untracked `docs/loki-safety-check-2026-11-14.md`.
- **Known baseline:** the full suite has 11 pre-existing failures (provider-cancellation-forwarding, respond-json JSON fallback/terminal, and `docs/superpowers/research` harness tests). Acceptance is "no new failures", never "all green".
- Every commit message ends with a blank line and `Co-Authored-By: Claude <noreply@anthropic.com>`. Commit commands below use a heredoc so the trailer is preserved.
- Do not push, and do not switch branches. Work on `feat/gateway-upstream-sync`.
- If a "run to see it fail" step does not fail as described, stop and find out why before writing the implementation.

## Decisions where the spec is silent or the code forces a choice

| # | Decision | Reason |
| --- | --- | --- |
| D1 | `sync_source_id` is written only by `INSERT` and never updated. It is deliberately absent from `upstreams_catalog_generation` and `configuration_upstreams_update` (migration `0025`), so setting or reading it never bumps catalog generation or the configuration revision. | A row belongs to one source for life (PUT replaces the document in place and keeps the source id), so there is no transition that needs a bump. |
| D2 | Device apply advances both `catalog_generation` and `credential_generation` (the way `replaceCredentials` does) only when `provider` or `config` changed. A change confined to `state` or to `name`/`flagOverrides`/`disabledPublicModelIds` writes without bumping. | The device cannot tell which part of `state` is a credential. Copilot's credential is `config.githubToken`; Loki reads its token from state on every call, so an hourly token rotation must not churn catalogs. Metadata changes already reach caches through the `configuration_revision` trigger. |
| D3 | Synced upstreams get `owner_id` = the user who connected the source, stored in a `sync_sources.owner_id` column that the spec table does not list. | The dashboard's reorder/toggle model is per owner group; owner `''` would render the rows read-only. A scheduler has no session, so the owner must be persisted. |
| D4 | The device ETag is the quoted SHA-256 of the body bytes the device actually received, computed locally; the response `ETag` header is ignored. | Intermediaries may rewrite `ETag` headers; the central defines the ETag as the same hash, so both sides agree without trusting the header. |
| D5 | If any entry was skipped (`id_conflict`, `unsupported_provider`) the new ETag is not stored and the stored one is cleared, so the next tick refetches a 200 and retries the skipped entries. | Otherwise a later fix (deleting the clashing local row) would never be picked up while central is unchanged and answers 304. |
| D6 | A snapshot entry whose provider `syncView` throws (for example invalid Loki state) is omitted from the snapshot. | A broken record must not leak raw state; omission makes the device remove its copy, which is the safe direction. |
| D7 | `readLokiState` accepts a missing `syncSecretHash` and reads it as `""`. | `syncView` removes the field; the device must still parse the state. Central still refuses `""` hashes everywhere. |
| D8 | Device source routes: any session user may `POST` (single source, `409 sync_source_exists` for everyone after the first); `GET` returns `source: null` to non-owners; `PUT`/`DELETE` return `404 sync_source_not_found` unless the caller is the source owner or an administrator. `PUT` with no source is `404 sync_source_not_found`. Ownership of synced upstreams never changes on `PUT`. | Spec lists the routes but not who may call them. |
| D9 | `GET /api/sync/source` also returns `available: boolean` (`true` only on the Bun runtime); `POST`/`PUT` answer `501 device_sync_unavailable` elsewhere. | Cloudflare Workers do not run device sync; the dashboard must hide the section instead of offering a dead control. |
| D10 | The shared session guard requires the `Origin` header for cookie sessions only on mutating methods (it still rejects a mismatched `Origin` on any method). Token sessions (`Authorization: Bearer ses_...`) are unchanged. | Browsers omit `Origin` on same-origin `GET`, so the Loki guard's "cookie without Origin is forbidden" rule would break the dashboard's `GET /api/sync/devices`. `docs/loki-sync-v1.md` already states the rule as "cookie-based mutations". |
| D11 | All synced-read-only rejections, on every route, answer `409` with body `{ "error": { "code": "synced_upstream_read_only" } }`. | One shape the dashboard can map by code; matches the `{ error: { code } }` family the sync and Loki routes already use. |
| D12 | `save()` (used by import) never overwrites a row that has `sync_source_id`; import merge skips ids of live synced rows. | Import must not convert a synced row into a normal one or edit its credentials. |
| D13 | The device scheduler is `createDeviceSyncScheduler` (pure, injectable timers) in the gateway package; only `apps/platform-bun/src/server.ts` calls `startDeviceSync()`. Tests never start it except with fake timers. | Keeps Workers and tests free of background timers. |
| D14 | An in-process mutex (`syncLock`) serializes the scheduler tick, `POST`/`PUT`/`DELETE /api/sync/source`. The tick uses `tryAcquire` (skips when busy); routes wait. | "One sync runs at a time" plus protection against a tick applying a snapshot for a document that was just replaced. |
| D15 | If applying a snapshot throws after the source row was stored by `POST`, the source stays, `last_error = apply_failed`, and the route answers `503 temporarily_unavailable`; the next tick retries. | The fetch already proved the document valid; the failure is local. |
| D16 | Device-side snapshot parsing ignores unknown fields on upstream entries (forward compatibility) but requires every known field to validate; sync documents reject unknown fields as the spec requires. | An older device must keep working against a newer central. |
| D17 | A synced row's "Refetch models" button is hidden along with Edit/Duplicate/Re-auth/Delete/Refresh credential. | Spec: synced rows keep only enable, reorder and proxy settings. |
| D18 | A row this source already synced whose provider becomes unknown to the device is deleted (not just skipped); it is re-created if the provider becomes supported again, losing device-local enabled/order/proxy. | Skipped entries are not "kept", so the delete pass removes them; a stale copy of an unsupported provider must not linger. |

## File structure

| File | Responsibility |
| --- | --- |
| `packages/provider-loki/src/state.ts` (modify) | Drop mirror/source state; tolerate and discard legacy fields; optional `syncSecretHash`; `lokiSyncState` |
| `packages/provider-loki/src/mirror.ts` (delete) | Removed device mirror client |
| `packages/provider-loki/src/provider.ts` (modify) | Drop mirror pull; `credentialsReadOnly` option |
| `packages/provider-loki/src/plugin.ts` (modify) | `syncable`, `syncView`, pass `credentialsReadOnly` |
| `packages/provider-loki/src/index.ts`, `package.json`, `bun.lock` (modify) | Drop mirror export and the unused `@vibe-core/platform` dependency |
| `packages/provider-loki/src/__tests__/{mirror,mirror-state,provider-mirror}.test.ts` (delete) | Removed with the feature |
| `packages/provider-loki/src/__tests__/{state,synced}.test.ts` (modify/create) | Legacy-state tolerance; synced credential and `syncView` |
| `packages/provider-llm/src/plugin.ts` (modify) | `credentialsReadOnly`, `syncable`, `syncView`, `SyncView` |
| `packages/provider-copilot/src/plugin.ts` (modify) | `syncable: true` |
| `packages/gateway/src/data-plane/providers/registry.ts` (modify) | `providerPlugin`, `isSyncableProvider`, pass `credentialsReadOnly` |
| `packages/gateway/migrations/0025_gateway_upstream_sync.sql` (create) | `sync_devices`, `sync_sources`, `upstreams.sync_source_id` |
| `packages/gateway/tests/schema-baseline.txt`, `tests/migrations.test.ts` (modify) | Baseline and upgrade test |
| `packages/gateway/src/repo/sync.ts` (create) | Sync repo types |
| `packages/gateway/src/repo/shared/sync.ts` (create) | `SharedSyncDeviceRepo`, `SharedSyncSourceRepo` |
| `packages/gateway/src/repo/types.ts`, `repo/index.ts`, `repo/shared/repos.ts`, `repo/configuration-cache.ts` (modify) | `Repo.syncDevices/syncSources`, `UpstreamRepo.listSynced/applySynced/deleteSynced`, `syncSourceId` |
| `apps/platform-bun/src/bun-sqlite-repo.ts`, `apps/platform-cloudflare/src/d1-repo.ts` (modify) | Expose the new repos |
| `packages/gateway/src/sync/protocol.ts` (create) | Constants, document and snapshot types, parsing/formatting |
| `packages/gateway/src/sync/fetch.ts` (create) | Device snapshot fetch client |
| `packages/gateway/src/sync/apply.ts` (create) | Device snapshot apply pass |
| `packages/gateway/src/sync/engine.ts` (create) | `syncLock`, `syncSource`, `connectSource`, `disconnectSource`, `runScheduledSync` |
| `packages/gateway/src/sync/scheduler.ts`, `hooks.ts`, `index.ts` (create) | Scheduler, post-import hook, `startDeviceSync` |
| `packages/gateway/package.json` (modify) | `./sync` export |
| `apps/platform-bun/src/server.ts` (modify) | Start device sync |
| `packages/gateway/src/control-plane/shared/session-guard.ts` (create) | Shared real-session + Origin guard |
| `packages/gateway/src/control-plane/sync/common.ts` (create) | `SyncError`, JSON helpers, hashing |
| `packages/gateway/src/control-plane/sync/devices.ts` (create) | Central device management routes |
| `packages/gateway/src/control-plane/sync/snapshot.ts` (create) | Central snapshot endpoint |
| `packages/gateway/src/control-plane/sync/source.ts` (create) | Device source routes |
| `packages/gateway/src/control-plane/sync/routes.ts` (create) | `syncManagementRouter` |
| `packages/gateway/src/control-plane/sync/read-only.ts` (create) | Read-only error, response, origin lookup |
| `packages/gateway/src/control-plane/loki/{routes,common,mirror}.ts`, `app.ts`, `control-plane/routes.ts` (modify/delete) | Mirror removal, shared guard, mounts |
| `packages/gateway/src/control-plane/upstreams/{routes,public-dto,codex-credentials-routes}.ts` (modify) | Read-only enforcement, DTO fields |
| `packages/gateway/src/control-plane/{lib/github,auth/github-routes,auth/session-auth,auth/routes,lib/import-export,data-transfer/routes}.ts` (modify) | Guards, `sds_` rejection, cascade, import/export exclusion |
| `packages/gateway/tests/sync-*.test.ts`, `sync-e2e.sqlite.test.ts` (create) | Per-layer and end-to-end tests |
| `apps/dashboard/src/api/{sync.ts,types.ts}` (create/modify) | Client and types |
| `apps/dashboard/src/tabs/upstreams/{sync-document,sync-errors,sync-devices}.ts` (create) | Pure helpers |
| `apps/dashboard/src/tabs/upstreams/{SyncDevicesSection,SyncSourceSection}.tsx` (create) | Central and device sections |
| `apps/dashboard/src/tabs/upstreams/{UpstreamsTab,UpstreamRow,LokiPairingPanel}.tsx`, `loki-*.ts` (modify/delete) | Mounting, synced rows, mirror UI removal |
| `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (modify) | Remove mirror keys; add sync keys (EN and ZH) |
| `docs/loki-sync-v1.md`, `docs/gateway-sync-v1.md`, old mirror spec (modify/create) | Documentation |

## Task order and why it differs from the suggested outline

The suggested order is kept, with one adjustment: the device orchestration (mutex, run loop, connect/disconnect, scheduler) gets its own Task 8 so Task 7 (pure apply pass) and Task 9 (HTTP routes) each stay reviewable. That makes 15 tasks.

---

### Task 1: Remove the Loki device mirror

Paired Loki (assistant pairing, `syncSecretHash`, sync v1 uploads) keeps working unchanged. Stored state that still contains `mirrors`, `source`, `errorCode: "mirror_revoked"` or `"account_mismatch"` must read without error and have those fields dropped.

**Files:**
- Modify: `packages/provider-loki/src/state.ts` (replace whole file), `provider.ts` (replace whole file), `plugin.ts`, `index.ts`, `package.json`
- Delete: `packages/provider-loki/src/mirror.ts`, `src/__tests__/mirror.test.ts`, `src/__tests__/mirror-state.test.ts`, `src/__tests__/provider-mirror.test.ts`
- Modify: `bun.lock` (remove one line, by hand)
- Modify: `packages/gateway/src/control-plane/loki/routes.ts` (replace whole file), `loki/common.ts` (line 2 and lines 43-48), `packages/gateway/src/app.ts` (lines 14 and 90), `packages/gateway/src/control-plane/upstreams/public-dto.ts` (lines 15 and 150)
- Delete: `packages/gateway/src/control-plane/loki/mirror.ts`, `packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts`
- Test: `packages/provider-loki/src/__tests__/state.test.ts`, `packages/gateway/tests/control-plane-loki.sqlite.test.ts`
- Dashboard: delete `LokiMirrorsSection.tsx`, `loki-mirror.ts`, `loki-mirror.test.ts`, `loki-status.ts` (all under `apps/dashboard/src/tabs/upstreams/`); replace `LokiPairingPanel.tsx`, `loki-errors.ts`, `loki-errors.test.ts`, `loki-settings.test.tsx`; modify `UpstreamRow.tsx` (lines 2, 144-147 and 185) and `apps/dashboard/src/api/types.ts` (lines 55 and 57)
- i18n: `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (delete the `dash.lokiSource*` and `dash.lokiMirror*` keys in both locales)
- Docs: `docs/loki-sync-v1.md` (delete the "Device mirror" section, line 134 to the end)

- [ ] **Step 1: Write the failing tests**

Append to `packages/provider-loki/src/__tests__/state.test.ts` (after the last test; the file already defines `empty` and imports `readLokiState`):

```ts
test("stored state from the removed device mirror reads without error and drops the mirror fields", () => {
  const legacy = {
    ...empty(),
    mirrors: [{ id: "lkmid_x", label: "old", secretHash: "z", createdAt: 1, unexpected: true }],
    source: { kind: "mirror", origin: "http://not-https.example", mirrorSecret: "junk" },
    errorCode: "mirror_revoked",
  }
  const state = readLokiState(legacy)
  expect(state).not.toHaveProperty("mirrors")
  expect(state).not.toHaveProperty("source")
  expect(state.errorCode).toBeUndefined()
  expect(readLokiState({ ...empty(), errorCode: "account_mismatch" }).errorCode).toBeUndefined()
  expect(readLokiState({ ...empty(), errorCode: "broker_unavailable" }).errorCode).toBe("broker_unavailable")
})
```

Append to `packages/gateway/tests/control-plane-loki.sqlite.test.ts` (add `import { serializeUpstream } from "../src/control-plane/upstreams/public-dto"` to the imports):

```ts
test("rows written by the removed device mirror still serialize and drop the mirror fields", async () => {
  await repo.upstreams.save({
    id: "up_loki_legacy_mirror", ownerId: owner, provider: "loki", name: "Legacy", enabled: true, sortOrder: 0,
    config: { profileId: "loki-df-v1" }, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
    createdAt: stamp, updatedAt: stamp,
    state: { version: 1, profileId: "loki-df-v1", generation: "g", syncSecretHash: "h", revision: 0, assistantStatus: "waiting",
      mirrors: [{ id: `lkmid_${"a".repeat(32)}`, label: "old", secretHash: "b".repeat(64), createdAt: 1 }], errorCode: "mirror_revoked" },
  })
  const dto = serializeUpstream((await repo.upstreams.getById("up_loki_legacy_mirror" as never))!)
  expect(dto).not.toHaveProperty("lokiSource")
  expect(dto.lokiStatus).toEqual({ assistantStatus: "waiting", tokenStatus: "missing", expiresAt: null, updatedAt: null })
})
```

Replace `apps/dashboard/src/tabs/upstreams/loki-settings.test.tsx` with:

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { UpstreamRecord } from "../../api/types"
import { ToastProvider } from "../../state/toast"
import { LokiPairingPanel } from "./LokiPairingPanel"
import { UpstreamRow } from "./UpstreamRow"

const row: UpstreamRecord = { id: "loki-fixture", provider: "loki", name: "Loki", enabled: true, sortOrder: 0,
  config: {}, disabledPublicModelIds: [], createdAt: "", updatedAt: "" }
const noop = () => {}

test("a Loki row lists its models like any other upstream", () => {
  const html = renderToStaticMarkup(<ToastProvider><UpstreamRow
    row={row} index={0} total={1} busy={false} models={[{ id: "claude-opus-5.5", name: "claude-opus-5.5" }]} onToggleEnabled={noop} onReorder={noop} onEdit={noop} onDuplicate={noop}
    onRefreshModels={noop} onRefreshCredential={noop} onReauth={noop} onDelete={noop} />
  </ToastProvider>)
  expect(html).toContain("dash.modelsServedHeader")
  expect(html).toContain("claude-opus-5.5")
})

function withWindow<T>(protocol: string, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { protocol, origin: `${protocol}//host` } } })
  try { return run() } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous)
    else Reflect.deleteProperty(globalThis, "window")
  }
}

test("a paired Loki upstream offers pairing controls and no device mirrors", () => {
  const html = withWindow("https:", () => renderToStaticMarkup(<LokiPairingPanel row={row} onChanged={noop} onClose={noop} />))
  expect(html).toContain("dash.lokiNewPairing")
  expect(html).toContain("dash.lokiRevoke")
  expect(html).not.toContain("dash.lokiMirror")
})

test("creating Loki over plain HTTP explains that pairing needs HTTPS and offers no other source", () => {
  const html = withWindow("http:", () => renderToStaticMarkup(<LokiPairingPanel onChanged={noop} onClose={noop} />))
  expect(html).toContain("dash.lokiHttpsRequired")
  expect(html).not.toContain('type="radio"')
  expect(html).not.toContain("dash.lokiMirrorDocument")
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test packages/provider-loki/src/__tests__/state.test.ts ./packages/gateway/tests/control-plane-loki.sqlite.test.ts apps/dashboard/src/tabs/upstreams/loki-settings.test.tsx`

Expected: FAIL. The state test throws `invalid_request` (the strict mirror parser rejects `unexpected`), the gateway test fails on the `errorCode`/`lokiSource` expectations, and the dashboard test fails because `dash.lokiMirrorsTitle` is still rendered.

- [ ] **Step 3: Replace `packages/provider-loki/src/state.ts`**

```ts
export interface LokiAccount {
  homeAccountId: string
  tenantId: string
}

export interface LokiCredential {
  accessToken: string
  tokenType: "Bearer"
  expiresAt: number
  account: LokiAccount
}

export type LokiAssistantStatus = "waiting" | "authorized" | "interaction_required" | "failed"
export type LokiErrorCode = "interaction_required" | "broker_unavailable" | "invalid_result" | "acquisition_failed"

export const LOKI_MIN_CREDENTIAL_TTL_MS = 60_000

export interface LokiSyncUpdate {
  version: 1
  generation: string
  expectedRevision: number
  requestId: string
  status: Exclude<LokiAssistantStatus, "waiting">
  credential?: LokiCredential
  errorCode?: LokiErrorCode
}

export interface LokiState {
  version: 1
  profileId: "loki-df-v1"
  generation: string
  syncSecretHash: string
  revision: number
  assistantStatus: LokiAssistantStatus
  account?: LokiAccount
  credential?: LokiCredential
  errorCode?: LokiErrorCode
  updatedAt?: number
  lastReceipt?: { requestId: string; payloadHash: string }
}

export class LokiSyncError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

const invalid = (): never => { throw new LokiSyncError("invalid_request", 400) }
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const text = (value: unknown, max = 512): string =>
  typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    && Array.from(value).every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127) ? value : invalid()
const integer = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : invalid()
function only(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) return invalid()
}

function parseAccount(value: unknown): LokiAccount {
  const account = record(value)
  only(account, ["homeAccountId", "tenantId"])
  const tenantId = text(account.tenantId)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) return invalid()
  return { homeAccountId: text(account.homeAccountId), tenantId: tenantId.toLowerCase() }
}

export function parseLokiCredential(value: unknown): LokiCredential {
  const credential = record(value)
  only(credential, ["accessToken", "tokenType", "expiresAt", "account"])
  if (credential.tokenType !== "Bearer") return invalid()
  return { accessToken: text(credential.accessToken, 48 * 1024), tokenType: "Bearer",
    expiresAt: integer(credential.expiresAt), account: parseAccount(credential.account) }
}

export function parseLokiSyncUpdate(value: unknown): LokiSyncUpdate {
  const source = record(value)
  only(source, ["version", "generation", "expectedRevision", "requestId", "status", "credential", "errorCode"])
  if (source.version !== 1 || (source.status !== "authorized" && source.status !== "interaction_required" && source.status !== "failed")) return invalid()
  const status = source.status as LokiSyncUpdate["status"]
  if (status !== "authorized" && source.credential !== undefined) return invalid()
  if (status === "authorized" && source.errorCode !== undefined) return invalid()
  const errorCode = source.errorCode
  if (errorCode !== undefined && errorCode !== "interaction_required" && errorCode !== "broker_unavailable"
    && errorCode !== "invalid_result" && errorCode !== "acquisition_failed") return invalid()
  return {
    version: 1, generation: text(source.generation, 128), expectedRevision: integer(source.expectedRevision),
    requestId: text(source.requestId, 128), status,
    ...(status === "authorized" ? { credential: parseLokiCredential(source.credential) } : {}),
    ...(errorCode === undefined ? {} : { errorCode }),
  }
}

export function applyLokiSyncUpdate(state: LokiState, update: LokiSyncUpdate, payloadHash: string, now: number): LokiState {
  if (state.generation !== update.generation) throw new LokiSyncError("binding_replaced", 409)
  if (state.lastReceipt?.requestId === update.requestId) {
    if (state.lastReceipt.payloadHash !== payloadHash) throw new LokiSyncError("request_conflict", 409)
    return state
  }
  if (state.revision !== update.expectedRevision || state.revision >= Number.MAX_SAFE_INTEGER) throw new LokiSyncError("revision_conflict", 409)
  const credential = update.credential
  if (credential) {
    if (credential.expiresAt <= now + LOKI_MIN_CREDENTIAL_TTL_MS) throw new LokiSyncError("credential_expired", 400)
    if (state.account && (state.account.homeAccountId !== credential.account.homeAccountId
      || state.account.tenantId !== credential.account.tenantId)) throw new LokiSyncError("account_mismatch", 409)
  }
  const { errorCode: _previousError, ...current } = state
  return {
    ...current, revision: state.revision + 1, assistantStatus: update.status, updatedAt: now,
    ...(credential ? { credential, account: credential.account } : {}),
    ...(update.errorCode ? { errorCode: update.errorCode } : {}),
    lastReceipt: { requestId: update.requestId, payloadHash },
  }
}

export function publicLokiStatus(state: LokiState, now = Date.now()) {
  return {
    assistantStatus: state.assistantStatus,
    tokenStatus: !state.credential ? "missing" as const : state.credential.expiresAt <= now ? "expired" as const : "valid" as const,
    expiresAt: state.credential?.expiresAt ?? null,
    updatedAt: state.updatedAt ?? null,
    ...(state.errorCode ? { errorCode: state.errorCode } : {}),
  }
}

const STORED_ERROR_CODES = new Set(["interaction_required", "broker_unavailable", "invalid_result", "acquisition_failed"])

export function readLokiState(value: unknown): LokiState {
  const source = record(value)
  if (source.version !== 1 || source.profileId !== "loki-df-v1"
    || (source.assistantStatus !== "waiting" && source.assistantStatus !== "authorized" && source.assistantStatus !== "interaction_required" && source.assistantStatus !== "failed")
    || typeof source.syncSecretHash !== "string") return invalid()
  const state: LokiState = {
    version: 1, profileId: "loki-df-v1", generation: text(source.generation, 128),
    syncSecretHash: source.syncSecretHash, revision: integer(source.revision),
    assistantStatus: source.assistantStatus as LokiAssistantStatus,
    ...(source.account === undefined ? {} : { account: parseAccount(source.account) }),
    ...(source.credential === undefined ? {} : { credential: parseLokiCredential(source.credential) }),
    ...(source.updatedAt === undefined ? {} : { updatedAt: integer(source.updatedAt) }),
  }
  if (source.lastReceipt !== undefined) {
    const receipt = record(source.lastReceipt)
    state.lastReceipt = { requestId: text(receipt.requestId, 128), payloadHash: text(receipt.payloadHash) }
  }
  if (typeof source.errorCode === "string" && STORED_ERROR_CODES.has(source.errorCode)) {
    state.errorCode = source.errorCode as LokiErrorCode
  }
  return state
}

const sameAccount = (a: LokiAccount, b: LokiAccount) => a.homeAccountId === b.homeAccountId && a.tenantId === b.tenantId

/** The stored credential, if it is unexpired and belongs to the bound account. */
export function usableLokiCredential(state: LokiState, now: number): LokiCredential | undefined {
  const credential = state.credential
  return credential && state.account && credential.expiresAt > now && sameAccount(credential.account, state.account)
    ? credential : undefined
}
```

- [ ] **Step 4: Replace `packages/provider-loki/src/provider.ts`**

The mirror pull, single-flight maps, backoff and `LokiProviderOptions.save/mirrorFetcher/background/waitMs` are gone; `now` stays for tests. Everything from `getModels()` down is unchanged.

```ts
import type { ModelPricing } from "@vibe-llm/protocols/common"
import { probeViaModels, resolveExecutionFetcher, type ExecutionFetcherForRequest, type LlmModelProvider,
  type ProviderModelsResponse, type ProviderRequest, type ProviderResponse } from "@vibe-llm/provider-llm"
import { directFetcher, type Fetcher } from "@vibe-core/upstream"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { LOKI_HEADERS, LOKI_PROFILE_ID } from "./profile"
import { lokiBaseUrl } from "./config"
import { isLokiEndpoint, lokiContextWindow, lokiModelEndpoints, LOKI_PATHS, normalizeLokiModels } from "./models"
import { lokiModelPricing } from "./pricing"
import { readLokiState, usableLokiCredential, type LokiCredential } from "./state"
import { LOKI_CONVERSATION_HEADERS, lokiConversationId } from "./conversation"
import { lokiMessagesBetaHeader, normalizeLokiMessages } from "./messages"
import { lokiRequestShape } from "./diagnostics"
import { lokiMessagesRejection } from "./rejections"

/** How long a live refresh keeps a name Loki has stopped listing. */
const LOKI_MISSING_RETENTION_MS = 24 * 60 * 60 * 1000

export interface LokiProviderOptions {
  now?: () => number
}

export class LokiProvider implements LlmModelProvider {
  readonly kind = "loki" as const
  readonly supportedEndpoints = ["messages", "responses", "chat_completions"] as const
  readonly inboundHeaderAllowlist = LOKI_CONVERSATION_HEADERS
  readonly name: string
  private readonly baseUrl: string
  private models = new Map<string, unknown>()

  constructor(private readonly expected: StoredUpstreamRecord,
    private readonly load: () => Promise<StoredUpstreamRecord | null>,
    private readonly fetcher: Fetcher = directFetcher,
    private readonly executionFetcher?: ExecutionFetcherForRequest,
    private readonly options: LokiProviderOptions = {}) {
    this.name = expected.name
    if (expected.config.profileId !== LOKI_PROFILE_ID) throw new Error("loki_invalid_profile")
    this.baseUrl = lokiBaseUrl(expected.config.baseUrl)
  }

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
    const credential = state.syncSecretHash ? usableLokiCredential(state, this.now()) : undefined
    if (!credential) throw new Error("loki_credential_unavailable")
    return credential
  }

  async getModels(): Promise<ProviderModelsResponse> {
    const credential = await this.credential()
    // Workers rejects redirect: "error"; manual mode keeps the bearer on the configured origin.
    const response = await this.fetcher(`${this.baseUrl}/models`, { method: "GET", redirect: "manual",
      headers: { ...LOKI_HEADERS, authorization: `Bearer ${credential.accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(20_000) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`loki_catalog_http_${response.status}`) }
    const models = normalizeLokiModels(await response.json())
    this.setModelCatalog(models)
    return models
  }

  /**
   * Loki answers /models with part of its list while one of its backends is
   * unreachable, and publishing that dropped models from routing. A live
   * refresh therefore keeps a name it left out, stamped with when it first
   * went missing, for up to a day; a name still missing then is really gone.
   * A configuration change (previous is null) is published as given.
   */
  reconcileCatalog(previous: ProviderModelsResponse | null, next: ProviderModelsResponse, now = Date.now()): ProviderModelsResponse {
    // Legacy shim: a row that still stores a non-empty static list published that list, not a live
    // catalog, so what it lacks says nothing about Loki dropping models.
    const legacy = this.expected.config.staticModels
    if (!previous || (Array.isArray(legacy) && legacy.length)) return next
    const listed = new Set(next.data.map(model => model.id))
    const kept = []
    for (const entry of previous.data) {
      if (listed.has(entry.id)) continue
      const stamp = (entry as { _loki_missing_since?: unknown })._loki_missing_since
      const since = typeof stamp === "number" && Number.isFinite(stamp) && stamp <= now ? stamp : now
      if (now - since >= LOKI_MISSING_RETENTION_MS) continue
      const [model] = normalizeLokiModels({ data: [entry] }).data
      if (model) kept.push({ ...model, _loki_missing_since: since })
    }
    return kept.length ? { ...next, data: [...next.data, ...kept] } : next
  }

  setModelCatalog(models: ProviderModelsResponse): void {
    this.models = new Map(normalizeLokiModels(models).data.map(model => [model.id, model]))
  }

  probe() { return probeViaModels(() => this.getModels()) }
  getPricingForModelKey(model: string): ModelPricing | null { return lokiModelPricing(this.models.get(model)) }

  async fetch(req: ProviderRequest): Promise<ProviderResponse> {
    req.signal?.throwIfAborted()
    if (req.beforeInference) throw new Error("loki_opaque_replay_unavailable")
    if (!isLokiEndpoint(req.endpoint) || req.action === "compact" || !req.payload
      || typeof req.payload !== "object" || Array.isArray(req.payload) || req.payload instanceof FormData) throw new Error("loki_endpoint_unavailable")
    const payload = { ...req.payload } as Record<string, unknown>
    if (typeof payload.model !== "string" || !Object.hasOwn(lokiModelEndpoints(this.models.get(payload.model)), req.endpoint)) throw new Error("loki_endpoint_unavailable")
    if (req.endpoint === "messages") normalizeLokiMessages(payload)
    const anthropicBeta = req.endpoint === "messages" ? lokiMessagesBetaHeader(payload) : undefined
    const conversationId = await lokiConversationId(req, this.expected.id)
    const credential = await this.credential(true)
    req.signal?.throwIfAborted()
    const fetcher = resolveExecutionFetcher(this.fetcher, this.executionFetcher, req)
    const signals = [req.signal, req.timeout ? AbortSignal.timeout(req.timeout) : undefined].filter((signal): signal is AbortSignal => signal !== undefined)
    // Keep Anthropic's version independent of Loki's: 2026-10-21 rejects sampling
    // parameters that this gateway preserves. See docs/en/api/migration-2026-10-21 on platform.claude.com.
    const response = await fetcher(`${this.baseUrl}${LOKI_PATHS[req.endpoint]}`, {
      method: "POST", redirect: "manual", signal: signals.length ? AbortSignal.any(signals) : undefined,
      headers: { ...LOKI_HEADERS, authorization: `Bearer ${credential.accessToken}`, "content-type": "application/json",
        "X-ConversationId": conversationId,
        ...(req.endpoint === "messages" ? { "anthropic-version": "2023-06-01" } : {}),
        ...(anthropicBeta ? { "anthropic-beta": anthropicBeta } : {}) }, body: JSON.stringify(payload),
    })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Error("loki_redirect_disallowed")
    }
    if (response.status === 400 && req.endpoint === "messages") {
      console.warn("[loki.request_rejected]", JSON.stringify({
        incoming: lokiRequestShape(req.payload as Record<string, unknown>), outgoing: lokiRequestShape(payload),
      }))
    }
    const result = req.endpoint === "messages"
      ? await lokiMessagesRejection(response, payload, lokiContextWindow(this.models.get(payload.model)))
      : response
    return { status: result.status, headers: result.headers, body: result.body }
  }
}
```

- [ ] **Step 5: Plugin, index, package manifest, lockfile**

Replace `packages/provider-loki/src/plugin.ts`:

```ts
import type { LlmProviderPlugin } from "@vibe-llm/provider-llm"
import { getAuthoritativeUpstreamRepo, type StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { LokiProvider } from "./provider"

export const lokiProviderPlugin: LlmProviderPlugin = {
  kind: "loki",
  async createFromUpstream(upstream, ctx) {
    const fetcher = ctx.fetcherForUpstream?.(upstream.id)
    if (!("rowIncarnation" in upstream) || typeof upstream.rowIncarnation !== "string") throw new Error("loki_binding_unavailable")
    const execution = ctx.executionFetcherForUpstream
    return new LokiProvider(upstream as StoredUpstreamRecord, () => getAuthoritativeUpstreamRepo().getById(upstream.id), fetcher,
      execution ? request => execution(upstream.id, request) : undefined)
  },
}
```

In `packages/provider-loki/src/index.ts` delete the line `export * from "./mirror"`.

In `packages/provider-loki/package.json` delete the line `"@vibe-core/platform": "workspace:*",` from `dependencies` (after the plugin change nothing in the package imports it; verify `grep -rn "vibe-core/platform" packages/provider-loki/src` prints nothing).

In `bun.lock`, inside the `"packages/provider-loki"` workspace block, delete exactly one line. Use the Edit tool with this context so only that block changes:

```
      "name": "@vibe-llm/provider-loki",
      "version": "0.0.0",
      "dependencies": {
        "@vibe-core/platform": "workspace:*",
        "@vibe-core/upstream": "workspace:*",
```

becomes

```
      "name": "@vibe-llm/provider-loki",
      "version": "0.0.0",
      "dependencies": {
        "@vibe-core/upstream": "workspace:*",
```

Do not run `bun install`. Verify:

```bash
grep -c mirrors.cloud.tencent bun.lock
bun install --frozen-lockfile --dry-run
git diff --stat bun.lock
```

Expected: `0`; a dry run that exits 0 without wanting to change the lockfile; `bun.lock | 1 -`. If the dry run says the lockfile is out of date, stop and compare `git diff bun.lock` with the single deleted line before doing anything else.

- [ ] **Step 6: Delete the mirror source and its tests**

```bash
git rm packages/provider-loki/src/mirror.ts \
  packages/provider-loki/src/__tests__/mirror.test.ts \
  packages/provider-loki/src/__tests__/mirror-state.test.ts \
  packages/provider-loki/src/__tests__/provider-mirror.test.ts \
  packages/gateway/src/control-plane/loki/mirror.ts \
  packages/gateway/tests/control-plane-loki-mirror.sqlite.test.ts
```

- [ ] **Step 7: Gateway Loki routes, helpers, mounts, DTO**

Replace `packages/gateway/src/control-plane/loki/routes.ts`. Mirror issuance, the `mirror` create option, `PUT .../mirror-source`, the owner-strict helper and the mirror pair rules are gone; the inline session guard is unchanged (Task 4 moves it to a shared file).

```ts
import { Hono } from "hono"
import { z } from "zod"
import { LokiSyncError, LOKI_PROFILE_ID, lokiBaseUrl, type LokiState } from "@vibe-llm/provider-loki"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import type { FullAuthCtx } from "../../shared/credential-auth"
import type { SessionToken } from "../../repo/branded-ids"
import { loadOwned } from "../shared/ownership"
import { serializeUpstream } from "../upstreams/public-dto"
import { boundedJson, json, newBinding, safeError, upstreamId } from "./common"
export { lokiSyncRouter } from "./sync"

export const lokiManagementRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

const endpoint = z.string().max(2048)
// Dashboards from before static models were removed always send `staticModels: []`; accept and ignore it.
const legacyStaticModels = z.array(z.string()).max(0).optional()
const createBody = z.object({ name: z.string().trim().min(1).max(120), baseUrl: endpoint.optional(), staticModels: legacyStaticModels }).strict()
const settingsBody = z.object({ baseUrl: endpoint, staticModels: legacyStaticModels }).strict()
function parseEndpoint(value: unknown): string {
  try { return lokiBaseUrl(value) } catch { throw new LokiSyncError("invalid_endpoint", 400) }
}
const pairing = (origin: string, id: string, state: LokiState, syncSecret: string) => ({
  version: 1, gatewayOrigin: origin, upstreamId: id, profileId: LOKI_PROFILE_ID, generation: state.generation, syncSecret,
})

async function ownedLoki(auth: FullAuthCtx, rawId: string) {
  const parsedId = upstreamId.safeParse(rawId)
  if (!parsedId.success) throw new LokiSyncError("upstream_not_found", 404)
  const row = await loadOwned(auth, () => getRepo().upstreams.getById(parsedId.data))
  if (!row || row.provider !== "loki") throw new LokiSyncError("upstream_not_found", 404)
  return { row, id: parsedId.data }
}
lokiManagementRouter.use("*", async (c, next) => {
  const auth = c.get("auth")
  if (auth?.authKind !== "session" || !auth.userId || auth.apiKeyId) return json({ error: { code: "session_required" } }, 401)
  const url = new URL(c.req.url)
  const headers = c.req.raw.headers
  const authorization = headers.get("authorization")
  const token = authorization !== null ? /^Bearer (ses_[^\s]+)$/i.exec(authorization)?.[1]
    : /(?:^|;\s*)session_token=(ses_[^\s;]+)/.exec(headers.get("cookie") ?? "")?.[1]
  if (!token || token.length > 4096 || url.search || headers.has("x-api-key") || headers.has("x-goog-api-key")) {
    return json({ error: { code: "session_required" } }, 401)
  }
  const origin = headers.get("origin")
  if ((origin !== null && origin !== url.origin) || (authorization === null && origin === null)) {
    return json({ error: { code: "origin_not_allowed" } }, 403)
  }
  // Legacy user keys share authKind=session; require an actual, current session record.
  const session = await getRepo().sessions.findByToken(token as SessionToken)
  if (!session || session.userId !== auth.userId || !(Date.parse(session.expiresAt) > Date.now())) {
    return json({ error: { code: "session_required" } }, 401)
  }
  await next()
})

lokiManagementRouter.post("/upstreams", async c => {
  try {
    const parsed = createBody.safeParse(await boundedJson(c.req.raw))
    if (!parsed.success) throw new LokiSyncError("invalid_request", 400)
    const baseUrl = parseEndpoint(parsed.data.baseUrl)
    const auth = c.get("auth")
    const { state, syncSecret } = await newBinding()
    const now = new Date().toISOString()
    const id = upstreamId.parse(`up_loki_${crypto.randomUUID().replaceAll("-", "")}`)
    const saved = await getRepo().upstreams.createIfAbsent({
      id, ownerId: auth.userId, provider: "loki", name: parsed.data.name, enabled: true, sortOrder: 0,
      config: { profileId: LOKI_PROFILE_ID, ...(parsed.data.baseUrl === undefined ? {} : { baseUrl }) },
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
      state, createdAt: now, updatedAt: now,
    })
    if (!saved) throw new LokiSyncError("temporarily_unavailable", 503)
    return json({ upstream: serializeUpstream(saved), pairing: pairing(new URL(c.req.url).origin, id, state, syncSecret) }, 201)
  } catch (error) { return safeError(error) }
})

lokiManagementRouter.patch("/upstreams/:id", async c => {
  try {
    const { row } = await ownedLoki(c.get("auth"), c.req.param("id"))
    const repo = getRepo()
    const parsed = settingsBody.safeParse(await boundedJson(c.req.raw))
    if (!parsed.success) throw new LokiSyncError("invalid_request", 400)
    const baseUrl = parseEndpoint(parsed.data.baseUrl)
    // Metadata CAS preserves concurrent token renewal and advances the catalog generation.
    const saved = await repo.upstreams.patchMetadata(row, current => {
      // A legacy staticModels field is dropped on the next write.
      const { staticModels: _legacy, ...config } = current.config
      return { ...current, config: { ...config, baseUrl } }
    })
    return json({ upstream: serializeUpstream(saved) })
  } catch (error) { return safeError(error) }
})

for (const method of ["POST", "DELETE"] as const) lokiManagementRouter.on(method, "/upstreams/:id/pair", async c => {
  try {
    const { row } = await ownedLoki(c.get("auth"), c.req.param("id"))
    const repo = getRepo()
    const { state, syncSecret } = await newBinding()
    if (method === "DELETE") state.syncSecretHash = ""
    const saved = await repo.upstreams.replaceCredentials(row, { config: row.config, state })
    return json({ upstream: serializeUpstream(saved), ...(method === "POST"
      ? { pairing: pairing(new URL(c.req.url).origin, row.id, state, syncSecret) } : {}) })
  } catch (error) { return safeError(error) }
})
```

In `packages/gateway/src/control-plane/loki/common.ts` make two edits.

Line 2, replace
`import { LokiSyncError, LOKI_PROFILE_ID, type LokiMirror, type LokiState, publicLokiStatus } from "@vibe-llm/provider-loki"`
with
`import { LokiSyncError, LOKI_PROFILE_ID, type LokiState, publicLokiStatus } from "@vibe-llm/provider-loki"`

Delete these lines (keep `randomHex`, which `newBinding` uses):

```ts
export async function newMirror(label: string, now: number): Promise<{ mirror: LokiMirror; mirrorSecret: string }> {
  const mirrorSecret = `lkm_${randomHex(32)}`
  return { mirrorSecret, mirror: { id: `lkmid_${randomHex(16)}`, label, secretHash: await digest(mirrorSecret), createdAt: now } }
}
export const publicMirror = (mirror: LokiMirror) =>
  ({ id: mirror.id, label: mirror.label, createdAt: mirror.createdAt, lastPulledAt: mirror.lastPulledAt ?? null })
```

In `packages/gateway/src/app.ts` delete `import { lokiMirrorRouter } from './control-plane/loki/mirror.ts'` and `app.route('/api/loki', lokiMirrorRouter)`.

In `packages/gateway/src/control-plane/upstreams/public-dto.ts` delete the type member `    lokiSource?: { kind: "mirror"; origin: string }` and, in `serializeUpstream`, the line `      if (state.source) dto.lokiSource = { kind: "mirror", origin: state.source.origin }`.

- [ ] **Step 8: Run backend tests and typecheck**

```bash
bun test packages/provider-loki
bun test ./packages/gateway/tests/control-plane-loki.sqlite.test.ts ./packages/gateway/tests/loki-inference.sqlite.test.ts ./packages/gateway/tests/loki-context-rejection.sqlite.test.ts ./packages/gateway/tests/provider-factory-contract.sqlite.test.ts ./packages/gateway/tests/control-plane-data-transfer.test.ts
bun run --filter '@vibe-llm/provider-loki' typecheck
bun run --filter '@vibe-llm/gateway' typecheck
grep -rn -i "mirror" packages/provider-loki/src packages/gateway/src/control-plane/loki packages/gateway/src/control-plane/upstreams --exclude-dir=__tests__
```

Expected: tests PASS (including the two new ones), typechecks clean, and `grep` prints nothing.

- [ ] **Step 9: Commit the backend removal**

Run `git status --short` and confirm only the files named in Steps 3-8 are changed or staged (the untracked `docs/loki-safety-check-2026-11-14.md` stays untracked).

```bash
git add packages/provider-loki/src/state.ts packages/provider-loki/src/provider.ts packages/provider-loki/src/plugin.ts \
  packages/provider-loki/src/index.ts packages/provider-loki/package.json bun.lock \
  packages/provider-loki/src/__tests__/state.test.ts \
  packages/gateway/src/control-plane/loki/routes.ts packages/gateway/src/control-plane/loki/common.ts \
  packages/gateway/src/app.ts packages/gateway/src/control-plane/upstreams/public-dto.ts \
  packages/gateway/tests/control-plane-loki.sqlite.test.ts
git commit -F - <<'EOF'
refactor(vnext/loki): remove the device mirror backend

The generic gateway upstream sync replaces it. Stored Loki state with the
old mirror fields still reads and drops them.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

- [ ] **Step 10: Dashboard removal**

```bash
git rm apps/dashboard/src/tabs/upstreams/LokiMirrorsSection.tsx apps/dashboard/src/tabs/upstreams/loki-mirror.ts \
  apps/dashboard/src/tabs/upstreams/loki-mirror.test.ts apps/dashboard/src/tabs/upstreams/loki-status.ts
```

Replace `apps/dashboard/src/tabs/upstreams/loki-errors.ts`:

```ts
import { ApiError } from "../../api/client"

/** The server's `error.code` from a failed API call, if any. */
export function settingsError(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object" || !("error" in error.body)) return undefined
  const detail = error.body.error
  return detail && typeof detail === "object" && "code" in detail && typeof detail.code === "string" ? detail.code : undefined
}
```

Replace `apps/dashboard/src/tabs/upstreams/loki-errors.test.ts`:

```ts
import { expect, test } from "bun:test"
import { ApiError } from "../../api/client"
import { settingsError } from "./loki-errors"

test("settingsError reads the server error code", () => {
  expect(settingsError(new ApiError(409, { error: { code: "revision_conflict" } }, "x"))).toBe("revision_conflict")
  expect(settingsError(new ApiError(500, { error: "text" }, "x"))).toBeUndefined()
  expect(settingsError(new Error("x"))).toBeUndefined()
})
```

Replace `apps/dashboard/src/tabs/upstreams/LokiPairingPanel.tsx` (the source choice, the mirror section and `LokiMirrorsSection` are gone):

```tsx
import { useId, useState } from "react"
import { api } from "../../api/client"
import type { UpstreamRecord } from "../../api/types"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Notice } from "../../ui/notice"
import { Field, FormHeading } from "./form/Field"
import { settingsError } from "./loki-errors"
import { formatLokiPairing } from "./loki-pairing"

interface Props { row?: UpstreamRecord; onChanged: () => void; onClose: () => void }
const DEFAULT_ENDPOINT = "https://loki.delve.office.com/api/v1/llmapi"

export function LokiPairingPanel({ row, onChanged, onClose }: Props) {
  const t = useT()
  const [name, setName] = useState(row?.name ?? "Microsoft Entra (Loki)")
  const [baseUrl, setBaseUrl] = useState(typeof row?.config.baseUrl === "string" ? row.config.baseUrl : DEFAULT_ENDPOINT)
  const [savedBaseUrl, setSavedBaseUrl] = useState(baseUrl)
  const [saved, setSaved] = useState(false)
  const titleId = useId()
  const [id, setId] = useState(row?.id)
  const [document, setDocument] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const secureOrigin = window.location.protocol === "https:"
  const errorMessage = (error: unknown, pairing = false) => t(settingsError(error) === "invalid_endpoint"
    ? "dash.lokiEndpointInvalid" : pairing ? "dash.lokiPairError" : "dash.lokiSettingsError")

  const save = async () => {
    if (!id) return
    setBusy(true); setError(""); setSaved(false)
    try {
      const result = await api<{ upstream: UpstreamRecord }>(`/api/loki/upstreams/${encodeURIComponent(id)}`,
        { method: "PATCH", body: { baseUrl: baseUrl.trim() } })
      const next = typeof result.upstream.config.baseUrl === "string" ? result.upstream.config.baseUrl : DEFAULT_ENDPOINT
      setBaseUrl(next); setSavedBaseUrl(next); setSaved(true)
      onChanged()
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy(false) }
  }

  const pair = async () => {
    setBusy(true); setError(""); setCopied(false); setDocument(""); setSaved(false)
    try {
      const result = await api<{ upstream: UpstreamRecord; pairing: unknown }>(id
        ? `/api/loki/upstreams/${encodeURIComponent(id)}/pair` : "/api/loki/upstreams",
      { method: "POST", body: id ? {} : { name, baseUrl: baseUrl.trim() } })
      if (!id) {
        const next = typeof result.upstream.config.baseUrl === "string" ? result.upstream.config.baseUrl : DEFAULT_ENDPOINT
        setBaseUrl(next); setSavedBaseUrl(next)
      }
      setId(result.upstream.id)
      setDocument(formatLokiPairing(result.pairing, window.location.origin))
      onChanged()
    } catch (error) { setError(errorMessage(error, true)) }
    finally { setBusy(false) }
  }
  const revoke = async () => {
    if (!id) return
    setBusy(true); setError("")
    try {
      await api(`/api/loki/upstreams/${encodeURIComponent(id)}/pair`, { method: "DELETE" })
      setDocument(""); setCopied(false); onChanged()
    } catch { setError(t("dash.lokiPairError")) }
    finally { setBusy(false) }
  }

  return <section className="space-y-3 rounded-lg border border-border bg-panel p-4" aria-labelledby={titleId}>
    <div className="flex items-center justify-between gap-3">
      <FormHeading id={titleId} className="text-body font-medium text-fg">{t("dash.lokiSettingsTitle")}</FormHeading>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>{t("dash.closeBtn")}</Button>
    </div>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); void (id ? save() : pair()) }}>
      {!id && !secureOrigin ? <Notice tone="warn" role="status">{t("dash.lokiHttpsRequired")}</Notice> : null}
      {!id ? <Field label={t("dash.lokiName")}>
        {({ id: inputId }) => (
          <input id={inputId} type="text" value={name} maxLength={120} required onChange={event => setName(event.target.value)} disabled={busy} />
        )}
      </Field> : null}
      <Field label={t("dash.endpointLabel")} hint={t("dash.lokiEndpointHint")}>
        {({ id: inputId, describedBy }) => (
          <div className="font-mono">
            <input id={inputId} type="url" value={baseUrl} placeholder={DEFAULT_ENDPOINT}
              maxLength={2048} autoComplete="off" spellCheck={false} aria-describedby={describedBy}
              onChange={event => { setBaseUrl(event.target.value); setSaved(false); setError("") }} disabled={busy} />
          </div>
        )}
      </Field>
      <Button type="submit" variant="primary" size="sm"
        disabled={busy || (id ? baseUrl === savedBaseUrl : !name.trim() || !secureOrigin)}>
        {busy ? t("dash.savingShort") : t(id ? "dash.save" : "dash.addLoki")}
      </Button>
      {saved ? <p role="status" className="text-xs text-fg-subtle">{t("dash.lokiSettingsSaved")}</p> : null}
    </form>
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
    {error ? <Notice tone="danger">{error}</Notice> : null}
    {document ? <div className="space-y-2">
      <p className="text-xs text-fg-subtle">{t("dash.lokiPairSecretHint")}</p>
      <textarea readOnly spellCheck={false} aria-label={t("dash.lokiPairDocument")} value={document}
        className="w-full bg-muted font-mono text-xs" rows={9} onFocus={event => event.target.select()} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => {
          const url = URL.createObjectURL(new Blob([document], { type: "application/json" }))
          const link = window.document.createElement("a")
          link.href = url
          link.download = "loki-pairing.json"
          window.document.body.appendChild(link)
          link.click()
          link.remove()
          window.setTimeout(() => URL.revokeObjectURL(url), 1000)
        }}>{t("dash.lokiDownload")}</Button>
        <Button variant="secondary" size="sm" onClick={async () => {
          try { await navigator.clipboard.writeText(document); setCopied(true) }
          catch { setError(t("dash.lokiCopyError")) }
        }}>{t(copied ? "dash.lokiCopied" : "dash.lokiCopy")}</Button>
      </div>
    </div> : null}
  </section>
}
```

In `apps/dashboard/src/api/types.ts` delete the line `    errorCode?: string` (inside `lokiStatus`) and the line `  lokiSource?: { kind: "mirror"; origin: string }`.

In `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx` make three edits.

1. Delete the import line `import { lokiRowStatusKey } from "./loki-status"`.
2. Replace the `lokiTone` expression

```tsx
  const lokiTone: HealthTone | null = u.provider === "loki" && u.lokiStatus
    ? u.lokiStatus.tokenStatus === "expired" || u.lokiStatus.errorCode === "mirror_revoked"
      || u.lokiStatus.errorCode === "account_mismatch" ? "danger" : LOKI_TONE[u.lokiStatus.assistantStatus]
    : null
```

with

```tsx
  const lokiTone: HealthTone | null = u.provider === "loki" && u.lokiStatus
    ? u.lokiStatus.tokenStatus === "expired" ? "danger" : LOKI_TONE[u.lokiStatus.assistantStatus]
    : null
```

3. Replace `{t(lokiRowStatusKey(u.lokiStatus, u.lokiSource))}` with

```tsx
                {t(u.lokiStatus.tokenStatus === "expired" ? "dash.lokiExpired" : {
                  waiting: "dash.lokiWaiting", authorized: "dash.lokiAuthorized",
                  interaction_required: "dash.lokiInteractionRequired", failed: "dash.lokiFailed",
                }[u.lokiStatus.assistantStatus])}
```

- [ ] **Step 11: Remove the i18n keys and run the dashboard checks**

```bash
sed -i '' -E '/^[[:space:]]+"dash\.loki(Source|SourcePairing|SourceMirror|Mirror[A-Za-z]*)":/d' packages/gateway/src/shared/edge/ui-pages/i18n.ts
grep -c 'dash.lokiMirror\|dash.lokiSource' packages/gateway/src/shared/edge/ui-pages/i18n.ts
bun test apps/dashboard ./packages/gateway/tests/i18n-keys.test.ts ./packages/gateway/tests/i18n-interpolation.test.ts
bun run --filter '@vibe-llm/dashboard' typecheck
```

Expected: `grep -c` prints `0`; tests PASS; typecheck clean. (`-i ''` is the macOS form; on GNU sed use `-i`.)

- [ ] **Step 12: Remove the "Device mirror" section from the Loki docs**

```bash
python3 -I - <<'PY'
p = "docs/loki-sync-v1.md"
s = open(p).read()
i = s.index("\n## Device mirror\n")
open(p, "w").write(s[:i].rstrip("\n") + "\n")
PY
grep -n -i mirror docs/loki-sync-v1.md
```

Expected: `grep` prints nothing.

- [ ] **Step 13: Commit the dashboard and docs removal**

```bash
git add apps/dashboard/src/tabs/upstreams/LokiPairingPanel.tsx apps/dashboard/src/tabs/upstreams/loki-errors.ts \
  apps/dashboard/src/tabs/upstreams/loki-errors.test.ts apps/dashboard/src/tabs/upstreams/loki-settings.test.tsx \
  apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx apps/dashboard/src/api/types.ts \
  packages/gateway/src/shared/edge/ui-pages/i18n.ts docs/loki-sync-v1.md
git commit -F - <<'EOF'
refactor(vnext/dashboard): remove the Loki device mirror UI, copy and docs

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 2: Provider contract (`syncable`, `syncView`, `credentialsReadOnly`) and opt-in

**Files:**
- Modify: `packages/provider-llm/src/plugin.ts` (lines 35-71)
- Modify: `packages/provider-copilot/src/plugin.ts` (line 26)
- Modify: `packages/provider-loki/src/state.ts` (`readLokiState`, end of file), `provider.ts` (options, `credential`), `plugin.ts`
- Modify: `packages/gateway/src/data-plane/providers/registry.ts` (after line 92; `createProviderFromUpstream`, lines 94-111)
- Test: `packages/provider-loki/src/__tests__/synced.test.ts` (create), `packages/gateway/tests/sync-provider-contract.sqlite.test.ts` (create)

Copilot never writes stored credentials: `packages/provider-copilot/src` contains no `saveState`, `replaceCredentials`, `patchMetadata` or repository access at all. It exchanges `config.githubToken` for a session through `ctx.getCachedCopilotToken` (an in-memory cache in `packages/gateway/src/shared/copilot-token-cache.ts`). The only code that writes `state.copilotApiEndpoint` is the control-plane device-flow path (`control-plane/lib/github.ts` lines 79-82), which Task 10 blocks for synced rows. So Copilot needs only `syncable: true`.

- [ ] **Step 1: Write the failing tests**

Create `packages/provider-loki/src/__tests__/synced.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { lokiProviderPlugin } from "../plugin"
import { LokiProvider } from "../provider"
import { lokiSyncState, readLokiState, type LokiState } from "../state"

const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const central = (overrides: Partial<LokiState> = {}): LokiState => ({
  version: 1, profileId: "loki-df-v1", generation: "g", syncSecretHash: "secret-hash", revision: 3, assistantStatus: "authorized",
  account, credential: { accessToken: "central-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, account },
  lastReceipt: { requestId: "request-one", payloadHash: "payload-hash" }, ...overrides,
})
const row = (state: unknown): StoredUpstreamRecord => ({
  id: "up_loki", rowIncarnation: "incarnation", ownerId: "owner", provider: "loki", name: "Loki", enabled: true, sortOrder: 0,
  config: { profileId: "loki-df-v1" }, state, catalogGeneration: 0, credentialGeneration: 0, flagOverrides: {},
  disabledPublicModelIds: [], proxyFallbackList: [], createdAt: "", updatedAt: "",
})
const catalog = { data: [{ id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"] }] }

test("Loki is syncable and its sync view withholds the pairing authority", () => {
  expect(lokiProviderPlugin.syncable).toBe(true)
  const legacy = { ...central(), mirrors: [{ id: "lkmid_x", label: "old", secretHash: "hash-of-mirror", createdAt: 1 }] }
  const view = lokiProviderPlugin.syncView!(row(legacy))
  expect(view.config).toEqual({ profileId: "loki-df-v1" })
  const text = JSON.stringify(view.state)
  for (const secret of ["secret-hash", "payload-hash", "lastReceipt", "syncSecretHash", "mirror"]) expect(text).not.toContain(secret)
  expect(text).toContain("central-token")
  const onDevice = readLokiState(view.state)
  expect(onDevice.syncSecretHash).toBe("")
  expect(onDevice.credential?.accessToken).toBe("central-token")
  expect(lokiSyncState(central())).not.toHaveProperty("syncSecretHash")
})

test("a synced Loki upstream uses the stored credential without a pairing secret", async () => {
  const synced = row(lokiSyncState(central()))
  const bearers: string[] = []
  const provider = new LokiProvider(synced, async () => synced, async (_url, init) => {
    bearers.push(new Headers(init.headers).get("authorization") ?? "")
    return Response.json(catalog)
  }, undefined, { credentialsReadOnly: true })
  await provider.getModels()
  expect(bearers).toEqual(["Bearer central-token"])
})

test("without credentialsReadOnly a state lacking the pairing secret is still unusable", async () => {
  const unpaired = row(lokiSyncState(central()))
  const provider = new LokiProvider(unpaired, async () => unpaired, async () => Response.json(catalog))
  await expect(provider.getModels()).rejects.toThrow("loki_credential_unavailable")
})

test("a synced Loki upstream with an expired credential waits for the next sync", async () => {
  const expired = row(lokiSyncState(central({ credential: { accessToken: "old", tokenType: "Bearer", expiresAt: Date.now() - 1, account } })))
  let calls = 0
  const provider = new LokiProvider(expired, async () => expired, async () => { calls++; return Response.json(catalog) },
    undefined, { credentialsReadOnly: true })
  await expect(provider.getModels()).rejects.toThrow("loki_credential_unavailable")
  expect(calls).toBe(0)
})
```

Create `packages/gateway/tests/sync-provider-contract.sqlite.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import type { StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { setupTestPlatform } from "./_setup-platform"
import { realFetch, stubGlobalFetch } from "./_stub-global-fetch"
import { _clearModelsMemoForTest, createProviderFromUpstream, isSyncableProvider, providerPlugin } from "../src/data-plane/providers/registry"

afterEach(() => { globalThis.fetch = realFetch; _clearModelsMemoForTest(); __resetPlatformForTests() })

const stamp = "2026-11-16T00:00:00.000Z"
const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const base = { ownerId: "device-owner", enabled: true, sortOrder: 0, flagOverrides: {}, disabledPublicModelIds: [],
  proxyFallbackList: [], createdAt: stamp, updatedAt: stamp }
const urlOf = (input: URL | RequestInfo) => String(input instanceof Request ? input.url : input)

test("only copilot and loki declare syncable", () => {
  for (const kind of ["copilot", "loki"]) expect(isSyncableProvider(kind)).toBe(true)
  for (const kind of ["custom", "azure", "sdf", "codex", "claude-code", "unknown"]) expect(isSyncableProvider(kind)).toBe(false)
  expect(providerPlugin("copilot")?.kind).toBe("copilot")
  expect(providerPlugin("nope")).toBeUndefined()
})

test("a synced Copilot upstream lists models without writing stored credentials or state", async () => {
  const { repo } = setupTestPlatform()
  await repo.upstreams.save({ ...base, id: "up_copilot_synced", provider: "copilot", name: "Synced Copilot",
    config: { githubToken: "ghp_synced_readonly_fixture", accountType: "individual" }, state: null })
  const stored = (await repo.upstreams.getById("up_copilot_synced" as never))!
  const writes: string[] = []
  for (const name of ["saveState", "replaceCredentials", "patchMetadata", "save", "createIfAbsent", "delete", "deleteAll"] as const) {
    const original = (repo.upstreams[name] as (...args: unknown[]) => Promise<unknown>).bind(repo.upstreams)
    ;(repo.upstreams as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { writes.push(name); return original(...args) }
  }
  stubGlobalFetch(async input => {
    const url = urlOf(input)
    if (url.endsWith("/copilot_internal/v2/token")) {
      return Response.json({ token: "session-token", expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1500,
        endpoints: { api: "https://api.githubcopilot.com" } })
    }
    if (url.endsWith("/models")) {
      return Response.json({ object: "list", data: [{ id: "gpt-4o", object: "model", name: "gpt-4o", vendor: "openai", version: "gpt-4o",
        model_picker_enabled: true, preview: false, capabilities: { family: "gpt-4o", limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 }, object: "model_capabilities",
          supports: {}, tokenizer: "o200k_base", type: "chat" } }] })
    }
    throw new Error(`unexpected egress ${url}`)
  })
  const plugin = providerPlugin("copilot")!
  const seen: unknown[] = []
  const original = plugin.createFromUpstream.bind(plugin)
  plugin.createFromUpstream = (upstream, ctx) => { seen.push(ctx.credentialsReadOnly); return original(upstream, ctx) }
  try {
    const synced = { ...stored, syncSourceId: "ssrc_fixture" } as StoredUpstreamRecord
    const provider = await createProviderFromUpstream(synced)
    expect((await provider!.getModels()).data.map(model => model.id)).toEqual(["gpt-4o"])
    await createProviderFromUpstream(stored)
    expect(seen).toEqual([true, false])
    expect(writes).toEqual([])
  } finally { plugin.createFromUpstream = original }
})

test("a synced Loki upstream serves from the synced credential and a plain one without a pairing secret does not", async () => {
  const { repo } = setupTestPlatform()
  const state = { version: 1, profileId: "loki-df-v1", generation: "g", revision: 1, assistantStatus: "authorized", account,
    credential: { accessToken: "central-token", tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, account } }
  await repo.upstreams.save({ ...base, id: "up_loki_synced", provider: "loki", name: "Synced Loki",
    config: { profileId: "loki-df-v1" }, state })
  const stored = (await repo.upstreams.getById("up_loki_synced" as never))!
  const bearers: string[] = []
  stubGlobalFetch(async (input, init) => {
    bearers.push(new Headers(init?.headers).get("authorization") ?? "")
    expect(urlOf(input)).toBe("https://loki.delve.office.com/api/v1/llmapi/models")
    return Response.json({ data: [{ id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"] }] })
  })
  const synced = await createProviderFromUpstream({ ...stored, syncSourceId: "ssrc_fixture" } as StoredUpstreamRecord)
  expect((await synced!.getModels()).data.map(model => model.id)).toEqual(["claude-opus-5.5"])
  expect(bearers).toEqual(["Bearer central-token"])
  const plain = await createProviderFromUpstream(stored)
  await expect(plain!.getModels()).rejects.toThrow("loki_credential_unavailable")
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test packages/provider-loki/src/__tests__/synced.test.ts ./packages/gateway/tests/sync-provider-contract.sqlite.test.ts`

Expected: FAIL: `lokiSyncState` is not exported, `lokiProviderPlugin.syncable` is undefined, `isSyncableProvider`/`providerPlugin` are not exported from the registry.

- [ ] **Step 3: Extend the plugin contract**

In `packages/provider-llm/src/plugin.ts`, add this member to `ProviderPluginContext` (after `executionFetcherForUpstream`, before the closing brace at line 66):

```ts
  /** Set for an upstream synced from another gateway. The provider must never rewrite its stored
   *  credentials. Deriving a short-lived token from them (Copilot's GitHub-token exchange) is allowed. */
  credentialsReadOnly?: boolean
```

Replace the `LlmProviderPlugin` interface (lines 68-71) with:

```ts
/** What may leave the central gateway for one synced upstream. */
export interface SyncView {
  config: Record<string, unknown>
  state: unknown
}

export interface LlmProviderPlugin
  extends UpstreamPlugin<UpstreamRecord<unknown>, ProviderPluginContext, LlmModelProvider> {
  readonly kind: UpstreamKind
  /** The provider may be selected for gateway sync. Declare it only if the provider never rewrites its
   *  stored credentials when created with `credentialsReadOnly: true`. */
  readonly syncable?: true
  /** What may leave the central gateway. Absent means config and state unchanged. */
  syncView?(record: UpstreamRecord<unknown>): SyncView
}
```

In `packages/provider-copilot/src/plugin.ts` change `kind: 'copilot',` to:

```ts
  kind: 'copilot',
  // The GitHub token in `config` is exactly what a synced device needs. The provider never rewrites it: it
  // exchanges it for a session token cached in memory (see ctx.getCachedCopilotToken).
  syncable: true,
```

- [ ] **Step 4: Loki state, provider and plugin**

In `packages/provider-loki/src/state.ts`, in `readLokiState`, replace the line

```ts
    || typeof source.syncSecretHash !== "string") return invalid()
```

with

```ts
    || (source.syncSecretHash !== undefined && typeof source.syncSecretHash !== "string")) return invalid()
```

and replace `syncSecretHash: source.syncSecretHash, revision: integer(source.revision),` with

```ts
    syncSecretHash: typeof source.syncSecretHash === "string" ? source.syncSecretHash : "", revision: integer(source.revision),
```

Append to the end of `state.ts`:

```ts

/** State that may leave the central gateway: the pairing authority and the upload receipt stay behind. */
export function lokiSyncState(state: LokiState): Omit<LokiState, "syncSecretHash" | "lastReceipt"> {
  const { syncSecretHash: _hash, lastReceipt: _receipt, ...rest } = state
  return rest
}
```

In `packages/provider-loki/src/provider.ts` replace the options interface

```ts
export interface LokiProviderOptions {
  now?: () => number
}
```

with

```ts
export interface LokiProviderOptions {
  now?: () => number
  /** A synced upstream: the stored credential is used without requiring the central pairing secret. */
  credentialsReadOnly?: boolean
}
```

and replace the `credential` method body

```ts
    const credential = state.syncSecretHash ? usableLokiCredential(state, this.now()) : undefined
```

with

```ts
    const credential = state.syncSecretHash || this.options.credentialsReadOnly ? usableLokiCredential(state, this.now()) : undefined
```

Replace `packages/provider-loki/src/plugin.ts`:

```ts
import type { LlmProviderPlugin } from "@vibe-llm/provider-llm"
import { getAuthoritativeUpstreamRepo, type StoredUpstreamRecord } from "@vibe-core/upstream-repo"
import { LokiProvider } from "./provider"
import { lokiSyncState, readLokiState } from "./state"

export const lokiProviderPlugin: LlmProviderPlugin = {
  kind: "loki",
  syncable: true,
  /** The Windows assistant's pairing authority stays on the central gateway. Invalid state throws, and the
   *  snapshot omits the upstream. */
  syncView: record => ({ config: record.config, state: lokiSyncState(readLokiState(record.state)) }),
  async createFromUpstream(upstream, ctx) {
    const fetcher = ctx.fetcherForUpstream?.(upstream.id)
    if (!("rowIncarnation" in upstream) || typeof upstream.rowIncarnation !== "string") throw new Error("loki_binding_unavailable")
    const execution = ctx.executionFetcherForUpstream
    return new LokiProvider(upstream as StoredUpstreamRecord, () => getAuthoritativeUpstreamRepo().getById(upstream.id), fetcher,
      execution ? request => execution(upstream.id, request) : undefined,
      { credentialsReadOnly: ctx.credentialsReadOnly === true })
  },
}
```

- [ ] **Step 5: Registry helpers and the read-only flag**

In `packages/gateway/src/data-plane/providers/registry.ts`, after line 92 (`const PROVIDER_PLUGINS: ReadonlyMap<string, LlmProviderPlugin> = ...`) add:

```ts
export function providerPlugin(kind: string): LlmProviderPlugin | undefined {
  return PROVIDER_PLUGINS.get(kind)
}

/** True when the provider declared that it may be mirrored to another gateway. */
export function isSyncableProvider(kind: string): boolean {
  return PROVIDER_PLUGINS.get(kind)?.syncable === true
}

/** A row that a sync source created on this gateway; its providers must not rewrite stored credentials. */
function isSyncedUpstream(upstream: UpstreamRecord<unknown>): boolean {
  const source = (upstream as { syncSourceId?: unknown }).syncSourceId
  return typeof source === "string" && source.length > 0
}
```

In `createProviderFromUpstream`, add one property to the object passed to `plugin.createFromUpstream` (next to `deferCredentials: true,`):

```ts
    credentialsReadOnly: isSyncedUpstream(upstream),
```

- [ ] **Step 6: Run tests and typechecks**

```bash
bun test packages/provider-loki ./packages/gateway/tests/sync-provider-contract.sqlite.test.ts ./packages/gateway/tests/providers-registry.test.ts ./packages/gateway/tests/provider-factory-contract.sqlite.test.ts ./packages/gateway/tests/loki-inference.sqlite.test.ts
bun run --filter '@vibe-llm/provider-llm' typecheck
bun run --filter '@vibe-llm/provider-loki' typecheck
bun run --filter '@vibe-llm/provider-copilot' typecheck
bun run --filter '@vibe-llm/gateway' typecheck
```

Expected: PASS and clean typechecks.

- [ ] **Step 7: Commit**

```bash
git add packages/provider-llm/src/plugin.ts packages/provider-copilot/src/plugin.ts \
  packages/provider-loki/src/state.ts packages/provider-loki/src/provider.ts packages/provider-loki/src/plugin.ts \
  packages/provider-loki/src/__tests__/synced.test.ts packages/gateway/src/data-plane/providers/registry.ts \
  packages/gateway/tests/sync-provider-contract.sqlite.test.ts
git commit -F - <<'EOF'
feat(vnext/providers): declare syncable providers and read-only credentials

Copilot and Loki opt in. Loki's sync view drops the pairing authority and a
synced Loki upstream serves from its stored credential.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 3: Migration and repositories (`sync_devices`, `sync_sources`, `upstreams.sync_source_id`)

Migrations are one corpus applied by `applyMigrations` on Bun (`apps/platform-bun/src/migrate.ts`, transaction per file, recorded in `_migrations`) and by `wrangler d1 migrations apply` on D1 (`migrations_dir` in `apps/platform-cloudflare/wrangler.jsonc`). The next free number is `0025`. `packages/gateway/tests/migrations.test.ts` replays the corpus and compares `sqlite_master` with `tests/schema-baseline.txt`; the baseline is regenerated with `UPDATE_SCHEMA_BASELINE=1`.

**Catalog generation (decision D1 above):** `upstreams_catalog_generation` (`0018_catalog_coordination.sql` lines 30-40) bumps `catalog_generation` when `id`, `row_incarnation`, `owner_id`, `provider`, `config_json`, `enabled` or `proxy_fallback_list_json` change, and `configuration_upstreams_update` (`0010_configuration_revision.sql` line 34) bumps the configuration revision on a list of columns. `sync_source_id` is in neither list and is only written by `INSERT`. The migration therefore needs no trigger change, and a test pins that setting the column advances nothing.

**Files:**
- Create: `packages/gateway/migrations/0025_gateway_upstream_sync.sql`
- Modify: `packages/gateway/tests/schema-baseline.txt` (regenerated), `packages/gateway/tests/migrations.test.ts` (add one test before the `replaying the corpus reproduces the checked-in schema` test)
- Create: `packages/gateway/src/repo/sync.ts`, `packages/gateway/src/repo/shared/sync.ts`
- Modify: `packages/gateway/src/repo/types.ts` (imports; lines 222-244; `Repo` at 593-619), `packages/gateway/src/repo/index.ts` (line 11-14), `packages/gateway/src/repo/shared/repos.ts` (lines 8-9, 68, 217-236, 577-596, 637-652, above line 722, 1365-1390), `packages/gateway/src/repo/configuration-cache.ts` (lines 297-301)
- Modify: `apps/platform-bun/src/bun-sqlite-repo.ts`, `apps/platform-cloudflare/src/d1-repo.ts`
- Modify: `packages/gateway/src/control-plane/auth/routes.ts` (line 265), `packages/gateway/tests/control-plane-auth.test.ts` (line 112)
- Test: `packages/gateway/tests/sync-repo.sqlite.test.ts`, `packages/gateway/tests/sync-repo.d1.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Add this test inside `describe("migration corpus", ...)` in `packages/gateway/tests/migrations.test.ts`, directly above the `// Guards against the failure this corpus already suffered once` comment:

```ts
  test("gateway sync upgrade leaves upstreams unsynced and the new column never advances a generation or revision", () => {
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)")
      for (const file of listSql().sort().filter(file => file < "0025_")) {
        db.exec(readFileSync(`${dir}/${file}`, "utf8"))
        db.run("INSERT INTO _migrations (name) VALUES (?)", [file])
      }
      db.run("INSERT INTO upstreams (id, owner_id, provider, name, created_at, updated_at) VALUES ('u1', 'o', 'copilot', 'c', 'now', 'now')")
      applyMigrations(db, dir)
      applyMigrations(db, dir)
      const row = () => db.query("SELECT sync_source_id, catalog_generation, credential_generation FROM upstreams").get()
      const revision = () => db.query<{ revision: number }, []>("SELECT revision FROM configuration_revision WHERE id=1").get()?.revision ?? -1
      expect(row()).toEqual({ sync_source_id: null, catalog_generation: 0, credential_generation: 0 })
      const before = revision()
      db.run("UPDATE upstreams SET sync_source_id = 'ssrc_x'")
      expect(row()).toEqual({ sync_source_id: "ssrc_x", catalog_generation: 0, credential_generation: 0 })
      expect(revision()).toBe(before)
      db.run("INSERT INTO sync_sources (id, owner_id, origin, device_id, secret) VALUES ('a', 'o', 'https://c.example', 'sdv_x', 'sds_x')")
      expect(() => db.run("INSERT INTO sync_sources (id, owner_id, origin, device_id, secret) VALUES ('b', 'o', 'https://c.example', 'sdv_x', 'sds_x')")).toThrow()
      expect(() => db.run("INSERT INTO sync_devices (id, owner_id, label, secret_hash, created_at) VALUES ('short', 'o', 'x', 'h', 'now')")).toThrow()
      expect(db.query("SELECT name FROM _migrations WHERE name = '0025_gateway_upstream_sync.sql'").all()).toHaveLength(1)
    } finally { db.close() }
  })
```

Create `packages/gateway/tests/sync-repo.sqlite.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { UserId } from "../src/repo/branded-ids"
import type { SyncDeviceRecord, SyncedUpstreamInput } from "../src/repo/sync"

let db: Database
let repo: BunSqliteRepo
beforeEach(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterEach(() => db.close())

const owner = "central-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const hex = (n: number, length: number) => n.toString(16).padStart(length, "0")
const device = (n: number, over: Partial<SyncDeviceRecord> = {}): SyncDeviceRecord => ({
  id: `sdv_${hex(n, 32)}`, ownerId: owner, label: `Device ${n}`, secretHash: hex(n, 64), upstreamIds: [],
  createdAt: `2026-11-16T00:00:${String(n).padStart(2, "0")}.000Z`, lastSyncAt: null, ...over,
})
const input = (over: Partial<SyncedUpstreamInput> = {}): SyncedUpstreamInput => ({
  id: "up_copilot_c1", ownerId: "device-owner", provider: "copilot", name: "Copilot", config: { githubToken: "ghp_a" },
  state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over,
})
const local = (id: string, sortOrder = 0) => ({ id, ownerId: "device-owner", provider: "custom" as const, name: id, enabled: true, sortOrder,
  config: {}, flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })

test("devices are created within the per-owner limit, unique by secret hash, and owner-scoped", async () => {
  for (let n = 1; n <= 3; n++) expect(await repo.syncDevices.createWithinLimit(device(n), 3)).toBe(true)
  expect(await repo.syncDevices.createWithinLimit(device(4), 3)).toBe(false)
  expect(await repo.syncDevices.createWithinLimit(device(4, { ownerId: "someone-else" as UserId }), 3)).toBe(true)
  await expect(repo.syncDevices.createWithinLimit(device(5, { secretHash: hex(1, 64), ownerId: "third" as UserId }), 3)).rejects.toThrow()
  expect((await repo.syncDevices.listByOwner(owner)).map(d => d.label)).toEqual(["Device 1", "Device 2", "Device 3"])
  expect((await repo.syncDevices.findBySecretHash(hex(2, 64)))?.id).toBe(device(2).id)
  expect(await repo.syncDevices.findBySecretHash(hex(9, 64))).toBeNull()
  expect((await repo.syncDevices.getById(device(3).id))?.ownerId).toBe(owner)
})

test("devices update only supplied fields, revoke only for their owner, and stamp last sync at most once per window", async () => {
  await repo.syncDevices.createWithinLimit(device(1, { upstreamIds: ["a", "b"] }), 16)
  const id = device(1).id
  expect((await repo.syncDevices.update(id, owner, { label: "Renamed" }))).toMatchObject({ label: "Renamed", upstreamIds: ["a", "b"] })
  expect((await repo.syncDevices.update(id, owner, { upstreamIds: ["c"] }))).toMatchObject({ label: "Renamed", upstreamIds: ["c"] })
  expect(await repo.syncDevices.update(id, "other" as UserId, { label: "Nope" })).toBeNull()
  expect((await repo.syncDevices.getById(id))?.secretHash).toBe(hex(1, 64))

  await repo.syncDevices.touchLastSync(id, "2026-11-16T10:00:00.000Z", "2026-11-16T09:50:00.000Z")
  expect((await repo.syncDevices.getById(id))?.lastSyncAt).toBe("2026-11-16T10:00:00.000Z")
  await repo.syncDevices.touchLastSync(id, "2026-11-16T10:05:00.000Z", "2026-11-16T09:55:00.000Z")
  expect((await repo.syncDevices.getById(id))?.lastSyncAt).toBe("2026-11-16T10:00:00.000Z")
  await repo.syncDevices.touchLastSync(id, "2026-11-16T10:11:00.000Z", "2026-11-16T10:01:00.000Z")
  expect((await repo.syncDevices.getById(id))?.lastSyncAt).toBe("2026-11-16T10:11:00.000Z")

  expect(await repo.syncDevices.delete(id, "other" as UserId)).toBe(false)
  expect(await repo.syncDevices.delete(id, owner)).toBe(true)
  await repo.syncDevices.createWithinLimit(device(2), 16)
  await repo.syncDevices.deleteByOwner(owner)
  expect(await repo.syncDevices.listByOwner(owner)).toEqual([])
})

test("a gateway holds at most one sync source; results are fenced by the secret and the etag keeps, sets or clears", async () => {
  const source = { id: "ssrc_1", ownerId: "device-owner" as UserId, origin: "https://central.example", deviceId: `sdv_${hex(1, 32)}`,
    secret: `sds_${hex(1, 64)}`, etag: null, lastAttemptAt: null, lastSuccessAt: null, status: "active" as const, lastError: null }
  expect(await repo.syncSources.get()).toBeNull()
  expect(await repo.syncSources.create(source)).toBe(true)
  expect(await repo.syncSources.create({ ...source, id: "ssrc_2" })).toBe(false)
  expect(await repo.syncSources.get()).toEqual(source)

  expect(await repo.syncSources.recordResult("ssrc_1", source.secret, { attemptAt: "t1", successAt: "t1", etag: '"abc"', error: null })).toBe(true)
  expect(await repo.syncSources.recordResult("ssrc_1", "sds_wrong", { attemptAt: "t2", error: "unreachable" })).toBe(false)
  expect(await repo.syncSources.recordResult("ssrc_1", source.secret, { attemptAt: "t3", error: "unreachable" })).toBe(true)
  expect(await repo.syncSources.get()).toMatchObject({ etag: '"abc"', lastAttemptAt: "t3", lastSuccessAt: "t1", lastError: "unreachable", status: "active" })
  await repo.syncSources.recordResult("ssrc_1", source.secret, { attemptAt: "t4", etag: null, error: null, status: "revoked" })
  expect(await repo.syncSources.get()).toMatchObject({ etag: null, status: "revoked", lastError: null })

  const replaced = await repo.syncSources.replaceDocument("ssrc_1", { origin: "https://other.example", deviceId: `sdv_${hex(2, 32)}`, secret: `sds_${hex(2, 64)}` }, "t5")
  expect(replaced).toMatchObject({ id: "ssrc_1", ownerId: "device-owner", origin: "https://other.example", status: "active", etag: null, lastError: null, lastSuccessAt: null })
  expect(await repo.syncSources.replaceDocument("missing", { origin: "https://x.example", deviceId: "d", secret: "s" }, "t6")).toBeNull()
  expect(await repo.syncSources.delete("ssrc_1")).toBe(true)
  expect(await repo.syncSources.delete("ssrc_1")).toBe(false)
  expect(await repo.syncSources.create({ ...source, id: "ssrc_3" })).toBe(true)
})

test("applySynced creates rows after the owner's existing upstreams with device-local defaults", async () => {
  await repo.upstreams.save(local("up_local", 5))
  expect(await repo.upstreams.applySynced("ssrc_1", input(), stamp)).toBe("created")
  expect(await repo.upstreams.applySynced("ssrc_1", input({ id: "up_copilot_c2", name: "Second" }), stamp)).toBe("created")
  const first = (await repo.upstreams.getById("up_copilot_c1" as never))!
  expect(first).toMatchObject({ syncSourceId: "ssrc_1", ownerId: "device-owner", enabled: true, sortOrder: 6, proxyFallbackList: [],
    config: { githubToken: "ghp_a" }, state: null, catalogGeneration: 0, credentialGeneration: 0 })
  expect((await repo.upstreams.getById("up_copilot_c2" as never))?.sortOrder).toBe(7)
  expect((await repo.upstreams.getById("up_local" as never))?.syncSourceId).toBeUndefined()
  expect((await repo.upstreams.listSynced("ssrc_1")).map(row => row.id)).toEqual(["up_copilot_c1", "up_copilot_c2"])
})

test("applySynced keeps enabled, sort order and proxies, and advances generations only when config changes", async () => {
  await repo.upstreams.applySynced("ssrc_1", input(), stamp)
  const created = (await repo.upstreams.getById("up_copilot_c1" as never))!
  await repo.upstreams.patchMetadata(created, current => ({ ...current, enabled: false, sortOrder: 7, proxyFallbackList: [{ id: "proxy-a" }] }))
  const before = (await repo.upstreams.getById("up_copilot_c1" as never))!

  expect(await repo.upstreams.applySynced("ssrc_1", input(), "2026-11-16T01:00:00.000Z")).toBe("unchanged")
  expect((await repo.upstreams.getById("up_copilot_c1" as never))?.updatedAt).toBe(before.updatedAt)

  expect(await repo.upstreams.applySynced("ssrc_1", input({ name: "Renamed", flagOverrides: { x: true }, disabledPublicModelIds: ["m"] }), "2026-11-16T01:00:00.000Z")).toBe("updated")
  const meta = (await repo.upstreams.getById("up_copilot_c1" as never))!
  expect(meta).toMatchObject({ name: "Renamed", enabled: false, sortOrder: 7, proxyFallbackList: [{ id: "proxy-a" }],
    flagOverrides: { x: true }, disabledPublicModelIds: ["m"], catalogGeneration: before.catalogGeneration, credentialGeneration: before.credentialGeneration })

  expect(await repo.upstreams.applySynced("ssrc_1", input({ name: "Renamed", flagOverrides: { x: true }, disabledPublicModelIds: ["m"], state: { copilotApiEndpoint: "https://e.example" } }), stamp)).toBe("updated")
  const stateOnly = (await repo.upstreams.getById("up_copilot_c1" as never))!
  expect(stateOnly.state).toEqual({ copilotApiEndpoint: "https://e.example" })
  expect([stateOnly.catalogGeneration, stateOnly.credentialGeneration]).toEqual([before.catalogGeneration, before.credentialGeneration])

  expect(await repo.upstreams.applySynced("ssrc_1", input({ name: "Renamed", flagOverrides: { x: true }, disabledPublicModelIds: ["m"], state: { copilotApiEndpoint: "https://e.example" }, config: { githubToken: "ghp_b" } }), stamp)).toBe("updated")
  const replaced = (await repo.upstreams.getById("up_copilot_c1" as never))!
  expect(replaced.config).toEqual({ githubToken: "ghp_b" })
  expect([replaced.catalogGeneration, replaced.credentialGeneration]).toEqual([before.catalogGeneration + 1, before.credentialGeneration + 1])
  expect([replaced.enabled, replaced.sortOrder, replaced.rowIncarnation]).toEqual([false, 7, before.rowIncarnation])
})

test("applySynced never touches a local row or another source's row", async () => {
  await repo.upstreams.save(local("up_copilot_c1"))
  expect(await repo.upstreams.applySynced("ssrc_1", input(), stamp)).toBe("conflict")
  expect((await repo.upstreams.getById("up_copilot_c1" as never))).toMatchObject({ provider: "custom", name: "up_copilot_c1" })
  await repo.upstreams.applySynced("ssrc_1", input({ id: "up_copilot_c9" }), stamp)
  expect(await repo.upstreams.applySynced("ssrc_2", input({ id: "up_copilot_c9", name: "Intruder" }), stamp)).toBe("conflict")
  expect((await repo.upstreams.getById("up_copilot_c9" as never))?.name).toBe("Copilot")
})

test("save never overwrites a synced row, and deleteSynced removes only absent rows of one source", async () => {
  await repo.upstreams.applySynced("ssrc_1", input(), stamp)
  await repo.upstreams.save({ ...local("up_copilot_c1"), name: "Hijack", config: { githubToken: "stolen" } })
  expect(await repo.upstreams.getById("up_copilot_c1" as never)).toMatchObject({ name: "Copilot", syncSourceId: "ssrc_1", config: { githubToken: "ghp_a" } })
  await repo.upstreams.applySynced("ssrc_1", input({ id: "up_copilot_c2" }), stamp)
  await repo.upstreams.applySynced("ssrc_1", input({ id: "up_copilot_c3" }), stamp)
  await repo.upstreams.applySynced("ssrc_2", input({ id: "up_copilot_d1" }), stamp)
  await repo.upstreams.save(local("up_local"))
  await repo.upstreams.deleteSynced("ssrc_1", ["up_copilot_c2"])
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()).toEqual(["up_copilot_c2", "up_copilot_d1", "up_local"])
  await repo.upstreams.deleteSynced("ssrc_1")
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()).toEqual(["up_copilot_d1", "up_local"])
})

test("synced writes advance the configuration revision so routing caches refresh", async () => {
  const before = await repo.configurationRevision!()
  await repo.upstreams.applySynced("ssrc_1", input(), stamp)
  const created = await repo.configurationRevision!()
  expect(created).toBeGreaterThan(before)
  await repo.upstreams.applySynced("ssrc_1", input({ config: { githubToken: "ghp_b" } }), stamp)
  expect(await repo.configurationRevision!()).toBeGreaterThan(created)
  const settled = await repo.configurationRevision!()
  db.run("UPDATE upstreams SET sync_source_id = 'ssrc_9' WHERE id = 'up_copilot_c1'")
  expect(await repo.configurationRevision!()).toBe(settled)
})
```

Create `packages/gateway/tests/sync-repo.d1.test.ts` (same Miniflare harness as `api-key-upstreams.d1.test.ts`, applying the real migration files):

```ts
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { D1Repo, type D1Database } from "@vibe-llm/platform-cloudflare/src/d1-repo.ts"
import { migrationsDir } from "../src/migrations-dir.ts"
import type { UserId } from "../src/repo/branded-ids"

let dir: string
let mf: Miniflare
let repo: D1Repo
const owner = "d1-sync-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const hex = (n: number, length: number) => n.toString(16).padStart(length, "0")
const device = (n: number) => ({ id: `sdv_${hex(n, 32)}`, ownerId: owner, label: `D${n}`, secretHash: hex(n, 64), upstreamIds: [], createdAt: stamp, lastSyncAt: null })
const input = (over: Record<string, unknown> = {}) => ({ id: "up_copilot_d1", ownerId: "device-owner", provider: "copilot" as const, name: "Copilot",
  config: { githubToken: "ghp_a" }, state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sync-repo-d1-"))
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fixture') } }",
    host: "127.0.0.1", port: 0, compatibilityDate: "2025-06-01", d1Databases: { DB: "sync-repo" }, d1Persist: join(dir, "d1") })
  const db = await mf.getD1Database("DB")
  const source = fileURLToPath(migrationsDir)
  for (const name of readdirSync(source).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of unstable_splitSqlQuery(readFileSync(join(source, name), "utf8"))) await db.prepare(sql).run()
  }
  repo = new D1Repo(db as unknown as D1Database)
})
afterAll(async () => { await mf?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true }) })

test.serial("actual D1 stores sync devices within the limit and stamps last sync once per window", async () => {
  for (let n = 1; n <= 2; n++) expect(await repo.syncDevices.createWithinLimit(device(n), 2)).toBe(true)
  expect(await repo.syncDevices.createWithinLimit(device(3), 2)).toBe(false)
  expect((await repo.syncDevices.findBySecretHash(hex(2, 64)))?.label).toBe("D2")
  await repo.syncDevices.touchLastSync(device(1).id, "2026-11-16T10:00:00.000Z", "2026-11-16T09:50:00.000Z")
  await repo.syncDevices.touchLastSync(device(1).id, "2026-11-16T10:05:00.000Z", "2026-11-16T09:55:00.000Z")
  expect((await repo.syncDevices.getById(device(1).id))?.lastSyncAt).toBe("2026-11-16T10:00:00.000Z")
  expect(await repo.syncDevices.delete(device(1).id, owner)).toBe(true)
})

test.serial("actual D1 holds one sync source and applies synced upstreams without touching device-local fields", async () => {
  const source = { id: "ssrc_d1", ownerId: "device-owner" as UserId, origin: "https://central.example", deviceId: `sdv_${hex(1, 32)}`,
    secret: `sds_${hex(1, 64)}`, etag: null, lastAttemptAt: null, lastSuccessAt: null, status: "active" as const, lastError: null }
  expect(await repo.syncSources.create(source)).toBe(true)
  expect(await repo.syncSources.create({ ...source, id: "ssrc_d1b" })).toBe(false)

  expect(await repo.upstreams.applySynced("ssrc_d1", input(), stamp)).toBe("created")
  const created = (await repo.upstreams.getById("up_copilot_d1" as never))!
  await repo.upstreams.patchMetadata(created, current => ({ ...current, enabled: false, sortOrder: 4 }))
  const before = (await repo.upstreams.getById("up_copilot_d1" as never))!
  expect(await repo.upstreams.applySynced("ssrc_d1", input({ config: { githubToken: "ghp_b" } }), stamp)).toBe("updated")
  const after = (await repo.upstreams.getById("up_copilot_d1" as never))!
  expect([after.enabled, after.sortOrder, after.syncSourceId]).toEqual([false, 4, "ssrc_d1"])
  expect([after.catalogGeneration, after.credentialGeneration]).toEqual([before.catalogGeneration + 1, before.credentialGeneration + 1])
  expect(await repo.upstreams.applySynced("ssrc_other", input(), stamp)).toBe("conflict")
  await repo.upstreams.deleteSynced("ssrc_d1")
  expect(await repo.upstreams.getById("up_copilot_d1" as never)).toBeNull()
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test ./packages/gateway/tests/migrations.test.ts ./packages/gateway/tests/sync-repo.sqlite.test.ts`

Expected: FAIL: no `sync_source_id` column / `sync_sources` table, and `repo.syncDevices` is undefined.

- [ ] **Step 3: Write the migration**

Create `packages/gateway/migrations/0025_gateway_upstream_sync.sql`:

```sql
-- Gateway upstream sync. A central gateway lists the devices allowed to pull a snapshot of selected upstreams;
-- a device gateway keeps at most one source to pull from and tags the rows it created.
CREATE TABLE sync_devices (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id GLOB 'sdv_*'),
  owner_id TEXT NOT NULL,
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
  secret_hash TEXT NOT NULL UNIQUE CHECK (length(secret_hash) = 64),
  upstream_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_sync_at TEXT
);
CREATE INDEX idx_sync_devices_owner ON sync_devices (owner_id, created_at);

-- `singleton` plus its UNIQUE constraint enforces "at most one row". `owner_id` is the user the synced upstreams belong to.
CREATE TABLE sync_sources (
  id TEXT PRIMARY KEY,
  singleton INTEGER NOT NULL DEFAULT 1 CHECK (singleton = 1) UNIQUE,
  owner_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  device_id TEXT NOT NULL,
  secret TEXT NOT NULL,
  etag TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  last_error TEXT
);

-- Written only by INSERT (device apply) and never updated. It is deliberately not watched by
-- upstreams_catalog_generation or configuration_upstreams_update, so it cannot advance a generation.
ALTER TABLE upstreams ADD COLUMN sync_source_id TEXT;
CREATE INDEX idx_upstreams_sync_source ON upstreams (sync_source_id) WHERE sync_source_id IS NOT NULL;
```

- [ ] **Step 4: Repository types**

Create `packages/gateway/src/repo/sync.ts`:

```ts
import type { UpstreamKind } from "@vibe-llm/protocols/common"
import type { UserId } from "./branded-ids.ts"

export interface SyncDeviceRecord {
  id: string
  ownerId: UserId
  label: string
  /** SHA-256 hex of the device secret; the secret itself is never stored. */
  secretHash: string
  upstreamIds: string[]
  createdAt: string
  lastSyncAt: string | null
}

export interface SyncDeviceRepo {
  /** Oldest first. */
  listByOwner(ownerId: UserId): Promise<SyncDeviceRecord[]>
  getById(id: string): Promise<SyncDeviceRecord | null>
  findBySecretHash(secretHash: string): Promise<SyncDeviceRecord | null>
  /** Inserts unless the owner already holds `limit` devices. False means the limit was reached. */
  createWithinLimit(device: SyncDeviceRecord, limit: number): Promise<boolean>
  /** Updates only supplied fields; null when the device does not exist or belongs to another owner. */
  update(id: string, ownerId: UserId, patch: { label?: string; upstreamIds?: readonly string[] }): Promise<SyncDeviceRecord | null>
  delete(id: string, ownerId: UserId): Promise<boolean>
  deleteByOwner(ownerId: UserId): Promise<void>
  /** Stamps `last_sync_at = now` unless it already holds a value at or after `notBefore`. */
  touchLastSync(id: string, now: string, notBefore: string): Promise<void>
}

export type SyncSourceStatus = "active" | "revoked"

export interface SyncSourceRecord {
  id: string
  /** The device user the synced upstreams belong to. */
  ownerId: UserId
  origin: string
  deviceId: string
  secret: string
  etag: string | null
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  status: SyncSourceStatus
  lastError: string | null
}

export interface SyncSourceResult {
  attemptAt: string
  successAt?: string
  /** Undefined keeps the stored ETag, null clears it, a string replaces it. */
  etag?: string | null
  error: string | null
  status?: SyncSourceStatus
}

export interface SyncSourceRepo {
  get(): Promise<SyncSourceRecord | null>
  /** False when a source already exists. */
  create(source: SyncSourceRecord): Promise<boolean>
  /** Replaces origin, device and secret in place and resets etag, error, success time and status. Null when gone. */
  replaceDocument(id: string, document: { origin: string; deviceId: string; secret: string }, now: string): Promise<SyncSourceRecord | null>
  /** Fenced on the secret so a result computed for a replaced document is dropped (false). */
  recordResult(id: string, secret: string, result: SyncSourceResult): Promise<boolean>
  delete(id: string): Promise<boolean>
}

/** One snapshot entry as the device writes it. Local fields (enabled, sort order, proxies) are not part of it. */
export interface SyncedUpstreamInput {
  id: string
  ownerId: string
  provider: UpstreamKind
  name: string
  config: Record<string, unknown>
  state: unknown
  flagOverrides: Record<string, boolean>
  disabledPublicModelIds: string[]
}

/** `conflict`: a row with this id exists that this source does not own. */
export type SyncedUpstreamOutcome = "created" | "updated" | "unchanged" | "conflict"
```

Create `packages/gateway/src/repo/shared/sync.ts`:

```ts
import type { UserId } from "../branded-ids.ts"
import type { SyncDeviceRecord, SyncDeviceRepo, SyncSourceRecord, SyncSourceRepo, SyncSourceResult, SyncSourceStatus } from "../sync.ts"
import type { SqlExecutor } from "./executor.ts"

const DEVICE_COLS = "id, owner_id, label, secret_hash, upstream_ids_json, created_at, last_sync_at"
const SOURCE_COLS = "id, owner_id, origin, device_id, secret, etag, last_attempt_at, last_success_at, status, last_error"

interface DeviceRow {
  id: string
  owner_id: string
  label: string
  secret_hash: string
  upstream_ids_json: string
  created_at: string
  last_sync_at: string | null
}

interface SourceRow {
  id: string
  owner_id: string
  origin: string
  device_id: string
  secret: string
  etag: string | null
  last_attempt_at: string | null
  last_success_at: string | null
  status: SyncSourceStatus
  last_error: string | null
}

function parseIds(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json)
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
  } catch { return [] }
}

const toDevice = (row: DeviceRow): SyncDeviceRecord => ({
  id: row.id, ownerId: row.owner_id as UserId, label: row.label, secretHash: row.secret_hash,
  upstreamIds: parseIds(row.upstream_ids_json), createdAt: row.created_at, lastSyncAt: row.last_sync_at,
})

const toSource = (row: SourceRow): SyncSourceRecord => ({
  id: row.id, ownerId: row.owner_id as UserId, origin: row.origin, deviceId: row.device_id, secret: row.secret, etag: row.etag,
  lastAttemptAt: row.last_attempt_at, lastSuccessAt: row.last_success_at, status: row.status, lastError: row.last_error,
})

export class SharedSyncDeviceRepo implements SyncDeviceRepo {
  constructor(private readonly x: SqlExecutor) {}

  async listByOwner(ownerId: UserId): Promise<SyncDeviceRecord[]> {
    const rows = await this.x.all<DeviceRow>(`SELECT ${DEVICE_COLS} FROM sync_devices WHERE owner_id = ? ORDER BY created_at ASC, id ASC`, [ownerId])
    return rows.map(toDevice)
  }

  async getById(id: string): Promise<SyncDeviceRecord | null> {
    const row = await this.x.first<DeviceRow>(`SELECT ${DEVICE_COLS} FROM sync_devices WHERE id = ?`, [id])
    return row ? toDevice(row) : null
  }

  async findBySecretHash(secretHash: string): Promise<SyncDeviceRecord | null> {
    const row = await this.x.first<DeviceRow>(`SELECT ${DEVICE_COLS} FROM sync_devices WHERE secret_hash = ?`, [secretHash])
    return row ? toDevice(row) : null
  }

  async createWithinLimit(device: SyncDeviceRecord, limit: number): Promise<boolean> {
    const result = await this.x.run(
      `INSERT INTO sync_devices (${DEVICE_COLS}) SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM sync_devices WHERE owner_id = ?) < ?`,
      [device.id, device.ownerId, device.label, device.secretHash, JSON.stringify(device.upstreamIds), device.createdAt,
        device.lastSyncAt, device.ownerId, limit],
    )
    return result.changes > 0
  }

  async update(id: string, ownerId: UserId, patch: { label?: string; upstreamIds?: readonly string[] }): Promise<SyncDeviceRecord | null> {
    const row = await this.x.first<DeviceRow>(
      `UPDATE sync_devices SET label = COALESCE(?, label), upstream_ids_json = COALESCE(?, upstream_ids_json)
       WHERE id = ? AND owner_id = ? RETURNING ${DEVICE_COLS}`,
      [patch.label ?? null, patch.upstreamIds === undefined ? null : JSON.stringify(patch.upstreamIds), id, ownerId],
    )
    return row ? toDevice(row) : null
  }

  async delete(id: string, ownerId: UserId): Promise<boolean> {
    const result = await this.x.run("DELETE FROM sync_devices WHERE id = ? AND owner_id = ?", [id, ownerId])
    return result.changes > 0
  }

  async deleteByOwner(ownerId: UserId): Promise<void> {
    await this.x.run("DELETE FROM sync_devices WHERE owner_id = ?", [ownerId])
  }

  async touchLastSync(id: string, now: string, notBefore: string): Promise<void> {
    await this.x.run("UPDATE sync_devices SET last_sync_at = ? WHERE id = ? AND (last_sync_at IS NULL OR last_sync_at < ?)", [now, id, notBefore])
  }
}

export class SharedSyncSourceRepo implements SyncSourceRepo {
  constructor(private readonly x: SqlExecutor) {}

  async get(): Promise<SyncSourceRecord | null> {
    const row = await this.x.first<SourceRow>(`SELECT ${SOURCE_COLS} FROM sync_sources LIMIT 1`, [])
    return row ? toSource(row) : null
  }

  async create(source: SyncSourceRecord): Promise<boolean> {
    const result = await this.x.run(
      `INSERT INTO sync_sources (${SOURCE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [source.id, source.ownerId, source.origin, source.deviceId, source.secret, source.etag, source.lastAttemptAt,
        source.lastSuccessAt, source.status, source.lastError],
    )
    return result.changes > 0
  }

  async replaceDocument(id: string, document: { origin: string; deviceId: string; secret: string }, now: string): Promise<SyncSourceRecord | null> {
    const row = await this.x.first<SourceRow>(
      `UPDATE sync_sources SET origin = ?, device_id = ?, secret = ?, etag = NULL, last_attempt_at = ?, last_success_at = NULL,
         status = 'active', last_error = NULL WHERE id = ? RETURNING ${SOURCE_COLS}`,
      [document.origin, document.deviceId, document.secret, now, id],
    )
    return row ? toSource(row) : null
  }

  async recordResult(id: string, secret: string, result: SyncSourceResult): Promise<boolean> {
    const setEtag = result.etag !== undefined
    const outcome = await this.x.run(
      `UPDATE sync_sources SET last_attempt_at = ?, last_success_at = COALESCE(?, last_success_at),
         etag = CASE WHEN ? = 1 THEN ? ELSE etag END, last_error = ?, status = COALESCE(?, status)
       WHERE id = ? AND secret = ?`,
      [result.attemptAt, result.successAt ?? null, setEtag ? 1 : 0, result.etag ?? null, result.error, result.status ?? null, id, secret],
    )
    return outcome.changes > 0
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.x.run("DELETE FROM sync_sources WHERE id = ?", [id])
    return result.changes > 0
  }
}
```

- [ ] **Step 5: Wire the types into `Repo` and `UpstreamRepo`**

In `packages/gateway/src/repo/types.ts`:

1. Add after the existing `import type { SharedSessionConfig } ...` line (line 15):

```ts
import type { SyncDeviceRepo, SyncSourceRepo, SyncedUpstreamInput, SyncedUpstreamOutcome } from "./sync.ts"
```

2. Replace line 222 (`export type StoredUpstreamRecord<TState = unknown> = ...`) with:

```ts
/** `syncSourceId` is set only on rows a device gateway created from a sync source. */
export type StoredUpstreamRecord<TState = unknown> = CoreStoredUpstreamRecord<TState, UpstreamKind> & { catalogGeneration: number; syncSourceId?: string }
```

3. Add inside `UpstreamRepo`, after `saveState` (line 243):

```ts
  /** Device sync: rows this source created, in display order. */
  listSynced(sourceId: string): Promise<StoredUpstreamRecord[]>
  /** Device sync: create or overwrite one row owned by `sourceId`. Keeps enabled, sort order and the proxy list. Advances
   * catalog and credential generations only when provider or config changed. Never touches a row the source does not own. */
  applySynced(sourceId: string, input: SyncedUpstreamInput, now: string): Promise<SyncedUpstreamOutcome>
  /** Device sync: delete this source's rows except `keepIds`. */
  deleteSynced(sourceId: string, keepIds?: readonly string[]): Promise<void>
```

4. Add to `Repo` (after `observabilityShares: ObservabilityShareRepo`):

```ts
  syncDevices: SyncDeviceRepo
  syncSources: SyncSourceRepo
```

In `packages/gateway/src/repo/index.ts` add to the type export block (after line 14):

```ts
export type { SyncDeviceRecord, SyncDeviceRepo, SyncSourceRecord, SyncSourceRepo } from "./sync.ts"
```

In `packages/gateway/src/repo/configuration-cache.ts`, in the `upstreams:` entry of `configurationMethodEffects` (lines 297-301), add `listSynced: "read",` to the first line and the two writes:

```ts
  upstreams: {
    list: "read", getById: "read", listSynced: "read", saveState: "state-write", // Refreshed row-by-row below.
    save: "configuration-write", createIfAbsent: "configuration-write", replaceCredentials: "configuration-write",
    patchMetadata: "configuration-write", applySynced: "configuration-write", deleteSynced: "configuration-write",
    delete: "configuration-write", deleteAll: "configuration-write",
  },
```

- [ ] **Step 6: SQL implementation in `repos.ts`**

Edits to `packages/gateway/src/repo/shared/repos.ts`:

1. Add imports. After line 8 (`import { SharedSetupLeaseRepo } from "./setup-leases.ts"`):

```ts
import { SharedSyncDeviceRepo, SharedSyncSourceRepo } from "./sync.ts"
import type { SyncedUpstreamInput, SyncedUpstreamOutcome } from "../sync.ts"
```

2. Replace line 68 with an insert-column list and a read list:

```ts
const UPSTREAM_INSERT_COLS = "catalog_generation, credential_generation, row_incarnation, id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at"
/** Everything a read returns. `sync_source_id` is written only by `applySynced`, never by the positional INSERTs. */
const UPSTREAM_COLS = `${UPSTREAM_INSERT_COLS}, sync_source_id`
```

3. In `toUpstreamRecord` (lines 217-236) replace the tail

```ts
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseProxyFallbackList(
```

with

```ts
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.sync_source_id ? { syncSourceId: row.sync_source_id } : {}),
  }
}

function parseProxyFallbackList(
```

4. In `interface UpstreamSqlRow` add `  sync_source_id: string | null` after `updated_at: string`.

5. Replace `save` and `createIfAbsent` (lines 637-652). Both now insert with `UPSTREAM_INSERT_COLS`, and `save` leaves synced rows alone (the `WHERE` makes the conflict branch a no-op for them):

```ts
  async save(upstream: UpstreamRecord<unknown>): Promise<void> {
    await this.x.run(
      `INSERT INTO upstreams (${UPSTREAM_INSERT_COLS}) VALUES (0, 0, lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET catalog_generation = upstreams.catalog_generation + 1, credential_generation = upstreams.credential_generation + 1, owner_id = excluded.owner_id, provider = excluded.provider, name = excluded.name, enabled = excluded.enabled, sort_order = excluded.sort_order, config_json = excluded.config_json, flag_overrides = excluded.flag_overrides, disabled_public_model_ids = excluded.disabled_public_model_ids, state_json = excluded.state_json, proxy_fallback_list_json = excluded.proxy_fallback_list_json, updated_at = excluded.updated_at
       WHERE upstreams.sync_source_id IS NULL`,
      this.insertBinds(upstream),
    )
  }

  async createIfAbsent(upstream: UpstreamRecord<unknown>): Promise<StoredUpstreamRecord | null> {
    const row = await this.x.first<UpstreamSqlRow>(
      `INSERT INTO upstreams (${UPSTREAM_INSERT_COLS}) VALUES (0, 0, lower(hex(randomblob(16))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING RETURNING ${UPSTREAM_COLS}`,
      this.insertBinds(upstream),
    )
    return row ? toUpstreamRecord(row) : null
  }
```

6. Add these three methods to `SharedUpstreamRepo` directly above `async delete(id: UpstreamId): Promise<boolean> {` (line 722):

```ts
  async listSynced(sourceId: string): Promise<StoredUpstreamRecord[]> {
    const rows = await this.x.all<UpstreamSqlRow>(
      `SELECT ${UPSTREAM_COLS} FROM upstreams WHERE sync_source_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC`, [sourceId])
    return rows.map(toUpstreamRecord)
  }

  async applySynced(sourceId: string, input: SyncedUpstreamInput, now: string): Promise<SyncedUpstreamOutcome> {
    const config = JSON.stringify(input.config)
    const flags = JSON.stringify(input.flagOverrides)
    const disabled = JSON.stringify(input.disabledPublicModelIds)
    const state = serializeState(input.state)
    for (let attempt = 0; attempt < UPSTREAM_WRITE_ATTEMPTS; attempt++) {
      // New rows sort after the owner's existing upstreams, start enabled and with no proxies.
      const created = await this.x.first<{ id: string }>(
        `INSERT INTO upstreams (catalog_generation, credential_generation, row_incarnation, id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at, sync_source_id)
         VALUES (0, 0, lower(hex(randomblob(16))), ?, ?, ?, ?, 1, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM upstreams WHERE owner_id = ?), ?, ?, ?, ?, '[]', ?, ?, ?)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [input.id, input.ownerId, input.provider, input.name, input.ownerId, config, flags, disabled, state, now, now, sourceId],
      )
      if (created) return "created"
      const row = await this.x.first<UpstreamSqlRow>(`SELECT ${UPSTREAM_COLS} FROM upstreams WHERE id = ?`, [input.id])
      if (!row) continue // deleted between the two statements: insert again
      if (row.sync_source_id !== sourceId) return "conflict"
      const configChanged = row.provider !== input.provider || row.config_json !== config
      const metadataChanged = row.name !== input.name || row.owner_id !== input.ownerId
        || row.flag_overrides !== flags || row.disabled_public_model_ids !== disabled
      if (!configChanged && !metadataChanged && row.state_json === state) return "unchanged"
      // A config change replaces the credential identity (as replaceCredentials does); state and metadata do not.
      const bump = configChanged ? 1 : 0
      const matched = await this.x.first<{ id: string }>(
        `UPDATE upstreams SET owner_id = ?, provider = ?, name = ?, config_json = ?, flag_overrides = ?, disabled_public_model_ids = ?, state_json = ?, updated_at = ?,
           catalog_generation = catalog_generation + ?, credential_generation = credential_generation + ?
         WHERE id = ? AND sync_source_id = ? AND row_incarnation = ? AND provider = ? AND config_json IS ? AND state_json IS ? RETURNING id`,
        [input.ownerId, input.provider, input.name, config, flags, disabled, state, now, bump, bump,
          input.id, sourceId, row.row_incarnation, row.provider, row.config_json, row.state_json],
      )
      if (matched) return "updated"
    }
    throw new UpstreamContentionError(input.id)
  }

  async deleteSynced(sourceId: string, keepIds: readonly string[] = []): Promise<void> {
    await this.x.run(
      "DELETE FROM upstreams WHERE sync_source_id = ? AND id NOT IN (SELECT value FROM json_each(?))",
      [sourceId, JSON.stringify(keepIds)],
    )
  }

```

7. In `buildSharedRepo` (line 1365+) add after `observabilityShares: new SharedObservabilityShareRepo(x),`:

```ts
    syncDevices: new SharedSyncDeviceRepo(x),
    syncSources: new SharedSyncSourceRepo(x),
```

- [ ] **Step 7: Expose the repos on both runtimes and cascade user deletion**

In `apps/platform-bun/src/bun-sqlite-repo.ts` and `apps/platform-cloudflare/src/d1-repo.ts` add the same three pieces to the class:

```ts
  syncDevices: Repo["syncDevices"]
  syncSources: Repo["syncSources"]
```
(after `observabilityShares: Repo["observabilityShares"]`), and in the constructor, after `this.observabilityShares = shared.observabilityShares`:

```ts
    this.syncDevices = shared.syncDevices
    this.syncSources = shared.syncSources
```

In `packages/gateway/src/control-plane/auth/routes.ts` add after line 266 (`await repo.observabilityShares.deleteByViewer(userId)`):

```ts
  await repo.syncDevices.deleteByOwner(userId)
```

In `packages/gateway/tests/control-plane-auth.test.ts`, add to the fake repo right after the `observabilityShares: { ... },` block (line 112, before `} as unknown as Repo`):

```ts
    syncDevices: { deleteByOwner: async () => { } },
```

- [ ] **Step 8: Regenerate the schema baseline and run the tests**

```bash
UPDATE_SCHEMA_BASELINE=1 bun test ./packages/gateway/tests/migrations.test.ts
git diff --stat packages/gateway/tests/schema-baseline.txt
bun test ./packages/gateway/tests/migrations.test.ts ./packages/gateway/tests/sync-repo.sqlite.test.ts ./packages/gateway/tests/sync-repo.d1.test.ts
bun test ./packages/gateway/tests/control-plane-auth.test.ts ./packages/gateway/tests/control-plane-upstreams.test.ts ./packages/gateway/tests/control-plane-data-transfer.test.ts ./packages/gateway/tests/api-key-upstreams.d1.test.ts ./packages/gateway/tests/catalog-repo.sqlite.test.ts ./packages/gateway/tests/configuration-snapshot.test.ts
bun run --filter '@vibe-llm/gateway' typecheck
bun run --filter '@vibe-llm/platform-bun' typecheck
bun run --filter '@vibe-llm/platform-cloudflare' typecheck
```

Expected: the baseline diff changes the `upstreams` table line (adds `,sync_source_id TEXT`) and adds `table sync_devices`, `table sync_sources`, `index idx_sync_devices_owner`, `index idx_upstreams_sync_source` (the snapshot query excludes `sqlite_%` names, so the automatic indexes for the `UNIQUE` columns do not appear). All tests PASS and typechecks are clean. Review `git diff packages/gateway/tests/schema-baseline.txt` before committing: only these additions and the one modified `upstreams` line may appear.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/migrations/0025_gateway_upstream_sync.sql packages/gateway/tests/schema-baseline.txt \
  packages/gateway/tests/migrations.test.ts packages/gateway/tests/sync-repo.sqlite.test.ts packages/gateway/tests/sync-repo.d1.test.ts \
  packages/gateway/src/repo/sync.ts packages/gateway/src/repo/shared/sync.ts packages/gateway/src/repo/types.ts \
  packages/gateway/src/repo/index.ts packages/gateway/src/repo/shared/repos.ts packages/gateway/src/repo/configuration-cache.ts \
  apps/platform-bun/src/bun-sqlite-repo.ts apps/platform-cloudflare/src/d1-repo.ts \
  packages/gateway/src/control-plane/auth/routes.ts packages/gateway/tests/control-plane-auth.test.ts
git commit -F - <<'EOF'
feat(vnext/gateway): add sync devices, sync sources and synced upstream rows

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 4: Central device management routes

`/api/sync/devices` is session-guarded and owner-only (administrators get no override). The guard that `lokiManagementRouter` carries inline (`loki/routes.ts`, the `use("*", ...)` block) moves into a shared middleware, with decision D10 applied (cookie sessions need `Origin` only on mutating methods).

**Files:**
- Create: `packages/gateway/src/sync/protocol.ts` (constants and the document builder; Task 6 extends it)
- Create: `packages/gateway/src/control-plane/shared/session-guard.ts`
- Create: `packages/gateway/src/control-plane/sync/common.ts`, `devices.ts`, `routes.ts`
- Modify: `packages/gateway/src/control-plane/loki/routes.ts` (the inline guard and the `SessionToken` import), `packages/gateway/src/control-plane/routes.ts` (lines 35-40)
- Test: `packages/gateway/tests/sync-devices.sqlite.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/tests/sync-devices.sqlite.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { syncManagementRouter } from "../src/control-plane/sync/routes"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "sync-owner" as UserId
const other = "sync-other" as UserId
const admin = "sync-admin" as UserId
const tokens = { [owner]: "ses_sync_owner", [other]: "ses_sync_other", [admin]: "ses_sync_admin" } as Record<string, string>
const stamp = "2026-11-16T00:00:00.000Z"
let db: Database
let repo: BunSqliteRepo
let app: Hono

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const seed = (id: string, ownerId: UserId, provider: "copilot" | "loki" | "custom") => repo.upstreams.save({
  id, ownerId, provider, name: id, enabled: true, sortOrder: 0, config: provider === "loki" ? { profileId: "loki-df-v1" } : {},
  flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp,
})

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  await repo.users.create({ id: admin, name: admin, email: "test@local.dev", createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) {
    await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await seed("up_copilot_a", owner, "copilot")
  await seed("up_loki_a", owner, "loki")
  await seed("up_custom_a", owner, "custom")
  await seed("up_copilot_x", other, "copilot")
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/sync", syncManagementRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

function call(path: string, method: string, body?: unknown, user: UserId = owner, base = "https://central.example") {
  return app.request(`${base}/api/sync${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
interface Issued { device: { id: string; label: string; upstreamIds: string[]; createdAt: string; lastSyncAt: string | null }
  document: { version: number; kind: string; gatewayOrigin: string; deviceId: string; deviceSecret: string } }
const issue = async (label = "MacBook", upstreamIds = ["up_copilot_a"], user: UserId = owner) =>
  (await (await call("/devices", "POST", { label, upstreamIds }, user)).json()) as Issued

test("an owner issues a device once and only the secret hash is stored", async () => {
  const response = await call("/devices", "POST", { label: " MacBook ", upstreamIds: ["up_copilot_a", "up_loki_a", "up_copilot_a"] })
  expect(response.status).toBe(201)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const { device, document } = await response.json() as Issued
  expect(device).toMatchObject({ label: "MacBook", upstreamIds: ["up_copilot_a", "up_loki_a"], lastSyncAt: null })
  expect(device.id).toMatch(/^sdv_[a-f0-9]{32}$/)
  expect(document).toEqual({ version: 1, kind: "gateway-sync", gatewayOrigin: "https://central.example", deviceId: device.id, deviceSecret: document.deviceSecret })
  expect(document.deviceSecret).toMatch(/^sds_[a-f0-9]{64}$/)
  expect(JSON.stringify(db.query("SELECT * FROM sync_devices").all())).not.toContain(document.deviceSecret)
  expect(db.query<{ secret_hash: string }, []>("SELECT secret_hash FROM sync_devices").get()?.secret_hash).toBe(sha256(document.deviceSecret))
  const listed = await (await call("/devices", "GET")).text()
  expect(listed).not.toContain(document.deviceSecret)
  expect(listed).not.toContain("secretHash")
  expect(JSON.parse(listed).devices).toHaveLength(1)
})

test("issuing validates the label, the selection and the request origin", async () => {
  const cases: Array<[unknown, number, string]> = [
    [{ label: "x", upstreamIds: ["up_copilot_x"] }, 400, "invalid_upstreams"],
    [{ label: "x", upstreamIds: ["up_custom_a"] }, 400, "invalid_upstreams"],
    [{ label: "x", upstreamIds: ["missing"] }, 400, "invalid_upstreams"],
    [{ label: "   ", upstreamIds: [] }, 400, "invalid_request"],
    [{ label: "x".repeat(65), upstreamIds: [] }, 400, "invalid_request"],
    [{ label: "x", upstreamIds: [], extra: 1 }, 400, "invalid_request"],
    [{ upstreamIds: [] }, 400, "invalid_request"],
  ]
  for (const [body, status, code] of cases) {
    const response = await call("/devices", "POST", body)
    expect([response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([status, code])
  }
  const plain = await call("/devices", "POST", { label: "x", upstreamIds: [] }, owner, "http://central.example")
  expect([plain.status, (await plain.json() as { error: { code: string } }).error.code]).toEqual([400, "https_required"])
  const adminTakesOverUpstream = await call("/devices", "POST", { label: "x", upstreamIds: ["up_copilot_a"] }, admin)
  expect(adminTakesOverUpstream.status).toBe(400)
  expect(db.query("SELECT id FROM sync_devices").all()).toEqual([])
})

test("each owner may hold 16 devices", async () => {
  for (let n = 0; n < 16; n++) expect((await call("/devices", "POST", { label: `D${n}`, upstreamIds: [] })).status).toBe(201)
  const seventeenth = await call("/devices", "POST", { label: "D16", upstreamIds: [] })
  expect([seventeenth.status, (await seventeenth.json() as { error: { code: string } }).error.code]).toEqual([409, "device_limit"])
  expect((await call("/devices", "POST", { label: "Mine", upstreamIds: ["up_copilot_x"] }, other)).status).toBe(201)
})

test("devices belong to their owner alone, administrators included", async () => {
  const { device } = await issue()
  for (const user of [other, admin]) {
    expect(await (await call("/devices", "GET", undefined, user)).json()).toEqual({ devices: [] })
    for (const [method, body] of [["PATCH", { label: "Hijack" }], ["DELETE", undefined]] as const) {
      const response = await call(`/devices/${device.id}`, method, body, user)
      expect([response.status, (await response.json() as { error: { code: string } }).error.code]).toEqual([404, "device_not_found"])
    }
  }
  expect((await repo.syncDevices.getById(device.id))?.label).toBe("MacBook")
})

test("editing changes the label and selection without touching the secret", async () => {
  const { device } = await issue()
  const before = db.query<{ secret_hash: string }, []>("SELECT secret_hash FROM sync_devices").get()?.secret_hash
  const renamed = await call(`/devices/${device.id}`, "PATCH", { label: "Desktop" })
  expect(await renamed.json()).toMatchObject({ device: { id: device.id, label: "Desktop", upstreamIds: ["up_copilot_a"] } })
  const reselected = await call(`/devices/${device.id}`, "PATCH", { upstreamIds: ["up_loki_a"] })
  expect(await reselected.json()).toMatchObject({ device: { label: "Desktop", upstreamIds: ["up_loki_a"] } })
  for (const body of [{}, { upstreamIds: ["up_copilot_x"] }, { upstreamIds: ["up_custom_a"] }, { label: "" }, { extra: 1 }]) {
    expect((await call(`/devices/${device.id}`, "PATCH", body)).status).toBe(400)
  }
  expect((await call("/devices/not-an-id", "PATCH", { label: "x" })).status).toBe(404)
  expect(db.query<{ secret_hash: string }, []>("SELECT secret_hash FROM sync_devices").get()?.secret_hash).toBe(before)
})

test("revoking removes the device and answers the remaining list", async () => {
  const first = await issue("One")
  const second = await issue("Two")
  const revoked = await call(`/devices/${first.device.id}`, "DELETE")
  expect(revoked.status).toBe(200)
  expect(((await revoked.json()) as { devices: Array<{ id: string }> }).devices.map(d => d.id)).toEqual([second.device.id])
  expect((await call(`/devices/${first.device.id}`, "DELETE")).status).toBe(404)
})

test("management needs a real session and, for cookies, a matching Origin on mutations", async () => {
  await repo.users.update(owner, { userKey: "legacy-sync-owner" })
  const legacy = await app.request("https://central.example/api/sync/devices", { headers: { authorization: "Bearer legacy-sync-owner" } })
  expect(legacy.status).toBe(401)
  expect((await app.request("https://central.example/api/sync/devices")).status).toBe(401)
  expect((await app.request("https://central.example/api/sync/devices?x=1", { headers: { authorization: `Bearer ${tokens[owner]}` } })).status).toBe(401)
  const cookie = `session_token=${tokens[owner]}`
  const body = JSON.stringify({ label: "Cookie", upstreamIds: [] })
  for (const origin of [undefined, "https://foreign.example"]) {
    const response = await app.request("https://central.example/api/sync/devices", { method: "POST",
      headers: { cookie, "content-type": "application/json", ...(origin ? { origin } : {}) }, body })
    expect(response.status).toBe(403)
  }
  const same = await app.request("https://central.example/api/sync/devices", { method: "POST",
    headers: { cookie, origin: "https://central.example", "content-type": "application/json" }, body })
  expect(same.status).toBe(201)
  expect((await app.request("https://central.example/api/sync/devices", { headers: { cookie } })).status).toBe(200)
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `bun test ./packages/gateway/tests/sync-devices.sqlite.test.ts`

Expected: FAIL: cannot resolve `../src/control-plane/sync/routes`.

- [ ] **Step 3: Protocol constants**

Create `packages/gateway/src/sync/protocol.ts` (Task 6 adds parsing to this file):

```ts
export const SYNC_VERSION = 1 as const
export const SYNC_DEVICE_ID_PATTERN = /^sdv_[a-f0-9]{32}$/
export const SYNC_DEVICE_SECRET_PATTERN = /^sds_[a-f0-9]{64}$/
export const SYNC_MAX_DEVICES_PER_OWNER = 16
export const SYNC_MAX_DEVICE_UPSTREAMS = 256
/** `last_sync_at` is written at most this often per device. */
export const SYNC_LAST_SYNC_STAMP_MS = 10 * 60 * 1000

/** The one-time document handed to a device. */
export interface SyncDocument {
  version: typeof SYNC_VERSION
  kind: "gateway-sync"
  gatewayOrigin: string
  deviceId: string
  deviceSecret: string
}

export function syncDocument(gatewayOrigin: string, deviceId: string, deviceSecret: string): SyncDocument {
  return { version: SYNC_VERSION, kind: "gateway-sync", gatewayOrigin, deviceId, deviceSecret }
}
```

- [ ] **Step 4: The shared session guard**

Create `packages/gateway/src/control-plane/shared/session-guard.ts`. It is the Loki guard verbatim except for decision D10:

```ts
import type { MiddlewareHandler } from "hono"
import { getRepo } from "../../repo/index.ts"
import type { SessionToken } from "../../repo/branded-ids.ts"
import type { FullAuthCtx } from "../../shared/credential-auth.ts"

const deny = (status: 401 | 403, code: string) => new Response(JSON.stringify({ error: { code } }), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store" },
})

/**
 * Management routes for secrets and credentials: a real, current `ses_` session (not a legacy user key, not an
 * inference key, no query string), and a same-origin request. A cookie session must also carry `Origin` on mutating
 * methods, because browsers omit `Origin` on same-origin GET; a mismatched `Origin` is refused on every method.
 */
export const requireBrowserSession: MiddlewareHandler = async (c, next) => {
  const auth = c.get("auth") as FullAuthCtx | undefined
  if (auth?.authKind !== "session" || !auth.userId || auth.apiKeyId) return deny(401, "session_required")
  const url = new URL(c.req.url)
  const headers = c.req.raw.headers
  const authorization = headers.get("authorization")
  const token = authorization !== null ? /^Bearer (ses_[^\s]+)$/i.exec(authorization)?.[1]
    : /(?:^|;\s*)session_token=(ses_[^\s;]+)/.exec(headers.get("cookie") ?? "")?.[1]
  if (!token || token.length > 4096 || url.search || headers.has("x-api-key") || headers.has("x-goog-api-key")) {
    return deny(401, "session_required")
  }
  const origin = headers.get("origin")
  const mutating = c.req.method !== "GET" && c.req.method !== "HEAD"
  if ((origin !== null && origin !== url.origin) || (authorization === null && origin === null && mutating)) {
    return deny(403, "origin_not_allowed")
  }
  // Legacy user keys share authKind=session; require an actual, current session record.
  const session = await getRepo().sessions.findByToken(token as SessionToken)
  if (!session || session.userId !== auth.userId || !(Date.parse(session.expiresAt) > Date.now())) {
    return deny(401, "session_required")
  }
  await next()
}
```

In `packages/gateway/src/control-plane/loki/routes.ts` replace the whole inline guard (from `lokiManagementRouter.use("*", async (c, next) => {` through its closing `})`) with:

```ts
lokiManagementRouter.use("*", requireBrowserSession)
```

add `import { requireBrowserSession } from "../shared/session-guard"` to the imports, and delete the now unused `import type { SessionToken } from "../../repo/branded-ids"`. (Loki has no GET management routes any more, so its behavior is unchanged.)

- [ ] **Step 5: Control-plane helpers and the device routes**

Create `packages/gateway/src/control-plane/sync/common.ts`:

```ts
export class SyncError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

export const syncJson = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
})

/** Known errors keep their code; anything else is a uniform transient failure that leaks nothing. */
export function syncFailure(error: unknown): Response {
  if (error instanceof SyncError) return syncJson({ error: { code: error.code } }, error.status)
  return syncJson({ error: { code: "temporarily_unavailable" } }, 503)
}

/** Reads at most `maxBytes` of UTF-8 JSON. */
export async function readJsonBody(request: Request, maxBytes = 16_384): Promise<unknown> {
  if (!request.body) throw new SyncError("invalid_request", 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new SyncError("body_too_large", 413)
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
  catch { throw new SyncError("invalid_request", 400) }
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")
}

export const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("")
```

Create `packages/gateway/src/control-plane/sync/devices.ts`:

```ts
import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../../app"
import { isSyncableProvider } from "../../data-plane/providers/registry"
import { getRepo } from "../../repo"
import type { UpstreamId, UserId } from "../../repo/branded-ids"
import type { SyncDeviceRecord } from "../../repo/sync"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { SYNC_DEVICE_ID_PATTERN, SYNC_MAX_DEVICES_PER_OWNER, SYNC_MAX_DEVICE_UPSTREAMS, syncDocument } from "../../sync/protocol"
import { SyncError, randomHex, readJsonBody, sha256Hex, syncFailure, syncJson } from "./common"

export const syncDevicesRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

const label = z.string().trim().min(1).max(64)
const upstreamIds = z.array(z.string().min(1).max(256)).max(SYNC_MAX_DEVICE_UPSTREAMS)
const createBody = z.object({ label, upstreamIds }).strict()
const patchBody = z.object({ label: label.optional(), upstreamIds: upstreamIds.optional() }).strict()
  .refine(body => body.label !== undefined || body.upstreamIds !== undefined)

const publicDevice = (device: SyncDeviceRecord) => ({
  id: device.id, label: device.label, upstreamIds: device.upstreamIds, createdAt: device.createdAt, lastSyncAt: device.lastSyncAt,
})

async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readJsonBody(request))
  if (!parsed.success) throw new SyncError("invalid_request", 400)
  return parsed.data
}

/** Every id must be an upstream the caller owns whose provider is syncable. Administrators get no override. */
async function selection(ownerId: UserId, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)]
  for (const id of unique) {
    const row = await getRepo().upstreams.getById(id as UpstreamId)
    if (!row || row.ownerId !== ownerId || !isSyncableProvider(row.provider)) throw new SyncError("invalid_upstreams", 400)
  }
  return unique
}

/** The caller's device, or 404: another owner's device is indistinguishable from a missing one. */
async function ownedDevice(ownerId: UserId, id: string): Promise<SyncDeviceRecord> {
  const device = SYNC_DEVICE_ID_PATTERN.test(id) ? await getRepo().syncDevices.getById(id) : null
  if (!device || device.ownerId !== ownerId) throw new SyncError("device_not_found", 404)
  return device
}

syncDevicesRouter.get("/devices", async c => {
  try {
    const devices = await getRepo().syncDevices.listByOwner(c.get("auth").userId as UserId)
    return syncJson({ devices: devices.map(publicDevice) })
  } catch (error) { return syncFailure(error) }
})

syncDevicesRouter.post("/devices", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const url = new URL(c.req.url)
    // Behind a TLS-terminating proxy the original scheme must be preserved, or the document would name a dead origin.
    if (url.protocol !== "https:") throw new SyncError("https_required", 400)
    const body = await parseBody(c.req.raw, createBody)
    const ids = await selection(ownerId, body.upstreamIds)
    const secret = `sds_${randomHex(32)}`
    const device: SyncDeviceRecord = {
      id: `sdv_${randomHex(16)}`, ownerId, label: body.label, secretHash: await sha256Hex(secret), upstreamIds: ids,
      createdAt: new Date().toISOString(), lastSyncAt: null,
    }
    if (!(await getRepo().syncDevices.createWithinLimit(device, SYNC_MAX_DEVICES_PER_OWNER))) throw new SyncError("device_limit", 409)
    return syncJson({ device: publicDevice(device), document: syncDocument(url.origin, device.id, secret) }, 201)
  } catch (error) { return syncFailure(error) }
})

syncDevicesRouter.patch("/devices/:id", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const existing = await ownedDevice(ownerId, c.req.param("id"))
    const body = await parseBody(c.req.raw, patchBody)
    const ids = body.upstreamIds === undefined ? undefined : await selection(ownerId, body.upstreamIds)
    const updated = await getRepo().syncDevices.update(existing.id, ownerId, { label: body.label, upstreamIds: ids })
    if (!updated) throw new SyncError("device_not_found", 404)
    return syncJson({ device: publicDevice(updated) })
  } catch (error) { return syncFailure(error) }
})

syncDevicesRouter.delete("/devices/:id", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const existing = await ownedDevice(ownerId, c.req.param("id"))
    if (!(await getRepo().syncDevices.delete(existing.id, ownerId))) throw new SyncError("device_not_found", 404)
    return syncJson({ devices: (await getRepo().syncDevices.listByOwner(ownerId)).map(publicDevice) })
  } catch (error) { return syncFailure(error) }
})
```

Create `packages/gateway/src/control-plane/sync/routes.ts` (Task 9 adds the device-source router here):

```ts
import { Hono } from "hono"
import type { Env } from "../../app"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { requireBrowserSession } from "../shared/session-guard"
import { syncDevicesRouter } from "./devices"

export const syncManagementRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()
syncManagementRouter.use("*", requireBrowserSession)
syncManagementRouter.route("/", syncDevicesRouter)
```

In `packages/gateway/src/control-plane/routes.ts` add `import { syncManagementRouter } from './sync/routes.ts'` after line 35 and, after line 40 (`controlPlane.route('/api/loki', lokiManagementRouter)`):

```ts
controlPlane.route('/api/sync', syncManagementRouter)
```

- [ ] **Step 6: Run the tests and typecheck**

```bash
bun test ./packages/gateway/tests/sync-devices.sqlite.test.ts ./packages/gateway/tests/control-plane-loki.sqlite.test.ts ./packages/gateway/tests/control-plane-scaffold.test.ts
bun run --filter '@vibe-llm/gateway' typecheck
```

Expected: PASS (the Loki "cross-origin cookie requests" test proves the guard move kept its behavior) and a clean typecheck.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/sync/protocol.ts packages/gateway/src/control-plane/shared/session-guard.ts \
  packages/gateway/src/control-plane/sync/common.ts packages/gateway/src/control-plane/sync/devices.ts \
  packages/gateway/src/control-plane/sync/routes.ts packages/gateway/src/control-plane/loki/routes.ts \
  packages/gateway/src/control-plane/routes.ts packages/gateway/tests/sync-devices.sqlite.test.ts
git commit -F - <<'EOF'
feat(vnext/gateway): manage sync devices on the central gateway

Owner-only issue, edit and revoke, behind a shared real-session guard.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 5: Central snapshot endpoint

`GET /api/sync/snapshot` is mounted before session auth (next to `/api/loki/sync/:id`, `packages/gateway/src/app.ts` line 89) and authenticates only with a device secret. `sessionAuthMiddleware` already turns away `lks_` keys (`session-auth.ts` lines 54-56); `sds_` gets the same treatment so a device secret is never mistaken for an inference or session credential elsewhere.

**Files:**
- Modify: `packages/gateway/src/sync/protocol.ts` (add `SyncedUpstream`, `SyncSnapshot`)
- Create: `packages/gateway/src/control-plane/sync/snapshot.ts`
- Modify: `packages/gateway/src/app.ts` (import near line 13, mount after line 89), `packages/gateway/src/control-plane/auth/session-auth.ts` (after line 56)
- Test: `packages/gateway/tests/sync-snapshot.sqlite.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/tests/sync-snapshot.sqlite.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { app as gateway } from "../src/app"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { syncManagementRouter } from "../src/control-plane/sync/routes"
import { syncSnapshotRouter } from "../src/control-plane/sync/snapshot"
import type { SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids"

const owner = "snap-owner" as UserId
const other = "snap-other" as UserId
const token = "ses_snap_owner"
const stamp = "2026-11-16T00:00:00.000Z"
const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const credential = { accessToken: "central-token", tokenType: "Bearer", expiresAt: 4_102_444_800_000, account }
let db: Database
let repo: BunSqliteRepo
let app: Hono

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const seed = (id: string, ownerId: UserId, provider: "copilot" | "loki" | "custom", over: Record<string, unknown> = {}) => repo.upstreams.save({
  id, ownerId, provider, name: id, enabled: true, sortOrder: 0, config: {}, flagOverrides: {}, disabledPublicModelIds: [], state: null,
  proxyFallbackList: [], createdAt: stamp, updatedAt: stamp, ...over,
})

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  await repo.sessions.create({ token: token as SessionToken, userId: owner, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  await seed("up_loki_a", owner, "loki", {
    enabled: false, sortOrder: 1, config: { profileId: "loki-df-v1" }, proxyFallbackList: [{ id: "trojan" }],
    state: { version: 1, profileId: "loki-df-v1", generation: "g", syncSecretHash: "pairing-hash", revision: 2, assistantStatus: "authorized",
      account, credential, lastReceipt: { requestId: "request-one", payloadHash: "payload-hash" } },
  })
  await seed("up_copilot_a", owner, "copilot", {
    sortOrder: 2, config: { githubToken: "ghp_central", accountType: "individual", user: { id: 1, login: "octo" } },
    flagOverrides: { f: true }, disabledPublicModelIds: ["m1"], proxyFallbackList: [{ id: "trojan" }],
    state: { copilotApiEndpoint: "https://api.githubcopilot.com" },
  })
  await seed("up_custom_a", owner, "custom")
  await seed("up_copilot_x", other, "copilot")
  app = new Hono()
  app.route("/api/sync", syncSnapshotRouter)
  app.use("*", sessionAuthMiddleware)
  app.route("/api/sync", syncManagementRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

async function issue(upstreamIds = ["up_copilot_a", "up_loki_a"]) {
  const response = await app.request("https://central.example/api/sync/devices", { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ label: "MacBook", upstreamIds }) })
  expect(response.status).toBe(201)
  const { document } = await response.json() as { document: { deviceId: string; deviceSecret: string } }
  return { id: document.deviceId, secret: document.deviceSecret }
}
const snapshot = (secret: string, headers: Record<string, string> = {}) =>
  app.request("https://central.example/api/sync/snapshot", { headers: { authorization: `Bearer ${secret}`, ...headers } })

test("a snapshot carries only the selected, owned, syncable upstreams in sort order through each provider's sync view", async () => {
  const device = await issue()
  db.run("UPDATE sync_devices SET upstream_ids_json = ? WHERE id = ?",
    [JSON.stringify(["up_copilot_a", "up_loki_a", "up_custom_a", "up_copilot_x", "missing"]), device.id])
  const response = await snapshot(device.secret)
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(response.headers.get("content-type")).toBe("application/json")
  const text = await response.text()
  expect(JSON.parse(text)).toEqual({ version: 1, deviceId: device.id, upstreams: [
    { id: "up_loki_a", provider: "loki", name: "up_loki_a", config: { profileId: "loki-df-v1" },
      state: { version: 1, profileId: "loki-df-v1", generation: "g", revision: 2, assistantStatus: "authorized", account, credential },
      flagOverrides: {}, disabledPublicModelIds: [] },
    { id: "up_copilot_a", provider: "copilot", name: "up_copilot_a",
      config: { githubToken: "ghp_central", accountType: "individual", user: { id: 1, login: "octo" } },
      state: { copilotApiEndpoint: "https://api.githubcopilot.com" }, flagOverrides: { f: true }, disabledPublicModelIds: ["m1"] },
  ] })
  for (const forbidden of ["pairing-hash", "payload-hash", "lastReceipt", "syncSecretHash", "trojan", "proxyFallbackList", "ownerId", "enabled", "up_custom_a", "up_copilot_x"]) {
    expect(text).not.toContain(forbidden)
  }
})

test("the ETag is the quoted SHA-256 of the body, an equal If-None-Match gets an empty 304, and a change gets a new body", async () => {
  const device = await issue()
  const first = await snapshot(device.secret)
  const body = await first.text()
  const etag = `"${sha256(body)}"`
  expect(first.headers.get("etag")).toBe(etag)
  for (const header of [etag, `W/${etag}`, `"other", ${etag}`]) {
    const cached = await snapshot(device.secret, { "if-none-match": header })
    expect([cached.status, await cached.text()]).toEqual([304, ""])
    expect(cached.headers.get("etag")).toBe(etag)
    expect(cached.headers.get("cache-control")).toBe("no-store")
  }
  const stale = await snapshot(device.secret, { "if-none-match": '"0000"' })
  expect(stale.status).toBe(200)
  const stored = (await repo.upstreams.getById("up_copilot_a" as UpstreamId))!
  await repo.upstreams.patchMetadata(stored, current => ({ ...current, name: "Renamed" }))
  const changed = await snapshot(device.secret, { "if-none-match": etag })
  expect(changed.status).toBe(200)
  expect(changed.headers.get("etag")).not.toBe(etag)
  expect(await changed.text()).toContain("Renamed")
})

test("every authentication failure answers the same 401", async () => {
  const device = await issue()
  const ghostSecret = `sds_${"2".repeat(64)}`
  await repo.syncDevices.createWithinLimit({ id: `sdv_${"a".repeat(32)}`, ownerId: "ghost-owner" as UserId, label: "Orphan",
    secretHash: sha256(ghostSecret), upstreamIds: [], createdAt: stamp, lastSyncAt: null }, 16)
  const unknown = `sds_${"1".repeat(64)}`
  const requests: Array<Record<string, string>> = [
    {}, { authorization: "Basic abc" }, { authorization: `Bearer lks_${"1".repeat(64)}` }, { authorization: `Bearer sds_${"1".repeat(63)}` },
    { authorization: `Bearer ${unknown}` }, { authorization: `Bearer ${device.secret.toUpperCase()}` }, { authorization: `Bearer ${ghostSecret}` },
  ]
  const failures: Response[] = []
  for (const headers of requests) failures.push(await app.request("https://central.example/api/sync/snapshot", { headers }))
  await repo.users.update(owner, { disabled: true })
  failures.push(await snapshot(device.secret))
  for (const response of failures) {
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({ error: { code: "invalid_device" } })
  }
})

test("last sync is stamped at most once per ten minutes and a failed stamp does not affect the response", async () => {
  const device = await issue()
  await snapshot(device.secret)
  const first = (await repo.syncDevices.getById(device.id))!.lastSyncAt
  expect(Date.now() - Date.parse(first!)).toBeLessThan(5_000)
  const recent = new Date(Date.now() - 60_000).toISOString()
  db.run("UPDATE sync_devices SET last_sync_at = ? WHERE id = ?", [recent, device.id])
  await snapshot(device.secret)
  expect((await repo.syncDevices.getById(device.id))!.lastSyncAt).toBe(recent)
  db.run("UPDATE sync_devices SET last_sync_at = ? WHERE id = ?", [new Date(Date.now() - 11 * 60_000).toISOString(), device.id])
  await snapshot(device.secret)
  expect(Date.parse((await repo.syncDevices.getById(device.id))!.lastSyncAt!)).toBeGreaterThan(Date.now() - 5_000)
  repo.syncDevices.touchLastSync = async () => { throw new Error("storage down") }
  expect((await snapshot(device.secret)).status).toBe(200)
})

test("deleted, transferred and unsyncable upstreams drop out, and an upstream whose sync view throws is omitted", async () => {
  const device = await issue()
  const ids = async () => ((await (await snapshot(device.secret)).json()) as { upstreams: Array<{ id: string }> }).upstreams.map(u => u.id)
  expect(await ids()).toEqual(["up_loki_a", "up_copilot_a"])
  db.run("UPDATE upstreams SET state_json = '{\"broken\":true}' WHERE id = 'up_loki_a'")
  expect(await ids()).toEqual(["up_copilot_a"])
  const copilot = (await repo.upstreams.getById("up_copilot_a" as UpstreamId))!
  await repo.upstreams.patchMetadata(copilot, current => ({ ...current, ownerId: other }))
  expect(await ids()).toEqual([])
  await repo.upstreams.delete("up_copilot_a" as UpstreamId)
  expect(await ids()).toEqual([])
})

test("the full gateway serves the snapshot without a session and refuses a device secret anywhere else", async () => {
  const device = await issue()
  const served = await gateway.request("https://central.example/api/sync/snapshot", { headers: { authorization: `Bearer ${device.secret}` } })
  expect(served.status).toBe(200)
  const elsewhere = await gateway.request("https://central.example/v1/models", { headers: { authorization: `Bearer ${device.secret}` } })
  expect(elsewhere.status).toBe(401)
  expect(await elsewhere.json()).toEqual({ error: { code: "invalid_device" } })
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `bun test ./packages/gateway/tests/sync-snapshot.sqlite.test.ts`

Expected: FAIL: cannot resolve `../src/control-plane/sync/snapshot`.

- [ ] **Step 3: Snapshot types**

Append to `packages/gateway/src/sync/protocol.ts`:

```ts

/** One upstream as it travels. `config` and `state` are the provider's `syncView` output. */
export interface SyncedUpstream {
  id: string
  provider: string
  name: string
  config: Record<string, unknown>
  state: unknown
  flagOverrides: Record<string, boolean>
  disabledPublicModelIds: string[]
}

export interface SyncSnapshot {
  version: typeof SYNC_VERSION
  deviceId: string
  upstreams: SyncedUpstream[]
}
```

- [ ] **Step 4: The endpoint**

Create `packages/gateway/src/control-plane/sync/snapshot.ts`:

```ts
import { Hono } from "hono"
import type { Env } from "../../app"
import { providerPlugin } from "../../data-plane/providers/registry"
import { getRepo } from "../../repo"
import type { UpstreamId } from "../../repo/branded-ids"
import type { StoredUpstreamRecord } from "../../repo/types"
import { SYNC_LAST_SYNC_STAMP_MS, SYNC_VERSION, type SyncedUpstream } from "../../sync/protocol"
import { SyncError, sha256Hex, syncFailure } from "./common"

/** Mounted before session auth: the device secret is the only credential this route knows. */
export const syncSnapshotRouter = new Hono<{ Bindings: Env }>()

const invalidDevice = () => new SyncError("invalid_device", 401)

/** What one upstream contributes, or null when it must not leave this gateway. A throwing sync view omits the upstream. */
function entry(row: StoredUpstreamRecord): SyncedUpstream | null {
  const plugin = providerPlugin(row.provider)
  if (!plugin?.syncable) return null
  try {
    const view = plugin.syncView ? plugin.syncView(row) : { config: row.config, state: row.state }
    return { id: row.id, provider: row.provider, name: row.name, config: view.config, state: view.state ?? null,
      flagOverrides: row.flagOverrides, disabledPublicModelIds: row.disabledPublicModelIds }
  } catch { return null }
}

const matches = (header: string | undefined, etag: string) =>
  header !== undefined && header.split(",").some(value => { const candidate = value.trim(); return candidate === etag || candidate === `W/${etag}` })

syncSnapshotRouter.get("/snapshot", async c => {
  try {
    const secret = /^Bearer (sds_[a-f0-9]{64})$/.exec(c.req.header("authorization") ?? "")?.[1]
    if (!secret) throw invalidDevice()
    const repo = getRepo()
    const device = await repo.syncDevices.findBySecretHash(await sha256Hex(secret))
    if (!device) throw invalidDevice()
    const owner = await repo.users.getById(device.ownerId)
    if (!owner || owner.disabled) throw invalidDevice()

    // Stale ids are ignored; the central `enabled` flag does not filter (enabled is device-local).
    const rows: StoredUpstreamRecord[] = []
    for (const id of device.upstreamIds) {
      const row = await repo.upstreams.getById(id as UpstreamId)
      if (row && row.ownerId === device.ownerId) rows.push(row)
    }
    rows.sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    const upstreams = rows.flatMap(row => { const item = entry(row); return item ? [item] : [] })
    const body = JSON.stringify({ version: SYNC_VERSION, deviceId: device.id, upstreams })
    const etag = `"${await sha256Hex(body)}"`

    const now = Date.now()
    await repo.syncDevices.touchLastSync(device.id, new Date(now).toISOString(), new Date(now - SYNC_LAST_SYNC_STAMP_MS).toISOString())
      .catch(() => { /* Advisory: a failed stamp never affects the response. */ })
    if (matches(c.req.header("if-none-match"), etag)) return new Response(null, { status: 304, headers: { etag, "cache-control": "no-store" } })
    return new Response(body, { status: 200, headers: { "content-type": "application/json", etag, "cache-control": "no-store" } })
  } catch (error) { return syncFailure(error) }
})
```

In `packages/gateway/src/app.ts` add `import { syncSnapshotRouter } from './control-plane/sync/snapshot.ts'` after the `lokiSyncRouter` import (line 13) and mount it after `app.route('/api/loki', lokiSyncRouter)` (line 89):

```ts
app.route('/api/sync', syncSnapshotRouter)
```

In `packages/gateway/src/control-plane/auth/session-auth.ts`, after the `lks_` rejection block (lines 54-56) add:

```ts
  // Device sync secrets are accepted only by the snapshot endpoint, which is mounted before this middleware.
  if (key?.startsWith('sds_')) {
    return c.json({ error: { code: 'invalid_device' } }, 401, { 'Cache-Control': 'no-store' })
  }
```

The access log in `app.ts` (lines 34-41) records only method, path, status and duration; headers and bodies are never logged, so no change is needed there.

- [ ] **Step 5: Run the tests and typecheck**

```bash
bun test ./packages/gateway/tests/sync-snapshot.sqlite.test.ts ./packages/gateway/tests/sync-devices.sqlite.test.ts ./packages/gateway/tests/control-plane-loki.sqlite.test.ts ./packages/gateway/tests/session-auth-prewarm.test.ts
bun run --filter '@vibe-llm/gateway' typecheck
```

Expected: PASS and a clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/sync/protocol.ts packages/gateway/src/control-plane/sync/snapshot.ts \
  packages/gateway/src/app.ts packages/gateway/src/control-plane/auth/session-auth.ts packages/gateway/tests/sync-snapshot.sqlite.test.ts
git commit -F - <<'EOF'
feat(vnext/gateway): serve selected upstream snapshots to devices

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 6: Sync document parsing and the device fetch client

**Files:**
- Modify: `packages/gateway/src/sync/protocol.ts` (constants, parsing, error type)
- Create: `packages/gateway/src/sync/fetch.ts`
- Test: `packages/gateway/tests/sync-protocol.test.ts`, `packages/gateway/tests/sync-fetch.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/tests/sync-protocol.test.ts`:

```ts
import { expect, test } from "bun:test"
import { SyncDocumentError, normalizeHttpsOrigin, parseSyncDocument, parseSyncSnapshot, syncDocument } from "../src/sync/protocol"

const deviceId = `sdv_${"1".repeat(32)}`
const secret = `sds_${"2".repeat(64)}`
const doc = (over: Record<string, unknown> = {}) => ({ ...syncDocument("https://central.example", deviceId, secret), ...over })

test("a sync document round-trips and normalizes its origin", () => {
  expect(parseSyncDocument(doc())).toEqual(syncDocument("https://central.example", deviceId, secret))
  expect(parseSyncDocument(doc({ gatewayOrigin: "https://CENTRAL.example/" })).gatewayOrigin).toBe("https://central.example")
  expect(parseSyncDocument(doc({ gatewayOrigin: "https://central.example:8443" })).gatewayOrigin).toBe("https://central.example:8443")
})

test("documents reject unknown fields, wrong kinds and malformed identifiers", () => {
  const bad: unknown[] = [
    null, [], "text", doc({ extra: 1 }), doc({ version: 2 }), doc({ kind: "loki-mirror" }), doc({ deviceId: "sdv_short" }),
    doc({ deviceId: `sdv_${"G".repeat(32)}` }), doc({ deviceSecret: `lks_${"2".repeat(64)}` }), doc({ deviceSecret: `sds_${"2".repeat(63)}` }),
    doc({ deviceSecret: `sds_${"A".repeat(64)}` }), (() => { const { deviceSecret: _drop, ...rest } = doc(); return rest })(),
  ]
  for (const value of bad) expect(() => parseSyncDocument(value)).toThrow(SyncDocumentError)
})

test("origins must be bare HTTPS origins", () => {
  for (const origin of ["http://central.example", "https://u:p@central.example", "https://central.example/path", "https://central.example/?q=1",
    "https://central.example#f", "https://central.example?x", "not a url", "", " https://central.example", "https://central.example\\x", 7]) {
    expect(normalizeHttpsOrigin(origin)).toBeNull()
    expect(() => parseSyncDocument(doc({ gatewayOrigin: origin }))).toThrow(SyncDocumentError)
  }
})

const entry = (over: Record<string, unknown> = {}) => ({ id: "up_copilot_a", provider: "copilot", name: "Copilot", config: { githubToken: "t" },
  state: null, flagOverrides: { f: true }, disabledPublicModelIds: ["m"], ...over })
const body = (upstreams: unknown[], over: Record<string, unknown> = {}) => JSON.stringify({ version: 1, deviceId, upstreams, ...over })

test("snapshots parse known fields strictly and ignore unknown ones", () => {
  const parsed = parseSyncSnapshot(body([entry(), entry({ id: "up_loki_b", provider: "loki", state: { a: 1 }, future: "ignored" })]), deviceId)
  expect(parsed.upstreams.map(u => u.id)).toEqual(["up_copilot_a", "up_loki_b"])
  expect(parsed.upstreams[1]).toEqual({ id: "up_loki_b", provider: "loki", name: "Copilot", config: { githubToken: "t" },
    state: { a: 1 }, flagOverrides: { f: true }, disabledPublicModelIds: ["m"] })
  expect(parseSyncSnapshot(body([{ ...entry(), state: undefined }]), deviceId).upstreams[0]!.state).toBeNull()
  expect(parseSyncSnapshot(body([]), deviceId).upstreams).toEqual([])
})

test("malformed snapshots are rejected", () => {
  const cases = [
    "not json", "[]", body([], { version: 2 }), body([], { deviceId: `sdv_${"9".repeat(32)}` }), body([entry(), entry()]),
    body([entry({ id: "bad id" })]), body([entry({ id: 5 })]), body([entry({ provider: "Bad Provider" })]), body([entry({ name: "" })]),
    body([entry({ config: [] })]), body([entry({ flagOverrides: { f: "yes" } })]), body([entry({ flagOverrides: [] })]),
    body([entry({ disabledPublicModelIds: [1] })]), body(["x"]), body(Array.from({ length: 257 }, (_, n) => entry({ id: `up_${n}` }))),
  ]
  for (const text of cases) expect(() => parseSyncSnapshot(text, deviceId)).toThrow(SyncDocumentError)
})
```

Create `packages/gateway/tests/sync-fetch.test.ts`:

```ts
import { expect, test } from "bun:test"
import { fetchSnapshot } from "../src/sync/fetch"

const source = { origin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`, secret: `sds_${"2".repeat(64)}` }
const body = JSON.stringify({ version: 1, deviceId: source.deviceId, upstreams: [{ id: "up_a", provider: "copilot", name: "A",
  config: { githubToken: "t" }, state: null, flagOverrides: {}, disabledPublicModelIds: [] }] })
const sha256 = (value: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

function recording(response: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  return { calls, fetcher: async (url: string, init: RequestInit) => { calls.push({ url, init }); return response() } }
}

test("a 200 is parsed, hashed locally into the ETag, and fetched directly without redirects", async () => {
  const { calls, fetcher } = recording(() => new Response(body, { status: 200, headers: { etag: '"server-says-otherwise"' } }))
  const result = await fetchSnapshot({ ...source, etag: null }, fetcher)
  expect(result).toMatchObject({ kind: "changed", etag: `"${sha256(body)}"` })
  if (result.kind === "changed") expect(result.snapshot.upstreams.map(u => u.id)).toEqual(["up_a"])
  const { url, init } = calls[0]!
  expect(url).toBe("https://central.example/api/sync/snapshot")
  expect(init.method).toBe("GET")
  expect(init.redirect).toBe("manual")
  expect(init.signal).toBeInstanceOf(AbortSignal)
  const headers = new Headers(init.headers)
  expect(headers.get("authorization")).toBe(`Bearer ${source.secret}`)
  expect(headers.has("if-none-match")).toBe(false)
})

test("the stored ETag is sent as If-None-Match and a 304 means nothing changed", async () => {
  const { calls, fetcher } = recording(() => new Response(null, { status: 304 }))
  expect(await fetchSnapshot({ ...source, etag: '"abc"' }, fetcher)).toEqual({ kind: "not_modified" })
  expect(new Headers(calls[0]!.init.headers).get("if-none-match")).toBe('"abc"')
  const withoutEtag = recording(() => new Response(null, { status: 304 }))
  expect(await fetchSnapshot({ ...source, etag: null }, withoutEtag.fetcher)).toEqual({ kind: "failed", code: "bad_response" })
})

test("status codes map to outcomes", async () => {
  const cases: Array<[number, unknown]> = [
    [401, { kind: "revoked" }], [302, { kind: "failed", code: "http_error" }], [403, { kind: "failed", code: "http_error" }],
    [404, { kind: "failed", code: "http_error" }], [500, { kind: "failed", code: "http_error" }], [503, { kind: "failed", code: "http_error" }],
  ]
  for (const [status, expected] of cases) {
    expect(await fetchSnapshot({ ...source, etag: null }, async () => new Response("x", { status }))).toEqual(expected)
  }
  expect(await fetchSnapshot({ ...source, etag: null }, async () => { throw new Error("network down") })).toEqual({ kind: "failed", code: "unreachable" })
})

test("malformed, mismatched and oversized bodies are bad responses", async () => {
  const bad = { kind: "failed", code: "bad_response" }
  const respond = (make: () => Response) => fetchSnapshot({ ...source, etag: null }, async () => make())
  expect(await respond(() => new Response("not json"))).toEqual(bad)
  expect(await respond(() => new Response(body.replace(source.deviceId, `sdv_${"9".repeat(32)}`)))).toEqual(bad)
  expect(await respond(() => new Response(new Uint8Array([0xff, 0xfe, 0xfd])))).toEqual(bad)
  expect(await respond(() => new Response("x", { headers: { "content-length": String(1_048_577) } }))).toEqual(bad)

  let cancelled = false
  const endless = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(65_536)) }, cancel() { cancelled = true } })
  expect(await respond(() => new Response(endless))).toEqual(bad)
  expect(cancelled).toBe(true)
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test ./packages/gateway/tests/sync-protocol.test.ts ./packages/gateway/tests/sync-fetch.test.ts`

Expected: FAIL: `SyncDocumentError`, `normalizeHttpsOrigin`, `parseSyncDocument`, `parseSyncSnapshot` and `../src/sync/fetch` do not exist.

- [ ] **Step 3: Parsing**

Append to `packages/gateway/src/sync/protocol.ts`:

```ts

export const SYNC_INTERVAL_MS = 60_000
export const SYNC_FETCH_TIMEOUT_MS = 15_000
export const SYNC_MAX_SNAPSHOT_BYTES = 1_048_576

/** Fixed codes stored in `sync_sources.last_error`. */
export type SyncErrorCode = "unreachable" | "http_error" | "bad_response" | "id_conflict" | "unsupported_provider" | "apply_failed"

export class SyncDocumentError extends Error {
  constructor(message = "invalid_sync_document") { super(message) }
}

/** A bare HTTPS origin normalized to `URL.origin`; null for userinfo, a path beyond "/", a query, a fragment or anything unparsable. */
export function normalizeHttpsOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || /[?#\s\\]/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" ? url.origin : null
  } catch { return null }
}

const DOCUMENT_KEYS = ["version", "kind", "gatewayOrigin", "deviceId", "deviceSecret"]

/** Strict: unknown fields, a wrong kind or malformed identifiers throw `SyncDocumentError`. */
export function parseSyncDocument(value: unknown): SyncDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyncDocumentError()
  const doc = value as Record<string, unknown>
  const origin = normalizeHttpsOrigin(doc.gatewayOrigin)
  if (Object.keys(doc).some(key => !DOCUMENT_KEYS.includes(key)) || doc.version !== SYNC_VERSION || doc.kind !== "gateway-sync" || !origin
    || typeof doc.deviceId !== "string" || !SYNC_DEVICE_ID_PATTERN.test(doc.deviceId)
    || typeof doc.deviceSecret !== "string" || !SYNC_DEVICE_SECRET_PATTERN.test(doc.deviceSecret)) throw new SyncDocumentError()
  return syncDocument(origin, doc.deviceId, doc.deviceSecret)
}

const UPSTREAM_ID_PATTERN = /^[a-zA-Z0-9_-]{1,256}$/
const PROVIDER_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null

/**
 * Known fields must validate; unknown fields on an entry are ignored so an older device keeps working against a newer
 * central. Throws `SyncDocumentError("bad_snapshot")`.
 */
export function parseSyncSnapshot(text: string, deviceId: string): SyncSnapshot {
  const bad = () => new SyncDocumentError("bad_snapshot")
  let raw: unknown
  try { raw = JSON.parse(text) } catch { throw bad() }
  const body = asRecord(raw)
  if (!body || body.version !== SYNC_VERSION || body.deviceId !== deviceId || !Array.isArray(body.upstreams)
    || body.upstreams.length > SYNC_MAX_DEVICE_UPSTREAMS) throw bad()
  const seen = new Set<string>()
  const upstreams = body.upstreams.map((item): SyncedUpstream => {
    const entry = asRecord(item)
    const config = asRecord(entry?.config)
    const flags = asRecord(entry?.flagOverrides)
    if (!entry || !config || !flags || typeof entry.id !== "string" || !UPSTREAM_ID_PATTERN.test(entry.id) || seen.has(entry.id)
      || typeof entry.provider !== "string" || !PROVIDER_PATTERN.test(entry.provider)
      || typeof entry.name !== "string" || entry.name.length === 0 || entry.name.length > 256
      || !Object.values(flags).every(flag => typeof flag === "boolean")
      || !Array.isArray(entry.disabledPublicModelIds) || !entry.disabledPublicModelIds.every(id => typeof id === "string")) throw bad()
    seen.add(entry.id)
    return { id: entry.id, provider: entry.provider, name: entry.name, config, state: entry.state ?? null,
      flagOverrides: flags as Record<string, boolean>, disabledPublicModelIds: entry.disabledPublicModelIds as string[] }
  })
  return { version: SYNC_VERSION, deviceId, upstreams }
}
```

- [ ] **Step 4: The fetch client**

Create `packages/gateway/src/sync/fetch.ts`:

```ts
import { directFetcher, type Fetcher } from "@vibe-core/upstream"
import { SYNC_FETCH_TIMEOUT_MS, SYNC_MAX_SNAPSHOT_BYTES, parseSyncSnapshot, type SyncSnapshot } from "./protocol"

export interface SnapshotSource {
  origin: string
  deviceId: string
  secret: string
  etag: string | null
}

export type SnapshotFetch =
  | { kind: "changed"; snapshot: SyncSnapshot; etag: string }
  | { kind: "not_modified" }
  | { kind: "revoked" }
  | { kind: "failed"; code: "unreachable" | "http_error" | "bad_response" }

/** Reads at most `max` bytes; cancels the stream and returns null when the body is larger. */
async function readBounded(response: Response, max: number): Promise<Uint8Array | null> {
  if (!response.body) return new Uint8Array(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) { await reader.cancel().catch(() => {}); return null }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

async function quotedSha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return `"${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}"`
}

/**
 * One poll of the central gateway. Direct fetch (never an upstream's proxy chain), no redirects, 15 s timeout, body capped
 * at 1 MiB while streaming. Never throws. The returned ETag is the hash of the bytes received, not the response header.
 */
export async function fetchSnapshot(source: SnapshotSource, fetcher: Fetcher = directFetcher): Promise<SnapshotFetch> {
  let response: Response
  try {
    response = await fetcher(`${source.origin}/api/sync/snapshot`, {
      method: "GET", redirect: "manual", signal: AbortSignal.timeout(SYNC_FETCH_TIMEOUT_MS),
      headers: { authorization: `Bearer ${source.secret}`, accept: "application/json", ...(source.etag ? { "if-none-match": source.etag } : {}) },
    })
  } catch { return { kind: "failed", code: "unreachable" } }
  const bad = { kind: "failed" as const, code: "bad_response" as const }
  try {
    const { status } = response
    if (status === 401) return { kind: "revoked" }
    if (status === 304) return source.etag ? { kind: "not_modified" } : bad
    if (status !== 200) return { kind: "failed", code: "http_error" }
    if (Number(response.headers.get("content-length") ?? 0) > SYNC_MAX_SNAPSHOT_BYTES) return bad
    const bytes = await readBounded(response, SYNC_MAX_SNAPSHOT_BYTES)
    if (!bytes) return bad
    const snapshot = parseSyncSnapshot(new TextDecoder("utf-8", { fatal: true }).decode(bytes), source.deviceId)
    return { kind: "changed", snapshot, etag: await quotedSha256(bytes) }
  } catch { return bad }
  finally { if (!response.bodyUsed) await response.body?.cancel().catch(() => {}) }
}
```

- [ ] **Step 5: Run the tests and typecheck**

```bash
bun test ./packages/gateway/tests/sync-protocol.test.ts ./packages/gateway/tests/sync-fetch.test.ts
bun run --filter '@vibe-llm/gateway' typecheck
```

Expected: PASS and a clean typecheck.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/sync/protocol.ts packages/gateway/src/sync/fetch.ts \
  packages/gateway/tests/sync-protocol.test.ts packages/gateway/tests/sync-fetch.test.ts
git commit -F - <<'EOF'
feat(vnext/gateway): parse sync documents and fetch snapshots on devices

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 7: Device apply pass

Pure orchestration over the repository methods from Task 3 (`applySynced`, `deleteSynced`), so the generation rule of decision D2 lives in one place (the SQL). The pass is idempotent: a failure midway leaves the ETag unstored (Task 8) and the next tick repeats it.

**Files:**
- Create: `packages/gateway/src/sync/apply.ts`
- Test: `packages/gateway/tests/sync-apply.sqlite.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/tests/sync-apply.sqlite.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { UpstreamId, UserId } from "../src/repo/branded-ids"
import type { SyncedUpstream } from "../src/sync/protocol"
import { applySnapshot } from "../src/sync/apply"

let db: Database
let repo: BunSqliteRepo
beforeEach(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterEach(() => db.close())

const stamp = "2026-11-16T00:00:00.000Z"
const source = { id: "ssrc_1", ownerId: "device-owner" as UserId }
const known = (provider: string) => provider === "copilot" || provider === "loki"
const entry = (id: string, over: Partial<SyncedUpstream> = {}): SyncedUpstream => ({
  id, provider: "copilot", name: id, config: { githubToken: `token-${id}` }, state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over,
})
const snapshot = (...upstreams: SyncedUpstream[]) => ({ version: 1 as const, deviceId: `sdv_${"1".repeat(32)}`, upstreams })
const apply = (...upstreams: SyncedUpstream[]) => applySnapshot(repo, source, snapshot(...upstreams), stamp, known)
const get = (id: string) => repo.upstreams.getById(id as UpstreamId)
const local = (id: string) => ({ id, ownerId: "device-owner", provider: "custom" as const, name: id, enabled: true, sortOrder: 0,
  config: {}, flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })

test("new upstreams are created enabled, in snapshot order after existing ones, with no proxies and the central id", async () => {
  await repo.upstreams.save({ ...local("up_local"), sortOrder: 3 })
  expect(await apply(entry("up_a"), entry("up_b"))).toEqual({ created: 2, updated: 0, unchanged: 0, skipped: [] })
  expect(await get("up_a")).toMatchObject({ syncSourceId: "ssrc_1", enabled: true, sortOrder: 4, proxyFallbackList: [], ownerId: "device-owner" })
  expect((await get("up_b"))?.sortOrder).toBe(5)
})

test("applying the same snapshot again changes nothing", async () => {
  await apply(entry("up_a"), entry("up_b"))
  const before = await repo.configurationRevision!()
  const stored = (await get("up_a"))!
  expect(await apply(entry("up_a"), entry("up_b"))).toEqual({ created: 0, updated: 0, unchanged: 2, skipped: [] })
  expect(await repo.configurationRevision!()).toBe(before)
  expect((await get("up_a"))?.updatedAt).toBe(stored.updatedAt)
})

test("central changes overwrite config, state and metadata while enabled, order and proxies stay device-local", async () => {
  await apply(entry("up_a"))
  const created = (await get("up_a"))!
  await repo.upstreams.patchMetadata(created, current => ({ ...current, enabled: false, sortOrder: 9, proxyFallbackList: [{ id: "proxy-a" }] }))
  const before = (await get("up_a"))!
  const result = await apply(entry("up_a", { name: "Renamed", config: { githubToken: "rotated" }, state: { copilotApiEndpoint: "https://e.example" },
    flagOverrides: { f: true }, disabledPublicModelIds: ["m"] }))
  expect(result.updated).toBe(1)
  const after = (await get("up_a"))!
  expect(after).toMatchObject({ name: "Renamed", config: { githubToken: "rotated" }, state: { copilotApiEndpoint: "https://e.example" },
    flagOverrides: { f: true }, disabledPublicModelIds: ["m"], enabled: false, sortOrder: 9, proxyFallbackList: [{ id: "proxy-a" }] })
  expect([after.catalogGeneration, after.credentialGeneration]).toEqual([before.catalogGeneration + 1, before.credentialGeneration + 1])
})

test("a Loki token rotation is a state-only change and does not advance generations", async () => {
  const state = (token: string) => ({ version: 1, profileId: "loki-df-v1", generation: "g", revision: 1, assistantStatus: "authorized", credential: { accessToken: token } })
  await apply(entry("up_loki", { provider: "loki", config: { profileId: "loki-df-v1" }, state: state("one") }))
  const before = (await get("up_loki"))!
  await apply(entry("up_loki", { provider: "loki", config: { profileId: "loki-df-v1" }, state: state("two") }))
  const after = (await get("up_loki"))!
  expect(after.state).toEqual(state("two"))
  expect([after.catalogGeneration, after.credentialGeneration]).toEqual([before.catalogGeneration, before.credentialGeneration])
})

test("a clashing local row is skipped and recorded while the rest of the snapshot applies", async () => {
  await repo.upstreams.save(local("up_clash"))
  const result = await apply(entry("up_clash"), entry("up_ok"))
  expect(result).toEqual({ created: 1, updated: 0, unchanged: 0, skipped: [{ id: "up_clash", code: "id_conflict" }] })
  expect(await get("up_clash")).toMatchObject({ provider: "custom", name: "up_clash" })
  expect((await get("up_clash"))?.syncSourceId).toBeUndefined()
  expect(await get("up_ok")).toMatchObject({ syncSourceId: "ssrc_1" })
})

test("a provider this gateway does not know is skipped and recorded", async () => {
  const result = await apply(entry("up_future", { provider: "future-provider" }), entry("up_ok"))
  expect(result.skipped).toEqual([{ id: "up_future", code: "unsupported_provider" }])
  expect(await get("up_future")).toBeNull()
  expect(await get("up_ok")).not.toBeNull()
})

test("rows absent from the snapshot are deleted, but only this source's", async () => {
  await apply(entry("up_a"), entry("up_b"))
  await repo.upstreams.applySynced("ssrc_other", { id: "up_foreign", ownerId: "device-owner", provider: "copilot", name: "F", config: {},
    state: null, flagOverrides: {}, disabledPublicModelIds: [] }, stamp)
  await repo.upstreams.save(local("up_local"))
  await apply(entry("up_b"))
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()).toEqual(["up_b", "up_foreign", "up_local"])
  await apply()
  expect((await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()).toEqual(["up_foreign", "up_local"])
})

test("a synced row whose provider turns unknown is not kept", async () => {
  await apply(entry("up_a"))
  await apply(entry("up_a", { provider: "future-provider" }))
  expect(await get("up_a")).toBeNull()
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `bun test ./packages/gateway/tests/sync-apply.sqlite.test.ts`

Expected: FAIL: cannot resolve `../src/sync/apply`.

- [ ] **Step 3: Implement the apply pass**

Create `packages/gateway/src/sync/apply.ts`:

```ts
import type { UpstreamKind } from "@vibe-llm/protocols/common"
import type { SyncSourceRecord } from "../repo/sync"
import type { Repo } from "../repo/types"
import type { SyncSnapshot } from "./protocol"

export interface ApplyResult {
  created: number
  updated: number
  unchanged: number
  /** Entries left alone; the caller records the first code and withholds the ETag so they are retried. */
  skipped: Array<{ id: string; code: "id_conflict" | "unsupported_provider" }>
}

/**
 * One pass over a snapshot:
 * - same id owned by this source: overwritten (enabled, order and proxies stay), generations advance on a config change;
 * - no row: created enabled, sorted last, without proxies, tagged with the source;
 * - a row this source does not own: skipped (`id_conflict`); a provider this gateway lacks: skipped (`unsupported_provider`);
 * - this source's rows absent from the snapshot: deleted.
 * Skipped entries are not "kept", so a synced row whose provider turned unknown is removed with the absent ones.
 */
export async function applySnapshot(
  repo: Pick<Repo, "upstreams">,
  source: Pick<SyncSourceRecord, "id" | "ownerId">,
  snapshot: SyncSnapshot,
  now: string,
  isKnownProvider: (provider: string) => boolean,
): Promise<ApplyResult> {
  const result: ApplyResult = { created: 0, updated: 0, unchanged: 0, skipped: [] }
  const keep: string[] = []
  for (const entry of snapshot.upstreams) {
    if (!isKnownProvider(entry.provider)) { result.skipped.push({ id: entry.id, code: "unsupported_provider" }); continue }
    const outcome = await repo.upstreams.applySynced(source.id, {
      id: entry.id, ownerId: source.ownerId, provider: entry.provider as UpstreamKind, name: entry.name, config: entry.config,
      state: entry.state, flagOverrides: entry.flagOverrides, disabledPublicModelIds: entry.disabledPublicModelIds,
    }, now)
    if (outcome === "conflict") { result.skipped.push({ id: entry.id, code: "id_conflict" }); continue }
    keep.push(entry.id)
    result[outcome]++
  }
  await repo.upstreams.deleteSynced(source.id, keep)
  return result
}
```

- [ ] **Step 4: Run the test and typecheck**

```bash
bun test ./packages/gateway/tests/sync-apply.sqlite.test.ts
bun run --filter '@vibe-llm/gateway' typecheck
```

Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/sync/apply.ts packages/gateway/tests/sync-apply.sqlite.test.ts
git commit -F - <<'EOF'
feat(vnext/gateway): apply sync snapshots on devices

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 8: Device engine, scheduler and import hook

The orchestration that Tasks 6 and 7 plug into: one in-process mutex (decision D14), the run loop, connect/replace/disconnect, a pure scheduler with injectable timers (decision D13), and a hook so a configuration import triggers an immediate sync.

Error and ETag rules implemented here (spec "Errors", decisions D4-D5):

| Fetch result | Effect |
| --- | --- |
| `304` | record attempt and success, clear `last_error` |
| network failure, timeout, redirect, other status, malformed body | keep the last applied snapshot, record `last_error` (`unreachable` / `http_error` / `bad_response`), retry next tick |
| `401` | delete every synced upstream of this source, `status = revoked`, clear the ETag, no more polling until a document is re-imported |
| `200` | apply; store the new ETag only when nothing was skipped; `last_error` = first skip code (`id_conflict` / `unsupported_provider`) or null; an apply exception records `apply_failed` and keeps the old ETag |

**Files:**
- Create: `packages/gateway/src/sync/engine.ts`, `scheduler.ts`, `hooks.ts`, `index.ts`
- Modify: `packages/gateway/package.json` (add the `./sync` export), `apps/platform-bun/src/server.ts` (after lines 3 and 26)
- Test: `packages/gateway/tests/sync-engine.sqlite.test.ts`, `packages/gateway/tests/sync-scheduler.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `packages/gateway/tests/sync-engine.sqlite.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { UpstreamId, UserId } from "../src/repo/branded-ids"
import { connectSource, disconnectSource, runScheduledSync, syncSource, withSyncLock, type SyncDeps } from "../src/sync/engine"
import { syncDocument, type SyncedUpstream } from "../src/sync/protocol"

let db: Database
let repo: BunSqliteRepo
let clock = Date.parse("2026-11-16T10:00:00.000Z")
beforeEach(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db); clock = Date.parse("2026-11-16T10:00:00.000Z") })
afterEach(() => db.close())

const deviceId = `sdv_${"1".repeat(32)}`
const secret = `sds_${"2".repeat(64)}`
const doc = syncDocument("https://central.example", deviceId, secret)
const owner = "device-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const entry = (id: string, over: Partial<SyncedUpstream> = {}): SyncedUpstream => ({
  id, provider: "copilot", name: id, config: { githubToken: `token-${id}` }, state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over,
})

/** A scripted central gateway. */
function central(entries: SyncedUpstream[] = [], forDevice = deviceId) {
  const script = { entries, mode: "ok" as "ok" | "revoked" | "down" | "error" | "garbage", calls: 0, sentEtags: [] as Array<string | null> }
  const fetcher = async (_url: string, init: RequestInit) => {
    script.calls++
    const sent = new Headers(init.headers).get("if-none-match")
    script.sentEtags.push(sent)
    if (script.mode === "down") throw new Error("network down")
    if (script.mode === "revoked") return new Response('{"error":{"code":"invalid_device"}}', { status: 401 })
    if (script.mode === "error") return new Response("boom", { status: 500 })
    if (script.mode === "garbage") return new Response("not json")
    const body = JSON.stringify({ version: 1, deviceId: forDevice, upstreams: script.entries })
    const etag = `"${sha256(body)}"`
    return sent === etag ? new Response(null, { status: 304 }) : new Response(body, { status: 200 })
  }
  return { script, fetcher }
}
const deps = (fetcher: SyncDeps["fetcher"]): SyncDeps => ({ repo, fetcher, now: () => clock, isKnownProvider: kind => kind === "copilot" || kind === "loki" })
const ids = async () => (await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()
const connect = (fetcher: SyncDeps["fetcher"], mode: "create" | "replace" = "create", document = doc) =>
  connectSource({ mode, ownerId: owner, document }, deps(fetcher))

test("connecting fetches first, stores the source for the connecting user and applies the snapshot", async () => {
  const { script, fetcher } = central([entry("up_a"), entry("up_b")])
  const outcome = await connect(fetcher)
  expect(outcome.kind).toBe("connected")
  expect(script.sentEtags).toEqual([null])
  const source = (await repo.syncSources.get())!
  expect(source).toMatchObject({ ownerId: owner, origin: "https://central.example", deviceId, secret, status: "active", lastError: null,
    lastSuccessAt: "2026-11-16T10:00:00.000Z" })
  expect(source.etag).toMatch(/^"[a-f0-9]{64}"$/)
  expect(await ids()).toEqual(["up_a", "up_b"])
  expect((await repo.upstreams.getById("up_a" as UpstreamId))).toMatchObject({ ownerId: owner, syncSourceId: source.id })
})

test("a revoked, unreachable or malformed central stores nothing, and an existing source is refused before any request", async () => {
  for (const [mode, expected] of [["revoked", "invalid_document"], ["down", "unreachable"], ["error", "unreachable"], ["garbage", "unreachable"]] as const) {
    const { script, fetcher } = central([entry("up_a")])
    script.mode = mode
    expect((await connect(fetcher)).kind).toBe(expected)
    expect(await repo.syncSources.get()).toBeNull()
    expect(await ids()).toEqual([])
  }
  const live = central([entry("up_a")])
  await connect(live.fetcher)
  const before = live.script.calls
  expect((await connect(live.fetcher)).kind).toBe("exists")
  expect(live.script.calls).toBe(before)
})

test("an unchanged central answers 304 and the sync only records the attempt", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  const etag = (await repo.syncSources.get())!.etag
  clock += 60_000
  expect(await syncSource(deps(fetcher))).toBe("not_modified")
  expect(script.sentEtags.at(-1)).toBe(etag)
  expect(await repo.syncSources.get()).toMatchObject({ etag, lastAttemptAt: "2026-11-16T10:01:00.000Z", lastSuccessAt: "2026-11-16T10:01:00.000Z", lastError: null })
})

test("a changed snapshot adds, updates and removes upstreams and stores the new ETag", async () => {
  const { script, fetcher } = central([entry("up_a"), entry("up_b")])
  await connect(fetcher)
  const firstEtag = (await repo.syncSources.get())!.etag
  script.entries = [entry("up_b", { name: "Renamed" }), entry("up_c")]
  expect(await syncSource(deps(fetcher))).toBe("applied")
  expect(await ids()).toEqual(["up_b", "up_c"])
  expect((await repo.upstreams.getById("up_b" as UpstreamId))?.name).toBe("Renamed")
  expect((await repo.syncSources.get())!.etag).not.toBe(firstEtag)
})

test("failures keep the last snapshot, record a fixed code and recover on the next tick", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  for (const [mode, code] of [["down", "unreachable"], ["error", "http_error"], ["garbage", "bad_response"]] as const) {
    script.mode = mode
    expect(await syncSource(deps(fetcher))).toBe("failed")
    expect(await repo.syncSources.get()).toMatchObject({ lastError: code, status: "active" })
    expect(await ids()).toEqual(["up_a"])
  }
  script.mode = "ok"
  expect(await syncSource(deps(fetcher))).toBe("not_modified")
  expect((await repo.syncSources.get())!.lastError).toBeNull()
})

test("a 401 removes the synced upstreams, marks the source revoked and stops polling until a document is re-imported", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  await repo.upstreams.save({ id: "up_local", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  script.mode = "revoked"
  expect(await syncSource(deps(fetcher))).toBe("revoked")
  expect(await ids()).toEqual(["up_local"])
  expect(await repo.syncSources.get()).toMatchObject({ status: "revoked", etag: null })
  const calls = script.calls
  expect(await syncSource(deps(fetcher))).toBe("idle")
  expect(script.calls).toBe(calls)
  script.mode = "ok"
  const replaced = await connect(fetcher, "replace")
  expect(replaced.kind).toBe("connected")
  expect(await repo.syncSources.get()).toMatchObject({ status: "active", lastError: null })
  expect(await ids()).toEqual(["up_a", "up_local"])
})

test("skipped entries are recorded and the ETag is withheld so they are retried", async () => {
  await repo.upstreams.save({ id: "up_clash", ownerId: owner, provider: "custom", name: "Clash", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const { script, fetcher } = central([entry("up_clash"), entry("up_future", { provider: "future" }), entry("up_ok")])
  await connect(fetcher)
  expect(await repo.syncSources.get()).toMatchObject({ lastError: "id_conflict", etag: null })
  expect(await ids()).toEqual(["up_clash", "up_ok"])
  expect(await syncSource(deps(fetcher))).toBe("applied")
  expect(script.sentEtags.at(-1)).toBeNull()
  await repo.upstreams.delete("up_clash" as UpstreamId)
  script.entries = [entry("up_clash"), entry("up_ok")]
  expect(await syncSource(deps(fetcher))).toBe("applied")
  expect(await repo.syncSources.get()).toMatchObject({ lastError: null })
  expect((await repo.syncSources.get())!.etag).not.toBeNull()
  expect(await ids()).toEqual(["up_clash", "up_ok"])
})

test("an apply failure keeps the old ETag, records apply_failed and the next tick retries", async () => {
  const { script, fetcher } = central([entry("up_a")])
  await connect(fetcher)
  const etag = (await repo.syncSources.get())!.etag
  script.entries = [entry("up_a"), entry("up_b")]
  const original = repo.upstreams.applySynced.bind(repo.upstreams)
  repo.upstreams.applySynced = async () => { throw new Error("storage down") }
  expect(await syncSource(deps(fetcher))).toBe("failed")
  expect(await repo.syncSources.get()).toMatchObject({ etag, lastError: "apply_failed" })
  repo.upstreams.applySynced = original
  expect(await syncSource(deps(fetcher))).toBe("applied")
  expect(await ids()).toEqual(["up_a", "up_b"])
})

test("replacing the document swaps the secret, prunes absent upstreams and keeps ownership; a failed replace changes nothing", async () => {
  const first = central([entry("up_a"), entry("up_b")])
  await connect(first.fetcher)
  const before = (await repo.syncSources.get())!
  const other = syncDocument("https://other.example", `sdv_${"3".repeat(32)}`, `sds_${"4".repeat(64)}`)
  const second = central([entry("up_b"), entry("up_z")], other.deviceId)
  const replace = () => connectSource({ mode: "replace", ownerId: "someone-else" as UserId, document: other }, deps(second.fetcher))
  for (const [mode, kind] of [["down", "unreachable"], ["revoked", "invalid_document"]] as const) {
    second.script.mode = mode
    expect((await replace()).kind).toBe(kind)
    expect(await repo.syncSources.get()).toEqual(before)
    expect(await ids()).toEqual(["up_a", "up_b"])
  }
  second.script.mode = "ok"
  expect((await replace()).kind).toBe("connected")
  expect(await repo.syncSources.get()).toMatchObject({ id: before.id, ownerId: owner, origin: "https://other.example",
    secret: other.deviceSecret, status: "active" })
  expect(await ids()).toEqual(["up_b", "up_z"])
})

test("replacing without a source is not found, and disconnecting deletes the source and every synced upstream", async () => {
  const { fetcher } = central([entry("up_a")])
  expect((await connect(fetcher, "replace")).kind).toBe("not_found")
  expect(await disconnectSource(deps(fetcher))).toBe(false)
  await connect(fetcher)
  await repo.upstreams.save({ id: "up_local", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  expect(await disconnectSource(deps(fetcher))).toBe(true)
  expect(await repo.syncSources.get()).toBeNull()
  expect(await ids()).toEqual(["up_local"])
})

test("one sync runs at a time: a scheduled tick skips while a connect holds the lock", async () => {
  const live = central([entry("up_a")])
  await connect(live.fetcher)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const slow = withSyncLock(async () => { await gate; return "done" })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(await runScheduledSync(deps(live.fetcher))).toBe("busy")
  release()
  expect(await slow).toBe("done")
  expect(await runScheduledSync(deps(live.fetcher))).toBe("not_modified")
})
```

Create `packages/gateway/tests/sync-scheduler.test.ts`:

```ts
import { expect, test } from "bun:test"
import { notifyConfigurationImported } from "../src/sync/hooks"
import { startDeviceSync } from "../src/sync"
import { createDeviceSyncScheduler } from "../src/sync/scheduler"

function fakeTimers() {
  const handlers = new Map<number, () => void>()
  let next = 1
  return {
    handlers,
    setInterval: (handler: () => void) => { handlers.set(next, handler); return next++ },
    clearInterval: (handle: unknown) => { handlers.delete(handle as number) },
    tick: () => { for (const handler of [...handlers.values()]) handler() },
  }
}
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

test("start syncs once immediately, then on every tick, never overlapping; stop is idempotent", async () => {
  const timers = fakeTimers()
  let runs = 0
  let finish!: () => void
  const scheduler = createDeviceSyncScheduler({ intervalMs: 60_000, setInterval: timers.setInterval, clearInterval: timers.clearInterval,
    run: () => { runs++; return new Promise<void>(resolve => { finish = resolve }) } })
  scheduler.start()
  scheduler.start()
  await flush()
  expect([runs, timers.handlers.size]).toEqual([1, 1])
  timers.tick()
  await flush()
  expect(runs).toBe(1)
  finish()
  await flush()
  timers.tick()
  await flush()
  expect(runs).toBe(2)
  scheduler.stop()
  scheduler.stop()
  expect(timers.handlers.size).toBe(0)
  finish()
})

test("a failing run is swallowed and the next tick still runs", async () => {
  const timers = fakeTimers()
  let runs = 0
  const warn = console.warn
  console.warn = () => {}
  try {
    const scheduler = createDeviceSyncScheduler({ setInterval: timers.setInterval, clearInterval: timers.clearInterval,
      run: async () => { runs++; throw new Error("boom") } })
    scheduler.start()
    await flush()
    timers.tick()
    await flush()
    expect(runs).toBe(2)
    scheduler.stop()
  } finally { console.warn = warn }
})

test("startDeviceSync is a singleton, a configuration import triggers a sync, and stop detaches it", async () => {
  const timers = fakeTimers()
  let runs = 0
  const handle = startDeviceSync({ setInterval: timers.setInterval, clearInterval: timers.clearInterval, run: async () => { runs++ } })
  expect(startDeviceSync({ run: async () => { runs += 100 } })).toBe(handle)
  await flush()
  expect(runs).toBe(1)
  notifyConfigurationImported()
  await flush()
  expect(runs).toBe(2)
  handle.stop()
  notifyConfigurationImported()
  await flush()
  expect(runs).toBe(2)
  expect(timers.handlers.size).toBe(0)
  const again = startDeviceSync({ setInterval: timers.setInterval, clearInterval: timers.clearInterval, run: async () => { runs++ } })
  expect(again).not.toBe(handle)
  again.stop()
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test ./packages/gateway/tests/sync-engine.sqlite.test.ts ./packages/gateway/tests/sync-scheduler.test.ts`

Expected: FAIL: the `engine`, `scheduler`, `hooks` and `index` modules do not exist.

- [ ] **Step 3: The engine**

Create `packages/gateway/src/sync/engine.ts`:

```ts
import { getRuntimeLocation } from "@vibe-core/platform"
import { directFetcher, type Fetcher } from "@vibe-core/upstream"
import { providerPlugin } from "../data-plane/providers/registry"
import { getRepo } from "../repo"
import type { UserId } from "../repo/branded-ids"
import type { SyncSourceRecord } from "../repo/sync"
import type { Repo } from "../repo/types"
import { applySnapshot, type ApplyResult } from "./apply"
import { fetchSnapshot } from "./fetch"
import type { SyncDocument } from "./protocol"

export interface SyncDeps {
  repo?: Pick<Repo, "syncSources" | "upstreams">
  fetcher?: Fetcher
  now?: () => number
  isKnownProvider?: (provider: string) => boolean
}

/** Device sync runs only on Bun/Docker gateways; Workers never poll. */
export function deviceSyncAvailable(): boolean {
  try { return getRuntimeLocation() === "bun" } catch { return false }
}

class Mutex {
  private locked = false
  private readonly waiters: Array<() => void> = []
  tryAcquire(): (() => void) | null {
    if (this.locked) return null
    this.locked = true
    return () => this.release()
  }
  async acquire(): Promise<() => void> {
    const free = this.tryAcquire()
    if (free) return free
    // The lock stays held and is handed to the next waiter.
    await new Promise<void>(resolve => this.waiters.push(resolve))
    return () => this.release()
  }
  private release(): void {
    const next = this.waiters.shift()
    if (next) next()
    else this.locked = false
  }
}

/** Serializes the scheduler tick with source connect, replace and disconnect (one process, one source). */
export const syncLock = new Mutex()

export async function withSyncLock<T>(run: () => Promise<T>): Promise<T> {
  const release = await syncLock.acquire()
  try { return await run() } finally { release() }
}

function resolveDeps(deps: SyncDeps) {
  return {
    repo: deps.repo ?? getRepo(),
    fetcher: deps.fetcher ?? directFetcher,
    now: deps.now ?? Date.now,
    isKnownProvider: deps.isKnownProvider ?? ((kind: string) => providerPlugin(kind) !== undefined),
  }
}

/** A snapshot with skipped entries is retried: its ETag is not stored and the first skip code is the recorded error. */
async function recordApplied(repo: Pick<Repo, "syncSources">, source: SyncSourceRecord, result: ApplyResult, etag: string, stamp: string): Promise<void> {
  const skipped = result.skipped[0]?.code ?? null
  await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, successAt: stamp, etag: skipped ? null : etag, error: skipped })
}

export type SyncRunResult = "idle" | "not_modified" | "applied" | "revoked" | "failed"

/** One poll of the stored source. The caller holds `syncLock`. */
export async function syncSource(deps: SyncDeps = {}): Promise<SyncRunResult> {
  const { repo, fetcher, now, isKnownProvider } = resolveDeps(deps)
  const source = await repo.syncSources.get()
  if (!source || source.status !== "active") return "idle"
  const stamp = new Date(now()).toISOString()
  const fetched = await fetchSnapshot(source, fetcher)
  switch (fetched.kind) {
    case "not_modified":
      await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, successAt: stamp, error: null })
      return "not_modified"
    case "revoked":
      await repo.upstreams.deleteSynced(source.id)
      await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, etag: null, error: null, status: "revoked" })
      return "revoked"
    case "failed":
      await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, error: fetched.code })
      return "failed"
    case "changed":
      try {
        await recordApplied(repo, source, await applySnapshot(repo, source, fetched.snapshot, stamp, isKnownProvider), fetched.etag, stamp)
        return "applied"
      } catch {
        await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, error: "apply_failed" }).catch(() => false)
        return "failed"
      }
  }
}

/** The scheduler's entry point: skips when another sync or a source change is running; never throws. */
export async function runScheduledSync(deps: SyncDeps = {}): Promise<SyncRunResult | "busy"> {
  const release = syncLock.tryAcquire()
  if (!release) return "busy"
  try { return await syncSource(deps) }
  catch {
    console.warn(JSON.stringify({ evt: "device_sync_failed" }))
    return "failed"
  } finally { release() }
}

export type ConnectOutcome =
  | { kind: "connected"; source: SyncSourceRecord }
  | { kind: "invalid_document" }
  | { kind: "exists" }
  | { kind: "unreachable" }
  | { kind: "not_found" }

/**
 * `create`: the first source. `replace`: swap the document of the existing source in place (same id, same owner), which
 * removes upstreams the new snapshot lacks. The fetch happens first, so a rejected or unreachable document changes nothing.
 * Throws only when applying the fetched snapshot fails (the source stays, `last_error = apply_failed`).
 */
export async function connectSource(input: { mode: "create" | "replace"; ownerId: UserId; document: SyncDocument }, deps: SyncDeps = {}): Promise<ConnectOutcome> {
  const { repo, fetcher, now, isKnownProvider } = resolveDeps(deps)
  return withSyncLock(async (): Promise<ConnectOutcome> => {
    const existing = await repo.syncSources.get()
    if (input.mode === "create" && existing) return { kind: "exists" }
    if (input.mode === "replace" && !existing) return { kind: "not_found" }
    const { document } = input
    const fetched = await fetchSnapshot({ origin: document.gatewayOrigin, deviceId: document.deviceId, secret: document.deviceSecret, etag: null }, fetcher)
    if (fetched.kind === "revoked") return { kind: "invalid_document" }
    if (fetched.kind !== "changed") return { kind: "unreachable" }
    const stamp = new Date(now()).toISOString()
    const fields = { origin: document.gatewayOrigin, deviceId: document.deviceId, secret: document.deviceSecret }
    let source: SyncSourceRecord | null
    if (existing) source = await repo.syncSources.replaceDocument(existing.id, fields, stamp)
    else {
      const created: SyncSourceRecord = { id: `ssrc_${crypto.randomUUID().replaceAll("-", "")}`, ownerId: input.ownerId, ...fields, etag: null,
        lastAttemptAt: stamp, lastSuccessAt: null, status: "active", lastError: null }
      source = (await repo.syncSources.create(created)) ? created : null
    }
    if (!source) return { kind: existing ? "not_found" : "exists" }
    try {
      await recordApplied(repo, source, await applySnapshot(repo, source, fetched.snapshot, stamp, isKnownProvider), fetched.etag, stamp)
    } catch (error) {
      await repo.syncSources.recordResult(source.id, source.secret, { attemptAt: stamp, error: "apply_failed" }).catch(() => false)
      throw error
    }
    return { kind: "connected", source: (await repo.syncSources.get()) ?? source }
  })
}

/** Removes the source and every upstream it created. False when there was no source. */
export async function disconnectSource(deps: SyncDeps = {}): Promise<boolean> {
  const { repo } = resolveDeps(deps)
  return withSyncLock(async () => {
    const source = await repo.syncSources.get()
    if (!source) return false
    await repo.upstreams.deleteSynced(source.id)
    await repo.syncSources.delete(source.id)
    return true
  })
}
```

- [ ] **Step 4: Scheduler, hook and entry point**

Create `packages/gateway/src/sync/hooks.ts`:

```ts
type Listener = () => void
const listeners = new Set<Listener>()

/** Registers a callback for "configuration was just imported". Returns the unsubscribe function. */
export function onConfigurationImported(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Called by the import route. A throwing listener never affects the import. */
export function notifyConfigurationImported(): void {
  for (const listener of listeners) {
    try { listener() } catch { /* Advisory. */ }
  }
}
```

Create `packages/gateway/src/sync/scheduler.ts`:

```ts
import { SYNC_INTERVAL_MS } from "./protocol"

export interface SchedulerOptions {
  /** One sync attempt. Rejections are swallowed. */
  run: () => Promise<unknown>
  intervalMs?: number
  setInterval?: (handler: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export interface DeviceSyncScheduler {
  /** Runs once immediately, then every interval. Calling it twice has no effect. */
  start(): void
  stop(): void
  /** Runs now unless a run is in flight. */
  trigger(): Promise<void>
}

export function createDeviceSyncScheduler(options: SchedulerOptions): DeviceSyncScheduler {
  const every = options.intervalMs ?? SYNC_INTERVAL_MS
  const set = options.setInterval ?? ((handler: () => void, ms: number) => {
    const handle = setInterval(handler, ms)
    ;(handle as { unref?: () => void }).unref?.()
    return handle
  })
  const clear = options.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))
  let handle: unknown
  let running = false
  const trigger = async () => {
    if (running) return
    running = true
    try { await options.run() }
    catch { console.warn(JSON.stringify({ evt: "device_sync_failed" })) }
    finally { running = false }
  }
  return {
    start() {
      if (handle !== undefined) return
      handle = set(() => { void trigger() }, every)
      void trigger()
    },
    stop() {
      if (handle === undefined) return
      clear(handle)
      handle = undefined
    },
    trigger,
  }
}
```

Create `packages/gateway/src/sync/index.ts`:

```ts
import { runScheduledSync } from "./engine"
import { onConfigurationImported } from "./hooks"
import { createDeviceSyncScheduler, type SchedulerOptions } from "./scheduler"

export { createDeviceSyncScheduler } from "./scheduler"
export { connectSource, deviceSyncAvailable, disconnectSource, runScheduledSync, syncLock, syncSource, withSyncLock } from "./engine"
export { notifyConfigurationImported, onConfigurationImported } from "./hooks"

export interface DeviceSyncHandle {
  trigger(): Promise<void>
  stop(): void
}

let current: DeviceSyncHandle | null = null

/**
 * Starts the device sync loop: one sync now, one after every configuration import, then every 60 seconds. A singleton:
 * a second call returns the running handle. Only `apps/platform-bun` calls this; tests pass fake timers and a fake `run`.
 */
export function startDeviceSync(options: Partial<SchedulerOptions> = {}): DeviceSyncHandle {
  if (current) return current
  const scheduler = createDeviceSyncScheduler({ ...options, run: options.run ?? (() => runScheduledSync()) })
  const detach = onConfigurationImported(() => { void scheduler.trigger() })
  scheduler.start()
  const handle: DeviceSyncHandle = {
    trigger: scheduler.trigger,
    stop() { scheduler.stop(); detach(); current = null },
  }
  current = handle
  return handle
}
```

In `packages/gateway/package.json` add to `exports` (after the `"./maintenance"` line):

```json
    "./sync": "./src/sync/index.ts",
```

In `apps/platform-bun/src/server.ts` add the import after line 3 (`import { app } from "@vibe-llm/gateway"`):

```ts
import { startDeviceSync } from "@vibe-llm/gateway/sync"
```

and, after the maintenance interval (after line 26, `setInterval(() => { void sweep() }, 60_000).unref()`):

```ts

// Docker gateways pull their sync source: once now, after every configuration import, then every 60 seconds.
// Cloudflare Workers never run this.
startDeviceSync()
```

- [ ] **Step 5: Run the tests and typechecks**

```bash
bun test ./packages/gateway/tests/sync-engine.sqlite.test.ts ./packages/gateway/tests/sync-scheduler.test.ts
bun run --filter '@vibe-llm/gateway' typecheck
bun run --filter '@vibe-llm/platform-bun' typecheck
```

Expected: PASS and clean typechecks.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/sync/engine.ts packages/gateway/src/sync/scheduler.ts packages/gateway/src/sync/hooks.ts \
  packages/gateway/src/sync/index.ts packages/gateway/package.json apps/platform-bun/src/server.ts \
  packages/gateway/tests/sync-engine.sqlite.test.ts packages/gateway/tests/sync-scheduler.test.ts
git commit -F - <<'EOF'
feat(vnext/gateway): run device sync on a schedule

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 9: Device source routes

`/api/sync/source` on the local gateway, session-guarded by the same middleware as the device routes. Ownership and availability follow decisions D8 and D9. Importing a configuration also triggers an immediate sync through the hook from Task 8.

**Files:**
- Create: `packages/gateway/src/control-plane/sync/source.ts`
- Modify: `packages/gateway/src/control-plane/sync/routes.ts`, `packages/gateway/src/control-plane/data-transfer/routes.ts` (imports; after the upsert loops at lines 85-91, directly before the `return c.json` at line 93)
- Test: `packages/gateway/tests/sync-source.sqlite.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/tests/sync-source.sqlite.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { dataTransferRouter } from "../src/control-plane/data-transfer/routes"
import { syncManagementRouter } from "../src/control-plane/sync/routes"
import { onConfigurationImported } from "../src/sync/hooks"
import { syncDocument } from "../src/sync/protocol"
import type { SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids"
import { realFetch, stubGlobalFetch } from "./_stub-global-fetch"

const owner = "device-owner" as UserId
const other = "device-other" as UserId
const admin = "device-admin" as UserId
const tokens: Record<string, string> = { [owner]: "ses_device_owner", [other]: "ses_device_other", [admin]: "ses_device_admin" }
const stamp = "2026-11-16T00:00:00.000Z"
const deviceId = `sdv_${"1".repeat(32)}`
const secret = `sds_${"2".repeat(64)}`
const doc = syncDocument("https://central.example", deviceId, secret)
let db: Database
let repo: BunSqliteRepo
let app: Hono
let central: { entries: unknown[]; mode: "ok" | "down" | "revoked" | "error" | "redirect"; calls: number }

const entry = (id: string) => ({ id, provider: "copilot", name: id, config: { githubToken: `token-${id}` }, state: null,
  flagOverrides: {}, disabledPublicModelIds: [] })

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  await repo.users.create({ id: admin, name: admin, email: "test@local.dev", createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) {
    await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  central = { entries: [entry("up_a"), entry("up_b")], mode: "ok", calls: 0 }
  stubGlobalFetch(async (_input, init) => {
    central.calls++
    if (central.mode === "down") throw new Error("network down")
    if (central.mode === "redirect") return new Response(null, { status: 302, headers: { location: "https://evil.example/" } })
    if (central.mode === "error") return new Response("boom", { status: 500 })
    if (central.mode === "revoked" || new Headers(init?.headers).get("authorization") !== `Bearer ${secret}`) return new Response("{}", { status: 401 })
    return Response.json({ version: 1, deviceId, upstreams: central.entries })
  })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/sync", syncManagementRouter)
})
afterEach(() => { globalThis.fetch = realFetch; db.close(); __resetPlatformForTests() })

function call(method: string, body?: unknown, user: UserId = owner, path = "/source") {
  return app.request(`http://device.local/api/sync${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) })
}
const code = async (response: Response) => (await response.json() as { error: { code: string } }).error.code
const ids = async () => (await repo.upstreams.list({ includeDisabled: true })).map(row => row.id).sort()

test("connecting stores the source, applies the snapshot for the caller and never returns the secret", async () => {
  expect(await (await call("GET")).json()).toEqual({ available: true, source: null })
  const response = await call("POST", { document: doc })
  expect(response.status).toBe(201)
  const text = await response.text()
  expect(text).not.toContain(secret)
  expect(JSON.parse(text)).toEqual({ source: { origin: "https://central.example", deviceId, status: "active",
    lastAttemptAt: expect.any(String), lastSuccessAt: expect.any(String), lastError: null, upstreamCount: 2 } })
  expect(await ids()).toEqual(["up_a", "up_b"])
  expect(await repo.upstreams.getById("up_a" as UpstreamId)).toMatchObject({ ownerId: owner })
  const read = await (await call("GET")).text()
  expect(read).not.toContain(secret)
  expect(JSON.parse(read).source).toMatchObject({ upstreamCount: 2 })
})

test("invalid documents are refused before any request and store nothing", async () => {
  const bad: unknown[] = [{ document: { ...doc, extra: 1 } }, { document: { ...doc, kind: "loki-mirror" } }, { document: { ...doc, gatewayOrigin: "http://central.example" } },
    { document: { ...doc, deviceSecret: `lks_${"2".repeat(64)}` } }, { document: "text" }, {}]
  for (const body of bad) expect([(await call("POST", body)).status]).toEqual([400])
  expect(await code(await call("POST", { document: { ...doc, extra: 1 } }))).toBe("invalid_sync_document")
  expect(await code(await call("POST", "not json"))).toBe("invalid_request")
  expect(await code(await call("POST", { document: doc, extra: true }))).toBe("invalid_request")
  expect(central.calls).toBe(0)
  expect(await repo.syncSources.get()).toBeNull()
})

test("a rejected or unreachable central creates nothing", async () => {
  central.mode = "revoked"
  const rejected = await call("POST", { document: doc })
  expect([rejected.status, await code(rejected)]).toEqual([400, "invalid_sync_document"])
  for (const mode of ["down", "error", "redirect"] as const) {
    central.mode = mode
    const response = await call("POST", { document: doc })
    expect([response.status, await code(response)]).toEqual([502, "sync_unreachable"])
  }
  expect(await repo.syncSources.get()).toBeNull()
  expect(await ids()).toEqual([])
})

test("a second source is refused for everyone", async () => {
  await call("POST", { document: doc })
  for (const user of [owner, other, admin]) {
    const response = await call("POST", { document: doc }, user)
    expect([response.status, await code(response)]).toEqual([409, "sync_source_exists"])
  }
})

test("only the source owner or an administrator sees and changes it", async () => {
  await call("POST", { document: doc })
  expect(((await (await call("GET", undefined, other)).json()) as { source: unknown }).source).toBeNull()
  expect(((await (await call("GET", undefined, admin)).json()) as { source: { origin: string } }).source.origin).toBe("https://central.example")
  for (const method of ["PUT", "DELETE"]) {
    const response = await call(method, method === "PUT" ? { document: doc } : undefined, other)
    expect([response.status, await code(response)]).toEqual([404, "sync_source_not_found"])
  }
  expect(await ids()).toEqual(["up_a", "up_b"])
})

test("replacing swaps the document and prunes upstreams the new snapshot lacks, keeping the original owner", async () => {
  expect([(await call("PUT", { document: doc })).status]).toEqual([404])
  await call("POST", { document: doc })
  central.entries = [entry("up_b"), entry("up_c")]
  central.mode = "down"
  expect(await code(await call("PUT", { document: doc }))).toBe("sync_unreachable")
  expect(await ids()).toEqual(["up_a", "up_b"])
  central.mode = "revoked"
  expect(await code(await call("PUT", { document: doc }))).toBe("invalid_sync_document")
  central.mode = "ok"
  expect(await code(await call("PUT", { document: { ...doc, extra: 1 } }))).toBe("invalid_sync_document")
  const replaced = await call("PUT", { document: doc }, admin)
  expect(replaced.status).toBe(200)
  expect(await ids()).toEqual(["up_b", "up_c"])
  expect((await repo.syncSources.get())?.ownerId).toBe(owner)
})

test("disconnecting removes the source and every synced upstream", async () => {
  await call("POST", { document: doc })
  await repo.upstreams.save({ id: "up_local", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const response = await call("DELETE")
  expect([response.status, await response.json()]).toEqual([200, { source: null }])
  expect(await ids()).toEqual(["up_local"])
  expect(await repo.syncSources.get()).toBeNull()
  expect((await call("DELETE")).status).toBe(404)
})

test("an apply failure keeps the stored source and answers a uniform 503", async () => {
  repo.upstreams.applySynced = async () => { throw new Error("storage down") }
  const response = await call("POST", { document: doc })
  expect([response.status, await code(response)]).toEqual([503, "temporarily_unavailable"])
  expect(await repo.syncSources.get()).toMatchObject({ lastError: "apply_failed", status: "active" })
})

test("Workers do not run device sync", async () => {
  initRuntimeLocation("cloudflare")
  expect(await (await call("GET")).json()).toEqual({ available: false, source: null })
  for (const method of ["POST", "PUT"]) {
    const response = await call(method, { document: doc })
    expect([response.status, await code(response)]).toEqual([501, "device_sync_unavailable"])
  }
  expect(central.calls).toBe(0)
})

test("the source routes need a real session and, for cookies, a matching Origin", async () => {
  const cookie = `session_token=${tokens[owner]}`
  expect((await app.request("http://device.local/api/sync/source", { method: "POST", headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ document: doc }) })).status).toBe(403)
  expect((await app.request("http://device.local/api/sync/source")).status).toBe(401)
})

test("a configuration import notifies the device sync", async () => {
  const transfer = new Hono()
  transfer.use("*", (c, next) => { c.set("auth" as never, { isAdmin: true } as never); return next() })
  transfer.route("/api", dataTransferRouter)
  let notified = 0
  const detach = onConfigurationImported(() => { notified++ })
  try {
    const bundle = { version: 2, apiKeys: [], githubAccounts: [], upstreams: [] }
    const imported = await transfer.request("http://device.local/api/import", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "merge", bundle }) })
    expect(imported.status).toBe(200)
    expect(notified).toBe(1)
    const rejected = await transfer.request("http://device.local/api/import", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "merge", bundle: { version: 9 } }) })
    expect(rejected.status).toBe(400)
    expect(notified).toBe(1)
  } finally { detach() }
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `bun test ./packages/gateway/tests/sync-source.sqlite.test.ts`

Expected: FAIL: `/api/sync/source` answers 404 (no router) and the import never notifies.

- [ ] **Step 3: The routes**

Create `packages/gateway/src/control-plane/sync/source.ts`:

```ts
import { Hono } from "hono"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import type { UserId } from "../../repo/branded-ids"
import type { SyncSourceRecord } from "../../repo/sync"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { connectSource, deviceSyncAvailable, disconnectSource, type ConnectOutcome } from "../../sync/engine"
import { SyncDocumentError, parseSyncDocument, type SyncDocument } from "../../sync/protocol"
import { SyncError, readJsonBody, syncFailure, syncJson } from "./common"

export const syncSourceRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

/** Never includes the secret. */
async function publicSource(source: SyncSourceRecord) {
  return {
    origin: source.origin, deviceId: source.deviceId, status: source.status, lastAttemptAt: source.lastAttemptAt,
    lastSuccessAt: source.lastSuccessAt, lastError: source.lastError,
    upstreamCount: (await getRepo().upstreams.listSynced(source.id)).length,
  }
}

const mayManage = (auth: FullAuthCtx, source: SyncSourceRecord) => auth.isAdmin === true || source.ownerId === auth.userId

async function readDocument(request: Request): Promise<SyncDocument> {
  const body = await readJsonBody(request)
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => key !== "document")) {
    throw new SyncError("invalid_request", 400)
  }
  try { return parseSyncDocument((body as { document?: unknown }).document) }
  catch (error) {
    if (error instanceof SyncDocumentError) throw new SyncError("invalid_sync_document", 400)
    throw error
  }
}

function requireAvailable(): void {
  if (!deviceSyncAvailable()) throw new SyncError("device_sync_unavailable", 501)
}

async function respond(outcome: ConnectOutcome, status: number): Promise<Response> {
  switch (outcome.kind) {
    case "connected": return syncJson({ source: await publicSource(outcome.source) }, status)
    case "invalid_document": throw new SyncError("invalid_sync_document", 400)
    case "exists": throw new SyncError("sync_source_exists", 409)
    case "unreachable": throw new SyncError("sync_unreachable", 502)
    case "not_found": throw new SyncError("sync_source_not_found", 404)
  }
}

syncSourceRouter.get("/source", async c => {
  try {
    const source = await getRepo().syncSources.get()
    const visible = source && mayManage(c.get("auth"), source) ? await publicSource(source) : null
    return syncJson({ available: deviceSyncAvailable(), source: visible })
  } catch (error) { return syncFailure(error) }
})

syncSourceRouter.post("/source", async c => {
  try {
    requireAvailable()
    const document = await readDocument(c.req.raw)
    return await respond(await connectSource({ mode: "create", ownerId: c.get("auth").userId as UserId, document }), 201)
  } catch (error) { return syncFailure(error) }
})

syncSourceRouter.put("/source", async c => {
  try {
    requireAvailable()
    const auth = c.get("auth")
    const current = await getRepo().syncSources.get()
    if (!current || !mayManage(auth, current)) throw new SyncError("sync_source_not_found", 404)
    const document = await readDocument(c.req.raw)
    return await respond(await connectSource({ mode: "replace", ownerId: current.ownerId, document }), 200)
  } catch (error) { return syncFailure(error) }
})

syncSourceRouter.delete("/source", async c => {
  try {
    const current = await getRepo().syncSources.get()
    if (!current || !mayManage(c.get("auth"), current)) throw new SyncError("sync_source_not_found", 404)
    if (!(await disconnectSource())) throw new SyncError("sync_source_not_found", 404)
    return syncJson({ source: null })
  } catch (error) { return syncFailure(error) }
})
```

Replace `packages/gateway/src/control-plane/sync/routes.ts`:

```ts
import { Hono } from "hono"
import type { Env } from "../../app"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { requireBrowserSession } from "../shared/session-guard"
import { syncDevicesRouter } from "./devices"
import { syncSourceRouter } from "./source"

export const syncManagementRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()
syncManagementRouter.use("*", requireBrowserSession)
syncManagementRouter.route("/", syncDevicesRouter)
syncManagementRouter.route("/", syncSourceRouter)
```

In `packages/gateway/src/control-plane/data-transfer/routes.ts` add the import after line 21 (`} from '../lib/import-export.ts'`):

```ts
import { notifyConfigurationImported } from '../../sync/hooks.ts'
```

and call it after the upsert loops, directly before `return c.json({ ok: true, ... })`:

```ts
  // Device gateways re-sync right away so synced upstreams removed by a replace come back.
  notifyConfigurationImported()
```

- [ ] **Step 4: Run the tests and typecheck**

```bash
bun test ./packages/gateway/tests/sync-source.sqlite.test.ts ./packages/gateway/tests/sync-devices.sqlite.test.ts ./packages/gateway/tests/control-plane-data-transfer.test.ts
bun run --filter '@vibe-llm/gateway' typecheck
```

Expected: PASS and a clean typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/control-plane/sync/source.ts packages/gateway/src/control-plane/sync/routes.ts \
  packages/gateway/src/control-plane/data-transfer/routes.ts packages/gateway/tests/sync-source.sqlite.test.ts
git commit -F - <<'EOF'
feat(vnext/gateway): connect, replace and disconnect a sync source on devices

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 10: Read-only enforcement for synced upstreams, DTO fields, import and export

Synced rows are tagged by `sync_source_id` (Task 3); the providers already run with `credentialsReadOnly` (Task 2). This task closes every write path the spec lists, with the single response shape of decision D11:

| Path | Behavior for a synced upstream |
| --- | --- |
| `PATCH /api/upstreams/:id` | accepts `enabled`, `sortOrder`, `proxyFallbackList`; any of `ownerId`, `provider`, `name`, `config`, `flagOverrides`, `disabledPublicModelIds` gives `409` |
| `DELETE /api/upstreams/:id` | `409` |
| `POST /api/upstreams` whose generated id is a synced row's id | `409` (and `save()` itself never overwrites, Task 3) |
| `POST /api/upstreams/:id/credentials/refresh` | `409` (Codex re-import needs a Codex row, which is never synced) |
| Loki `PATCH /api/loki/upstreams/:id`, `POST`/`DELETE .../pair` | `409` |
| Copilot device-flow add / sign-out of the account whose row is synced (`lib/github.ts`) | `409`, before any `github_accounts` write |
| Duplicate, re-authenticate | UI-only actions: duplicate is a client-side draft (Task 13 hides it); re-authentication is the device-flow add above |
| Configuration export | rows with `sync_source_id` are left out; import skips ids of live synced rows |

`POST /:id/test` and `GET /:id/models` stay allowed: they construct providers through the registry, which applies `credentialsReadOnly`.

**Files:**
- Create: `packages/gateway/src/control-plane/sync/read-only.ts`
- Modify: `packages/gateway/src/control-plane/upstreams/routes.ts` (import near line 41; lines 403-412, 444-448, 458-465, 495, 501-512), `upstreams/codex-credentials-routes.ts` (import near line 20; lines 252-253), `upstreams/public-dto.ts` (lines 10-17, 139-154)
- Modify: `packages/gateway/src/control-plane/loki/routes.ts` (`ownedLoki`), `control-plane/lib/github.ts` (lines 90-130), `control-plane/auth/github-routes.ts` (lines 24-31, 206-212, 295-302, 339)
- Modify: `packages/gateway/src/control-plane/lib/import-export.ts` (line 117), `control-plane/data-transfer/routes.ts` (lines 76-100)
- Test: `packages/gateway/tests/sync-read-only.sqlite.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/tests/sync-read-only.sqlite.test.ts`:

```ts
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { githubAuthRouter } from "../src/control-plane/auth/github-routes"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { dataTransferRouter } from "../src/control-plane/data-transfer/routes"
import { exportConfig } from "../src/control-plane/lib/import-export"
import { addGithubAccount, copilotUpstreamRowId, removeGithubAccount } from "../src/control-plane/lib/github"
import { lokiManagementRouter } from "../src/control-plane/loki/routes"
import { SyncedUpstreamReadOnlyError } from "../src/control-plane/sync/read-only"
import { upstreamsRouter } from "../src/control-plane/upstreams/routes"
import type { GitHubAccountId, SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids"

const owner = "device-owner" as UserId
const token = "ses_read_only_owner"
const stamp = "2026-11-16T00:00:00.000Z"
let db: Database
let repo: BunSqliteRepo
let upstreams: Hono
let lokiApp: Hono
let accountsApp: Hono

const readOnly = { error: { code: "synced_upstream_read_only" } }
const synced = (id: string, provider: "copilot" | "loki" | "custom", over: Record<string, unknown> = {}) => repo.upstreams.applySynced("ssrc_1", {
  id, ownerId: owner, provider, name: id, config: provider === "loki" ? { profileId: "loki-df-v1" } : { githubToken: "ghp_synced" },
  state: null, flagOverrides: {}, disabledPublicModelIds: [], ...over,
}, stamp)
const send = (app: Hono, path: string, method: string, body?: unknown) => app.request(`https://device.local${path}`, {
  method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
})
const row = (id: string) => repo.upstreams.getById(id as UpstreamId)

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  await repo.users.create({ id: owner, name: owner, createdAt: stamp, disabled: false })
  await repo.sessions.create({ token: token as SessionToken, userId: owner, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  await repo.syncSources.create({ id: "ssrc_1", ownerId: owner, origin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`,
    secret: `sds_${"2".repeat(64)}`, etag: null, lastAttemptAt: null, lastSuccessAt: null, status: "active", lastError: null })
  upstreams = new Hono()
  upstreams.use("*", async (c, next) => { c.set("auth" as never, { authKind: "session", isAdmin: false, isUser: true, userId: owner } as never); await next() })
  upstreams.route("/api/upstreams", upstreamsRouter)
  lokiApp = new Hono()
  lokiApp.use("*", sessionAuthMiddleware)
  lokiApp.route("/api/loki", lokiManagementRouter)
  accountsApp = new Hono()
  accountsApp.use("*", async (c, next) => { c.set("auth" as never, { authKind: "session", isUser: true, userId: owner } as never); await next() })
  accountsApp.route("/api/auth", githubAuthRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

test("the generic PATCH accepts only enabled, order and proxies for a synced upstream", async () => {
  await synced("up_copilot_s", "copilot")
  for (const body of [{ name: "x" }, { config: { githubToken: "y" } }, { provider: "copilot" }, { ownerId: "someone" }, { flagOverrides: { a: true } },
    { disabledPublicModelIds: [] }, { enabled: false, name: "x" }]) {
    const response = await send(upstreams, "/api/upstreams/up_copilot_s", "PATCH", body)
    expect([response.status, await response.json()]).toEqual([409, readOnly])
  }
  expect(await row("up_copilot_s")).toMatchObject({ name: "up_copilot_s", enabled: true, config: { githubToken: "ghp_synced" } })
  const allowed = await send(upstreams, "/api/upstreams/up_copilot_s", "PATCH", { enabled: false, sortOrder: 5, proxyFallbackList: [{ id: "direct_fetch" }] })
  expect(allowed.status).toBe(200)
  expect(await allowed.json()).toMatchObject({ upstream: { enabled: false, sortOrder: 5, syncedFrom: { origin: "https://central.example" } } })
  expect(await row("up_copilot_s")).toMatchObject({ enabled: false, sortOrder: 5, proxyFallbackList: [{ id: "direct_fetch" }], syncSourceId: "ssrc_1" })
})

test("a synced upstream cannot be deleted and an ordinary one still can", async () => {
  await synced("up_copilot_s", "copilot")
  await repo.upstreams.save({ id: "up_custom_l", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const blocked = await send(upstreams, "/api/upstreams/up_copilot_s", "DELETE")
  expect([blocked.status, await blocked.json()]).toEqual([409, readOnly])
  expect(await row("up_copilot_s")).not.toBeNull()
  expect((await send(upstreams, "/api/upstreams/up_custom_l", "DELETE")).status).toBe(200)
})

test("creating an upstream whose generated id is a synced row's id is refused and leaves the row alone", async () => {
  await synced("up_custom_dup_00000000", "custom", { config: { name: "synced" } })
  const uuid = spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000")
  try {
    const response = await send(upstreams, "/api/upstreams", "POST", { provider: "custom", name: "dup",
      config: { name: "dup", baseUrl: "https://api.example.com/v1", apiKey: "sk-x" } })
    expect([response.status, await response.json()]).toEqual([409, readOnly])
  } finally { uuid.mockRestore() }
  expect(await row("up_custom_dup_00000000")).toMatchObject({ config: { name: "synced" }, syncSourceId: "ssrc_1" })
})

test("credential refresh and Loki settings and pairing reject synced upstreams", async () => {
  await synced("up_copilot_s", "copilot")
  await synced("up_loki_s", "loki")
  const refresh = await send(upstreams, "/api/upstreams/up_copilot_s/credentials/refresh", "POST", {})
  expect([refresh.status, await refresh.json()]).toEqual([409, readOnly])
  for (const [path, method, body] of [["/api/loki/upstreams/up_loki_s", "PATCH", { baseUrl: "https://loki.example/api" }],
    ["/api/loki/upstreams/up_loki_s/pair", "POST", {}], ["/api/loki/upstreams/up_loki_s/pair", "DELETE", undefined]] as const) {
    const response = await send(lokiApp, path, method, body)
    expect([response.status, await response.json()]).toEqual([409, readOnly])
  }
  expect(await row("up_loki_s")).toMatchObject({ config: { profileId: "loki-df-v1" }, state: null })
})

test("signing in or out of the Copilot account behind a synced row is refused before any account write", async () => {
  const user = { id: 7 as GitHubAccountId, login: "octo", name: "Octo", avatar_url: "" }
  await synced(copilotUpstreamRowId(owner, user.id), "copilot")
  await expect(addGithubAccount("ghp_local", user, "individual", owner)).rejects.toBeInstanceOf(SyncedUpstreamReadOnlyError)
  expect(await repo.github.listAccounts()).toEqual([])
  await repo.github.saveAccount(user.id, { token: "ghp_old", accountType: "individual", user, ownerId: owner })
  await expect(removeGithubAccount(user.id, owner)).rejects.toBeInstanceOf(SyncedUpstreamReadOnlyError)
  expect((await repo.github.listAccounts()).map(account => account.user.id)).toEqual([user.id])
  expect(await row(copilotUpstreamRowId(owner, user.id))).not.toBeNull()
  const route = await send(accountsApp, `/api/auth/github/${user.id}`, "DELETE")
  expect([route.status, await route.json()]).toEqual([409, readOnly])
})

test("the upstream list marks syncable providers and shows where synced rows come from", async () => {
  await synced("up_copilot_s", "copilot")
  await repo.upstreams.save({ id: "up_custom_l", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const listed = await (await send(upstreams, "/api/upstreams?includeDisabled=1", "GET")).json() as { upstreams: Array<Record<string, unknown>> }
  const byId = Object.fromEntries(listed.upstreams.map(upstream => [upstream.id as string, upstream]))
  expect(byId.up_copilot_s).toMatchObject({ syncable: true, syncedFrom: { origin: "https://central.example" } })
  expect(byId.up_custom_l).not.toHaveProperty("syncable")
  expect(byId.up_custom_l).not.toHaveProperty("syncedFrom")
  expect(JSON.stringify(listed)).not.toContain("syncSourceId")
})

test("exports leave out synced upstreams and imports skip their ids", async () => {
  await synced("up_copilot_s", "copilot")
  await repo.upstreams.save({ id: "up_custom_l", ownerId: owner, provider: "custom", name: "Local", enabled: true, sortOrder: 0, config: {},
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp })
  const rows = await repo.upstreams.list({ includeDisabled: true })
  for (const redactSecrets of [true, false]) {
    const bundle = exportConfig({ apiKeys: [], githubAccounts: [], upstreams: rows }, { redactSecrets })
    expect(bundle.upstreams.map(upstream => upstream.id)).toEqual(["up_custom_l"])
    expect(JSON.stringify(bundle)).not.toContain("ghp_synced")
  }
  const transfer = new Hono()
  transfer.use("*", async (c, next) => { c.set("auth" as never, { isAdmin: true } as never); await next() })
  transfer.route("/api", dataTransferRouter)
  const imposter = { id: "up_copilot_s", provider: "copilot", name: "Imposter", config: { githubToken: "stolen" }, enabled: true, sortOrder: 0,
    flagOverrides: {}, disabledPublicModelIds: [], state: null, proxyFallbackList: [], createdAt: stamp, updatedAt: stamp }
  const fresh = { ...imposter, id: "up_copilot_new", name: "New" }
  for (const mode of ["merge", "replace"] as const) {
    const response = await transfer.request("https://device.local/api/import", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, bundle: { version: 2, apiKeys: [], githubAccounts: [], upstreams: [imposter, fresh] } }) })
    expect(response.status).toBe(200)
    expect(((await response.json()) as { imported: { upstreams: number } }).imported.upstreams).toBe(1)
    expect(await row("up_copilot_new")).toMatchObject({ name: "New" })
    // A merge leaves the synced row untouched; a replace deletes everything first and the sync that follows an import rebuilds it.
    if (mode === "merge") expect(await row("up_copilot_s")).toMatchObject({ name: "up_copilot_s", syncSourceId: "ssrc_1", config: { githubToken: "ghp_synced" } })
    else expect(await row("up_copilot_s")).toBeNull()
    await repo.upstreams.deleteAll()
    await synced("up_copilot_s", "copilot")
  }
})
```

- [ ] **Step 2: Run the test to see it fail**

Run: `bun test ./packages/gateway/tests/sync-read-only.sqlite.test.ts`

Expected: FAIL: `../src/control-plane/sync/read-only` does not exist, and the generic routes accept every change.

- [ ] **Step 3: The read-only helpers**

Create `packages/gateway/src/control-plane/sync/read-only.ts`:

```ts
import { getRepo } from "../../repo"

/** Thrown by library code that would rewrite or delete a row synced from another gateway. */
export class SyncedUpstreamReadOnlyError extends Error {
  readonly code = "synced_upstream_read_only"
  constructor() { super("synced_upstream_read_only") }
}

/** Fields a synced upstream may not change through the generic PATCH. `enabled`, `sortOrder` and the proxy list stay device-local. */
export const SYNCED_LOCKED_FIELDS = ["ownerId", "provider", "name", "config", "flagOverrides", "disabledPublicModelIds"] as const

export const isSynced = (row: { syncSourceId?: string } | null | undefined): boolean => !!row?.syncSourceId

/** The one response shape for every rejected write. */
export function syncedReadOnlyResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "synced_upstream_read_only" } }), {
    status: 409, headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}

export function syncedReadOnlyResponseFor(error: unknown): Response | null {
  return error instanceof SyncedUpstreamReadOnlyError ? syncedReadOnlyResponse() : null
}

/** The origin synced rows come from, or null when none is synced or the source is unreadable. Costs a query only when a row is synced. */
export async function syncOriginFor(rows: ReadonlyArray<{ syncSourceId?: string }>): Promise<string | null> {
  if (!rows.some(isSynced)) return null
  try { return (await getRepo().syncSources.get())?.origin ?? null } catch { return null }
}
```

- [ ] **Step 4: The generic upstream routes and the DTO**

In `packages/gateway/src/control-plane/upstreams/routes.ts`:

1. After the `serializeUpstream` import (line 41) add:

```ts
import { SYNCED_LOCKED_FIELDS, isSynced, syncOriginFor, syncedReadOnlyResponse } from '../sync/read-only.ts'
```

2. In `GET /` replace `return c.json({ upstreams: upstreams.map(serializeUpstream) })` with:

```ts
  const syncOrigin = await syncOriginFor(upstreams)
  return c.json({ upstreams: upstreams.map((upstream) => serializeUpstream(upstream, { syncOrigin })) })
```

3. In `POST /`, directly before `await getRepo().upstreams.save(upstream)` add:

```ts
    if (isSynced(await getRepo().upstreams.getById(upstream.id as UpstreamId))) return syncedReadOnlyResponse()
```

4. In `PATCH /:id` replace

```ts
  if (!existing) return jsonError('upstream not found', 404)
  try {
    const body = c.req.valid('json')
    if (body.provider !== undefined && body.provider !== existing.provider) {
```

with

```ts
  if (!existing) return jsonError('upstream not found', 404)
  if (isSynced(existing)) {
    const requested = c.req.valid('json')
    if (SYNCED_LOCKED_FIELDS.some((field) => requested[field] !== undefined)) return syncedReadOnlyResponse()
  }
  try {
    const body = c.req.valid('json')
    if (body.provider !== undefined && body.provider !== existing.provider) {
```

and replace `return c.json({ upstream: serializeUpstream(next) })` (end of that handler) with:

```ts
    return c.json({ upstream: serializeUpstream(next, { syncOrigin: await syncOriginFor([next]) }) })
```

5. In `DELETE /:id` replace

```ts
  if (!existing) return jsonError('upstream not found', 404)
  // For copilot upstreams, cascade-delete the github_accounts row
```

with

```ts
  if (!existing) return jsonError('upstream not found', 404)
  if (isSynced(existing)) return syncedReadOnlyResponse()
  // For copilot upstreams, cascade-delete the github_accounts row
```

In `packages/gateway/src/control-plane/upstreams/codex-credentials-routes.ts` add after line 19 (`import { serializeUpstream } from "./public-dto.ts"`):

```ts
import { isSynced, syncedReadOnlyResponse } from "../sync/read-only.ts"
```

then, in `POST /:id/credentials/refresh`, replace

```ts
  if (!row) return errorResponse("upstream not found", 404)
  const account = targetAccount(row)
```

with

```ts
  if (!row) return errorResponse("upstream not found", 404)
  if (isSynced(row)) return syncedReadOnlyResponse()
  const account = targetAccount(row)
```

In `packages/gateway/src/control-plane/upstreams/public-dto.ts`:

1. Add `import { isSyncableProvider } from "../../data-plane/providers/registry.ts"` to the imports.
2. Add to the `PublicUpstream` intersection (next to `lokiStatus`):

```ts
    /** The provider may be selected for gateway sync. */
    syncable?: true
    /** Present on rows created by a sync source; `origin` is null when the source row is gone. */
    syncedFrom?: { origin: string | null }
```

3. Replace the `serializeUpstream` signature line and add the two fields before `return dto`:

```ts
export function serializeUpstream(upstream: UpstreamRecord<unknown>, options: { syncOrigin?: string | null } = {}): PublicUpstream {
```

```ts
  if (isSyncableProvider(upstream.provider)) dto.syncable = true
  if ((upstream as { syncSourceId?: string }).syncSourceId) dto.syncedFrom = { origin: options.syncOrigin ?? null }
```

(`syncSourceId` itself is never serialized.)

- [ ] **Step 5: Loki routes, Copilot account library and its routes**

In `packages/gateway/src/control-plane/loki/routes.ts` extend `ownedLoki` (used only by the mutating `PATCH` and `pair` routes) so a synced row is refused with the same shape through `safeError`:

```ts
async function ownedLoki(auth: FullAuthCtx, rawId: string) {
  const parsedId = upstreamId.safeParse(rawId)
  if (!parsedId.success) throw new LokiSyncError("upstream_not_found", 404)
  const row = await loadOwned(auth, () => getRepo().upstreams.getById(parsedId.data))
  if (!row || row.provider !== "loki") throw new LokiSyncError("upstream_not_found", 404)
  if (row.syncSourceId) throw new LokiSyncError("synced_upstream_read_only", 409)
  return { row, id: parsedId.data }
}
```

In `packages/gateway/src/control-plane/lib/github.ts` add `import { SyncedUpstreamReadOnlyError } from '../sync/read-only.ts'` and:

1. In `addGithubAccount`, as the first statements after `const repo = getRepo().github`:

```ts
  // A row synced from another gateway is read-only: refuse before any credential is stored.
  if ((await getRepo().upstreams.getById(copilotUpstreamRowId(ownerId ?? '', user.id)))?.syncSourceId) {
    throw new SyncedUpstreamReadOnlyError()
  }
```

2. In `removeGithubAccount`, as the first statements after `const repo = getRepo().github`:

```ts
  if ((await getRepo().upstreams.getById(copilotUpstreamRowId(ownerId ?? '', userId)))?.syncSourceId) {
    throw new SyncedUpstreamReadOnlyError()
  }
```

In `packages/gateway/src/control-plane/auth/github-routes.ts` add `import { syncedReadOnlyResponseFor } from '../sync/read-only.ts'` and wrap the three calls so the error becomes the `409`:

```ts
    try {
      await addGithubAccount(data.access_token, user, accountType, userId as UserId | undefined, {
        githubHost: GITHUB_DOTCOM_HOST,
        source: 'device-flow',
        // Passed through as-is, not `?? []`: absent means "keep whatever chain
        // the row already has", so a re-login cannot wipe a later edit.
        proxyFallbackList: proxy_fallback_list,
      })
    } catch (error) {
      const blocked = syncedReadOnlyResponseFor(error)
      if (blocked) return blocked
      throw error
    }
```

(replacing the existing call at lines 206-212),

```ts
  try {
    await addGithubAccount(github_token, user, accountType, userId as UserId | undefined, {
      githubHost: host,
      source: 'paste',
      copilotApiEndpoint,
      // Passed through as-is, not `?? []`: absent means "keep whatever chain
      // the row already has", so a re-paste cannot wipe a later edit.
      proxyFallbackList: proxy_fallback_list,
    })
  } catch (error) {
    const blocked = syncedReadOnlyResponseFor(error)
    if (blocked) return blocked
    throw error
  }
```

(replacing the call at lines 295-302), and

```ts
  try {
    await removeGithubAccount(ghUserId as GitHubAccountId, userId as UserId)
  } catch (error) {
    const blocked = syncedReadOnlyResponseFor(error)
    if (blocked) return blocked
    throw error
  }
```

(replacing line 339).

- [ ] **Step 6: Export and import**

In `packages/gateway/src/control-plane/lib/import-export.ts` replace line 117

```ts
  const upstreamsIn = (input.upstreams ?? []).map(withoutLokiAuthority)
```

with

```ts
  // Synced upstreams are rebuilt by sync and must not enter a backup (nor any credential they carry).
  const upstreamsIn = (input.upstreams ?? []).filter(u => !(u as { syncSourceId?: string }).syncSourceId).map(withoutLokiAuthority)
```

In `packages/gateway/src/control-plane/data-transfer/routes.ts`, in `POST /import`, after `const merged = unredactWithLive(...)` (before the `if (mode === 'replace')` block) add:

```ts
  // Synced upstreams belong to the sync source. A bundle never overrides them, and a replace is followed by a sync.
  const syncedIds = new Set(liveUpstreams.filter((u) => u.syncSourceId).map((u) => u.id))
  const importable = merged.upstreams.filter((u) => !syncedIds.has(u.id))
```

then change the upstream loop and the response to use `importable`:

```ts
  for (const upstream of importable) {
    await repo.upstreams.save(upstream)
  }
```

and `upstreams: importable.length,` inside `imported`.

- [ ] **Step 7: Run the tests and typecheck**

```bash
bun test ./packages/gateway/tests/sync-read-only.sqlite.test.ts ./packages/gateway/tests/control-plane-upstreams.test.ts ./packages/gateway/tests/control-plane-data-transfer.test.ts ./packages/gateway/tests/control-plane-loki.sqlite.test.ts ./packages/gateway/tests/control-plane-github-lib.test.ts ./packages/gateway/tests/control-plane-auth-github.test.ts ./packages/gateway/tests/control-plane-github-accounts.test.ts ./packages/gateway/tests/control-plane-codex-import.sqlite.test.ts ./packages/gateway/tests/codex-public-dto.test.ts ./packages/gateway/tests/control-plane-credential-boundary.sqlite.test.ts
bun run --filter '@vibe-llm/gateway' typecheck
```

Expected: PASS and a clean typecheck. If a test with a hand-built fake repo now fails because it lacks `upstreams.getById` or `syncSources`, give that fake the missing no-op (`getById: async () => null`); do not weaken the production guard.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/control-plane/sync/read-only.ts packages/gateway/src/control-plane/upstreams/routes.ts \
  packages/gateway/src/control-plane/upstreams/codex-credentials-routes.ts packages/gateway/src/control-plane/upstreams/public-dto.ts \
  packages/gateway/src/control-plane/loki/routes.ts packages/gateway/src/control-plane/lib/github.ts \
  packages/gateway/src/control-plane/auth/github-routes.ts packages/gateway/src/control-plane/lib/import-export.ts \
  packages/gateway/src/control-plane/data-transfer/routes.ts packages/gateway/tests/sync-read-only.sqlite.test.ts
git commit -F - <<'EOF'
feat(vnext/gateway): keep synced upstreams read-only and out of backups

Only enable, order and proxies change on a device; every other write returns
409 synced_upstream_read_only.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 11: End-to-end test in one process

One test process hosts two gateways by swapping the global repository (`initRepo`) between a central and a device `BunSqliteRepo`. The device's outbound `fetch` to `https://central.example` is answered by the real central `app` after switching the global repo to the central one, then switching back; everything else (`api.github.com`, `api.githubcopilot.com`, `loki.delve.office.com`) is a stub. Calls run one at a time, so the swap never interleaves.

The test covers the spec's end-to-end line: issue, import, inference through synced Copilot and Loki upstreams using synced credentials, the central selection changing, the next sync adding and removing upstreams, a Loki token rotation without a generation bump, then revocation removing the synced upstreams.

**Files:**
- Test: `packages/gateway/tests/sync-e2e.sqlite.test.ts` (create)

If a data-plane request in this test is rejected for a reason that is about the fixture (model shape, headers), copy the working fixture from `tests/loki-inference.sqlite.test.ts` (Loki) or `tests/data-plane-models-embeddings-images.test.ts` (Copilot) and adjust only the test. Do not change production code to make a fixture pass; a failure that is about sync (missing row, wrong credential, extra central call) is a real defect to fix in the task that owns it.

- [ ] **Step 1: Write the test**

Create `packages/gateway/tests/sync-e2e.sqlite.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { app } from "../src/app"
import { _clearModelsMemoForTest } from "../src/data-plane/providers/registry"
import { initRepo } from "../src/repo/index"
import type { Repo } from "../src/repo/types"
import type { SessionToken, UpstreamId, UserId } from "../src/repo/branded-ids"
import { runScheduledSync } from "../src/sync/engine"
import { setupTestPlatform } from "./_setup-platform"
import { syntheticCopilotTokenResponse } from "./helpers/catalog-test-repo"
import { realFetch, stubGlobalFetch } from "./_stub-global-fetch"

const stamp = "2026-11-16T00:00:00.000Z"
const account = { homeAccountId: "home", tenantId: "11111111-1111-4111-8111-111111111111" }
const centralOwner = "central-owner" as UserId
const deviceOwner = "device-owner" as UserId
const centralSession = "ses_central_owner"
const deviceSession = "ses_device_owner"
const lokiState = (token: string) => ({ version: 1, profileId: "loki-df-v1", generation: "g", syncSecretHash: "pairing-hash", revision: 1,
  assistantStatus: "authorized", account, lastReceipt: { requestId: "r", payloadHash: "p" },
  credential: { accessToken: token, tokenType: "Bearer", expiresAt: Date.now() + 3_600_000, account } })
const copilotModel = { id: "gpt-4o", object: "model", name: "gpt-4o", vendor: "openai", version: "gpt-4o", model_picker_enabled: true, preview: false,
  capabilities: { family: "gpt-4o", limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 }, object: "model_capabilities",
    supports: {}, tokenizer: "o200k_base", type: "chat" } }

let central: BunSqliteRepo
let device: Repo
let current: Repo
const traffic = { central: 0, copilot: [] as string[], loki: [] as string[] }

const use = (repo: Repo) => { current = repo; initRepo(repo) }
async function onCentral<T>(run: () => Promise<T>): Promise<T> {
  const previous = current
  use(central)
  try { return await run() } finally { use(previous) }
}
const call = (host: "central" | "device", path: string, method = "GET", body?: unknown) => {
  use(host === "central" ? central : device)
  return app.request(`https://${host}.example${path}`, { method, headers: { authorization: `Bearer ${host === "central" ? centralSession : deviceSession}`,
    "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const inference = (path: string, body: unknown) => {
  use(device)
  return app.request(`https://device.example${path}`, { method: "POST",
    headers: { authorization: "Bearer device-inference-key", "content-type": "application/json", "X-ConversationId": "e2e-conversation" }, body: JSON.stringify(body) })
}
const deviceUpstreams = async () => ((await (await call("device", "/api/upstreams?includeDisabled=1")).json()) as
  { upstreams: Array<{ id: string; enabled: boolean; syncedFrom?: { origin: string | null } }> }).upstreams

beforeEach(async () => {
  const platform = setupTestPlatform()
  device = platform.repo
  central = new BunSqliteRepo(new Database(":memory:"))
  traffic.central = 0; traffic.copilot = []; traffic.loki = []
  _clearModelsMemoForTest()
  for (const [repo, id, token, email] of [[central, centralOwner, centralSession, "central@example.com"], [device, deviceOwner, deviceSession, "device@example.com"]] as const) {
    await repo.users.create({ id, name: id, email, createdAt: stamp, disabled: false })
    await repo.sessions.create({ token: token as SessionToken, userId: id, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await device.apiKeys.save({ id: "device-key", name: "inference", key: "device-inference-key", ownerId: deviceOwner,
    modelMappingsEnabled: false, modelMappings: [], createdAt: stamp })
  const base = { ownerId: centralOwner, enabled: true, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "trojan" }], createdAt: stamp, updatedAt: stamp }
  await central.upstreams.save({ ...base, id: "up_copilot_c", provider: "copilot", name: "Central Copilot", sortOrder: 1,
    config: { githubToken: "ghp_central_token", accountType: "individual", user: { id: 1, login: "octo" } }, state: null })
  await central.upstreams.save({ ...base, id: "up_loki_c", provider: "loki", name: "Central Loki", sortOrder: 2,
    config: { profileId: "loki-df-v1" }, state: lokiState("central-loki-token") })
  await central.upstreams.save({ ...base, id: "up_copilot_d", provider: "copilot", name: "Second Copilot", sortOrder: 3,
    config: { githubToken: "ghp_second_token", accountType: "individual", user: { id: 2, login: "octo2" } }, state: null })
  stubGlobalFetch(async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const url = new URL(request.url)
    if (url.origin === "https://central.example") {
      traffic.central++
      return onCentral(() => app.request(request.url, { method: request.method, headers: request.headers }))
    }
    const bearer = request.headers.get("authorization") ?? ""
    if (url.pathname.endsWith("/copilot_internal/v2/token")) return syntheticCopilotTokenResponse(request)!
    if (url.origin === "https://api.githubcopilot.com") {
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [copilotModel] })
      traffic.copilot.push(bearer)
      return Response.json({ id: "chatcmpl-1", object: "chat.completion", created: 1, model: "gpt-4o",
        choices: [{ index: 0, message: { role: "assistant", content: "hello from copilot" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    }
    if (url.origin === "https://loki.delve.office.com") {
      if (url.pathname.endsWith("/models")) return Response.json({ data: [{ id: "claude-opus-5.5", supported_endpoints: ["/v1/messages"] }] })
      traffic.loki.push(bearer)
      return Response.json({ id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5.5",
        content: [{ type: "text", text: "hello from loki" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    }
    throw new Error(`unexpected egress ${request.url}`)
  })
})
afterEach(() => { globalThis.fetch = realFetch; __resetPlatformForTests() })

test("issue, import, serve with synced credentials, follow central edits and token rotation, then lose everything on revoke", async () => {
  // 1. Central issues a document for the Copilot and Loki upstreams.
  const issued = await call("central", "/api/sync/devices", "POST", { label: "MacBook", upstreamIds: ["up_copilot_c", "up_loki_c"] })
  expect(issued.status).toBe(201)
  const { device: issuedDevice, document } = await issued.json() as { device: { id: string }; document: Record<string, string> }
  expect(document.gatewayOrigin).toBe("https://central.example")

  // 2. The device imports it: one sync, then the source is stored.
  const connected = await call("device", "/api/sync/source", "POST", { document })
  expect(connected.status).toBe(201)
  expect((await connected.json() as { source: { upstreamCount: number } }).source.upstreamCount).toBe(2)
  const rows = await deviceUpstreams()
  expect(rows.map(row => row.id)).toEqual(["up_copilot_c", "up_loki_c"])
  for (const row of rows) expect(row.syncedFrom).toEqual({ origin: "https://central.example" })
  expect(JSON.stringify(await device.upstreams.list({ includeDisabled: true }))).not.toContain("trojan")
  expect(await device.upstreams.getById("up_copilot_c" as UpstreamId)).toMatchObject({ proxyFallbackList: [], ownerId: deviceOwner })
  expect(JSON.stringify(await device.upstreams.getById("up_loki_c" as UpstreamId))).not.toContain("pairing-hash")

  // 3. Inference on the device uses the synced credentials and never calls central; nothing stored is rewritten.
  const writes: string[] = []
  for (const name of ["saveState", "replaceCredentials", "patchMetadata", "save", "createIfAbsent", "delete", "deleteAll"] as const) {
    const original = (device.upstreams[name] as (...args: unknown[]) => Promise<unknown>).bind(device.upstreams)
    ;(device.upstreams as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => { writes.push(name); return original(...args) }
  }
  const centralBefore = traffic.central
  const chat = await inference("/v1/chat/completions", { model: "gpt-4o", messages: [{ role: "user", content: "hello" }] })
  expect(chat.status, await chat.clone().text()).toBe(200)
  expect(await chat.text()).toContain("hello from copilot")
  const message = await inference("/v1/messages", { model: "claude-opus-5.5", max_tokens: 16, messages: [{ role: "user", content: "hello" }] })
  expect(message.status, await message.clone().text()).toBe(200)
  expect(await message.text()).toContain("hello from loki")
  expect(traffic.copilot).toEqual(["Bearer stored-fixture-token"])
  expect(traffic.loki).toEqual(["Bearer central-loki-token"])
  expect(traffic.central).toBe(centralBefore)
  expect(writes).toEqual([])

  // 4. Central edits the selection: drop Loki, add the second Copilot. The next sync removes and adds.
  use(device)
  expect(await runScheduledSync()).toBe("not_modified")
  const edited = await call("central", `/api/sync/devices/${issuedDevice.id}`, "PATCH", { upstreamIds: ["up_copilot_c", "up_copilot_d"] })
  expect(edited.status).toBe(200)
  use(device)
  expect(await runScheduledSync()).toBe("applied")
  expect((await deviceUpstreams()).map(row => row.id)).toEqual(["up_copilot_c", "up_copilot_d"])

  // 5. The Loki upstream comes back, device-local fields survive, and a later token rotation reaches the device
  //    without advancing generations.
  await call("device", "/api/upstreams/up_copilot_c", "PATCH", { enabled: false })
  expect((await call("central", `/api/sync/devices/${issuedDevice.id}`, "PATCH", { upstreamIds: ["up_copilot_c", "up_loki_c"] })).status).toBe(200)
  use(device)
  expect(await runScheduledSync()).toBe("applied")
  expect((await deviceUpstreams()).map(row => [row.id, row.enabled])).toEqual([["up_copilot_c", false], ["up_loki_c", true]])
  const before = (await device.upstreams.getById("up_loki_c" as UpstreamId))!
  await central.upstreams.saveState<unknown>("up_loki_c" as UpstreamId, () => lokiState("rotated-loki-token"))
  use(device)
  expect(await runScheduledSync()).toBe("applied")
  const after = (await device.upstreams.getById("up_loki_c" as UpstreamId))!
  expect([after.catalogGeneration, after.credentialGeneration]).toEqual([before.catalogGeneration, before.credentialGeneration])
  const rotated = await inference("/v1/messages", { model: "claude-opus-5.5", max_tokens: 16, messages: [{ role: "user", content: "hello" }] })
  expect(rotated.status, await rotated.clone().text()).toBe(200)
  expect(traffic.loki.at(-1)).toBe("Bearer rotated-loki-token")

  // 6. Revoking on central removes every synced upstream from the device on its next sync, then polling stops.
  const revoked = await call("central", `/api/sync/devices/${issuedDevice.id}`, "DELETE")
  expect(revoked.status).toBe(200)
  use(device)
  expect(await runScheduledSync()).toBe("revoked")
  expect(await deviceUpstreams()).toEqual([])
  expect(await device.syncSources.get()).toMatchObject({ status: "revoked" })
  const calls = traffic.central
  expect(await runScheduledSync()).toBe("idle")
  expect(traffic.central).toBe(calls)
})
```

- [ ] **Step 2: Run the test**

Run: `bun test ./packages/gateway/tests/sync-e2e.sqlite.test.ts`

Expected: PASS. If a step fails, identify the owning task (central routes: Tasks 4-5; apply: Tasks 3 and 7; engine: Task 8; source routes: Task 9; read-only: Task 10; providers: Task 2) and fix there with a regression test in that task's test file, then re-run.

- [ ] **Step 3: Run the whole sync test family together**

```bash
bun test ./packages/gateway/tests/sync-*.test.ts packages/provider-loki
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/tests/sync-e2e.sqlite.test.ts
git commit -F - <<'EOF'
test(vnext/gateway): end-to-end gateway upstream sync in one process

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 12: Dashboard "Sync devices" section (central gateway)

Pure helpers carry the logic that is easy to test (document validation, error mapping, checklist rules); the section is a thin container around a presentational view rendered with `react-dom/server` in tests, the way `loki-settings.test.tsx` does it. The dashboard learns which providers are syncable from the `syncable` flag the server now puts on each upstream (Task 10), so there is no client-side provider list to drift.

**Files:**
- Create: `apps/dashboard/src/api/sync.ts`
- Modify: `apps/dashboard/src/api/types.ts` (inside `UpstreamRecord`, after `tokenExpiredAt`, around line 49)
- Create: `apps/dashboard/src/tabs/upstreams/sync-document.ts`, `sync-errors.ts`, `sync-devices.ts`, `SyncDevicesSection.tsx`
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx` (import near line 15; after the `Card` that ends at line 362)
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (insert after the `dash.lokiExpired` line in each locale)
- Test: `sync-document.test.ts`, `sync-errors.test.ts`, `sync-devices.test.ts`, `SyncDevicesSection.test.tsx` (all under `apps/dashboard/src/tabs/upstreams/`)

- [ ] **Step 1: Write the failing tests**

Create `apps/dashboard/src/tabs/upstreams/sync-document.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { SyncDocument } from "../../api/sync"
import { formatSyncDocument, httpsOrigin, parseSyncDocumentText } from "./sync-document"

const doc: SyncDocument = { version: 1, kind: "gateway-sync", gatewayOrigin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`,
  deviceSecret: `sds_${"2".repeat(64)}` }

test("a document issued by this gateway formats, and one naming another gateway or carrying a wrong secret does not", () => {
  expect(JSON.parse(formatSyncDocument(doc, "https://central.example"))).toEqual(doc)
  expect(JSON.parse(formatSyncDocument({ ...doc, gatewayOrigin: "https://CENTRAL.example/" }, "https://central.example")).gatewayOrigin).toBe("https://central.example")
  expect(() => formatSyncDocument(doc, "https://other.example")).toThrow()
  expect(() => formatSyncDocument(doc, "http://central.example")).toThrow()
  expect(() => formatSyncDocument({ ...doc, deviceSecret: `lks_${"2".repeat(64)}` }, "https://central.example")).toThrow()
})

test("pasted text parses to a document, or null for anything invalid", () => {
  expect(parseSyncDocumentText(` ${JSON.stringify(doc)}\n`)).toEqual(doc)
  for (const text of ["", "{", "[]", JSON.stringify({ ...doc, kind: "loki-mirror" }), JSON.stringify({ ...doc, extra: 1 }),
    JSON.stringify({ ...doc, version: 2 }), JSON.stringify({ ...doc, deviceId: "sdv_short" }), JSON.stringify({ ...doc, gatewayOrigin: "http://central.example" })]) {
    expect(parseSyncDocumentText(text)).toBeNull()
  }
})

test("origins are normalized like the server and unsafe forms are rejected", () => {
  expect(parseSyncDocumentText(JSON.stringify({ ...doc, gatewayOrigin: "https://central.example/" }))?.gatewayOrigin).toBe("https://central.example")
  for (const gatewayOrigin of ["https://central.example/path", "https://central.example?x=1", "https://central.example/#f", "https://user:pw@central.example", "not a url"]) {
    expect(parseSyncDocumentText(JSON.stringify({ ...doc, gatewayOrigin }))).toBeNull()
    expect(httpsOrigin(gatewayOrigin)).toBeNull()
  }
})
```

Create `apps/dashboard/src/tabs/upstreams/sync-errors.test.ts`:

```ts
import { expect, test } from "bun:test"
import { ApiError } from "../../api/client"
import { installDictionary } from "../../state/i18n-fixture"
import { syncDeviceErrorKey, syncLastErrorKey, syncSourceErrorKey } from "./sync-errors"

const fail = (code: string) => new ApiError(400, { error: { code } }, code)

test("device errors map to specific copy", () => {
  expect(syncDeviceErrorKey(fail("https_required"))).toBe("dash.syncDeviceHttpsRequired")
  expect(syncDeviceErrorKey(fail("device_limit"))).toBe("dash.syncDeviceLimit")
  expect(syncDeviceErrorKey(fail("invalid_upstreams"))).toBe("dash.syncDeviceInvalidUpstreams")
  expect(syncDeviceErrorKey(fail("boom"))).toBe("dash.syncDeviceError")
  expect(syncDeviceErrorKey(new Error("network"))).toBe("dash.syncDeviceError")
})

test("source errors map to specific copy", () => {
  expect(syncSourceErrorKey(fail("invalid_sync_document"))).toBe("dash.syncSourceRejected")
  expect(syncSourceErrorKey(fail("sync_unreachable"))).toBe("dash.syncSourceUnreachable")
  expect(syncSourceErrorKey(fail("sync_source_exists"))).toBe("dash.syncSourceExists")
  expect(syncSourceErrorKey(fail("sync_source_not_found"))).toBe("dash.syncSourceGone")
  expect(syncSourceErrorKey(fail("device_sync_unavailable"))).toBe("dash.syncSourceUnavailable")
  expect(syncSourceErrorKey(fail("invalid_request"))).toBe("dash.syncSourceError")
  expect(syncSourceErrorKey(undefined)).toBe("dash.syncSourceError")
})

test("stored sync error codes map to copy", () => {
  expect(syncLastErrorKey(null)).toBeNull()
  expect(syncLastErrorKey("unreachable")).toBe("dash.syncErrorUnreachable")
  expect(syncLastErrorKey("id_conflict")).toBe("dash.syncErrorIdConflict")
  expect(syncLastErrorKey("something_new")).toBe("dash.syncErrorUnknown")
})

test("every key these helpers can return has English and Chinese copy", () => {
  const keys = new Set<string>()
  for (const code of ["https_required", "device_limit", "invalid_upstreams", "x"]) keys.add(syncDeviceErrorKey(fail(code)))
  for (const code of ["invalid_sync_document", "sync_unreachable", "sync_source_exists", "sync_source_not_found", "device_sync_unavailable", "x"]) keys.add(syncSourceErrorKey(fail(code)))
  for (const code of ["unreachable", "http_error", "bad_response", "id_conflict", "unsupported_provider", "apply_failed", "x"]) keys.add(syncLastErrorKey(code)!)
  for (const lang of ["en", "zh"] as const) {
    const restore = installDictionary(lang)
    try {
      // The dictionary lookup is the global window.t installed by the fixture.
      const t = (window as unknown as { t: (key: string) => string }).t
      for (const key of keys) expect(t(key), `${lang} ${key}`).not.toBe(key)
    } finally { restore() }
  }
})
```

Create `apps/dashboard/src/tabs/upstreams/sync-devices.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { SyncDevice } from "../../api/sync"
import type { UpstreamRecord } from "../../api/types"
import { canSubmitDevice, initialSelection, selectableUpstreams, syncedCount, toggleSelection } from "./sync-devices"

const row = (over: Partial<UpstreamRecord>): UpstreamRecord => ({ id: "u", provider: "copilot", name: "n", enabled: true, sortOrder: 0, config: {},
  disabledPublicModelIds: [], createdAt: "", updatedAt: "", ownerId: "me", syncable: true, ...over })
const device = (upstreamIds: string[]): SyncDevice => ({ id: "sdv_x", label: "MacBook", upstreamIds, createdAt: "", lastSyncAt: null })

test("the checklist offers the owner's own upstreams and disables providers that cannot sync", () => {
  const rows = [row({ id: "a" }), row({ id: "b", provider: "custom", syncable: undefined }), row({ id: "c", ownerId: "other" }),
    row({ id: "d", syncedFrom: { origin: "https://central.example" } })]
  expect(selectableUpstreams(rows, "me")).toEqual([
    { id: "a", name: "n", provider: "copilot", syncable: true },
    { id: "b", name: "n", provider: "custom", syncable: false },
  ])
})

test("selection toggles, starts from the still-selectable ids, and counts only live syncable upstreams", () => {
  expect(toggleSelection(["a"], "b")).toEqual(["a", "b"])
  expect(toggleSelection(["a", "b"], "a")).toEqual(["b"])
  const available = selectableUpstreams([row({ id: "a" }), row({ id: "b", provider: "custom", syncable: false })], "me")
  expect(initialSelection(device(["a", "b", "gone"]), available)).toEqual(["a"])
  expect(initialSelection(null, available)).toEqual([])
  expect(syncedCount(device(["a", "b", "gone"]), available)).toBe(1)
})

test("a device needs a trimmed label of at most 64 characters and no request in flight", () => {
  expect(canSubmitDevice("MacBook", false)).toBe(true)
  expect(canSubmitDevice("   ", false)).toBe(false)
  expect(canSubmitDevice("x".repeat(65), false)).toBe(false)
  expect(canSubmitDevice("MacBook", true)).toBe(false)
})
```

Create `apps/dashboard/src/tabs/upstreams/SyncDevicesSection.test.tsx`:

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SyncDevicesView, type SyncDevicesViewProps } from "./SyncDevicesSection"

const noop = () => {}
const upstreams = [{ id: "up_copilot", name: "Copilot", provider: "copilot" as const, syncable: true },
  { id: "up_custom", name: "Custom", provider: "custom" as const, syncable: false }]
const device = { id: `sdv_${"1".repeat(32)}`, label: "MacBook", upstreamIds: ["up_copilot"], createdAt: "2026-11-16T00:00:00.000Z", lastSyncAt: null }
const view = (over: Partial<SyncDevicesViewProps> = {}) => renderToStaticMarkup(<SyncDevicesView devices={[]} upstreams={upstreams} form={null}
  issued={null} busy={false} error="" copied={false} secureOrigin onNew={noop} onEdit={noop} onLabel={noop} onToggle={noop} onSave={noop}
  onCancel={noop} onRevoke={noop} onCopy={noop} onDownload={noop} {...over} />)

test("with no devices the section explains itself and offers to add one", () => {
  const html = view()
  expect(html).toContain("dash.syncDevicesTitle")
  expect(html).toContain("dash.syncDevicesDescription")
  expect(html).toContain("dash.syncDeviceNone")
  expect(html).toContain("dash.syncDeviceNew")
})

test("a device row shows its label, synced count and last sync with edit and revoke", () => {
  const html = view({ devices: [device, { ...device, id: `sdv_${"2".repeat(32)}`, label: "Desktop", lastSyncAt: "2026-11-16T10:00:00.000Z" }] })
  expect(html).toContain("MacBook")
  expect(html).toContain("Desktop")
  expect(html).toContain("dash.syncDeviceCount")
  expect(html).toContain("dash.syncNever")
  expect(html).toContain("dash.syncDeviceLastSync")
  expect(html).toContain("dash.edit")
  expect(html).toContain("dash.syncDeviceRevoke")
})

test("the form lists upstreams, disables unsupported providers and issues or saves", () => {
  const html = view({ form: { id: null, label: "Mac", selected: ["up_copilot"] } })
  const boxes = html.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []
  expect(boxes).toHaveLength(2)
  expect(boxes[0]).toContain("checked")
  expect(boxes[0]).not.toContain("disabled")
  expect(boxes[1]).toContain("disabled")
  expect(html.match(/dash\.syncDeviceNotSupported/g)).toHaveLength(1)
  expect(html).toContain("dash.syncDeviceIssue")
  expect(view({ form: { id: device.id, label: "Mac", selected: [] } })).toContain("dash.save")
})

test("an issued document is shown once with copy and download", () => {
  const html = view({ issued: { text: '{ "kind": "gateway-sync" }' } })
  expect(html).toContain("gateway-sync")
  expect(html).toContain("dash.syncDeviceSecretHint")
  expect(html).toContain("dash.syncDeviceCopy")
  expect(html).toContain("dash.syncDeviceDownload")
  expect(view({ issued: { text: "x" }, copied: true })).toContain("dash.syncDeviceCopied")
})

test("plain HTTP warns and cannot issue, and errors show as alerts", () => {
  const html = view({ secureOrigin: false, error: "dash.syncDeviceError" })
  expect(html).toContain("dash.syncDeviceHttpsRequired")
  expect(html).toContain('role="alert"')
  expect(html.match(/<button[^>]*disabled[^>]*>[^<]*dash\.syncDeviceNew/)).not.toBeNull()
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test apps/dashboard/src/tabs/upstreams/sync-document.test.ts apps/dashboard/src/tabs/upstreams/sync-errors.test.ts apps/dashboard/src/tabs/upstreams/sync-devices.test.ts apps/dashboard/src/tabs/upstreams/SyncDevicesSection.test.tsx`

Expected: FAIL: none of the modules exist.

- [ ] **Step 3: API client and types**

Create `apps/dashboard/src/api/sync.ts`:

```ts
import { api } from "./client"

export interface SyncDevice {
  id: string
  label: string
  upstreamIds: string[]
  createdAt: string
  lastSyncAt: string | null
}

export interface SyncDocument {
  version: 1
  kind: "gateway-sync"
  gatewayOrigin: string
  deviceId: string
  deviceSecret: string
}

export interface SyncSourceView {
  origin: string
  deviceId: string
  status: "active" | "revoked"
  lastAttemptAt: string | null
  lastSuccessAt: string | null
  lastError: string | null
  upstreamCount: number
}

export const listSyncDevices = () => api<{ devices: SyncDevice[] }>("/api/sync/devices")
export const issueSyncDevice = (body: { label: string; upstreamIds: string[] }) =>
  api<{ device: SyncDevice; document: unknown }>("/api/sync/devices", { method: "POST", body })
export const updateSyncDevice = (id: string, body: { label?: string; upstreamIds?: string[] }) =>
  api<{ device: SyncDevice }>(`/api/sync/devices/${encodeURIComponent(id)}`, { method: "PATCH", body })
export const revokeSyncDevice = (id: string) =>
  api<{ devices: SyncDevice[] }>(`/api/sync/devices/${encodeURIComponent(id)}`, { method: "DELETE" })

export const getSyncSource = () => api<{ available: boolean; source: SyncSourceView | null }>("/api/sync/source")
export const connectSyncSource = (document: SyncDocument) =>
  api<{ source: SyncSourceView }>("/api/sync/source", { method: "POST", body: { document } })
export const replaceSyncSource = (document: SyncDocument) =>
  api<{ source: SyncSourceView }>("/api/sync/source", { method: "PUT", body: { document } })
export const disconnectSyncSource = () => api<{ source: null }>("/api/sync/source", { method: "DELETE" })
```

In `apps/dashboard/src/api/types.ts`, inside `UpstreamRecord`, after the `tokenExpiredAt?: string` line add:

```ts
  /** The provider may be selected for gateway sync. */
  syncable?: boolean
  /** Set on rows created by a sync source; `origin` is null when the source is gone. */
  syncedFrom?: { origin: string | null }
```

- [ ] **Step 4: Pure helpers**

Create `apps/dashboard/src/tabs/upstreams/sync-document.ts`:

```ts
// Client-side validation mirroring `parseSyncDocument` in the gateway; the server re-validates.
import type { SyncDocument } from "../../api/sync"

const KEYS = ["version", "kind", "gatewayOrigin", "deviceId", "deviceSecret"]

/** The normalized origin of a bare HTTPS origin, or null. Mirrors the server's rules. */
export function httpsOrigin(value: string): string | null {
  if (/[?#\s\\]/.test(value)) return null
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" ? url.origin : null
  } catch { return null }
}

function validDocument(value: unknown): SyncDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const doc = value as Record<string, unknown>
  if (Object.keys(doc).some(key => !KEYS.includes(key)) || doc.version !== 1 || doc.kind !== "gateway-sync"
    || typeof doc.gatewayOrigin !== "string" || typeof doc.deviceId !== "string" || !/^sdv_[a-f0-9]{32}$/.test(doc.deviceId)
    || typeof doc.deviceSecret !== "string" || !/^sds_[a-f0-9]{64}$/.test(doc.deviceSecret)) return null
  const origin = httpsOrigin(doc.gatewayOrigin)
  return origin ? { version: 1, kind: "gateway-sync", gatewayOrigin: origin, deviceId: doc.deviceId, deviceSecret: doc.deviceSecret } : null
}

/** Parses pasted text; null when it is not a valid document. */
export function parseSyncDocumentText(text: string): SyncDocument | null {
  try { return validDocument(JSON.parse(text.trim())) } catch { return null }
}

/** Formats a freshly issued document, refusing one that names another gateway. */
export function formatSyncDocument(value: unknown, expectedOrigin: string): string {
  const doc = validDocument(value)
  if (!doc || doc.gatewayOrigin !== httpsOrigin(expectedOrigin)) throw new Error("Invalid sync document")
  return JSON.stringify(doc, null, 2)
}
```

Create `apps/dashboard/src/tabs/upstreams/sync-errors.ts`:

```ts
import { settingsError } from "./loki-errors"

/** Copy key for a failed device issue, edit or revoke. */
export function syncDeviceErrorKey(error: unknown): string {
  switch (settingsError(error)) {
    case "https_required": return "dash.syncDeviceHttpsRequired"
    case "device_limit": return "dash.syncDeviceLimit"
    case "invalid_upstreams": return "dash.syncDeviceInvalidUpstreams"
    default: return "dash.syncDeviceError"
  }
}

/** Copy key for a failed connect, replace or disconnect on a device. */
export function syncSourceErrorKey(error: unknown): string {
  switch (settingsError(error)) {
    case "invalid_sync_document": return "dash.syncSourceRejected"
    case "sync_unreachable": return "dash.syncSourceUnreachable"
    case "sync_source_exists": return "dash.syncSourceExists"
    case "sync_source_not_found": return "dash.syncSourceGone"
    case "device_sync_unavailable": return "dash.syncSourceUnavailable"
    default: return "dash.syncSourceError"
  }
}

const LAST_ERROR_KEYS: Record<string, string> = {
  unreachable: "dash.syncErrorUnreachable", http_error: "dash.syncErrorHttp", bad_response: "dash.syncErrorBadResponse",
  id_conflict: "dash.syncErrorIdConflict", unsupported_provider: "dash.syncErrorUnsupportedProvider", apply_failed: "dash.syncErrorApplyFailed",
}

/** Copy key for a stored `last_error`; null when there is none. */
export function syncLastErrorKey(code: string | null): string | null {
  return code === null ? null : LAST_ERROR_KEYS[code] ?? "dash.syncErrorUnknown"
}
```

Create `apps/dashboard/src/tabs/upstreams/sync-devices.ts`:

```ts
import type { SyncDevice } from "../../api/sync"
import type { UpstreamRecord } from "../../api/types"

export interface SelectableUpstream {
  id: string
  name: string
  provider: UpstreamRecord["provider"]
  syncable: boolean
}

/** The owner's own upstreams for the checklist. Rows synced from elsewhere are not offered onward. */
export function selectableUpstreams(rows: readonly UpstreamRecord[], ownerId: string): SelectableUpstream[] {
  return rows.filter(row => row.ownerId === ownerId && !row.syncedFrom)
    .map(row => ({ id: row.id, name: row.name, provider: row.provider, syncable: row.syncable === true }))
}

export const toggleSelection = (selected: readonly string[], id: string): string[] =>
  selected.includes(id) ? selected.filter(entry => entry !== id) : [...selected, id]

/** The selection a form starts from: a device's ids that are still present and syncable. */
export function initialSelection(device: Pick<SyncDevice, "upstreamIds"> | null, upstreams: readonly SelectableUpstream[]): string[] {
  return device ? device.upstreamIds.filter(id => upstreams.some(upstream => upstream.id === id && upstream.syncable)) : []
}

/** How many of a device's selected upstreams still exist and can sync (the server ignores stale ids too). */
export function syncedCount(device: Pick<SyncDevice, "upstreamIds">, upstreams: readonly SelectableUpstream[]): number {
  const live = new Set(upstreams.filter(upstream => upstream.syncable).map(upstream => upstream.id))
  return device.upstreamIds.filter(id => live.has(id)).length
}

export const canSubmitDevice = (label: string, busy: boolean): boolean => !busy && label.trim().length > 0 && label.trim().length <= 64
```

- [ ] **Step 5: The section**

Create `apps/dashboard/src/tabs/upstreams/SyncDevicesSection.tsx`:

```tsx
import { useCallback, useEffect, useId, useState } from "react"
import { issueSyncDevice, listSyncDevices, revokeSyncDevice, updateSyncDevice, type SyncDevice } from "../../api/sync"
import type { UpstreamRecord } from "../../api/types"
import { useConfirm } from "../../state/confirm"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { formatSyncDocument } from "./sync-document"
import { canSubmitDevice, initialSelection, selectableUpstreams, syncedCount, toggleSelection, type SelectableUpstream } from "./sync-devices"
import { syncDeviceErrorKey } from "./sync-errors"

/** `id: null` is a new device. */
export interface SyncDeviceForm { id: string | null; label: string; selected: string[] }

export interface SyncDevicesViewProps {
  devices: SyncDevice[]
  upstreams: SelectableUpstream[]
  form: SyncDeviceForm | null
  issued: { text: string } | null
  busy: boolean
  /** An already translated message. */
  error: string
  copied: boolean
  secureOrigin: boolean
  onNew: () => void
  onEdit: (device: SyncDevice) => void
  onLabel: (value: string) => void
  onToggle: (id: string) => void
  onSave: () => void
  onCancel: () => void
  onRevoke: (device: SyncDevice) => void
  onCopy: () => void
  onDownload: () => void
}

export function SyncDevicesView(props: SyncDevicesViewProps) {
  const t = useT()
  const titleId = useId()
  const { devices, upstreams, form, issued, busy } = props
  const time = (value: string | null) => value ? new Date(value).toLocaleString() : t("dash.syncNever")
  return <Card aria-labelledby={titleId} className="mt-4 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <SectionHeading id={titleId}>{t("dash.syncDevicesTitle")}</SectionHeading>
      <Button variant="secondary" size="sm" disabled={busy || !props.secureOrigin || form !== null} onClick={props.onNew}>{t("dash.syncDeviceNew")}</Button>
    </div>
    <p className="text-body text-fg-muted">{t("dash.syncDevicesDescription")}</p>
    {!props.secureOrigin ? <Notice tone="warn" role="status">{t("dash.syncDeviceHttpsRequired")}</Notice> : null}
    {devices.length ? <ul className="space-y-1 text-body">
      {devices.map(device => <li key={device.id} className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-medium text-fg">{device.label}</span>
          <span className="text-fg-muted"> · {t("dash.syncDeviceCount", { n: syncedCount(device, upstreams) })} · {t("dash.syncDeviceLastSync", { at: time(device.lastSyncAt) })}</span>
        </span>
        <span className="flex gap-1">
          <Button variant="ghost" size="sm" disabled={busy || form !== null} onClick={() => props.onEdit(device)}>{t("dash.edit")}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => props.onRevoke(device)} className="text-danger hover:text-danger">{t("dash.syncDeviceRevoke")}</Button>
        </span>
      </li>)}
    </ul> : <p className="text-body text-fg-subtle">{t("dash.syncDeviceNone")}</p>}
    {form ? <form className="space-y-3 border-t border-border pt-3" onSubmit={event => { event.preventDefault(); props.onSave() }}>
      <input type="text" value={form.label} maxLength={64} placeholder={t("dash.syncDeviceLabel")} aria-label={t("dash.syncDeviceLabel")}
        onChange={event => props.onLabel(event.target.value)} disabled={busy} />
      <fieldset className="space-y-1">
        <legend className="mb-1 text-xs font-medium text-fg-muted">{t("dash.syncDeviceUpstreams")}</legend>
        {upstreams.length ? upstreams.map(upstream => <label key={upstream.id} className="flex items-center gap-2 text-body">
          <input type="checkbox" checked={form.selected.includes(upstream.id)} disabled={busy || !upstream.syncable}
            onChange={() => props.onToggle(upstream.id)} />
          <span>{upstream.name}</span>
          <span className="font-mono text-xs text-fg-subtle">{upstream.provider}</span>
          {!upstream.syncable ? <span className="text-xs text-fg-subtle">{t("dash.syncDeviceNotSupported")}</span> : null}
        </label>) : <p className="text-body text-fg-subtle">{t("dash.syncDeviceNoUpstreams")}</p>}
      </fieldset>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!canSubmitDevice(form.label, busy)}>
          {busy ? t("dash.savingShort") : t(form.id === null ? "dash.syncDeviceIssue" : "dash.save")}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onCancel}>{t("dash.cancel")}</Button>
      </div>
    </form> : null}
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
    {issued ? <div className="space-y-2">
      <p className="text-xs text-fg-subtle">{t("dash.syncDeviceSecretHint")}</p>
      <textarea readOnly spellCheck={false} aria-label={t("dash.syncDeviceDocument")} value={issued.text}
        className="w-full bg-muted font-mono text-xs" rows={9} onFocus={event => event.target.select()} />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={props.onDownload}>{t("dash.syncDeviceDownload")}</Button>
        <Button variant="secondary" size="sm" onClick={props.onCopy}>{t(props.copied ? "dash.syncDeviceCopied" : "dash.syncDeviceCopy")}</Button>
      </div>
    </div> : null}
  </Card>
}

export function SyncDevicesSection({ upstreams, myOwnerId }: { upstreams: UpstreamRecord[]; myOwnerId: string }) {
  const t = useT()
  const confirm = useConfirm()
  const [devices, setDevices] = useState<SyncDevice[]>([])
  const [form, setForm] = useState<SyncDeviceForm | null>(null)
  const [issued, setIssued] = useState<{ text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const secureOrigin = window.location.protocol === "https:"
  const selectable = selectableUpstreams(upstreams, myOwnerId)

  const reload = useCallback(() => listSyncDevices().then(result => setDevices(result.devices))
    .catch(() => setError(t("dash.syncDeviceError"))), [t])
  useEffect(() => { void reload() }, [reload])

  const fail = (error: unknown) => setError(t(syncDeviceErrorKey(error)))
  const save = async () => {
    if (!form) return
    setBusy(true); setError(""); setCopied(false)
    try {
      if (form.id === null) {
        const result = await issueSyncDevice({ label: form.label.trim(), upstreamIds: form.selected })
        setDevices(list => [...list, result.device])
        try { setIssued({ text: formatSyncDocument(result.document, window.location.origin) }) }
        catch { setError(t("dash.syncDeviceOriginMismatch")) }
      } else {
        const result = await updateSyncDevice(form.id, { label: form.label.trim(), upstreamIds: form.selected })
        setDevices(list => list.map(device => device.id === result.device.id ? result.device : device))
      }
      setForm(null)
    } catch (error) { fail(error) }
    finally { setBusy(false) }
  }
  const revoke = async (device: SyncDevice) => {
    const sure = await confirm({ title: t("dash.syncDeviceRevokeConfirmTitle", { name: device.label }),
      description: t("dash.syncDeviceRevokeConfirmHint"), confirmLabel: t("dash.syncDeviceRevoke"), danger: true })
    if (!sure) return
    setBusy(true); setError("")
    try { setDevices((await revokeSyncDevice(device.id)).devices); setIssued(null) }
    catch (error) { fail(error) }
    finally { setBusy(false) }
  }

  return <SyncDevicesView devices={devices} upstreams={selectable} form={form} issued={issued} busy={busy} error={error} copied={copied}
    secureOrigin={secureOrigin}
    onNew={() => { setIssued(null); setError(""); setForm({ id: null, label: "", selected: [] }) }}
    onEdit={device => { setIssued(null); setError(""); setForm({ id: device.id, label: device.label, selected: initialSelection(device, selectable) }) }}
    onLabel={label => setForm(current => current && { ...current, label })}
    onToggle={id => setForm(current => current && { ...current, selected: toggleSelection(current.selected, id) })}
    onSave={() => void save()} onCancel={() => { setForm(null); setError("") }} onRevoke={device => void revoke(device)}
    onCopy={async () => {
      if (!issued) return
      try { await navigator.clipboard.writeText(issued.text); setCopied(true) }
      catch { setError(t("dash.lokiCopyError")) }
    }}
    onDownload={() => {
      if (!issued) return
      const url = URL.createObjectURL(new Blob([issued.text], { type: "application/json" }))
      const link = window.document.createElement("a")
      link.href = url
      link.download = "gateway-sync.json"
      window.document.body.appendChild(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }} />
}
```

In `apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx` add `import { SyncDevicesSection } from "./SyncDevicesSection"` after the `LokiPairingPanel` import (line 15) and render the section directly after the `Card` that holds the upstream groups (it ends with `</Card>` at line 362, before the `{deviceFlowOpen ? (` block):

```tsx
      <SyncDevicesSection upstreams={store.upstreams} myOwnerId={myOwnerId} />
```

- [ ] **Step 6: Copy (English and Chinese)**

This step adds the copy for the whole feature in one pass: both sections, the stored-error labels and the synced-row badge (Task 13 only uses keys defined here). Insert the following keys in `packages/gateway/src/shared/edge/ui-pages/i18n.ts`: the English block directly after the English `"dash.lokiExpired"` line and the Chinese block directly after the Chinese one. Run this script, which fails loudly if an anchor is missing or if a key already exists:

```bash
python3 -I - <<'PY'
p = "packages/gateway/src/shared/edge/ui-pages/i18n.ts"
s = open(p).read()
en = [
  ("dash.syncDevicesTitle", "Sync devices"),
  ("dash.syncDevicesDescription", "Select upstreams to mirror onto a device's local gateway. The device pulls them every minute. Proxies are never synced."),
  ("dash.syncDeviceNew", "Add device"),
  ("dash.syncDeviceLabel", "Device name"),
  ("dash.syncDeviceUpstreams", "Upstreams to sync"),
  ("dash.syncDeviceNotSupported", "not supported yet"),
  ("dash.syncDeviceNone", "No devices yet."),
  ("dash.syncDeviceNoUpstreams", "You have no upstreams to sync yet."),
  ("dash.syncDeviceIssue", "Issue sync document"),
  ("dash.syncDeviceCount", "{n} synced upstreams"),
  ("dash.syncDeviceLastSync", "last sync {at}"),
  ("dash.syncNever", "never"),
  ("dash.syncDeviceRevoke", "Revoke"),
  ("dash.syncDeviceRevokeConfirmTitle", "Revoke {name}?"),
  ("dash.syncDeviceRevokeConfirmHint", "All upstreams synced to this device will be removed from it."),
  ("dash.syncDeviceSecretHint", "Shown once. Paste it into the device gateway under Sync source. Keep it private."),
  ("dash.syncDeviceDocument", "Sync document"),
  ("dash.syncDeviceCopy", "Copy sync document"),
  ("dash.syncDeviceCopied", "Sync document copied"),
  ("dash.syncDeviceDownload", "Download sync document"),
  ("dash.syncDeviceHttpsRequired", "Open this gateway over HTTPS to issue a sync document."),
  ("dash.syncDeviceOriginMismatch", "The gateway reported a different address than this page. Check that your proxy forwards the original Host and scheme."),
  ("dash.syncDeviceLimit", "You already have 16 devices. Revoke one first."),
  ("dash.syncDeviceInvalidUpstreams", "Some selected upstreams can no longer be synced. Refresh and choose again."),
  ("dash.syncDeviceError", "Could not update sync devices. Refresh and try again."),
  ("dash.syncSourceTitle", "Sync source"),
  ("dash.syncSourceDescription", "Mirror selected upstreams from a central gateway. Synced upstreams stay read-only here except enabling, ordering and proxies."),
  ("dash.syncSourceDocument", "Sync document"),
  ("dash.syncSourcePasteHint", "Paste the sync document issued by the central gateway."),
  ("dash.syncSourceConnect", "Connect"),
  ("dash.syncSourceReplace", "Replace document"),
  ("dash.syncSourceDisconnect", "Disconnect"),
  ("dash.syncSourceDisconnectConfirmTitle", "Disconnect from {origin}?"),
  ("dash.syncSourceDisconnectConfirmHint", "All synced upstreams will be deleted from this gateway."),
  ("dash.syncSourceFrom", "Connected to {origin}"),
  ("dash.syncSourceLastSuccess", "last successful sync {at}"),
  ("dash.syncSourceLastAttempt", "last attempt {at}"),
  ("dash.syncSourceCount", "{n} synced upstreams"),
  ("dash.syncSourceRevokedNotice", "The central gateway revoked this device. Its synced upstreams were removed. Paste a new document to reconnect."),
  ("dash.syncSourceFailingNotice", "The last sync failed ({error}). The previous upstreams are kept and the sync retries every minute."),
  ("dash.syncSourceSkippedNotice", "Some upstreams were not synced ({error}). They are retried every minute."),
  ("dash.syncSourceDocumentInvalid", "This is not a valid sync document."),
  ("dash.syncSourceRejected", "The central gateway rejected this document. It may have been revoked; issue a new one."),
  ("dash.syncSourceUnreachable", "Could not reach the central gateway. Check the document's address and your network. Nothing was changed."),
  ("dash.syncSourceExists", "This gateway already has a sync source. Replace or disconnect it first."),
  ("dash.syncSourceUnavailable", "This gateway cannot sync from another gateway."),
  ("dash.syncSourceGone", "There is no sync source to change. Refresh and try again."),
  ("dash.syncSourceError", "Could not update the sync source. Refresh and try again."),
  ("dash.syncSourceConnected", "Connected. Upstreams synced."),
  ("dash.syncSourceReplaced", "Document replaced. Upstreams synced."),
  ("dash.syncErrorUnreachable", "central gateway unreachable"),
  ("dash.syncErrorHttp", "central gateway returned an error"),
  ("dash.syncErrorBadResponse", "unexpected response"),
  ("dash.syncErrorIdConflict", "a local upstream uses the same id"),
  ("dash.syncErrorUnsupportedProvider", "provider not supported by this gateway"),
  ("dash.syncErrorApplyFailed", "could not store upstreams"),
  ("dash.syncErrorUnknown", "unknown error"),
  ("dash.syncedBadge", "Synced from {origin}"),
  ("dash.syncedBadgeUnknown", "Synced"),
  ("dash.syncedHint", "Managed by the central gateway. Only enabling, order and proxies can change here."),
  ("dash.syncedLokiExpired", "Token expired; waiting for the central gateway"),
  ("dash.syncedLokiWaiting", "Waiting for the central gateway's token"),
]
zh = [
  ("dash.syncDevicesTitle", "同步设备"),
  ("dash.syncDevicesDescription", "选择要同步到设备本地网关的上游。设备每分钟拉取一次，代理不会被同步。"),
  ("dash.syncDeviceNew", "添加设备"),
  ("dash.syncDeviceLabel", "设备名称"),
  ("dash.syncDeviceUpstreams", "要同步的上游"),
  ("dash.syncDeviceNotSupported", "暂不支持"),
  ("dash.syncDeviceNone", "还没有设备。"),
  ("dash.syncDeviceNoUpstreams", "你还没有可同步的上游。"),
  ("dash.syncDeviceIssue", "签发同步文档"),
  ("dash.syncDeviceCount", "{n} 个同步上游"),
  ("dash.syncDeviceLastSync", "最近同步 {at}"),
  ("dash.syncNever", "从未"),
  ("dash.syncDeviceRevoke", "吊销"),
  ("dash.syncDeviceRevokeConfirmTitle", "吊销 {name}？"),
  ("dash.syncDeviceRevokeConfirmHint", "同步到此设备的所有上游都会从该设备上移除。"),
  ("dash.syncDeviceSecretHint", "只显示一次。请粘贴到设备网关的「同步来源」。请妥善保管。"),
  ("dash.syncDeviceDocument", "同步文档"),
  ("dash.syncDeviceCopy", "复制同步文档"),
  ("dash.syncDeviceCopied", "已复制同步文档"),
  ("dash.syncDeviceDownload", "下载同步文档"),
  ("dash.syncDeviceHttpsRequired", "请通过 HTTPS 打开此网关后再签发同步文档。"),
  ("dash.syncDeviceOriginMismatch", "网关报告的地址与当前页面不一致，请检查代理是否转发了原始 Host 和协议。"),
  ("dash.syncDeviceLimit", "你已有 16 台设备，请先吊销一台。"),
  ("dash.syncDeviceInvalidUpstreams", "所选的部分上游已无法同步，请刷新后重新选择。"),
  ("dash.syncDeviceError", "无法更新同步设备，请刷新后重试。"),
  ("dash.syncSourceTitle", "同步来源"),
  ("dash.syncSourceDescription", "从中心网关同步所选上游。同步来的上游在此只能启用或停用、排序和设置代理。"),
  ("dash.syncSourceDocument", "同步文档"),
  ("dash.syncSourcePasteHint", "粘贴中心网关签发的同步文档。"),
  ("dash.syncSourceConnect", "连接"),
  ("dash.syncSourceReplace", "替换文档"),
  ("dash.syncSourceDisconnect", "断开连接"),
  ("dash.syncSourceDisconnectConfirmTitle", "断开与 {origin} 的连接？"),
  ("dash.syncSourceDisconnectConfirmHint", "所有同步来的上游都会从此网关删除。"),
  ("dash.syncSourceFrom", "已连接到 {origin}"),
  ("dash.syncSourceLastSuccess", "最近成功同步 {at}"),
  ("dash.syncSourceLastAttempt", "最近尝试 {at}"),
  ("dash.syncSourceCount", "{n} 个同步上游"),
  ("dash.syncSourceRevokedNotice", "中心网关已吊销此设备，同步来的上游已被移除。请粘贴新的文档以重新连接。"),
  ("dash.syncSourceFailingNotice", "上次同步失败（{error}）。已保留之前的上游，每分钟会自动重试。"),
  ("dash.syncSourceSkippedNotice", "部分上游未同步（{error}），每分钟会自动重试。"),
  ("dash.syncSourceDocumentInvalid", "这不是有效的同步文档。"),
  ("dash.syncSourceRejected", "中心网关拒绝了这份文档，可能已被吊销，请重新签发。"),
  ("dash.syncSourceUnreachable", "无法连接中心网关，请检查文档中的地址和网络。未做任何更改。"),
  ("dash.syncSourceExists", "此网关已有同步来源，请先替换或断开。"),
  ("dash.syncSourceUnavailable", "此网关不支持从其他网关同步。"),
  ("dash.syncSourceGone", "没有可更改的同步来源，请刷新后重试。"),
  ("dash.syncSourceError", "无法更新同步来源，请刷新后重试。"),
  ("dash.syncSourceConnected", "已连接，上游已同步。"),
  ("dash.syncSourceReplaced", "已替换文档，上游已同步。"),
  ("dash.syncErrorUnreachable", "无法连接中心网关"),
  ("dash.syncErrorHttp", "中心网关返回了错误"),
  ("dash.syncErrorBadResponse", "响应无法识别"),
  ("dash.syncErrorIdConflict", "本地已有同 ID 的上游"),
  ("dash.syncErrorUnsupportedProvider", "此网关不支持该提供方"),
  ("dash.syncErrorApplyFailed", "无法保存上游"),
  ("dash.syncErrorUnknown", "未知错误"),
  ("dash.syncedBadge", "同步自 {origin}"),
  ("dash.syncedBadgeUnknown", "已同步"),
  ("dash.syncedHint", "由中心网关管理，此处只能启用或停用、排序和设置代理。"),
  ("dash.syncedLokiExpired", "令牌已过期，等待中心网关"),
  ("dash.syncedLokiWaiting", "等待中心网关的令牌"),
]
def block(pairs):
    return "".join(f'      "{key}": "{value}",\n' for key, value in pairs)
for key, _ in en + zh:
    assert f'"{key}"' not in s, key  # checked against the untouched file, before either locale is changed
blocks = ((('      "dash.lokiExpired": "Token expired; waiting for assistant",\n'), block(en)),
          (('      "dash.lokiExpired": "令牌已过期，等待助手续期",\n'), block(zh)))
for anchor, text in blocks:
    assert s.count(anchor) == 1, anchor
    s = s.replace(anchor, anchor + text)
open(p, "w").write(s)
PY
```

- [ ] **Step 7: Run the tests and checks**

```bash
bun test apps/dashboard ./packages/gateway/tests/i18n-keys.test.ts ./packages/gateway/tests/i18n-interpolation.test.ts
bun run --filter '@vibe-llm/dashboard' typecheck
```

Expected: PASS (the key-parity test proves every `t("dash.sync…")` literal exists in both locales) and a clean typecheck.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/api/sync.ts apps/dashboard/src/api/types.ts \
  apps/dashboard/src/tabs/upstreams/sync-document.ts apps/dashboard/src/tabs/upstreams/sync-errors.ts \
  apps/dashboard/src/tabs/upstreams/sync-devices.ts apps/dashboard/src/tabs/upstreams/SyncDevicesSection.tsx \
  apps/dashboard/src/tabs/upstreams/sync-document.test.ts apps/dashboard/src/tabs/upstreams/sync-errors.test.ts \
  apps/dashboard/src/tabs/upstreams/sync-devices.test.ts apps/dashboard/src/tabs/upstreams/SyncDevicesSection.test.tsx \
  apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -F - <<'EOF'
feat(vnext/dashboard): issue, edit and revoke sync devices

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 13: Dashboard "Sync source" section and synced rows (device gateway)

All copy used here was added in Task 12 (Step 6). The section hides itself when the server reports `available: false` (Workers) and while the first load is pending.

**Files:**
- Create: `apps/dashboard/src/tabs/upstreams/sync-source.ts`, `SyncSourceSection.tsx`, `loki-status.ts`
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx` (imports, the `const u = row` block, the name `h3`, the action buttons, the Loki status text), `UpstreamsTab.tsx` (import; after `<SyncDevicesSection …/>`)
- Test: `sync-source.test.ts`, `SyncSourceSection.test.tsx`, `loki-status.test.ts`, `UpstreamRow.synced.test.tsx` (all under `apps/dashboard/src/tabs/upstreams/`)

- [ ] **Step 1: Write the failing tests**

Create `apps/dashboard/src/tabs/upstreams/sync-source.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { SyncSourceView } from "../../api/sync"
import { sourceHealth } from "./sync-source"

const source = (over: Partial<SyncSourceView> = {}): SyncSourceView => ({ origin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`,
  status: "active", lastAttemptAt: null, lastSuccessAt: null, lastError: null, upstreamCount: 0, ...over })

test("health separates revoked, failing, partially skipped and fine sources", () => {
  expect(sourceHealth(source())).toBe("ok")
  expect(sourceHealth(source({ status: "revoked" }))).toBe("revoked")
  expect(sourceHealth(source({ status: "revoked", lastError: "unreachable" }))).toBe("revoked")
  for (const lastError of ["unreachable", "http_error", "bad_response", "apply_failed", "something_new"]) expect(sourceHealth(source({ lastError }))).toBe("failing")
  for (const lastError of ["id_conflict", "unsupported_provider"]) expect(sourceHealth(source({ lastError }))).toBe("skipped")
})
```

Create `apps/dashboard/src/tabs/upstreams/SyncSourceSection.test.tsx`:

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SyncSourceView } from "../../api/sync"
import { SyncSourceView as View, type SyncSourceViewProps } from "./SyncSourceSection"

const noop = () => {}
const source = (over: Partial<SyncSourceView> = {}): SyncSourceView => ({ origin: "https://central.example", deviceId: `sdv_${"1".repeat(32)}`,
  status: "active", lastAttemptAt: "2026-11-16T10:01:00.000Z", lastSuccessAt: "2026-11-16T10:00:00.000Z", lastError: null, upstreamCount: 2, ...over })
const view = (over: Partial<SyncSourceViewProps> = {}) => renderToStaticMarkup(<View available loaded source={null} text="" replacing={false}
  busy={false} error="" notice="" onText={noop} onConnect={noop} onToggleReplace={noop} onReplace={noop} onDisconnect={noop} {...over} />)

test("it renders nothing while loading or where device sync does not run", () => {
  expect(view({ loaded: false })).toBe("")
  expect(view({ available: false })).toBe("")
})

test("not connected: a document box and a Connect button that needs text", () => {
  const html = view()
  expect(html).toContain("dash.syncSourceTitle")
  expect(html).toContain("dash.syncSourcePasteHint")
  expect(html).toContain("<textarea")
  expect(html.match(/<button[^>]*disabled[^>]*>[^<]*dash\.syncSourceConnect/)).not.toBeNull()
  expect(view({ text: "{}" }).match(/<button[^>]*disabled[^>]*>[^<]*dash\.syncSourceConnect/)).toBeNull()
})

test("connected: origin, count, last sync, Replace document and Disconnect, and no secret", () => {
  const html = view({ source: source() })
  for (const key of ["dash.syncSourceFrom", "dash.syncSourceCount", "dash.syncSourceLastSuccess", "dash.syncSourceLastAttempt",
    "dash.syncSourceReplace", "dash.syncSourceDisconnect"]) expect(html).toContain(key)
  expect(html).not.toContain("<textarea")
  expect(html).not.toContain("sds_")
  expect(view({ source: source(), replacing: true })).toContain("<textarea")
})

test("revoked, failing and skipped sources explain themselves", () => {
  const revoked = view({ source: source({ status: "revoked" }) })
  expect(revoked).toContain("dash.syncSourceRevokedNotice")
  expect(revoked).toContain("<textarea")
  expect(view({ source: source({ lastError: "unreachable" }) })).toContain("dash.syncSourceFailingNotice")
  expect(view({ source: source({ lastError: "id_conflict" }) })).toContain("dash.syncSourceSkippedNotice")
  const fine = view({ source: source() })
  for (const key of ["dash.syncSourceRevokedNotice", "dash.syncSourceFailingNotice", "dash.syncSourceSkippedNotice"]) expect(fine).not.toContain(key)
})

test("errors alert and a success notice is a status", () => {
  const html = view({ error: "dash.syncSourceRejected", notice: "dash.syncSourceConnected" })
  expect(html).toContain('role="alert"')
  expect(html).toContain('role="status"')
})
```

Create `apps/dashboard/src/tabs/upstreams/loki-status.test.ts`:

```ts
import { expect, test } from "bun:test"
import { installDictionary } from "../../state/i18n-fixture"
import { lokiRowStatusKey } from "./loki-status"

const status = (over: Record<string, unknown> = {}) =>
  ({ assistantStatus: "authorized", tokenStatus: "valid", expiresAt: null, updatedAt: null, ...over }) as Parameters<typeof lokiRowStatusKey>[0]

test("a Loki row's status line depends on where its token comes from", () => {
  expect(lokiRowStatusKey(status({ tokenStatus: "expired" }), false)).toBe("dash.lokiExpired")
  expect(lokiRowStatusKey(status({ tokenStatus: "expired" }), true)).toBe("dash.syncedLokiExpired")
  expect(lokiRowStatusKey(status({ tokenStatus: "missing", assistantStatus: "waiting" }), true)).toBe("dash.syncedLokiWaiting")
  expect(lokiRowStatusKey(status({ tokenStatus: "missing", assistantStatus: "waiting" }), false)).toBe("dash.lokiWaiting")
  expect(lokiRowStatusKey(status(), false)).toBe("dash.lokiAuthorized")
  expect(lokiRowStatusKey(status(), true)).toBe("dash.lokiAuthorized")
  expect(lokiRowStatusKey(status({ assistantStatus: "interaction_required" }), false)).toBe("dash.lokiInteractionRequired")
  expect(lokiRowStatusKey(status({ assistantStatus: "failed" }), false)).toBe("dash.lokiFailed")
})

test("every status key has English and Chinese copy", () => {
  const keys = ["dash.lokiExpired", "dash.syncedLokiExpired", "dash.syncedLokiWaiting", "dash.lokiWaiting", "dash.lokiAuthorized",
    "dash.lokiInteractionRequired", "dash.lokiFailed"]
  for (const lang of ["en", "zh"] as const) {
    const restore = installDictionary(lang)
    try {
      const t = (window as unknown as { t: (key: string) => string }).t
      for (const key of keys) expect(t(key), `${lang} ${key}`).not.toBe(key)
    } finally { restore() }
  }
})
```

Create `apps/dashboard/src/tabs/upstreams/UpstreamRow.synced.test.tsx`:

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { UpstreamRecord } from "../../api/types"
import { ToastProvider } from "../../state/toast"
import { UpstreamRow } from "./UpstreamRow"

const noop = () => {}
const copilot: UpstreamRecord = { id: "up_copilot_s", provider: "copilot", name: "Copilot", enabled: true, sortOrder: 0,
  config: { user: { id: 1, login: "octo" } }, disabledPublicModelIds: [], createdAt: "", updatedAt: "", syncable: true }
const render = (row: UpstreamRecord) => renderToStaticMarkup(<ToastProvider><UpstreamRow row={row} index={1} total={3} busy={false} models={[]} showProxy
  onToggleEnabled={noop} onReorder={noop} onEdit={noop} onDuplicate={noop} onRefreshModels={noop} onRefreshCredential={noop} onReauth={noop} onDelete={noop} />
</ToastProvider>)

test("a synced row shows where it comes from and keeps only enable, reorder and proxy settings", () => {
  const html = render({ ...copilot, syncedFrom: { origin: "https://central.example" } })
  expect(html).toContain("dash.syncedBadge")
  expect(html).toContain("dash.syncedHint")
  expect(html).toContain("dash.moveUp")
  expect(html).toContain("dash.moveDown")
  expect(html).toContain("dash.reorderUpstreamHandle")
  expect(html).toContain("dash.proxyBtn")
  const toggle = html.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? ""
  expect(toggle).not.toContain("disabled")
  for (const removed of ["dash.edit", "dash.duplicateUpstream", "dash.refetchModelsLabel", "dash.codexRefreshCredential", "dash.reauthBtn", "dash.signOutBtn", "dash.delete"]) {
    expect(html, removed).not.toContain(removed)
  }
})

test("a synced row whose source is gone still says it is synced", () => {
  const html = render({ ...copilot, syncedFrom: { origin: null } })
  expect(html).toContain("dash.syncedBadgeUnknown")
})

test("an ordinary row keeps its full set of actions", () => {
  const html = render(copilot)
  expect(html).not.toContain("dash.syncedBadge")
  for (const kept of ["dash.edit", "dash.refetchModelsLabel", "dash.reauthBtn", "dash.signOutBtn", "dash.proxyBtn"]) expect(html, kept).toContain(kept)
})

test("a synced Loki row describes its token as coming from the central gateway", () => {
  const loki: UpstreamRecord = { ...copilot, id: "up_loki_s", provider: "loki", name: "Loki", config: {}, syncedFrom: { origin: "https://central.example" },
    lokiStatus: { assistantStatus: "authorized", tokenStatus: "expired", expiresAt: null, updatedAt: null } }
  expect(render(loki)).toContain("dash.syncedLokiExpired")
  expect(render({ ...loki, syncedFrom: undefined })).toContain("dash.lokiExpired")
})
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test apps/dashboard/src/tabs/upstreams/sync-source.test.ts apps/dashboard/src/tabs/upstreams/SyncSourceSection.test.tsx apps/dashboard/src/tabs/upstreams/loki-status.test.ts apps/dashboard/src/tabs/upstreams/UpstreamRow.synced.test.tsx`

Expected: FAIL: the new modules do not exist, and the row shows full actions for a synced row.

- [ ] **Step 3: Helpers**

Create `apps/dashboard/src/tabs/upstreams/sync-source.ts`:

```ts
import type { SyncSourceView } from "../../api/sync"

/** `skipped`: the snapshot applied but some entries could not be (they are retried). `failing`: the last poll or apply failed. */
export type SourceHealth = "revoked" | "failing" | "skipped" | "ok"

const SKIP_CODES = new Set(["id_conflict", "unsupported_provider"])

export function sourceHealth(source: Pick<SyncSourceView, "status" | "lastError">): SourceHealth {
  if (source.status === "revoked") return "revoked"
  if (source.lastError === null) return "ok"
  return SKIP_CODES.has(source.lastError) ? "skipped" : "failing"
}
```

Create `apps/dashboard/src/tabs/upstreams/loki-status.ts`:

```ts
import type { UpstreamRecord } from "../../api/types"

/** Copy key for a Loki row's status line. A synced row's token comes from the central gateway, not the Windows assistant. */
export function lokiRowStatusKey(status: NonNullable<UpstreamRecord["lokiStatus"]>, synced: boolean): string {
  if (status.tokenStatus === "expired") return synced ? "dash.syncedLokiExpired" : "dash.lokiExpired"
  if (synced && status.tokenStatus === "missing") return "dash.syncedLokiWaiting"
  return {
    waiting: "dash.lokiWaiting", authorized: "dash.lokiAuthorized",
    interaction_required: "dash.lokiInteractionRequired", failed: "dash.lokiFailed",
  }[status.assistantStatus]
}
```

- [ ] **Step 4: The section**

Create `apps/dashboard/src/tabs/upstreams/SyncSourceSection.tsx`:

```tsx
import { useCallback, useEffect, useId, useState } from "react"
import { connectSyncSource, disconnectSyncSource, getSyncSource, replaceSyncSource, type SyncSourceView as SourceRecord } from "../../api/sync"
import { useConfirm } from "../../state/confirm"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { Field } from "./form/Field"
import { parseSyncDocumentText } from "./sync-document"
import { syncLastErrorKey, syncSourceErrorKey } from "./sync-errors"
import { sourceHealth } from "./sync-source"

export interface SyncSourceViewProps {
  available: boolean
  loaded: boolean
  source: SourceRecord | null
  text: string
  replacing: boolean
  busy: boolean
  /** Already translated. */
  error: string
  /** Already translated. */
  notice: string
  onText: (value: string) => void
  onConnect: () => void
  onToggleReplace: () => void
  onReplace: () => void
  onDisconnect: () => void
}

export function SyncSourceView(props: SyncSourceViewProps) {
  const t = useT()
  const titleId = useId()
  if (!props.available || !props.loaded) return null
  const { source, busy } = props
  const time = (value: string | null) => value ? new Date(value).toLocaleString() : t("dash.syncNever")
  const health = source ? sourceHealth(source) : "ok"
  const documentField = <Field label={t("dash.syncSourceDocument")} hint={t("dash.syncSourcePasteHint")}>
    {({ id, describedBy }) => <textarea id={id} value={props.text} rows={8} spellCheck={false} className="w-full font-mono text-xs"
      aria-describedby={describedBy} placeholder={'{ "kind": "gateway-sync", … }'} disabled={busy} onChange={event => props.onText(event.target.value)} />}
  </Field>
  return <Card aria-labelledby={titleId} className="mt-4 space-y-3">
    <SectionHeading id={titleId}>{t("dash.syncSourceTitle")}</SectionHeading>
    <p className="text-body text-fg-muted">{t("dash.syncSourceDescription")}</p>
    {source ? <>
      <p className="text-body text-fg">{t("dash.syncSourceFrom", { origin: source.origin })}</p>
      <p className="text-xs text-fg-subtle">
        {t("dash.syncSourceCount", { n: source.upstreamCount })} · {t("dash.syncSourceLastSuccess", { at: time(source.lastSuccessAt) })} · {t("dash.syncSourceLastAttempt", { at: time(source.lastAttemptAt) })}
      </p>
      {health === "revoked" ? <Notice tone="danger">{t("dash.syncSourceRevokedNotice")}</Notice> : null}
      {health === "failing" ? <Notice tone="warn" role="status">
        {t("dash.syncSourceFailingNotice", { error: t(syncLastErrorKey(source.lastError) ?? "dash.syncErrorUnknown") })}</Notice> : null}
      {health === "skipped" ? <Notice tone="warn" role="status">
        {t("dash.syncSourceSkippedNotice", { error: t(syncLastErrorKey(source.lastError) ?? "dash.syncErrorUnknown") })}</Notice> : null}
      {props.replacing || health === "revoked" ? <div className="space-y-2">
        {documentField}
        <Button variant="primary" size="sm" disabled={busy || !props.text.trim()} onClick={props.onReplace}>{t("dash.syncSourceConnect")}</Button>
      </div> : null}
      <div className="flex flex-wrap gap-2">
        {health !== "revoked" ? <Button variant="secondary" size="sm" disabled={busy} aria-expanded={props.replacing} onClick={props.onToggleReplace}>
          {props.replacing ? t("dash.closeBtn") : t("dash.syncSourceReplace")}</Button> : null}
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onDisconnect} className="text-danger hover:text-danger">{t("dash.syncSourceDisconnect")}</Button>
      </div>
    </> : <div className="space-y-2">
      {documentField}
      <Button variant="primary" size="sm" disabled={busy || !props.text.trim()} onClick={props.onConnect}>{t("dash.syncSourceConnect")}</Button>
    </div>}
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
    {props.notice ? <p role="status" className="text-xs text-fg-subtle">{props.notice}</p> : null}
  </Card>
}

export function SyncSourceSection({ onChanged }: { onChanged: () => void }) {
  const t = useT()
  const confirm = useConfirm()
  const [state, setState] = useState<{ available: boolean; source: SourceRecord | null } | null>(null)
  const [text, setText] = useState("")
  const [replacing, setReplacing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")

  const load = useCallback(() => getSyncSource().then(setState).catch(() => setState({ available: false, source: null })), [])
  useEffect(() => {
    void load()
    // The status changes by itself every minute (last sync, errors, revocation).
    const timer = window.setInterval(() => { void load() }, 30_000)
    return () => window.clearInterval(timer)
  }, [load])

  const submit = async (replace: boolean) => {
    const document = parseSyncDocumentText(text)
    if (!document) { setError(t("dash.syncSourceDocumentInvalid")); setNotice(""); return }
    setBusy(true); setError(""); setNotice("")
    try {
      const result = await (replace ? replaceSyncSource : connectSyncSource)(document)
      setState({ available: true, source: result.source })
      setText(""); setReplacing(false)
      setNotice(t(replace ? "dash.syncSourceReplaced" : "dash.syncSourceConnected"))
      onChanged()
    } catch (error) { setError(t(syncSourceErrorKey(error))) }
    finally { setBusy(false) }
  }
  const disconnect = async () => {
    const origin = state?.source?.origin ?? ""
    const sure = await confirm({ title: t("dash.syncSourceDisconnectConfirmTitle", { origin }), description: t("dash.syncSourceDisconnectConfirmHint"),
      confirmLabel: t("dash.syncSourceDisconnect"), danger: true })
    if (!sure) return
    setBusy(true); setError(""); setNotice("")
    try { await disconnectSyncSource(); setState({ available: true, source: null }); setReplacing(false); onChanged() }
    catch (error) { setError(t(syncSourceErrorKey(error))); void load() }
    finally { setBusy(false) }
  }

  return <SyncSourceView available={state?.available ?? false} loaded={state !== null} source={state?.source ?? null} text={text} replacing={replacing}
    busy={busy} error={error} notice={notice} onText={value => { setText(value); setError("") }} onConnect={() => void submit(false)}
    onToggleReplace={() => { setReplacing(value => !value); setText(""); setError("") }} onReplace={() => void submit(true)} onDisconnect={() => void disconnect()} />
}
```

- [ ] **Step 5: Synced rows and mounting**

In `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx` (anchor on text, not line numbers: Task 1 moved them):

1. Add the import `import { lokiRowStatusKey } from "./loki-status"` back as the first import line.
2. Replace

```tsx
  const locked = readOnly
  const u = row
```

with

```tsx
  const locked = readOnly
  const u = row
  const synced = !!u.syncedFrom
```

3. Replace the name heading line

```tsx
              <h3 id={nameId} className="text-body font-medium text-fg truncate">{u.name}</h3>
```

with

```tsx
              <h3 id={nameId} className="text-body font-medium text-fg truncate">{u.name}</h3>
              {synced ? (
                <span className="inline-flex shrink-0 cursor-default" title={t("dash.syncedHint")}>
                  <Badge tone="brand">{u.syncedFrom?.origin ? t("dash.syncedBadge", { origin: u.syncedFrom.origin }) : t("dash.syncedBadgeUnknown")}</Badge>
                </span>
              ) : null}
```

4. Hide every action except enable, reorder and proxy. Replace

```tsx
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={locked || busy} aria-expanded={!!editing}>
```

with

```tsx
          {!synced ? <>
          <Button variant="ghost" size="sm" onClick={onEdit} disabled={locked || busy} aria-expanded={!!editing}>
```

replace

```tsx
          {u.provider === "copilot" ? (
            <Button variant="ghost" size="sm" onClick={onReauth} disabled={locked} title={t("dash.reauthTip")}>
              {t("dash.reauthBtn")}
            </Button>
          ) : null}
```

with

```tsx
          {u.provider === "copilot" ? (
            <Button variant="ghost" size="sm" onClick={onReauth} disabled={locked} title={t("dash.reauthTip")}>
              {t("dash.reauthBtn")}
            </Button>
          ) : null}
          </> : null}
```

and replace the Delete button

```tsx
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            disabled={locked || busy}
            className="text-danger hover:text-danger"
          >
            {u.provider === "copilot" ? t("dash.signOutBtn") : t("dash.delete")}
          </Button>
```

with

```tsx
          {!synced ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onDelete}
              disabled={locked || busy}
              className="text-danger hover:text-danger"
            >
              {u.provider === "copilot" ? t("dash.signOutBtn") : t("dash.delete")}
            </Button>
          ) : null}
```

(the proxy button stays between the two blocks and is untouched).

5. Replace the Loki status text

```tsx
                {t(u.lokiStatus.tokenStatus === "expired" ? "dash.lokiExpired" : {
                  waiting: "dash.lokiWaiting", authorized: "dash.lokiAuthorized",
                  interaction_required: "dash.lokiInteractionRequired", failed: "dash.lokiFailed",
                }[u.lokiStatus.assistantStatus])}
```

with

```tsx
                {t(lokiRowStatusKey(u.lokiStatus, synced))}
```

In `apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx` add `import { SyncSourceSection } from "./SyncSourceSection"` next to the `SyncDevicesSection` import and render it right after the `SyncDevicesSection` line:

```tsx
      <SyncSourceSection onChanged={store.reload} />
```

Rows from a sync source are owned by the connecting user, so for that user they sit in the "you" group where the existing enable toggle, reordering and proxy button already work; no other change to the tab is needed (decision D3).

- [ ] **Step 6: Run the tests and checks**

```bash
bun test apps/dashboard ./packages/gateway/tests/i18n-keys.test.ts ./packages/gateway/tests/i18n-interpolation.test.ts
bun run --filter '@vibe-llm/dashboard' typecheck
```

Expected: PASS and a clean typecheck. (The dashboard bundle is built by `bun run build:ui` in Task 15.)

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/tabs/upstreams/sync-source.ts apps/dashboard/src/tabs/upstreams/SyncSourceSection.tsx \
  apps/dashboard/src/tabs/upstreams/loki-status.ts apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx \
  apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx apps/dashboard/src/tabs/upstreams/sync-source.test.ts \
  apps/dashboard/src/tabs/upstreams/SyncSourceSection.test.tsx apps/dashboard/src/tabs/upstreams/loki-status.test.ts \
  apps/dashboard/src/tabs/upstreams/UpstreamRow.synced.test.tsx
git commit -F - <<'EOF'
feat(vnext/dashboard): connect a sync source and show synced upstreams

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 14: Documentation

**Files:**
- Modify: `docs/loki-sync-v1.md` (append a short pointer section), `docs/superpowers/specs/2026-11-16-loki-device-mirror-design.md` (status line)
- Create: `docs/gateway-sync-v1.md`

- [ ] **Step 1: Point the Loki protocol at the new mechanism**

Append to `docs/loki-sync-v1.md`:

```md

## Mirroring a paired upstream to device gateways

A paired Loki upstream can be mirrored to the owner's other gateways with gateway upstream sync; see [gateway-sync-v1.md](gateway-sync-v1.md). Sync v1 between the assistant and the central upstream is unchanged. The snapshot carries the upstream's configuration and the state needed to call Loki (the current credential), but never `syncSecretHash` or the upload receipt: the Windows assistant's pairing authority stays on the central gateway. A synced Loki upstream on a device is read-only, never accepts assistant uploads (it has no pairing secret), and answers `loki_credential_unavailable` once its credential expires until the next sync delivers a renewed one. The earlier per-upstream "device mirror" (`lkm_` secrets, `GET /api/loki/mirror/{id}`) no longer exists; stored state that still carries its fields is read without error and the fields are dropped.
```

In `docs/superpowers/specs/2026-11-16-loki-device-mirror-design.md` change the status line (line 3) to:

```md
Status: superseded by `2026-11-16-gateway-upstream-sync-design.md` (the code was removed on branch `feat/gateway-upstream-sync`).
```

- [ ] **Step 2: Write the protocol document**

Create `docs/gateway-sync-v1.md`:

````md
# Gateway upstream sync v1

A central gateway lets selected upstreams be mirrored onto a device's local gateway. The device pulls a full snapshot every 60 seconds; unchanged polls answer `304`. Only `copilot` and `loki` upstreams are syncable. Sync copies stored upstream records and contains no per-provider credential logic: providers opt in (`syncable`) and may filter what leaves the central gateway (`syncView`).

## What stays on the device

`enabled`, `sort_order` and the proxy fallback list are device-local. Everything else follows the central gateway and is read-only on the device. Proxies are never synced (a new synced upstream starts with none). Devices never rewrite a stored credential; deriving a short-lived token from it (Copilot's GitHub-token exchange) is allowed. Revoking a device removes its synced upstreams.

## The sync document

Shown once when a device is issued:

```json
{ "version": 1, "kind": "gateway-sync", "gatewayOrigin": "https://central.example", "deviceId": "sdv_<32 hex>", "deviceSecret": "sds_<64 hex>" }
```

`gatewayOrigin` is a bare HTTPS origin (no userinfo, path beyond `/`, query or fragment). Unknown fields are rejected. `sds_` is distinct from the Loki pairing prefix `lks_`, so neither secret works in the other's place. Only the SHA-256 of the secret is stored on the central gateway.

## Central gateway

Device management needs a real `ses_` session and the usual Origin rules (a cookie session must send `Origin` on mutations). Only the owner may manage their devices; administrators get no override (`404 device_not_found`).

- `GET /api/sync/devices` returns `{ devices: [{ id, label, upstreamIds, createdAt, lastSyncAt }] }`.
- `POST /api/sync/devices` with `{ label, upstreamIds }` returns `201 { device, document }`. The label is 1..64 characters. Errors: `400 https_required` (the request origin must be HTTPS), `409 device_limit` (16 per owner), `400 invalid_upstreams` (every id must be an upstream the caller owns with a syncable provider), `400 invalid_request`.
- `PATCH /api/sync/devices/{id}` with `{ label?, upstreamIds? }` returns `{ device }`; the secret is unchanged.
- `DELETE /api/sync/devices/{id}` revokes and returns `{ devices }`.

### Snapshot

`GET /api/sync/snapshot` with `Authorization: Bearer sds_<64 hex>` and an optional `If-None-Match`. It is mounted before session auth. Every authentication failure, including an unknown secret or a disabled owner, answers the same `401 { "error": { "code": "invalid_device" } }`; other failures answer `503 temporarily_unavailable`. All responses carry `Cache-Control: no-store`.

```json
{ "version": 1, "deviceId": "sdv_…", "upstreams": [
  { "id": "…", "provider": "copilot", "name": "…", "config": {}, "state": null, "flagOverrides": {}, "disabledPublicModelIds": [] } ] }
```

Included: ids selected for the device that still exist, belong to the device owner and have a syncable provider (the central `enabled` flag does not filter). `config` and `state` are the provider's `syncView`; Loki's removes `syncSecretHash` and `lastReceipt`. An upstream whose sync view throws is omitted. Order is central `sort_order`, then id. The `ETag` is the quoted SHA-256 of the body; an equal `If-None-Match` answers `304` with no body. `last_sync_at` is stamped at most every 10 minutes and a failed stamp never affects the response. Requests are logged by method, path and status only.

## Device gateway

Session-guarded; the connecting user owns the synced upstreams.

- `GET /api/sync/source` returns `{ available, source }` where `source` is `{ origin, deviceId, status, lastAttemptAt, lastSuccessAt, lastError, upstreamCount }` or null (never the secret). `available` is false on Cloudflare Workers, which do not run device sync.
- `POST /api/sync/source` with `{ document }` validates the document (`400 invalid_sync_document`), refuses a second source (`409 sync_source_exists`), then fetches one snapshot before storing anything. Central `401` gives `400 invalid_sync_document`; a network failure, timeout, redirect, other status or malformed body gives `502 sync_unreachable`. Plain HTTP is fine for the device's own address.
- `PUT /api/sync/source` replaces the document of the existing source with the same checks and applies the new snapshot (upstreams it lacks are removed); `404 sync_source_not_found` when there is none.
- `DELETE /api/sync/source` removes the source and every upstream it created.

### Polling

Docker (Bun) gateways run one sync at startup, one right after a configuration import, then every 60 seconds; one sync runs at a time. A fetch is direct (never an upstream's proxy chain), never follows redirects, times out after 15 seconds and reads at most 1 MiB. The device stores the quoted SHA-256 of the body it received as the ETag and sends it as `If-None-Match`.

| Result | Effect |
| --- | --- |
| `304` | nothing changes |
| network failure, timeout, redirect, 5xx, malformed body | the last applied snapshot stays; `lastError` is `unreachable`, `http_error` or `bad_response`; retried next tick |
| `401` | every synced upstream of the source is deleted, the source is marked `revoked` and polling stops until a document is re-imported |
| `200` | applied (below); the ETag is stored only when nothing was skipped |

Applying a snapshot: a row with the same id from this source is overwritten (provider, name, config, state, flag overrides, disabled model ids) while `enabled`, order and proxies stay; a missing row is created enabled, sorted last, with no proxies; a row with that id that the source does not own is skipped (`id_conflict`); a provider this gateway does not know is skipped (`unsupported_provider`); this source's rows absent from the snapshot are deleted. Skipped entries keep the ETag unstored so they are retried every tick. Catalog and credential generations advance only when a row's `provider` or `config` changed; a state-only change (a Loki token rotation) does not.

### Read-only rules

For a synced upstream the generic `PATCH` accepts only `enabled`, `sortOrder` and the proxy list. Changing anything else, deleting it, refreshing credentials, pairing Loki, or signing in or out of its Copilot account answers `409 { "error": { "code": "synced_upstream_read_only" } }`. Its provider is created with `credentialsReadOnly: true`.

## Backups

Configuration exports never include `sync_devices`, `sync_sources` or synced upstreams, and an import skips ids of live synced rows; they are rebuilt by sync. No device secret enters a backup.

## Adding a provider

Declare `syncable: true` on its `LlmProviderPlugin` only if it never rewrites its stored credentials when created with `credentialsReadOnly: true`, and add `syncView(record)` if part of its record must not leave the central gateway.

## Rollout

1. Deploy the Worker (the new endpoints are additive; migration `0025` adds the tables and `upstreams.sync_source_id`).
2. On the central gateway, issue a device with the Copilot and Loki upstreams selected.
3. Rebuild the local container, paste the document under Upstreams, Sync source, and confirm the upstreams appear and serve inference.
4. Copilot upstreams that the central gateway reaches through a proxy may need a device-local proxy if direct access fails.
````

- [ ] **Step 3: Commit**

```bash
git add docs/loki-sync-v1.md docs/gateway-sync-v1.md docs/superpowers/specs/2026-11-16-loki-device-mirror-design.md
git commit -F - <<'EOF'
docs(vnext): document gateway upstream sync and retire the device mirror

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
```

---

### Task 15: Full verification

No new code. Run the repository's own gate and compare against the known baseline.

- [ ] **Step 1: Lockfile and workspace hygiene**

```bash
grep -c mirrors.cloud.tencent bun.lock
bun install --frozen-lockfile --dry-run
git diff --stat d1ea817d -- bun.lock
git status --short
```

Expected: `0`; a dry run that exits 0 with no lockfile change requested; the lockfile diff is the single removed `@vibe-core/platform` line under `packages/provider-loki` (Task 1); `git status` shows only the untracked `docs/loki-safety-check-2026-11-14.md` (leave it alone).

- [ ] **Step 2: The local CI gate**

```bash
bun run ci:local
```

`ci:local` runs `ci:prepare`, `build:ui`, `check-framework-purity`, `typecheck`, `bun test`, `lint` and the Cloudflare `deploy:dry` in order and stops at the first failing step. `bun test` is expected to fail on the 11 known pre-existing failures, so run the steps from the failing one onward by hand:

```bash
bun run ci:prepare
bun run build:ui
bun run scripts/check-framework-purity.ts
bun run typecheck
bun test 2>&1 | tee /tmp/sync-full-suite.txt | grep -E '^\(fail\)' | sort > /tmp/sync-failures.txt
wc -l < /tmp/sync-failures.txt
cat /tmp/sync-failures.txt
bun run lint
bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry
```

Expected:
- `build:ui`, purity check, `typecheck`, `lint` and `deploy:dry` exit 0 (`deploy:dry` proves the Worker bundle still builds with the new `sync/` modules and migration; nothing in it starts a timer).
- `wc -l` prints `11`, and every line in `/tmp/sync-failures.txt` belongs to the known groups: provider-cancellation-forwarding, the respond-json JSON fallback/terminal tests, and the `docs/superpowers/research` harness tests. Any other `(fail)` line is a new failure to fix before finishing.
- If `lint` reports `import/no-cycle` or `no-restricted-paths` for the new files, fix the import (the allowed direction is control-plane to data-plane to repo, never back) rather than adding an exception.

- [ ] **Step 3: Targeted re-runs of everything this plan added**

```bash
bun test ./packages/gateway/tests/sync-*.test.ts ./packages/gateway/tests/migrations.test.ts ./packages/gateway/tests/i18n-keys.test.ts packages/provider-loki apps/dashboard
```

Expected: PASS.

- [ ] **Step 4: Manual smoke of the device loop (optional, local only)**

Start two gateways (`cd apps/platform-bun && PORT=8788 VNEXT_DB_PATH=/tmp/central.sqlite bun src/server.ts` and `PORT=8789 VNEXT_DB_PATH=/tmp/device.sqlite bun src/server.ts`), issue a document on the first (the issue route needs an HTTPS origin, so put a TLS-terminating proxy in front of the central one or use the unit and end-to-end tests as the proof), connect the second, and confirm the Upstreams page shows the "Synced from" badge and that the device log shows no `device_sync_failed` events. Do not deploy; deployment is a separate, explicit step (see the rollout list in `docs/gateway-sync-v1.md`).

---

## Spec coverage map

| Spec section | Where it is implemented and tested |
| --- | --- |
| Decisions: one-way periodic pull, ETag/304 | Tasks 5 (central ETag), 6 (client), 8 (60 s scheduler, 304 handling) |
| Provider-agnostic mechanism; copilot and loki only | Tasks 2 (contract, opt-in), 3 (`applySynced`), 7 |
| Replaces the Loki device mirror | Task 1 (backend, dashboard, i18n, docs), Task 14 (old spec status) |
| Selection editable at any time | Task 4 (`PATCH /devices/:id`), Task 11 (selection edit then sync) |
| Device-local `enabled`, `sort_order`, proxy list | Tasks 3, 7, 10 (PATCH allowlist), 11 |
| Proxies never synced | Task 5 (no proxy fields; asserted), Task 7 (empty list on create) |
| Devices never refresh stored credentials | Task 2 (`credentialsReadOnly`, Copilot no-write test), Task 11 (no repo writes during inference) |
| Revocation removes synced upstreams | Tasks 8 (`401` path), 11 |
| At most one sync source | Task 3 (singleton constraint), Task 9 (`409 sync_source_exists`) |
| Provider contract (`syncable`, `syncView`, `credentialsReadOnly`) | Task 2 |
| Data model (`sync_devices`, `sync_sources`, `sync_source_id`), shared migrations, legacy Loki state tolerated | Tasks 3, 1 |
| Export/import excludes sync data | Task 10 |
| Sync document and `gatewayOrigin` rules | Tasks 4 (builder), 6 (parser), 12 (client) |
| Central snapshot (auth, filtering, body, ETag, `no-store`, stamping, uniform 401, no header/body logging) | Task 5 |
| Device management routes and limits | Task 4 |
| Device source routes | Task 9 |
| Schedule (Bun only, startup, after import, 60 s, single flight) | Tasks 8, 9 (import hook), 9 (`available`) |
| Fetch rules (direct, no redirects, 15 s, 1 MiB) | Task 6 |
| Apply rules | Tasks 3, 7, 8 |
| Errors (`304`, failures, `401`) | Task 8 |
| Read-only synced upstreams | Tasks 2, 10 |
| Dashboard central section | Task 12 |
| Dashboard device section and synced rows | Task 13 |
| EN and ZH copy | Task 12 Step 6, verified by `i18n-keys.test.ts` and the per-helper dictionary tests |
| Testing list, end to end, acceptance | Tasks 3-13 per layer, Task 11 end to end, Task 15 acceptance |
| Rollout | Task 14 (document), Task 15 Step 4 |
