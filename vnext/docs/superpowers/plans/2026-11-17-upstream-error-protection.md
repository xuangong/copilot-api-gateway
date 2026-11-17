# Upstream Error Protection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record every upstream response by error class, detect error floods per upstream, optionally pause the culprit (an upstream, or one API key that causes at least 80% of the risky errors) for an automatic cooldown, and show statistics, samples, history and status in the dashboard. Source of truth: `vnext/docs/superpowers/specs/2026-11-17-upstream-error-protection-design.md`.

**Architecture:** One neutral module `packages/gateway/src/protection/` (classification, settings, detection, a `ProtectionRuntime` with injectable clock/scheduler and per-isolate caches) sits on a new `ProtectionRepo` (`repo/protection.ts` interface, `repo/shared/protection.ts` SQL shared by D1 and bun:sqlite, migration `0027_upstream_protection.sql`). Recording happens at one choke point per call site: a wrapper around `provider.fetch` in the three hub attempts (`chat-completions`, `messages`, `responses`; Gemini and cross-protocol requests delegate to those), and inside `runEmbeddingsAttempt` / `runImagesAttempt`. Recording and evaluation are scheduled with `waitUntil` and can never fail or delay the client response. Enforcement skips paused upstreams in `enumerateBindingCandidates` and `resolveBinding` (not in `listRoutingBindings`, which also feeds model listings) and rejects paused keys in an app-level middleware. A session-guarded owner-only API feeds the dashboard (global banner, a Protection section per upstream, a badge on paused keys).

**Tech Stack:** Bun + TypeScript monorepo (`vnext/`), Hono, zod, Cloudflare Worker + D1 (`apps/platform-cloudflare`), Bun + SQLite (`apps/platform-bun`), shared code `packages/gateway`, React + Chart.js dashboard (`apps/dashboard`), `bun test`.

---

## Conventions used by every task

- All commands run from `/Users/xian/projects/copilot-api-gateway/vnext` unless a `cd` is shown. Never run plain `bun install`.
- Test: `bun test <path>`. Gateway typecheck: `bun run --filter '@vibe-llm/gateway' typecheck` (if it complains about missing setup assets run `bun run build:setup` once). Dashboard typecheck: `bun run --filter '@vibe-llm/dashboard' typecheck`. Lint: `bunx eslint <paths>`.
- Commit: `git add <listed paths>` then `git commit -m "<subject>" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`. Never stage `vnext/docs/loki-safety-check-2026-11-14.md`.
- Never paste keys or tokens into tests, fixtures or logs. Tests use obviously fake placeholders.
- Import boundaries (eslint `import/no-restricted-paths`): `data-plane` must not import `control-plane`; `repo/` and `shared/` must not import either plane. `src/protection/` is a new neutral directory both planes may import; it may import `repo/`.
- Test IDs: fake upstreams are `up_test_*`, fake keys `key_test_*`.

## Decisions (choices the spec leaves open)

- **D1 Settings live in a side table.** `upstream_protection_settings (upstream_id PK, settings_json, updated_at)` in migration 0027, not an existing JSON column. `config_json` is provider specific (the custom/azure/sdf normalisers drop unknown keys), masked in the public DTO and rewritten by credential flows and sync; `flag_overrides` is `Record<string, boolean>`; `state_json` holds credentials; a new `upstreams` column would touch `UpstreamRecord` in six packages and the `configuration_upstreams_update` trigger (revision bumps invalidate every isolate's configuration cache on each tweak). The PATCH route writes the side table; the list DTO merges it.
- **D2 One choke point per call site.** `withUpstreamProtection` wraps the `provider.fetch` lambda passed to `fetchAffinityUpstream` in `chat-completions/attempt.ts:212`, `messages/attempt.ts:415`, `responses/attempt.ts:442`. It sees the returned `ProviderResponse`, a thrown `HTTPError` (providers throw it for non-2xx, see the `catch` blocks at the end of each attempt) and thrown network errors, exactly once per upstream call. Gemini and cross-protocol requests go through those hub attempts, so they are covered without double counting. `fetchWithPerformance` is not used (its recorder is optional and it does not see `HTTPError`); the respond layer is not used (it sees translated results and misses failures).
- **D3 Classification is by status at response headers.** A 2xx whose stream fails later is `ok`. Thrown `HTTPError` is classified by its status. A thrown non-HTTP error is `network` only when it is a `TypeError` (fetch failure), `TimeoutError`, or carries a known socket error code; caller aborts (`signal.aborted`, `AbortError`) and gateway errors (affinity fence) are not recorded.
- **D4 Dimensions.** `model` = the public bare model (`sel.bareModel`; the routed model for embeddings/images). `key_id` = `''` when the request has no API key.
- **D5 Scheduling.** `scheduleBackground(promise)` calls `waitUntil` from `@vibe-core/platform` and falls back to a detached promise when no background executor is initialised (unit tests; `waitUntil` throws then). The existing platform wiring is reused: Workers `initBackground({ waitUntil: p => ctx.waitUntil(p) })` (`apps/platform-cloudflare/src/bootstrap.ts:54`), Bun `initBackground({ waitUntil: p => { void p.catch(() => {}) } })` (`apps/platform-bun/src/bootstrap.ts:42`); `respond.ts` already uses the same `waitUntil(recordPerformance(...))` pattern. `ProtectionRuntime.record()` is synchronous and returns `void`.
- **D6 Samples.** For a `ProviderResponse` body the wrapper `tee()`s the stream (client keeps one branch), reads at most 4 KiB with a 5 s timeout, parses `error.message` / `error.code|type` shapes, redacts token-looking strings, collapses whitespace, trims to 300 chars. HTML or unparsable bodies store an empty message. Network samples use status 0 and the gateway's error name. Samples are written for `rate_limited`, `rejected`, `auth`, `upstream`, `network` only.
- **D7 D1 round trips.** `ok`/`other` responses: one upsert. Sampled classes: one `batch([upsert, insert sample, trim])`. Every statement binds far fewer than 100 parameters.
- **D8 Enforcement point.** Paused upstreams are removed from the candidate lists in `enumerateBindingCandidates` (chat flows, alpha search) and `resolveBinding` (embeddings, images, decision, count tokens). `listRoutingBindings` is untouched so `/v1/models` and the key editor still list a paused upstream's models. There is no runtime retry across upstreams in this codebase, so "fallback" means selection simply picks the next candidate.
- **D9 "No route" for a paused upstream.** Chat flows: `selectBindingForProtocol` returns `{ kind: 'upstream-paused' }`; each attempt maps it to `llmInternalErrorResult(503, …, undefined, 'upstream-paused', { code: 'upstream_paused', retryAfterSeconds })`, and the four renderers (`chat-completions/respond.ts`, `messages/respond.ts`, `gemini/respond.ts`, `responses/turn.ts`) add `Retry-After` and `error.code` (Gemini keeps its Google RPC body, header only). `resolveBinding` callers get an `UpstreamPausedError` (an `HTTPException` carrying the 503 response, like the existing `ModelCatalogUnavailableError`). Affinity-constrained requests whose only provable route is paused keep the existing affinity error (known limitation).
- **D10 Key guard.** App-level middleware immediately after `devAuthMiddleware` in `app.ts`, active only when `auth.apiKeyId` is set, so dashboard sessions (which resume keys) are unaffected. Body `{ error: { type: 'api_error', code: 'key_paused', message } }`, `503`, `Retry-After`.
- **D11 Query parameter is `keyId`, not `key`.** `requireBrowserSessionAllowingQuery` refuses any `key` query parameter (it guards against credential-in-URL). The spec's optional `key=` filter is therefore `keyId=`.
- **D12 API shapes.** `from`/`to` are unix seconds. `bucket` defaults to `minute` when the range is at most 1500 minutes, else `hour`; at most 30 days and 1500 buckets; responses are sparse (the client zero-fills). `ok` is not returned: `requests` minus the six class counts.
- **D13 Visibility.** Admin sees everything; a user sees pauses whose upstream they own or whose key they own; other ids answer `404`. A viewer who does not own the pause's upstream gets blank `upstreamId`/`upstreamName`, no `reason.upstreamName` and only their own keys in `reason.topKeys`. Resume is stricter than viewing (changed after review): a key pause may be resumed only by the key's owner or an admin (it applies across all upstreams), an upstream pause only by that upstream's owner or an admin; the DTO carries `canResume`. Resuming a `notify` row dismisses the warning.
- **D14 Auto resolution.** Rows stay `resolved_at IS NULL` until the maintenance sweep stamps `resolved_at = ends_at, resolved_by = 'auto'`. The DTO derives `endedBy = resolvedBy ?? (endsAt <= now ? 'auto' : null)`, so history is right before the sweep runs.
- **D15 Settings validation.** Integers for minutes/counts. `maxCooldownMinutes` range 1..10080 and not below `cooldownMinutes`; `authBurst` 0..10000. PATCH merges missing keys with the stored values (full objects from the dashboard, partial from scripts). Stored JSON is read leniently: an invalid field falls back to its default.
- **D16 Cooldown doubling** counts earlier rows of the same target and the same mode that started within 24 h (resolved early or not).
- **D17 "Covered" rule.** Skip when an active row targets this upstream, or targets the attributed key (the top key whose share is at least `keyShare`), and would cover a row of the new mode: a `pause` is covered only by an active `pause` (a warning never blocks a pause), a `notify` by any active row. An atomic `INSERT … WHERE NOT EXISTS` on the final target stops duplicates across isolates.
- **D18 Throttle and settings reads.** Evaluation runs only after a risky response is recorded, at most once per 10 s per upstream per isolate; each evaluation reads the settings row once (an `off` upstream costs one indexed read per 10 s during a flood, nothing otherwise).
- **D19 Cache failure is fail-open.** If the active-pause refresh fails the previous rows (or none) stay in force and the next attempt happens after the TTL. The isolate that creates or resolves a pause patches its own cache immediately.
- **D20 Runtime wiring.** `getProtection()` builds a singleton from `getRepo()`, `Date.now` and `scheduleBackground`; tests inject `new ProtectionRuntime({ repo, now, schedule })` and call `setProtectionForTests`. Reset is registered with `__registerPlatformReset`.
- **D21 Retention.** Every sweep: auto-resolve stamp, minutes older than 30 d, pauses older than 90 d, samples and settings of vanished upstreams. Chunks of 5000 rows, at most 10 DELETEs per table per sweep (normally 5 statements in total).
- **D22 Not recorded in v1** (they also reach upstream accounts, listed as follow-up): `count_tokens` (messages, Gemini), `decision` routes, `alpha/search`, image-generation server-tool sub-calls, catalog refreshes, web-search providers. The user-visible scope matches the spec: chat flows, embeddings, images.
- **D23 Chart.** New `tabs/upstreams/protection/ErrorBarChart.tsx` (Chart.js bar + line; it reuses `chartFont`, `isDarkTheme` and `cssVar`, which `TimeSeriesChart.tsx` now exports) instead of extending `TimeSeriesChart`, which is line-only and carries cost/cache/link tooltip machinery. Bars are the six non-`ok` classes (stacked, risky classes warm), the line is `requests`; with `ok` stacked the line would only trace the stack top and the errors would vanish at scale.
- **D24 Local time.** Reuse the zone logic in `tabs/telemetry/telemetry-format.ts`; add `formatClockMs`, `formatUntil`, `formatInstantMs` there rather than duplicating `Intl` handling.
- **D25 Dashboard placement.** `state/protection.tsx` polls every 60 s and after actions; `AppShell` gets a `banner` slot; the Protection section is a collapsible panel per upstream row opened by a "Protection" button (like the proxy chain), hidden in read-only owner groups; the key badge reads the same store. Names in banner text are plain (no emphasis markup).
- **D26 Session-auth exemption.** `/api/protection/*` and the three upstream read routes join the paths for which `sessionAuthMiddleware` skips the Copilot-token prefetch (telemetry precedent), because the banner polls every minute.
- **D27 Defaults mirrored.** The dashboard keeps `PROTECTION_DEFAULTS` / `PROTECTION_LIMITS`; a gateway test fails if they drift from `repo/protection.ts`.
- **D28 Synced upstreams** may still edit `protection` (not in `SYNCED_LOCKED_FIELDS`): statistics and protection are local to each gateway.

## File structure

Create:

| File | Responsibility |
| --- | --- |
| `packages/gateway/migrations/0027_upstream_protection.sql` | Tables `upstream_request_minutes`, `upstream_error_samples`, `protection_pauses`, `upstream_protection_settings` and indexes |
| `packages/gateway/src/repo/protection.ts` | Types, constants, defaults and the `ProtectionRepo` interface |
| `packages/gateway/src/repo/shared/protection.ts` | `SharedProtectionRepo` SQL for D1 and SQLite |
| `packages/gateway/src/protection/classify.ts` | Status/error classification, error-detail extraction and redaction |
| `packages/gateway/src/protection/settings.ts` | `normalizeProtection` (strict) and `resolveProtection` (lenient) |
| `packages/gateway/src/protection/detect.ts` | Pure `assess`, `covered`, `cooldownMinutes` |
| `packages/gateway/src/protection/runtime.ts` | `ProtectionRuntime`, `getProtection`, `scheduleBackground`, caches, throttle |
| `packages/gateway/src/protection/observe.ts` | `withUpstreamProtection`, `recordResponse`, `recordThrown` |
| `packages/gateway/src/protection/messages.ts` | Wording and `Retry-After` maths for paused errors |
| `packages/gateway/src/data-plane/protection/key-guard.ts` | `keyPausedMiddleware` |
| `packages/gateway/src/data-plane/errors/upstream-paused.ts` | `UpstreamPausedError` (HTTPException) |
| `packages/gateway/src/control-plane/protection/routes.ts` | `protectionRouter` (`/api/protection`) and `upstreamProtectionRouter` (`/api/upstreams/:id/...`) |
| `packages/gateway/src/control-plane/protection/dto.ts` | DTO shaping, visibility |
| `packages/gateway/tests/protection-*.ts(x)` | Tests listed per task |
| `apps/dashboard/src/api/protection.ts` | Typed API client |
| `apps/dashboard/src/state/protection.tsx`, `protection-poll.ts` | Store, polling |
| `apps/dashboard/src/components/ProtectionBanner.tsx`, `protection-banner-model.ts` | Global banner |
| `apps/dashboard/src/tabs/upstreams/protection/*` | `protection-form.ts`, `error-chart.ts`, `ErrorBarChart.tsx` (stacked error bars plus requests line), `ProtectionSettingsForm.tsx`, `ErrorSamplesTable.tsx`, `PauseHistoryTable.tsx`, `use-protection-data.ts`, `ProtectionSection.tsx` |
| `docs/upstream-protection-v1.md` | Short reference |

Modify:

| File | Change |
| --- | --- |
| `packages/gateway/src/repo/types.ts` (Repo, ~L634) and `repo/shared/repos.ts` (~L1460) | Add `protection` |
| `apps/platform-bun/src/bun-sqlite-repo.ts`, `apps/platform-cloudflare/src/d1-repo.ts` | Expose `protection` |
| `packages/protocols-llm/src/common/result.ts` (+`index.ts`) | `InternalErrorResult.code/retryAfterSeconds`, `retryAfterHeaders` |
| `chat-flow/{chat-completions,messages,responses}/attempt.ts`, `gemini/attempt.ts` | Wrap fetch; map `upstream-paused` |
| `chat-flow/{chat-completions,messages,gemini}/respond.ts`, `responses/turn.ts` | Render code and `Retry-After` |
| `observability/attempts/{embeddings,images}-attempt.ts` | Record |
| `data-plane/routing/candidates.ts`, `routing/binding-resolver.ts`, `chat-flow/shared/select-binding.ts` | Skip paused upstreams |
| `app.ts`, `control-plane/routes.ts`, `control-plane/auth/session-auth.ts` | Middleware, mounts, exemption |
| `control-plane/upstreams/routes.ts`, `public-dto.ts` | PATCH/list `protection` |
| `maintenance.ts` | Retention |
| `shared/edge/ui-pages/i18n.ts` | EN + ZH keys |
| `apps/dashboard/src/{App.tsx,shell/AppShell.tsx,components/TimeSeriesChart.tsx (export two helpers),tabs/upstreams/*,tabs/keys/*,tabs/telemetry/telemetry-format.ts,api/types.ts,api/upstreams.ts}` | UI wiring |
| `packages/gateway/tests/schema-baseline.txt` | Regenerated |

---

## Task 1: Migration 0027 and schema baseline

**Files:**
- Create: `packages/gateway/migrations/0027_upstream_protection.sql`
- Create: `packages/gateway/tests/upstream-protection-migration.test.ts`
- Modify: `packages/gateway/tests/schema-baseline.txt` (regenerated, do not hand edit)

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/upstream-protection-migration.test.ts
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations } from "@vibe-llm/platform-bun/src/migrate.ts"

const columns = (db: Database, table: string): string[] =>
  db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map(row => row.name)

test("migration 0027 creates the protection tables", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    expect(columns(db, "upstream_request_minutes")).toEqual(
      ["minute", "upstream_id", "key_id", "model", "requests", "rate_limited", "rejected", "auth", "upstream", "network", "other"])
    expect(columns(db, "upstream_error_samples")).toEqual(["upstream_id", "status", "at", "key_id", "model", "code", "message"])
    expect(columns(db, "protection_pauses")).toEqual(
      ["id", "target_kind", "target_id", "upstream_id", "mode", "reason_json", "started_at", "ends_at", "resolved_at", "resolved_by"])
    expect(columns(db, "upstream_protection_settings")).toEqual(["upstream_id", "settings_json", "updated_at"])
  } finally { db.close() }
})

test("the minute row is unique per (upstream, minute, key, model) and upserts count", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    const upsert = `INSERT INTO upstream_request_minutes (minute, upstream_id, key_id, model, requests, rate_limited) VALUES (60, 'u', 'k', 'm', 1, 1)
      ON CONFLICT (upstream_id, minute, key_id, model) DO UPDATE SET requests = requests + 1, rate_limited = rate_limited + 1`
    db.run(upsert)
    db.run(upsert)
    expect(db.query("SELECT requests, rate_limited FROM upstream_request_minutes").all()).toEqual([{ requests: 2, rate_limited: 2 }])
  } finally { db.close() }
})

test("pause rows reject unknown kinds and modes, and the active lookup uses the partial index", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    const insert = (kind: string, mode: string) => db.run(
      "INSERT INTO protection_pauses (id, target_kind, target_id, upstream_id, mode, reason_json, started_at, ends_at) VALUES (?, ?, 't', 'u', ?, '{}', 1, 2)",
      [`pp_${"a".repeat(32)}${kind}${mode}`.slice(0, 35), kind, mode])
    expect(() => insert("galaxy", "pause")).toThrow()
    expect(() => insert("key", "ban")).toThrow()
    insert("key", "pause")
    const plan = db.query<{ detail: string }, []>(
      "EXPLAIN QUERY PLAN SELECT id FROM protection_pauses WHERE resolved_at IS NULL AND ends_at > 5").all().map(row => row.detail)
    expect(plan.some(detail => detail.includes("idx_protection_pauses_active"))).toBe(true)
  } finally { db.close() }
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/upstream-protection-migration.test.ts`
Expected: FAIL (`pragma_table_info` returns no columns, `no such table: upstream_request_minutes`).

- [ ] **Step 3: Write the migration**

```sql
-- packages/gateway/migrations/0027_upstream_protection.sql
-- Upstream error protection: per-minute response counts by class, the latest error samples,
-- protection pauses/warnings and per-upstream protection settings.

-- `minute` is unix seconds at the start of the minute. One row per (upstream, minute, key, model);
-- `requests` counts every recorded response, the class columns count the non-2xx classes. 2xx is requests minus the classes.
CREATE TABLE upstream_request_minutes (
  minute INTEGER NOT NULL,
  upstream_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  rate_limited INTEGER NOT NULL DEFAULT 0 CHECK (rate_limited >= 0),
  rejected INTEGER NOT NULL DEFAULT 0 CHECK (rejected >= 0),
  auth INTEGER NOT NULL DEFAULT 0 CHECK (auth >= 0),
  upstream INTEGER NOT NULL DEFAULT 0 CHECK (upstream >= 0),
  network INTEGER NOT NULL DEFAULT 0 CHECK (network >= 0),
  other INTEGER NOT NULL DEFAULT 0 CHECK (other >= 0),
  PRIMARY KEY (upstream_id, minute, key_id, model)
);
CREATE INDEX idx_upstream_request_minutes_minute ON upstream_request_minutes (minute);
CREATE INDEX idx_upstream_request_minutes_key ON upstream_request_minutes (key_id, minute);

-- The latest 20 per (upstream, status); `status` 0 is a network failure, `at` is unix ms.
-- Only the upstream's own error description is stored, never request or response content.
CREATE TABLE upstream_error_samples (
  upstream_id TEXT NOT NULL,
  status INTEGER NOT NULL,
  at INTEGER NOT NULL,
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_upstream_error_samples_latest ON upstream_error_samples (upstream_id, status, at);

-- Times are unix ms. A `notify` row records a warning, not a block. Active = resolved_at IS NULL AND ends_at > now.
CREATE TABLE protection_pauses (
  id TEXT PRIMARY KEY CHECK (length(id) = 35 AND id GLOB 'pp_*'),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('upstream', 'key')),
  target_id TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('pause', 'notify')),
  reason_json TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT CHECK (resolved_by IS NULL OR resolved_by IN ('auto', 'owner'))
);
CREATE INDEX idx_protection_pauses_active ON protection_pauses (ends_at) WHERE resolved_at IS NULL;
CREATE INDEX idx_protection_pauses_upstream ON protection_pauses (upstream_id, started_at);
CREATE INDEX idx_protection_pauses_target ON protection_pauses (target_kind, target_id, started_at);
CREATE INDEX idx_protection_pauses_started ON protection_pauses (started_at);

-- Protection settings per upstream (JSON validated by the control plane); a missing row means all defaults.
CREATE TABLE upstream_protection_settings (
  upstream_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

- [ ] **Step 4: Run the test, then regenerate the schema baseline**

Run: `bun test packages/gateway/tests/upstream-protection-migration.test.ts`
Expected: PASS (3 tests).

Run: `bun test packages/gateway/tests/migrations.test.ts`
Expected: FAIL only in the schema baseline test (new objects missing from `schema-baseline.txt`).

Run: `UPDATE_SCHEMA_BASELINE=1 bun test packages/gateway/tests/migrations.test.ts && bun test packages/gateway/tests/migrations.test.ts`
Expected: PASS. `git diff packages/gateway/tests/schema-baseline.txt` shows only added `index`/`table` lines for the four new tables and their indexes.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/migrations/0027_upstream_protection.sql packages/gateway/tests/upstream-protection-migration.test.ts packages/gateway/tests/schema-baseline.txt
git commit -m "feat(protection): migration 0027 for error statistics, samples, pauses and settings" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Protection repo (interface, shared SQL, wiring, contract tests on SQLite and D1)

**Files:**
- Create: `packages/gateway/src/repo/protection.ts`
- Create: `packages/gateway/src/repo/shared/protection.ts`
- Create: `packages/gateway/tests/protection-repo-contract.ts`, `protection-repo.sqlite.test.ts`, `protection-repo.d1.test.ts`
- Modify: `packages/gateway/src/repo/types.ts` (import near L16, `Repo` interface near L634 after `telemetry: TelemetryRepo`)
- Modify: `packages/gateway/src/repo/index.ts` (type exports, below the telemetry export near L15)
- Modify: `packages/gateway/src/repo/shared/repos.ts` (import near L10, object near L1460 after `telemetry: new SharedTelemetryRepo(x),`)
- Modify: `apps/platform-bun/src/bun-sqlite-repo.ts` (field near L62, assignment near L93), `apps/platform-cloudflare/src/d1-repo.ts` (field near L216, assignment near L246)

- [ ] **Step 1: Write the repo types first (needed by the contract test)**

```ts
// packages/gateway/src/repo/protection.ts
export const ERROR_CLASSES = ["ok", "rate_limited", "rejected", "auth", "upstream", "network", "other"] as const
export type ErrorClass = (typeof ERROR_CLASSES)[number]
/** Classes that have a count column; `ok` is `requests` minus these. */
export const COUNTED_CLASSES = ["rate_limited", "rejected", "auth", "upstream", "network", "other"] as const
export type CountedClass = (typeof COUNTED_CLASSES)[number]
export const RISKY_CLASSES = ["rate_limited", "rejected", "auth"] as const
export type RiskyClass = (typeof RISKY_CLASSES)[number]
/** Classes whose responses leave an error sample. */
export const SAMPLED_CLASSES: readonly ErrorClass[] = ["rate_limited", "rejected", "auth", "upstream", "network"]

export const PROTECTION_SAMPLES_PER_STATUS = 20
export const PROTECTION_MINUTES_RETENTION_DAYS = 30
export const PROTECTION_PAUSES_RETENTION_DAYS = 90
export const PROTECTION_PURGE_CHUNK = 5000
/** DELETE statements per table and sweep. */
export const PROTECTION_PURGE_MAX_CHUNKS = 10
export const PROTECTION_MESSAGE_MAX = 300

export type ProtectionMode = "off" | "notify" | "pause"
export interface ProtectionSettings {
  mode: ProtectionMode
  windowMinutes: number
  minRiskyErrors: number
  minFailureRatio: number
  authBurst: number
  keyShare: number
  cooldownMinutes: number
  maxCooldownMinutes: number
}
export const DEFAULT_PROTECTION_SETTINGS: ProtectionSettings = {
  mode: "off", windowMinutes: 5, minRiskyErrors: 20, minFailureRatio: 0.5, authBurst: 5, keyShare: 0.8, cooldownMinutes: 30, maxCooldownMinutes: 360,
}
/** Inclusive [min, max] per numeric field. */
export const PROTECTION_LIMITS = {
  windowMinutes: [1, 60], minRiskyErrors: [1, 10000], minFailureRatio: [0, 1], authBurst: [0, 10000],
  keyShare: [0.5, 1], cooldownMinutes: [1, 1440], maxCooldownMinutes: [1, 10080],
} as const satisfies Record<Exclude<keyof ProtectionSettings, "mode">, readonly [number, number]>

export interface ErrorSampleInput { status: number; /** unix ms */ at: number; code: string; message: string }
export interface UpstreamResponseRecord {
  /** Unix seconds, start of the minute. */
  minute: number
  upstreamId: string
  keyId: string
  model: string
  cls: ErrorClass
  sample?: ErrorSampleInput
}
export interface ErrorSample extends ErrorSampleInput { upstreamId: string; keyId: string; model: string }

export interface ClassCounts {
  requests: number
  rate_limited: number
  rejected: number
  auth: number
  upstream: number
  network: number
  other: number
}
export interface KeyWindowCounts extends ClassCounts { keyId: string }
export interface WindowSummary { totals: ClassCounts; byKey: KeyWindowCounts[] }
/** `t` is unix seconds at the start of the bucket. */
export interface ErrorBucket extends ClassCounts { t: number }

export type PauseTargetKind = "upstream" | "key"
export type PauseMode = "pause" | "notify"
export type PauseResolver = "auto" | "owner"
export interface PauseReason {
  windowMinutes: number
  requests: number
  risky: number
  counts: Omit<ClassCounts, "requests">
  failureRatio: number
  topKeys: Array<{ keyId: string; risky: number }>
  trigger: "ratio" | "authBurst"
  /** Share of the risky errors caused by the attributed key, when there is one. */
  keyShare: number | null
  upstreamName?: string
  targetName?: string
}
export interface PauseRecord {
  id: string
  targetKind: PauseTargetKind
  targetId: string
  upstreamId: string
  mode: PauseMode
  reason: PauseReason
  /** Unix ms. */
  startedAt: number
  endsAt: number
  resolvedAt: number | null
  resolvedBy: PauseResolver | null
}
export type NewPause = Omit<PauseRecord, "resolvedAt" | "resolvedBy">

export interface ProtectionRepo {
  /** One upsert (`ok`/`other`) or one atomic batch (upsert + sample + trim to 20 per upstream and status). */
  recordResponse(input: UpstreamResponseRecord): Promise<void>
  /** Sums over minutes `[fromMinute, toMinute]` (unix seconds, inclusive), per key. */
  windowSummary(upstreamId: string, fromMinute: number, toMinute: number): Promise<WindowSummary>
  /** Sums per bucket over `[fromSec, toSec)`; sparse (empty buckets absent), oldest first. */
  errorBuckets(upstreamId: string, fromSec: number, toSec: number, bucketSeconds: 60 | 3600, keyId?: string): Promise<ErrorBucket[]>
  /** Latest samples, ordered by status then newest first. */
  listSamples(upstreamId: string): Promise<ErrorSample[]>
  getSettings(upstreamId: string): Promise<Record<string, unknown> | null>
  getSettingsMany(upstreamIds: readonly string[]): Promise<Map<string, Record<string, unknown>>>
  setSettings(upstreamId: string, settings: ProtectionSettings, nowMs: number): Promise<void>
  /** False (nothing written) when an unresolved, unexpired row already targets the same (kind, id). */
  insertPauseIfNone(pause: NewPause, nowMs: number): Promise<boolean>
  /** Rows of the same target and mode that started at or after `sinceMs`. */
  countRecentPauses(kind: PauseTargetKind, targetId: string, mode: PauseMode, sinceMs: number): Promise<number>
  /** Unresolved rows with `endsAt > nowMs`, newest first. */
  listActive(nowMs: number): Promise<PauseRecord[]>
  /** Newest first. */
  listPauses(upstreamId: string, limit: number): Promise<PauseRecord[]>
  getPause(id: string): Promise<PauseRecord | null>
  /** False when the row is missing or already resolved. */
  resolvePause(id: string, by: PauseResolver, nowMs: number): Promise<boolean>
  /** Retention; bounded statements per call. Pass `chunk`/`maxChunks` to override (tests). */
  deleteExpired(nowMs: number, options?: { chunk?: number; maxChunks?: number }):
    Promise<{ resolved: number; minutes: number; pauses: number; samples: number; settings: number }>
}

export const emptyCounts = (): ClassCounts => ({ requests: 0, rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 })
/** Risky errors of a count set. */
export const riskyCount = (c: Pick<ClassCounts, "rate_limited" | "rejected" | "auth">): number => c.rate_limited + c.rejected + c.auth
```

- [ ] **Step 2: Write the contract test (shared by both runtimes)**

```ts
// packages/gateway/tests/protection-repo-contract.ts
import { expect, test } from "bun:test"
import type { NewPause, ProtectionRepo, ProtectionSettings } from "../src/repo/protection"
import { DEFAULT_PROTECTION_SETTINGS, PROTECTION_PURGE_CHUNK } from "../src/repo/protection"

const MIN = 60
const T0 = 1_800_000_000 - (1_800_000_000 % 3600) // a unix-second hour boundary
const pid = (n: number) => `pp_${n.toString(16).padStart(32, "0")}`
const pause = (n: number, over: Partial<NewPause> = {}): NewPause => ({
  id: pid(n), targetKind: "upstream", targetId: `up_test_p${n}`, upstreamId: `up_test_p${n}`, mode: "pause",
  reason: { windowMinutes: 5, requests: 10, risky: 8, counts: { rate_limited: 8, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.8, topKeys: [{ keyId: "key_test_1", risky: 8 }], trigger: "ratio", keyShare: null },
  startedAt: 1_000, endsAt: 61_000, ...over,
})

export function protectionRepoContract(getRepo: () => ProtectionRepo, run: (sql: string, binds?: unknown[]) => Promise<void>) {
  test.serial("minute upserts add up per (upstream, minute, key, model) and the window sums them per key", async () => {
    const repo = getRepo()
    const base = { upstreamId: "up_test_w", model: "gpt-x" }
    for (const cls of ["ok", "rate_limited", "rate_limited"] as const) await repo.recordResponse({ ...base, minute: T0, keyId: "key_test_a", cls })
    await repo.recordResponse({ ...base, minute: T0 + MIN, keyId: "key_test_b", cls: "auth" })
    await repo.recordResponse({ ...base, minute: T0 + 2 * MIN, keyId: "key_test_a", cls: "other" })
    await repo.recordResponse({ ...base, minute: T0 - MIN, keyId: "key_test_a", cls: "rejected" }) // outside the window
    await repo.recordResponse({ upstreamId: "up_test_other", model: "gpt-x", minute: T0, keyId: "key_test_a", cls: "rate_limited" })
    const window = await repo.windowSummary("up_test_w", T0, T0 + 2 * MIN)
    expect(window.totals).toEqual({ requests: 5, rate_limited: 2, rejected: 0, auth: 1, upstream: 0, network: 0, other: 1 })
    const a = window.byKey.find(k => k.keyId === "key_test_a")
    expect(a).toMatchObject({ requests: 4, rate_limited: 2, other: 1 })
    expect(window.byKey.find(k => k.keyId === "key_test_b")).toMatchObject({ requests: 1, auth: 1 })
    expect((await repo.windowSummary("up_test_empty", T0, T0 + MIN)).totals.requests).toBe(0)
  })

  test.serial("error samples are trimmed to the latest 20 per (upstream, status) and statuses do not trim each other", async () => {
    const repo = getRepo()
    for (let i = 0; i < 25; i++) {
      await repo.recordResponse({ upstreamId: "up_test_s", model: "m", minute: T0, keyId: "key_test_a", cls: "rate_limited",
        sample: { status: 429, at: 10_000 + i, code: "rate_limit_exceeded", message: `slow down ${i}` } })
    }
    await repo.recordResponse({ upstreamId: "up_test_s", model: "m", minute: T0, keyId: "key_test_a", cls: "network", sample: { status: 0, at: 5, code: "", message: "TypeError" } })
    const samples = await repo.listSamples("up_test_s")
    const s429 = samples.filter(s => s.status === 429)
    expect(s429).toHaveLength(20)
    expect(s429[0]).toMatchObject({ at: 10_024, message: "slow down 24", code: "rate_limit_exceeded", keyId: "key_test_a", model: "m" })
    expect(s429[19]?.at).toBe(10_005)
    expect(samples.filter(s => s.status === 0)).toHaveLength(1)
    expect(samples[0]?.status).toBe(0) // ordered by status
    // The counts of the same calls were upserted too.
    expect((await repo.windowSummary("up_test_s", T0, T0)).totals).toMatchObject({ requests: 26, rate_limited: 25, network: 1 })
  })

  test.serial("error buckets group by hour or minute, filter by key and stay sparse", async () => {
    const repo = getRepo()
    const base = { upstreamId: "up_test_b", model: "m" }
    await repo.recordResponse({ ...base, minute: T0 + 5 * MIN, keyId: "key_test_a", cls: "rate_limited" })
    await repo.recordResponse({ ...base, minute: T0 + 6 * MIN, keyId: "key_test_b", cls: "ok" })
    await repo.recordResponse({ ...base, minute: T0 + 3600 + MIN, keyId: "key_test_a", cls: "auth" })
    const hours = await repo.errorBuckets("up_test_b", T0, T0 + 3 * 3600, 3600)
    expect(hours.map(b => [b.t, b.requests, b.rate_limited, b.auth])).toEqual([[T0, 2, 1, 0], [T0 + 3600, 1, 0, 1]])
    const minutes = await repo.errorBuckets("up_test_b", T0, T0 + 3600, 60)
    expect(minutes.map(b => b.t)).toEqual([T0 + 5 * MIN, T0 + 6 * MIN])
    const onlyA = await repo.errorBuckets("up_test_b", T0, T0 + 3 * 3600, 3600, "key_test_a")
    expect(onlyA.map(b => b.requests)).toEqual([1, 1])
    expect(await repo.errorBuckets("up_test_b", T0 + 10 * 3600, T0 + 11 * 3600, 3600)).toEqual([])
  })

  test.serial("settings round-trip, many at once, and a missing row is null", async () => {
    const repo = getRepo()
    expect(await repo.getSettings("up_test_cfg")).toBeNull()
    const settings: ProtectionSettings = { ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", windowMinutes: 10 }
    await repo.setSettings("up_test_cfg", settings, 1)
    await repo.setSettings("up_test_cfg", { ...settings, minRiskyErrors: 7 }, 2)
    await repo.setSettings("up_test_cfg2", { ...settings, mode: "notify" }, 3)
    expect(await repo.getSettings("up_test_cfg")).toMatchObject({ mode: "pause", windowMinutes: 10, minRiskyErrors: 7 })
    const many = await repo.getSettingsMany(["up_test_cfg", "up_test_cfg2", "up_test_none"])
    expect([...many.keys()].sort()).toEqual(["up_test_cfg", "up_test_cfg2"])
    expect(many.get("up_test_cfg2")).toMatchObject({ mode: "notify" })
    expect((await repo.getSettingsMany([])).size).toBe(0)
  })

  test.serial("pauses insert once per target while active, list as active, resolve, and count recent history", async () => {
    const repo = getRepo()
    const first = pause(1, { targetId: "up_test_pa", upstreamId: "up_test_pa", startedAt: 1_000, endsAt: 61_000 })
    expect(await repo.insertPauseIfNone(first, 2_000)).toBe(true)
    expect(await repo.insertPauseIfNone(pause(2, { targetId: "up_test_pa", upstreamId: "up_test_pa" }), 2_000)).toBe(false)
    expect(await repo.insertPauseIfNone(pause(3, { targetKind: "key", targetId: "key_test_pa", upstreamId: "up_test_pa" }), 2_000)).toBe(true)
    expect((await repo.listActive(2_000)).map(p => p.id).sort()).toEqual([pid(1), pid(3)])
    expect((await repo.getPause(pid(1)))?.reason.trigger).toBe("ratio")
    expect(await repo.getPause(pid(99))).toBeNull()
    expect(await repo.listActive(61_000)).toEqual([]) // both rows end at 61_000 and `ends_at > now` is strict
    expect(await repo.resolvePause(pid(1), "owner", 3_000)).toBe(true)
    expect(await repo.resolvePause(pid(1), "owner", 3_001)).toBe(false)
    expect(await repo.getPause(pid(1))).toMatchObject({ resolvedAt: 3_000, resolvedBy: "owner" })
    // Resolved rows no longer block a new row for the same target.
    expect(await repo.insertPauseIfNone(pause(4, { targetId: "up_test_pa", upstreamId: "up_test_pa", startedAt: 5_000, endsAt: 65_000 }), 5_000)).toBe(true)
    expect(await repo.countRecentPauses("upstream", "up_test_pa", "pause", 0)).toBe(2)
    expect(await repo.countRecentPauses("upstream", "up_test_pa", "pause", 2_000)).toBe(1)
    expect(await repo.countRecentPauses("upstream", "up_test_pa", "notify", 0)).toBe(0)
    expect((await repo.listPauses("up_test_pa", 2)).map(p => p.id)).toEqual([pid(4), pid(3)])
  })

  test.serial("retention deletes old minutes and pauses, auto-resolves expired rows and drops samples and settings of vanished upstreams", async () => {
    const repo = getRepo()
    const now = Date.UTC(2026, 10, 17)
    const nowSec = now / 1000
    const day = 86_400
    await run("INSERT INTO upstreams (id, provider, name, created_at, updated_at) VALUES ('up_test_live', 'custom', 'live', 't', 't')")
    for (const id of ["up_test_live", "up_test_gone"]) {
      await repo.recordResponse({ upstreamId: id, model: "m", minute: nowSec - 31 * day, keyId: "k", cls: "ok" })
      await repo.recordResponse({ upstreamId: id, model: "m", minute: nowSec - 29 * day, keyId: "k", cls: "rate_limited", sample: { status: 429, at: now, code: "", message: "x" } })
      await repo.setSettings(id, DEFAULT_PROTECTION_SETTINGS, now)
    }
    await repo.insertPauseIfNone(pause(10, { targetId: "up_test_live", upstreamId: "up_test_live", startedAt: now - 91 * 86_400_000, endsAt: now - 91 * 86_400_000 + 1_000 }), now - 91 * 86_400_000)
    await repo.insertPauseIfNone(pause(11, { targetId: "up_test_live2", upstreamId: "up_test_live", startedAt: now - 3_600_000, endsAt: now - 1_000 }), now - 3_600_000)
    // Earlier tests left rows for upstreams that have no `upstreams` row and pauses from 1970; they expire here too, so counts are lower bounds.
    const result = await repo.deleteExpired(now)
    expect(result.minutes).toBeGreaterThanOrEqual(2)
    expect(result.pauses).toBeGreaterThanOrEqual(1)
    expect(result.samples).toBeGreaterThanOrEqual(1)
    expect(result.settings).toBeGreaterThanOrEqual(1)
    expect(result.resolved).toBeGreaterThanOrEqual(1)
    expect(await repo.getPause(pid(10))).toBeNull()
    expect(await repo.getPause(pid(11))).toMatchObject({ resolvedBy: "auto", resolvedAt: now - 1_000 })
    expect((await repo.listSamples("up_test_gone"))).toEqual([])
    expect((await repo.listSamples("up_test_live"))).toHaveLength(1)
    expect(await repo.getSettings("up_test_gone")).toBeNull()
    expect(await repo.getSettings("up_test_live")).not.toBeNull()
    expect((await repo.windowSummary("up_test_live", nowSec - 40 * day, nowSec)).totals.requests).toBe(1)
  })

  test.serial("retention works in bounded chunks and a later call continues", async () => {
    const repo = getRepo()
    const now = Date.UTC(2026, 10, 17)
    for (let i = 0; i < 5; i++) await repo.recordResponse({ upstreamId: "up_test_chunk", model: `m${i}`, minute: now / 1000 - 40 * 86_400 + i * 60, keyId: "k", cls: "ok" })
    const first = await repo.deleteExpired(now, { chunk: 2, maxChunks: 2 })
    expect(first.minutes).toBe(4)
    const second = await repo.deleteExpired(now, { chunk: 2, maxChunks: 2 })
    expect(second.minutes).toBe(1)
    expect(PROTECTION_PURGE_CHUNK).toBeGreaterThan(2)
  })
}
```


```ts
// packages/gateway/tests/protection-repo.sqlite.test.ts
import { afterAll, beforeAll } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { protectionRepoContract } from "./protection-repo-contract"

let db: Database
let repo: BunSqliteRepo
beforeAll(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterAll(() => db.close())

protectionRepoContract(() => repo.protection, async (sql, binds = []) => { db.run(sql, binds as never[]) })
```

```ts
// packages/gateway/tests/protection-repo.d1.test.ts
import { afterAll, beforeAll } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { D1Repo, type D1Database } from "@vibe-llm/platform-cloudflare/src/d1-repo.ts"
import { migrationsDir } from "../src/migrations-dir.ts"
import { protectionRepoContract } from "./protection-repo-contract"

let dir: string
let mf: Miniflare
let repo: D1Repo
let d1: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> }; run(): Promise<unknown> } }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "protection-repo-d1-"))
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fixture') } }",
    host: "127.0.0.1", port: 0, compatibilityDate: "2025-06-01", d1Databases: { DB: "protection-repo" }, d1Persist: join(dir, "d1") })
  const db = await mf.getD1Database("DB")
  const source = fileURLToPath(migrationsDir)
  for (const name of readdirSync(source).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of unstable_splitSqlQuery(readFileSync(join(source, name), "utf8"))) await db.prepare(sql).run()
  }
  d1 = db as unknown as typeof d1
  repo = new D1Repo(db as unknown as D1Database)
})
afterAll(async () => { await mf?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true }) })

protectionRepoContract(() => repo.protection, async (sql, binds = []) => { await (binds.length ? d1.prepare(sql).bind(...binds) : d1.prepare(sql)).run() })
```

- [ ] **Step 3: Run and see the failure**

Run: `bun test packages/gateway/tests/protection-repo.sqlite.test.ts`
Expected: FAIL (`repo.protection` is undefined: `TypeError: undefined is not an object`).

- [ ] **Step 4: Implement the shared repo**

```ts
// packages/gateway/src/repo/shared/protection.ts
import {
  COUNTED_CLASSES, ERROR_CLASSES, PROTECTION_MINUTES_RETENTION_DAYS, PROTECTION_PAUSES_RETENTION_DAYS, PROTECTION_PURGE_CHUNK,
  PROTECTION_PURGE_MAX_CHUNKS, PROTECTION_SAMPLES_PER_STATUS, emptyCounts,
  type ClassCounts, type ErrorBucket, type ErrorClass, type ErrorSample, type NewPause, type PauseMode, type PauseReason, type PauseRecord,
  type PauseResolver, type PauseTargetKind, type ProtectionRepo, type ProtectionSettings, type UpstreamResponseRecord, type WindowSummary,
} from "../protection.ts"
import type { SqlExecutor, SqlStatement } from "./executor.ts"

type CountRow = { [K in keyof ClassCounts]: number | null }
const SUMS = `SUM(requests) AS requests, SUM(rate_limited) AS rate_limited, SUM(rejected) AS rejected, SUM(auth) AS auth,
  SUM(upstream) AS upstream, SUM(network) AS network, SUM(other) AS other`
const toCounts = (row: Partial<CountRow>): ClassCounts => ({
  requests: Number(row.requests ?? 0), rate_limited: Number(row.rate_limited ?? 0), rejected: Number(row.rejected ?? 0), auth: Number(row.auth ?? 0),
  upstream: Number(row.upstream ?? 0), network: Number(row.network ?? 0), other: Number(row.other ?? 0),
})

/** `cls` comes from the closed `ErrorClass` union, so the column name is safe to inline. */
const upsertSql = (cls: ErrorClass): string => {
  if (!(ERROR_CLASSES as readonly string[]).includes(cls)) throw new Error(`unknown error class: ${cls}`)
  const column = cls === "ok" ? null : cls
  return `INSERT INTO upstream_request_minutes (minute, upstream_id, key_id, model, requests${column ? `, ${column}` : ""})
    VALUES (?, ?, ?, ?, 1${column ? ", 1" : ""})
    ON CONFLICT (upstream_id, minute, key_id, model) DO UPDATE SET requests = requests + 1${column ? `, ${column} = ${column} + 1` : ""}`
}

const INSERT_SAMPLE_SQL = `INSERT INTO upstream_error_samples (upstream_id, status, at, key_id, model, code, message) VALUES (?, ?, ?, ?, ?, ?, ?)`
const TRIM_SAMPLES_SQL = `DELETE FROM upstream_error_samples WHERE upstream_id = ? AND status = ? AND rowid NOT IN
  (SELECT rowid FROM upstream_error_samples WHERE upstream_id = ? AND status = ? ORDER BY at DESC, rowid DESC LIMIT ${PROTECTION_SAMPLES_PER_STATUS})`

interface PauseRow {
  id: string; target_kind: PauseTargetKind; target_id: string; upstream_id: string; mode: PauseMode; reason_json: string
  started_at: number; ends_at: number; resolved_at: number | null; resolved_by: PauseResolver | null
}
const PAUSE_COLS = "id, target_kind, target_id, upstream_id, mode, reason_json, started_at, ends_at, resolved_at, resolved_by"
const parseReason = (json: string): PauseReason => {
  try { return JSON.parse(json) as PauseReason } catch {
    return { windowMinutes: 0, requests: 0, risky: 0, counts: { rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0, topKeys: [], trigger: "ratio", keyShare: null }
  }
}
const toPause = (row: PauseRow): PauseRecord => ({
  id: row.id, targetKind: row.target_kind, targetId: row.target_id, upstreamId: row.upstream_id, mode: row.mode, reason: parseReason(row.reason_json),
  startedAt: Number(row.started_at), endsAt: Number(row.ends_at), resolvedAt: row.resolved_at === null ? null : Number(row.resolved_at), resolvedBy: row.resolved_by,
})

export class SharedProtectionRepo implements ProtectionRepo {
  constructor(private readonly x: SqlExecutor) {}

  async recordResponse(input: UpstreamResponseRecord): Promise<void> {
    const upsert: SqlStatement = { sql: upsertSql(input.cls), binds: [input.minute, input.upstreamId, input.keyId, input.model] }
    const sample = input.sample
    if (!sample) { await this.x.run(upsert.sql, upsert.binds); return }
    if (!this.x.batch) throw new Error("protection samples need an executor with batch support")
    await this.x.batch([
      upsert,
      { sql: INSERT_SAMPLE_SQL, binds: [input.upstreamId, sample.status, sample.at, input.keyId, input.model, sample.code, sample.message] },
      { sql: TRIM_SAMPLES_SQL, binds: [input.upstreamId, sample.status, input.upstreamId, sample.status] },
    ])
  }

  async windowSummary(upstreamId: string, fromMinute: number, toMinute: number): Promise<WindowSummary> {
    const rows = await this.x.all<CountRow & { key_id: string }>(
      `SELECT key_id, ${SUMS} FROM upstream_request_minutes WHERE upstream_id = ? AND minute >= ? AND minute <= ? GROUP BY key_id`,
      [upstreamId, fromMinute, toMinute])
    const totals = emptyCounts()
    const byKey = rows.map(row => ({ keyId: row.key_id, ...toCounts(row) }))
    for (const key of byKey) {
      totals.requests += key.requests
      for (const cls of COUNTED_CLASSES) totals[cls] += key[cls]
    }
    return { totals, byKey }
  }

  async errorBuckets(upstreamId: string, fromSec: number, toSec: number, bucketSeconds: 60 | 3600, keyId?: string): Promise<ErrorBucket[]> {
    const size = bucketSeconds === 3600 ? 3600 : 60 // inlined: only these two literals ever reach the SQL text
    const rows = await this.x.all<CountRow & { t: number }>(
      `SELECT (minute / ${size}) * ${size} AS t, ${SUMS} FROM upstream_request_minutes
       WHERE upstream_id = ? AND minute >= ? AND minute < ?${keyId === undefined ? "" : " AND key_id = ?"} GROUP BY t ORDER BY t`,
      keyId === undefined ? [upstreamId, fromSec, toSec] : [upstreamId, fromSec, toSec, keyId])
    return rows.map(row => ({ t: Number(row.t), ...toCounts(row) }))
  }

  async listSamples(upstreamId: string): Promise<ErrorSample[]> {
    const rows = await this.x.all<{ upstream_id: string; status: number; at: number; key_id: string; model: string; code: string; message: string }>(
      `SELECT upstream_id, status, at, key_id, model, code, message FROM upstream_error_samples WHERE upstream_id = ?
       ORDER BY status ASC, at DESC, rowid DESC LIMIT 400`, [upstreamId])
    return rows.map(row => ({ upstreamId: row.upstream_id, status: Number(row.status), at: Number(row.at), keyId: row.key_id, model: row.model, code: row.code, message: row.message }))
  }

  private parseSettings(json: string): Record<string, unknown> | null {
    try {
      const value: unknown = JSON.parse(json)
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch { return null }
  }

  async getSettings(upstreamId: string): Promise<Record<string, unknown> | null> {
    const row = await this.x.first<{ settings_json: string }>("SELECT settings_json FROM upstream_protection_settings WHERE upstream_id = ?", [upstreamId])
    return row ? this.parseSettings(row.settings_json) : null
  }

  async getSettingsMany(upstreamIds: readonly string[]): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>()
    if (upstreamIds.length === 0) return out
    const rows = await this.x.all<{ upstream_id: string; settings_json: string }>(
      "SELECT upstream_id, settings_json FROM upstream_protection_settings WHERE upstream_id IN (SELECT value FROM json_each(?))", [JSON.stringify(upstreamIds)])
    for (const row of rows) {
      const parsed = this.parseSettings(row.settings_json)
      if (parsed) out.set(row.upstream_id, parsed)
    }
    return out
  }

  async setSettings(upstreamId: string, settings: ProtectionSettings, nowMs: number): Promise<void> {
    await this.x.run(
      `INSERT INTO upstream_protection_settings (upstream_id, settings_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (upstream_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`,
      [upstreamId, JSON.stringify(settings), nowMs])
  }

  async insertPauseIfNone(pause: NewPause, nowMs: number): Promise<boolean> {
    const result = await this.x.run(
      `INSERT INTO protection_pauses (id, target_kind, target_id, upstream_id, mode, reason_json, started_at, ends_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM protection_pauses WHERE target_kind = ? AND target_id = ? AND resolved_at IS NULL AND ends_at > ?)`,
      [pause.id, pause.targetKind, pause.targetId, pause.upstreamId, pause.mode, JSON.stringify(pause.reason), pause.startedAt, pause.endsAt,
        pause.targetKind, pause.targetId, nowMs])
    return result.changes > 0
  }

  async countRecentPauses(kind: PauseTargetKind, targetId: string, mode: PauseMode, sinceMs: number): Promise<number> {
    const row = await this.x.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM protection_pauses WHERE target_kind = ? AND target_id = ? AND mode = ? AND started_at >= ?", [kind, targetId, mode, sinceMs])
    return Number(row?.n ?? 0)
  }

  async listActive(nowMs: number): Promise<PauseRecord[]> {
    const rows = await this.x.all<PauseRow>(
      `SELECT ${PAUSE_COLS} FROM protection_pauses WHERE resolved_at IS NULL AND ends_at > ? ORDER BY started_at DESC, id DESC`, [nowMs])
    return rows.map(toPause)
  }

  async listPauses(upstreamId: string, limit: number): Promise<PauseRecord[]> {
    const rows = await this.x.all<PauseRow>(
      `SELECT ${PAUSE_COLS} FROM protection_pauses WHERE upstream_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`, [upstreamId, limit])
    return rows.map(toPause)
  }

  async getPause(id: string): Promise<PauseRecord | null> {
    const row = await this.x.first<PauseRow>(`SELECT ${PAUSE_COLS} FROM protection_pauses WHERE id = ?`, [id])
    return row ? toPause(row) : null
  }

  async resolvePause(id: string, by: PauseResolver, nowMs: number): Promise<boolean> {
    const result = await this.x.run("UPDATE protection_pauses SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL", [nowMs, by, id])
    return result.changes > 0
  }

  async deleteExpired(nowMs: number, options: { chunk?: number; maxChunks?: number } = {}) {
    const chunk = options.chunk ?? PROTECTION_PURGE_CHUNK
    const maxChunks = options.maxChunks ?? PROTECTION_PURGE_MAX_CHUNKS
    /** Repeats a `... LIMIT ?` statement until it deletes less than a full chunk or the table's budget is used. */
    const drain = async (sql: string, binds: unknown[]): Promise<number> => {
      let total = 0
      for (let i = 0; i < maxChunks; i++) {
        const { changes } = await this.x.run(sql, [...binds, chunk])
        total += changes
        if (changes < chunk) break
      }
      return total
    }
    const resolved = (await this.x.run(
      `UPDATE protection_pauses SET resolved_at = ends_at, resolved_by = 'auto'
       WHERE id IN (SELECT id FROM protection_pauses WHERE resolved_at IS NULL AND ends_at <= ? LIMIT ?)`, [nowMs, chunk])).changes
    const minutes = await drain(
      "DELETE FROM upstream_request_minutes WHERE rowid IN (SELECT rowid FROM upstream_request_minutes WHERE minute < ? LIMIT ?)",
      [Math.floor(nowMs / 1000) - PROTECTION_MINUTES_RETENTION_DAYS * 86_400])
    const pauses = await drain(
      "DELETE FROM protection_pauses WHERE id IN (SELECT id FROM protection_pauses WHERE started_at < ? LIMIT ?)",
      [nowMs - PROTECTION_PAUSES_RETENTION_DAYS * 86_400_000])
    const samples = await drain(
      `DELETE FROM upstream_error_samples WHERE rowid IN
        (SELECT s.rowid FROM upstream_error_samples s WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = s.upstream_id) LIMIT ?)`, [])
    const settings = await drain(
      `DELETE FROM upstream_protection_settings WHERE upstream_id IN
        (SELECT p.upstream_id FROM upstream_protection_settings p WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = p.upstream_id) LIMIT ?)`, [])
    return { resolved, minutes, pauses, samples, settings }
  }
}
```

- [ ] **Step 5: Wire it into `Repo`, `buildSharedRepo`, and both platform repos**

In `packages/gateway/src/repo/types.ts` add next to the telemetry import and the interface:

```ts
import type { ProtectionRepo } from "./protection.ts"
// ... inside `export interface Repo {` after `telemetry: TelemetryRepo`:
  protection: ProtectionRepo
```

In `packages/gateway/src/repo/shared/repos.ts`:

```ts
import { SharedProtectionRepo } from "./protection.ts"
// ... in the returned object after `telemetry: new SharedTelemetryRepo(x),`:
    protection: new SharedProtectionRepo(x),
```

In `apps/platform-bun/src/bun-sqlite-repo.ts` add the field `protection: Repo["protection"]` after `telemetry: Repo["telemetry"]` and `this.protection = shared.protection` after `this.telemetry = shared.telemetry`. Make the identical two additions in `apps/platform-cloudflare/src/d1-repo.ts` (field near L216, assignment near L246).

Also export the public types from `packages/gateway/src/repo/index.ts` below the telemetry export:

```ts
export type { ProtectionRepo, ProtectionSettings, PauseRecord, ErrorClass } from "./protection.ts"
```

- [ ] **Step 6: Run the tests**

Run: `bun test packages/gateway/tests/protection-repo.sqlite.test.ts packages/gateway/tests/protection-repo.d1.test.ts`
Expected: PASS (7 tests per file).

Run: `bun run --filter '@vibe-llm/gateway' typecheck && bun run --filter '@vibe-llm/platform-bun' typecheck && bun run --filter '@vibe-llm/platform-cloudflare' typecheck`
Expected: no errors. (If another test file builds a full `Repo` literal and now fails to typecheck, add `protection: undefined as never` there; none exists at the time of writing, `grep -rn "proxyBackoffs:" packages apps` shows only a `Pick`.)

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/repo packages/gateway/tests/protection-repo-contract.ts packages/gateway/tests/protection-repo.sqlite.test.ts packages/gateway/tests/protection-repo.d1.test.ts apps/platform-bun/src/bun-sqlite-repo.ts apps/platform-cloudflare/src/d1-repo.ts
git commit -m "feat(protection): ProtectionRepo with shared SQL, wired into D1 and SQLite" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 3: Classification and error-detail extraction (pure)

**Files:**
- Create: `packages/gateway/src/protection/classify.ts`
- Create: `packages/gateway/tests/protection-classify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-classify.test.ts
import { expect, test } from "bun:test"
import { classifyStatus, classifyThrown, extractErrorDetail, isRiskyClass, isSampledClass } from "../src/protection/classify"

test("statuses map to the spec's classes", () => {
  const table: Array<[number, string]> = [
    [200, "ok"], [204, "ok"], [299, "ok"], [429, "rate_limited"],
    [400, "rejected"], [404, "rejected"], [409, "rejected"], [413, "rejected"], [422, "rejected"],
    [401, "auth"], [403, "auth"], [500, "upstream"], [502, "upstream"], [503, "upstream"], [599, "upstream"],
    [100, "other"], [302, "other"], [402, "other"], [405, "other"], [408, "other"], [418, "other"], [600, "other"],
  ]
  for (const [status, cls] of table) expect(classifyStatus(status), String(status)).toBe(cls as never)
})

test("only rate-limit, rejected and auth are risky; ok and other are not sampled", () => {
  expect(["rate_limited", "rejected", "auth"].every(c => isRiskyClass(c as never))).toBe(true)
  expect(["ok", "upstream", "network", "other"].some(c => isRiskyClass(c as never))).toBe(false)
  expect(["rate_limited", "rejected", "auth", "upstream", "network"].every(c => isSampledClass(c as never))).toBe(true)
  expect(isSampledClass("ok")).toBe(false)
  expect(isSampledClass("other")).toBe(false)
})

test("thrown errors are network only when they look like transport failures, and never when the caller aborted", () => {
  expect(classifyThrown(new TypeError("fetch failed"))).toBe("network")
  expect(classifyThrown(Object.assign(new Error("slow"), { name: "TimeoutError" }))).toBe("network")
  expect(classifyThrown(Object.assign(new Error("reset"), { code: "ECONNRESET" }))).toBe("network")
  expect(classifyThrown(new Error("outer", { cause: Object.assign(new Error("inner"), { code: "ETIMEDOUT" }) }))).toBe("network")
  expect(classifyThrown(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBeNull()
  expect(classifyThrown(new Error("affinity routing unavailable"))).toBeNull()
  expect(classifyThrown("string")).toBeNull()
  const controller = new AbortController()
  controller.abort()
  expect(classifyThrown(new TypeError("fetch failed"), controller.signal)).toBeNull()
})

test("error details come from the common JSON shapes", () => {
  expect(extractErrorDetail(JSON.stringify({ error: { message: "Rate limit reached", code: "rate_limit_exceeded", type: "requests" } })))
    .toEqual({ code: "rate_limit_exceeded", message: "Rate limit reached" })
  expect(extractErrorDetail(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Slow down" } })))
    .toEqual({ code: "rate_limit_error", message: "Slow down" })
  expect(extractErrorDetail(JSON.stringify({ error: "plain string" }))).toEqual({ code: "", message: "plain string" })
  expect(extractErrorDetail(JSON.stringify({ message: "top level", code: 42 }))).toEqual({ code: "42", message: "top level" })
  expect(extractErrorDetail(JSON.stringify({ detail: "d" }))).toEqual({ code: "", message: "d" })
})

test("details are trimmed to 300 characters, whitespace collapsed, tokens (and any 40+ character blob) redacted, HTML dropped", () => {
  const long = extractErrorDetail(JSON.stringify({ error: { message: "word ".repeat(100) } }))
  expect(long.message).toHaveLength(300)
  expect(extractErrorDetail(JSON.stringify({ error: { message: "a \n\n  b\tc" } })).message).toBe("a b c")
  const redacted = extractErrorDetail(JSON.stringify({ error: { message: "Incorrect API key sk-FAKEFAKEFAKE0000 and Bearer FAKEFAKEFAKE0000abc and ghp_FAKEFAKEFAKE0000" } })).message
  expect(redacted).toBe("Incorrect API key [redacted] and [redacted] and [redacted]")
  expect(extractErrorDetail("<html><body>Bad gateway</body></html>")).toEqual({ code: "", message: "" })
  expect(extractErrorDetail("  upstream said no \n")).toEqual({ code: "", message: "upstream said no" })
  expect(extractErrorDetail("")).toEqual({ code: "", message: "" })
  expect(extractErrorDetail('{"error":{"message":"cut off')).toEqual({ code: "", message: '{"error":{"message":"cut off' })
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-classify.test.ts`
Expected: FAIL (`Cannot find module "../src/protection/classify"`).

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/protection/classify.ts
import { PROTECTION_MESSAGE_MAX, RISKY_CLASSES, SAMPLED_CLASSES, type ErrorClass } from "../repo/protection.ts"

const REJECTED = new Set([400, 404, 409, 413, 422])

/** The spec's table. A stream that starts with 2xx is `ok` whatever happens later. */
export function classifyStatus(status: number): ErrorClass {
  if (status >= 200 && status < 300) return "ok"
  if (status === 429) return "rate_limited"
  if (REJECTED.has(status)) return "rejected"
  if (status === 401 || status === 403) return "auth"
  if (status >= 500 && status < 600) return "upstream"
  return "other"
}

export const isRiskyClass = (cls: ErrorClass): boolean => (RISKY_CLASSES as readonly string[]).includes(cls)
export const isSampledClass = (cls: ErrorClass): boolean => SAMPLED_CLASSES.includes(cls)

const SOCKET_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT",
  "ConnectionRefused", "ConnectionClosed", "FailedToOpenSocket",
])
const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code

/**
 * A thrown error is a `network` failure only when it looks like a transport failure. Caller aborts and
 * gateway-side errors (affinity fence, validation) return null: they never reached the upstream, or were not its fault.
 */
export function classifyThrown(error: unknown, signal?: AbortSignal): ErrorClass | null {
  if (signal?.aborted) return null
  if (!(error instanceof Error)) return null
  if (error.name === "AbortError") return null
  if (error.name === "TimeoutError" || error instanceof TypeError) return "network"
  const code = codeOf(error) ?? codeOf(error.cause)
  return typeof code === "string" && SOCKET_CODES.has(code) ? "network" : null
}

const TOKENISH = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bgithub_pat_[A-Za-z0-9_]{8,}/g,
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|xox[abp]|tlm|ses|lks|sds|stl)[-_][A-Za-z0-9_-]{8,}/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
]
const tidy = (value: string): string => {
  let text = value
  for (const pattern of TOKENISH) text = text.replace(pattern, "[redacted]")
  return text.replace(/\s+/g, " ").trim().slice(0, PROTECTION_MESSAGE_MAX)
}
const scalar = (value: unknown): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : ""

/**
 * The upstream's own error description from a response body (the first few KiB). Request and response content is
 * never stored: only `error.message` and `error.code`/`error.type` shapes are read; HTML pages yield an empty message.
 */
export function extractErrorDetail(text: string): { code: string; message: string } {
  const body = text.trim()
  if (body === "") return { code: "", message: "" }
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { parsed = undefined }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>
    const error = obj.error
    if (typeof error === "string") return { code: "", message: tidy(error) }
    if (error !== null && typeof error === "object") {
      const inner = error as Record<string, unknown>
      return { code: tidy(scalar(inner.code) || scalar(inner.type)), message: tidy(scalar(inner.message)) }
    }
    return { code: tidy(scalar(obj.code) || scalar(obj.type)), message: tidy(scalar(obj.message) || scalar(obj.detail)) }
  }
  if (body.startsWith("<")) return { code: "", message: "" }
  return { code: "", message: tidy(body) }
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `bun test packages/gateway/tests/protection-classify.test.ts`
Expected: PASS (5 tests). Then `bunx eslint packages/gateway/src/protection packages/gateway/tests/protection-classify.test.ts` with no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/protection/classify.ts packages/gateway/tests/protection-classify.test.ts
git commit -m "feat(protection): classify upstream statuses and extract redacted error details" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Protection settings validation

**Files:**
- Create: `packages/gateway/src/protection/settings.ts`
- Create: `packages/gateway/tests/protection-settings.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-settings.test.ts
import { expect, test } from "bun:test"
import { DEFAULT_PROTECTION_SETTINGS, PROTECTION_LIMITS } from "../src/repo/protection"
import { ProtectionSettingsError, normalizeProtection, resolveProtection } from "../src/protection/settings"

test("an empty object leaves the current settings; a partial object merges onto them", () => {
  expect(normalizeProtection({})).toEqual(DEFAULT_PROTECTION_SETTINGS)
  const current = { ...DEFAULT_PROTECTION_SETTINGS, mode: "notify" as const, windowMinutes: 10 }
  expect(normalizeProtection({ minRiskyErrors: 7 }, current)).toEqual({ ...current, minRiskyErrors: 7 })
  expect(normalizeProtection({ mode: "pause" }, current).windowMinutes).toBe(10)
})

test("every numeric field accepts its bounds and rejects just outside them", () => {
  for (const [field, [min, max]] of Object.entries(PROTECTION_LIMITS)) {
    const base = { ...DEFAULT_PROTECTION_SETTINGS, cooldownMinutes: 1, maxCooldownMinutes: 10080 }
    expect(normalizeProtection({ [field]: min }, base)[field as keyof typeof base], `${field} min`).toBe(min)
    expect(normalizeProtection({ [field]: max }, base)[field as keyof typeof base], `${field} max`).toBe(max)
    const step = Number.isInteger(min) && Number.isInteger(max) && field !== "minFailureRatio" && field !== "keyShare" ? 1 : 0.01
    expect(() => normalizeProtection({ [field]: min - step }, base), `${field} below`).toThrow(ProtectionSettingsError)
    expect(() => normalizeProtection({ [field]: max + step }, base), `${field} above`).toThrow(ProtectionSettingsError)
  }
})

test("minutes and counts must be integers; ratios may be fractions; non-numbers are refused", () => {
  expect(() => normalizeProtection({ windowMinutes: 2.5 })).toThrow(ProtectionSettingsError)
  expect(() => normalizeProtection({ authBurst: 1.5 })).toThrow(ProtectionSettingsError)
  expect(normalizeProtection({ minFailureRatio: 0.333 }).minFailureRatio).toBe(0.333)
  expect(normalizeProtection({ authBurst: 0 }).authBurst).toBe(0)
  for (const bad of ["5", null, Number.NaN, Infinity, [], {}]) expect(() => normalizeProtection({ windowMinutes: bad })).toThrow(ProtectionSettingsError)
})

test("mode, unknown keys, the cooldown ordering and non-objects are refused without echoing input", () => {
  expect(() => normalizeProtection({ mode: "ban" })).toThrow(ProtectionSettingsError)
  expect(() => normalizeProtection({ secretToken: "sk-FAKEFAKEFAKE0000" })).toThrow("unknown protection setting")
  expect(() => normalizeProtection({ cooldownMinutes: 100, maxCooldownMinutes: 50 })).toThrow("maxCooldownMinutes")
  for (const bad of [null, "x", 1, []]) expect(() => normalizeProtection(bad)).toThrow(ProtectionSettingsError)
  try { normalizeProtection({ mode: "sk-FAKEFAKEFAKE0000" }) } catch (error) { expect(String(error)).not.toContain("sk-FAKE") }
})

test("stored JSON is read leniently: invalid fields fall back to their defaults", () => {
  expect(resolveProtection(null)).toEqual(DEFAULT_PROTECTION_SETTINGS)
  expect(resolveProtection("nope")).toEqual(DEFAULT_PROTECTION_SETTINGS)
  expect(resolveProtection({ mode: "pause", windowMinutes: 999, minRiskyErrors: 3, extra: true }))
    .toEqual({ ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", minRiskyErrors: 3 })
  expect(resolveProtection({ cooldownMinutes: 100, maxCooldownMinutes: 50 }).maxCooldownMinutes).toBe(100)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-settings.test.ts`
Expected: FAIL (`Cannot find module "../src/protection/settings"`).

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/protection/settings.ts
import { DEFAULT_PROTECTION_SETTINGS, PROTECTION_LIMITS, type ProtectionMode, type ProtectionSettings } from "../repo/protection.ts"

export class ProtectionSettingsError extends Error {}

type NumericField = keyof typeof PROTECTION_LIMITS
const NUMERIC = Object.keys(PROTECTION_LIMITS) as NumericField[]
const INTEGER = new Set<NumericField>(["windowMinutes", "minRiskyErrors", "authBurst", "cooldownMinutes", "maxCooldownMinutes"])
const MODES: readonly ProtectionMode[] = ["off", "notify", "pause"]

const fieldOk = (field: NumericField, value: unknown): value is number => {
  const [min, max] = PROTECTION_LIMITS[field]
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!INTEGER.has(field) || Number.isInteger(value))
}

/**
 * Strict validation for the PATCH route: unknown keys and out-of-range values throw. Keys that are absent keep
 * their value from `current`. Error messages name fields and ranges, never the submitted value.
 */
export function normalizeProtection(input: unknown, current: ProtectionSettings = DEFAULT_PROTECTION_SETTINGS): ProtectionSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ProtectionSettingsError("protection must be an object")
  const raw = input as Record<string, unknown>
  const known = new Set<string>(["mode", ...NUMERIC])
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new ProtectionSettingsError("unknown protection setting")
  const out: ProtectionSettings = { ...current }
  if (raw.mode !== undefined) {
    if (!MODES.includes(raw.mode as ProtectionMode)) throw new ProtectionSettingsError("protection.mode must be off, notify or pause")
    out.mode = raw.mode as ProtectionMode
  }
  for (const field of NUMERIC) {
    const value = raw[field]
    if (value === undefined) continue
    if (!fieldOk(field, value)) {
      const [min, max] = PROTECTION_LIMITS[field]
      throw new ProtectionSettingsError(`protection.${field} must be ${INTEGER.has(field) ? "an integer" : "a number"} between ${min} and ${max}`)
    }
    out[field] = value
  }
  if (out.maxCooldownMinutes < out.cooldownMinutes) throw new ProtectionSettingsError("protection.maxCooldownMinutes must not be below cooldownMinutes")
  return out
}

/** Lenient read of stored JSON: an invalid or missing field takes its default; never throws. */
export function resolveProtection(raw: unknown): ProtectionSettings {
  const out: ProtectionSettings = { ...DEFAULT_PROTECTION_SETTINGS }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out
  const stored = raw as Record<string, unknown>
  if (MODES.includes(stored.mode as ProtectionMode)) out.mode = stored.mode as ProtectionMode
  for (const field of NUMERIC) {
    const value = stored[field]
    if (fieldOk(field, value)) out[field] = value
  }
  if (out.maxCooldownMinutes < out.cooldownMinutes) out.maxCooldownMinutes = out.cooldownMinutes
  return out
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `bun test packages/gateway/tests/protection-settings.test.ts`
Expected: PASS (5 tests). `bunx eslint packages/gateway/src/protection` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/protection/settings.ts packages/gateway/tests/protection-settings.test.ts
git commit -m "feat(protection): validate and resolve per-upstream protection settings" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Runtime core: recording, scheduling, injectable clock

**Files:**
- Create: `packages/gateway/src/protection/runtime.ts`
- Create: `packages/gateway/tests/protection-runtime-record.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-runtime-record.test.ts
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initBackground } from "@vibe-core/platform"
import { ProtectionRuntime, scheduleBackground, type ProtectionRuntimeOptions, type UpstreamOutcome } from "../src/protection/runtime"

const NOW = Date.UTC(2026, 10, 17, 12, 30, 15)
const MINUTE = Math.floor(NOW / 60_000) * 60
let db: Database
let repo: BunSqliteRepo
let pending: Promise<unknown>[]
const runtime = (over: Partial<ProtectionRuntimeOptions> = {}) =>
  new ProtectionRuntime({ repo: () => repo, now: () => NOW, schedule: p => { pending.push(p) }, ...over })
const flush = () => Promise.all(pending.splice(0))
const outcome = (over: Partial<UpstreamOutcome> = {}): UpstreamOutcome =>
  ({ upstreamId: "up_test_r", keyId: "key_test_1", model: "gpt-x", cls: "ok", status: 200, code: "", message: "", ...over })

beforeEach(() => { __resetPlatformForTests(); db = new Database(":memory:"); repo = new BunSqliteRepo(db); pending = [] })
afterEach(() => { db.close(); __resetPlatformForTests() })

test("each upstream response becomes one minute upsert at the injected clock's minute", async () => {
  const rt = runtime()
  rt.record(outcome())
  rt.record(outcome({ cls: "other", status: 418 }))
  await flush()
  const window = await repo.protection.windowSummary("up_test_r", MINUTE, MINUTE)
  expect(window.totals).toMatchObject({ requests: 2, other: 1 })
  expect(await repo.protection.listSamples("up_test_r")).toEqual([]) // ok and other leave no sample
})

test("error classes also leave a sample stamped with the clock", async () => {
  const rt = runtime()
  rt.record(outcome({ cls: "rate_limited", status: 429, code: "rate_limit_exceeded", message: "slow down" }))
  await flush()
  expect(await repo.protection.listSamples("up_test_r")).toEqual([
    { upstreamId: "up_test_r", status: 429, at: NOW, keyId: "key_test_1", model: "gpt-x", code: "rate_limit_exceeded", message: "slow down" }])
})

test("an outcome can arrive as a promise (body still being read)", async () => {
  const rt = runtime()
  rt.record(Promise.resolve(outcome({ cls: "rejected", status: 400, message: "bad" })))
  await flush()
  expect((await repo.protection.windowSummary("up_test_r", MINUTE, MINUTE)).totals.rejected).toBe(1)
})

test("recording never throws and never rejects, even when the repo or the scheduler fails", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const failing = { protection: { recordResponse: async () => { throw new Error("D1 down") } } } as never
  const rt = runtime({ repo: () => failing })
  expect(() => rt.record(outcome())).not.toThrow()
  await expect(flush()).resolves.toBeDefined()
  expect(warn).toHaveBeenCalled()
  const broken = runtime({ schedule: () => { throw new Error("no executor") } })
  expect(() => broken.record(outcome())).not.toThrow()
  warn.mockRestore()
})

test("scheduleBackground uses waitUntil when a background executor exists and still runs without one", async () => {
  const waitUntil = mock((_p: Promise<unknown>) => {})
  initBackground({ waitUntil })
  let ran = false
  scheduleBackground(Promise.resolve().then(() => { ran = true }))
  expect(waitUntil).toHaveBeenCalledTimes(1)
  __resetPlatformForTests()
  scheduleBackground(Promise.reject(new Error("ignored")))
  await Promise.resolve()
  await Promise.resolve()
  expect(ran).toBe(true)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-runtime-record.test.ts`
Expected: FAIL (`Cannot find module "../src/protection/runtime"`).

- [ ] **Step 3: Implement the runtime core**

```ts
// packages/gateway/src/protection/runtime.ts
import { __registerPlatformReset, waitUntil } from "@vibe-core/platform"
import { getRepo } from "../repo/index.ts"
import type { Repo } from "../repo/types.ts"
import { SAMPLED_CLASSES, type ErrorClass } from "../repo/protection.ts"

/** One response (or network failure) of a request the gateway sent to an upstream. */
export interface UpstreamOutcome {
  upstreamId: string
  /** `''` when the request carried no API key. */
  keyId: string
  /** The public model. */
  model: string
  cls: ErrorClass
  /** HTTP status; 0 for a network failure. */
  status: number
  code: string
  message: string
}
export type OutcomeInput = UpstreamOutcome | Promise<UpstreamOutcome>

/** `waitUntil` where a background executor exists; a detached, error-swallowing promise otherwise (unit tests, scripts). */
export function scheduleBackground(work: Promise<unknown>): void {
  const safe = work.catch(() => {})
  try { waitUntil(safe) } catch { /* no background executor: the promise already runs */ }
}

export interface ProtectionRuntimeOptions {
  repo?: () => Repo
  /** Unix ms. */
  now?: () => number
  schedule?: (work: Promise<unknown>) => void
  /** How long the active-pause cache may be reused. */
  cacheTtlMs?: number
  /** Minimum gap between two evaluations of one upstream. */
  evalIntervalMs?: number
}

const warn = (evt: string, error: unknown): void => {
  console.warn(JSON.stringify({ evt, error: error instanceof Error ? error.name : "unknown" }))
}

export class ProtectionRuntime {
  readonly now: () => number
  readonly cacheTtlMs: number
  readonly evalIntervalMs: number
  protected readonly repo: () => Repo
  protected readonly schedule: (work: Promise<unknown>) => void

  constructor(options: ProtectionRuntimeOptions = {}) {
    this.repo = options.repo ?? getRepo
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? scheduleBackground
    this.cacheTtlMs = options.cacheTtlMs ?? 10_000
    this.evalIntervalMs = options.evalIntervalMs ?? 10_000
  }

  /** Fire and forget: never throws, never rejects, never delays the caller. */
  record(input: OutcomeInput): void {
    try {
      this.schedule(Promise.resolve(input).then(outcome => this.recordNow(outcome)).catch(error => warn("protection_record_failed", error)))
    } catch (error) { warn("protection_schedule_failed", error) }
  }

  /** Writes one response: one upsert, plus the sample insert and trim in the same batch for the sampled classes. */
  async recordNow(outcome: UpstreamOutcome): Promise<void> {
    const nowMs = this.now()
    await this.repo().protection.recordResponse({
      minute: Math.floor(nowMs / 60_000) * 60,
      upstreamId: outcome.upstreamId, keyId: outcome.keyId, model: outcome.model, cls: outcome.cls,
      ...(SAMPLED_CLASSES.includes(outcome.cls) ? { sample: { status: outcome.status, at: nowMs, code: outcome.code, message: outcome.message } } : {}),
    })
  }
}

let current: ProtectionRuntime | null = null
/** The process-wide runtime: real repo, wall clock and `waitUntil`. */
export function getProtection(): ProtectionRuntime { return current ??= new ProtectionRuntime() }
export function setProtectionForTests(runtime: ProtectionRuntime | null): void { current = runtime }
__registerPlatformReset(() => { current = null })
```

- [ ] **Step 4: Run it and see it pass**

Run: `bun test packages/gateway/tests/protection-runtime-record.test.ts`
Expected: PASS (5 tests). `bun run --filter '@vibe-llm/gateway' typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/protection/runtime.ts packages/gateway/tests/protection-runtime-record.test.ts
git commit -m "feat(protection): ProtectionRuntime records upstream outcomes without blocking requests" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 6: Record upstream outcomes in the chat flows (`withUpstreamProtection`)

**Files:**
- Create: `packages/gateway/src/protection/observe.ts`
- Create: `packages/gateway/tests/protection-observe.test.ts`
- Create: `packages/gateway/tests/data-plane/chat-flow/shared/protection-recording.test.ts`
- Modify: `packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts` (import block near L11-L27; fetch call at L212)
- Modify: `packages/gateway/src/data-plane/chat-flow/messages/attempt.ts` (imports near L8; fetch call at L415)
- Modify: `packages/gateway/src/data-plane/chat-flow/responses/attempt.ts` (imports near L7; fetch call at L442)

- [ ] **Step 1: Write the failing tests for the wrapper**

```ts
// packages/gateway/tests/protection-observe.test.ts
import { expect, test } from "bun:test"
import { HTTPError, type ProviderRequest, type ProviderResponse } from "@vibe-llm/provider-llm"
import { recordResponse, recordThrown, withUpstreamProtection } from "../src/protection/observe"
import type { UpstreamOutcome } from "../src/protection/runtime"

const identity = { upstreamId: "up_test_o", keyId: "key_test_1", model: "gpt-x" }
const request = { signal: undefined } as unknown as ProviderRequest
const recorder = () => {
  const seen: Array<UpstreamOutcome | Promise<UpstreamOutcome>> = []
  return { runtime: () => ({ record: (o: UpstreamOutcome | Promise<UpstreamOutcome>) => { seen.push(o) } }), outcomes: () => Promise.all(seen) }
}
const provider = (status: number, body: string | null, headers: Record<string, string> = { "content-type": "application/json" }): ProviderResponse =>
  ({ status, headers: new Headers(headers), body: body === null ? null : new Response(body).body })

test("a 2xx response is returned untouched and recorded as ok", async () => {
  const r = recorder()
  const response = provider(200, "{}")
  const result = await withUpstreamProtection(identity, async () => response, r.runtime)(request)
  expect(result).toBe(response)
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "ok", status: 200, code: "", message: "" }])
})

test("a 429 is classified, its error described, and the client still receives the whole body", async () => {
  const r = recorder()
  const body = JSON.stringify({ error: { message: "Too many requests", code: "rate_limit_exceeded" } })
  const result = await withUpstreamProtection(identity, async () => provider(429, body), r.runtime)(request)
  expect(result.status).toBe(429)
  expect(await new Response(result.body).text()).toBe(body)
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "rate_limited", status: 429, code: "rate_limit_exceeded", message: "Too many requests" }])
})

test("an HTML 502 is an upstream error with no message; an unclassified status is `other` and not read", async () => {
  const r = recorder()
  await withUpstreamProtection(identity, async () => provider(502, "<html>bad gateway</html>", { "content-type": "text/html" }), r.runtime)(request)
  const other = provider(418, "teapot")
  const result = await withUpstreamProtection(identity, async () => other, r.runtime)(request)
  expect(result).toBe(other)
  expect(await r.outcomes()).toEqual([
    { ...identity, cls: "upstream", status: 502, code: "", message: "" },
    { ...identity, cls: "other", status: 418, code: "", message: "" }])
})

test("a stream that starts with 2xx and fails mid-way counts as ok: the account was not refused", async () => {
  const r = recorder()
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("data: x\n\n")); controller.error(new TypeError("terminated")) } })
  const response = { status: 200, headers: new Headers({ "content-type": "text/event-stream" }), body } as ProviderResponse
  const result = await withUpstreamProtection(identity, async () => response, r.runtime)(request)
  await expect(new Response(result.body).text()).rejects.toBeInstanceOf(TypeError)
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "ok", status: 200, code: "", message: "" }])
})

test("a thrown HTTPError is recorded by its status and rethrown unchanged", async () => {
  const r = recorder()
  const error = new HTTPError("bad", new Response(JSON.stringify({ error: { message: "content filtered" } }), { status: 400 }))
  await expect(withUpstreamProtection(identity, async () => { throw error }, r.runtime)(request)).rejects.toBe(error)
  expect(await error.response.text()).toContain("content filtered") // the caller can still read it
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "rejected", status: 400, code: "", message: "content filtered" }])
})

test("transport failures are network with the error name; aborts and gateway errors are not recorded", async () => {
  const r = recorder()
  const net = new TypeError("fetch failed")
  await expect(withUpstreamProtection(identity, async () => { throw net }, r.runtime)(request)).rejects.toBe(net)
  const aborted = new AbortController(); aborted.abort()
  await expect(withUpstreamProtection(identity, async () => { throw new TypeError("x") }, r.runtime)({ signal: aborted.signal } as ProviderRequest)).rejects.toBeInstanceOf(TypeError)
  await expect(withUpstreamProtection(identity, async () => { throw new Error("affinity routing unavailable") }, r.runtime)(request)).rejects.toThrow("affinity")
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "network", status: 0, code: "", message: "TypeError" }])
})

test("a failing recorder never changes what the caller sees", async () => {
  const boom = () => ({ record: () => { throw new Error("boom") } })
  const ok = provider(200, "{}")
  expect(await withUpstreamProtection(identity, async () => ok, boom)(request)).toBe(ok)
  const limited = await withUpstreamProtection(identity, async () => provider(429, "{}"), boom)(request)
  expect(await new Response(limited.body).text()).toBe("{}")
  await expect(withUpstreamProtection(identity, async () => { throw new TypeError("x") }, boom)(request)).rejects.toBeInstanceOf(TypeError)
})

test("recordResponse works on a Response (embeddings, images) without consuming it", async () => {
  const r = recorder()
  const response = new Response(JSON.stringify({ error: { message: "bad key", type: "invalid_request_error" } }), { status: 401 })
  recordResponse(identity, response, r.runtime)
  expect(await response.json()).toEqual({ error: { message: "bad key", type: "invalid_request_error" } })
  expect(await r.outcomes()).toEqual([{ ...identity, cls: "auth", status: 401, code: "invalid_request_error", message: "bad key" }])
  recordThrown(identity, new Error("plain"), undefined, r.runtime)
  expect(await r.outcomes()).toHaveLength(1)
})
```

```ts
// packages/gateway/tests/data-plane/chat-flow/shared/protection-recording.test.ts
import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { HTTPError } from '@vibe-llm/provider-llm'
import { chatCompletionsAttempt } from '../../../../src/data-plane/chat-flow/chat-completions/attempt'
import { messagesAttempt } from '../../../../src/data-plane/chat-flow/messages/attempt'
import { responsesAttempt } from '../../../../src/data-plane/chat-flow/responses/attempt'
import type { TelemetryRequestContext } from '../../../../src/data-plane/chat-flow/shared/telemetry-ctx'
import { ProtectionRuntime, setProtectionForTests, type UpstreamOutcome } from '../../../../src/protection/runtime'
import { __resetPlatformForTests } from '@vibe-core/platform'

const recorded: Array<UpstreamOutcome | Promise<UpstreamOutcome>> = []
beforeEach(() => {
  recorded.length = 0
  setProtectionForTests({ record: (o: UpstreamOutcome | Promise<UpstreamOutcome>) => { recorded.push(o) } } as unknown as ProtectionRuntime)
})
afterEach(() => __resetPlatformForTests())

const telemetry: TelemetryRequestContext = {
  incomingModel: 'alias', apiKeyId: 'key_test_1' as never, userAgent: 'ua', requestId: 'rid', isStreaming: false, runtimeLocation: 'bun', requestStartedAt: Date.now(),
}
const identityTranslator = { translateRequest: (p: unknown) => p } as never
const ctx = { requestStartedAt: Date.now() }
const auth = { ownerId: 'o', copilot: false }
const json = (status: number, body: unknown) => ({ status, headers: new Headers({ 'content-type': 'application/json' }), body: new Response(JSON.stringify(body)).body })

const flows = [
  { name: 'chat_completions', model: 'gpt-x', endpoint: 'chat_completions', run: (args: any) => chatCompletionsAttempt.generate({ payload: { model: 'gpt-x', messages: [], stream: false }, ...args }) },
  { name: 'messages', model: 'claude-x', endpoint: 'messages', run: (args: any) => messagesAttempt.generate({ payload: { model: 'claude-x', messages: [], stream: false }, ...args }) },
  { name: 'responses', model: 'gpt-4o', endpoint: 'responses', run: (args: any) => responsesAttempt.generate({ payload: { model: 'gpt-4o', input: [], stream: false }, ...args }) },
] as const

for (const flow of flows) {
  const select = (fetch: unknown) => async () => ({
    kind: 'ok', targetEndpoint: flow.endpoint, translator: identityTranslator, bareModel: flow.model,
    binding: { upstream: 'up_test_fake', model: { id: flow.model }, provider: { getPricingForModelKey: () => null, fetch } },
  })

  test(`${flow.name}: a provider 429 is recorded once with upstream, key and model`, async () => {
    const fetch = mock(async () => json(429, { error: { message: 'slow down', code: 'rate_limit_exceeded' } }))
    const res = await flow.run({ auth, ctx, telemetryCtx: telemetry, selectBinding: select(fetch) })
    expect(res.type).toBe('upstream-error')
    expect(await Promise.all(recorded)).toEqual([
      { upstreamId: 'up_test_fake', keyId: 'key_test_1', model: flow.model, cls: 'rate_limited', status: 429, code: 'rate_limit_exceeded', message: 'slow down' }])
  })

  test(`${flow.name}: a thrown HTTPError and a network failure are recorded, and the error surfaces as before`, async () => {
    const httpError = mock(async () => { throw new HTTPError('nope', new Response(JSON.stringify({ error: { message: 'filtered' } }), { status: 400 })) })
    const res = await flow.run({ auth, ctx, telemetryCtx: telemetry, selectBinding: select(httpError) })
    expect(res.type).toBe('upstream-error')
    const net = mock(async () => { throw new TypeError('fetch failed') })
    const res2 = await flow.run({ auth, ctx, telemetryCtx: telemetry, selectBinding: select(net) })
    expect(res2.type).toBe('internal-error')
    const outcomes = await Promise.all(recorded)
    expect(outcomes.map(o => [o.cls, o.status])).toEqual([['rejected', 400], ['network', 0]])
  })

  test(`${flow.name}: gateway-side rejections before the upstream call record nothing`, async () => {
    for (const kind of ['model-not-found', 'no-eligible-binding', 'catalog-unavailable']) {
      const res = await flow.run({ auth, ctx, telemetryCtx: telemetry, selectBinding: async () => ({ kind, bareModel: flow.model }) })
      expect(res.type).toBe('internal-error')
    }
    expect(recorded).toHaveLength(0)
  })
}
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test packages/gateway/tests/protection-observe.test.ts packages/gateway/tests/data-plane/chat-flow/shared/protection-recording.test.ts`
Expected: FAIL (`Cannot find module "../src/protection/observe"`; in the second file the 429 tests find `recorded` empty).

- [ ] **Step 3: Implement the observer**

```ts
// packages/gateway/src/protection/observe.ts
import { HTTPError, type ProviderRequest, type ProviderResponse } from "@vibe-llm/provider-llm"
import { classifyStatus, classifyThrown, extractErrorDetail, isSampledClass } from "./classify.ts"
import { getProtection, type ProtectionRuntime, type UpstreamOutcome } from "./runtime.ts"

export interface UpstreamIdentity { upstreamId: string; keyId: string; model: string }
type Recorder = Pick<ProtectionRuntime, "record">
type RuntimeAccessor = () => Recorder

const DETAIL_BYTES = 4096
const DETAIL_TIMEOUT_MS = 5000
const NO_DETAIL = { code: "", message: "" }

/** Identity of one upstream call. `keyId` is `''` when the request carries no API key. */
export const protectionIdentity = (telemetry: { apiKeyId?: string }, upstreamId: string, model: string): UpstreamIdentity =>
  ({ upstreamId, keyId: telemetry.apiKeyId ?? "", model })

const outcome = (identity: UpstreamIdentity, cls: UpstreamOutcome["cls"], status: number, detail: { code: string; message: string }): UpstreamOutcome =>
  ({ ...identity, cls, status, code: detail.code, message: detail.message })

/** At most 4 KiB of an error body, never longer than 5 s, always releasing the stream. */
async function readDetail(body: ReadableStream<Uint8Array> | null): Promise<{ code: string; message: string }> {
  if (!body) return NO_DETAIL
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const read = (async (): Promise<string> => {
      const chunks: Uint8Array[] = []
      let size = 0
      while (size < DETAIL_BYTES) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(next.value)
        size += next.value.byteLength
      }
      const merged = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength }
      return new TextDecoder().decode(merged.subarray(0, DETAIL_BYTES))
    })()
    const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), DETAIL_TIMEOUT_MS) })
    const text = await Promise.race([read, timeout])
    return text === null ? NO_DETAIL : extractErrorDetail(text)
  } catch { return NO_DETAIL } finally {
    if (timer !== undefined) clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

const safely = (work: () => void): void => { try { work() } catch { /* observation never changes the outcome */ } }

/** For `Response` objects (embeddings, images): records the status, reading a clone so the original stays readable. */
export function recordResponse(identity: UpstreamIdentity, response: Response, runtime: RuntimeAccessor = getProtection): void {
  safely(() => {
    const cls = classifyStatus(response.status)
    if (!isSampledClass(cls) || !response.body || response.bodyUsed) {
      runtime().record(outcome(identity, cls, response.status, NO_DETAIL))
      return
    }
    runtime().record(readDetail(response.clone().body).then(detail => outcome(identity, cls, response.status, detail)))
  })
}

/** An `HTTPError` counts by its response status; a transport failure is `network`; aborts and gateway errors are ignored. */
export function recordThrown(identity: UpstreamIdentity, error: unknown, signal?: AbortSignal, runtime: RuntimeAccessor = getProtection): void {
  safely(() => {
    if (error instanceof HTTPError) { recordResponse(identity, error.response, runtime); return }
    const cls = classifyThrown(error, signal)
    if (cls) runtime().record(outcome(identity, cls, 0, { code: "", message: error instanceof Error ? error.name : "Error" }))
  })
}

/**
 * Wraps one `provider.fetch`: every response and thrown failure of the call is recorded exactly once. A non-2xx body is
 * `tee()`d so the client path keeps one branch and the observer reads the other in the background.
 */
export function withUpstreamProtection(
  identity: UpstreamIdentity,
  fetch: (request: ProviderRequest) => Promise<ProviderResponse>,
  runtime: RuntimeAccessor = getProtection,
): (request: ProviderRequest) => Promise<ProviderResponse> {
  return async (request) => {
    let response: ProviderResponse
    try {
      response = await fetch(request)
    } catch (error) {
      recordThrown(identity, error, request.signal ?? undefined, runtime)
      throw error
    }
    let result = response
    safely(() => {
      const cls = classifyStatus(response.status)
      if (!isSampledClass(cls) || !response.body) {
        runtime().record(outcome(identity, cls, response.status, NO_DETAIL))
        return
      }
      const [forClient, forObserver] = response.body.tee()
      result = { ...response, body: forClient }
      runtime().record(readDetail(forObserver).then(detail => outcome(identity, cls, response.status, detail)))
    })
    return result
  }
}
```

- [ ] **Step 4: Wire the three hub attempts**

`chat-completions/attempt.ts`: add the import `import { protectionIdentity, withUpstreamProtection } from '../../../protection/observe.ts'` and replace L212 with:

```ts
      const observedFetch = withUpstreamProtection(protectionIdentity(telemetryCtx, bindingForTelemetry.upstream, publicModel), request => binding.provider.fetch(request))
      upstreamResp = await fetchWithPerformance(telemetryCtx.metrics, "chat_completions", providerReq, () => fetchAffinityUpstream(affinityExecution, providerReq, observedFetch))
```

`messages/attempt.ts` (same import path) replace L415 with:

```ts
      const observedFetch = withUpstreamProtection(protectionIdentity(telemetryCtx, bindingForTelemetry.upstream, publicModel), request => sel.binding.provider.fetch(request))
      upstreamResp = await fetchWithPerformance(telemetryCtx.metrics, "messages", providerReq, () => fetchAffinityUpstream(affinityExecution, providerReq, observedFetch))
```

`responses/attempt.ts` replace L442 with:

```ts
      const observedFetch = withUpstreamProtection(protectionIdentity(telemetryCtx, bindingForTelemetry.upstream, publicModel), request => sel.binding.provider.fetch(request))
      upstreamResp = await fetchWithPerformance(telemetryCtx.metrics, "responses", providerReq, () => fetchAffinityUpstream(affinity, providerReq, observedFetch))
```

(`bindingForTelemetry` and `publicModel` are declared on the two lines above each call in all three files; `telemetryCtx` is the attempt's telemetry context.)

- [ ] **Step 5: Run the tests, the attempt suites and typecheck**

Run: `bun test packages/gateway/tests/protection-observe.test.ts packages/gateway/tests/data-plane/chat-flow`
Expected: PASS (new tests plus all existing chat-flow tests; `provider-cancellation-forwarding`, `respond-json` JSON fallback/terminal failures, if present, are the known baseline failures and must not change).
Existing attempt tests never initialise a repo, so the recorder logs `{"evt":"protection_record_failed",...}` warnings there; that is the designed fail-safe (recording errors are swallowed) and not a failure.

Run: `bun run --filter '@vibe-llm/gateway' typecheck` and `bunx eslint packages/gateway/src/protection packages/gateway/src/data-plane/chat-flow`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/protection/observe.ts packages/gateway/src/data-plane/chat-flow packages/gateway/tests/protection-observe.test.ts packages/gateway/tests/data-plane/chat-flow/shared/protection-recording.test.ts
git commit -m "feat(protection): record every chat-flow upstream response and failure once" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Record embeddings and images upstream outcomes

**Files:**
- Modify: `packages/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts` (imports near L19-L28; `try { res = await input.call() }` block near L113-L130; right after `const upstreamMs = Date.now() - upstreamStart` near L131)
- Modify: `packages/gateway/src/data-plane/observability/attempts/images-attempt.ts` (same two spots near L77-L96)
- Create: `packages/gateway/tests/protection-embeddings-images.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-embeddings-images.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { HTTPError } from "@vibe-llm/provider-llm"
import { runEmbeddingsAttempt } from "../src/data-plane/observability/attempts/embeddings-attempt"
import { runImagesAttempt } from "../src/data-plane/observability/attempts/images-attempt"
import { ProtectionRuntime, setProtectionForTests, type UpstreamOutcome } from "../src/protection/runtime"

const recorded: Array<UpstreamOutcome | Promise<UpstreamOutcome>> = []
beforeEach(() => {
  recorded.length = 0
  setProtectionForTests({ record: (o: UpstreamOutcome | Promise<UpstreamOutcome>) => { recorded.push(o) } } as unknown as ProtectionRuntime)
})
afterEach(() => __resetPlatformForTests())

const base = {
  apiKeyId: undefined, incomingModel: "alias", model: "m-1", modelKey: "m-1", pricing: null, upstream: "up_test_e",
  userAgent: undefined, requestId: undefined, dump: null,
}
const outcomes = () => Promise.all(recorded)

test("embeddings: success, non-2xx and thrown failures are each recorded once; the response is unchanged", async () => {
  const ok = await runEmbeddingsAttempt({ ...base, call: async () => new Response(JSON.stringify({ data: [], usage: { prompt_tokens: 1 } })) })
  expect(ok.ok).toBe(true)
  const limited = await runEmbeddingsAttempt({ ...base, call: async () => new Response(JSON.stringify({ error: { message: "slow down", code: "rate_limit_exceeded" } }), { status: 429 }) })
  expect(limited).toMatchObject({ ok: false, status: 429 })
  if (!limited.ok && "response" in limited) expect(await limited.response.json()).toMatchObject({ error: { message: "slow down" } })
  const httpError = new HTTPError("x", new Response("{}", { status: 401 }))
  await expect(runEmbeddingsAttempt({ ...base, call: async () => { throw httpError } })).rejects.toBe(httpError)
  await expect(runEmbeddingsAttempt({ ...base, call: async () => { throw new TypeError("fetch failed") } })).rejects.toBeInstanceOf(TypeError)
  expect((await outcomes()).map(o => [o.upstreamId, o.keyId, o.model, o.cls, o.status])).toEqual([
    ["up_test_e", "", "m-1", "ok", 200], ["up_test_e", "", "m-1", "rate_limited", 429],
    ["up_test_e", "", "m-1", "auth", 401], ["up_test_e", "", "m-1", "network", 0]])
})

test("images: the same, and success bodies are not disturbed", async () => {
  const ok = await runImagesAttempt({ ...base, call: async () => new Response(JSON.stringify({ data: [] })) })
  expect(ok.ok).toBe(true)
  const rejected = await runImagesAttempt({ ...base, call: async () => new Response(JSON.stringify({ error: { message: "content policy", code: "content_policy_violation" } }), { status: 400 }) })
  expect(rejected).toMatchObject({ ok: false, status: 400 })
  await expect(runImagesAttempt({ ...base, call: async () => { throw new Error("gateway bug") } })).rejects.toThrow("gateway bug")
  expect((await outcomes()).map(o => [o.cls, o.code])).toEqual([["ok", ""], ["rejected", "content_policy_violation"]])
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-embeddings-images.test.ts`
Expected: FAIL (`expect(received).toEqual(expected)`: no outcomes recorded).

- [ ] **Step 3: Implement**

In both attempt modules add `import { recordResponse, recordThrown } from '../../../protection/observe.ts'`. In `runEmbeddingsAttempt`, right before `const elapsed = startTimer()` add:

```ts
  const identity = { upstreamId: input.upstream, keyId: input.apiKeyId ?? '', model: input.model }
```

In the `catch (err)` block add as the first statement `recordThrown(identity, err)`, and immediately after `const upstreamMs = Date.now() - upstreamStart` (the one following the try/catch) add `recordResponse(identity, res)`. Apply the same three insertions to `runImagesAttempt` (it has the identical `try { res = await input.call() } catch (err)` shape and `const upstreamMs` line). Quota rejections return before `input.call()` so they are never recorded.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/protection-embeddings-images.test.ts packages/gateway/tests/data-plane-models-embeddings-images.test.ts packages/gateway/tests/data-plane/images`
Expected: PASS. `bun run --filter '@vibe-llm/gateway' typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/data-plane/observability/attempts packages/gateway/tests/protection-embeddings-images.test.ts
git commit -m "feat(protection): record embeddings and images upstream outcomes" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 8: Detection rules (pure)

**Files:**
- Create: `packages/gateway/src/protection/detect.ts`
- Create: `packages/gateway/tests/protection-detect.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-detect.test.ts
import { expect, test } from "bun:test"
import { DEFAULT_PROTECTION_SETTINGS, emptyCounts, type ClassCounts, type KeyWindowCounts, type PauseRecord, type ProtectionSettings, type WindowSummary } from "../src/repo/protection"
import { assess, cooldownMinutes, covered } from "../src/protection/detect"

const settings = (over: Partial<ProtectionSettings> = {}): ProtectionSettings => ({ ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", ...over })
const key = (keyId: string, over: Partial<ClassCounts> = {}): KeyWindowCounts => ({ keyId, ...emptyCounts(), ...over })
const windowOf = (...keys: KeyWindowCounts[]): WindowSummary => {
  const totals = emptyCounts()
  for (const k of keys) for (const field of Object.keys(totals) as Array<keyof ClassCounts>) totals[field] += k[field]
  return { totals, byKey: keys }
}
const row = (over: Partial<PauseRecord>): PauseRecord => ({
  id: "pp_" + "0".repeat(32), targetKind: "upstream", targetId: "up_test_d", upstreamId: "up_test_d", mode: "pause",
  reason: {} as never, startedAt: 0, endsAt: 1, resolvedAt: null, resolvedBy: null, ...over,
})

test("the ratio rule needs both the risky count and the failure ratio, each inclusive at its boundary", () => {
  expect(assess("u", settings(), windowOf(key("a", { requests: 19, rate_limited: 19 })))).toBeNull() // 19 < 20
  expect(assess("u", settings(), windowOf(key("a", { requests: 20, rate_limited: 20 })))?.trigger).toBe("ratio")
  expect(assess("u", settings(), windowOf(key("a", { requests: 40, rate_limited: 20 })))?.trigger).toBe("ratio") // ratio == 0.5
  expect(assess("u", settings(), windowOf(key("a", { requests: 41, rate_limited: 20 })))).toBeNull() // 0.488 < 0.5
  expect(assess("u", settings({ minRiskyErrors: 1, minFailureRatio: 0 }), windowOf(key("a", { requests: 100, rejected: 1 })))?.trigger).toBe("ratio")
  expect(assess("u", settings(), windowOf())).toBeNull()
})

test("only rate-limit, rejected and auth responses are risky", () => {
  expect(assess("u", settings(), windowOf(key("a", { requests: 100, upstream: 50, network: 30, other: 20 })))).toBeNull()
  expect(assess("u", settings(), windowOf(key("a", { requests: 20, rate_limited: 7, rejected: 7, auth: 6 })))?.reason.risky).toBe(20)
})

test("the auth burst fires on auth errors alone, is inclusive, and 0 disables it", () => {
  const w = (auth: number) => windowOf(key("a", { requests: 1000, auth }))
  expect(assess("u", settings(), w(4))).toBeNull()
  const burst = assess("u", settings(), w(5))
  expect(burst?.trigger).toBe("authBurst")
  expect(assess("u", settings({ authBurst: 0 }), windowOf(key("a", { requests: 100_000, auth: 500 })))).toBeNull() // risky 500 but ratio 0.005
  expect(assess("u", settings({ authBurst: 3 }), w(3))?.trigger).toBe("authBurst")
  // When both rules fire the ratio rule is reported.
  expect(assess("u", settings(), windowOf(key("a", { requests: 30, auth: 30 })))?.trigger).toBe("ratio")
})

test("a key causing at least keyShare of the risky errors takes the whole key; otherwise the upstream", () => {
  const split = (a: number, b: number) => assess("up_x", settings(), windowOf(key("key_a", { requests: a, rate_limited: a }), key("key_b", { requests: b, rate_limited: b })))
  const at = split(16, 4) // 16/20 = 0.8
  expect(at?.target).toEqual({ kind: "key", id: "key_a" })
  expect(at?.attributedKey).toBe("key_a")
  expect(at?.reason.keyShare).toBe(0.8)
  const below = split(15, 5) // 0.75
  expect(below?.target).toEqual({ kind: "upstream", id: "up_x" })
  expect(below?.attributedKey).toBeNull()
  expect(below?.reason.keyShare).toBeNull()
  expect(assess("up_x", settings({ keyShare: 0.5 }), windowOf(key("key_a", { requests: 10, rate_limited: 10 }), key("key_b", { requests: 10, rate_limited: 10 })))?.target)
    .toEqual({ kind: "key", id: "key_a" }) // tie broken by key id
})

test("requests without an API key are never attributed to a key", () => {
  const a = assess("up_x", settings(), windowOf(key("", { requests: 25, rate_limited: 25 })))
  expect(a?.target).toEqual({ kind: "upstream", id: "up_x" })
})

test("the reason carries window, counts per class, ratio and the top five keys", () => {
  const keys = ["k1", "k2", "k3", "k4", "k5", "k6"].map((id, i) => key(id, { requests: 10 + i, rate_limited: 10 - i }))
  const a = assess("up_x", settings({ keyShare: 1 }), windowOf(...keys))!
  expect(a.reason).toMatchObject({ windowMinutes: 5, requests: 75, risky: 45, failureRatio: 45 / 75, trigger: "ratio", keyShare: null })
  expect(a.reason.counts).toEqual({ rate_limited: 45, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 })
  expect(a.reason.topKeys).toEqual([{ keyId: "k1", risky: 10 }, { keyId: "k2", risky: 9 }, { keyId: "k3", risky: 8 }, { keyId: "k4", risky: 7 }, { keyId: "k5", risky: 6 }])
})

test("an active row for the upstream, or for the attributed key, covers the evaluation; ended or foreign rows do not", () => {
  expect(covered([row({})], "up_test_d", null)).toBe(true)
  expect(covered([row({ mode: "notify" })], "up_test_d", null)).toBe(true)
  expect(covered([row({ targetKind: "key", targetId: "key_a" })], "up_test_d", "key_a")).toBe(true)
  expect(covered([row({ targetKind: "key", targetId: "key_a" })], "up_test_d", "key_b")).toBe(false)
  expect(covered([row({ targetKind: "key", targetId: "key_a" })], "up_test_d", null)).toBe(false)
  expect(covered([row({ targetId: "up_other", upstreamId: "up_other" })], "up_test_d", null)).toBe(false)
  expect(covered([], "up_test_d", "key_a")).toBe(false)
})

test("the cooldown doubles per earlier pause and is capped", () => {
  const s = settings({ cooldownMinutes: 30, maxCooldownMinutes: 360 })
  expect([0, 1, 2, 3, 4, 5, 50].map(n => cooldownMinutes(s, n))).toEqual([30, 60, 120, 240, 360, 360, 360])
  expect(cooldownMinutes(settings({ cooldownMinutes: 100, maxCooldownMinutes: 100 }), 3)).toBe(100)
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-detect.test.ts`
Expected: FAIL (`Cannot find module "../src/protection/detect"`).

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/protection/detect.ts
import { riskyCount, type PauseReason, type PauseRecord, type PauseTargetKind, type ProtectionSettings, type WindowSummary } from "../repo/protection.ts"

export interface Assessment {
  trigger: "ratio" | "authBurst"
  target: { kind: PauseTargetKind; id: string }
  /** The key whose share of the risky errors reaches `keyShare`, when there is one. */
  attributedKey: string | null
  reason: PauseReason
}

/**
 * Spec steps 2 and 4: does the window trigger, and who is the target? Pure: the caller supplies the summed window.
 * Ratio rule: risky >= minRiskyErrors and risky / requests >= minFailureRatio. Auth burst: authBurst > 0 and auth >= authBurst.
 */
export function assess(upstreamId: string, settings: ProtectionSettings, window: WindowSummary): Assessment | null {
  const { totals } = window
  const risky = riskyCount(totals)
  const ratio = totals.requests > 0 ? risky / totals.requests : 0
  const byRatio = risky >= settings.minRiskyErrors && ratio >= settings.minFailureRatio
  const byAuth = settings.authBurst > 0 && totals.auth >= settings.authBurst
  if (!byRatio && !byAuth) return null

  const ranked = window.byKey
    .map(key => ({ keyId: key.keyId, risky: riskyCount(key) }))
    .filter(key => key.risky > 0)
    .sort((a, b) => b.risky - a.risky || a.keyId.localeCompare(b.keyId))
  const top = ranked[0]
  const share = top && risky > 0 ? top.risky / risky : 0
  const attributedKey = top && top.keyId !== "" && share >= settings.keyShare ? top.keyId : null
  const trigger = byRatio ? "ratio" as const : "authBurst" as const
  const { requests, ...counts } = totals
  return {
    trigger,
    target: attributedKey ? { kind: "key", id: attributedKey } : { kind: "upstream", id: upstreamId },
    attributedKey,
    reason: { windowMinutes: settings.windowMinutes, requests, risky, counts, failureRatio: ratio, topKeys: ranked.slice(0, 5), trigger, keyShare: attributedKey ? share : null },
  }
}

/** Spec step 3: an active pause or warning (any mode) for this upstream, or for the attributed key, already covers it. `active` must be unresolved and unexpired. */
export function covered(active: readonly PauseRecord[], upstreamId: string, attributedKey: string | null): boolean {
  return active.some(row =>
    (row.targetKind === "upstream" && row.targetId === upstreamId) ||
    (attributedKey !== null && row.targetKind === "key" && row.targetId === attributedKey))
}

/** Spec step 5: `cooldownMinutes`, doubled for each earlier row of the same target in the last 24 h, capped at `maxCooldownMinutes`. */
export function cooldownMinutes(settings: ProtectionSettings, earlier: number): number {
  return Math.min(settings.maxCooldownMinutes, settings.cooldownMinutes * 2 ** Math.min(earlier, 20))
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `bun test packages/gateway/tests/protection-detect.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/protection/detect.ts packages/gateway/tests/protection-detect.test.ts
git commit -m "feat(protection): pure flood detection, attribution and cooldown rules" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Evaluation after risky responses (throttled, never blocking)

**Files:**
- Modify: `packages/gateway/src/protection/runtime.ts` (imports; `recordNow`; new methods)
- Create: `packages/gateway/tests/protection-evaluate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-evaluate.test.ts
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { DEFAULT_PROTECTION_SETTINGS, type ErrorClass, type ProtectionSettings } from "../src/repo/protection"
import { ProtectionRuntime } from "../src/protection/runtime"

const UP = "up_test_d"
const NOW0 = Date.UTC(2026, 10, 17, 12, 0, 30)
let now = NOW0
let db: Database
let repo: BunSqliteRepo
const runtime = () => new ProtectionRuntime({ repo: () => repo, now: () => now, schedule: () => {} })
const minuteOf = (ms: number) => Math.floor(ms / 60_000) * 60
const seed = async (cls: ErrorClass, count: number, o: { key?: string; minutesAgo?: number } = {}) => {
  for (let i = 0; i < count; i++) await repo.protection.recordResponse({ upstreamId: UP, keyId: o.key ?? "key_test_1", model: "m", cls, minute: minuteOf(now) - (o.minutesAgo ?? 0) * 60 })
}
const enable = (over: Partial<ProtectionSettings> = {}) => repo.protection.setSettings(UP, { ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", ...over }, now)
const rows = () => db.query<{ mode: string; target_kind: string; target_id: string; started_at: number; ends_at: number; reason_json: string }, []>(
  "SELECT mode, target_kind, target_id, started_at, ends_at, reason_json FROM protection_pauses ORDER BY started_at").all()
const minutes = (ms: number) => ms / 60_000

beforeEach(() => { __resetPlatformForTests(); now = NOW0; db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterEach(() => { db.close(); __resetPlatformForTests() })

test("an upstream with protection off is never evaluated: no window query, no row", async () => {
  const rt = runtime()
  const window = spyOn(repo.protection, "windowSummary")
  await seed("rate_limited", 100)
  expect(await rt.evaluate(UP)).toBeNull() // no settings row = off
  await enable({ mode: "off" })
  expect(await rt.evaluate(UP)).toBeNull()
  expect(window).not.toHaveBeenCalled()
  expect(rows()).toEqual([])
})

test("a flood creates one pause row with the reason, the mode and the cooldown end", async () => {
  db.run("INSERT INTO upstreams (id, provider, name, created_at, updated_at) VALUES (?, 'custom', 'Copilot A', 't', 't')", [UP])
  await enable()
  await seed("ok", 4)
  await seed("rate_limited", 20)
  const pause = await runtime().evaluate(UP)
  expect(pause).toMatchObject({ mode: "pause", targetKind: "key", targetId: "key_test_1", upstreamId: UP, startedAt: now, endsAt: now + 30 * 60_000 })
  expect(pause?.reason).toMatchObject({ requests: 24, risky: 20, trigger: "ratio", upstreamName: "Copilot A", keyShare: 1 })
  expect(pause?.id).toMatch(/^pp_[0-9a-f]{32}$/)
  expect(rows()).toHaveLength(1)
})

test("the window is windowMinutes whole minutes including the current one", async () => {
  await enable()
  await seed("rate_limited", 25, { minutesAgo: 5 }) // minute M-5 is outside a 5 minute window [M-4, M]
  await seed("ok", 10)
  expect(await runtime().evaluate(UP)).toBeNull()
  await seed("rate_limited", 25, { minutesAgo: 4 })
  expect(await runtime().evaluate(UP)).not.toBeNull()
})

test("key attribution follows keyShare at its boundary", async () => {
  await enable()
  await seed("rate_limited", 16, { key: "key_a" })
  await seed("rate_limited", 4, { key: "key_b" })
  expect((await runtime().evaluate(UP))?.targetKind).toBe("key")
  db.run("DELETE FROM protection_pauses")
  await seed("rate_limited", 1, { key: "key_b" }) // 16 / 21 < 0.8
  expect(await runtime().evaluate(UP)).toMatchObject({ targetKind: "upstream", targetId: UP })
})

test("a running pause or warning prevents a duplicate; evaluation skips when the attributed key is already covered", async () => {
  await enable()
  await seed("rate_limited", 30)
  const rt = runtime()
  expect(await rt.evaluate(UP)).not.toBeNull()
  expect(await rt.evaluate(UP)).toBeNull()
  expect(rows()).toHaveLength(1)
  // An upstream-level row covers key attribution too.
  db.run("DELETE FROM protection_pauses")
  await repo.protection.insertPauseIfNone({ id: "pp_" + "1".repeat(32), targetKind: "upstream", targetId: UP, upstreamId: UP, mode: "notify", reason: {} as never, startedAt: now, endsAt: now + 60_000 }, now)
  expect(await rt.evaluate(UP)).toBeNull()
})

test("the cooldown doubles for each earlier pause of the same target within 24 h and is capped", async () => {
  await enable({ cooldownMinutes: 30, maxCooldownMinutes: 100 })
  await seed("rate_limited", 30)
  const rt = runtime()
  const durations: number[] = []
  for (let i = 0; i < 4; i++) {
    const pause = await rt.evaluate(UP)
    durations.push(minutes(pause!.endsAt - pause!.startedAt))
    await repo.protection.resolvePause(pause!.id, "owner", now)
    now += 1_000
    await seed("rate_limited", 30) // keep the window hot after the clock moved
  }
  expect(durations).toEqual([30, 60, 100, 100])
})

test("older pauses (more than 24 h ago) do not lengthen the cooldown", async () => {
  await enable()
  await seed("rate_limited", 30)
  await repo.protection.insertPauseIfNone({ id: "pp_" + "2".repeat(32), targetKind: "key", targetId: "key_test_1", upstreamId: UP, mode: "pause", reason: {} as never,
    startedAt: now - 25 * 3_600_000, endsAt: now - 24 * 3_600_000 }, now - 25 * 3_600_000)
  const pause = await runtime().evaluate(UP)
  expect(minutes(pause!.endsAt - pause!.startedAt)).toBe(30)
})

test("notify mode records a warning row", async () => {
  await enable({ mode: "notify" })
  await seed("auth", 5)
  const pause = await runtime().evaluate(UP)
  expect(pause).toMatchObject({ mode: "notify" })
  expect(pause?.reason.trigger).toBe("authBurst") // 5 auth errors reach authBurst (5) though not minRiskyErrors (20)
  expect(rows()[0]?.mode).toBe("notify")
})

test("only risky responses trigger an evaluation, at most once per interval per upstream", async () => {
  await enable({ minRiskyErrors: 1000 })
  await repo.protection.setSettings("up_test_other", { ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", minRiskyErrors: 1000 }, now)
  const rt = runtime()
  const window = spyOn(repo.protection, "windowSummary")
  const outcome = (cls: ErrorClass) => ({ upstreamId: UP, keyId: "key_test_1", model: "m", cls, status: cls === "ok" ? 200 : 429, code: "", message: "" })
  await rt.recordNow(outcome("ok"))
  await rt.recordNow(outcome("upstream"))
  expect(window).not.toHaveBeenCalled()
  await rt.recordNow(outcome("rate_limited"))
  await rt.recordNow(outcome("rate_limited"))
  await rt.recordNow(outcome("auth"))
  expect(window).toHaveBeenCalledTimes(1)
  now += 9_999
  await rt.recordNow(outcome("rate_limited"))
  expect(window).toHaveBeenCalledTimes(1)
  now += 1
  await rt.recordNow(outcome("rate_limited"))
  expect(window).toHaveBeenCalledTimes(2)
  await rt.recordNow({ ...outcome("rate_limited"), upstreamId: "up_test_other" }) // each upstream has its own throttle
  expect(window).toHaveBeenCalledTimes(3)
})

test("a failing evaluation never fails the recording", async () => {
  await enable()
  const rt = runtime()
  spyOn(repo.protection, "windowSummary").mockRejectedValue(new Error("D1 down"))
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  await expect(rt.recordNow({ upstreamId: UP, keyId: "k", model: "m", cls: "rate_limited", status: 429, code: "", message: "" })).resolves.toBeUndefined()
  expect(warn).toHaveBeenCalled()
  warn.mockRestore()
  expect(db.query<{ n: number }, []>("SELECT SUM(requests) AS n FROM upstream_request_minutes").get()?.n).toBe(1) // the response itself was recorded
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-evaluate.test.ts`
Expected: FAIL (`rt.evaluate is not a function`).

- [ ] **Step 3: Implement**

Add imports at the top of `runtime.ts`:

```ts
import type { ApiKeyId, UpstreamId } from "../repo/branded-ids.ts"
import type { NewPause, PauseRecord } from "../repo/protection.ts"
import { isRiskyClass } from "./classify.ts"
import { assess, cooldownMinutes, covered } from "./detect.ts"
import { resolveProtection } from "./settings.ts"
```

Add a field `private readonly lastEvaluated = new Map<string, number>()` to the class, change `recordNow` to end with the evaluation, and add the new methods:

```ts
  async recordNow(outcome: UpstreamOutcome): Promise<void> {
    const nowMs = this.now()
    await this.repo().protection.recordResponse({
      minute: Math.floor(nowMs / 60_000) * 60,
      upstreamId: outcome.upstreamId, keyId: outcome.keyId, model: outcome.model, cls: outcome.cls,
      ...(SAMPLED_CLASSES.includes(outcome.cls) ? { sample: { status: outcome.status, at: nowMs, code: outcome.code, message: outcome.message } } : {}),
    })
    if (isRiskyClass(outcome.cls)) await this.maybeEvaluate(outcome.upstreamId)
  }

  /** At most one evaluation per `evalIntervalMs` per upstream (per isolate/process); failures are logged, never thrown. */
  protected async maybeEvaluate(upstreamId: string): Promise<void> {
    const nowMs = this.now()
    const last = this.lastEvaluated.get(upstreamId)
    if (last !== undefined && nowMs - last < this.evalIntervalMs) return
    this.lastEvaluated.set(upstreamId, nowMs)
    try { await this.evaluate(upstreamId) } catch (error) { warn("protection_evaluate_failed", error) }
  }

  /**
   * Spec "Detection" steps 1-6. Returns the row it created, or null when protection is off, nothing triggers, an active
   * row already covers the target, or another isolate won the insert race.
   */
  async evaluate(upstreamId: string): Promise<PauseRecord | null> {
    const protection = this.repo().protection
    const settings = resolveProtection(await protection.getSettings(upstreamId))
    if (settings.mode === "off") return null
    const nowMs = this.now()
    const minute = Math.floor(nowMs / 60_000) * 60
    const window = await protection.windowSummary(upstreamId, minute - (settings.windowMinutes - 1) * 60, minute)
    const assessment = assess(upstreamId, settings, window)
    if (!assessment) return null
    if (covered(await protection.listActive(nowMs), upstreamId, assessment.attributedKey)) return null
    const earlier = await protection.countRecentPauses(assessment.target.kind, assessment.target.id, settings.mode, nowMs - 24 * 3_600_000)
    const names = await this.names(upstreamId, assessment.target)
    const pause: NewPause = {
      id: `pp_${crypto.randomUUID().replace(/-/g, "")}`,
      targetKind: assessment.target.kind, targetId: assessment.target.id, upstreamId, mode: settings.mode,
      reason: { ...assessment.reason, ...names },
      startedAt: nowMs, endsAt: nowMs + cooldownMinutes(settings, earlier) * 60_000,
    }
    if (!(await protection.insertPauseIfNone(pause, nowMs))) return null
    return { ...pause, resolvedAt: null, resolvedBy: null }
  }

  /** Display names captured when the row is created; a failed lookup just leaves them out. */
  private async names(upstreamId: string, target: { kind: string; id: string }): Promise<{ upstreamName?: string; targetName?: string }> {
    const repo = this.repo()
    const out: { upstreamName?: string; targetName?: string } = {}
    try { out.upstreamName = (await repo.upstreams.getById(upstreamId as UpstreamId))?.name } catch { /* optional */ }
    if (target.kind === "key") {
      try { out.targetName = (await repo.apiKeys.getById(target.id as ApiKeyId))?.name } catch { /* optional */ }
    } else out.targetName = out.upstreamName
    return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined))
  }
```

- [ ] **Step 4: Run it and see it pass**

Run: `bun test packages/gateway/tests/protection-evaluate.test.ts packages/gateway/tests/protection-runtime-record.test.ts`
Expected: PASS. `bun run --filter '@vibe-llm/gateway' typecheck` clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/protection/runtime.ts packages/gateway/tests/protection-evaluate.test.ts
git commit -m "feat(protection): evaluate upstreams after risky responses and create pauses or warnings" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Active-pause cache (applied at once locally, refreshed within 10 s elsewhere)

**Files:**
- Modify: `packages/gateway/src/protection/runtime.ts` (fields, `evaluate` tail, new methods)
- Create: `packages/gateway/tests/protection-cache.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-cache.test.ts
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { DEFAULT_PROTECTION_SETTINGS, type NewPause } from "../src/repo/protection"
import { ProtectionRuntime } from "../src/protection/runtime"

const NOW0 = Date.UTC(2026, 10, 17, 12, 0, 0)
let now = NOW0
let db: Database
let repo: BunSqliteRepo
const runtime = () => new ProtectionRuntime({ repo: () => repo, now: () => now, schedule: () => {} })
const pid = (n: number) => `pp_${n.toString(16).padStart(32, "0")}`
const pause = (n: number, over: Partial<NewPause> = {}): NewPause => ({
  id: pid(n), targetKind: "upstream", targetId: "up_test_c", upstreamId: "up_test_c", mode: "pause", reason: {} as never, startedAt: NOW0, endsAt: NOW0 + 600_000, ...over,
})
const insert = (p: NewPause) => repo.protection.insertPauseIfNone(p, NOW0)

beforeEach(() => { __resetPlatformForTests(); now = NOW0; db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterEach(() => { db.close(); __resetPlatformForTests() })

test("the cache reads the repo at most once per 10 seconds, even for concurrent callers", async () => {
  const rt = runtime()
  const list = spyOn(repo.protection, "listActive")
  await Promise.all([rt.activePauses(), rt.activePauses(), rt.activePauses()])
  expect(list).toHaveBeenCalledTimes(1)
  now += 9_999
  await rt.activePauses()
  expect(list).toHaveBeenCalledTimes(1)
  now += 1
  await rt.activePauses()
  expect(list).toHaveBeenCalledTimes(2)
})

test("a pause written by another isolate is seen after the TTL, not before", async () => {
  const rt = runtime()
  expect((await rt.pausedUpstreams()).size).toBe(0)
  await insert(pause(1))
  now += 5_000
  expect((await rt.pausedUpstreams()).size).toBe(0)
  now += 5_000
  expect([...(await rt.pausedUpstreams()).keys()]).toEqual(["up_test_c"])
})

test("the isolate that creates a pause applies it at once, and resuming removes it at once", async () => {
  await repo.protection.setSettings("up_test_c", { ...DEFAULT_PROTECTION_SETTINGS, mode: "pause" }, NOW0)
  for (let i = 0; i < 30; i++) await repo.protection.recordResponse({ upstreamId: "up_test_c", keyId: "", model: "m", cls: "rate_limited", minute: Math.floor(NOW0 / 60_000) * 60 })
  const rt = runtime()
  expect((await rt.pausedUpstreams()).size).toBe(0) // warms the cache with no rows
  const created = await rt.evaluate("up_test_c")
  expect([...(await rt.pausedUpstreams()).keys()]).toEqual(["up_test_c"]) // key '' is never attributed, so the whole upstream
  expect(await rt.resume(created!.id, "owner")).toBe(true)
  expect((await rt.pausedUpstreams()).size).toBe(0)
  expect(await rt.resume(created!.id, "owner")).toBe(false)
  expect((await repo.protection.getPause(created!.id))?.resolvedBy).toBe("owner")
})

test("a pause expires from the cache when its end passes, without a refresh", async () => {
  await insert(pause(1, { endsAt: NOW0 + 3_000 }))
  const rt = runtime()
  expect((await rt.pausedUpstreams()).size).toBe(1)
  now += 3_000
  expect((await rt.pausedUpstreams()).size).toBe(0)
})

test("only pause-mode rows block: warnings are ignored, keys are looked up by id, the empty key is never paused, the longest pause wins", async () => {
  await insert(pause(1, { mode: "notify", targetId: "up_test_n", upstreamId: "up_test_n" }))
  await insert(pause(2, { targetKind: "key", targetId: "key_test_a", endsAt: NOW0 + 60_000 }))
  const rt = runtime()
  expect((await rt.pausedUpstreams()).has("up_test_n")).toBe(false)
  expect((await rt.pausedKey("key_test_a"))?.endsAt).toBe(NOW0 + 60_000)
  expect(await rt.pausedKey("key_test_b")).toBeNull()
  expect(await rt.pausedKey("")).toBeNull()
  expect((await rt.activePauses()).map(p => p.id).sort()).toEqual([pid(1), pid(2)]) // the banner still sees the warning
})

test("a failing refresh keeps the previous rows in force and tries again after the TTL; it never throws", async () => {
  await insert(pause(1))
  const rt = runtime()
  expect((await rt.pausedUpstreams()).size).toBe(1)
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  const list = spyOn(repo.protection, "listActive").mockRejectedValue(new Error("D1 down"))
  now += 10_000
  expect((await rt.pausedUpstreams()).size).toBe(1)
  expect((await rt.pausedUpstreams()).size).toBe(1)
  expect(list).toHaveBeenCalledTimes(1)
  list.mockRestore()
  now += 10_000
  expect((await rt.pausedUpstreams()).size).toBe(1)
  expect(warn).toHaveBeenCalled()
  warn.mockRestore()
  const cold = new ProtectionRuntime({ repo: () => ({ protection: { listActive: async () => { throw new Error("down") } } }) as never, now: () => now, schedule: () => {} })
  const warn2 = spyOn(console, "warn").mockImplementation(() => {})
  expect((await cold.pausedUpstreams()).size).toBe(0)
  warn2.mockRestore()
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-cache.test.ts`
Expected: FAIL (`rt.activePauses is not a function`).

- [ ] **Step 3: Implement**

Add to the class in `runtime.ts` (and `import type { PauseResolver } from "../repo/protection.ts"`):

```ts
  private cache: { at: number; rows: PauseRecord[] } | null = null
  private inflight: Promise<void> | null = null

  /** Unresolved, unexpired rows of every mode, from a cache refreshed at most every `cacheTtlMs`. Never throws. */
  async activePauses(): Promise<readonly PauseRecord[]> {
    const nowMs = this.now()
    if (!this.cache || nowMs - this.cache.at >= this.cacheTtlMs) await this.refresh(nowMs)
    return (this.cache?.rows ?? []).filter(row => row.resolvedAt === null && row.endsAt > nowMs)
  }

  private refresh(nowMs: number): Promise<void> {
    if (this.inflight) return this.inflight
    const work: Promise<void> = this.load(nowMs).finally(() => { if (this.inflight === work) this.inflight = null })
    this.inflight = work
    return work
  }

  /** Fail-open: on error the previous rows (or none) stay in force and the next attempt waits for the TTL. */
  private async load(nowMs: number): Promise<void> {
    try {
      this.cache = { at: nowMs, rows: await this.repo().protection.listActive(nowMs) }
    } catch (error) {
      warn("protection_cache_refresh_failed", error)
      this.cache = { at: nowMs, rows: this.cache?.rows ?? [] }
    }
  }

  /** Paused upstreams (mode `pause` only), mapped to the row that ends last. */
  async pausedUpstreams(): Promise<Map<string, PauseRecord>> {
    const out = new Map<string, PauseRecord>()
    for (const row of await this.activePauses()) {
      if (row.mode !== "pause" || row.targetKind !== "upstream") continue
      const previous = out.get(row.targetId)
      if (!previous || row.endsAt > previous.endsAt) out.set(row.targetId, row)
    }
    return out
  }

  /** The pause-mode row that blocks an API key (the one ending last), or null. The empty key id is never paused. */
  async pausedKey(keyId: string): Promise<PauseRecord | null> {
    if (keyId === "") return null
    let found: PauseRecord | null = null
    for (const row of await this.activePauses()) {
      if (row.mode === "pause" && row.targetKind === "key" && row.targetId === keyId && (!found || row.endsAt > found.endsAt)) found = row
    }
    return found
  }

  /** Resolves a row (`owner` from the dashboard) and drops it from this isolate's cache at once. */
  async resume(id: string, by: PauseResolver): Promise<boolean> {
    const resolved = await this.repo().protection.resolvePause(id, by, this.now())
    if (resolved && this.cache) this.cache = { ...this.cache, rows: this.cache.rows.filter(row => row.id !== id) }
    return resolved
  }
```

and at the end of `evaluate`, replace the final `return { ...pause, resolvedAt: null, resolvedBy: null }` with:

```ts
    const created: PauseRecord = { ...pause, resolvedAt: null, resolvedBy: null }
    // This isolate enforces the new row at once; other isolates see it within `cacheTtlMs`.
    if (this.cache) this.cache = { ...this.cache, rows: [...this.cache.rows, created] }
    return created
```

- [ ] **Step 4: Run it and see it pass**

Run: `bun test packages/gateway/tests/protection-cache.test.ts packages/gateway/tests/protection-evaluate.test.ts`
Expected: PASS. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/protection/runtime.ts packages/gateway/tests/protection-cache.test.ts
git commit -m "feat(protection): per-isolate active pause cache with local immediate effect" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 11: Enforcement in chat routing (skip paused upstreams, `503 upstream_paused` with `Retry-After`)

**Files:**
- Create: `packages/gateway/src/protection/messages.ts`
- Modify: `packages/protocols-llm/src/common/result.ts` (`InternalErrorResult` L162-172, `llmInternalErrorResult` L203-214, new `retryAfterHeaders`), `packages/protocols-llm/src/common/index.ts` (export list near L123-124)
- Modify: `packages/gateway/src/data-plane/routing/candidates.ts` (`EnumerateResult` L26-37, `enumerateBindingCandidates` L81-123)
- Modify: `packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts` (`SelectBindingResult` L26-32, `selectBindingForProtocol` L103-116)
- Modify: `chat-flow/chat-completions/attempt.ts` (L115), `chat-flow/messages/attempt.ts` (union L129-134, L320), `chat-flow/responses/attempt.ts` (union L136-141, L318), `chat-flow/gemini/attempt.ts` (union L129-134, L163)
- Modify: `chat-flow/chat-completions/respond.ts` (L344-352), `chat-flow/messages/respond.ts` (L346-360), `chat-flow/gemini/respond.ts` (L388-399), `chat-flow/responses/turn.ts` (L334-336)
- Create: `packages/gateway/tests/protection-enforcement-fixture.ts`, `protection-enforcement.sqlite.test.ts`, `protection-paused-render.test.ts`

- [ ] **Step 1: Write the shared fixture and the failing tests**

```ts
// packages/gateway/tests/protection-enforcement-fixture.ts
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { initBackground, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index.ts"
import { listUpstreamModels } from "../src/data-plane/providers/registry.ts"
import type { UpstreamRecord } from "../src/repo/types.ts"
import type { NewPause } from "../src/repo/protection.ts"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime.ts"

export const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
let counter = 0
export const pauseId = () => `pp_${(++counter).toString(16).padStart(32, "0")}`

export async function enforcementFixture(ids: readonly string[] = ["up_test_first", "up_test_second"]) {
  initRuntimeLocation("bun")
  initBackground({ waitUntil: () => {} })
  const db = new Database(":memory:")
  const repo = new BunSqliteRepo(db)
  initRepo(repo)
  for (const [index, id] of ids.entries()) {
    const row: UpstreamRecord = { id, provider: "custom", name: id, enabled: true, sortOrder: index,
      config: { name: id, baseUrl: `https://${id}.invalid`, authStyle: "none", endpoints: ["chat_completions", "responses", "embeddings"], models: ["shared"] },
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], state: null,
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }
    await repo.upstreams.save(row)
  }
  await listUpstreamModels()
  const clock = { now: NOW }
  const runtime = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: () => {} })
  setProtectionForTests(runtime)
  /** Inserts a pause row straight into the repo (as another isolate would). */
  const pause = async (over: Partial<NewPause> & { targetId: string }): Promise<NewPause> => {
    const row: NewPause = {
      id: pauseId(), targetKind: "upstream", upstreamId: over.targetId, mode: "pause",
      reason: { windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: null, upstreamName: over.targetId },
      startedAt: NOW, endsAt: NOW + 600_000, ...over,
    }
    await repo.protection.insertPauseIfNone(row, NOW)
    return row
  }
  return { db, repo, runtime, clock, pause, close: () => db.close() }
}
```

```ts
// packages/gateway/tests/protection-enforcement.sqlite.test.ts
import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { selectBindingForChatCompletions } from "../src/data-plane/chat-flow/shared/select-binding.ts"
import { NOW, enforcementFixture } from "./protection-enforcement-fixture"

const closers: Array<() => void> = []
afterEach(() => { for (const close of closers.splice(0)) close(); __resetPlatformForTests() })
const fixture = async (ids?: readonly string[]) => { const f = await enforcementFixture(ids); closers.push(f.close); return f }
const select = (model = "shared") => selectBindingForChatCompletions({ model, auth: {} })

test("a paused upstream is skipped and the next upstream serves the model", async () => {
  const f = await fixture()
  expect((await select())).toMatchObject({ kind: "ok", binding: { upstream: "up_test_first" } })
  await f.pause({ targetId: "up_test_first" })
  f.clock.now += 10_000 // the other isolate's row is visible after the cache TTL
  expect((await select())).toMatchObject({ kind: "ok", binding: { upstream: "up_test_second" } })
})

test("when every upstream that serves the model is paused the answer is upstream-paused with the earliest resume time", async () => {
  const f = await fixture()
  await f.pause({ targetId: "up_test_first", endsAt: NOW + 600_000 })
  await f.pause({ targetId: "up_test_second", endsAt: NOW + 90_000 })
  f.clock.now += 10_000
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
  f.clock.now += 10_000
  expect((await select("up_test_first/shared")).kind).toBe("upstream-paused")
  expect((await select("up_test_second/shared")).kind).toBe("ok")
})

test("warnings never block, and an unknown model is still model-not-found", async () => {
  const f = await fixture()
  await f.pause({ targetId: "up_test_first", mode: "notify" })
  f.clock.now += 10_000
  expect((await select())).toMatchObject({ kind: "ok", binding: { upstream: "up_test_first" } })
  expect((await select("nope")).kind).toBe("model-not-found")
})

test("resuming restores service at once on this isolate; a fresh pause is enforced only after the cache TTL elsewhere", async () => {
  const f = await fixture(["up_test_first"])
  expect((await select()).kind).toBe("ok") // warms the cache with no rows
  const row = await f.pause({ targetId: "up_test_first" })
  expect((await select()).kind).toBe("ok") // not refreshed yet: within 10 s
  f.clock.now += 10_000
  expect((await select()).kind).toBe("upstream-paused")
  expect(await f.runtime.resume(row.id, "owner")).toBe(true)
  expect((await select()).kind).toBe("ok")
})

test("paused-upstream selection does not hide the upstream's models from listings", async () => {
  const f = await fixture(["up_test_first"])
  await f.pause({ targetId: "up_test_first" })
  f.clock.now += 10_000
  const { listProviderBindings } = await import("../src/data-plane/providers/registry.ts")
  expect((await listProviderBindings()).map(b => b.upstream)).toContain("up_test_first")
})
```

```ts
// packages/gateway/tests/protection-paused-render.test.ts
import { beforeEach, expect, test } from 'bun:test'
import { llmInternalErrorResult } from '@vibe-llm/protocols/common'
import { respondChatCompletions } from '../src/data-plane/chat-flow/chat-completions/respond.ts'
import { respondMessages } from '../src/data-plane/chat-flow/messages/respond.ts'
import { respondGemini } from '../src/data-plane/chat-flow/gemini/respond.ts'
import { respondResponses } from '../src/data-plane/chat-flow/responses/respond.ts'
import { chatCompletionsAttempt } from '../src/data-plane/chat-flow/chat-completions/attempt.ts'
import { messagesAttempt } from '../src/data-plane/chat-flow/messages/attempt.ts'
import { responsesAttempt } from '../src/data-plane/chat-flow/responses/attempt.ts'
import { geminiAttempt } from '../src/data-plane/chat-flow/gemini/attempt.ts'
import { setupTestPlatform } from './_setup-platform.ts'

beforeEach(() => setupTestPlatform())
const paused = () => llmInternalErrorResult(503, new Error('Upstream "A" is paused'), undefined, 'upstream-paused', { code: 'upstream_paused', retryAfterSeconds: 120 })
const plain = () => llmInternalErrorResult(502, new Error('boom'))

test('chat completions: code in the body and Retry-After on the response', async () => {
  const r = await respondChatCompletions(paused(), { wantsStream: false, includeUsageChunk: false })
  expect([r.status, r.headers.get('retry-after')]).toEqual([503, '120'])
  expect(await r.json()).toEqual({ error: { message: 'Upstream "A" is paused', code: 'upstream_paused' } })
  const other = await respondChatCompletions(plain(), { wantsStream: false, includeUsageChunk: false })
  expect(other.headers.get('retry-after')).toBeNull()
  expect(await other.json()).toEqual({ error: { message: 'boom' } })
})

test('messages: api_error with the code and Retry-After', async () => {
  const r = await respondMessages(paused(), { wantsStream: false })
  expect([r.status, r.headers.get('retry-after')]).toEqual([503, '120'])
  expect(await r.json()).toEqual({ type: 'error', error: { type: 'api_error', message: 'Upstream "A" is paused', code: 'upstream_paused' } })
})

test('gemini: Google RPC body unchanged, Retry-After added', async () => {
  const r = await respondGemini(paused(), { wantsStream: false })
  expect([r.status, r.headers.get('retry-after')]).toEqual([503, '120'])
  expect(((await r.json()) as { error: { code: number } }).error.code).toBe(503)
})

test('responses: api_error with the code and Retry-After', async () => {
  const r = await respondResponses(paused(), { wantsStream: false })
  expect([r.status, r.headers.get('retry-after')]).toEqual([503, '120'])
  expect(await r.json()).toMatchObject({ error: { type: 'api_error', code: 'upstream_paused' } })
})

test('every attempt maps an upstream-paused selection to a 503 internal error carrying code and retry seconds', async () => {
  const selection = { kind: 'upstream-paused', bareModel: 'm', message: 'Upstream "A" is paused', retryAfterSeconds: 42 }
  const common = { auth: { ownerId: 'o' }, ctx: { requestStartedAt: Date.now() }, telemetryCtx: {} as never, selectBinding: async () => selection }
  const results = await Promise.all([
    chatCompletionsAttempt.generate({ ...common, payload: { model: 'm', messages: [] } } as never),
    messagesAttempt.generate({ ...common, payload: { model: 'm', messages: [] } } as never),
    responsesAttempt.generate({ ...common, payload: { model: 'm', input: [] } } as never),
    geminiAttempt.generate({ ...common, model: 'm', payload: {} } as never),
  ])
  for (const result of results) {
    expect(result).toMatchObject({ type: 'internal-error', status: 503, reason: 'upstream-paused', code: 'upstream_paused', retryAfterSeconds: 42 })
  }
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test packages/gateway/tests/protection-enforcement.sqlite.test.ts packages/gateway/tests/protection-paused-render.test.ts`
Expected: FAIL (the paused upstream is still selected; `retryAfterSeconds`/`code` are not rendered; the attempts do not know `upstream-paused`).

- [ ] **Step 3: Implement**

`packages/gateway/src/protection/messages.ts`:

```ts
import type { PauseRecord } from "../repo/protection.ts"

/** Whole seconds until `endsAt`, at least 1, for `Retry-After`. */
export const retryAfterSeconds = (endsAt: number, nowMs: number): number => Math.max(1, Math.ceil((endsAt - nowMs) / 1000))

export interface PausedRoute { message: string; retryAfterSeconds: number }

/**
 * The 503 for a request whose every candidate upstream is paused: names the upstreams and when the first resumes.
 * `candidateUpstreamIds` are the paused candidates' upstream ids; ids without a row in `paused` are ignored.
 */
export function pausedRoute(candidateUpstreamIds: readonly string[], paused: ReadonlyMap<string, PauseRecord>, nowMs: number): PausedRoute | null {
  const rows = [...new Set(candidateUpstreamIds)].flatMap(id => { const row = paused.get(id); return row ? [row] : [] })
  if (rows.length === 0) return null
  const resumesAt = Math.min(...rows.map(row => row.endsAt))
  const seconds = retryAfterSeconds(resumesAt, nowMs)
  const names = rows.map(row => `"${row.reason.upstreamName ?? row.targetId}"`).join(", ")
  const plural = rows.length > 1
  return {
    retryAfterSeconds: seconds,
    message: `${plural ? "Upstreams" : "Upstream"} ${names} ${plural ? "are" : "is"} paused to protect the account after an error flood; service resumes at ${new Date(resumesAt).toISOString()}. Retry after ${seconds} seconds.`,
  }
}

/** The 503 for a paused API key. */
export function keyPausedMessage(pause: PauseRecord, nowMs: number): { message: string; retryAfterSeconds: number } {
  const seconds = retryAfterSeconds(pause.endsAt, nowMs)
  return {
    retryAfterSeconds: seconds,
    message: `This API key is paused to protect an upstream account after an error flood; it resumes at ${new Date(pause.endsAt).toISOString()}. Retry after ${seconds} seconds.`,
  }
}
```

`packages/protocols-llm/src/common/result.ts`: add to `InternalErrorResult`

```ts
  /** Machine-readable error code rendered into the body (e.g. `upstream_paused`). */
  readonly code?: string
  /** Rendered as a `Retry-After` header. */
  readonly retryAfterSeconds?: number
```

change `llmInternalErrorResult` to

```ts
export const llmInternalErrorResult = (
  status: number,
  error: Error,
  performance?: PerformanceTelemetryContext,
  reason?: string,
  extras?: { code?: string; retryAfterSeconds?: number },
): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
  performance,
  reason,
  ...(extras?.code !== undefined ? { code: extras.code } : {}),
  ...(extras?.retryAfterSeconds !== undefined ? { retryAfterSeconds: extras.retryAfterSeconds } : {}),
})

/** `Retry-After` for an internal error that asks the client to come back later; undefined otherwise. */
export const retryAfterHeaders = (result: Pick<InternalErrorResult, 'retryAfterSeconds'>): Record<string, string> | undefined =>
  result.retryAfterSeconds === undefined ? undefined : { 'retry-after': String(result.retryAfterSeconds) }
```

and add `retryAfterHeaders,` next to `llmInternalErrorResult,` in `packages/protocols-llm/src/common/index.ts`.

`routing/candidates.ts`: add `import type { PauseRecord } from '../../repo/protection.ts'` and `import { getProtection } from '../../protection/runtime.ts'`; extend `EnumerateResult`:

```ts
  /** Candidates dropped because their upstream is paused (mode `pause`). */
  pausedCandidates?: BindingCandidate[]
  /** The paused upstreams at enumeration time, by upstream id. */
  pausedUpstreams?: ReadonlyMap<string, PauseRecord>
```

and in `enumerateBindingCandidates`, after `ids` is computed, replace `current` and the returned object's getters:

```ts
  const paused = await getProtection().pausedUpstreams() // never throws; fail-open
  const current = () => {
    const found = filterBindingCandidates({ bindings: bindings.find(ids), model, pickTarget, pin: opts.pin })
    if (paused.size === 0) return { ...found, pausedCandidates: [] as BindingCandidate[] }
    return {
      ...found,
      candidates: found.candidates.filter(candidate => !paused.has(candidate.binding.upstream)),
      pausedCandidates: found.candidates.filter(candidate => paused.has(candidate.binding.upstream)),
    }
  }
  return {
    bareModel: parsed.bareModel, upstreamPin, pausedUpstreams: paused,
    get candidates() { return current().candidates },
    get pausedCandidates() { return current().pausedCandidates },
    // ...sawModel, catalogUnavailable, failedCatalogs, materialize, reconcile unchanged
  }
```

`chat-flow/shared/select-binding.ts`: add

```ts
import { getProtection } from '../../../protection/runtime.ts'
import { pausedRoute } from '../../../protection/messages.ts'

export interface UpstreamPausedSelection { kind: 'upstream-paused'; bareModel: string; message: string; retryAfterSeconds: number }
```

add `| UpstreamPausedSelection` to `SelectBindingResult`, and in `selectBindingForProtocol` replace the `if (!first) { ... }` block with:

```ts
  if (!first) {
    if (enumeration.catalogUnavailable) return catalogUnavailable()
    if (!enumeration.sawModel) return { kind: "model-not-found", bareModel }
    const paused = enumeration.pausedUpstreams && enumeration.pausedCandidates?.length
      ? pausedRoute(enumeration.pausedCandidates.map(candidate => candidate.binding.upstream), enumeration.pausedUpstreams, getProtection().now())
      : null
    if (paused) return { kind: "upstream-paused", bareModel, ...paused }
    return { kind: "no-eligible-binding", bareModel }
  }
```

Attempts. In `messages/attempt.ts`, `responses/attempt.ts`, `gemini/attempt.ts` add `import type { UpstreamPausedSelection } from '../shared/select-binding'` and `| UpstreamPausedSelection` to the local `Select*BindingResult` union. In all four attempts add, directly after the `no-eligible-binding` line:

```ts
    if (sel.kind === 'upstream-paused') return llmInternalErrorResult(503, new Error(sel.message), undefined, 'upstream-paused', { code: 'upstream_paused', retryAfterSeconds: sel.retryAfterSeconds })
```

(`responses/attempt.ts` has the line in `selectResponsesAttempt` with two fewer spaces of indentation.)

Renderers (add `retryAfterHeaders` to each file's existing `@vibe-llm/protocols/common` import):

```ts
// chat-completions/respond.ts, replace the final return of the internal-error branch
    return Response.json(
      { error: { message: result.error.message, ...(result.code ? { code: result.code } : {}) } },
      { status: result.status, headers: retryAfterHeaders(result) },
    )

// messages/respond.ts
    return Response.json(
      { type: 'error', error: { type: errType, message: result.error.message, ...(result.code ? { code: result.code } : {}) } },
      { status: result.status, headers: retryAfterHeaders(result) },
    )

// gemini/respond.ts (Google RPC body unchanged)
    return Response.json(
      geminiErrorBody(result.status, result.error.message),
      { status: result.status, headers: retryAfterHeaders(result) },
    )

// responses/turn.ts, replace the internal-error metadata line
      metadata = {
        status: result.status,
        headers: new Headers(retryAfterHeaders(result)),
        body: { error: { type: "api_error", message: result.error.message, ...(result.code ? { code: result.code } : {}) } },
      }
```

- [ ] **Step 4: Run the tests and the wider suites**

Run: `bun test packages/gateway/tests/protection-enforcement.sqlite.test.ts packages/gateway/tests/protection-paused-render.test.ts packages/gateway/tests/data-plane packages/gateway/tests/routing-materialization.sqlite.test.ts`
Expected: PASS (known baseline failures in `respond-json` JSON fallback/terminal and `provider-cancellation-forwarding` unchanged).

Run: `bun run --filter '@vibe-llm/gateway' typecheck && bun run --filter '@vibe-llm/protocols-llm' typecheck 2>/dev/null; bunx eslint packages/gateway/src packages/protocols-llm/src`
Expected: clean (skip the protocols-llm typecheck if the package has no script; `bun run typecheck` at the root covers it in Task 23).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src packages/protocols-llm/src packages/gateway/tests/protection-enforcement-fixture.ts packages/gateway/tests/protection-enforcement.sqlite.test.ts packages/gateway/tests/protection-paused-render.test.ts
git commit -m "feat(protection): skip paused upstreams when routing chat requests and answer 503 upstream_paused" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Enforcement for embeddings, images and other `resolveBinding` callers

**Files:**
- Create: `packages/gateway/src/data-plane/errors/upstream-paused.ts`
- Modify: `packages/gateway/src/data-plane/routing/binding-resolver.ts` (loop and tail, L52-L65)
- Create: `packages/gateway/tests/protection-resolve-binding.sqlite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-resolve-binding.sqlite.test.ts
import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { resolveBinding } from "../src/data-plane/routing/binding-resolver.ts"
import { UpstreamPausedError } from "../src/data-plane/errors/upstream-paused.ts"
import { NOW, enforcementFixture } from "./protection-enforcement-fixture"

const closers: Array<() => void> = []
afterEach(() => { for (const close of closers.splice(0)) close(); __resetPlatformForTests() })
const fixture = async (ids?: readonly string[]) => { const f = await enforcementFixture(ids); closers.push(f.close); return f }

test("a paused upstream is skipped and the next one serves the endpoint", async () => {
  const f = await fixture()
  await f.pause({ targetId: "up_test_first" })
  f.clock.now += 10_000
  expect((await resolveBinding("shared", "embeddings"))?.upstream).toBe("up_test_second")
})

test("when every candidate is paused a 503 with Retry-After and the upstream_paused code is thrown", async () => {
  const f = await fixture(["up_test_first"])
  await f.pause({ targetId: "up_test_first", endsAt: NOW + 90_000 })
  f.clock.now += 10_000
  const error = await resolveBinding("shared", "embeddings").catch(e => e)
  expect(error).toBeInstanceOf(UpstreamPausedError)
  const response = (error as UpstreamPausedError).getResponse()
  expect(response.status).toBe(503)
  expect(response.headers.get("retry-after")).toBe("80")
  const body = await response.json() as { error: { type: string; code: string; message: string } }
  expect(body.error).toMatchObject({ type: "api_error", code: "upstream_paused" })
  expect(body.error.message).toContain('"up_test_first"')
})

test("the Gemini error format keeps the Google RPC body and adds the header", async () => {
  const f = await fixture(["up_test_first"])
  await f.pause({ targetId: "up_test_first" })
  f.clock.now += 10_000
  const error = await resolveBinding("shared", "embeddings", { errorFormat: "gemini" }).catch(e => e) as UpstreamPausedError
  const response = error.getResponse()
  expect(response.headers.get("retry-after")).not.toBeNull()
  expect(((await response.json()) as { error: { code: number } }).error.code).toBe(503)
})

test("a missing model is still null, and a warning row never blocks", async () => {
  const f = await fixture(["up_test_first"])
  await f.pause({ targetId: "up_test_first", mode: "notify" })
  f.clock.now += 10_000
  expect(await resolveBinding("nope", "embeddings")).toBeNull()
  expect((await resolveBinding("shared", "embeddings"))?.upstream).toBe("up_test_first")
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-resolve-binding.sqlite.test.ts`
Expected: FAIL (`Cannot find module "../src/data-plane/errors/upstream-paused.ts"`).

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/data-plane/errors/upstream-paused.ts
import { HTTPException } from 'hono/http-exception'
import { geminiErrorBody } from './forward.ts'

/** For routes without an attempt/result renderer (embeddings, images, decision, count tokens): every candidate upstream is paused. */
export class UpstreamPausedError extends HTTPException {
  constructor(message: string, retryAfterSeconds: number, format?: 'gemini') {
    super(503, {
      message,
      res: Response.json(
        format === 'gemini'
          ? geminiErrorBody(503, message)
          : { error: { type: 'api_error', code: 'upstream_paused', message } },
        { status: 503, headers: { 'retry-after': String(retryAfterSeconds) } },
      ),
    })
  }
}
```

In `routing/binding-resolver.ts` add imports `import { getProtection } from '../../protection/runtime.ts'`, `import { pausedRoute } from '../../protection/messages.ts'`, `import { UpstreamPausedError } from '../errors/upstream-paused.ts'` and replace the section from `const composite = ...` to the end of `resolveBinding` with:

```ts
  const composite = parseCompositeModelId(bareModel)
  const ids = composite.baseId && composite.baseId !== bareModel ? [bareModel, composite.baseId] : [bareModel]
  const paused = await getProtection().pausedUpstreams() // never throws; fail-open
  const skipped: string[] = []
  // This resolver intentionally prefers all direct matches before any base
  // fallback; chat candidate enumeration preserves upstream order instead.
  for (const id of ids) {
    for (const descriptor of bindings.find([id])) {
      if ((upstreamPin && descriptor.upstream !== upstreamPin) || descriptor.model.endpoints[endpoint] === undefined) continue
      if (paused.has(descriptor.upstream)) { skipped.push(descriptor.upstream); continue }
      const binding = await bindings.materialize(descriptor)
      if (binding) return binding
    }
  }
  await bindings.reconcile()

  if (incomplete) throw new ModelCatalogUnavailableError(opts.errorFormat)
  const route = pausedRoute(skipped, paused, getProtection().now())
  if (route) throw new UpstreamPausedError(route.message, route.retryAfterSeconds, opts.errorFormat)
  return null
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/protection-resolve-binding.sqlite.test.ts packages/gateway/tests/data-plane-models-embeddings-images.test.ts packages/gateway/tests/decision-routes.test.ts packages/gateway/tests/count-tokens-billing-attribution.test.ts`
Expected: PASS. Typecheck and eslint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/data-plane/errors/upstream-paused.ts packages/gateway/src/data-plane/routing/binding-resolver.ts packages/gateway/tests/protection-resolve-binding.sqlite.test.ts
git commit -m "feat(protection): skip paused upstreams in resolveBinding and answer 503 upstream_paused" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: Paused API keys are rejected before any upstream call

**Files:**
- Create: `packages/gateway/src/data-plane/protection/key-guard.ts`
- Modify: `packages/gateway/src/app.ts` (import near L15; `app.use` right after the `devAuthMiddleware` line near L63)
- Create: `packages/gateway/tests/protection-key-guard.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-key-guard.test.ts
import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Hono } from "hono"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { keyPausedMiddleware } from "../src/data-plane/protection/key-guard"
import { NOW, enforcementFixture } from "./protection-enforcement-fixture"

let close: () => void = () => {}
afterEach(() => { close(); __resetPlatformForTests() })

async function setup(auth: Record<string, unknown> | undefined) {
  const f = await enforcementFixture(["up_test_first"])
  close = f.close
  const app = new Hono()
  app.use("*", async (c, next) => { if (auth) c.set("auth" as never, auth as never); await next() })
  app.use("*", keyPausedMiddleware)
  let reached = 0
  app.post("/v1/chat/completions", c => { reached++; return c.text("served") })
  return { f, app, reached: () => reached }
}
const call = (app: Hono) => app.request("/v1/chat/completions", { method: "POST" })

test("a request with a paused key gets 503 key_paused with Retry-After and never reaches the handler", async () => {
  const { f, app, reached } = await setup({ apiKeyId: "key_test_1" })
  await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first", endsAt: NOW + 90_000 })
  f.clock.now += 10_000
  const response = await call(app)
  expect(response.status).toBe(503)
  expect(response.headers.get("retry-after")).toBe("80")
  const body = await response.json() as { error: { type: string; code: string; message: string } }
  expect(body.error).toMatchObject({ type: "api_error", code: "key_paused" })
  expect(body.error.message).toContain(new Date(NOW + 90_000).toISOString())
  expect(reached()).toBe(0)
})

test("another key, or a key that only has a warning, passes", async () => {
  const { f, app } = await setup({ apiKeyId: "key_test_2" })
  await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first" })
  await f.pause({ targetKind: "key", targetId: "key_test_2", upstreamId: "up_test_first", mode: "notify" })
  f.clock.now += 10_000
  expect((await call(app)).status).toBe(200)
})

test("a dashboard session and an anonymous request pass even while a key is paused", async () => {
  const session = await setup({ userId: "u1", authKind: "session" })
  await session.f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first" })
  session.f.clock.now += 10_000
  expect((await call(session.app)).status).toBe(200)
})

test("an anonymous request passes", async () => {
  const { app } = await setup(undefined)
  expect((await call(app)).status).toBe(200)
})

test("resuming restores the key at once", async () => {
  const { f, app } = await setup({ apiKeyId: "key_test_1" })
  const row = await f.pause({ targetKind: "key", targetId: "key_test_1", upstreamId: "up_test_first" })
  f.clock.now += 10_000
  expect((await call(app)).status).toBe(503)
  await f.runtime.resume(row.id, "owner")
  expect((await call(app)).status).toBe(200)
})

test("the guard is registered in app.ts after the credential middleware and before any route", () => {
  const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8")
  const guard = source.indexOf("app.use('*', keyPausedMiddleware)")
  expect(guard).toBeGreaterThan(-1)
  expect(guard).toBeGreaterThan(source.indexOf("devAuthMiddleware(c, next)"))
  expect(guard).toBeLessThan(source.indexOf("app.route('/', dmrRouter)"))
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-key-guard.test.ts`
Expected: FAIL (`Cannot find module "../src/data-plane/protection/key-guard"`).

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/data-plane/protection/key-guard.ts
import type { MiddlewareHandler } from 'hono'
import { getProtection } from '../../protection/runtime.ts'
import { keyPausedMessage } from '../../protection/messages.ts'

/**
 * A paused API key gets `503 key_paused` with `Retry-After` on every request, before any upstream is called.
 * Only requests authenticated by an API key are checked: dashboard sessions (which resume keys) pass. A cache refresh
 * failure is fail-open (the runtime never throws).
 */
export const keyPausedMiddleware: MiddlewareHandler = async (c, next) => {
  const auth = c.get('auth' as never) as { apiKeyId?: string } | undefined
  if (auth?.apiKeyId) {
    const runtime = getProtection()
    const pause = await runtime.pausedKey(auth.apiKeyId)
    if (pause) {
      const { message, retryAfterSeconds } = keyPausedMessage(pause, runtime.now())
      return c.json({ error: { type: 'api_error', code: 'key_paused', message } }, 503, { 'Retry-After': String(retryAfterSeconds) })
    }
  }
  await next()
}
```

In `app.ts` add `import { keyPausedMiddleware } from './data-plane/protection/key-guard.ts'` and register it on the line right after the `devAuthMiddleware` registration:

```ts
app.use('*', sessionAuthMiddleware)
app.use('*', (c, next) => /^\/api\/keys\/[^/]+\/setup\//.test(c.req.path) ? next() : devAuthMiddleware(c, next))
// A key paused by upstream protection is refused before any route or upstream is touched.
app.use('*', keyPausedMiddleware)
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/protection-key-guard.test.ts packages/gateway/tests/control-plane-auth.test.ts packages/gateway/tests/chat.e2e.test.ts`
Expected: PASS. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/data-plane/protection/key-guard.ts packages/gateway/src/app.ts packages/gateway/tests/protection-key-guard.test.ts
git commit -m "feat(protection): refuse requests from paused API keys with 503 key_paused" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 14: API: active pauses and owner resume (`/api/protection`)

**Files:**
- Create: `packages/gateway/src/control-plane/protection/dto.ts`
- Create: `packages/gateway/src/control-plane/protection/routes.ts` (this task adds `protectionRouter`; Task 15 adds `upstreamProtectionRouter` to the same file)
- Modify: `packages/gateway/src/control-plane/routes.ts` (import near L31, mount near L38-L42)
- Modify: `packages/gateway/src/control-plane/auth/session-auth.ts` (L98-L104)
- Create: `packages/gateway/tests/protection-api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-api.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { protectionRouter, upstreamProtectionRouter } from "../src/control-plane/protection/routes"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids"
import type { NewPause } from "../src/repo/protection"

const owner = "prot-owner" as UserId
const other = "prot-other" as UserId
const admin = "prot-admin" as UserId
const tokens = { [owner]: "ses_prot_owner", [other]: "ses_prot_other", [admin]: "ses_prot_admin" } as Record<string, string>
const stamp = "2026-11-17T00:00:00.000Z"
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
let db: Database
let repo: BunSqliteRepo
let app: Hono
let runtime: ProtectionRuntime
let counter = 0

const pause = (over: Partial<NewPause>): NewPause => ({
  id: `pp_${(++counter).toString(16).padStart(32, "0")}`, targetKind: "upstream", targetId: "up_test_owned", upstreamId: "up_test_owned", mode: "pause",
  reason: { windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: null },
  startedAt: NOW - 60_000, endsAt: NOW + 600_000, ...over,
})

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  runtime = new ProtectionRuntime({ repo: () => repo, now: () => NOW, schedule: () => {} })
  setProtectionForTests(runtime)
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  await repo.users.create({ id: admin, name: admin, email: "test@local.dev", createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) {
    await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  const row = (id: string, ownerId: string, name: string) => ({ id, ownerId, provider: "custom" as const, name, enabled: true, sortOrder: 0,
    config: {}, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
  await repo.upstreams.save(row("up_test_owned", owner, "Owned upstream"))
  await repo.upstreams.save(row("up_test_global", "", "Global upstream"))
  await repo.apiKeys.save({ id: "key_test_owner" as ApiKeyId, name: "Owner key", key: "gw_test_placeholder_1", createdAt: stamp, ownerId: owner, modelMappingsEnabled: false, modelMappings: [] })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/protection", protectionRouter)
  app.route("/api/upstreams", upstreamProtectionRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

const call = (path: string, method = "GET", user: UserId = owner, headers: Record<string, string> = {}) =>
  app.request(`https://gw.example${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, ...headers } })
const insert = (over: Partial<NewPause>) => { const row = pause(over); return repo.protection.insertPauseIfNone(row, NOW - 60_000).then(() => row) }

test("active pauses are listed with names; owners see their upstream and key rows, strangers see nothing, admins everything", async () => {
  const upstreamRow = await insert({})
  const keyRow = await insert({ targetKind: "key", targetId: "key_test_owner", upstreamId: "up_test_global" })
  await insert({ targetId: "up_test_global", upstreamId: "up_test_global" }) // a global upstream is the admin's, not the user's
  const ownerView = await (await call("/api/protection/active")).json() as { pauses: Array<{ id: string; targetName: string; upstreamName: string; mode: string }> }
  expect(ownerView.pauses.map(p => p.id).sort()).toEqual([upstreamRow.id, keyRow.id].sort())
  expect(ownerView.pauses.find(p => p.id === keyRow.id)).toMatchObject({ targetName: "Owner key", upstreamName: "Global upstream", mode: "pause" })
  expect(ownerView.pauses.find(p => p.id === upstreamRow.id)).toMatchObject({ targetName: "Owned upstream" })
  expect(((await (await call("/api/protection/active", "GET", other)).json()) as { pauses: unknown[] }).pauses).toEqual([])
  expect(((await (await call("/api/protection/active", "GET", admin)).json()) as { pauses: unknown[] }).pauses).toHaveLength(3)
})

test("resolved and expired rows are not active", async () => {
  const resolved = await insert({})
  await repo.protection.resolvePause(resolved.id, "owner", NOW)
  await insert({ targetId: "up_test_owned", upstreamId: "up_test_owned", startedAt: NOW - 120_000, endsAt: NOW - 1_000 })
  expect(((await (await call("/api/protection/active")).json()) as { pauses: unknown[] }).pauses).toEqual([])
})

test("access needs a browser session: no credentials, an API key and a query string are refused", async () => {
  expect((await app.request("https://gw.example/api/protection/active")).status).toBe(401)
  expect((await call("/api/protection/active?x=1")).status).toBe(401)
  expect((await call("/api/protection/active", "GET", owner, { origin: "https://evil.example" })).status).toBe(403)
})

test("the owner resumes a pause: it is resolved by owner and the isolate stops enforcing it at once", async () => {
  const row = await insert({})
  expect((await runtime.pausedUpstreams()).has("up_test_owned")).toBe(true)
  const response = await call(`/api/protection/pauses/${row.id}/resume`, "POST")
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ ok: true })
  expect(await repo.protection.getPause(row.id)).toMatchObject({ resolvedBy: "owner", resolvedAt: NOW })
  expect((await runtime.pausedUpstreams()).size).toBe(0)
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST")).status).toBe(404) // already resolved
})

test("resuming is owner-only: a stranger and an unknown id both get 404, an admin may resume", async () => {
  const row = await insert({})
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST", other)).status).toBe(404)
  expect((await call(`/api/protection/pauses/pp_${"f".repeat(32)}/resume`, "POST")).status).toBe(404)
  expect((await call("/api/protection/pauses/not-an-id/resume", "POST")).status).toBe(404)
  expect(await repo.protection.getPause(row.id)).toMatchObject({ resolvedAt: null })
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST", admin)).status).toBe(200)
})

test("a key's owner can resume a key pause caused by an upstream they do not own", async () => {
  const row = await insert({ targetKind: "key", targetId: "key_test_owner", upstreamId: "up_test_global" })
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST", other)).status).toBe(404)
  expect((await call(`/api/protection/pauses/${row.id}/resume`, "POST", owner)).status).toBe(200)
})

test("responses are never cached", async () => {
  expect((await call("/api/protection/active")).headers.get("cache-control")).toBe("no-store")
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-api.test.ts`
Expected: FAIL (`Cannot find module "../src/control-plane/protection/routes"`).

- [ ] **Step 3: Implement the DTO helpers**

```ts
// packages/gateway/src/control-plane/protection/dto.ts
import { getRepo } from "../../repo/index.ts"
import type { ApiKeyId, UpstreamId } from "../../repo/branded-ids.ts"
import type { PauseMode, PauseReason, PauseRecord, PauseTargetKind } from "../../repo/protection.ts"
import { loadOwned, type OwnerScopedAuth } from "../shared/ownership.ts"

export interface PauseDto {
  id: string
  targetKind: PauseTargetKind
  targetId: string
  targetName: string
  upstreamId: string
  upstreamName: string
  mode: PauseMode
  reason: PauseReason
  startedAt: number
  endsAt: number
  resolvedAt: number | null
  /** `resolvedBy`, or `auto` once the cooldown has passed (the sweep stamps the row later). */
  endedBy: "auto" | "owner" | null
}

export const endedBy = (row: PauseRecord, nowMs: number): PauseDto["endedBy"] => row.resolvedBy ?? (row.endsAt <= nowMs ? "auto" : null)

/** Admins manage every row; a user manages rows of an upstream they own or about a key they own. Anything else behaves as missing. */
export async function canManagePause(auth: OwnerScopedAuth | undefined, row: PauseRecord): Promise<boolean> {
  if (await loadOwned(auth, () => getRepo().upstreams.getById(row.upstreamId as UpstreamId))) return true
  if (row.targetKind !== "key") return false
  return (await loadOwned(auth, () => getRepo().apiKeys.getById(row.targetId as ApiKeyId))) !== null
}

/** Live names (falling back to the names captured in the reason, then the ids). */
export async function toPauseDto(row: PauseRecord, nowMs: number): Promise<PauseDto> {
  const repo = getRepo()
  const upstream = await repo.upstreams.getById(row.upstreamId as UpstreamId).catch(() => null)
  const upstreamName = upstream?.name ?? row.reason.upstreamName ?? row.upstreamId
  let targetName = upstreamName
  if (row.targetKind === "key") {
    const key = await repo.apiKeys.getById(row.targetId as ApiKeyId).catch(() => null)
    targetName = key?.name ?? row.reason.targetName ?? row.targetId
  } else if (row.targetId !== row.upstreamId) targetName = row.reason.targetName ?? row.targetId
  return {
    id: row.id, targetKind: row.targetKind, targetId: row.targetId, targetName, upstreamId: row.upstreamId, upstreamName, mode: row.mode,
    reason: row.reason, startedAt: row.startedAt, endsAt: row.endsAt, resolvedAt: row.resolvedAt, endedBy: endedBy(row, nowMs),
  }
}
```

```ts
// packages/gateway/src/control-plane/protection/routes.ts
import { Hono } from "hono"
import type { Env } from "../../app.ts"
import { getRepo } from "../../repo/index.ts"
import type { FullAuthCtx } from "../../shared/credential-auth.ts"
import { getProtection } from "../../protection/runtime.ts"
import { requireBrowserSession } from "../shared/session-guard.ts"
import { canManagePause, toPauseDto } from "./dto.ts"

type Vars = { auth: FullAuthCtx }
const PAUSE_ID = /^pp_[0-9a-f]{32}$/
const notFound = () => new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } })
const NO_STORE = { "cache-control": "no-store" }

/** `/api/protection`: session-guarded, no query strings. */
export const protectionRouter = new Hono<{ Bindings: Env; Variables: Vars }>()
protectionRouter.use("*", requireBrowserSession)

protectionRouter.get("/active", async (c) => {
  const nowMs = getProtection().now()
  const auth = c.get("auth")
  const pauses = []
  for (const row of await getRepo().protection.listActive(nowMs)) {
    if (await canManagePause(auth, row)) pauses.push(await toPauseDto(row, nowMs))
  }
  return c.json({ pauses }, 200, NO_STORE)
})

protectionRouter.post("/pauses/:id/resume", async (c) => {
  const id = c.req.param("id")
  if (!PAUSE_ID.test(id)) return notFound()
  const runtime = getProtection()
  const row = await getRepo().protection.getPause(id)
  if (!row || row.resolvedAt !== null || row.endsAt <= runtime.now() || !(await canManagePause(c.get("auth"), row))) return notFound()
  if (!(await runtime.resume(id, "owner"))) return notFound()
  return c.json({ ok: true }, 200, NO_STORE)
})
```

Also export an empty router below `protectionRouter` so the mount compiles: `export const upstreamProtectionRouter = new Hono<{ Bindings: Env; Variables: Vars }>()`. Task 15 adds its routes.

In `control-plane/routes.ts` add `import { protectionRouter, upstreamProtectionRouter } from './protection/routes.ts'` and mount right after `controlPlane.route('/api/upstreams', upstreamsRouter)`:

```ts
controlPlane.route('/api/protection', protectionRouter)
controlPlane.route('/api/upstreams', upstreamProtectionRouter)
```

In `session-auth.ts`, next to `telemetryManagement` add

```ts
  const protectionManagement = c.req.path.startsWith('/api/protection/') || /^\/api\/upstreams\/[^/]+\/(?:errors|error-samples|pauses)$/.test(c.req.path)
```

and append `&& !protectionManagement` to the long `if (ctx && resolvedUserId && !hasConfigurationSnapshot() && ... && !telemetryManagement)` condition. (The banner polls every minute; like telemetry, these paths never need the Copilot token prefetch.)

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/protection-api.test.ts packages/gateway/tests/control-plane-auth.test.ts packages/gateway/tests/control-plane-scaffold.test.ts`
Expected: PASS. Typecheck and eslint clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/control-plane packages/gateway/tests/protection-api.test.ts
git commit -m "feat(protection): owner-only API for active pauses and early resume" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 15: API: error series, samples, history and the `protection` setting

**Files:**
- Create: `packages/gateway/src/control-plane/protection/query.ts`
- Modify: `packages/gateway/src/control-plane/protection/routes.ts` (fill `upstreamProtectionRouter`)
- Modify: `packages/gateway/src/control-plane/upstreams/public-dto.ts` (`PublicUpstream` L12-L26, `serializeUpstream` L141-L167)
- Modify: `packages/gateway/src/control-plane/upstreams/routes.ts` (imports; `upstreamBody` L65-L77; `GET /` L404-L414; `PATCH /:id` L461-L506)
- Create: `packages/gateway/tests/protection-query.test.ts`, `protection-upstream-api.test.ts`
- Modify: `packages/gateway/tests/control-plane-sdf-token-expiry.test.ts` (the in-memory `repo` fixture, near L36-L47: the list route now also reads protection settings, so the fake repo needs a `protection` stub)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/protection-query.test.ts
import { expect, test } from "bun:test"
import { parseErrorQuery } from "../src/control-plane/protection/query"

const NOW = 1_800_000_000
const q = (query: string) => parseErrorQuery(new URLSearchParams(query), NOW)

test("a one hour range defaults to minute buckets, a longer one to hour buckets", () => {
  expect(q(`from=${NOW - 3600}&to=${NOW}`)).toMatchObject({ bucketSeconds: 60 })
  expect(q(`from=${NOW - 86_400}&to=${NOW}`)).toMatchObject({ bucketSeconds: 60 }) // 1440 buckets <= 1500
  expect(q(`from=${NOW - 7 * 86_400}&to=${NOW}`)).toMatchObject({ bucketSeconds: 3600 })
})

test("from and to are aligned to whole buckets and default to the last hour", () => {
  expect(q(`from=${NOW - 3600 + 7}&to=${NOW - 7}&bucket=hour`)).toEqual({ from: Math.floor((NOW - 3600 + 7) / 3600) * 3600, to: Math.ceil((NOW - 7) / 3600) * 3600, bucketSeconds: 3600 })
  expect(q("")).toMatchObject({ from: Math.floor((NOW - 3600) / 60) * 60, to: Math.ceil(NOW / 60) * 60, bucketSeconds: 60 })
})

test("at most 30 days and 1500 buckets", () => {
  expect(q(`from=${NOW - 30 * 86_400}&to=${NOW}`)).toMatchObject({ bucketSeconds: 3600 })
  expect(q(`from=${NOW - 30 * 86_400 - 3600}&to=${NOW}`)).toEqual({ error: "range_too_long" })
  expect(q(`from=${NOW - 2 * 86_400}&to=${NOW}&bucket=minute`)).toEqual({ error: "too_many_buckets" })
  expect(q(`from=${NOW - 1500 * 3600}&to=${NOW}&bucket=hour`)).toEqual({ error: "range_too_long" }) // 1500 hours is 62.5 days
})

test("malformed input is refused with a code", () => {
  for (const [query, code] of [
    ["from=abc&to=10", "invalid_range"], ["from=10&to=10", "invalid_range"], ["from=20&to=10", "invalid_range"], ["from=-5&to=10", "invalid_range"],
    [`from=${NOW - 60}&to=${NOW}&bucket=day`, "invalid_bucket"], [`from=${NOW - 60}&to=${NOW}&keyId=${"k".repeat(129)}`, "invalid_key"],
  ] as const) expect(q(query), query).toEqual({ error: code })
  expect(q(`from=${NOW - 60}&to=${NOW}&keyId=key_test_1`)).toMatchObject({ keyId: "key_test_1" })
})
```

```ts
// packages/gateway/tests/protection-upstream-api.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { protectionRouter, upstreamProtectionRouter } from "../src/control-plane/protection/routes"
import { upstreamsRouter } from "../src/control-plane/upstreams/routes"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime"
import { DEFAULT_PROTECTION_SETTINGS } from "../src/repo/protection"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "prot-owner" as UserId
const other = "prot-other" as UserId
const tokens = { [owner]: "ses_prot_owner", [other]: "ses_prot_other" } as Record<string, string>
const stamp = "2026-11-17T00:00:00.000Z"
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)
const MINUTE = Math.floor(NOW / 60_000) * 60
let db: Database
let repo: BunSqliteRepo
let app: Hono

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  setProtectionForTests(new ProtectionRuntime({ repo: () => repo, now: () => NOW, schedule: () => {} }))
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) {
    await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await repo.upstreams.save({ id: "up_test_owned", ownerId: owner, provider: "custom", name: "Owned", enabled: true, sortOrder: 0,
    config: { name: "Owned", baseUrl: "https://owned.invalid", authStyle: "none", endpoints: ["chat_completions"], models: ["m"] },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/protection", protectionRouter)
  app.route("/api/upstreams", upstreamsRouter)
  app.route("/api/upstreams", upstreamProtectionRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

const call = (path: string, method = "GET", user: UserId = owner, body?: unknown) =>
  app.request(`https://gw.example${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })

test("error buckets are returned sparse per bucket with the class counts, filtered by keyId", async () => {
  const base = { upstreamId: "up_test_owned", model: "m" }
  await repo.protection.recordResponse({ ...base, minute: MINUTE, keyId: "key_test_a", cls: "rate_limited" })
  await repo.protection.recordResponse({ ...base, minute: MINUTE, keyId: "key_test_b", cls: "ok" })
  await repo.protection.recordResponse({ ...base, minute: MINUTE - 3600, keyId: "key_test_a", cls: "auth" })
  const all = await (await call(`/api/upstreams/up_test_owned/errors?from=${MINUTE - 7200}&to=${MINUTE + 60}&bucket=hour`)).json() as { bucket: string; buckets: Array<{ t: number; requests: number; rate_limited: number; auth: number }> }
  expect(all.bucket).toBe("hour")
  expect(all.buckets.map(b => [b.requests, b.rate_limited, b.auth])).toEqual([[1, 0, 1], [2, 1, 0]])
  const onlyB = await (await call(`/api/upstreams/up_test_owned/errors?from=${MINUTE - 7200}&to=${MINUTE + 60}&bucket=hour&keyId=key_test_b`)).json() as { buckets: Array<{ requests: number }> }
  expect(onlyB.buckets.map(b => b.requests)).toEqual([1])
})

test("a bad query is a 400 with a code; a stranger, an unknown upstream and a missing session cannot read", async () => {
  const bad = await call(`/api/upstreams/up_test_owned/errors?from=20&to=10`)
  expect([bad.status, await bad.json()]).toEqual([400, { error: { code: "invalid_range" } }])
  expect((await call(`/api/upstreams/up_test_owned/errors`, "GET", other)).status).toBe(404)
  expect((await call(`/api/upstreams/up_test_nope/error-samples`)).status).toBe(404)
  expect((await call(`/api/upstreams/up_test_owned/pauses`, "GET", other)).status).toBe(404)
  expect((await app.request("https://gw.example/api/upstreams/up_test_owned/errors")).status).toBe(401)
})

test("the key filter parameter is keyId because the session guard refuses a `key` query parameter", async () => {
  expect((await call(`/api/upstreams/up_test_owned/errors?key=key_test_a`)).status).toBe(401)
})

test("samples list the latest per status and carry no request content", async () => {
  await repo.protection.recordResponse({ upstreamId: "up_test_owned", model: "m", minute: MINUTE, keyId: "key_test_a", cls: "rate_limited", sample: { status: 429, at: NOW, code: "rate_limit_exceeded", message: "slow down" } })
  const body = await (await call(`/api/upstreams/up_test_owned/error-samples`)).json() as { samples: Array<Record<string, unknown>> }
  expect(body.samples).toEqual([{ upstreamId: "up_test_owned", status: 429, at: NOW, keyId: "key_test_a", model: "m", code: "rate_limit_exceeded", message: "slow down" }])
})

test("pause history is newest first, limited, with the way each one ended", async () => {
  const mk = (n: number, over: object) => ({ id: `pp_${n.toString(16).padStart(32, "0")}`, targetKind: "upstream" as const, targetId: "up_test_owned", upstreamId: "up_test_owned", mode: "pause" as const,
    reason: { windowMinutes: 5, requests: 1, risky: 1, counts: { rate_limited: 1, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 1, topKeys: [], trigger: "ratio" as const, keyShare: null }, ...over })
  await repo.protection.insertPauseIfNone(mk(1, { startedAt: NOW - 3 * 3_600_000, endsAt: NOW - 2 * 3_600_000 }), NOW - 3 * 3_600_000)
  const second = mk(2, { startedAt: NOW - 3_600_000, endsAt: NOW + 600_000 })
  await repo.protection.insertPauseIfNone(second, NOW - 3_600_000)
  await repo.protection.resolvePause(second.id, "owner", NOW - 1_000)
  await repo.protection.insertPauseIfNone(mk(3, { startedAt: NOW - 60_000, endsAt: NOW + 600_000 }), NOW - 60_000)
  const body = await (await call(`/api/upstreams/up_test_owned/pauses?limit=3`)).json() as { pauses: Array<{ id: string; endedBy: string | null }> }
  expect(body.pauses.map(p => [p.id.slice(-1), p.endedBy])).toEqual([["3", null], ["2", "owner"], ["1", "auto"]])
  expect(((await (await call(`/api/upstreams/up_test_owned/pauses?limit=1`)).json()) as { pauses: unknown[] }).pauses).toHaveLength(1)
  expect((await call(`/api/upstreams/up_test_owned/pauses?limit=0`)).status).toBe(400)
  expect((await call(`/api/upstreams/up_test_owned/pauses?limit=101`)).status).toBe(400)
})

test("PATCH accepts and validates protection; GET returns it resolved with defaults", async () => {
  const before = await (await call("/api/upstreams")).json() as { upstreams: Array<{ id: string; protection: unknown }> }
  expect(before.upstreams.find(u => u.id === "up_test_owned")?.protection).toEqual(DEFAULT_PROTECTION_SETTINGS)
  const patched = await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: { mode: "pause", minRiskyErrors: 7 } })
  expect(patched.status).toBe(200)
  expect(((await patched.json()) as { upstream: { protection: unknown } }).upstream.protection).toEqual({ ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", minRiskyErrors: 7 })
  const after = await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: { windowMinutes: 10 } }) // merges onto the stored values
  expect(((await after.json()) as { upstream: { protection: unknown } }).upstream.protection).toEqual({ ...DEFAULT_PROTECTION_SETTINGS, mode: "pause", minRiskyErrors: 7, windowMinutes: 10 })
  const listed = await (await call("/api/upstreams")).json() as { upstreams: Array<{ id: string; protection: { mode: string } }> }
  expect(listed.upstreams.find(u => u.id === "up_test_owned")?.protection.mode).toBe("pause")
  for (const bad of [{ windowMinutes: 0 }, { windowMinutes: 61 }, { minFailureRatio: 1.5 }, { keyShare: 0.4 }, { mode: "ban" }, { nope: 1 }, { cooldownMinutes: 100, maxCooldownMinutes: 50 }, "x"]) {
    const response = await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: bad })
    expect(response.status, JSON.stringify(bad)).toBe(400)
  }
  expect((await repo.protection.getSettings("up_test_owned"))).toMatchObject({ windowMinutes: 10 }) // failed patches changed nothing
  expect((await call("/api/upstreams/up_test_owned", "PATCH", other, { protection: { mode: "pause" } })).status).toBe(404)
})

test("a PATCH without protection leaves the stored settings alone", async () => {
  await call("/api/upstreams/up_test_owned", "PATCH", owner, { protection: { mode: "notify" } })
  await call("/api/upstreams/up_test_owned", "PATCH", owner, { name: "Renamed" })
  expect((await repo.protection.getSettings("up_test_owned"))).toMatchObject({ mode: "notify" })
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test packages/gateway/tests/protection-query.test.ts packages/gateway/tests/protection-upstream-api.test.ts`
Expected: FAIL (`Cannot find module "../src/control-plane/protection/query"`; the upstream routes answer 404 for `/errors`).

- [ ] **Step 3: Implement the query parser**

```ts
// packages/gateway/src/control-plane/protection/query.ts
export const MAX_RANGE_SECONDS = 30 * 86_400
export const MAX_BUCKETS = 1500
const SECONDS = /^\d{1,12}$/

export type ErrorQuery = { from: number; to: number; bucketSeconds: 60 | 3600; keyId?: string }

/**
 * `from` / `to` are unix seconds (default: the last hour). Buckets are `minute` or `hour`; the default is minute while the
 * range fits in 1500 minutes, else hour. Aligned to whole buckets; at most 30 days and 1500 buckets.
 */
export function parseErrorQuery(params: URLSearchParams, nowSec: number): ErrorQuery | { error: "invalid_range" | "invalid_bucket" | "invalid_key" | "range_too_long" | "too_many_buckets" } {
  const rawTo = params.get("to")
  const rawFrom = params.get("from")
  if ((rawTo !== null && !SECONDS.test(rawTo)) || (rawFrom !== null && !SECONDS.test(rawFrom))) return { error: "invalid_range" }
  const to0 = rawTo === null ? nowSec : Number(rawTo)
  const from0 = rawFrom === null ? to0 - 3600 : Number(rawFrom)
  if (!(to0 > from0)) return { error: "invalid_range" }
  if (to0 - from0 > MAX_RANGE_SECONDS) return { error: "range_too_long" }
  const bucket = params.get("bucket")
  if (bucket !== null && bucket !== "minute" && bucket !== "hour") return { error: "invalid_bucket" }
  const bucketSeconds: 60 | 3600 = bucket === "hour" ? 3600 : bucket === "minute" ? 60 : (to0 - from0) / 60 <= MAX_BUCKETS ? 60 : 3600
  const from = Math.floor(from0 / bucketSeconds) * bucketSeconds
  const to = Math.ceil(to0 / bucketSeconds) * bucketSeconds
  if ((to - from) / bucketSeconds > MAX_BUCKETS) return { error: "too_many_buckets" }
  const keyId = params.get("keyId")
  if (keyId !== null && (keyId.length === 0 || keyId.length > 128)) return { error: "invalid_key" }
  return { from, to, bucketSeconds, ...(keyId === null ? {} : { keyId }) }
}
```

- [ ] **Step 4: Implement the upstream-scoped routes** (replace the empty `upstreamProtectionRouter` declaration in `routes.ts` with the following; the new imports go at the top of the file)

```ts
import { loadOwned } from "../shared/ownership.ts"
import type { UpstreamId } from "../../repo/branded-ids.ts"
import { requireBrowserSessionAllowingQuery } from "../shared/session-guard.ts"
import { parseErrorQuery } from "./query.ts"

/** `/api/upstreams/:id/{errors,error-samples,pauses}`: session-guarded, owner-only (admins see all). Mounted next to `upstreamsRouter`. */
export const upstreamProtectionRouter = new Hono<{ Bindings: Env; Variables: Vars }>()
const bad = (code: string) => new Response(JSON.stringify({ error: { code } }), { status: 400, headers: { "content-type": "application/json", "cache-control": "no-store" } })
const ownedUpstream = (auth: FullAuthCtx | undefined, id: string) => loadOwned(auth, () => getRepo().upstreams.getById(id as UpstreamId))

upstreamProtectionRouter.get("/:id/errors", requireBrowserSessionAllowingQuery, async (c) => {
  const id = c.req.param("id")
  if (!(await ownedUpstream(c.get("auth"), id))) return notFound()
  const query = parseErrorQuery(new URL(c.req.url).searchParams, Math.floor(getProtection().now() / 1000))
  if ("error" in query) return bad(query.error)
  const buckets = await getRepo().protection.errorBuckets(id, query.from, query.to, query.bucketSeconds, query.keyId)
  return c.json({ upstreamId: id, from: query.from, to: query.to, bucket: query.bucketSeconds === 60 ? "minute" : "hour", buckets }, 200, NO_STORE)
})

upstreamProtectionRouter.get("/:id/error-samples", requireBrowserSessionAllowingQuery, async (c) => {
  const id = c.req.param("id")
  if (!(await ownedUpstream(c.get("auth"), id))) return notFound()
  return c.json({ samples: await getRepo().protection.listSamples(id) }, 200, NO_STORE)
})

upstreamProtectionRouter.get("/:id/pauses", requireBrowserSessionAllowingQuery, async (c) => {
  const id = c.req.param("id")
  if (!(await ownedUpstream(c.get("auth"), id))) return notFound()
  const raw = new URL(c.req.url).searchParams.get("limit")
  const limit = raw === null ? 20 : /^\d{1,3}$/.test(raw) ? Number(raw) : 0
  if (limit < 1 || limit > 100) return bad("invalid_limit")
  const nowMs = getProtection().now()
  const rows = await getRepo().protection.listPauses(id, limit)
  return c.json({ pauses: await Promise.all(rows.map(row => toPauseDto(row, nowMs))) }, 200, NO_STORE)
})
```

- [ ] **Step 5: Implement the `protection` setting on the upstream routes**

`public-dto.ts`: add `protection?: ProtectionSettings` to `PublicUpstream` (import `type ProtectionSettings` from `../../repo/protection.ts`), widen the options type to `{ syncOrigin?: string | null; protection?: ProtectionSettings }`, and before `return dto` add `if (options.protection) dto.protection = options.protection`.

`upstreams/routes.ts`: import `resolveProtection, normalizeProtection` from `../../protection/settings.ts` and `type ProtectionSettings` from `../../repo/protection.ts`; add `protection: z.unknown().optional(),` to `upstreamBody`; in `GET /` replace the `serializeUpstream` map with:

```ts
  const settings = await getRepo().protection.getSettingsMany(upstreams.map((upstream) => upstream.id))
  return c.json({ upstreams: upstreams.map((upstream) => serializeUpstream(upstream, { syncOrigin, protection: resolveProtection(settings.get(upstream.id)) })) })
```

In `PATCH /:id`, directly before `const next = await getRepo().upstreams.patchMetadata(...)` add:

```ts
    // Validated before anything is written, so a bad `protection` leaves the upstream untouched. Missing keys keep their stored value.
    let protection: ProtectionSettings | undefined
    if (body.protection !== undefined) {
      const current = resolveProtection(await getRepo().protection.getSettings(id))
      protection = input(() => normalizeProtection(body.protection, current))
    }
```

and after `invalidateUpstreamCaches(existing, next)` replace the response with:

```ts
    if (protection) await getRepo().protection.setSettings(id, protection, Date.now())
    const effective = protection ?? resolveProtection(await getRepo().protection.getSettings(id))
    return c.json({ upstream: serializeUpstream(next, { syncOrigin: await syncOriginFor([next]), protection: effective }) })
```

- [ ] **Step 6: Give the fake repo of the SDF token tests the new dependency, then run the tests**

In `control-plane-sdf-token-expiry.test.ts`, inside the `repo: { ... } as unknown as Repo` literal of `inMemoryRepo()`, add next to `upstreams`:

```ts
      // The list route reads protection settings next to the upstreams.
      protection: { getSettingsMany: async () => new Map(), getSettings: async () => null, setSettings: async () => {} },
```

Run: `bun test packages/gateway/tests/protection-query.test.ts packages/gateway/tests/protection-upstream-api.test.ts packages/gateway/tests/protection-api.test.ts packages/gateway/tests/control-plane-upstreams.test.ts packages/gateway/tests/control-plane-upstream-duplicate-metadata.test.ts packages/gateway/tests/control-plane-sdf-token-expiry.test.ts`
Expected: PASS. Typecheck and eslint clean.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/control-plane packages/gateway/tests/protection-query.test.ts packages/gateway/tests/protection-upstream-api.test.ts packages/gateway/tests/control-plane-sdf-token-expiry.test.ts
git commit -m "feat(protection): error series, samples, history and protection settings API" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 16: Retention in scheduled maintenance

**Files:**
- Modify: `packages/gateway/src/maintenance.ts` (task list in `sweepMaintenance`, L32-L44)
- Create: `packages/gateway/tests/protection-retention.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/protection-retention.test.ts
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import { __resetPlatformForTests, initEnv } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { resetTelemetryRetentionState, sweepMaintenance } from "../src/maintenance"
import { DEFAULT_PROTECTION_SETTINGS } from "../src/repo/protection"

const NOW = Date.UTC(2026, 10, 17, 12, 0)
const day = 86_400
let raw: Database
let repo: BunSqliteRepo
let db: BunSqliteDatabase
let files: FsFileProvider
let root: string

beforeEach(async () => {
  resetTelemetryRetentionState()
  __resetPlatformForTests()
  initEnv(() => "")
  root = await mkdtemp(join(tmpdir(), "protection-retention-"))
  raw = new Database(join(root, "test.sqlite"))
  repo = new BunSqliteRepo(raw)
  initRepo(repo)
  db = new BunSqliteDatabase(raw)
  files = new FsFileProvider(join(root, "files"))
})
afterEach(async () => { raw.close(); await rm(root, { recursive: true, force: true }); __resetPlatformForTests() })

const count = (table: string) => raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n

test("the maintenance sweep deletes minutes older than 30 days, pauses older than 90 days, and orphaned samples and settings", async () => {
  raw.run("INSERT INTO upstreams (id, provider, name, created_at, updated_at) VALUES ('up_test_live', 'custom', 'live', 't', 't')")
  const nowSec = NOW / 1000
  for (const [upstreamId, ageDays] of [["up_test_live", 31], ["up_test_live", 29], ["up_test_gone", 10]] as const) {
    await repo.protection.recordResponse({ upstreamId, model: "m", keyId: "k", cls: "rate_limited", minute: nowSec - ageDays * day,
      sample: { status: 429, at: NOW, code: "", message: "x" } })
  }
  await repo.protection.setSettings("up_test_live", DEFAULT_PROTECTION_SETTINGS, NOW)
  await repo.protection.setSettings("up_test_gone", DEFAULT_PROTECTION_SETTINGS, NOW)
  const row = (n: number, startedAt: number) => ({ id: `pp_${n.toString(16).padStart(32, "0")}`, targetKind: "upstream" as const, targetId: "up_test_live", upstreamId: "up_test_live", mode: "pause" as const,
    reason: {} as never, startedAt, endsAt: startedAt + 60_000 })
  await repo.protection.insertPauseIfNone(row(1, NOW - 91 * day * 1000), NOW - 91 * day * 1000)
  await repo.protection.insertPauseIfNone(row(2, NOW - 10 * 60_000), NOW - 10 * 60_000)

  await sweepMaintenance(db, files, NOW)

  expect(count("upstream_request_minutes")).toBe(2) // the 31 day old row is gone
  expect(count("protection_pauses")).toBe(1)
  expect(await repo.protection.getPause(row(2, 0).id)).toMatchObject({ resolvedBy: "auto" }) // its cooldown ended
  expect(await repo.protection.listSamples("up_test_gone")).toEqual([])
  expect((await repo.protection.listSamples("up_test_live")).length).toBe(2) // the live upstream keeps both of its samples
  expect(await repo.protection.getSettings("up_test_gone")).toBeNull()
  expect(await repo.protection.getSettings("up_test_live")).not.toBeNull()
})

test("a failing protection purge is logged and does not stop the other maintenance tasks", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  spyOn(repo.protection, "deleteExpired").mockRejectedValue(new Error("D1 down"))
  await expect(sweepMaintenance(db, files, NOW)).resolves.toBeUndefined()
  expect(warn.mock.calls.map(call => String(call[0]))).toContain(JSON.stringify({ evt: "maintenance_failed", operation: "protection_retention" }))
  warn.mockRestore()
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test packages/gateway/tests/protection-retention.test.ts`
Expected: FAIL (old rows are still present: `expect(received).toBe(2)` got 3).

- [ ] **Step 3: Implement**

In `maintenance.ts` add one entry to the task list in `sweepMaintenance`, after `telemetry_retention`:

```ts
    ["protection_retention", () => getRepo().protection.deleteExpired(now).then(() => undefined)],
```

Each sweep issues about five statements (auto-resolve stamp plus four index-ranged deletes); a backlog continues on the next sweep (chunk 5000, at most 10 DELETEs per table per call).

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/protection-retention.test.ts packages/gateway/tests/telemetry-retention.test.ts packages/gateway/tests/catalog-maintenance.test.ts`
Expected: PASS. Typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/maintenance.ts packages/gateway/tests/protection-retention.test.ts
git commit -m "feat(protection): retention for minute stats, pauses, samples and settings" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 17: Dashboard foundations: API client, local-time helpers, polling

**Files:**
- Create: `apps/dashboard/src/api/protection.ts`
- Create: `apps/dashboard/src/state/protection-poll.ts`, `apps/dashboard/src/state/protection-poll.test.ts`
- Create: `apps/dashboard/src/tabs/telemetry/telemetry-format-clock.test.ts`
- Modify: `apps/dashboard/src/tabs/telemetry/telemetry-format.ts` (after `formatInstant`, near L59)
- Modify: `apps/dashboard/src/api/types.ts` (`UpstreamRecord`, after `proxyFallbackList` L44), `apps/dashboard/src/api/upstreams.ts` (`UpstreamPatch` L60-L68)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/dashboard/src/tabs/telemetry/telemetry-format-clock.test.ts
import { afterEach, expect, test } from "bun:test"
import { formatClockMs, formatInstantMs, formatUntil, setDisplayZone } from "./telemetry-format"

afterEach(() => setDisplayZone(null))

test("clock, instant and until text follow the display zone, not UTC", () => {
  setDisplayZone("Asia/Shanghai")
  const at = Date.UTC(2026, 10, 17, 10, 40) // 18:40 in Shanghai
  expect(formatClockMs(at)).toBe("18:40")
  expect(formatInstantMs(at)).toBe("2026-11-17 18:40")
  expect(formatUntil(at, Date.UTC(2026, 10, 17, 2, 0))).toBe("18:40") // 10:00 local the same day: just the clock
  expect(formatUntil(at, Date.UTC(2026, 10, 16, 2, 0))).toBe("11-17 18:40") // another local day: with the date
  setDisplayZone("UTC")
  expect(formatClockMs(at)).toBe("10:40")
})

test("a time just before local midnight is the same day for a nearby now, the next day for an earlier one", () => {
  setDisplayZone("America/New_York")
  const at = Date.UTC(2026, 10, 18, 4, 30) // 23:30 on Nov 17 in New York (UTC-5)
  expect(formatUntil(at, Date.UTC(2026, 10, 17, 15, 0))).toBe("23:30")
  expect(formatUntil(at, Date.UTC(2026, 10, 18, 6, 0))).toBe("11-17 23:30")
})
```

```ts
// apps/dashboard/src/state/protection-poll.test.ts
import { expect, test } from "bun:test"
import { startPolling } from "./protection-poll"

const fakeTimers = () => {
  const ticks: Array<() => void> = []
  const cleared: unknown[] = []
  return {
    ticks, cleared,
    timers: { setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length }, clearInterval: (id: never) => { cleared.push(id) } },
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

test("loads at once, then on every tick, and stops when told to", async () => {
  const f = fakeTimers()
  let loads = 0
  const stop = startPolling(async () => { loads++ }, 60_000, f.timers)
  expect(loads).toBe(1)
  await settle()
  f.ticks[0]!()
  expect(loads).toBe(2)
  await settle()
  stop()
  expect(f.cleared).toEqual([1])
  f.ticks[0]!()
  expect(loads).toBe(2)
})

test("a load that is still running is not started twice, and a failing load does not stop the polling", async () => {
  const f = fakeTimers()
  let loads = 0
  let release: () => void = () => {}
  startPolling(() => { loads++; return new Promise<void>((resolve, reject) => { release = loads === 1 ? resolve : () => reject(new Error("offline")) }) }, 60_000, f.timers)
  f.ticks[0]!()
  expect(loads).toBe(1)
  release()
  await settle()
  f.ticks[0]!()
  expect(loads).toBe(2)
  release()
  await settle()
  f.ticks[0]!()
  expect(loads).toBe(3)
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test apps/dashboard/src/tabs/telemetry/telemetry-format-clock.test.ts apps/dashboard/src/state/protection-poll.test.ts`
Expected: FAIL (missing exports / module).

- [ ] **Step 3: Implement**

In `telemetry-format.ts`, directly after the `formatInstant` definition add:

```ts
/** `HH:mm` of an instant (ms) in the display zone. */
export const formatClockMs = (ms: number): string => { const p = zoneParts(ms); return `${pad(p.hour)}:${pad(p.minute)}` }
/** An instant (ms) as `YYYY-MM-DD HH:mm` in the display zone. */
export const formatInstantMs = (ms: number): string => formatInstant(new Date(ms).toISOString())
/** When a pause ends: `HH:mm` if that is today's date in the display zone, `MM-DD HH:mm` otherwise. */
export function formatUntil(ms: number, nowMs: number): string {
  const at = zoneParts(ms)
  const now = zoneParts(nowMs)
  const sameDay = at.year === now.year && at.month === now.month && at.day === now.day
  return sameDay ? formatClockMs(ms) : `${pad(at.month)}-${pad(at.day)} ${formatClockMs(ms)}`
}
```

```ts
// apps/dashboard/src/state/protection-poll.ts
export interface PollingTimers { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (id: never) => void }
export const PROTECTION_POLL_MS = 60_000

const realTimers: PollingTimers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as never),
}

/** Runs `load` now and every `intervalMs`; a load still in flight is not started twice and a failure never stops the polling. Returns the stop function. */
export function startPolling(load: () => Promise<void>, intervalMs = PROTECTION_POLL_MS, timers: PollingTimers = realTimers): () => void {
  let running = false
  let stopped = false
  const tick = () => {
    if (running || stopped) return
    running = true
    void load().catch(() => {}).finally(() => { running = false })
  }
  tick()
  const id = timers.setInterval(tick, intervalMs)
  return () => { stopped = true; timers.clearInterval(id as never) }
}
```

```ts
// apps/dashboard/src/api/protection.ts
import { api } from "./client"

export const ERROR_CLASS_KEYS = ["rate_limited", "rejected", "auth", "upstream", "network", "other"] as const
export type ErrorClassKey = (typeof ERROR_CLASS_KEYS)[number]
export type ProtectionMode = "off" | "notify" | "pause"

export interface ProtectionSettings {
  mode: ProtectionMode
  windowMinutes: number
  minRiskyErrors: number
  minFailureRatio: number
  authBurst: number
  keyShare: number
  cooldownMinutes: number
  maxCooldownMinutes: number
}

export interface PauseReason {
  windowMinutes: number
  requests: number
  risky: number
  counts: Record<ErrorClassKey, number>
  failureRatio: number
  topKeys: Array<{ keyId: string; risky: number }>
  trigger: "ratio" | "authBurst"
  keyShare: number | null
  upstreamName?: string
  targetName?: string
}

/** One row of `/api/protection/active` and of the pause history (times are unix ms). */
export interface ProtectionPause {
  id: string
  targetKind: "upstream" | "key"
  targetId: string
  targetName: string
  upstreamId: string
  upstreamName: string
  mode: "pause" | "notify"
  reason: PauseReason
  startedAt: number
  endsAt: number
  resolvedAt: number | null
  endedBy: "auto" | "owner" | null
}

export interface ErrorBucketRow extends Record<ErrorClassKey, number> { t: number; requests: number }
export interface ErrorSeries { upstreamId: string; from: number; to: number; bucket: "minute" | "hour"; buckets: ErrorBucketRow[] }
export interface ErrorSample { upstreamId: string; status: number; at: number; keyId: string; model: string; code: string; message: string }

export const getActivePauses = () => api<{ pauses: ProtectionPause[] }>("/api/protection/active")
export const resumePause = (id: string) => api<{ ok: true }>(`/api/protection/pauses/${encodeURIComponent(id)}/resume`, { method: "POST" })
const upstream = (id: string, rest: string) => `/api/upstreams/${encodeURIComponent(id)}/${rest}`
export const getErrorSeries = (id: string, query: { from: number; to: number; bucket: "minute" | "hour"; keyId?: string }) =>
  api<ErrorSeries>(upstream(id, "errors"), { query })
export const getErrorSamples = (id: string) => api<{ samples: ErrorSample[] }>(upstream(id, "error-samples"))
export const getPauseHistory = (id: string, limit = 20) => api<{ pauses: ProtectionPause[] }>(upstream(id, "pauses"), { query: { limit } })
```

In `api/types.ts` add `import type { ProtectionSettings } from "./protection"` and the field `protection?: ProtectionSettings` to `UpstreamRecord` (after `proxyFallbackList`). In `api/upstreams.ts` add `protection?: Partial<ProtectionSettings>` to `UpstreamPatch` (import the type).

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test apps/dashboard/src/tabs/telemetry apps/dashboard/src/state/protection-poll.test.ts`
Expected: PASS (existing telemetry tests unchanged).

Run: `bun run --filter '@vibe-llm/dashboard' typecheck && bunx eslint apps/dashboard/src`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/api/protection.ts apps/dashboard/src/api/types.ts apps/dashboard/src/api/upstreams.ts apps/dashboard/src/state/protection-poll.ts apps/dashboard/src/state/protection-poll.test.ts apps/dashboard/src/tabs/telemetry
git commit -m "feat(dashboard): protection API client, local-time helpers and polling" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 18: Global banner on every page (wording, Resume now, link to the upstream), EN and ZH

**Files:**
- Create: `apps/dashboard/src/state/protection.tsx`
- Create: `apps/dashboard/src/components/protection-banner-model.ts`, `apps/dashboard/src/components/ProtectionBanner.tsx`, `apps/dashboard/src/components/ProtectionBanner.test.tsx`
- Modify: `apps/dashboard/src/shell/AppShell.tsx` (props L8-L15, render L33-L36), `apps/dashboard/src/shell/shell.test.tsx` (append one test), `apps/dashboard/src/App.tsx` (imports; `Shell` return L36-L40)
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (EN block after `"dash.tlmAxisMs": "Milliseconds",` near L425; ZH block after `"dash.tlmAxisMs": "毫秒",` near L2021)

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/dashboard/src/components/ProtectionBanner.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { PauseReason, ProtectionPause } from "../api/protection"
import { installDictionary } from "../state/i18n-fixture"
import { setDisplayZone } from "../tabs/telemetry/telemetry-format"
import { bannerItems } from "./protection-banner-model"
import { ProtectionBanner } from "./ProtectionBanner"

const NOW = Date.UTC(2026, 10, 17, 12, 0)
let restore: () => void = () => {}
beforeEach(() => { setDisplayZone("UTC"); restore = installDictionary("en") })
afterEach(() => { restore(); setDisplayZone(null) })

const reason = (over: Partial<PauseReason> = {}): PauseReason => ({
  windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 },
  failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: null, ...over,
})
const pause = (over: Partial<ProtectionPause> = {}): ProtectionPause => ({
  id: "pp_" + "1".repeat(32), targetKind: "upstream", targetId: "up_a", targetName: "Copilot A", upstreamId: "up_a", upstreamName: "Copilot A", mode: "pause",
  reason: reason(), startedAt: NOW - 60_000, endsAt: Date.UTC(2026, 10, 17, 18, 40), resolvedAt: null, endedBy: null, ...over,
})
const text = (p: ProtectionPause) => bannerItems([p], window.t!, NOW)[0]!.text

test("an upstream pause reads as the spec's sentence", () => {
  expect(text(pause())).toBe("Upstream Copilot A paused until 18:40 — 46 rate-limit errors in 5 min (92% of requests).")
})

test("a key pause names the key and the upstream; the date is added when the end is on another day", () => {
  expect(text(pause({ targetKind: "key", targetId: "key_1", targetName: "CI key", upstreamName: "Copilot A" })))
    .toBe("API key CI key paused until 18:40 — 46 rate-limit errors in 5 min (92% of requests) on upstream Copilot A.")
  expect(text(pause({ endsAt: Date.UTC(2026, 10, 18, 2, 10) }))).toContain("paused until 11-18 02:10")
})

test("warnings (notify) say the upstream or key is receiving an error flood", () => {
  expect(text(pause({ mode: "notify" }))).toBe("Upstream Copilot A is receiving an error flood — 46 rate-limit errors in 5 min (92% of requests).")
  expect(text(pause({ mode: "notify", targetKind: "key", targetName: "CI key" })))
    .toBe("API key CI key is causing an error flood on upstream Copilot A — 46 rate-limit errors in 5 min (92% of requests).")
})

test("the summary names the dominant risky class", () => {
  const rejected = reason({ counts: { rate_limited: 3, rejected: 30, auth: 1, upstream: 0, network: 0, other: 0 }, risky: 34, failureRatio: 0.68 })
  expect(text(pause({ reason: rejected }))).toContain("30 rejected-request errors in 5 min (68% of requests)")
  const auth = reason({ counts: { rate_limited: 0, rejected: 0, auth: 5, upstream: 0, network: 0, other: 0 }, risky: 5, failureRatio: 0.004 })
  expect(text(pause({ reason: auth }))).toContain("5 authentication errors in 5 min (0% of requests)")
})

test("the same sentence in Chinese", () => {
  restore()
  restore = installDictionary("zh")
  expect(text(pause())).toBe("上游 Copilot A 已暂停至 18:40 — 5 分钟内 46 个限流错误（占请求的 92%）。")
})

test("pauses come before warnings, newest first; only pauses can be resumed", () => {
  const items = bannerItems([
    pause({ id: "pp_" + "a".repeat(32), mode: "notify", startedAt: 3 }),
    pause({ id: "pp_" + "b".repeat(32), startedAt: 1 }),
    pause({ id: "pp_" + "c".repeat(32), startedAt: 2 }),
  ], window.t!, NOW)
  expect(items.map(item => [item.id.slice(3, 4), item.canResume, item.tone])).toEqual([["c", true, "danger"], ["b", true, "danger"], ["a", false, "warn"]])
})

test("the banner shows each item with Resume now for pauses and a link only when the viewer can open the upstream", () => {
  const items = bannerItems([pause(), pause({ id: "pp_" + "2".repeat(32), mode: "notify" })], window.t!, NOW)
  const html = renderToStaticMarkup(<ProtectionBanner items={items} onResume={() => {}} onOpen={() => {}} canOpen={item => item.canResume} />)
  expect(html).toContain('role="region"')
  expect(html).toContain("Upstream protection")
  expect(html.match(/Resume now/g)).toHaveLength(1)
  expect(html.match(/Protection settings/g)).toHaveLength(1)
  expect(html).toContain("is receiving an error flood")
})

test("without items nothing is rendered", () => {
  expect(renderToStaticMarkup(<ProtectionBanner items={[]} onResume={() => {}} onOpen={() => {}} canOpen={() => true} />)).toBe("")
})
```

Append to `apps/dashboard/src/shell/shell.test.tsx` (and add `import { AppShell } from "./AppShell"` and `import { AuthProvider } from "../state/auth"` to its imports; the shell's user menu needs the auth context, which does nothing until effects run, so static rendering is safe):

```tsx
test("the shell shows its banner above the page crumb and the page", () => {
  const shell = (banner?: React.ReactNode) => renderToStaticMarkup(
    <AuthProvider>
      <AppShell groups={buildNavGroups(t, { isAdmin: true })} current="usage" onSelect={() => {}} offNavTitles={{}} banner={banner}>
        <p>page body</p>
      </AppShell>
    </AuthProvider>,
  )
  const html = shell(<div data-banner="x">B</div>)
  const banner = html.indexOf('data-banner="x"')
  expect(banner).toBeGreaterThan(-1)
  expect(banner).toBeLessThan(html.indexOf("page body"))
  expect(shell()).not.toContain("data-banner")
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test apps/dashboard/src/components/ProtectionBanner.test.tsx apps/dashboard/src/shell/shell.test.tsx`
Expected: FAIL (`Cannot find module "./protection-banner-model"`, and `banner` is not rendered).

- [ ] **Step 3: Implement**

i18n keys (insert verbatim, six-space indent, after the anchor lines named above). English:

```
      "dash.protBannerLabel": "Upstream protection",
      "dash.protBannerUpstreamPaused": "Upstream {name} paused until {until} — {summary}.",
      "dash.protBannerKeyPaused": "API key {name} paused until {until} — {summary} on upstream {upstream}.",
      "dash.protBannerUpstreamWarning": "Upstream {name} is receiving an error flood — {summary}.",
      "dash.protBannerKeyWarning": "API key {name} is causing an error flood on upstream {upstream} — {summary}.",
      "dash.protSummary": "{count} {kind} errors in {minutes} min ({percent}% of requests)",
      "dash.protKindRateLimited": "rate-limit",
      "dash.protKindRejected": "rejected-request",
      "dash.protKindAuth": "authentication",
      "dash.protResumeNow": "Resume now",
      "dash.protOpenSettings": "Protection settings",
      "dash.protResumed": "Resumed.",
      "dash.protResumeFailed": "Could not resume. Please retry.",
```

Chinese:

```
      "dash.protBannerLabel": "上游保护",
      "dash.protBannerUpstreamPaused": "上游 {name} 已暂停至 {until} — {summary}。",
      "dash.protBannerKeyPaused": "API 密钥 {name} 已暂停至 {until} — {summary}（上游 {upstream}）。",
      "dash.protBannerUpstreamWarning": "上游 {name} 正在遭遇错误洪峰 — {summary}。",
      "dash.protBannerKeyWarning": "API 密钥 {name} 正在上游 {upstream} 上造成错误洪峰 — {summary}。",
      "dash.protSummary": "{minutes} 分钟内 {count} 个{kind}错误（占请求的 {percent}%）",
      "dash.protKindRateLimited": "限流",
      "dash.protKindRejected": "被拒绝请求",
      "dash.protKindAuth": "认证",
      "dash.protResumeNow": "立即恢复",
      "dash.protOpenSettings": "保护设置",
      "dash.protResumed": "已恢复。",
      "dash.protResumeFailed": "无法恢复，请重试。",
```

```ts
// apps/dashboard/src/components/protection-banner-model.ts
import type { PauseReason, ProtectionPause } from "../api/protection"
import { formatUntil } from "../tabs/telemetry/telemetry-format"

export type Translate = (key: string, vars?: Record<string, string | number>) => string
const RISKY = ["rate_limited", "rejected", "auth"] as const
const KIND_KEYS = { rate_limited: "dash.protKindRateLimited", rejected: "dash.protKindRejected", auth: "dash.protKindAuth" } as const

/** "46 rate-limit errors in 5 min (92% of requests)": the dominant risky class, the window and the failure ratio. */
export function summarizeReason(reason: PauseReason, t: Translate): string {
  const kind = RISKY.reduce((best, cls) => (reason.counts[cls] > reason.counts[best] ? cls : best), RISKY[0])
  return t("dash.protSummary", { count: reason.counts[kind], kind: t(KIND_KEYS[kind]), minutes: reason.windowMinutes, percent: Math.round(reason.failureRatio * 100) })
}

export interface BannerItem {
  id: string
  tone: "danger" | "warn"
  text: string
  /** Only pauses are resumed; a warning just ends. */
  canResume: boolean
  upstreamId: string
  targetKind: "upstream" | "key"
}

/** Pauses first, then warnings; newest first within each. */
export function bannerItems(pauses: readonly ProtectionPause[], t: Translate, nowMs: number): BannerItem[] {
  return [...pauses]
    .sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "pause" ? -1 : 1) || b.startedAt - a.startedAt)
    .map((pause): BannerItem => {
      const vars = { name: pause.targetName, upstream: pause.upstreamName, until: formatUntil(pause.endsAt, nowMs), summary: summarizeReason(pause.reason, t) }
      const key = pause.targetKind === "key" ? "Key" : "Upstream"
      const text = pause.mode === "pause" ? t(`dash.protBanner${key}Paused`, vars) : t(`dash.protBanner${key}Warning`, vars)
      return { id: pause.id, tone: pause.mode === "pause" ? "danger" : "warn", text, canResume: pause.mode === "pause", upstreamId: pause.upstreamId, targetKind: pause.targetKind }
    })
}
```

```tsx
// apps/dashboard/src/components/ProtectionBanner.tsx
import { useAuth } from "../state/auth"
import { useT } from "../state/i18n"
import { useProtection } from "../state/protection"
import { Button } from "../ui/button"
import { Notice } from "../ui/notice"
import { bannerItems, type BannerItem } from "./protection-banner-model"

interface Props {
  items: readonly BannerItem[]
  onResume: (id: string) => void
  onOpen: (upstreamId: string) => void
  /** Whether the viewer can open this item's upstream (owners of key rows on someone else's upstream cannot). */
  canOpen: (item: BannerItem) => boolean
}

/** Shown on every page while a pause or warning is active; renders nothing otherwise. */
export function ProtectionBanner({ items, onResume, onOpen, canOpen }: Props) {
  const t = useT()
  if (items.length === 0) return null
  return (
    <div role="region" aria-label={t("dash.protBannerLabel")} className="mb-4 space-y-2">
      {items.map((item) => (
        <Notice key={item.id} tone={item.tone}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>{item.text}</span>
            <span className="flex shrink-0 gap-1">
              {item.canResume ? <Button size="sm" variant="secondary" onClick={() => onResume(item.id)}>{t("dash.protResumeNow")}</Button> : null}
              {canOpen(item) ? <Button size="sm" variant="ghost" onClick={() => onOpen(item.upstreamId)}>{t("dash.protOpenSettings")}</Button> : null}
            </span>
          </div>
        </Notice>
      ))}
    </div>
  )
}

/** The banner wired to the store; refreshed every 60 s and after Resume. */
export function ProtectionBannerHost() {
  const t = useT()
  const { session } = useAuth()
  const store = useProtection()
  const items = bannerItems(store.pauses, t, Date.now())
  const isAdmin = session?.isAdmin === true
  return <ProtectionBanner items={items} onResume={(id) => { void store.resume(id) }} onOpen={store.openUpstream} canOpen={(item) => item.targetKind === "upstream" || isAdmin} />
}
```

```tsx
// apps/dashboard/src/state/protection.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { getActivePauses, resumePause, type ProtectionPause } from "../api/protection"
import { useT } from "./i18n"
import { startPolling } from "./protection-poll"
import { useToast } from "./toast"

export interface ProtectionStore {
  /** Active pauses and warnings the viewer may see. */
  pauses: readonly ProtectionPause[]
  refresh: () => Promise<void>
  /** Resumes a pause (owner action); true on success. */
  resume: (id: string) => Promise<boolean>
  /** An upstream the banner asked the Upstreams page to open at its Protection section. */
  focusUpstreamId: string | null
  openUpstream: (id: string) => void
  clearFocus: () => void
}

const EMPTY: ProtectionStore = { pauses: [], refresh: async () => {}, resume: async () => false, focusUpstreamId: null, openUpstream: () => {}, clearFocus: () => {} }
const Ctx = createContext<ProtectionStore>(EMPTY)

/** Polls `/api/protection/active` every 60 s and after actions. Must sit inside the toast provider and after login. */
export function ProtectionProvider({ children }: { children: ReactNode }) {
  const { push: toast } = useToast()
  const t = useT()
  const [pauses, setPauses] = useState<ProtectionPause[]>([])
  const [focusUpstreamId, setFocus] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try { setPauses((await getActivePauses()).pauses) } catch { /* keep the last list; the next poll retries */ }
  }, [])
  useEffect(() => startPolling(refresh), [refresh])
  const resume = useCallback(async (id: string) => {
    try {
      await resumePause(id)
      toast(t("dash.protResumed"), "success")
      await refresh()
      return true
    } catch {
      toast(t("dash.protResumeFailed"), "error")
      return false
    }
  }, [refresh, toast, t])
  const openUpstream = useCallback((id: string) => { setFocus(id); window.location.hash = "upstreams" }, [])
  const clearFocus = useCallback(() => setFocus(null), [])
  const value = useMemo(() => ({ pauses, refresh, resume, focusUpstreamId, openUpstream, clearFocus }), [pauses, refresh, resume, focusUpstreamId, openUpstream, clearFocus])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** Without a provider (tests, logged-out pages) the store is empty and every action is a no-op. */
export const useProtection = (): ProtectionStore => useContext(Ctx)
```

`AppShell.tsx`: add `banner?: ReactNode` to `Props`, destructure it, and render `{banner}` directly above `<PageCrumb group={group} page={page} fallback={title} />`.

`App.tsx`: import `{ ProtectionProvider } from "./state/protection"` and `{ ProtectionBannerHost } from "./components/ProtectionBanner"`, and change the end of `Shell` to:

```tsx
  return (
    <ProtectionProvider>
      <AppShell groups={groups} current={tab} onSelect={setTab} offNavTitles={offNavTitles} banner={<ProtectionBannerHost />}>
        <TabBody tab={tab} />
      </AppShell>
    </ProtectionProvider>
  )
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/dashboard/src packages/gateway/tests/i18n-keys.test.ts packages/gateway/tests/i18n-interpolation.test.ts`
Expected: PASS (banner tests, shell test, EN/ZH parity, type-scale).

Run: `bun run --filter '@vibe-llm/dashboard' typecheck && bunx eslint apps/dashboard/src`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(dashboard): global upstream protection banner with Resume now" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 19: Dashboard logic: settings form model, chart data shaping, stacked error chart

**Files:**
- Create: `apps/dashboard/src/tabs/upstreams/protection/protection-form.ts`, `protection-form.test.ts`
- Create: `apps/dashboard/src/tabs/upstreams/protection/error-chart.ts`, `error-chart.test.ts`
- Create: `apps/dashboard/src/tabs/upstreams/protection/ErrorBarChart.tsx`, `ErrorBarChart.test.tsx`
- Create: `packages/gateway/tests/protection-defaults-parity.test.ts`
- Modify: `apps/dashboard/src/components/TimeSeriesChart.tsx` (`isDarkTheme` near L96, `cssVar` near L112: add `export`)

- [ ] **Step 1: Write the failing tests**

```ts
// apps/dashboard/src/tabs/upstreams/protection/protection-form.test.ts
import { expect, test } from "bun:test"
import { NUMERIC_FIELDS, PROTECTION_DEFAULTS, PROTECTION_LIMITS, isDirty, parseForm, resetToDefaults, toForm } from "./protection-form"

test("the form round-trips the settings as text", () => {
  const form = toForm({ ...PROTECTION_DEFAULTS, mode: "pause", minFailureRatio: 0.25 })
  expect(form.mode).toBe("pause")
  expect(form.values.minFailureRatio).toBe("0.25")
  const parsed = parseForm(form)
  expect(parsed).toEqual({ ok: true, settings: { ...PROTECTION_DEFAULTS, mode: "pause", minFailureRatio: 0.25 } })
})

test("every field accepts its bounds and rejects just outside them", () => {
  for (const field of NUMERIC_FIELDS) {
    const [min, max] = PROTECTION_LIMITS[field]
    const base = { ...toForm({ ...PROTECTION_DEFAULTS, cooldownMinutes: 1, maxCooldownMinutes: 10080 }) }
    const at = (value: number) => parseForm({ ...base, values: { ...base.values, [field]: String(value) } })
    expect(at(min), `${field} min`).toMatchObject({ ok: true })
    expect(at(max), `${field} max`).toMatchObject({ ok: true })
    const step = ["minFailureRatio", "keyShare"].includes(field) ? 0.01 : 1
    expect(at(min - step), `${field} below`).toMatchObject({ ok: false, errors: { [field]: "range" } })
    expect(at(max + step), `${field} above`).toMatchObject({ ok: false, errors: { [field]: "range" } })
  }
})

test("empty, non-numeric and fractional-integer inputs are reported per field", () => {
  const form = toForm(PROTECTION_DEFAULTS)
  expect(parseForm({ ...form, values: { ...form.values, windowMinutes: "" } })).toMatchObject({ ok: false, errors: { windowMinutes: "number" } })
  expect(parseForm({ ...form, values: { ...form.values, authBurst: "abc" } })).toMatchObject({ ok: false, errors: { authBurst: "number" } })
  expect(parseForm({ ...form, values: { ...form.values, minRiskyErrors: "2.5" } })).toMatchObject({ ok: false, errors: { minRiskyErrors: "integer" } })
  expect(parseForm({ ...form, values: { ...form.values, authBurst: "0" } })).toMatchObject({ ok: true }) // 0 disables the burst rule
})

test("the maximum cooldown must not be below the cooldown", () => {
  const form = toForm({ ...PROTECTION_DEFAULTS, cooldownMinutes: 100, maxCooldownMinutes: 50 })
  expect(parseForm(form)).toEqual({ ok: false, errors: { maxCooldownMinutes: "order" } })
})

test("reset restores the defaults but keeps the chosen mode; dirty tracks edits", () => {
  const saved = { ...PROTECTION_DEFAULTS, mode: "notify" as const, windowMinutes: 10 }
  const form = toForm(saved)
  expect(isDirty(form, saved)).toBe(false)
  expect(isDirty({ ...form, values: { ...form.values, windowMinutes: " 10 " } }, saved)).toBe(false)
  expect(isDirty({ ...form, mode: "pause" }, saved)).toBe(true)
  const reset = resetToDefaults(form)
  expect(reset.mode).toBe("notify")
  expect(reset.values.windowMinutes).toBe("5")
  expect(isDirty(reset, saved)).toBe(true)
})
```

```ts
// packages/gateway/tests/protection-defaults-parity.test.ts
import { expect, test } from "bun:test"
import { DEFAULT_PROTECTION_SETTINGS, PROTECTION_LIMITS } from "../src/repo/protection"
import { PROTECTION_DEFAULTS, PROTECTION_LIMITS as DASHBOARD_LIMITS } from "../../../apps/dashboard/src/tabs/upstreams/protection/protection-form"

test("the dashboard's copy of the protection defaults and limits matches the gateway's", () => {
  expect(PROTECTION_DEFAULTS).toEqual(DEFAULT_PROTECTION_SETTINGS)
  expect(DASHBOARD_LIMITS).toEqual(PROTECTION_LIMITS)
})
```

```ts
// apps/dashboard/src/tabs/upstreams/protection/error-chart.test.ts
import { afterEach, expect, test } from "bun:test"
import type { ErrorBucketRow } from "../../../api/protection"
import { setDisplayZone } from "../../telemetry/telemetry-format"
import { ERROR_RANGES, classColors, errorChartModel, fillBuckets, rangeWindow } from "./error-chart"

afterEach(() => setDisplayZone(null))
const row = (t: number, over: Partial<ErrorBucketRow> = {}): ErrorBucketRow =>
  ({ t, requests: 0, rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0, ...over })

test("ranges: 1 h by minute, 24 h / 7 d / 30 d by hour, aligned to the end of the current bucket", () => {
  const now = Date.UTC(2026, 10, 17, 12, 34, 56)
  const hour = rangeWindow("24h", now)
  expect(hour).toEqual({ from: Date.UTC(2026, 10, 16, 13) / 1000, to: Date.UTC(2026, 10, 17, 13) / 1000, bucket: "hour" })
  const minute = rangeWindow("1h", now)
  expect(minute).toEqual({ from: Date.UTC(2026, 10, 17, 11, 35) / 1000, to: Date.UTC(2026, 10, 17, 12, 35) / 1000, bucket: "minute" })
  expect(ERROR_RANGES["30d"].seconds / 3600).toBe(720)
  expect(rangeWindow("7d", now).to - rangeWindow("7d", now).from).toBe(7 * 86_400)
})

test("sparse server rows are zero-filled to one row per bucket", () => {
  const filled = fillBuckets([row(7200, { requests: 5, rate_limited: 2 })], 3600, 14_400, 3600)
  expect(filled.map(r => [r.t, r.requests, r.rate_limited])).toEqual([[3600, 0, 0], [7200, 5, 2], [10_800, 0, 0]])
  expect(fillBuckets([], 0, 120, 60).map(r => r.t)).toEqual([0, 60])
  expect(fillBuckets([row(99_999)], 0, 120, 60).every(r => r.requests === 0)).toBe(true) // rows outside the window are ignored
})

test("the model stacks only the classes that occurred, risky ones first, with requests as the line", () => {
  setDisplayZone("UTC")
  const from = Date.UTC(2026, 10, 17, 10) / 1000
  const model = errorChartModel([row(from, { requests: 10, auth: 1, rate_limited: 4 }), row(from + 3600, { requests: 3, upstream: 1 })],
    { from, to: from + 3 * 3600, bucket: "hour" }, key => `label:${key}`)
  expect(model.labels).toEqual(["11-17 10:00", "11-17 11:00", "11-17 12:00"])
  expect(model.bars.map(b => [b.key, b.label, b.data])).toEqual([
    ["rate_limited", "label:rate_limited", [4, 0, 0]], ["auth", "label:auth", [1, 0, 0]], ["upstream", "label:upstream", [0, 1, 0]]])
  expect(model.requests).toEqual([10, 3, 0])
  expect(model.hasData).toBe(true)
  const empty = errorChartModel([], { from, to: from + 3600, bucket: "hour" }, key => key)
  expect(empty).toMatchObject({ bars: [], requests: [0], hasData: false })
})

test("minute buckets are labelled with the local clock", () => {
  setDisplayZone("Asia/Shanghai")
  const from = Date.UTC(2026, 10, 17, 10, 0) / 1000
  expect(errorChartModel([], { from, to: from + 120, bucket: "minute" }, k => k).labels).toEqual(["18:00", "18:01"])
})

test("each class has its own colour per theme, and the risky classes are warm (red channel above blue)", () => {
  for (const dark of [false, true]) {
    const colors = classColors(dark)
    const values = Object.values(colors)
    expect(new Set(values).size).toBe(values.length)
    for (const key of ["rate_limited", "rejected", "auth"] as const) {
      const hex = colors[key].replace("#", "")
      expect(parseInt(hex.slice(0, 2), 16), `${key} red`).toBeGreaterThan(parseInt(hex.slice(4, 6), 16))
    }
  }
})
```

```tsx
// apps/dashboard/src/tabs/upstreams/protection/ErrorBarChart.test.tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ErrorBarChart } from "./ErrorBarChart"

test("the chart is a canvas in a sized box (Chart.js draws into it after mount)", () => {
  const html = renderToStaticMarkup(<ErrorBarChart labels={["a"]} bars={[{ key: "rate_limited", label: "Rate limited", data: [1] }]} requests={{ label: "Requests", data: [3] }} height={240} />)
  expect(html).toContain("<canvas")
  expect(html).toContain("height:240px")
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test apps/dashboard/src/tabs/upstreams/protection packages/gateway/tests/protection-defaults-parity.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: Implement**

```ts
// apps/dashboard/src/tabs/upstreams/protection/protection-form.ts
import type { ProtectionMode, ProtectionSettings } from "../../../api/protection"

/** Mirrors `DEFAULT_PROTECTION_SETTINGS` / `PROTECTION_LIMITS` in the gateway (a gateway test fails if they drift). */
export const PROTECTION_DEFAULTS: ProtectionSettings = {
  mode: "off", windowMinutes: 5, minRiskyErrors: 20, minFailureRatio: 0.5, authBurst: 5, keyShare: 0.8, cooldownMinutes: 30, maxCooldownMinutes: 360,
}
export const PROTECTION_LIMITS = {
  windowMinutes: [1, 60], minRiskyErrors: [1, 10000], minFailureRatio: [0, 1], authBurst: [0, 10000],
  keyShare: [0.5, 1], cooldownMinutes: [1, 1440], maxCooldownMinutes: [1, 10080],
} as const

export type NumericField = keyof typeof PROTECTION_LIMITS
export const NUMERIC_FIELDS = Object.keys(PROTECTION_LIMITS) as NumericField[]
export const INTEGER_FIELDS: ReadonlySet<NumericField> = new Set<NumericField>(["windowMinutes", "minRiskyErrors", "authBurst", "cooldownMinutes", "maxCooldownMinutes"])

/** Inputs are text while editing; `parseForm` turns them into settings or per-field errors. */
export interface ProtectionForm { mode: ProtectionMode; values: Record<NumericField, string> }
export type FieldErrorKind = "number" | "integer" | "range" | "order"
export type FieldErrors = Partial<Record<NumericField, FieldErrorKind>>

export const toForm = (settings: ProtectionSettings): ProtectionForm => ({
  mode: settings.mode,
  values: Object.fromEntries(NUMERIC_FIELDS.map((field) => [field, String(settings[field])])) as Record<NumericField, string>,
})

export function parseForm(form: ProtectionForm): { ok: true; settings: ProtectionSettings } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {}
  const settings: ProtectionSettings = { ...PROTECTION_DEFAULTS, mode: form.mode }
  for (const field of NUMERIC_FIELDS) {
    const text = form.values[field].trim()
    const value = text === "" ? Number.NaN : Number(text)
    const [min, max] = PROTECTION_LIMITS[field]
    if (!Number.isFinite(value)) errors[field] = "number"
    else if (INTEGER_FIELDS.has(field) && !Number.isInteger(value)) errors[field] = "integer"
    else if (value < min || value > max) errors[field] = "range"
    else settings[field] = value
  }
  if (!errors.cooldownMinutes && !errors.maxCooldownMinutes && settings.maxCooldownMinutes < settings.cooldownMinutes) errors.maxCooldownMinutes = "order"
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, settings }
}

/** Defaults for every threshold; the chosen mode stays. */
export const resetToDefaults = (form: ProtectionForm): ProtectionForm => ({ ...toForm(PROTECTION_DEFAULTS), mode: form.mode })

export function isDirty(form: ProtectionForm, saved: ProtectionSettings): boolean {
  const base = toForm(saved)
  return base.mode !== form.mode || NUMERIC_FIELDS.some((field) => base.values[field] !== form.values[field].trim())
}
```

```ts
// apps/dashboard/src/tabs/upstreams/protection/error-chart.ts
import { ERROR_CLASS_KEYS, type ErrorBucketRow, type ErrorClassKey } from "../../../api/protection"
import { formatClockMs, hourShort } from "../../telemetry/telemetry-format"

export type ErrorRange = "1h" | "24h" | "7d" | "30d"
export type ErrorBucketSize = "minute" | "hour"
export const ERROR_RANGES: Record<ErrorRange, { seconds: number; bucket: ErrorBucketSize }> = {
  "1h": { seconds: 3600, bucket: "minute" },
  "24h": { seconds: 86_400, bucket: "hour" },
  "7d": { seconds: 604_800, bucket: "hour" },
  "30d": { seconds: 2_592_000, bucket: "hour" },
}
const bucketSeconds = (bucket: ErrorBucketSize): number => (bucket === "minute" ? 60 : 3600)

export interface ErrorWindow { from: number; to: number; bucket: ErrorBucketSize }

/** Unix seconds, ending at the end of the current bucket so the open bucket is included. */
export function rangeWindow(range: ErrorRange, nowMs: number): ErrorWindow {
  const { seconds, bucket } = ERROR_RANGES[range]
  const step = bucketSeconds(bucket)
  const to = (Math.floor(nowMs / 1000 / step) + 1) * step
  return { from: to - seconds, to, bucket }
}

/** One row per bucket in `[from, to)`; the server only returns buckets that have requests. */
export function fillBuckets(rows: readonly ErrorBucketRow[], from: number, to: number, step: number): ErrorBucketRow[] {
  const byTime = new Map(rows.map((row) => [row.t, row]))
  const out: ErrorBucketRow[] = []
  for (let t = from; t < to; t += step) {
    out.push(byTime.get(t) ?? { t, requests: 0, rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 })
  }
  return out
}

/** Risky classes are warm (amber, rose, red); the others are warm-neutral or grey; the requests line is the brand blue. */
export function classColors(dark: boolean): Record<ErrorClassKey | "requests", string> {
  return dark
    ? { rate_limited: "#F0B050", rejected: "#F07898", auth: "#F2705F", upstream: "#C19A78", network: "#A3A8B0", other: "#CFC8BB", requests: "#7B90FF" }
    : { rate_limited: "#D88A2E", rejected: "#C85878", auth: "#B83A2B", upstream: "#8A6A4F", network: "#7A7F87", other: "#B8B2A7", requests: "#4E6CF5" }
}

export interface ErrorChartModel {
  labels: string[]
  /** Only classes that occurred, in the order risky first. */
  bars: Array<{ key: ErrorClassKey; label: string; data: number[] }>
  requests: number[]
  hasData: boolean
}

export function errorChartModel(rows: readonly ErrorBucketRow[], window: ErrorWindow, classLabel: (key: ErrorClassKey) => string): ErrorChartModel {
  const filled = fillBuckets(rows, window.from, window.to, bucketSeconds(window.bucket))
  const labels = filled.map((row) => (window.bucket === "minute" ? formatClockMs(row.t * 1000) : hourShort(new Date(row.t * 1000).toISOString())))
  const bars = ERROR_CLASS_KEYS
    .map((key) => ({ key, label: classLabel(key), data: filled.map((row) => row[key]) }))
    .filter((bar) => bar.data.some((value) => value > 0))
  const requests = filled.map((row) => row.requests)
  return { labels, bars, requests, hasData: requests.some((value) => value > 0) }
}
```

`TimeSeriesChart.tsx`: change `function isDarkTheme()` and `function cssVar(name: string)` to `export function ...` (no other change).

```tsx
// apps/dashboard/src/tabs/upstreams/protection/ErrorBarChart.tsx
import { useEffect, useRef, useState } from "react"
import { BarController, BarElement, CategoryScale, Chart, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip, type ChartConfiguration } from "chart.js"
import { chartFont, cssVar, isDarkTheme } from "../../../components/TimeSeriesChart"
import { classColors } from "./error-chart"
import type { ErrorClassKey } from "../../../api/protection"

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Legend, Tooltip)

interface Props {
  labels: string[]
  /** Stacked bars, one per error class that occurred. */
  bars: Array<{ key: ErrorClassKey; label: string; data: number[] }>
  /** The line over the bars: every request, whatever its outcome. */
  requests: { label: string; data: number[] }
  height?: number
  yTitle?: string
}

/** Stacked error counts per bucket with the request count as a line. Rebuilt on data or theme change. */
export function ErrorBarChart({ labels, bars, requests, height = 260, yTitle }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [themeTick, setThemeTick] = useState(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dark = isDarkTheme()
    const colors = classColors(dark)
    const tick = cssVar("--tick-color") || (dark ? "#9ca3af" : "#4b5563")
    const grid = cssVar("--grid-color") || (dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)")
    const css = getComputedStyle(document.documentElement)
    const read = (name: string) => css.getPropertyValue(name)
    const sans = chartFont(read, "sans")
    const mono = chartFont(read, "mono")
    const config = {
      type: "bar",
      data: {
        labels,
        datasets: [
          ...bars.map((bar) => ({ type: "bar" as const, label: bar.label, data: bar.data, backgroundColor: colors[bar.key], stack: "errors", borderWidth: 0 })),
          { type: "line" as const, label: requests.label, data: requests.data, borderColor: colors.requests, backgroundColor: colors.requests, borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, tension: 0.25, fill: false },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: true, labels: { color: tick, font: { family: sans, size: 12 } } } },
        scales: {
          x: { stacked: true, ticks: { color: tick, font: { family: sans, size: 12 }, maxRotation: 0, autoSkip: true }, grid: { display: false } },
          y: {
            stacked: true, beginAtZero: true,
            ticks: { color: tick, font: { family: mono, size: 12 }, precision: 0 },
            grid: { color: grid },
            title: yTitle ? { display: true, text: yTitle, color: tick, font: { family: sans, size: 12 } } : { display: false },
          },
        },
      },
    } as unknown as ChartConfiguration
    const chart = new Chart(canvas, config)
    return () => chart.destroy()
  }, [labels, bars, requests, yTitle, themeTick])

  useEffect(() => {
    const handler = () => setThemeTick((n) => n + 1)
    window.addEventListener("theme-changed", handler)
    return () => window.removeEventListener("theme-changed", handler)
  }, [])

  return <div style={{ height, width: "100%", position: "relative" }}><canvas ref={canvasRef} /></div>
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/dashboard/src packages/gateway/tests/protection-defaults-parity.test.ts`
Expected: PASS. Typecheck both packages; eslint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src packages/gateway/tests/protection-defaults-parity.test.ts
git commit -m "feat(dashboard): protection form model, chart data shaping and stacked error chart" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 20: Upstream page: Protection section (settings form, error chart, samples, history), EN and ZH

**Files:**
- Create: `apps/dashboard/src/tabs/upstreams/protection/ProtectionSettingsForm.tsx`, `ProtectionSettingsForm.test.tsx`
- Create: `apps/dashboard/src/tabs/upstreams/protection/ErrorSamplesTable.tsx`, `PauseHistoryTable.tsx`, `tables.test.tsx`
- Create: `apps/dashboard/src/tabs/upstreams/protection/use-protection-data.ts`, `ProtectionSection.tsx`
- Create: `apps/dashboard/src/tabs/upstreams/UpstreamRow.protection.test.tsx`
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx` (Props L32-L58, name row L151-L166, buttons near L282-L291)
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx` (imports; state L58; row props near L315-L317; panels near L345-L356)
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (EN after the Task 18 block, ZH likewise)

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/dashboard/src/tabs/upstreams/protection/ProtectionSettingsForm.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { installDictionary } from "../../../state/i18n-fixture"
import { ProtectionFields } from "./ProtectionSettingsForm"
import { PROTECTION_DEFAULTS, toForm } from "./protection-form"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())

const render = (over: Partial<Parameters<typeof ProtectionFields>[0]> = {}) =>
  renderToStaticMarkup(<ProtectionFields form={toForm(PROTECTION_DEFAULTS)} errors={{}} dirty={false} saving={false} disabled={false} onMode={() => {}} onValue={() => {}} onReset={() => {}} onSave={() => {}} {...over} />)

test("the mode selector and every threshold are shown with their default and allowed range", () => {
  const html = render()
  for (const text of ["Off", "Warn only", "Warn and pause", "Window (minutes)", "Minimum risky errors", "Minimum failure ratio", "Authentication burst", "Key attribution share", "Cooldown (minutes)", "Maximum cooldown (minutes)"]) {
    expect(html, text).toContain(text)
  }
  expect(html).toContain("Default 5, allowed 1 to 60.")
  expect(html).toContain("Default 0.5, allowed 0 to 1.")
  expect(html).toContain("Default 360, allowed 1 to 10080.")
})

test("a field error replaces its hint, and Save is disabled while the form has errors, is unchanged, or is saving", () => {
  const withError = render({ errors: { windowMinutes: "range", maxCooldownMinutes: "order" } })
  expect(withError).toContain("Must be between 1 and 60.")
  expect(withError).toContain("Must not be below the cooldown.")
  expect(withError).not.toContain("Default 5, allowed 1 to 60.")
  const save = (html: string) => html.match(/<button[^>]*>Save protection settings<\/button>/)?.[0] ?? ""
  // `disabled=""` is the attribute; the class list also contains Tailwind's `disabled:` variants, so match the attribute exactly.
  expect(save(render({ dirty: true }))).not.toContain('disabled=""')
  expect(save(render({ dirty: false }))).toContain('disabled=""')
  expect(save(render({ dirty: true, errors: { authBurst: "number" } }))).toContain('disabled=""')
  expect(save(render({ dirty: true, saving: true }))).toContain('disabled=""')
  expect(save(render({ dirty: true, disabled: true }))).toContain('disabled=""')
})
```

```tsx
// apps/dashboard/src/tabs/upstreams/protection/tables.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ErrorSample, ProtectionPause } from "../../../api/protection"
import { installDictionary } from "../../../state/i18n-fixture"
import { setDisplayZone } from "../../telemetry/telemetry-format"
import { ErrorSamplesTable } from "./ErrorSamplesTable"
import { PauseHistoryTable } from "./PauseHistoryTable"

let restore: () => void = () => {}
beforeEach(() => { setDisplayZone("UTC"); restore = installDictionary("en") })
afterEach(() => { restore(); setDisplayZone(null) })

const AT = Date.UTC(2026, 10, 17, 18, 5)
const sample = (over: Partial<ErrorSample> = {}): ErrorSample =>
  ({ upstreamId: "up_a", status: 429, at: AT, keyId: "key_abcdefghijkl", model: "gpt-x", code: "rate_limit_exceeded", message: "Slow down", ...over })

test("samples show status, code, message, local time, key and model; network failures read Network", () => {
  const html = renderToStaticMarkup(<ErrorSamplesTable samples={[sample(), sample({ status: 0, code: "", message: "TypeError", keyId: "" })]} />)
  for (const text of ["Status", "Code", "Message", "Time", "Key", "Model", "429", "rate_limit_exceeded", "Slow down", "2026-11-17 18:05", "key_abcd", "gpt-x", "Network", "TypeError"]) expect(html, text).toContain(text)
  expect(html).toContain('title="key_abcdefghijkl"')
  expect(renderToStaticMarkup(<ErrorSamplesTable samples={[]} />)).toContain("No errors recorded for this upstream.")
})

test("messages are rendered as text, never as markup", () => {
  const html = renderToStaticMarkup(<ErrorSamplesTable samples={[sample({ message: '<img src=x onerror=alert(1)>' })]} />)
  expect(html).not.toContain("<img")
  expect(html).toContain("&lt;img")
})

const pause = (over: Partial<ProtectionPause> = {}): ProtectionPause => ({
  id: "pp_" + "1".repeat(32), targetKind: "upstream", targetId: "up_a", targetName: "Copilot A", upstreamId: "up_a", upstreamName: "Copilot A", mode: "pause",
  reason: { windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: null },
  startedAt: AT, endsAt: AT + 30 * 60_000, resolvedAt: null, endedBy: "auto", ...over,
})

test("history shows target, reason, start, end and how each ended", () => {
  const html = renderToStaticMarkup(<PauseHistoryTable pauses={[
    pause(),
    pause({ id: "pp_" + "2".repeat(32), targetKind: "key", targetName: "CI key", endedBy: "owner", resolvedAt: AT + 60_000 }),
    pause({ id: "pp_" + "3".repeat(32), mode: "notify", endedBy: null }),
  ]} />)
  for (const text of ["Target", "Reason", "Started", "Ends / ended", "How it ended", "Upstream", "Copilot A", "API key", "CI key", "46 rate-limit errors in 5 min (92% of requests)",
    "2026-11-17 18:05", "2026-11-17 18:35", "2026-11-17 18:06", "Cooldown ended", "Resumed by owner", "Active", "Warning", "Pause"]) expect(html, text).toContain(text)
  expect(renderToStaticMarkup(<PauseHistoryTable pauses={[]} />)).toContain("No pauses or warnings yet.")
})
```

```tsx
// apps/dashboard/src/tabs/upstreams/UpstreamRow.protection.test.tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProtectionPause } from "../../api/protection"
import type { UpstreamRecord } from "../../api/types"
import { ToastProvider } from "../../state/toast"
import { UpstreamRow } from "./UpstreamRow"

const noop = () => {}
const row: UpstreamRecord = { id: "up_custom", provider: "custom", name: "Custom", enabled: true, sortOrder: 0, config: {}, disabledPublicModelIds: [], createdAt: "", updatedAt: "", syncable: true }
const pause = (mode: "pause" | "notify"): ProtectionPause => ({ id: "pp_" + "1".repeat(32), targetKind: "upstream", targetId: "up_custom", targetName: "Custom", upstreamId: "up_custom", upstreamName: "Custom", mode,
  reason: { windowMinutes: 5, requests: 1, risky: 1, counts: { rate_limited: 1, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 1, topKeys: [], trigger: "ratio", keyShare: null },
  startedAt: 0, endsAt: 1, resolvedAt: null, endedBy: null })
const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(<ToastProvider><UpstreamRow row={row} index={0} total={1} busy={false} models={[]}
  onToggleEnabled={noop} onReorder={noop} onEdit={noop} onDuplicate={noop} onRefreshModels={noop} onRefreshCredential={noop} onReauth={noop} onDelete={noop} {...extra} /></ToastProvider>)

test("the Protection button appears only when asked for, and toggles to Close while open", () => {
  expect(render()).not.toContain("dash.protButton")
  expect(render({ showProtection: true, onToggleProtection: noop })).toContain("dash.protButton")
  expect(render({ showProtection: true, protectionOpen: true, onToggleProtection: noop })).not.toContain("dash.protButton")
})

test("an active pause or warning on the upstream shows a badge", () => {
  expect(render({ pause: pause("pause") })).toContain("dash.protPausedBadge")
  expect(render({ pause: pause("notify") })).toContain("dash.protWarningBadge")
  expect(render()).not.toContain("dash.protPausedBadge")
})
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test apps/dashboard/src/tabs/upstreams`
Expected: FAIL (modules missing; the row ignores the new props).

- [ ] **Step 3: Add the i18n keys**

Insert after the Task 18 keys (EN block, then ZH block; six-space indent). English:

```
      "dash.protTitle": "Upstream protection",
      "dash.protButton": "Protection",
      "dash.protIntro": "Error statistics are always recorded. Protection watches for floods of rate-limit, rejected and authentication errors, and can warn you or pause the upstream (or the one API key causing them) for a cooldown.",
      "dash.protState": "Current state",
      "dash.protStateNormal": "Normal: no pause or warning is active.",
      "dash.protMode": "Mode",
      "dash.protModeOff": "Off",
      "dash.protModeNotify": "Warn only",
      "dash.protModePause": "Warn and pause",
      "dash.protModeHint": "Off records statistics only. Warn only shows a banner. Warn and pause also blocks the culprit until the cooldown ends.",
      "dash.protWindowMinutes": "Window (minutes)",
      "dash.protWindowMinutesHelp": "Errors are counted over this many whole minutes, including the current one.",
      "dash.protMinRiskyErrors": "Minimum risky errors",
      "dash.protMinRiskyErrorsHelp": "Rate-limit, rejected and authentication errors needed in the window to trigger.",
      "dash.protMinFailureRatio": "Minimum failure ratio",
      "dash.protMinFailureRatioHelp": "Risky errors divided by all requests in the window (0 to 1).",
      "dash.protAuthBurst": "Authentication burst",
      "dash.protAuthBurstHelp": "This many authentication errors alone trigger. 0 turns this rule off.",
      "dash.protKeyShare": "Key attribution share",
      "dash.protKeyShareHelp": "A key causing at least this share of the risky errors is paused instead of the upstream.",
      "dash.protCooldownMinutes": "Cooldown (minutes)",
      "dash.protCooldownMinutesHelp": "How long a pause or warning lasts. It doubles for each earlier one on the same target within 24 hours.",
      "dash.protMaxCooldownMinutes": "Maximum cooldown (minutes)",
      "dash.protMaxCooldownMinutesHelp": "The doubling stops here.",
      "dash.protFieldRange": "Default {value}, allowed {min} to {max}.",
      "dash.protErrNumber": "Enter a number.",
      "dash.protErrInteger": "Enter a whole number.",
      "dash.protErrRange": "Must be between {min} and {max}.",
      "dash.protErrOrder": "Must not be below the cooldown.",
      "dash.protSave": "Save protection settings",
      "dash.protReset": "Reset thresholds to defaults",
      "dash.protSaved": "Protection settings saved.",
      "dash.protSaveFailed": "Could not save protection settings.",
      "dash.protChartTitle": "Upstream responses",
      "dash.protRangeLabel": "Time range",
      "dash.protRange1h": "1 hour",
      "dash.protRequests": "Requests",
      "dash.protAxisCount": "Responses per bucket",
      "dash.protChartEmpty": "No requests reached this upstream in this period.",
      "dash.protTimesIn": "Times are shown in {zone}.",
      "dash.protRefresh": "Refresh",
      "dash.protClassRateLimited": "Rate limited (429)",
      "dash.protClassRejected": "Rejected (400, 404, 409, 413, 422)",
      "dash.protClassAuth": "Authentication (401, 403)",
      "dash.protClassUpstream": "Server error (5xx)",
      "dash.protClassNetwork": "Network failure",
      "dash.protClassOther": "Other",
      "dash.protSamplesTitle": "Latest error samples",
      "dash.protSamplesEmpty": "No errors recorded for this upstream.",
      "dash.protColStatus": "Status",
      "dash.protColCode": "Code",
      "dash.protColMessage": "Message",
      "dash.protColTime": "Time",
      "dash.protColKey": "Key",
      "dash.protColModel": "Model",
      "dash.protNetwork": "Network",
      "dash.protHistoryTitle": "Pause history",
      "dash.protHistoryEmpty": "No pauses or warnings yet.",
      "dash.protColTarget": "Target",
      "dash.protColReason": "Reason",
      "dash.protColStarted": "Started",
      "dash.protColEnded": "Ends / ended",
      "dash.protColHow": "How it ended",
      "dash.protTargetUpstream": "Upstream",
      "dash.protTargetKey": "API key",
      "dash.protRowPause": "Pause",
      "dash.protRowWarning": "Warning",
      "dash.protEndedAuto": "Cooldown ended",
      "dash.protEndedOwner": "Resumed by owner",
      "dash.protEndedActive": "Active",
      "dash.protLoadFailed": "Could not load protection data.",
      "dash.protPausedBadge": "Paused",
      "dash.protWarningBadge": "Error flood",
```

Chinese:

```
      "dash.protTitle": "上游保护",
      "dash.protButton": "保护",
      "dash.protIntro": "错误统计始终记录。保护功能会监测限流、被拒绝和认证错误的洪峰，并可提醒你，或在冷却期内暂停该上游（或造成错误的那个 API 密钥）。",
      "dash.protState": "当前状态",
      "dash.protStateNormal": "正常：当前没有暂停或警告。",
      "dash.protMode": "模式",
      "dash.protModeOff": "关闭",
      "dash.protModeNotify": "仅提醒",
      "dash.protModePause": "提醒并暂停",
      "dash.protModeHint": "关闭仅记录统计；仅提醒会显示横幅；提醒并暂停还会在冷却结束前阻断肇事方。",
      "dash.protWindowMinutes": "统计窗口（分钟）",
      "dash.protWindowMinutesHelp": "在这么多个完整分钟（含当前分钟）内统计错误。",
      "dash.protMinRiskyErrors": "最少风险错误数",
      "dash.protMinRiskyErrorsHelp": "窗口内触发所需的限流、被拒绝和认证错误总数。",
      "dash.protMinFailureRatio": "最低失败比例",
      "dash.protMinFailureRatioHelp": "窗口内风险错误数除以全部请求数（0 到 1）。",
      "dash.protAuthBurst": "认证错误突发",
      "dash.protAuthBurstHelp": "仅认证错误达到此数量即触发。0 表示关闭此规则。",
      "dash.protKeyShare": "密钥归因比例",
      "dash.protKeyShareHelp": "某个密钥造成的风险错误占比达到此值时，暂停该密钥而不是整个上游。",
      "dash.protCooldownMinutes": "冷却时间（分钟）",
      "dash.protCooldownMinutesHelp": "暂停或警告持续的时间。24 小时内同一目标每多一次就翻倍。",
      "dash.protMaxCooldownMinutes": "最长冷却时间（分钟）",
      "dash.protMaxCooldownMinutesHelp": "翻倍到此为止。",
      "dash.protFieldRange": "默认 {value}，允许 {min} 到 {max}。",
      "dash.protErrNumber": "请输入数字。",
      "dash.protErrInteger": "请输入整数。",
      "dash.protErrRange": "必须在 {min} 到 {max} 之间。",
      "dash.protErrOrder": "不能小于冷却时间。",
      "dash.protSave": "保存保护设置",
      "dash.protReset": "阈值恢复默认",
      "dash.protSaved": "保护设置已保存。",
      "dash.protSaveFailed": "无法保存保护设置。",
      "dash.protChartTitle": "上游响应",
      "dash.protRangeLabel": "时间范围",
      "dash.protRange1h": "1 小时",
      "dash.protRequests": "请求数",
      "dash.protAxisCount": "每个时间段的响应数",
      "dash.protChartEmpty": "此时间段内没有请求到达该上游。",
      "dash.protTimesIn": "时间按 {zone} 显示。",
      "dash.protRefresh": "刷新",
      "dash.protClassRateLimited": "限流（429）",
      "dash.protClassRejected": "被拒绝（400、404、409、413、422）",
      "dash.protClassAuth": "认证（401、403）",
      "dash.protClassUpstream": "服务端错误（5xx）",
      "dash.protClassNetwork": "网络故障",
      "dash.protClassOther": "其他",
      "dash.protSamplesTitle": "最近的错误样本",
      "dash.protSamplesEmpty": "该上游没有记录到错误。",
      "dash.protColStatus": "状态码",
      "dash.protColCode": "错误码",
      "dash.protColMessage": "信息",
      "dash.protColTime": "时间",
      "dash.protColKey": "密钥",
      "dash.protColModel": "模型",
      "dash.protNetwork": "网络",
      "dash.protHistoryTitle": "暂停历史",
      "dash.protHistoryEmpty": "还没有暂停或警告。",
      "dash.protColTarget": "目标",
      "dash.protColReason": "原因",
      "dash.protColStarted": "开始",
      "dash.protColEnded": "结束 / 已结束",
      "dash.protColHow": "结束方式",
      "dash.protTargetUpstream": "上游",
      "dash.protTargetKey": "API 密钥",
      "dash.protRowPause": "暂停",
      "dash.protRowWarning": "警告",
      "dash.protEndedAuto": "冷却结束",
      "dash.protEndedOwner": "所有者恢复",
      "dash.protEndedActive": "进行中",
      "dash.protLoadFailed": "无法加载保护数据。",
      "dash.protPausedBadge": "已暂停",
      "dash.protWarningBadge": "错误洪峰",
```

- [ ] **Step 4: Implement the components**

```tsx
// apps/dashboard/src/tabs/upstreams/protection/ProtectionSettingsForm.tsx
import { useEffect, useState } from "react"
import type { ProtectionMode, ProtectionSettings } from "../../../api/protection"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { SegmentedControl, type SegmentedOption } from "../../../ui/segmented-control"
import { Field } from "../form/Field"
import {
  NUMERIC_FIELDS, PROTECTION_DEFAULTS, PROTECTION_LIMITS, isDirty, parseForm, resetToDefaults, toForm,
  type FieldErrorKind, type FieldErrors, type NumericField, type ProtectionForm,
} from "./protection-form"

type Translate = (key: string, vars?: Record<string, string | number>) => string

const fieldTexts = (t: Translate): Record<NumericField, { label: string; help: string }> => ({
  windowMinutes: { label: t("dash.protWindowMinutes"), help: t("dash.protWindowMinutesHelp") },
  minRiskyErrors: { label: t("dash.protMinRiskyErrors"), help: t("dash.protMinRiskyErrorsHelp") },
  minFailureRatio: { label: t("dash.protMinFailureRatio"), help: t("dash.protMinFailureRatioHelp") },
  authBurst: { label: t("dash.protAuthBurst"), help: t("dash.protAuthBurstHelp") },
  keyShare: { label: t("dash.protKeyShare"), help: t("dash.protKeyShareHelp") },
  cooldownMinutes: { label: t("dash.protCooldownMinutes"), help: t("dash.protCooldownMinutesHelp") },
  maxCooldownMinutes: { label: t("dash.protMaxCooldownMinutes"), help: t("dash.protMaxCooldownMinutesHelp") },
})

function errorText(t: Translate, field: NumericField, kind: FieldErrorKind): string {
  const [min, max] = PROTECTION_LIMITS[field]
  if (kind === "number") return t("dash.protErrNumber")
  if (kind === "integer") return t("dash.protErrInteger")
  if (kind === "order") return t("dash.protErrOrder")
  return t("dash.protErrRange", { min, max })
}

interface FieldsProps {
  form: ProtectionForm
  errors: FieldErrors
  dirty: boolean
  saving: boolean
  disabled: boolean
  onMode: (mode: ProtectionMode) => void
  onValue: (field: NumericField, value: string) => void
  onReset: () => void
  onSave: () => void
}

/** The presentational form: mode selector, one input per threshold with its default and range, Save and Reset. */
export function ProtectionFields({ form, errors, dirty, saving, disabled, onMode, onValue, onReset, onSave }: FieldsProps) {
  const t = useT()
  const texts = fieldTexts(t)
  const modes: Array<SegmentedOption<ProtectionMode>> = [
    { value: "off", label: t("dash.protModeOff") }, { value: "notify", label: t("dash.protModeNotify") }, { value: "pause", label: t("dash.protModePause") },
  ]
  const blocked = disabled || saving || !dirty || Object.keys(errors).length > 0
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs font-medium text-fg-muted">{t("dash.protMode")}</div>
        <SegmentedControl options={modes} value={form.mode} onChange={onMode} ariaLabel={t("dash.protMode")} size="sm" disabled={disabled || saving} />
        <p className="mt-1 text-xs text-fg-subtle">{t("dash.protModeHint")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {NUMERIC_FIELDS.map((field) => {
          const [min, max] = PROTECTION_LIMITS[field]
          const kind = errors[field]
          return (
            <Field key={field} label={texts[field].label}
              hint={<>{texts[field].help} {t("dash.protFieldRange", { value: PROTECTION_DEFAULTS[field], min, max })}</>}
              error={kind ? errorText(t, field, kind) : undefined}>
              {({ id, describedBy }) => (
                <input id={id} type="number" inputMode="decimal" step="any" value={form.values[field]} disabled={disabled || saving}
                  aria-describedby={describedBy} aria-invalid={kind ? true : undefined} onChange={(event) => onValue(field, event.target.value)} />
              )}
            </Field>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={blocked} onClick={onSave}>{t("dash.protSave")}</Button>
        <Button variant="ghost" size="sm" disabled={disabled || saving} onClick={onReset}>{t("dash.protReset")}</Button>
      </div>
    </div>
  )
}

interface Props {
  saved: ProtectionSettings
  saving: boolean
  disabled?: boolean
  onSave: (settings: ProtectionSettings) => void
}

export function ProtectionSettingsForm({ saved, saving, disabled = false, onSave }: Props) {
  const [form, setForm] = useState(() => toForm(saved))
  useEffect(() => { setForm(toForm(saved)) }, [saved])
  const parsed = parseForm(form)
  return (
    <ProtectionFields form={form} errors={parsed.ok ? {} : parsed.errors} dirty={isDirty(form, saved)} saving={saving} disabled={disabled}
      onMode={(mode) => setForm((current) => ({ ...current, mode }))}
      onValue={(field, value) => setForm((current) => ({ ...current, values: { ...current.values, [field]: value } }))}
      onReset={() => setForm((current) => resetToDefaults(current))}
      onSave={() => { if (parsed.ok) onSave(parsed.settings) }} />
  )
}
```

```tsx
// apps/dashboard/src/tabs/upstreams/protection/ErrorSamplesTable.tsx
import type { ErrorSample } from "../../../api/protection"
import { useT } from "../../../state/i18n"
import { Table, TBody, Td, Th } from "../../../ui/table"
import { formatInstantMs } from "../../telemetry/telemetry-format"

/** Latest samples per status, newest first within a status. React escapes the upstream's message: it is shown as text. */
export function ErrorSamplesTable({ samples }: { samples: readonly ErrorSample[] }) {
  const t = useT()
  if (samples.length === 0) return <p className="text-body text-fg-subtle">{t("dash.protSamplesEmpty")}</p>
  return (
    <Table label={t("dash.protSamplesTitle")}>
      <thead>
        <tr>
          <Th>{t("dash.protColStatus")}</Th><Th>{t("dash.protColCode")}</Th><Th>{t("dash.protColMessage")}</Th>
          <Th>{t("dash.protColTime")}</Th><Th>{t("dash.protColKey")}</Th><Th>{t("dash.protColModel")}</Th>
        </tr>
      </thead>
      <TBody>
        {samples.map((sample, index) => (
          <tr key={`${sample.status}-${sample.at}-${index}`}>
            <Td className="tabular-nums">{sample.status === 0 ? t("dash.protNetwork") : sample.status}</Td>
            <Td className="font-mono text-xs">{sample.code}</Td>
            <Td className="max-w-md break-words">{sample.message}</Td>
            <Td className="whitespace-nowrap tabular-nums">{formatInstantMs(sample.at)}</Td>
            <Td className="font-mono text-xs"><span title={sample.keyId}>{sample.keyId === "" ? "—" : sample.keyId.slice(0, 8)}</span></Td>
            <Td className="font-mono text-xs">{sample.model}</Td>
          </tr>
        ))}
      </TBody>
    </Table>
  )
}
```

```tsx
// apps/dashboard/src/tabs/upstreams/protection/PauseHistoryTable.tsx
import { summarizeReason } from "../../../components/protection-banner-model"
import type { ProtectionPause } from "../../../api/protection"
import { useT } from "../../../state/i18n"
import { Badge } from "../../../ui/badge"
import { Table, TBody, Td, Th } from "../../../ui/table"
import { formatInstantMs } from "../../telemetry/telemetry-format"

/** Newest first: target, reason summary, start, end (the scheduled end while active) and how it ended. */
export function PauseHistoryTable({ pauses }: { pauses: readonly ProtectionPause[] }) {
  const t = useT()
  if (pauses.length === 0) return <p className="text-body text-fg-subtle">{t("dash.protHistoryEmpty")}</p>
  const how = (pause: ProtectionPause) => pause.endedBy === "owner" ? t("dash.protEndedOwner") : pause.endedBy === "auto" ? t("dash.protEndedAuto") : t("dash.protEndedActive")
  return (
    <Table label={t("dash.protHistoryTitle")}>
      <thead>
        <tr>
          <Th>{t("dash.protColTarget")}</Th><Th>{t("dash.protColReason")}</Th><Th>{t("dash.protColStarted")}</Th><Th>{t("dash.protColEnded")}</Th><Th>{t("dash.protColHow")}</Th>
        </tr>
      </thead>
      <TBody>
        {pauses.map((pause) => (
          <tr key={pause.id}>
            <Td>
              <div className="flex flex-wrap items-center gap-1">
                <Badge tone={pause.mode === "pause" ? "danger" : "warn"}>{pause.mode === "pause" ? t("dash.protRowPause") : t("dash.protRowWarning")}</Badge>
                <span className="text-fg-muted">{pause.targetKind === "key" ? t("dash.protTargetKey") : t("dash.protTargetUpstream")}</span>
                <span className="font-medium">{pause.targetName}</span>
              </div>
            </Td>
            <Td>{summarizeReason(pause.reason, t)}</Td>
            <Td className="whitespace-nowrap tabular-nums">{formatInstantMs(pause.startedAt)}</Td>
            <Td className="whitespace-nowrap tabular-nums">{formatInstantMs(pause.endedBy === "owner" && pause.resolvedAt !== null ? pause.resolvedAt : pause.endsAt)}</Td>
            <Td>{how(pause)}</Td>
          </tr>
        ))}
      </TBody>
    </Table>
  )
}
```

(`Td` is exported from `ui/table` and used by `KeyRow`; `Badge` from `ui/badge`.)

```ts
// apps/dashboard/src/tabs/upstreams/protection/use-protection-data.ts
import { useEffect, useState } from "react"
import { getErrorSamples, getErrorSeries, getPauseHistory, type ErrorBucketRow, type ErrorSample, type ProtectionPause } from "../../../api/protection"
import { rangeWindow, type ErrorRange, type ErrorWindow } from "./error-chart"

export interface ProtectionData {
  window: ErrorWindow | null
  buckets: ErrorBucketRow[]
  samples: ErrorSample[]
  history: ProtectionPause[]
  loading: boolean
  failed: boolean
}

const INITIAL: ProtectionData = { window: null, buckets: [], samples: [], history: [], loading: true, failed: false }

/** Loads the error series for `range`, the samples and the history; reloads when `reloadTick` changes. */
export function useProtectionData(upstreamId: string, range: ErrorRange, reloadTick: number): ProtectionData {
  const [state, setState] = useState<ProtectionData>(INITIAL)
  useEffect(() => {
    let cancelled = false
    const window = rangeWindow(range, Date.now())
    setState((current) => ({ ...current, loading: true, failed: false }))
    Promise.all([getErrorSeries(upstreamId, window), getErrorSamples(upstreamId), getPauseHistory(upstreamId)])
      .then(([series, samples, history]) => {
        if (!cancelled) setState({ window, buckets: series.buckets, samples: samples.samples, history: history.pauses, loading: false, failed: false })
      })
      .catch(() => { if (!cancelled) setState((current) => ({ ...current, loading: false, failed: true })) })
    return () => { cancelled = true }
  }, [upstreamId, range, reloadTick])
  return state
}
```

```tsx
// apps/dashboard/src/tabs/upstreams/protection/ProtectionSection.tsx
import { useMemo, useState } from "react"
import { bannerItems } from "../../../components/protection-banner-model"
import type { ErrorClassKey, ProtectionSettings } from "../../../api/protection"
import type { UpstreamRecord } from "../../../api/types"
import { patchUpstream } from "../../../api/upstreams"
import { useT } from "../../../state/i18n"
import { useProtection } from "../../../state/protection"
import { useToast } from "../../../state/toast"
import { Button } from "../../../ui/button"
import { SectionHeading } from "../../../ui/card"
import { Notice } from "../../../ui/notice"
import { SegmentedControl, type SegmentedOption } from "../../../ui/segmented-control"
import { zoneLabel } from "../../telemetry/telemetry-format"
import { ErrorBarChart } from "./ErrorBarChart"
import { ErrorSamplesTable } from "./ErrorSamplesTable"
import { PauseHistoryTable } from "./PauseHistoryTable"
import { ProtectionSettingsForm } from "./ProtectionSettingsForm"
import { errorChartModel, type ErrorRange } from "./error-chart"
import { PROTECTION_DEFAULTS } from "./protection-form"
import { useProtectionData } from "./use-protection-data"

type Translate = (key: string, vars?: Record<string, string | number>) => string
const classLabel = (t: Translate, key: ErrorClassKey): string => {
  switch (key) {
    case "rate_limited": return t("dash.protClassRateLimited")
    case "rejected": return t("dash.protClassRejected")
    case "auth": return t("dash.protClassAuth")
    case "upstream": return t("dash.protClassUpstream")
    case "network": return t("dash.protClassNetwork")
    case "other": return t("dash.protClassOther")
  }
}

/** Per-upstream protection: current state, settings, the error chart, samples and history. Mounted only while open. */
export function ProtectionSection({ upstream, onSaved }: { upstream: UpstreamRecord; onSaved: () => void }) {
  const t = useT()
  const { push: toast } = useToast()
  const store = useProtection()
  const [range, setRange] = useState<ErrorRange>("24h")
  const [reloadTick, setReloadTick] = useState(0)
  const [saving, setSaving] = useState(false)
  const data = useProtectionData(upstream.id, range, reloadTick)
  const saved: ProtectionSettings = useMemo(() => upstream.protection ?? PROTECTION_DEFAULTS, [upstream.protection])

  // Memoised so the chart is rebuilt only when its data or the language changes, not on every render.
  const model = useMemo(
    () => (data.window ? errorChartModel(data.buckets, data.window, (key) => classLabel(t, key)) : null),
    [data.window, data.buckets, t],
  )
  const requests = useMemo(() => ({ label: t("dash.protRequests"), data: model?.requests ?? [] }), [model, t])
  const active = store.pauses.filter((pause) => pause.upstreamId === upstream.id)
  const states = bannerItems(active, t, Date.now())

  const ranges: Array<SegmentedOption<ErrorRange>> = [
    { value: "1h", label: t("dash.protRange1h") }, { value: "24h", label: t("dash.tlmRange24h") },
    { value: "7d", label: t("dash.tlmRange7d") }, { value: "30d", label: t("dash.tlmRange30d") },
  ]
  const save = async (settings: ProtectionSettings) => {
    setSaving(true)
    try {
      await patchUpstream(upstream.id, { protection: settings })
      toast(t("dash.protSaved"), "success")
      onSaved()
      void store.refresh()
    } catch {
      toast(t("dash.protSaveFailed"), "error")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mt-2 space-y-4 rounded-lg border border-border bg-background p-3 sm:p-4">
      <div>
        <SectionHeading as="h3">{t("dash.protTitle")}</SectionHeading>
        <p className="mt-1 text-xs text-fg-subtle">{t("dash.protIntro")}</p>
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-fg-muted">{t("dash.protState")}</div>
        {states.length === 0 ? <p className="text-body text-fg">{t("dash.protStateNormal")}</p> : (
          <div className="space-y-2">
            {states.map((item) => (
              <Notice key={item.id} tone={item.tone}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>{item.text}</span>
                  {item.canResume ? <Button size="sm" variant="secondary" onClick={() => { void store.resume(item.id).then(() => setReloadTick((n) => n + 1)) }}>{t("dash.protResumeNow")}</Button> : null}
                </div>
              </Notice>
            ))}
          </div>
        )}
      </div>
      <ProtectionSettingsForm saved={saved} saving={saving} onSave={save} />
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeading as="h3">{t("dash.protChartTitle")}</SectionHeading>
          <div className="flex items-center gap-2">
            <SegmentedControl options={ranges} value={range} onChange={setRange} ariaLabel={t("dash.protRangeLabel")} size="sm" />
            <Button variant="ghost" size="sm" onClick={() => setReloadTick((n) => n + 1)}>{t("dash.protRefresh")}</Button>
          </div>
        </div>
        {data.failed ? <Notice tone="danger">{t("dash.protLoadFailed")}</Notice> : null}
        {model && model.hasData ? <ErrorBarChart labels={model.labels} bars={model.bars} requests={requests} yTitle={t("dash.protAxisCount")} />
          : <p className="text-body text-fg-subtle">{data.loading ? t("dash.loadingShort") : t("dash.protChartEmpty")}</p>}
        <p className="text-xs text-fg-subtle">{t("dash.protTimesIn", { zone: zoneLabel(Date.now()) })}</p>
      </div>
      <div className="space-y-2">
        <SectionHeading as="h3">{t("dash.protSamplesTitle")}</SectionHeading>
        <ErrorSamplesTable samples={data.samples} />
      </div>
      <div className="space-y-2">
        <SectionHeading as="h3">{t("dash.protHistoryTitle")}</SectionHeading>
        <PauseHistoryTable pauses={data.history} />
      </div>
    </div>
  )
}
```

`UpstreamRow.tsx`: import `type { ProtectionPause } from "../../api/protection"`; add to `Props`:

```ts
  /** Shows the Protection button (owners and admins). */
  showProtection?: boolean
  protectionOpen?: boolean
  onToggleProtection?: () => void
  /** The active pause or warning about this upstream itself, for the badge. */
  pause?: ProtectionPause
```

destructure them (`showProtection = false, protectionOpen = false, onToggleProtection, pause`); in the name row, after the `expiredAt` badge block add:

```tsx
              {pause ? (
                <Badge tone={pause.mode === "pause" ? "danger" : "warn"}>{pause.mode === "pause" ? t("dash.protPausedBadge") : t("dash.protWarningBadge")}</Badge>
              ) : null}
```

and next to the proxy button (`{showProxy ? (...) : null}`) add:

```tsx
          {showProtection ? (
            <Button variant="ghost" size="sm" onClick={onToggleProtection} aria-expanded={protectionOpen}>
              {protectionOpen ? t("dash.closeBtn") : t("dash.protButton")}
            </Button>
          ) : null}
```

`UpstreamsTab.tsx`: add `import { useProtection } from "../../state/protection"` and `import { ProtectionSection } from "./protection/ProtectionSection"`; next to `const [proxyId, setProxyId]` add:

```tsx
  const protection = useProtection()
  const { focusUpstreamId, clearFocus } = protection
  const [protectionId, setProtectionId] = useState<string | null>(null)
  // The banner's "Protection settings" button asks for one upstream's section to be open.
  useEffect(() => {
    if (focusUpstreamId === null) return
    setProtectionId(focusUpstreamId)
    clearFocus()
  }, [focusUpstreamId, clearFocus])
```

pass to `<UpstreamRow ...>` after `onToggleProxy`:

```tsx
                          showProtection={g.isMine || isAdmin}
                          protectionOpen={protectionId === u.id}
                          onToggleProtection={() => setProtectionId((v) => (v === u.id ? null : u.id))}
                          pause={protection.pauses.find((p) => p.targetKind === "upstream" && p.targetId === u.id)}
```

and after the `proxyId === u.id` block add:

```tsx
                        {protectionId === u.id && (g.isMine || isAdmin) ? (
                          <Expand>
                            <ProtectionSection upstream={u} onSaved={() => { void store.reload() }} />
                          </Expand>
                        ) : null}
```

- [ ] **Step 5: Run the tests**

Run: `bun test apps/dashboard/src packages/gateway/tests/i18n-keys.test.ts packages/gateway/tests/i18n-interpolation.test.ts`
Expected: PASS (the existing `UpstreamRow.synced.test.tsx` still passes: the new props are optional). `type-scale.test.ts` passes (only `text-xs`/`text-body`).

Run: `bun run --filter '@vibe-llm/dashboard' typecheck && bunx eslint apps/dashboard/src`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(dashboard): per-upstream protection section with settings, error chart, samples and history" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```


---

## Task 21: API Keys page: "Paused until …" badge with reason tooltip and Resume

**Files:**
- Modify: `apps/dashboard/src/tabs/keys/KeyRow.tsx` (Props L10-L18, name cell L50-L66, actions L100-L134), `apps/dashboard/src/tabs/keys/KeysTab.tsx` (imports; `<KeyRow>` L93-L105)
- Create: `apps/dashboard/src/tabs/keys/KeyRow.protection.test.tsx`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (EN and ZH, after the Task 20 blocks)

- [ ] **Step 1: Write the failing test**

```tsx
// apps/dashboard/src/tabs/keys/KeyRow.protection.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProtectionPause } from "../../api/protection"
import type { ApiKeyDetail } from "../../api/keys"
import { installDictionary } from "../../state/i18n-fixture"
import { setDisplayZone } from "../telemetry/telemetry-format"
import { KeyRow } from "./KeyRow"

let restore: () => void = () => {}
beforeEach(() => { setDisplayZone("UTC"); restore = installDictionary("en") })
afterEach(() => { restore(); setDisplayZone(null) })

const key = { id: "key_1", name: "CI key", key: "gw_test_placeholder_1", created_at: "2026-11-01T00:00:00Z", last_used_at: null, owner_id: "u1", owner_name: "Owner", is_owner: true, assignees: [] } as unknown as ApiKeyDetail
const pause: ProtectionPause = {
  id: "pp_" + "1".repeat(32), targetKind: "key", targetId: "key_1", targetName: "CI key", upstreamId: "up_a", upstreamName: "Copilot A", mode: "pause",
  reason: { windowMinutes: 5, requests: 50, risky: 46, counts: { rate_limited: 46, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0.92, topKeys: [], trigger: "ratio", keyShare: 1 },
  startedAt: Date.UTC(2026, 10, 17, 12, 0), endsAt: Date.UTC(2026, 10, 17, 18, 40), resolvedAt: null, endedBy: null,
}
const render = (props: Record<string, unknown> = {}) => renderToStaticMarkup(
  <table><tbody><KeyRow row={key} selected={false} canManage busy={false} onSelect={() => {}} onDelete={() => {}} {...props} /></tbody></table>)

test("a paused key shows the badge with the end time and the reason as its tooltip, and a Resume action", () => {
  const html = render({ pause, onResume: () => {} })
  expect(html).toMatch(/Paused until (?:\d{2}-\d{2} )?\d{2}:\d{2}/)
  expect(html).toContain('title="46 rate-limit errors in 5 min (92% of requests) on upstream Copilot A"')
  expect(html).toContain(">Resume<")
})

test("an unpaused key has neither; a shared key shows the badge but not the Resume action", () => {
  const plain = render()
  expect(plain).not.toContain("Paused until")
  expect(plain).not.toContain(">Resume<")
  const shared = render({ pause, onResume: () => {}, row: { ...key, is_owner: false } })
  expect(shared).toContain("Paused until")
  expect(shared).not.toContain(">Resume<")
})
```

- [ ] **Step 2: Run it and see it fail**

Run: `bun test apps/dashboard/src/tabs/keys/KeyRow.protection.test.tsx`
Expected: FAIL (`Paused until` is not rendered).

- [ ] **Step 3: Implement**

i18n keys, English: 

```
      "dash.protKeyPausedBadge": "Paused until {until}",
      "dash.protKeyPausedTip": "{summary} on upstream {upstream}",
      "dash.protResumeKey": "Resume",
```

Chinese:

```
      "dash.protKeyPausedBadge": "已暂停至 {until}",
      "dash.protKeyPausedTip": "{summary}（上游 {upstream}）",
      "dash.protResumeKey": "恢复",
```

`KeyRow.tsx`: add imports

```tsx
import type { ProtectionPause } from "../../api/protection"
import { summarizeReason } from "../../components/protection-banner-model"
import { formatUntil } from "../telemetry/telemetry-format"
```

extend `Props` with:

```ts
  /** The active pause on this key, if any. */
  pause?: ProtectionPause
  onResume?: () => void
```

destructure `pause, onResume`, and in the name cell, right after the name `<button>`, add:

```tsx
          {pause ? (
            <span className="cursor-default" title={t("dash.protKeyPausedTip", { summary: summarizeReason(pause.reason, t), upstream: pause.upstreamName })}>
              <Badge tone="danger">{t("dash.protKeyPausedBadge", { until: formatUntil(pause.endsAt, Date.now()) })}</Badge>
            </span>
          ) : null}
```

and in the actions cell, before the copy button:

```tsx
          {pause && onResume && canManage && !isShared ? (
            <Button variant="secondary" size="sm" onClick={(event) => { event.stopPropagation(); onResume() }}>{t("dash.protResumeKey")}</Button>
          ) : null}
```

`KeysTab.tsx`: import `useProtection` from `../../state/protection`, call `const protection = useProtection()` next to `const store = useKeys()`, and pass to each row:

```tsx
                  pause={protection.pauses.find((p) => p.targetKind === "key" && p.targetId === k.id && p.mode === "pause")}
                  onResume={(() => {
                    const paused = protection.pauses.find((p) => p.targetKind === "key" && p.targetId === k.id && p.mode === "pause")
                    return paused ? () => { void protection.resume(paused.id) } : undefined
                  })()}
```

- [ ] **Step 4: Run the tests**

Run: `bun test apps/dashboard/src packages/gateway/tests/i18n-keys.test.ts`
Expected: PASS. Typecheck and eslint clean.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/tabs/keys packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(dashboard): paused badge with reason tooltip and Resume on API keys" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 22: Reference documentation

**Files:**
- Create: `docs/upstream-protection-v1.md`

- [ ] **Step 1: Write the document** (short reference, no secrets; relative to `vnext/`)

```markdown
# Upstream error protection (v1)

Reference for operators. Design: `docs/superpowers/specs/2026-11-17-upstream-error-protection-design.md`; plan: `docs/superpowers/plans/2026-11-17-upstream-error-protection.md`.

## What is recorded

Every response (or network failure) of a request the gateway sends to an upstream is counted per minute, upstream, API key and model, by class:

| class | statuses | risky |
| --- | --- | --- |
| `ok` | 2xx (a stream that fails after a 2xx start still counts as `ok`) | no |
| `rate_limited` | 429 | yes |
| `rejected` | 400, 404, 409, 413, 422 | yes |
| `auth` | 401, 403 | yes |
| `upstream` | 5xx | no |
| `network` | no HTTP response: connect error, timeout, reset | no |
| `other` | anything else | no |

Covered: chat completions, messages, responses and Gemini requests (all through the three hub attempts), embeddings and images. Not covered in v1: `count_tokens`, decision routes, `alpha/search`, image-generation server-tool sub-calls, catalog refreshes, web-search providers. Requests the gateway rejects itself (bad key, quota, validation, no route, paused) are never recorded. Statistics are always recorded, whatever the protection mode.

For error classes (and `upstream`/`network`) the latest 20 samples per upstream and status keep the upstream's error code and message (at most 300 characters, token-looking strings redacted). Request and response content is never stored.

## Protection settings (per upstream, default off)

Set in the dashboard (Upstreams, Protection button) or with `PATCH /api/upstreams/:id` and a `protection` object:

| field | default | range | meaning |
| --- | --- | --- | --- |
| `mode` | `off` | `off`, `notify`, `pause` | off records only; notify shows a banner; pause also blocks |
| `windowMinutes` | 5 | 1 to 60 | whole minutes counted, including the current one |
| `minRiskyErrors` | 20 | 1 to 10000 | risky errors needed |
| `minFailureRatio` | 0.5 | 0 to 1 | risky errors / requests in the window |
| `authBurst` | 5 | 0 to 10000 | auth errors alone that trigger; 0 disables |
| `keyShare` | 0.8 | 0.5 to 1 | share of the risky errors that attributes them to one key |
| `cooldownMinutes` | 30 | 1 to 1440 | length of a pause or warning |
| `maxCooldownMinutes` | 360 | 1 to 10080, not below `cooldownMinutes` | cap of the doubling |

## Detection and enforcement

After a risky response is recorded (at most once every 10 s per upstream per isolate) the gateway sums the window. It triggers when `risky >= minRiskyErrors and risky / requests >= minFailureRatio`, or when `authBurst > 0 and auth >= authBurst`. If one key caused at least `keyShare` of the risky errors the target is that key (on every upstream); otherwise it is the upstream. The cooldown is `cooldownMinutes`, doubled for each earlier row of the same target and mode in the last 24 hours, capped at `maxCooldownMinutes`. No second row is created while one is active.

- `notify` rows only warn.
- A paused upstream is skipped like a disabled one; if no other upstream serves the model the answer is `503` with `Retry-After` and error code `upstream_paused`. Model listings still show the paused upstream's models.
- A paused key gets `503` with `Retry-After` and code `key_paused` before any upstream is called.
- A new pause is enforced at once by the isolate that created it and within about 10 s everywhere else (per-isolate cache, one indexed query per refresh). If the refresh fails the previous state stays in force.

## API (browser session, owner-only; admins see everything)

- `GET /api/protection/active`, `POST /api/protection/pauses/:id/resume`
- `GET /api/upstreams/:id/errors?from=&to=&bucket=minute|hour&keyId=` (unix seconds, at most 30 days and 1500 buckets; `keyId`, not `key`, because the session guard refuses a `key` query parameter)
- `GET /api/upstreams/:id/error-samples`, `GET /api/upstreams/:id/pauses?limit=`

## Retention

The scheduled maintenance sweep deletes per-minute counts older than 30 days, pause rows older than 90 days, and samples and settings of upstreams that no longer exist, in chunks of 5000 rows (at most 10 DELETEs per table per sweep). It also stamps expired rows `resolved_by = 'auto'`.

## Rollout

Merge, push, apply migration `0027_upstream_protection.sql` to D1, deploy the Worker, rebuild local gateways. Statistics start immediately; protection stays `off` until enabled per upstream.
```

- [ ] **Step 2: Check**

Run: `grep -n "sk-\|ghp_\|Bearer \|tlm_" docs/upstream-protection-v1.md` and expect no output (no secrets or key-shaped strings).

- [ ] **Step 3: Commit**

```bash
git add docs/upstream-protection-v1.md
git commit -m "docs: upstream error protection v1 reference" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 23: Final verification against the known baseline

**Files:** none changed (fix-ups, if any, are separate commits that name the failing test).

- [ ] **Step 1: Run the full local CI**

Run (from `/Users/xian/projects/copilot-api-gateway/vnext`): `bun run ci:local 2>&1 | tee /tmp/ci-local-protection.log`
Expected: the pipeline order is `ci:prepare`, `build:ui`, framework purity, `typecheck`, `bun test`, `test:agent`, `lint`, `deploy:dry`. Typecheck, lint, purity, `test:agent` and `deploy:dry` must pass. `bun test` may fail only on the known baseline:
- `provider-cancellation-forwarding` tests,
- `respond-json` JSON fallback and terminal tests,
- the `docs/superpowers/research` harness tests,
- the flaky `apps/platform-cloudflare/src/setup-leases.d1.test.ts` (re-run it alone once with `bun test apps/platform-cloudflare/src/setup-leases.d1.test.ts` to confirm flakiness, not a regression).

If `ci:prepare` cannot reach the reference repository (network), set `REFERENCE_SOURCE_ROOT` to an existing checkout instead of changing the script.

- [ ] **Step 2: Compare failures with the baseline**

Run: `grep -E "^\(fail\)|✗|error:" /tmp/ci-local-protection.log | sort -u`
Expected: every listed failing test belongs to the baseline above. Anything else (especially a test whose name contains `protection`, `routing`, `select-binding`, `attempt`, `respond`, `i18n`, `type-scale`, `migrations`, `schema`) is a regression to fix with its own commit.

- [ ] **Step 3: Targeted checks of the new surface**

Run: `bun test packages/gateway/tests/protection-*.test.ts packages/gateway/tests/upstream-protection-migration.test.ts packages/gateway/tests/data-plane/chat-flow/shared/protection-recording.test.ts packages/gateway/tests/i18n-keys.test.ts packages/gateway/tests/migrations.test.ts apps/dashboard/src`
Expected: all PASS.

- [ ] **Step 4: Per-spec acceptance walk-through**

Confirm each spec "Testing" bullet has a passing test: classification (`protection-classify`, `protection-observe`), mid-stream failures as `ok` (`protection-observe`, fourth test), gateway rejections not recorded (`protection-recording` third test), repo contract on SQLite and D1 (`protection-repo.*`), detection boundaries (`protection-detect`, `protection-evaluate`), enforcement and cache (`protection-enforcement.sqlite`, `protection-resolve-binding.sqlite`, `protection-key-guard`, `protection-cache`), API (`protection-api`, `protection-upstream-api`, `protection-query`), dashboard (banner, form, chart, tables, key badge, i18n parity), retention (`protection-retention`).

- [ ] **Step 5: Record the result**

If everything matches the baseline, no commit is needed. Otherwise commit each fix separately, then repeat Steps 1 and 2.

