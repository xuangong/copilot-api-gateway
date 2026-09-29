# C02 SQL catalog foundation report

Base: `a7c5adc039075871b3a86a7d94604f5639bc8a6b`. Date: 2026-09-29. The 12 owned product files are frozen in `task-C02-foundation-owned.json` and `task-C02-foundation-frozen-sha256.json`. All 10 hashes in `current-user-dirty-sha256.json` still match. Unrelated tracked/untracked collaboration work, `PRODUCT.md`, ownership and opt-in retention are untouched. No commit, push, deployment, live credential/configuration operation, or subagent was performed.

## Delivered behavior

Migration `0018_catalog_coordination.sql` adds upstream discovery generation and a dedicated `model_catalogs` table keyed by `(upstream_id, catalog_revision)`. Conditional SQL lease acquisition, atomic publication/release and fenced persistent failure state use immutable row incarnation, current generation, owner/provider and random lease token. Publication also increments a monotonic `publication_version`, so L1 can order accepted results even when database timestamps are equal. Successful affected-row detection uses returned rows, not `changes === 1`.

Generation advances on upstream ID/incarnation/owner/provider/config/enabled/fallback-route changes and on effective referenced proxy URL/ID/timeout insert/update/delete. Display name/order/flags/disabled-model filters, ordinary state/token/quota/health updates and proxy health do not advance it. The explicit credential replacement seam advances generation exactly once in the same UPDATE. Its advancement also increments `configuration_revision`; the local configuration-cache write observer includes it. Generation cannot decrease.

Deletion and ID rename explicitly delete catalog rows, independent of foreign-key enforcement. Existing `0017` row-incarnation initialization/immutability is retained. Generation default is zero; legacy-style INSERT that omits incarnation can advance it during the existing AFTER INSERT incarnation initialization, so callers use returned authoritative metadata rather than assuming every insert has generation zero.

`patchMetadata` rereads its authorized target after a successful UPDATE, because AFTER-trigger generation changes are absent from RETURNING's row values. Core provider-facing stored row and `saveState(..., target)` semantics remain unchanged. No provider package was edited.

## Exact public API

Catalog interfaces live in `vnext/packages/gateway/src/repo/catalogs.ts` and are type-exported by gateway's public repository entry point. Bun/D1 implement the new required `Repo.catalogs` member through `buildSharedRepo`. Configuration-cache overlays pass that member through to raw SQL, including when an upstream configuration snapshot is pinned.

```ts
interface CatalogIdentity {
  upstreamId: string
  rowIncarnation: string
  ownerId?: string
  provider: string
  configurationGeneration: number
  configurationFingerprint: string
  catalogRevision: number
}
interface CatalogModels {
  object: string
  data: Array<{ id: string; [key: string]: unknown }>
  [key: string]: unknown
}
interface CatalogSnapshot {
  identity: CatalogIdentity
  publicationVersion: number
  models: CatalogModels
  refreshedAtMs: number
  refreshAfterMs: number
}
interface CatalogLease {
  identity: CatalogIdentity
  token: string
  leaseUntilMs: number
}
type CatalogErrorCode = "timeout" | "aborted" | "upstream_error" | "invalid_catalog" | "unavailable"
interface CatalogFailure {
  failureCount: number
  retryAtMs: number
  lastErrorCode: CatalogErrorCode | null
}
interface CatalogObservation extends CatalogFailure {
  upstream: StoredUpstreamRecord
  proxies: ProxyRecord[]
  identity: CatalogIdentity
  snapshot: CatalogSnapshot | null
  lease: CatalogLease | null
  databaseNowMs: number
}
interface CatalogRepo {
  read(id: UpstreamId, catalogRevision: number): Promise<CatalogObservation | null>
  tryAcquire(identity: CatalogIdentity, options?: { explicit?: boolean; leaseMs?: number }): Promise<CatalogLease | null>
  publish(lease: CatalogLease, models: CatalogModels, options?: { freshnessMs?: number }): Promise<CatalogSnapshot | null>
  recordFailure(lease: CatalogLease, code: CatalogErrorCode, options?: { backoffMs?: number }): Promise<CatalogFailure | null>
  deleteInactiveRevisions(options: { activeRevisions: readonly number[]; inactiveBeforeMs: number; limit: number }): Promise<number>
}
```

- `read` loads a raw stored upstream, its referenced proxy rows, then a SQL observation fenced by the upstream incarnation/generation. Proxy mutations advance the same generation, preventing mixed observations. It retries at most four times before `UpstreamContentionError`; missing upstream returns null. Upstream state/proxies may contain credentials: this is an internal API, not a public DTO.
- A stale-generation or mismatching-fingerprint catalog is ineligible in `read`: snapshot/lease are null and retry state is reset in the observation. SQL clears old model JSON and failure state when the new generation acquires. Returned leases may already be expired; compare `leaseUntilMs` with `databaseNowMs`.
- `tryAcquire` seeds from the current upstream via INSERT SELECT, then conditionally acquires with UPDATE RETURNING. A generation change replaces old lease/backoff eligibility. Same-generation automatic acquisition respects retry time; explicit acquisition only bypasses backoff, never a live lease. Null means eligibility was lost, requiring another authoritative observation. This layer does not decide route owner visibility, enabled policy or snapshot freshness.
- `publish` returns null when token/current identity/generation/revision or unexpired-lease predicates reject it. That result must never enter L1. An accepted result returns its persisted publication sequence and times. It validates model IDs and returns only valid persisted snapshot shapes/times. Successful empty catalogs are valid.
- `recordFailure` uses the same fence, clears its lease and preserves successful model JSON. Only fixed error categories are accepted at runtime; arbitrary exceptions/messages are rejected. It returns the persisted retry state, or null for a stale loser.
- Maintenance requires the complete active revision set (1–32 entries), uses a 1–512 row limit, and preserves live leases. It removes only non-active revisions with `last_used_at_ms < inactiveBeforeMs`; successful publishes, acquisitions and failures update that timestamp. It is not automatically scheduled by this foundation. A rolling deployment must include all still-active code revisions in this argument.

Database time is `CAST(strftime('%s','now') AS INTEGER) * 1000`: integer milliseconds with one-second precision, independent of `Date.now`. Defaults: 30-second lease, 120-second successful freshness, 30-second initial retry with 0.8–1.2 jitter, exponential growth capped at five minutes. Lease options allow 1–300,000 ms; explicit freshness allows 1–86,400,000 ms; explicit backoff allows 1–300,000 ms. These are bounded policy defaults, not measured provider timing guarantees.

## Explicit credential replacement seam

Gateway `StoredUpstreamRecord<T>` now extends the existing core stored type with required `catalogGeneration: number`. The added method is:

```ts
replaceCredentials(
  target: StoredUpstreamRecord,
  replacement: { config: Record<string, unknown>; state: unknown },
): Promise<StoredUpstreamRecord>
```

The complete prior stored snapshot is required. The method reads and verifies incarnation/owner/provider, compares target generation/config/state, and performs a single conditional UPDATE against raw `config_json`/`state_json` and generation. Credential replacement and generation +1 are atomic. A config-changing replacement is not double-incremented by the generation trigger. The post-write authoritative reread returns trigger-complete metadata.

The method never replays an import. Missing/replaced targets raise `UpstreamGoneError` / `UpstreamReplacedError`; config/state/generation contention raises `UpstreamContentionError`. Ordinary quota or rotation winning between the read and UPDATE causes contention rather than being overwritten. The later importer must reread authoritatively, compare its provider credentialRevision and authorization/config expectations, and decide whether a bounded retry is still permitted. No Codex-specific SQL policy or import route/UI was added. Existing general `save` semantics are unchanged; callers must explicitly adopt this seam for same-account reimport generation advancement.

## Discovery fingerprint and code revision contract

`catalogFingerprint(storedUpstream, proxies)` hashes the canonical discovery projection with SHA-256. Recursive object keys use code-unit ordering, avoiding locale/Unicode equivalence ambiguity; array order is preserved. Projection fields are ID/incarnation, normalized owner, provider, enabled, full config, and the entire ordered fallback list with colo restrictions plus each effective referenced proxy URL and dial timeout. Missing proxies are represented as null. Built-in `direct_fetch` and `direct_connect` never resolve through same-named proxy table rows.

Generation, mutable credential state, quota/health, top-level display/filter metadata and proxy display/timestamps are excluded. Config/proxy credentials exist only inside the digest, not in SQL identity keys. The selected Codex/Claude account is included through config. Fingerprint intentionally stays identical for same-identity credential reimport; generation distinguishes that new identity epoch.

The catalog is upstream-scoped: it hashes the full allowed route set, not the currently selected runtime colo/fallback. Allowed egress routes are required to return the same upstream catalog. A genuinely route-dependent catalog would require an explicit partition design/revision change; it is not silently supported by the current key.

`catalogRevision` is supplied by the caller and independently validated as a positive safe integer. Existing registry `MODEL_CATALOG_REVISION = 4` remains unchanged in this foundation. Activation must bump that C03-owned revision when adopting this projection/adapter. Two supplied revisions coexist and cannot overwrite each other's SQL rows; no implicit compatibility reader accepts an older code revision.

## Validation evidence

Executed on the final implementation:

- `bun test packages/gateway/tests/catalog-repo.sqlite.test.ts packages/gateway/tests/upstream-cas.sqlite.test.ts packages/gateway/tests/upstream-dto-races.sqlite.test.ts packages/gateway/tests/configuration-snapshot.test.ts packages/gateway/tests/codex-credential-effects.sqlite.test.ts apps/platform-cloudflare/src/d1-repo.test.ts packages/gateway/tests/migrations.test.ts` — **150 pass, 0 fail, 624 assertions**, seven files. Full output: `task-C02-foundation-focused-tests.log`.
- New catalog suite: **27 tests** using independent Bun SQLite handles on temporary files, actual migrations and statement barriers. Covers single lease winner, takeover, stale publication/failure, config/owner/provider/proxy changes, raw-insert migration, same-timestamp ABA/cleanup, rotation during a held lease, prior-state CAS contention, persisted retry/restart/jitter cap, revision coexistence/maintenance, publication ordering, Unicode fingerprint stability, invalid persisted timing and configuration-cache bypass/invalidation.
- Existing registry/control-plane/outage/error routing command: `bun test packages/gateway/tests/providers-registry.test.ts packages/gateway/tests/control-plane-upstreams.test.ts packages/gateway/tests/integration/catalog-outage.test.ts packages/gateway/tests/integration/catalog-discovery-errors.test.ts` — **104 pass, 0 fail, 293 assertions**. Full output: `task-C02-foundation-routing-tests.log`.
- Gateway, platform-bun and platform-cloudflare `typecheck` commands all exited 0. ESLint over owned TypeScript files exited 0 (only the existing multi-project performance notice). `git diff --check` over the 12 owned product files passed.
- Schema baseline regenerated through the existing `UPDATE_SCHEMA_BASELINE=1 bun test packages/gateway/tests/migrations.test.ts` workflow; the normal baseline comparison subsequently passed.

RED evidence: initial catalog tests failed because generation/catalog repo/replacement API did not exist (0 pass, 15 fail). A Unicode reverse-key fixture reproduced unequal fingerprints before replacing locale sorting. A malformed-time fixture reproduced acceptance of `refreshedAtMs: "invalid"` before adding validation (`task-C02-foundation-red-timing.log`). Existing control-plane editor test initially produced **103 pass, 1 fail**: after edit then revert, it incorrectly expected an old-generation catalog to be restored. It now asserts `cached: false`, explicitly populates the new generation, then verifies failed refresh retains that current catalog.

Although registry orchestration code is untouched, new stored generation naturally participates in its existing broad `upstreamConfiguration` hash. Thus reverting config bytes no longer restores an earlier generation's catalog. This is an intentional invalidation improvement, not a claim of zero runtime behavior change. SQL coordinated production discovery is still unactivated.

Root reported actual local workerd + D1Repo initial and expanded probes passing against the mutable implementation, including ownerless targets, trigger-inclusive affected-row semantics, publication versions and bounded proxy-read races. This report does not substitute that attributed evidence for a frozen rerun. Root owns the frozen actual-D1 rerun and full clean `ci:local`/Wrangler dry-run; the implementation agent did not run full CI or production D1 operations.

Direct non-Sessions D1 binding queries remain in place. The primary-routing guarantee comes from the official D1 contract verified by root (`c02-d1-replication-official.md:19`), not local geographical testing. Local SQLite/workerd can validate SQL and one-store races; production cross-isolate deployment/routing behavior has not been measured here.

## Remaining activation boundary

The next package must connect registry/C03 to this SQL repo: authoritative provider and proxy-fetcher reconstruction with visibility rechecks, shared refresh lifecycle, actual cross-instance one-fetch acceptance, bounded cold polling/timeout/cancellation, explicit refresh join/backoff behavior, stale SQL-outage handling, the 512-entry L1 with generation/publication ordering, C03 code revision and maintenance scheduling. It must preserve separate request-token Copilot behavior and cached editor reads. C08 import/UI then adopts the atomic replacement seam. None of those future runtime behaviors are claimed by this foundation.

## Fix 1: shared-provider-state full-CI fixture

Root's clean `ci:local` found one failure outside the original 12-path foundation ownership: `integration/shared-provider-state.test.ts` expected no configuration revision change after a simulated remote quota write. The fixture saved `codexState()` and later created a second `codexState()`; each call used `Date.now() + 3_600_000` for `accessToken.expiresAt`. Migration `0010_configuration_revision.sql` excludes only `quotaSnapshot` from Codex state comparison, so the changed access-token expiry correctly incremented `configuration_revision` from 1 to 2. The new `0018` catalog-generation trigger does not compare `state_json`; this was fixture drift, not a catalog-generation product bug.

A deterministic diagnostic with fixed expiry values confirmed the trigger distinction: changing expiry from `4_000_000_000_000` to `4_000_000_001_000` alongside quota produced revision `1 → 2`; changing quota alone with expiry held at `4_000_000_001_000` kept revision `2`. The original focused test reproduced **8 pass, 1 fail**, with the same `Expected: 1 / Received: 2` failure as root's clean CI. The test now reads its authoritative saved state and modifies only `quotaSnapshot`, matching its remote-quota intent. No product implementation changed.

`task-C02-foundation-owned.json` and `task-C02-foundation-frozen-sha256.json` now include this one additional test file, for 13 exact owned product paths. Fix1 focused command `bun test packages/gateway/tests/integration/shared-provider-state.test.ts packages/gateway/tests/catalog-repo.sqlite.test.ts` passed **36 pass, 0 fail, 156 assertions**; output is `task-C02-foundation-fix1-focused-tests.log`. `bun run typecheck` passed all workspace packages, and `git diff --check` passed. All 12 original frozen product hashes and all 10 protected user-dirty hashes still match. Root owns the rerun of full clean CI and workerd/D1 against the new freeze.
