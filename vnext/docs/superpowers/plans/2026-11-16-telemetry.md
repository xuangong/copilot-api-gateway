# Telemetry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let external systems push hourly metrics to the gateway with a push-only key, store them as a generic time series, and show freshness, month-to-date usage with a projection, hourly charts, top groups, surge and failure flags and single-check results in the dashboard; ship a Python agent and one-line installer for the owner's trojan VM as the first source.

**Architecture:** The gateway gains `telemetry_sources` and `telemetry_points` tables, an unauthenticated-by-session `POST /api/telemetry/push` (bearer `tlm_` key, atomic per-(metric, hour) replacement through a new optional `SqlExecutor.batch`), session-guarded owner-only source management and query routes (series, top, summary, metrics) backed by pure analysis functions, and a retention task in `sweepMaintenance`. The agent (`tools/trojan-telemetry/trojan-telemetry.py`, standard library only) runs from a systemd timer, computes closed hours from `docker logs` and `vnstat`, writes them to an outbox, pushes oldest first, and probes the trojan service end to end once per run. Releases are built by a GitHub Actions workflow on a `telemetry-agent-v*` tag.

**Tech Stack:** Bun workspaces, TypeScript, Hono, zod 4, bun:test with in-memory SQLite (`BunSqliteRepo`) and Miniflare D1, React dashboard rendered with `react-dom/server` in tests, Python 3 standard library with `unittest`, bash.

**Spec:** `vnext/docs/superpowers/specs/2026-11-16-telemetry-design.md` (source of truth, including its amendments).

All paths below are relative to `vnext/` unless they start with `.github/` (repository root). Run commands from `vnext/` (`/Users/xian/projects/copilot-api-gateway/vnext`). Gateway test paths need the `./` prefix, e.g. `bun test ./packages/gateway/tests/<file>`. Python tests run from the agent directory: `cd tools/trojan-telemetry && python3 -m unittest discover -s tests -v`.

---

## Repository rules for every task

- **Never run plain `bun install`.** A local registry mirror rewrites `bun.lock`. This plan adds no dependency. Before the first commit and again in Task 15 run `git diff --quiet cf94bd93 -- bun.lock && echo unchanged`; it must print `unchanged`.
- **Never `git add -A` or `git add .`.** Stage the exact files listed in each commit step. Do not touch the untracked `docs/loki-safety-check-2026-11-14.md`.
- **Known baseline:** the full suite has 11 pre-existing failures, plus a flaky `apps/platform-cloudflare/src/setup-leases.d1.test.ts`. Acceptance is "no new failures", never "all green". Record the failing test names from the first full run in Task 15 and compare.
- Every commit message ends with a blank line and `Co-Authored-By: Claude <noreply@anthropic.com>`. Commit commands below use a heredoc so the trailer is preserved.
- **Never push, tag or create a release.** Work on `feat/telemetry` (do not switch branches). Publishing `telemetry-agent-v1.0.0` is an owner-confirmed rollout step after merge; this plan only adds the workflow that would run on that tag.
- If a "run to see it fail" step does not fail as described, stop and find out why before writing the implementation.
- Python must stay compatible with Python 3.8 (no `X | Y` type syntax, no `match`, no `str.removeprefix`).

## Decisions where the spec is silent or the code forces a choice

The task code blocks further down were written before the final review: they scan points directly, keep one `hour` index and mention `hourContributors`. Where they differ from D1, D3, D7, D10, D15 and D32 below, the decisions and `packages/gateway/src/repo/shared/telemetry.ts` are authoritative.

| # | Decision | Reason |
| --- | --- | --- |
| D1 | Migration `0026_telemetry.sql` (0025 is the highest). `telemetry_points` is `WITHOUT ROWID` with primary key `(source_id, metric, hour, dims_key)`; there is no separate `(source_id, metric, hour)` index (the key prefix covers it) but retention uses two partial indexes on `hour` (`WHERE dims_key <> ''` and `WHERE dims_key = ''`). A rollup table `telemetry_hourly(source_id, metric, hour, unit, value)` (`WITHOUT ROWID`, primary key `(source_id, metric, hour)`, index on `hour`) holds the sum over dims per metric and hour, so totals never scan dimension rows. `value REAL CHECK (value >= 0)`, `unit CHECK IN ('bytes','count','ms')`. | One table serves point reads and hour replacement; each partial index serves one retention predicate and the rollup serves totals, first hours and the metric list by seeks (decision added after the final review: an unindexed hour filter over every retained row cost millions of rows read per page view). |
| D2 | `dims_key` is `JSON.stringify` of the dims with sorted keys, `""` when there are none; `dims_json` is the same text, or `{}` when none. Dim keys match `^[a-z][a-z0-9_]{0,31}$`; dim values are strings of 1..256 characters; at most 3 dims. | Spec rule "keys like metric segments (1..32 chars)" made precise; a leading letter also rules out `__proto__`. |
| D3 | `SqlExecutor` gains an optional `batch(statements)`; D1 maps it to `db.batch` (one transaction), Bun to `db.transaction`. Hour replacement is one batch: one `DELETE` per distinct metric with its hours (hours bound once as a JSON array read by `json_each`), `INSERT ... SELECT` from `json_each` in chunks of 1000 points (the dims text travels once per row; `dims_key` is derived in SQL), then one `INSERT OR REPLACE` into `telemetry_hourly` per 1000 (metric, hour) sums (computed in TypeScript; at most 20 metrics x 168 hours = 3 360 rows, 4 statements), then the `last_push_at` update. Worst case is 20 DELETEs + at most 22 INSERT chunks (a row cut at 1000 or a 1.5 MB byte cut) + 4 rollup chunks + 1 UPDATE = 47 statements per push, plus 2 auth reads = 49 queries per invocation, far under the Workers Paid limit of 1000 (and still under the free plan's 50; a unit test asserts at most 47). Inserts are guarded by `EXISTS (source)`. A shared contract test proves rollback on both runtimes. | D1 allows 100 bound parameters per statement, so rows travel as one JSON parameter; a half-applied push would double-count or lose an hour. |
| D4 | Push limits (each `400 invalid_request`): at most 20 000 points, 20 distinct metrics (keeps a push within D1's per-invocation query limit, see D3) and 168 distinct hours per body; value at most 1e15; one unit per metric per body; unknown fields rejected; `dims` optional; empty `points` is accepted (heartbeat that only stamps `last_push_at`). Points older than their kind's retention (dims 90 d, no dims 400 d) or more than one hour in the future are rejected. | Bounds the work of one request. |
| D5 | Push authenticates before reading the body. A body over 2 MiB answers `413 body_too_large`. A missing, malformed or non-`tlm_` credential, an unknown key, a deleted source and a disabled owner all answer `401 invalid_key`. `session-auth` rejects any `tlm_` bearer elsewhere with `401 invalid_key` (like `sds_`). | Spec: uniform 401, push key can only push. |
| D6 | Source create and rotate require HTTPS (`400 https_required`) so the install command names a real origin. `DELETE` returns `{ sources }`. Deleting a user also deletes the user's sources (`auth/routes.ts`). | Same rule as sync devices. |
| D7 | Source delete (and user cascade) removes only the source row, one query. Its points become orphans that scheduled maintenance purges shortly after: `deleteExpired` finds orphan ids by a primary-key loose index scan and deletes in chunks of 20 000 rows, with one budget of at most 20 DELETE statements per call across expired rows and orphans (the rest waits for the next sweep); orphans are found in both `telemetry_points` and `telemetry_hourly`. | A request or a sweep must stay well within the per-invocation query limit; a single unbounded `DELETE` can exceed D1 limits. |
| D8 | `PATCH` `settings` replaces the whole object, is validated by a strict zod schema, and must serialize to at most 32 KiB. | Predictable semantics; bounded row size. |
| D9 | Query windows are hour-aligned ISO (`...:00:00Z`), `from` inclusive and `to` exclusive, default last 24 h up to and including the current hour, at most 90 days. `top` 1..20 (series), `limit` 1..100 (top table). Series are dense. Anything after the top N becomes one `(other)` group merged with any real `(other)` group the agent pushed. Rows lacking the `groupBy` key form the group `""`. | Spec amendment decisions. |
| D10 | `/metrics` reports first and last hour over the last 30 days (from the rollup, by a loose index scan over metrics) and the dim keys of the dimension rows at each metric's last hour only. | Bounded seeks. |
| D11 | Top table: previous period is the equal-length window before `from`; `change` is `null` when the previous value is 0; `share` is relative to all groups; `otherCurrent` is the remainder after the listed groups. | Spec. |
| D12 | Month-to-date covers the UTC month start through the current hour. Projection = MTD + average daily total of the last 7 complete UTC days (only days whose start is at or after the first data hour; a partially covered first day is not averaged) x fractional days remaining. Cost uses decimal GB (1e9) and is `null` for non-`bytes` metrics or without `pricePerGB`. | Spec. |
| D13 | Surges are judged only for hours with at least 24 h of history before them; at most 10 metrics, 20 surges, 5 contributors each; `ms` metrics are skipped; the comparison is `value >= factor x baseline` and `value >= minimum` (both inclusive); `ratio` is `null` when the baseline is 0. | Spec amendment (history rule) plus JSON-safe ratio. |
| D14 | A never-pushed source reports `stale: false`, `lastPushAt: null`. Stale is strictly `now - lastPushAt > staleAfterHours`. | Spec. |
| D15 | Retention is `repo.telemetry.deleteExpired(nowMs, { orphans })`, run by `sweepMaintenance` as task `telemetry_retention` (Bun sweep and Worker cron both call it every minute, expiry runs on every sweep and only the orphan scan is gated to UTC minute 17 (plus the next sweep while the previous scan used its whole budget); each row class is purged through its own partial index and rollup rows expire after 400 days). | Reuses the existing scheduler; an every-minute run re-walked every retained plain row (see `docs/telemetry-v1.md`, "D1 rows read/written"). |
| D16 | Check statuses are `passed` (value > 0), `failed` (value = 0), `no check` (no point at or after the metric's first point) and `not monitored` (before the first point). `no check` is a warning, `not monitored` is neutral. The summary judges the latest closed hour; when it is `no check`, the dashboard shows a warning alongside any staleness warning. A failed check's stage is read from the matching `<name>.fail` metric (for `<name>.ok`) when that metric is in `flagNonZeroMetrics`. No uptime percentage is ever computed. | Latest spec amendment. |
| D17 | The agent lives in `tools/trojan-telemetry/` (`trojan-telemetry.py`, `VERSION`, `install.sh`, `build-release.sh`, `tests/`). Python tests load the hyphenated script with `importlib`. | The script name comes from the spec. |
| D18 | There is no build-time version embed: `TELEMETRY_AGENT_VERSION` is a constant in `control-plane/telemetry/agent-release.ts`, a bun test compares it with `VERSION` and with the agent's `AGENT_VERSION`, and the release workflow checks the tag against all of them. | Keeps the dashboard's install command pinned without a build step. |
| D19 | Install command: `curl -fsSL <release>/install.sh \| sudo TELEMETRY_GATEWAY='...' TELEMETRY_KEY='...' bash` with POSIX single-quoted values. `build-release.sh <version> <outdir>` stamps the version into `install.sh` and writes `SHA256SUMS` for `trojan-telemetry.py` and `install.sh`; the workflow calls it; a Python test runs it. The installer embeds the systemd units and honours `TELEMETRY_PREFIX` (a root for every path; skips apt, systemctl and the first run) and `TELEMETRY_BASE_URL` (download base, `file://` allowed) for tests. | Testable without root. |
| D20 | Agent cursor semantics: it processes hours in `(cursor, lastClosed]`; first run backfills 24 h; a cursor older than 30 days is clamped to 30 days. A docker or vnstat failure stops the loop without advancing the cursor and makes the run exit 1; a missing vnstat row for an hour is not a failure. Every processed hour writes an outbox file even when `points` is empty. | Spec; the empty file only records that the hour was processed; the gateway replaces just the pushed (metric, hour) pairs, so an empty file never clears older data. |
| D21 | Push batches hold at most 24 hours, 10 000 points and 1.5 MiB; an hour (its hourly file and its probe file) is never split; any non-200 response or network failure stops the push and the run exits 1. | A permanent 400 therefore blocks later hours; that is deliberate (surfaced by `systemctl status`). |
| D22 | User mapping: `TROJAN_USERS` (ordered hashes) wins, else the sha224 hex of each trojan-go `password` entry in file order. The config comes from `TROJAN_CONFIG`, else bind mounts found with `docker inspect`, else `/etc/trojan-go/config.json`, `/etc/trojan/config.json`. Unknown hashes map to `#?`. | Spec. |
| D23 | Log traffic units are 1024-based (`B`, `KiB`...`TiB`; `KB`... accepted as the same); traffic is attributed to the hour in which the connection closed (the hour of the log line, via `docker logs --since/--until`). | trojan-go prints `KiB` etc. at close time. |
| D24 | Registrable domain heuristic without a public suffix list: IP literals are kept; otherwise the last 2 labels, or the last 3 when the TLD is 2 letters and the second label is a generic second-level label (`com`, `co`, `net`, `org`, `gov`, `edu`, `ac`, `or`, `ne`, `go`, ...). Known limit: other multi-label public suffixes (for example `pvt.k12.ma.us`) group one level too coarse. | Spec; documented in `docs/telemetry-v1.md`. |
| D25 | vnstat is read once per run with `vnstat --json h -i IFACE`; JSON v1 values are KiB, v2 bytes; hours are in VM local time and converted to UTC; counters may lag up to 5 minutes, which the `:05` timer offset absorbs. | Spec. |
| D26 | Non-blocking `flock` on `<state>/lock` (exit 0 silently if held); a hidden `--now <ISO>` flag fixes the clock for tests; the agent loads `/etc/trojan-telemetry.env` itself (existing environment variables win). | Spec. |
| D27 | The probe uses TCP, then TLS with SNI `TROJAN_SNI` (certificate verified), then a trojan request (sha224 hex of the first password, CRLF, `0x01`, address type `0x03`, length, host, port, CRLF), then `GET /generate_204`. Stages are `tcp`, `tls`, `tunnel`, `http`, `timeout`. It is written as its own outbox file `<YYYY-MM-DDTHH>.probe.json` (a second probe in the same hour replaces the first) with metrics `probe.ok`, `probe.fail{stage}`, `probe.latency_ms`. `PROBE_HOST` defaults to the SNI host (resolved by DNS, so the check covers the public path); `PROBE_PORT` (default 443) is an addition for tests. `PROBE_CA_FILE` exists only for tests. | The spec's "interface's public address" cannot be derived reliably on a cloud VM whose NIC holds a private address. |
| D28 | CI runs no Python today: `test:agent` is added to `package.json` and appended to `ci:local`, and a step is added to `.github/workflows/vnext-ci.yml`. The only workflows are `vnext-ci.yml` and `vnext-remote-compat.yml`; a new `.github/workflows/telemetry-agent-release.yml` builds releases. | Verified with `ls .github/workflows` at the repository root. |
| D29 | End-to-end: a bun test serves `app.fetch` with `Bun.serve` over an in-memory repo, puts fake `docker` and `vnstat` first on `PATH`, spawns the real `python3 trojan-telemetry.py run --now ...`, and queries the routes. It is skipped only when `python3` is missing. | Proves agent and gateway agree. |
| D30 | Dashboard: the hash router is single-segment, so the selected source is component state; the nav item `telemetry` goes in the Observe group (every viewer; sources are owner-only server side) and `navigation.test.ts` is updated. The chart draws one line per group plus a dashed Total; `ChartDataset` gains an optional per-point `highlight`. A `checkMetrics` metric is drawn as a strip of per-hour markers (never a chart or percentage). The settings form uses decimal GB. Views are pure and tested with `renderToStaticMarkup`; containers stay thin. | Matches the sync UI pattern. |
| D31 | Name-collision check (done at planning time with `grep -rnE` over `packages apps docs`): the codebase uses "telemetry" for internal request-usage recording (`respond-telemetry.ts`, `telemetry-ctx.ts`, `upstream-telemetry.ts`, the 2026-06-16 spec3 plan directory). None of the identifiers introduced here exist: directory `control-plane/telemetry/`, repo property `Repo.telemetry`, types `TelemetrySource*`, `TelemetryPoint`, `TelemetryRepo`, `TelemetrySettings`, tables `telemetry_sources` and `telemetry_points`, route prefix `/api/telemetry`, key prefix `tlm_`, id prefix `tls_`, nav id `telemetry`, i18n keys `dash.telemetry` and `dash.tlm*`. Re-run the grep in Task 15. | Prevents shadowing. |
| D32 | The dashboard's five-minute poll refreshes only `/summary` (and the source list's badges on the list page); the metric list loads on open, on manual refresh and after saving settings. Polling pauses while `document.hidden` and refreshes once when the page is visible again. | Bounds rows read per open tab. |
| D33 | Review fix: the install command no longer pipes curl into a shell. `agent-release.ts` pins `TELEMETRY_AGENT_SHA256` (the committed agent) and `TELEMETRY_INSTALLER_SHA256` (the installer as stamped by `build-release.sh`); the command downloads `install.sh` to a temp file, verifies it, then runs it with `TELEMETRY_AGENT_SHA256`, which `install.sh` checks in addition to `SHA256SUMS`. A consistency test recomputes both hashes and the release workflow checks the built assets against them. | The release page alone must not decide which bytes run as root. |
| D34 | Review fix: push failure handling. A `400`/`413` on a multi-hour batch is retried hour by hour; an hour still refused alone is moved to `outbox/rejected/` (never retried, discarded after 30 days) and later hours keep pushing (nothing is quarantined when no hour at all was accepted in the run, nor hours within the last 2 hours of the agent's clock, nor when the move fails); every other failure stops the push and keeps all files. The run exits 1 when anything was rejected. Supersedes the "stop at the first failure" and "rejected file blocks later hours" wording elsewhere in this plan. | One bad hour must not block the outbox forever. |

## File structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/migrations/0026_telemetry.sql` (create) | Tables and indexes |
| `packages/gateway/tests/schema-baseline.txt`, `tests/migrations.test.ts` (modify) | Baseline and upgrade test |
| `packages/gateway/src/repo/shared/executor.ts` (modify) | Optional `batch` |
| `packages/gateway/src/repo/telemetry.ts` (create) | Repo types, constants, `canonicalDims` |
| `packages/gateway/src/repo/shared/telemetry.ts` (create) | `SharedTelemetryRepo` |
| `packages/gateway/src/repo/types.ts`, `repo/index.ts`, `repo/shared/repos.ts` (modify) | `Repo.telemetry` wiring and type exports |
| `apps/platform-bun/src/bun-sqlite-repo.ts`, `apps/platform-cloudflare/src/d1-repo.ts` (modify) | Executor `batch`, expose `telemetry` |
| `packages/gateway/tests/telemetry-repo-contract.ts` (create) | Runtime-independent repo contract tests |
| `packages/gateway/tests/telemetry-repo.sqlite.test.ts`, `telemetry-repo.d1.test.ts` (create) | Run the contract on SQLite and D1 |
| `packages/gateway/src/control-plane/telemetry/common.ts` (create) | Errors, JSON helpers, bounded body read, hashing, clock |
| `packages/gateway/src/control-plane/telemetry/protocol.ts` (create) | Constants, push validation, settings schema, query window parsing |
| `packages/gateway/src/control-plane/telemetry/push.ts` (create) | `POST /api/telemetry/push` |
| `packages/gateway/src/control-plane/telemetry/agent-release.ts` (create) | `TELEMETRY_AGENT_VERSION`, install command |
| `packages/gateway/src/control-plane/telemetry/sources.ts` (create) | Source management routes |
| `packages/gateway/src/control-plane/telemetry/analysis.ts` (create) | Pure analysis functions |
| `packages/gateway/src/control-plane/telemetry/queries.ts` (create) | Metrics, series, top, summary routes |
| `packages/gateway/src/control-plane/telemetry/routes.ts` (create) | Guarded management router |
| `packages/gateway/src/app.ts`, `control-plane/routes.ts`, `control-plane/auth/session-auth.ts`, `control-plane/auth/routes.ts`, `src/maintenance.ts` (modify) | Mounting, `tlm_` rejection, user cascade, retention |
| `packages/gateway/tests/telemetry-*.test.ts` (create) | Push, sources, analysis, queries, retention, release consistency, e2e |
| `packages/gateway/tests/control-plane-auth.test.ts` (modify) | Fake repo gains `telemetry` |
| `tools/trojan-telemetry/trojan-telemetry.py`, `VERSION`, `install.sh`, `build-release.sh` (create) | Agent and release scripts |
| `tools/trojan-telemetry/tests/*.py` (create) | Agent, probe and release tests |
| `package.json`, `.github/workflows/vnext-ci.yml`, `.github/workflows/telemetry-agent-release.yml` (modify/create) | CI and release |
| `apps/dashboard/src/api/telemetry.ts` (create) | Client calls and types |
| `apps/dashboard/src/tabs/telemetry/*` (create) | Pure helpers, views and containers |
| `apps/dashboard/src/components/TimeSeriesChart.tsx` (modify) | Per-point `highlight` |
| `apps/dashboard/src/shell/navigation.ts`, `navigation.test.ts`, `App.tsx` (modify) | Nav item and page |
| `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (modify) | EN and ZH copy |
| `docs/telemetry-v1.md` (create) | Operator and protocol documentation |

---

## Task 1: Migration and repositories (SQLite and D1)

**Files:**
- Create: `packages/gateway/migrations/0026_telemetry.sql`
- Create: `packages/gateway/src/repo/telemetry.ts`, `packages/gateway/src/repo/shared/telemetry.ts`
- Modify: `packages/gateway/src/repo/shared/executor.ts`, `repo/types.ts`, `repo/index.ts`, `repo/shared/repos.ts`
- Modify: `apps/platform-bun/src/bun-sqlite-repo.ts`, `apps/platform-cloudflare/src/d1-repo.ts`
- Modify: `packages/gateway/tests/migrations.test.ts`, `packages/gateway/tests/schema-baseline.txt`
- Create: `packages/gateway/tests/telemetry-repo-contract.ts`, `telemetry-repo.sqlite.test.ts`, `telemetry-repo.d1.test.ts`

- [ ] **Step 1: Confirm the starting point**

```bash
git rev-parse --abbrev-ref HEAD
git diff --quiet cf94bd93 -- bun.lock && echo unchanged
ls packages/gateway/migrations | tail -1
```

Expected: `feat/telemetry`, `unchanged`, `0025_gateway_upstream_sync.sql`.

- [ ] **Step 2: Write the failing migration test**

Append this test inside the `describe("migration corpus", ...)` block of `packages/gateway/tests/migrations.test.ts`, directly after the `gateway sync upgrade ...` test (before the schema-baseline test):

```ts
  test("telemetry migration creates the tables, enforces constraints and applies once", () => {
    const db = new Database(":memory:")
    try {
      db.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY)")
      for (const file of listSql().sort().filter(file => file < "0026_")) {
        db.exec(readFileSync(`${dir}/${file}`, "utf8"))
        db.run("INSERT INTO _migrations (name) VALUES (?)", [file])
      }
      applyMigrations(db, dir)
      applyMigrations(db, dir)
      const id = `tls_${"a".repeat(32)}`
      db.run("INSERT INTO telemetry_sources (id, owner_id, name, key_hash, created_at) VALUES (?, 'o', 'vm', ?, 'now')", [id, "b".repeat(64)])
      expect(db.query("SELECT settings_json, last_push_at FROM telemetry_sources").get()).toEqual({ settings_json: "{}", last_push_at: null })
      expect(() => db.run("INSERT INTO telemetry_sources (id, owner_id, name, key_hash, created_at) VALUES ('short', 'o', 'vm', ?, 'now')", ["c".repeat(64)])).toThrow()
      expect(() => db.run("INSERT INTO telemetry_sources (id, owner_id, name, key_hash, created_at) VALUES (?, 'o', 'vm2', ?, 'now')", [`tls_${"d".repeat(32)}`, "b".repeat(64)])).toThrow()
      const insert = (value: number, unit: string, hour = 3600) =>
        db.run("INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit) VALUES (?, 'm', ?, '', '{}', ?, ?)", [id, hour, value, unit])
      insert(1, "bytes")
      expect(() => insert(1, "bytes")).toThrow()
      expect(() => insert(-1, "bytes", 7200)).toThrow()
      expect(() => insert(1, "seconds", 7200)).toThrow()
      insert(1, "ms", 7200)
      expect(db.query("SELECT name FROM _migrations WHERE name = '0026_telemetry.sql'").all()).toHaveLength(1)
    } finally { db.close() }
  })
```

- [ ] **Step 3: Run it to see it fail**

Run: `bun test ./packages/gateway/tests/migrations.test.ts -t "telemetry migration"`
Expected: FAIL (`no such table: telemetry_sources`).

- [ ] **Step 4: Create the migration**

`packages/gateway/migrations/0026_telemetry.sql`:

```sql
-- Telemetry: external systems push hourly metrics with a push-only key. `key_hash` is the SHA-256 hex of the `tlm_` key.
CREATE TABLE telemetry_sources (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND id GLOB 'tls_*'),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  key_hash TEXT NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_push_at TEXT
);
CREATE INDEX idx_telemetry_sources_owner ON telemetry_sources (owner_id, created_at);

-- `hour` is unix seconds at the top of an hour. `dims_key` is the canonical JSON of the sorted dims ('' when none).
-- The primary key prefix (source_id, metric, hour) serves per-metric range reads; `hour` alone serves retention.
CREATE TABLE telemetry_points (
  source_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  hour INTEGER NOT NULL,
  dims_key TEXT NOT NULL,
  dims_json TEXT NOT NULL,
  value REAL NOT NULL CHECK (value >= 0),
  unit TEXT NOT NULL CHECK (unit IN ('bytes', 'count', 'ms')),
  PRIMARY KEY (source_id, metric, hour, dims_key)
) WITHOUT ROWID;
CREATE INDEX idx_telemetry_points_hour ON telemetry_points (hour);
```

- [ ] **Step 5: Run, then regenerate the schema baseline**

```bash
bun test ./packages/gateway/tests/migrations.test.ts -t "telemetry migration"
UPDATE_SCHEMA_BASELINE=1 bun test ./packages/gateway/tests/migrations.test.ts -t "schema"
git diff --stat packages/gateway/tests/schema-baseline.txt
bun test ./packages/gateway/tests/migrations.test.ts
```

Expected: the first passes; the baseline diff adds only the two tables and two indexes (plus the autoindexes SQLite lists); the final run is fully green.

- [ ] **Step 6: Write the repository types**

`packages/gateway/src/repo/telemetry.ts`:

```ts
import type { UserId } from "./branded-ids.ts"

export type TelemetryUnit = "bytes" | "count" | "ms"

export const TELEMETRY_UNITS: readonly TelemetryUnit[] = ["bytes", "count", "ms"]
export const TELEMETRY_DIMS_RETENTION_DAYS = 90
export const TELEMETRY_PLAIN_RETENTION_DAYS = 400
export const TELEMETRY_PURGE_CHUNK = 20_000
export const TELEMETRY_PURGE_MAX_CHUNKS = 50
export const TELEMETRY_INSERT_CHUNK = 400

export interface TelemetrySourceRecord {
  id: string
  ownerId: UserId
  name: string
  /** SHA-256 hex of the push key; the key itself is never stored. */
  keyHash: string
  /** Validated by the routes; stored as JSON. */
  settings: Record<string, unknown>
  createdAt: string
  lastPushAt: string | null
}

/** `hour` is unix seconds at the top of an hour. */
export interface TelemetryPoint {
  metric: string
  hour: number
  dims: Record<string, string>
  value: number
  unit: TelemetryUnit
}

export interface TelemetryMetricInfo {
  metric: string
  unit: TelemetryUnit
  firstHour: number
  lastHour: number
  dimKeys: string[]
}

export interface TelemetryHourValue { hour: number; value: number }
export interface TelemetryMetricHourValue extends TelemetryHourValue { metric: string; unit: TelemetryUnit }
export interface TelemetryGroupTotal { key: string; value: number }
export interface TelemetryGroupHours { key: string; points: TelemetryHourValue[] }
export interface TelemetryDimRow { metric: string; hour: number; dims: Record<string, string>; value: number }
export interface TelemetryContribution { dims: Record<string, string>; value: number }

export interface TelemetryRepo {
  /** Oldest first. */
  listSources(ownerId: UserId): Promise<TelemetrySourceRecord[]>
  getSource(id: string): Promise<TelemetrySourceRecord | null>
  findSourceByKeyHash(keyHash: string): Promise<TelemetrySourceRecord | null>
  /** Inserts unless the owner already holds `limit` sources. False means the limit was reached. */
  createSourceWithinLimit(source: TelemetrySourceRecord, limit: number): Promise<boolean>
  /** Updates only supplied fields (`settings` replaces the whole object); null when missing or owned by someone else. */
  updateSource(id: string, ownerId: UserId, patch: { name?: string; settings?: Record<string, unknown> }): Promise<TelemetrySourceRecord | null>
  rotateKey(id: string, ownerId: UserId, keyHash: string): Promise<TelemetrySourceRecord | null>
  /** Deletes the row, then purges its points in chunks. False when missing or owned by someone else. */
  deleteSource(id: string, ownerId: UserId): Promise<boolean>
  deleteSourcesByOwner(ownerId: UserId): Promise<void>
  /**
   * Atomically replaces every (metric, hour) present in `points` and stamps `last_push_at`. Empty `points` only stamps.
   * False (and nothing written) when the source no longer exists.
   */
  replaceHours(sourceId: string, points: readonly TelemetryPoint[], nowIso: string): Promise<boolean>
  /** Metrics with data at or after `sinceHour`: unit, first and last hour in that range, dim keys of the 24 h before each newest hour. */
  listMetrics(sourceId: string, sinceHour: number): Promise<TelemetryMetricInfo[]>
  /** The earliest hour of a metric, or null. */
  firstHour(sourceId: string, metric: string): Promise<number | null>
  /** Per metric and hour, summed over dims; `[fromHour, toHour)`. */
  hourlyTotals(sourceId: string, metrics: readonly string[], fromHour: number, toHour: number): Promise<TelemetryMetricHourValue[]>
  /** Sum over all groups plus the top groups by total (the group `(other)` is excluded from the ranking). */
  topGroups(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, limit: number):
    Promise<{ unit: TelemetryUnit | null; total: number; groups: TelemetryGroupTotal[] }>
  groupHours(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, keys: readonly string[]): Promise<TelemetryGroupHours[]>
  groupTotals(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, keys: readonly string[]): Promise<TelemetryGroupTotal[]>
  /** Rows with value > 0, newest hour first. */
  nonZeroRows(sourceId: string, metrics: readonly string[], fromHour: number, toHour: number, limit: number): Promise<TelemetryDimRow[]>
  /** The largest dimensioned rows of one metric at one hour. */
  hourContributors(sourceId: string, metric: string, hour: number, limit: number): Promise<TelemetryContribution[]>
  /** Deletes points past retention and points whose source is gone. Returns the number of rows deleted. */
  deleteExpired(nowMs: number): Promise<number>
}

/** Canonical dims text: JSON of the entries sorted by key; `""` when there are none. */
export function canonicalDims(dims: Record<string, string>): string {
  const keys = Object.keys(dims).sort()
  if (keys.length === 0) return ""
  const sorted: Record<string, string> = {}
  for (const key of keys) sorted[key] = dims[key]!
  return JSON.stringify(sorted)
}
```

- [ ] **Step 7: Add `batch` to the executor and both runtimes**

`packages/gateway/src/repo/shared/executor.ts` (replace the interface):

```ts
// Thin async SQL adapter so D1 and bun:sqlite can share a single set of repo
// implementations. Backends implement these three methods; everything else
// lives in shared/repos.ts.

export interface SqlStatement {
  sql: string
  binds: unknown[]
}

export interface SqlExecutor {
  all<T = any>(sql: string, binds: unknown[]): Promise<T[]>
  first<T = any>(sql: string, binds: unknown[]): Promise<T | null>
  run(sql: string, binds: unknown[]): Promise<{ changes: number }>
  /** Runs the statements in order as one transaction: any failure rolls all of them back. Optional; telemetry requires it. */
  batch?(statements: readonly SqlStatement[]): Promise<{ changes: number }[]>
}
```

In `apps/platform-bun/src/bun-sqlite-repo.ts`, add this method to `SqliteExecutor` after `run` (the statement type is structural, so no new import is needed):

```ts
  async batch(statements: readonly { sql: string; binds: unknown[] }[]): Promise<{ changes: number }[]> {
    const transaction = this.db.transaction((items: readonly { sql: string; binds: unknown[] }[]) =>
      items.map(item => ({ changes: Number(this.db.query(item.sql).run(...(item.binds as any[])).changes) || 0 })))
    return transaction(statements)
  }
```

In `apps/platform-cloudflare/src/d1-repo.ts`, add inside `D1Executor` after `run`:

```ts
  async batch(statements: readonly { sql: string; binds: unknown[] }[]): Promise<{ changes: number }[]> {
    const results = await this.db.batch(statements.map(statement => this.prep(statement.sql, statement.binds)))
    return results.map(result => ({ changes: (result.meta.changes as number) ?? 0 }))
  }
```


- [ ] **Step 8: Write the repository implementation**

`packages/gateway/src/repo/shared/telemetry.ts`:

```ts
import type { UserId } from "../branded-ids.ts"
import {
  TELEMETRY_DIMS_RETENTION_DAYS, TELEMETRY_INSERT_CHUNK, TELEMETRY_PLAIN_RETENTION_DAYS, TELEMETRY_PURGE_CHUNK,
  TELEMETRY_PURGE_MAX_CHUNKS, canonicalDims,
  type TelemetryContribution, type TelemetryDimRow, type TelemetryGroupHours, type TelemetryGroupTotal, type TelemetryMetricHourValue,
  type TelemetryMetricInfo, type TelemetryPoint, type TelemetryRepo, type TelemetrySourceRecord, type TelemetryUnit,
} from "../telemetry.ts"
import type { SqlExecutor, SqlStatement } from "./executor.ts"

const SOURCE_COLS = "id, owner_id, name, key_hash, settings_json, created_at, last_push_at"

interface SourceRow {
  id: string
  owner_id: string
  name: string
  key_hash: string
  settings_json: string
  created_at: string
  last_push_at: string | null
}

function parseObject(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json)
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

function parseDims(json: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseObject(json))) if (typeof value === "string") out[key] = value
  return out
}

const toSource = (row: SourceRow): TelemetrySourceRecord => ({
  id: row.id, ownerId: row.owner_id as UserId, name: row.name, keyHash: row.key_hash, settings: parseObject(row.settings_json),
  createdAt: row.created_at, lastPushAt: row.last_push_at,
})

const DELETE_HOURS_SQL = `DELETE FROM telemetry_points WHERE source_id = ? AND metric = ?
  AND hour IN (SELECT value FROM json_each(?)) AND EXISTS (SELECT 1 FROM telemetry_sources WHERE id = ?)`

const INSERT_ROWS_SQL = `INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit)
  SELECT ?, json_extract(j.value, '$.m'), json_extract(j.value, '$.h'), json_extract(j.value, '$.k'),
         json_extract(j.value, '$.d'), json_extract(j.value, '$.v'), json_extract(j.value, '$.u')
  FROM json_each(?) AS j WHERE EXISTS (SELECT 1 FROM telemetry_sources WHERE id = ?)`

/** The group a row belongs to: the value of one dim, or '' when the row lacks that dim. */
const GROUPED = `SELECT COALESCE(json_extract(dims_json, ?), '') AS grp, hour, value FROM telemetry_points
  WHERE source_id = ? AND metric = ? AND hour >= ? AND hour < ?`

export class SharedTelemetryRepo implements TelemetryRepo {
  constructor(private readonly x: SqlExecutor) {}

  async listSources(ownerId: UserId): Promise<TelemetrySourceRecord[]> {
    const rows = await this.x.all<SourceRow>(`SELECT ${SOURCE_COLS} FROM telemetry_sources WHERE owner_id = ? ORDER BY created_at ASC, id ASC`, [ownerId])
    return rows.map(toSource)
  }

  async getSource(id: string): Promise<TelemetrySourceRecord | null> {
    const row = await this.x.first<SourceRow>(`SELECT ${SOURCE_COLS} FROM telemetry_sources WHERE id = ?`, [id])
    return row ? toSource(row) : null
  }

  async findSourceByKeyHash(keyHash: string): Promise<TelemetrySourceRecord | null> {
    const row = await this.x.first<SourceRow>(`SELECT ${SOURCE_COLS} FROM telemetry_sources WHERE key_hash = ?`, [keyHash])
    return row ? toSource(row) : null
  }

  async createSourceWithinLimit(source: TelemetrySourceRecord, limit: number): Promise<boolean> {
    const result = await this.x.run(
      `INSERT INTO telemetry_sources (${SOURCE_COLS}) SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM telemetry_sources WHERE owner_id = ?) < ?`,
      [source.id, source.ownerId, source.name, source.keyHash, JSON.stringify(source.settings), source.createdAt, source.lastPushAt, source.ownerId, limit],
    )
    return result.changes > 0
  }

  async updateSource(id: string, ownerId: UserId, patch: { name?: string; settings?: Record<string, unknown> }): Promise<TelemetrySourceRecord | null> {
    const row = await this.x.first<SourceRow>(
      `UPDATE telemetry_sources SET name = COALESCE(?, name), settings_json = COALESCE(?, settings_json)
       WHERE id = ? AND owner_id = ? RETURNING ${SOURCE_COLS}`,
      [patch.name ?? null, patch.settings === undefined ? null : JSON.stringify(patch.settings), id, ownerId],
    )
    return row ? toSource(row) : null
  }

  async rotateKey(id: string, ownerId: UserId, keyHash: string): Promise<TelemetrySourceRecord | null> {
    const row = await this.x.first<SourceRow>(
      `UPDATE telemetry_sources SET key_hash = ? WHERE id = ? AND owner_id = ? RETURNING ${SOURCE_COLS}`, [keyHash, id, ownerId])
    return row ? toSource(row) : null
  }

  async deleteSource(id: string, ownerId: UserId): Promise<boolean> {
    const result = await this.x.run("DELETE FROM telemetry_sources WHERE id = ? AND owner_id = ?", [id, ownerId])
    if (result.changes === 0) return false
    // A purge cut short by the chunk cap leaves orphans; retention clears them.
    await this.purge("source_id = ?", [id])
    return true
  }

  async deleteSourcesByOwner(ownerId: UserId): Promise<void> {
    const ids = await this.x.all<{ id: string }>("SELECT id FROM telemetry_sources WHERE owner_id = ?", [ownerId])
    for (const { id } of ids) await this.deleteSource(id, ownerId)
  }

  async replaceHours(sourceId: string, points: readonly TelemetryPoint[], nowIso: string): Promise<boolean> {
    if (!this.x.batch) throw new Error("SqlExecutor.batch is required for telemetry")
    const hoursByMetric = new Map<string, Set<number>>()
    for (const point of points) {
      const hours = hoursByMetric.get(point.metric) ?? new Set<number>()
      hours.add(point.hour)
      hoursByMetric.set(point.metric, hours)
    }
    const statements: SqlStatement[] = []
    for (const [metric, hours] of hoursByMetric) {
      statements.push({ sql: DELETE_HOURS_SQL, binds: [sourceId, metric, JSON.stringify([...hours]), sourceId] })
    }
    for (let offset = 0; offset < points.length; offset += TELEMETRY_INSERT_CHUNK) {
      const rows = points.slice(offset, offset + TELEMETRY_INSERT_CHUNK).map(point => {
        const key = canonicalDims(point.dims)
        return { m: point.metric, h: point.hour, k: key, d: key === "" ? "{}" : key, v: point.value, u: point.unit }
      })
      statements.push({ sql: INSERT_ROWS_SQL, binds: [sourceId, JSON.stringify(rows), sourceId] })
    }
    statements.push({ sql: "UPDATE telemetry_sources SET last_push_at = ? WHERE id = ?", binds: [nowIso, sourceId] })
    const results = await this.x.batch(statements)
    return (results[results.length - 1]?.changes ?? 0) > 0
  }

  async listMetrics(sourceId: string, sinceHour: number): Promise<TelemetryMetricInfo[]> {
    const metrics = await this.x.all<{ metric: string; unit: TelemetryUnit; first_hour: number; last_hour: number }>(
      `SELECT metric, MAX(unit) AS unit, MIN(hour) AS first_hour, MAX(hour) AS last_hour FROM telemetry_points
       WHERE source_id = ? AND hour >= ? GROUP BY metric ORDER BY metric`, [sourceId, sinceHour])
    const keys = await this.x.all<{ metric: string; dim_key: string }>(
      `SELECT DISTINCT p.metric AS metric, j.key AS dim_key
       FROM telemetry_points p
       JOIN (SELECT metric, MAX(hour) AS last_hour FROM telemetry_points WHERE source_id = ? AND hour >= ? GROUP BY metric) m ON m.metric = p.metric,
            json_each(p.dims_json) AS j
       WHERE p.source_id = ? AND p.dims_key <> '' AND p.hour >= m.last_hour - 86400`, [sourceId, sinceHour, sourceId])
    const byMetric = new Map<string, string[]>()
    for (const row of keys) byMetric.set(row.metric, [...(byMetric.get(row.metric) ?? []), row.dim_key])
    return metrics.map(row => ({
      metric: row.metric, unit: row.unit, firstHour: Number(row.first_hour), lastHour: Number(row.last_hour),
      dimKeys: (byMetric.get(row.metric) ?? []).sort(),
    }))
  }

  async firstHour(sourceId: string, metric: string): Promise<number | null> {
    const row = await this.x.first<{ first_hour: number | null }>(
      "SELECT MIN(hour) AS first_hour FROM telemetry_points WHERE source_id = ? AND metric = ?", [sourceId, metric])
    return row?.first_hour === null || row?.first_hour === undefined ? null : Number(row.first_hour)
  }

  async hourlyTotals(sourceId: string, metrics: readonly string[], fromHour: number, toHour: number): Promise<TelemetryMetricHourValue[]> {
    if (metrics.length === 0) return []
    const rows = await this.x.all<{ metric: string; hour: number; value: number; unit: TelemetryUnit }>(
      `SELECT metric, hour, SUM(value) AS value, MAX(unit) AS unit FROM telemetry_points
       WHERE source_id = ? AND metric IN (SELECT value FROM json_each(?)) AND hour >= ? AND hour < ?
       GROUP BY metric, hour ORDER BY metric, hour`, [sourceId, JSON.stringify(metrics), fromHour, toHour])
    return rows.map(row => ({ metric: row.metric, hour: Number(row.hour), value: Number(row.value), unit: row.unit }))
  }

  async topGroups(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, limit: number) {
    const total = await this.x.first<{ total: number; unit: TelemetryUnit | null }>(
      `SELECT COALESCE(SUM(value), 0) AS total, MAX(unit) AS unit FROM telemetry_points
       WHERE source_id = ? AND metric = ? AND hour >= ? AND hour < ?`, [sourceId, metric, fromHour, toHour])
    const groups = await this.x.all<{ grp: string; total: number }>(
      `SELECT grp, SUM(value) AS total FROM (${GROUPED}) WHERE grp <> '(other)' GROUP BY grp ORDER BY total DESC, grp ASC LIMIT ?`,
      [`$.${groupBy}`, sourceId, metric, fromHour, toHour, limit])
    return {
      unit: total?.unit ?? null, total: Number(total?.total ?? 0),
      groups: groups.map((row): TelemetryGroupTotal => ({ key: row.grp, value: Number(row.total) })),
    }
  }

  async groupHours(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, keys: readonly string[]): Promise<TelemetryGroupHours[]> {
    if (keys.length === 0) return []
    const rows = await this.x.all<{ grp: string; hour: number; value: number }>(
      `SELECT grp, hour, SUM(value) AS value FROM (${GROUPED}) WHERE grp IN (SELECT value FROM json_each(?))
       GROUP BY grp, hour ORDER BY grp, hour`, [`$.${groupBy}`, sourceId, metric, fromHour, toHour, JSON.stringify(keys)])
    const byKey = new Map<string, TelemetryGroupHours>()
    for (const row of rows) {
      const entry = byKey.get(row.grp) ?? { key: row.grp, points: [] }
      entry.points.push({ hour: Number(row.hour), value: Number(row.value) })
      byKey.set(row.grp, entry)
    }
    return keys.flatMap(key => { const entry = byKey.get(key); return entry ? [entry] : [] })
  }

  async groupTotals(sourceId: string, metric: string, groupBy: string, fromHour: number, toHour: number, keys: readonly string[]): Promise<TelemetryGroupTotal[]> {
    if (keys.length === 0) return []
    const rows = await this.x.all<{ grp: string; total: number }>(
      `SELECT grp, SUM(value) AS total FROM (${GROUPED}) WHERE grp IN (SELECT value FROM json_each(?)) GROUP BY grp`,
      [`$.${groupBy}`, sourceId, metric, fromHour, toHour, JSON.stringify(keys)])
    return rows.map(row => ({ key: row.grp, value: Number(row.total) }))
  }

  async nonZeroRows(sourceId: string, metrics: readonly string[], fromHour: number, toHour: number, limit: number): Promise<TelemetryDimRow[]> {
    if (metrics.length === 0) return []
    const rows = await this.x.all<{ metric: string; hour: number; dims_json: string; value: number }>(
      `SELECT metric, hour, dims_json, value FROM telemetry_points
       WHERE source_id = ? AND metric IN (SELECT value FROM json_each(?)) AND hour >= ? AND hour < ? AND value > 0
       ORDER BY hour DESC, metric ASC, value DESC, dims_key ASC LIMIT ?`, [sourceId, JSON.stringify(metrics), fromHour, toHour, limit])
    return rows.map(row => ({ metric: row.metric, hour: Number(row.hour), dims: parseDims(row.dims_json), value: Number(row.value) }))
  }

  async hourContributors(sourceId: string, metric: string, hour: number, limit: number): Promise<TelemetryContribution[]> {
    const rows = await this.x.all<{ dims_json: string; value: number }>(
      `SELECT dims_json, value FROM telemetry_points WHERE source_id = ? AND metric = ? AND hour = ? AND dims_key <> ''
       ORDER BY value DESC, dims_key ASC LIMIT ?`, [sourceId, metric, hour, limit])
    return rows.map(row => ({ dims: parseDims(row.dims_json), value: Number(row.value) }))
  }

  async deleteExpired(nowMs: number): Promise<number> {
    const nowSec = Math.floor(nowMs / 1000)
    const withDims = nowSec - TELEMETRY_DIMS_RETENTION_DAYS * 86_400
    const plain = nowSec - TELEMETRY_PLAIN_RETENTION_DAYS * 86_400
    const expired = await this.purge("(dims_key = '' AND hour < ?) OR (dims_key <> '' AND hour < ?)", [plain, withDims])
    const orphans = await this.purge("source_id NOT IN (SELECT id FROM telemetry_sources)", [])
    return expired + orphans
  }

  /** Deletes matching rows in bounded chunks. Row-value IN keeps each statement on the primary key. */
  private async purge(where: string, binds: unknown[]): Promise<number> {
    let total = 0
    for (let chunk = 0; chunk < TELEMETRY_PURGE_MAX_CHUNKS; chunk++) {
      const result = await this.x.run(
        `DELETE FROM telemetry_points WHERE (source_id, metric, hour, dims_key) IN
           (SELECT source_id, metric, hour, dims_key FROM telemetry_points WHERE ${where} LIMIT ${TELEMETRY_PURGE_CHUNK})`, binds)
      total += result.changes
      if (result.changes < TELEMETRY_PURGE_CHUNK) break
    }
    return total
  }
}
```

- [ ] **Step 9: Wire the repository**

`packages/gateway/src/repo/types.ts`: add `import type { TelemetryRepo } from "./telemetry.ts"` next to the sync import, and add `telemetry: TelemetryRepo` after `syncSources: SyncSourceRepo` in `interface Repo`.

`packages/gateway/src/repo/index.ts`: after the sync type export add

```ts
export type { TelemetryPoint, TelemetryRepo, TelemetrySourceRecord, TelemetryUnit } from "./telemetry.ts"
```

`packages/gateway/src/repo/shared/repos.ts`: add `import { SharedTelemetryRepo } from "./telemetry.ts"` next to the sync import, and in `buildSharedRepo` add `telemetry: new SharedTelemetryRepo(x),` after the `syncSources` line.

In both `apps/platform-bun/src/bun-sqlite-repo.ts` and `apps/platform-cloudflare/src/d1-repo.ts`: add the field `telemetry: Repo["telemetry"]` after `syncSources: Repo["syncSources"]`, and `this.telemetry = shared.telemetry` after `this.syncSources = shared.syncSources`. (The D1 file declares the field types as `SyncSourceRepo`; use `Repo["telemetry"]` there too and make sure `Repo` is imported in that file, which `Repo["configurationRevision"]` already shows.)

Then find any other object literal typed as `Repo` that the compiler now rejects: `bun run typecheck 2>&1 | grep -i telemetry`. Test fakes cast through `as unknown as Repo`, so none is expected.

- [ ] **Step 10: Write the shared contract tests**

`packages/gateway/tests/telemetry-repo-contract.ts`:

```ts
import { expect, test } from "bun:test"
import type { UserId } from "../src/repo/branded-ids"
import type { TelemetryPoint, TelemetryRepo, TelemetrySourceRecord } from "../src/repo/telemetry"

const owner = "tlm-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const HOUR = 3600
const hex = (n: number, length: number) => n.toString(16).padStart(length, "0")
const BASE = Date.UTC(2026, 10, 10) / 1000

export const sourceId = (n: number) => `tls_${hex(n, 32)}`
export const source = (n: number, over: Partial<TelemetrySourceRecord> = {}): TelemetrySourceRecord => ({
  id: sourceId(n), ownerId: owner, name: `src ${n}`, keyHash: hex(n, 64), settings: {}, createdAt: stamp, lastPushAt: null, ...over,
})
export const point = (metric: string, hourOffset: number, value: number, dims: Record<string, string> = {}, unit: TelemetryPoint["unit"] = "bytes"): TelemetryPoint =>
  ({ metric, hour: BASE + hourOffset * HOUR, dims, value, unit })

/** Registers the same tests for every runtime. Each test owns its source ids, so one database can serve all of them. */
export function telemetryRepoContract(getRepo: () => TelemetryRepo, run: (sql: string, binds?: unknown[]) => Promise<void>) {
  test.serial("sources are created within the owner limit, unique by key hash, found by hash and scoped to their owner", async () => {
    const repo = getRepo()
    const other = "tlm-other" as UserId
    expect(await repo.createSourceWithinLimit(source(1), 2)).toBe(true)
    expect(await repo.createSourceWithinLimit(source(2), 2)).toBe(true)
    expect(await repo.createSourceWithinLimit(source(3), 2)).toBe(false)
    expect(await repo.createSourceWithinLimit(source(4, { ownerId: other }), 2)).toBe(true)
    await expect(repo.createSourceWithinLimit(source(5, { ownerId: "third" as UserId, keyHash: hex(1, 64) }), 2)).rejects.toThrow()
    expect((await repo.listSources(owner)).map(s => s.name)).toEqual(["src 1", "src 2"])
    expect((await repo.findSourceByKeyHash(hex(2, 64)))?.id).toBe(sourceId(2))
    expect(await repo.findSourceByKeyHash(hex(99, 64))).toBeNull()
    expect(await repo.updateSource(sourceId(1), other, { name: "x" })).toBeNull()
    expect(await repo.updateSource(sourceId(1), owner, { name: "Renamed" })).toMatchObject({ name: "Renamed", settings: {} })
    expect(await repo.updateSource(sourceId(1), owner, { settings: { surgeFactor: 4 } })).toMatchObject({ name: "Renamed", settings: { surgeFactor: 4 } })
    expect(await repo.updateSource(sourceId(1), owner, { settings: { budgetMetric: "m" } })).toMatchObject({ settings: { budgetMetric: "m" } })
    expect(await repo.rotateKey(sourceId(1), other, hex(70, 64))).toBeNull()
    expect(await repo.rotateKey(sourceId(1), owner, hex(71, 64))).toMatchObject({ keyHash: hex(71, 64) })
    expect(await repo.findSourceByKeyHash(hex(1, 64))).toBeNull()
    expect(await repo.findSourceByKeyHash(hex(71, 64))).toMatchObject({ id: sourceId(1) })
  })

  test.serial("a push replaces exactly the (metric, hour) pairs it contains and stamps last_push_at", async () => {
    const repo = getRepo()
    const id = sourceId(10)
    await repo.createSourceWithinLimit(source(10, { ownerId: "tlm-r" as UserId, keyHash: hex(10, 64) }), 16)
    expect(await repo.replaceHours(id, [
      point("proxy.sent_bytes", 0, 10, { user: "#1" }), point("proxy.sent_bytes", 0, 20, { user: "#2" }),
      point("proxy.sent_bytes", 1, 5, { user: "#1" }), point("nic.tx_bytes", 0, 99),
    ], "2026-11-16T01:00:00.000Z")).toBe(true)
    expect((await repo.getSource(id))?.lastPushAt).toBe("2026-11-16T01:00:00.000Z")
    // Recomputing hour 0 of proxy.sent_bytes drops user #2 and leaves hour 1 and the other metric alone.
    expect(await repo.replaceHours(id, [point("proxy.sent_bytes", 0, 7, { user: "#1" })], "2026-11-16T02:00:00.000Z")).toBe(true)
    const totals = await repo.hourlyTotals(id, ["proxy.sent_bytes", "nic.tx_bytes"], BASE, BASE + 5 * HOUR)
    expect(totals.map(t => [t.metric, t.hour - BASE, t.value, t.unit])).toEqual([
      ["nic.tx_bytes", 0, 99, "bytes"], ["proxy.sent_bytes", 0, 7, "bytes"], ["proxy.sent_bytes", HOUR, 5, "bytes"],
    ])
    expect((await repo.getSource(id))?.lastPushAt).toBe("2026-11-16T02:00:00.000Z")
    // A heartbeat only stamps.
    expect(await repo.replaceHours(id, [], "2026-11-16T03:00:00.000Z")).toBe(true)
    expect((await repo.getSource(id))?.lastPushAt).toBe("2026-11-16T03:00:00.000Z")
    expect((await repo.hourlyTotals(id, ["proxy.sent_bytes"], BASE, BASE + 5 * HOUR))).toHaveLength(2)
  })

  test.serial("a push for a missing source writes nothing and reports false", async () => {
    const repo = getRepo()
    const id = sourceId(11)
    expect(await repo.replaceHours(id, [point("m", 0, 1)], stamp)).toBe(false)
    expect(await repo.hourlyTotals(id, ["m"], BASE, BASE + HOUR)).toEqual([])
  })

  test.serial("a failing statement rolls the whole push back, including the deletes", async () => {
    const repo = getRepo()
    const id = sourceId(12)
    await repo.createSourceWithinLimit(source(12, { ownerId: "tlm-rb" as UserId, keyHash: hex(12, 64) }), 16)
    await repo.replaceHours(id, [point("m", 0, 5, { k: "keep" })], "2026-11-16T01:00:00.000Z")
    // The negative value violates CHECK (value >= 0) in the second chunk, after the DELETE and the first chunk succeeded.
    const rows = [point("m", 0, 1, { k: "new" }), ...Array.from({ length: 400 }, (_, i) => point("other", 1, 1, { k: `d${i}` })), point("other", 1, -1, { k: "bad" })]
    await expect(repo.replaceHours(id, rows, "2026-11-16T09:00:00.000Z")).rejects.toThrow()
    const kept = await repo.topGroups(id, "m", "k", BASE, BASE + HOUR, 5)
    expect(kept.groups).toEqual([{ key: "keep", value: 5 }])
    expect(await repo.hourlyTotals(id, ["other"], BASE, BASE + 5 * HOUR)).toEqual([])
    expect((await repo.getSource(id))?.lastPushAt).toBe("2026-11-16T01:00:00.000Z")
  })

  test.serial("more points than one insert chunk are all stored", async () => {
    const repo = getRepo()
    const id = sourceId(13)
    await repo.createSourceWithinLimit(source(13, { ownerId: "tlm-big" as UserId, keyHash: hex(13, 64) }), 16)
    const rows = Array.from({ length: 1000 }, (_, i) => point("big", 0, 1, { k: `v${String(i).padStart(4, "0")}` }))
    expect(await repo.replaceHours(id, rows, stamp)).toBe(true)
    expect((await repo.topGroups(id, "big", "k", BASE, BASE + HOUR, 1)).total).toBe(1000)
  })

  test.serial("grouped reads rank groups, keep the empty group, exclude (other) from the ranking and cover the previous period", async () => {
    const repo = getRepo()
    const id = sourceId(14)
    await repo.createSourceWithinLimit(source(14, { ownerId: "tlm-g" as UserId, keyHash: hex(14, 64) }), 16)
    await repo.replaceHours(id, [
      point("t", 0, 50, { user: "a", domain: "x.com" }), point("t", 0, 30, { user: "b", domain: "y.com" }),
      point("t", 0, 5, { user: "(other)", domain: "z.com" }), point("t", 0, 4, { domain: "only.com" }),
      point("t", 1, 10, { user: "a", domain: "x.com" }), point("t", 1, 60, { user: "b", domain: "y.com" }),
    ], stamp)
    const top = await repo.topGroups(id, "t", "user", BASE, BASE + 2 * HOUR, 2)
    expect(top).toEqual({ unit: "bytes", total: 159, groups: [{ key: "b", value: 90 }, { key: "a", value: 60 }] })
    const withEmpty = await repo.topGroups(id, "t", "user", BASE, BASE + 2 * HOUR, 10)
    expect(withEmpty.groups.map(g => g.key)).toEqual(["b", "a", ""])
    const hours = await repo.groupHours(id, "t", "user", BASE, BASE + 2 * HOUR, ["a", "b"])
    expect(hours).toEqual([
      { key: "a", points: [{ hour: BASE, value: 50 }, { hour: BASE + HOUR, value: 10 }] },
      { key: "b", points: [{ hour: BASE, value: 30 }, { hour: BASE + HOUR, value: 60 }] },
    ])
    expect(await repo.groupTotals(id, "t", "user", BASE + HOUR, BASE + 2 * HOUR, ["a", "b", "zzz"])).toEqual(
      expect.arrayContaining([{ key: "a", value: 10 }, { key: "b", value: 60 }]))
    expect(await repo.groupHours(id, "t", "user", BASE, BASE + HOUR, [])).toEqual([])
  })

  test.serial("metrics list units, first and last hour and the dim keys of the newest 24 hours", async () => {
    const repo = getRepo()
    const id = sourceId(15)
    await repo.createSourceWithinLimit(source(15, { ownerId: "tlm-m" as UserId, keyHash: hex(15, 64) }), 16)
    await repo.replaceHours(id, [
      point("p", 0, 1, { old: "x" }, "count"), point("p", 40, 1, { user: "a", domain: "d" }, "count"), point("lat", 3, 120, {}, "ms"),
    ], stamp)
    expect(await repo.listMetrics(id, BASE)).toEqual([
      { metric: "lat", unit: "ms", firstHour: BASE + 3 * HOUR, lastHour: BASE + 3 * HOUR, dimKeys: [] },
      { metric: "p", unit: "count", firstHour: BASE, lastHour: BASE + 40 * HOUR, dimKeys: ["domain", "user"] },
    ])
    expect(await repo.listMetrics(id, BASE + 10 * HOUR)).toHaveLength(1)
    expect(await repo.firstHour(id, "p")).toBe(BASE)
    expect(await repo.firstHour(id, "nope")).toBeNull()
  })

  test.serial("non-zero rows come newest first and contributors are the largest dimensioned rows", async () => {
    const repo = getRepo()
    const id = sourceId(16)
    await repo.createSourceWithinLimit(source(16, { ownerId: "tlm-n" as UserId, keyHash: hex(16, 64) }), 16)
    await repo.replaceHours(id, [
      point("probe.fail", 1, 1, { stage: "tls" }, "count"), point("probe.fail", 2, 0, { stage: "tcp" }, "count"), point("probe.fail", 3, 1, { stage: "http" }, "count"),
      ...Array.from({ length: 7 }, (_, i) => point("proxy", 5, 10 + i, { user: `u${i}` })), point("proxy", 5, 500),
    ], stamp)
    const rows = await repo.nonZeroRows(id, ["probe.fail"], BASE, BASE + 10 * HOUR, 10)
    expect(rows.map(r => [r.hour - BASE, r.dims.stage])).toEqual([[3 * HOUR, "http"], [HOUR, "tls"]])
    expect(await repo.nonZeroRows(id, ["probe.fail"], BASE, BASE + 10 * HOUR, 1)).toHaveLength(1)
    expect(await repo.nonZeroRows(id, [], BASE, BASE + HOUR, 5)).toEqual([])
    const top = await repo.hourContributors(id, "proxy", BASE + 5 * HOUR, 5)
    expect(top.map(c => c.dims.user)).toEqual(["u6", "u5", "u4", "u3", "u2"])
  })

  test.serial("deleting a source or its owner removes the row and its points", async () => {
    const repo = getRepo()
    const own = "tlm-del" as UserId
    const a = sourceId(17), b = sourceId(18)
    await repo.createSourceWithinLimit(source(17, { ownerId: own, keyHash: hex(17, 64) }), 16)
    await repo.createSourceWithinLimit(source(18, { ownerId: own, keyHash: hex(18, 64) }), 16)
    await repo.replaceHours(a, [point("m", 0, 1)], stamp)
    await repo.replaceHours(b, [point("m", 0, 2)], stamp)
    expect(await repo.deleteSource(a, "someone-else" as UserId)).toBe(false)
    expect(await repo.deleteSource(a, own)).toBe(true)
    expect(await repo.deleteSource(a, own)).toBe(false)
    expect(await repo.getSource(a)).toBeNull()
    expect(await repo.hourlyTotals(a, ["m"], BASE, BASE + HOUR)).toEqual([])
    expect(await repo.hourlyTotals(b, ["m"], BASE, BASE + HOUR)).toHaveLength(1)
    await repo.deleteSourcesByOwner(own)
    expect(await repo.listSources(own)).toEqual([])
    expect(await repo.hourlyTotals(b, ["m"], BASE, BASE + HOUR)).toEqual([])
  })

  test.serial("retention keeps 90 days of dimensioned and 400 days of plain points and clears orphans", async () => {
    const repo = getRepo()
    const id = sourceId(19)
    await repo.createSourceWithinLimit(source(19, { ownerId: "tlm-ret" as UserId, keyHash: hex(19, 64) }), 16)
    const now = Date.UTC(2027, 5, 1)
    const day = 86_400
    const at = (days: number) => Math.floor(now / 1000) - days * day
    const rowAt = (days: number, dims: Record<string, string>): TelemetryPoint => ({ metric: "r", hour: at(days) - (at(days) % HOUR), dims, value: 1, unit: "count" })
    // Hours are written directly so ages beyond the push-time limits can be tested.
    await run("DELETE FROM telemetry_points WHERE source_id = ?", [id])
    for (const row of [rowAt(89, { k: "v" }), rowAt(91, { k: "v" }), rowAt(399, {}), rowAt(401, {})]) {
      await run("INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit) VALUES (?, ?, ?, ?, ?, 1, 'count')",
        [id, row.metric, row.hour, Object.keys(row.dims).length ? JSON.stringify(row.dims) : "", Object.keys(row.dims).length ? JSON.stringify(row.dims) : "{}"])
    }
    await run("INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit) VALUES (?, 'r', ?, '', '{}', 1, 'count')", [`tls_${"f".repeat(32)}`, at(1)])
    expect(await repo.deleteExpired(now)).toBe(3)
    const left = await repo.hourlyTotals(id, ["r"], 0, at(0) + HOUR)
    expect(left.map(r => Math.round((at(0) - r.hour) / day))).toEqual([399, 89])
    expect(await repo.hourlyTotals(`tls_${"f".repeat(32)}`, ["r"], 0, at(0) + HOUR)).toEqual([])
    expect(await repo.deleteExpired(now)).toBe(0)
  })
}
```

Note the retention assertions: `rowAt` floors each hour, so ages round to whole days; the two surviving rows are the 399-day plain row and the 89-day dimensioned row, listed oldest first.

`packages/gateway/tests/telemetry-repo.sqlite.test.ts`:

```ts
import { afterAll, beforeAll } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { telemetryRepoContract } from "./telemetry-repo-contract"

let db: Database
let repo: BunSqliteRepo
beforeAll(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterAll(() => db.close())

telemetryRepoContract(() => repo.telemetry, async (sql, binds = []) => { db.run(sql, binds as never[]) })
```

`packages/gateway/tests/telemetry-repo.d1.test.ts` (mirrors `sync-repo.d1.test.ts` setup):

```ts
import { afterAll, beforeAll } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { D1Repo, type D1Database } from "@vibe-llm/platform-cloudflare/src/d1-repo.ts"
import { migrationsDir } from "../src/migrations-dir.ts"
import { telemetryRepoContract } from "./telemetry-repo-contract"

let dir: string
let mf: Miniflare
let repo: D1Repo
let d1: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> }; run(): Promise<unknown> } }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "telemetry-repo-d1-"))
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fixture') } }",
    host: "127.0.0.1", port: 0, compatibilityDate: "2025-06-01", d1Databases: { DB: "telemetry-repo" }, d1Persist: join(dir, "d1") })
  const db = await mf.getD1Database("DB")
  const source = fileURLToPath(migrationsDir)
  for (const name of readdirSync(source).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of unstable_splitSqlQuery(readFileSync(join(source, name), "utf8"))) await db.prepare(sql).run()
  }
  d1 = db as unknown as typeof d1
  repo = new D1Repo(db as unknown as D1Database)
})
afterAll(async () => { await mf?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true }) })

telemetryRepoContract(() => repo.telemetry, async (sql, binds = []) => { await (binds.length ? d1.prepare(sql).bind(...binds) : d1.prepare(sql)).run() })
```

- [ ] **Step 11: Run the repository tests**

```bash
bun test ./packages/gateway/tests/telemetry-repo.sqlite.test.ts
bun test ./packages/gateway/tests/telemetry-repo.d1.test.ts
```

Expected: PASS on both. If a D1 statement is rejected, the error names the SQL; fix the shared SQL rather than special-casing a runtime.

- [ ] **Step 12: Typecheck the touched packages**

Run: `bun run --filter '@vibe-llm/gateway' typecheck && bun run --filter '@vibe-llm/platform-bun' typecheck && bun run --filter '@vibe-llm/platform-cloudflare' typecheck`
Expected: no errors.

- [ ] **Step 13: Commit**

```bash
git add packages/gateway/migrations/0026_telemetry.sql packages/gateway/tests/schema-baseline.txt packages/gateway/tests/migrations.test.ts \
  packages/gateway/src/repo/telemetry.ts packages/gateway/src/repo/shared/telemetry.ts packages/gateway/src/repo/shared/executor.ts \
  packages/gateway/src/repo/types.ts packages/gateway/src/repo/index.ts packages/gateway/src/repo/shared/repos.ts \
  apps/platform-bun/src/bun-sqlite-repo.ts apps/platform-cloudflare/src/d1-repo.ts \
  packages/gateway/tests/telemetry-repo-contract.ts packages/gateway/tests/telemetry-repo.sqlite.test.ts packages/gateway/tests/telemetry-repo.d1.test.ts
git commit -m "$(cat <<'EOF'
feat(telemetry): add telemetry tables and atomic hour-replacing repositories

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 2: Push endpoint and `tlm_` rejection

**Files:**
- Create: `packages/gateway/src/control-plane/telemetry/common.ts`, `protocol.ts`, `push.ts`
- Modify: `packages/gateway/src/app.ts`, `packages/gateway/src/control-plane/auth/session-auth.ts`
- Create: `packages/gateway/tests/telemetry-push.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/gateway/tests/telemetry-push.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { telemetryPushRouter } from "../src/control-plane/telemetry/push"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "tlm-push-owner" as UserId
const hex = (n: number, length: number) => n.toString(16).padStart(length, "0")
const key = `tlm_${hex(1, 64)}`
const sourceId = `tls_${hex(1, 32)}`
const stamp = "2026-11-16T00:00:00.000Z"
const hourNow = Math.floor(Date.now() / 3_600_000) * 3600
const iso = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z")
const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

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
  await repo.users.create({ id: owner, name: owner, createdAt: stamp, disabled: false })
  await repo.sessions.create({ token: "ses_tlm_push" as SessionToken, userId: owner, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  await repo.telemetry.createSourceWithinLimit({ id: sourceId, ownerId: owner, name: "vm", keyHash: sha256(key), settings: {}, createdAt: stamp, lastPushAt: null }, 16)
  app = new Hono()
  app.route("/api/telemetry", telemetryPushRouter)
  app.use("*", sessionAuthMiddleware)
  app.get("/api/other", c => c.json({ ok: true }))
})
afterEach(() => { db.close(); __resetPlatformForTests() })

const point = (over: Record<string, unknown> = {}) => ({ metric: "proxy.sent_bytes", hour: iso(hourNow - 3600), dims: { user: "#1", domain: "example.com" }, value: 10, unit: "bytes", ...over })
const push = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${key}` }) =>
  app.request("https://gw.example/api/telemetry/push", { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body) })
const rows = () => db.query("SELECT metric, hour, dims_key, value, unit FROM telemetry_points ORDER BY metric, hour, dims_key").all()
const invalid = { error: { code: "invalid_key" } }

test("a valid push stores the points, stamps last_push_at and answers with the accepted count", async () => {
  const response = await push({ version: 1, points: [point(), point({ dims: { user: "#2", domain: "b.com" }, value: 5 }), point({ metric: "nic.tx_bytes", dims: undefined, value: 99 })] })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({ accepted: 3 })
  expect(rows()).toHaveLength(3)
  expect(db.query<{ dims_key: string }, []>("SELECT dims_key FROM telemetry_points WHERE metric = 'proxy.sent_bytes' ORDER BY dims_key LIMIT 1").get()?.dims_key)
    .toBe('{"domain":"example.com","user":"#1"}')
  expect((await repo.telemetry.getSource(sourceId))?.lastPushAt).not.toBeNull()
})

test("a second push replaces the hours it contains and an empty push only stamps", async () => {
  await push({ version: 1, points: [point(), point({ dims: { user: "#2", domain: "b.com" }, value: 5 })] })
  await push({ version: 1, points: [point({ value: 7 })] })
  expect(rows().map(r => (r as { value: number }).value)).toEqual([7])
  const before = (await repo.telemetry.getSource(sourceId))?.lastPushAt
  await new Promise(resolve => setTimeout(resolve, 5))
  expect((await push({ version: 1, points: [] })).status).toBe(200)
  expect(rows()).toHaveLength(1)
  expect((await repo.telemetry.getSource(sourceId))?.lastPushAt).not.toBe(before)
})

test.each([
  ["no header", {}],
  ["a malformed scheme", { authorization: `Token ${key}` }],
  ["a short key", { authorization: "Bearer tlm_abc" }],
  ["an unknown key", { authorization: `Bearer tlm_${hex(2, 64)}` }],
  ["a session token", { authorization: "Bearer ses_tlm_push" }],
  ["an inference key header", { "x-api-key": key }],
])("%s answers the uniform 401 invalid_key", async (_name, headers) => {
  const response = await push({ version: 1, points: [point()] }, headers)
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual(invalid)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(rows()).toHaveLength(0)
})

test("the scheme is case-insensitive, a disabled owner and a deleted source are refused", async () => {
  expect((await push({ version: 1, points: [] }, { authorization: `bEaReR ${key}` })).status).toBe(200)
  await repo.users.update(owner, { disabled: true })
  expect(await (await push({ version: 1, points: [] })).json()).toEqual(invalid)
  await repo.users.update(owner, { disabled: false })
  await repo.telemetry.deleteSource(sourceId, owner)
  expect(await (await push({ version: 1, points: [] })).json()).toEqual(invalid)
})

test("authentication happens before the body is read, and an oversized body is 413", async () => {
  const huge = JSON.stringify({ version: 1, points: [], pad: "x".repeat(2 * 1024 * 1024 + 1) })
  expect((await push(huge, { authorization: `Bearer tlm_${hex(2, 64)}` })).status).toBe(401)
  const response = await push(huge)
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ error: { code: "body_too_large" } })
})

const day = 86_400
const many = (count: number, make: (i: number) => Record<string, unknown>) => Array.from({ length: count }, (_, i) => point(make(i)))
test.each([
  ["not JSON", "{nope"],
  ["an array body", []],
  ["version 2", { version: 2, points: [] }],
  ["an unknown top-level field", { version: 1, points: [], extra: 1 }],
  ["points not an array", { version: 1, points: {} }],
  ["an unknown point field", { version: 1, points: [point({ extra: 1 })] }],
  ["a bad metric name", { version: 1, points: [point({ metric: "Bad-Name" })] }],
  ["a metric over 64 characters", { version: 1, points: [point({ metric: `a${"b".repeat(64)}` })] }],
  ["an hour not at the top of an hour", { version: 1, points: [point({ hour: iso(hourNow - 3600).replace(":00:00Z", ":30:00Z") })] }],
  ["a non-ISO hour", { version: 1, points: [point({ hour: 12345 })] }],
  ["an hour more than one hour ahead", { version: 1, points: [point({ hour: iso(hourNow + 2 * 3600) })] }],
  ["a dimensioned point older than 90 days", { version: 1, points: [point({ hour: iso(hourNow - 91 * day) })] }],
  ["a plain point older than 400 days", { version: 1, points: [point({ dims: undefined, hour: iso(hourNow - 401 * day) })] }],
  ["a negative value", { version: 1, points: [point({ value: -1 })] }],
  ["a value over 1e15", { version: 1, points: [point({ value: 1e15 + 1 })] }],
  ["a string value", { version: 1, points: [point({ value: "1" })] }],
  ["an unknown unit", { version: 1, points: [point({ unit: "seconds" })] }],
  ["four dims", { version: 1, points: [point({ dims: { a: "1", b: "2", c: "3", d: "4" } })] }],
  ["a bad dim key", { version: 1, points: [point({ dims: { Bad: "1" } })] }],
  ["an empty dim value", { version: 1, points: [point({ dims: { user: "" } })] }],
  ["a dim value over 256 characters", { version: 1, points: [point({ dims: { user: "x".repeat(257) } })] }],
  ["a non-string dim value", { version: 1, points: [point({ dims: { user: 1 } })] }],
  ["a duplicate (metric, hour, dims)", { version: 1, points: [point(), point()] }],
  ["two units for one metric", { version: 1, points: [point(), point({ dims: { user: "#9", domain: "z.com" }, unit: "count" })] }],
  ["more than 20 metrics", { version: 1, points: many(21, i => ({ metric: `m${i}`, dims: undefined })) }],
  ["more than 168 distinct hours", { version: 1, points: many(169, i => ({ hour: iso(hourNow - (i + 1) * 3600), dims: undefined })) }],
  ["more than 20000 points", { version: 1, points: many(20_001, i => ({ metric: "big", dims: { u: String(i) }, value: 1, unit: "count" })) }],
])("%s is a 400 invalid_request and stores nothing", async (_name, body) => {
  const response = await push(body)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: { code: "invalid_request" } })
  expect(rows()).toHaveLength(0)
})

test("168 hours, 20 metrics and 20000 points are accepted at the limits", async () => {
  expect((await push({ version: 1, points: many(168, i => ({ hour: iso(hourNow - (i + 1) * 3600), dims: undefined })) })).status).toBe(200)
  expect((await push({ version: 1, points: many(20, i => ({ metric: `m${i}`, dims: undefined })) })).status).toBe(200)
  // Short names keep 20 000 points under the 2 MiB body limit.
  const big = Array.from({ length: 20_000 }, (_, i) => point({ metric: "big", dims: { u: String(i) }, hour: iso(hourNow - 7200), value: 1, unit: "count" }))
  expect((await push({ version: 1, points: big })).status).toBe(200)
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_points WHERE metric = 'big'").get()?.n).toBe(20_000)
})

test("a tlm_ credential is refused by every other route, whichever header carries it", async () => {
  for (const headers of [{ authorization: `Bearer ${key}` }, { "x-api-key": key }]) {
    const response = await app.request("https://gw.example/api/other", { headers })
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual(invalid)
  }
  expect((await app.request("https://gw.example/api/other?key=" + key)).status).toBe(401)
  expect((await app.request("https://gw.example/api/other", { headers: { authorization: "Bearer ses_tlm_push" } })).status).toBe(200)
})
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test ./packages/gateway/tests/telemetry-push.test.ts`
Expected: FAIL (cannot resolve `../src/control-plane/telemetry/push`).

- [ ] **Step 3: Write `common.ts`**

`packages/gateway/src/control-plane/telemetry/common.ts`:

```ts
export class TelemetryError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code) }
}

export const telemetryJson = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
})

/** Known errors keep their code; anything else is a uniform transient failure that leaks nothing. */
export function telemetryFailure(error: unknown): Response {
  if (error instanceof TelemetryError) return telemetryJson({ error: { code: error.code } }, error.status)
  return telemetryJson({ error: { code: "temporarily_unavailable" } }, 503)
}

/** Reads at most `maxBytes` of UTF-8 JSON; the limit is enforced while streaming. */
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new TelemetryError("body_too_large", 413)
  if (!request.body) throw new TelemetryError("invalid_request", 400)
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) throw new TelemetryError("body_too_large", 413)
      chunks.push(value)
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown }
  catch { throw new TelemetryError("invalid_request", 400) }
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")
}

export const randomHex = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, "0")).join("")

/** The clock the routes read; tests replace `now`. */
export const telemetryClock = { now: () => Date.now() }
```

- [ ] **Step 4: Write `protocol.ts`**

`packages/gateway/src/control-plane/telemetry/protocol.ts`:

```ts
import { z } from "zod"
import {
  TELEMETRY_DIMS_RETENTION_DAYS, TELEMETRY_PLAIN_RETENTION_DAYS, TELEMETRY_UNITS, canonicalDims,
  type TelemetryPoint, type TelemetryUnit,
} from "../../repo/telemetry"
import { TelemetryError } from "./common"

export const PUSH_LIMITS = { bodyBytes: 2 * 1024 * 1024, points: 20_000, metrics: 20, hours: 168, value: 1e15 } as const
export const MAX_SOURCES_PER_OWNER = 16
export const SETTINGS_MAX_BYTES = 32 * 1024
export const MAX_WINDOW_DAYS = 90

export const METRIC_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
export const DIM_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
export const SOURCE_ID_PATTERN = /^tls_[a-f0-9]{32}$/
export const PUSH_KEY_PATTERN = /^tlm_[a-f0-9]{64}$/
const HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00Z$/

export const isMetricName = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 64 && METRIC_PATTERN.test(value)

/** Unix seconds of an ISO hour at the top of an hour (`2026-11-16T13:00:00Z`), or null. */
export function parseHour(value: unknown): number | null {
  if (typeof value !== "string" || !HOUR_PATTERN.test(value)) return null
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || new Date(ms).toISOString().replace(".000Z", "Z") !== value) return null
  return ms / 1000
}

export const formatHour = (seconds: number): string => new Date(seconds * 1000).toISOString().replace(".000Z", "Z")

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const bad = () => new TelemetryError("invalid_request", 400)

function parseDims(value: unknown): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value)) throw bad()
  const entries = Object.entries(value)
  if (entries.length > 3) throw bad()
  const dims: Record<string, string> = {}
  for (const [key, dim] of entries) {
    if (!DIM_KEY_PATTERN.test(key) || typeof dim !== "string" || dim.length < 1 || dim.length > 256) throw bad()
    dims[key] = dim
  }
  return dims
}

/** Validates a push body into points. Throws `TelemetryError("invalid_request", 400)` on anything out of bounds. */
export function parsePushBody(body: unknown, nowMs: number): TelemetryPoint[] {
  if (!isRecord(body) || Object.keys(body).some(key => key !== "version" && key !== "points")) throw bad()
  if (body.version !== 1 || !Array.isArray(body.points) || body.points.length > PUSH_LIMITS.points) throw bad()
  const nowSec = Math.floor(nowMs / 1000)
  const points: TelemetryPoint[] = []
  const seen = new Set<string>()
  const units = new Map<string, TelemetryUnit>()
  const hours = new Set<number>()
  for (const raw of body.points as unknown[]) {
    if (!isRecord(raw) || Object.keys(raw).some(key => !["metric", "hour", "dims", "value", "unit"].includes(key))) throw bad()
    if (!isMetricName(raw.metric)) throw bad()
    const hour = parseHour(raw.hour)
    if (hour === null) throw bad()
    const dims = parseDims(raw.dims)
    if (typeof raw.value !== "number" || !Number.isFinite(raw.value) || raw.value < 0 || raw.value > PUSH_LIMITS.value) throw bad()
    if (typeof raw.unit !== "string" || !(TELEMETRY_UNITS as readonly string[]).includes(raw.unit)) throw bad()
    const unit = raw.unit as TelemetryUnit
    const retentionDays = Object.keys(dims).length > 0 ? TELEMETRY_DIMS_RETENTION_DAYS : TELEMETRY_PLAIN_RETENTION_DAYS
    if (hour > nowSec + 3600 || hour < nowSec - retentionDays * 86_400) throw bad()
    if (units.get(raw.metric) !== undefined && units.get(raw.metric) !== unit) throw bad()
    units.set(raw.metric, unit)
    const identity = `${raw.metric}\u0000${hour}\u0000${canonicalDims(dims)}`
    if (seen.has(identity)) throw bad()
    seen.add(identity)
    hours.add(hour)
    if (units.size > PUSH_LIMITS.metrics || hours.size > PUSH_LIMITS.hours) throw bad()
    points.push({ metric: raw.metric, hour, dims, value: raw.value, unit })
  }
  return points
}

const metricName = z.string().max(64).regex(METRIC_PATTERN)
const gb = z.number().min(0).max(1e9)
export const settingsSchema = z.object({
  budgetMetric: metricName.optional(),
  monthlyLimit: z.number().positive().max(1e15).optional(),
  pricePerGB: z.number().min(0).max(1e6).optional(),
  freeGB: gb.optional(),
  surgeMetrics: z.array(metricName).max(10).optional(),
  surgeFactor: z.number().gt(1).max(1000).optional(),
  surgeMinBytes: z.number().min(0).max(1e15).optional(),
  surgeMinCount: z.number().min(0).max(1e15).optional(),
  flagNonZeroMetrics: z.array(metricName).max(20).optional(),
  checkMetrics: z.array(metricName).max(20).optional(),
  labels: z.record(z.string().regex(DIM_KEY_PATTERN), z.record(z.string().min(1).max(256), z.string().min(1).max(64)))
    .refine(value => Object.keys(value).length <= 8).optional(),
  staleAfterHours: z.number().int().min(1).max(720).optional(),
}).strict()
export type TelemetrySettings = z.infer<typeof settingsSchema>

/** The stored settings, or `{}` when the stored object no longer validates. */
export function settingsOf(record: { settings: Record<string, unknown> }): TelemetrySettings {
  const parsed = settingsSchema.safeParse(record.settings)
  return parsed.success ? parsed.data : {}
}

export interface QueryWindow { from: number; to: number }

/** `from` inclusive, `to` exclusive, both hour-aligned ISO. Default: the last 24 hours through the current hour. At most 90 days. */
export function parseWindow(fromParam: string | undefined, toParam: string | undefined, nowSec: number): QueryWindow {
  const to = toParam === undefined ? Math.floor(nowSec / 3600) * 3600 + 3600 : parseHour(toParam)
  if (to === null) throw bad()
  const from = fromParam === undefined ? to - 24 * 3600 : parseHour(fromParam)
  if (from === null || to <= from || to - from > MAX_WINDOW_DAYS * 86_400) throw bad()
  return { from, to }
}
```

- [ ] **Step 5: Write `push.ts`**

`packages/gateway/src/control-plane/telemetry/push.ts`:

```ts
import { Hono } from "hono"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import { TelemetryError, readBoundedJson, sha256Hex, telemetryClock, telemetryFailure, telemetryJson } from "./common"
import { PUSH_KEY_PATTERN, PUSH_LIMITS, parsePushBody } from "./protocol"

/** Mounted before session auth: the push key is the only credential this route knows. */
export const telemetryPushRouter = new Hono<{ Bindings: Env }>()

const invalidKey = () => new TelemetryError("invalid_key", 401)

telemetryPushRouter.post("/push", async c => {
  try {
    const key = /^[Bb][Ee][Aa][Rr][Ee][Rr] (tlm_[a-f0-9]{64})$/.exec(c.req.header("authorization") ?? "")?.[1]
    if (!key || !PUSH_KEY_PATTERN.test(key)) throw invalidKey()
    const repo = getRepo()
    const source = await repo.telemetry.findSourceByKeyHash(await sha256Hex(key))
    if (!source) throw invalidKey()
    const owner = await repo.users.getById(source.ownerId)
    if (!owner || owner.disabled) throw invalidKey()

    // Authenticated: only now is the body read.
    const now = telemetryClock.now()
    const points = parsePushBody(await readBoundedJson(c.req.raw, PUSH_LIMITS.bodyBytes), now)
    if (!(await repo.telemetry.replaceHours(source.id, points, new Date(now).toISOString()))) throw invalidKey()
    return telemetryJson({ accepted: points.length })
  } catch (error) { return telemetryFailure(error) }
})
```

- [ ] **Step 6: Mount the router and reject `tlm_` elsewhere**

In `packages/gateway/src/app.ts`, add next to the other imports `import { telemetryPushRouter } from './control-plane/telemetry/push.ts'` and, directly after `app.route('/api/sync', syncSnapshotRouter)`, add:

```ts
app.route('/api/telemetry', telemetryPushRouter)
```

In `packages/gateway/src/control-plane/auth/session-auth.ts`, directly after the `sds_` block add:

```ts
  // Telemetry push keys are accepted only by the push endpoint, which is mounted before this middleware.
  if (key?.startsWith('tlm_')) {
    return c.json({ error: { code: 'invalid_key' } }, 401, { 'Cache-Control': 'no-store' })
  }
```

Telemetry views never need a Copilot token, so skip that lookup for them the way Loki management does. In the same file replace

```ts
  const lokiManagement = c.req.path.startsWith('/api/loki/')
  if (ctx && resolvedUserId && !hasConfigurationSnapshot() && !credentialManagementPath && !quotaObservationPath && !capabilityRead && !setupManagement && !lokiManagement) {
```

with

```ts
  const lokiManagement = c.req.path.startsWith('/api/loki/')
  const telemetryManagement = c.req.path.startsWith('/api/telemetry/')
  if (ctx && resolvedUserId && !hasConfigurationSnapshot() && !credentialManagementPath && !quotaObservationPath && !capabilityRead && !setupManagement && !lokiManagement && !telemetryManagement) {
```

- [ ] **Step 7: Run the tests**

Run: `bun test ./packages/gateway/tests/telemetry-push.test.ts ./packages/gateway/tests/sync-snapshot.sqlite.test.ts`
Expected: PASS (the second file proves the neighbouring mount still works).

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/control-plane/telemetry/common.ts packages/gateway/src/control-plane/telemetry/protocol.ts \
  packages/gateway/src/control-plane/telemetry/push.ts packages/gateway/src/app.ts packages/gateway/src/control-plane/auth/session-auth.ts \
  packages/gateway/tests/telemetry-push.test.ts
git commit -m "$(cat <<'EOF'
feat(telemetry): add the push endpoint with push-only tlm_ keys

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Task 3: Source management and the install command

**Files:**
- Create: `packages/gateway/src/control-plane/telemetry/agent-release.ts`, `sources.ts`, `routes.ts`
- Modify: `packages/gateway/src/control-plane/shared/session-guard.ts`
- Modify: `packages/gateway/src/control-plane/routes.ts`, `packages/gateway/src/control-plane/auth/routes.ts`, `packages/gateway/tests/control-plane-auth.test.ts`
- Create: `packages/gateway/tests/telemetry-agent-release.test.ts`, `packages/gateway/tests/telemetry-sources.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/gateway/tests/telemetry-agent-release.test.ts`:

```ts
import { expect, test } from "bun:test"
import { TELEMETRY_AGENT_VERSION, TELEMETRY_RELEASE_TAG, installCommand, shellQuote } from "../src/control-plane/telemetry/agent-release"

test("shell quoting wraps values in single quotes and escapes embedded quotes", () => {
  expect(shellQuote("plain")).toBe("'plain'")
  expect(shellQuote("it's")).toBe(`'it'\\''s'`)
  expect(shellQuote("a b$c`d\"e")).toBe("'a b$c`d\"e'")
})

test("the install command pins the release and passes the gateway and key as quoted environment values", () => {
  const key = `tlm_${"a".repeat(64)}`
  const command = installCommand("https://gw.example", key)
  expect(TELEMETRY_RELEASE_TAG).toBe(`telemetry-agent-v${TELEMETRY_AGENT_VERSION}`)
  expect(command).toBe(
    `curl -fsSL https://github.com/xuangong/copilot-api-gateway/releases/download/${TELEMETRY_RELEASE_TAG}/install.sh | sudo TELEMETRY_GATEWAY='https://gw.example' TELEMETRY_KEY='${key}' bash`)
})
```

`packages/gateway/tests/telemetry-sources.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { telemetryManagementRouter } from "../src/control-plane/telemetry/routes"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "tlm-owner" as UserId
const other = "tlm-other" as UserId
const admin = "tlm-admin" as UserId
const tokens = { [owner]: "ses_tlm_owner", [other]: "ses_tlm_other", [admin]: "ses_tlm_admin" } as Record<string, string>
const stamp = "2026-11-16T00:00:00.000Z"
let db: Database
let repo: BunSqliteRepo
let app: Hono

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

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
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/telemetry", telemetryManagementRouter)
})
afterEach(() => { db.close(); __resetPlatformForTests() })

function call(path: string, method: string, body?: unknown, user: UserId = owner, base = "https://gw.example") {
  return app.request(`${base}/api/telemetry${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
interface Created { source: { id: string; name: string; createdAt: string; lastPushAt: string | null; settings: Record<string, unknown> }; key: string; install: string }
const create = async (name = "trojan-vm", user: UserId = owner) => (await (await call("/sources", "POST", { name }, user)).json()) as Created

test("an owner creates a source once: the key is shown once and only its hash is stored", async () => {
  const response = await call("/sources", "POST", { name: " trojan-vm " })
  expect(response.status).toBe(201)
  expect(response.headers.get("cache-control")).toBe("no-store")
  const { source, key, install } = await response.json() as Created
  expect(source).toMatchObject({ name: "trojan-vm", lastPushAt: null, settings: {} })
  expect(source.id).toMatch(/^tls_[a-f0-9]{32}$/)
  expect(key).toMatch(/^tlm_[a-f0-9]{64}$/)
  expect(install).toContain("TELEMETRY_GATEWAY='https://gw.example'")
  expect(install).toContain(`TELEMETRY_KEY='${key}'`)
  expect(JSON.stringify(db.query("SELECT * FROM telemetry_sources").all())).not.toContain(key)
  expect(db.query<{ key_hash: string }, []>("SELECT key_hash FROM telemetry_sources").get()?.key_hash).toBe(sha256(key))
  const listed = await (await call("/sources", "GET")).text()
  expect(listed).not.toContain(key)
  expect(listed).not.toContain("keyHash")
  expect(JSON.parse(listed)).toEqual({ sources: [source] })
})

test("creation needs HTTPS, a valid body and respects the 16 source limit", async () => {
  const plain = await call("/sources", "POST", { name: "x" }, owner, "http://gw.example")
  expect(plain.status).toBe(400)
  expect(await plain.json()).toEqual({ error: { code: "https_required" } })
  for (const body of [{}, { name: "" }, { name: "x".repeat(65) }, { name: "a", extra: 1 }, "nope"]) {
    const response = await call("/sources", "POST", body)
    expect(response.status).toBe(400)
  }
  for (let i = 0; i < 16; i++) expect((await call("/sources", "POST", { name: `s${i}` })).status).toBe(201)
  const over = await call("/sources", "POST", { name: "one too many" })
  expect(over.status).toBe(409)
  expect(await over.json()).toEqual({ error: { code: "source_limit" } })
  expect((await call("/sources", "POST", { name: "mine" }, other)).status).toBe(201)
})

test("patch renames and replaces the whole settings object, validating it strictly", async () => {
  const { source } = await create()
  const renamed = await (await call(`/sources/${source.id}`, "PATCH", { name: "Azure VM" })).json() as { source: Created["source"] }
  expect(renamed.source.name).toBe("Azure VM")
  const first = await (await call(`/sources/${source.id}`, "PATCH", { settings: { budgetMetric: "nic.tx_bytes", monthlyLimit: 1e12, surgeFactor: 4 } })).json() as { source: Created["source"] }
  expect(first.source.settings).toEqual({ budgetMetric: "nic.tx_bytes", monthlyLimit: 1e12, surgeFactor: 4 })
  const second = await (await call(`/sources/${source.id}`, "PATCH", { settings: { checkMetrics: ["probe.ok"], labels: { user: { "#1": "MacBook" } } } })).json() as { source: Created["source"] }
  expect(second.source.settings).toEqual({ checkMetrics: ["probe.ok"], labels: { user: { "#1": "MacBook" } } })
  for (const body of [
    {}, { name: "" }, { extra: 1 }, { settings: { unknown: 1 } }, { settings: { surgeFactor: 1 } }, { settings: { monthlyLimit: -5 } },
    { settings: { budgetMetric: "Bad Name" } }, { settings: { flagNonZeroMetrics: Array.from({ length: 21 }, (_, i) => `m${i}`) } },
    { settings: { staleAfterHours: 0 } }, { settings: { labels: { Bad: { a: "b" } } } },
    { settings: { labels: { user: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`value-${i}`.padEnd(120, "x"), "y".repeat(60)])) } } },
  ]) {
    const response = await call(`/sources/${source.id}`, "PATCH", body)
    expect(response.status).toBe(400)
  }
  expect((await call(`/sources/${source.id}`, "GET")).status).toBe(404)
})

test("rotating issues a new key, retires the old one and needs HTTPS", async () => {
  const { source, key } = await create()
  const rotated = await call(`/sources/${source.id}/rotate-key`, "POST")
  expect(rotated.status).toBe(200)
  const { key: next, install } = await rotated.json() as { key: string; install: string }
  expect(next).toMatch(/^tlm_[a-f0-9]{64}$/)
  expect(next).not.toBe(key)
  expect(install).toContain(next)
  expect(await repo.telemetry.findSourceByKeyHash(sha256(key))).toBeNull()
  expect((await repo.telemetry.findSourceByKeyHash(sha256(next)))?.id).toBe(source.id)
  const plain = await call(`/sources/${source.id}/rotate-key`, "POST", undefined, owner, "http://gw.example")
  expect(await plain.json()).toEqual({ error: { code: "https_required" } })
})

test("delete removes the source and its points and answers with the remaining list", async () => {
  const first = await create("a")
  const second = await create("b")
  await repo.telemetry.replaceHours(first.source.id, [{ metric: "m", hour: 3600, dims: {}, value: 1, unit: "count" }], stamp)
  const response = await call(`/sources/${first.source.id}`, "DELETE")
  expect(response.status).toBe(200)
  expect(((await response.json()) as { sources: Array<{ id: string }> }).sources.map(s => s.id)).toEqual([second.source.id])
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_points").get()?.n).toBe(0)
  expect((await call(`/sources/${first.source.id}`, "DELETE")).status).toBe(404)
})

test("only the owner may manage a source: other users and administrators get 404 source_not_found", async () => {
  const { source } = await create()
  for (const user of [other, admin]) {
    for (const [path, method, body] of [
      [`/sources/${source.id}`, "PATCH", { name: "x" }], [`/sources/${source.id}/rotate-key`, "POST", undefined], [`/sources/${source.id}`, "DELETE", undefined],
    ] as const) {
      const response = await call(path, method, body, user)
      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: { code: "source_not_found" } })
    }
    expect(((await (await call("/sources", "GET", undefined, user)).json()) as { sources: unknown[] }).sources).toEqual([])
  }
  expect((await call("/sources/not-an-id", "DELETE")).status).toBe(404)
})

test("management needs a real browser session: no credential, a tlm_ key and a key query parameter are refused", async () => {
  expect((await app.request("https://gw.example/api/telemetry/sources")).status).toBe(401)
  const { key } = await create()
  const withKey = await app.request("https://gw.example/api/telemetry/sources", { headers: { authorization: `Bearer ${key}` } })
  expect(withKey.status).toBe(401)
  expect(await withKey.json()).toEqual({ error: { code: "invalid_key" } })
  // Read-only views take filters in the query string, but a `key` parameter would be read by session-auth as a credential.
  expect((await app.request("https://gw.example/api/telemetry/sources?key=ses_tlm_other", { headers: { authorization: `Bearer ${tokens[owner]}` } })).status).toBe(401)
  expect((await app.request("https://gw.example/api/telemetry/sources?x=1", { headers: { authorization: `Bearer ${tokens[owner]}` } })).status).toBe(200)
})
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test ./packages/gateway/tests/telemetry-agent-release.test.ts ./packages/gateway/tests/telemetry-sources.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write `agent-release.ts`**

`packages/gateway/src/control-plane/telemetry/agent-release.ts`:

```ts
/**
 * The agent release this gateway's install command pins. Kept equal to `tools/trojan-telemetry/VERSION` and to the agent's
 * `AGENT_VERSION` by `tests/telemetry-agent-release-consistency.test.ts` and by the release workflow.
 */
export const TELEMETRY_AGENT_VERSION = "1.0.0"
export const TELEMETRY_RELEASE_TAG = `telemetry-agent-v${TELEMETRY_AGENT_VERSION}`
export const TELEMETRY_RELEASE_BASE = `https://github.com/xuangong/copilot-api-gateway/releases/download/${TELEMETRY_RELEASE_TAG}`

/** POSIX single quoting: safe for any value, including embedded quotes. */
export const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export function installCommand(gatewayOrigin: string, key: string): string {
  return `curl -fsSL ${TELEMETRY_RELEASE_BASE}/install.sh | sudo TELEMETRY_GATEWAY=${shellQuote(gatewayOrigin)} TELEMETRY_KEY=${shellQuote(key)} bash`
}
```

- [ ] **Step 3b: Let read-only views carry a query string**

`requireBrowserSession` refuses any query string, which suits the sync routes but not telemetry views that take `from`, `to`, `metric` and so on. Add a variant with the same rules that only refuses a `key` parameter (session-auth reads `?key=` as a credential). Replace `packages/gateway/src/control-plane/shared/session-guard.ts` with the following (the guard body is unchanged except for the query rule):

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
function browserSessionGuard(allowQuery: boolean): MiddlewareHandler {
  return async (c, next) => {
    const auth = c.get("auth") as FullAuthCtx | undefined
    if (auth?.authKind !== "session" || !auth.userId || auth.apiKeyId) return deny(401, "session_required")
    const url = new URL(c.req.url)
    const headers = c.req.raw.headers
    const authorization = headers.get("authorization")
    const token = authorization !== null ? /^Bearer (ses_[^\s]+)$/i.exec(authorization)?.[1]
      : /(?:^|;\s*)session_token=(ses_[^\s;]+)/.exec(headers.get("cookie") ?? "")?.[1]
    const queryRefused = allowQuery ? url.searchParams.has("key") : url.search !== ""
    if (!token || token.length > 4096 || queryRefused || headers.has("x-api-key") || headers.has("x-goog-api-key")) {
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
}

export const requireBrowserSession: MiddlewareHandler = browserSessionGuard(false)
/** The same rules for read-only views that take filters; a `key` query parameter is still refused. */
export const requireBrowserSessionAllowingQuery: MiddlewareHandler = browserSessionGuard(true)
```

Run `bun test ./packages/gateway/tests/sync-devices.sqlite.test.ts` afterwards: the sync and Loki routes keep the strict variant.

- [ ] **Step 4: Write `sources.ts` and `routes.ts`**

`packages/gateway/src/control-plane/telemetry/sources.ts`:

```ts
import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import type { UserId } from "../../repo/branded-ids"
import type { TelemetrySourceRecord } from "../../repo/telemetry"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { installCommand } from "./agent-release"
import { TelemetryError, randomHex, readBoundedJson, sha256Hex, telemetryFailure, telemetryJson } from "./common"
import { MAX_SOURCES_PER_OWNER, SETTINGS_MAX_BYTES, SOURCE_ID_PATTERN, settingsSchema } from "./protocol"

export const telemetrySourcesRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

const name = z.string().trim().min(1).max(64)
const createBody = z.object({ name }).strict()
const patchBody = z.object({ name: name.optional(), settings: settingsSchema.optional() }).strict()
  .refine(body => body.name !== undefined || body.settings !== undefined)

export const publicSource = (source: TelemetrySourceRecord) => ({
  id: source.id, name: source.name, createdAt: source.createdAt, lastPushAt: source.lastPushAt, settings: source.settings,
})

async function parseBody<S extends z.ZodType>(request: Request, schema: S, maxBytes = 65_536): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await readBoundedJson(request, maxBytes))
  if (!parsed.success) throw new TelemetryError("invalid_request", 400)
  return parsed.data
}

/** The caller's source, or 404: another owner's source is indistinguishable from a missing one. Administrators get no override. */
export async function ownedSource(ownerId: UserId, id: string): Promise<TelemetrySourceRecord> {
  const source = SOURCE_ID_PATTERN.test(id) ? await getRepo().telemetry.getSource(id) : null
  if (!source || source.ownerId !== ownerId) throw new TelemetryError("source_not_found", 404)
  return source
}

/** Behind a TLS-terminating proxy the original scheme must be preserved, or the install command would name a dead origin. */
function secureOrigin(requestUrl: string): string {
  const url = new URL(requestUrl)
  if (url.protocol !== "https:") throw new TelemetryError("https_required", 400)
  return url.origin
}

telemetrySourcesRouter.get("/sources", async c => {
  try {
    const sources = await getRepo().telemetry.listSources(c.get("auth").userId as UserId)
    return telemetryJson({ sources: sources.map(publicSource) })
  } catch (error) { return telemetryFailure(error) }
})

telemetrySourcesRouter.post("/sources", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const origin = secureOrigin(c.req.url)
    const body = await parseBody(c.req.raw, createBody)
    const key = `tlm_${randomHex(32)}`
    const source: TelemetrySourceRecord = {
      id: `tls_${randomHex(16)}`, ownerId, name: body.name, keyHash: await sha256Hex(key), settings: {},
      createdAt: new Date().toISOString(), lastPushAt: null,
    }
    if (!(await getRepo().telemetry.createSourceWithinLimit(source, MAX_SOURCES_PER_OWNER))) throw new TelemetryError("source_limit", 409)
    return telemetryJson({ source: publicSource(source), key, install: installCommand(origin, key) }, 201)
  } catch (error) { return telemetryFailure(error) }
})

telemetrySourcesRouter.patch("/sources/:id", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const existing = await ownedSource(ownerId, c.req.param("id"))
    const body = await parseBody(c.req.raw, patchBody)
    if (body.settings !== undefined && new TextEncoder().encode(JSON.stringify(body.settings)).length > SETTINGS_MAX_BYTES) {
      throw new TelemetryError("invalid_request", 400)
    }
    const updated = await getRepo().telemetry.updateSource(existing.id, ownerId, { name: body.name, settings: body.settings })
    if (!updated) throw new TelemetryError("source_not_found", 404)
    return telemetryJson({ source: publicSource(updated) })
  } catch (error) { return telemetryFailure(error) }
})

telemetrySourcesRouter.post("/sources/:id/rotate-key", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const origin = secureOrigin(c.req.url)
    const existing = await ownedSource(ownerId, c.req.param("id"))
    const key = `tlm_${randomHex(32)}`
    if (!(await getRepo().telemetry.rotateKey(existing.id, ownerId, await sha256Hex(key)))) throw new TelemetryError("source_not_found", 404)
    return telemetryJson({ key, install: installCommand(origin, key) })
  } catch (error) { return telemetryFailure(error) }
})

telemetrySourcesRouter.delete("/sources/:id", async c => {
  try {
    const ownerId = c.get("auth").userId as UserId
    const existing = await ownedSource(ownerId, c.req.param("id"))
    if (!(await getRepo().telemetry.deleteSource(existing.id, ownerId))) throw new TelemetryError("source_not_found", 404)
    return telemetryJson({ sources: (await getRepo().telemetry.listSources(ownerId)).map(publicSource) })
  } catch (error) { return telemetryFailure(error) }
})
```

`packages/gateway/src/control-plane/telemetry/routes.ts` (queries are added in Task 5; the router already imports them there):

```ts
import { Hono } from "hono"
import type { Env } from "../../app"
import type { FullAuthCtx } from "../../shared/credential-auth"
import { requireBrowserSessionAllowingQuery } from "../shared/session-guard"
import { telemetrySourcesRouter } from "./sources"

export const telemetryManagementRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()
telemetryManagementRouter.use("*", requireBrowserSessionAllowingQuery)
telemetryManagementRouter.route("/", telemetrySourcesRouter)
```

- [ ] **Step 5: Mount it and add the user cascade**

In `packages/gateway/src/control-plane/routes.ts` add `import { telemetryManagementRouter } from './telemetry/routes.ts'` and, after `controlPlane.route('/api/sync', syncManagementRouter)`, add `controlPlane.route('/api/telemetry', telemetryManagementRouter)`.

In `packages/gateway/src/control-plane/auth/routes.ts` add, directly after `await repo.syncDevices.deleteByOwner(userId)`:

```ts
  await repo.telemetry.deleteSourcesByOwner(userId)
```

In `packages/gateway/tests/control-plane-auth.test.ts` make three edits: add `const telemetryDeletes: string[] = []` after `const syncDeviceDeletes: string[] = []`; add `telemetry: { deleteSourcesByOwner: async (oid: string) => { telemetryDeletes.push(oid) } },` after the `syncSources: { get: async () => null },` line; add `telemetryDeletes` to the returned object (`return { repo, users, ..., syncDeviceDeletes, telemetryDeletes }`); and add `expect(store.telemetryDeletes).toEqual(['u1'])` after the `syncDeviceDeletes` assertion.

- [ ] **Step 6: Run the tests**

Run: `bun test ./packages/gateway/tests/telemetry-agent-release.test.ts ./packages/gateway/tests/telemetry-sources.test.ts ./packages/gateway/tests/control-plane-auth.test.ts ./packages/gateway/tests/sync-devices.sqlite.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/control-plane/telemetry/agent-release.ts packages/gateway/src/control-plane/telemetry/sources.ts \
  packages/gateway/src/control-plane/shared/session-guard.ts packages/gateway/src/control-plane/telemetry/routes.ts packages/gateway/src/control-plane/routes.ts packages/gateway/src/control-plane/auth/routes.ts \
  packages/gateway/tests/control-plane-auth.test.ts packages/gateway/tests/telemetry-agent-release.test.ts packages/gateway/tests/telemetry-sources.test.ts
git commit -m "$(cat <<'EOF'
feat(telemetry): add owner-only source management with a pinned install command

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 4: Pure analysis functions

All analysis is pure and takes already-read rows, so every rule is unit-tested without a database.

**Files:**
- Create: `packages/gateway/src/control-plane/telemetry/analysis.ts`
- Create: `packages/gateway/tests/telemetry-analysis.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/gateway/tests/telemetry-analysis.test.ts`:

```ts
import { expect, test } from "bun:test"
import {
  DAY, HOUR, buildSeries, buildTop, checkStatuses, costOf, findSurges, freshness, latestCheck, nonZeroFlags, projectMonth, selectSurges, stageOf,
  type Surge,
} from "../src/control-plane/telemetry/analysis"
import { parseWindow } from "../src/control-plane/telemetry/protocol"
import { TelemetryError } from "../src/control-plane/telemetry/common"

const H0 = Date.UTC(2026, 10, 10) / 1000
const at = (hours: number) => H0 + hours * HOUR
const hv = (hour: number, value: number) => ({ hour, value })

// ---- month to date and projection -------------------------------------------------------------------------------

const utc = (iso: string) => Date.parse(iso) / 1000
const hoursOf = (from: string, count: number, value: number) => Array.from({ length: count }, (_, i) => hv(utc(from) + i * HOUR, value))

test("projection is month-to-date plus the last seven complete days' average times the fractional days left", () => {
  const rows = [...hoursOf("2026-11-01T00:00:00Z", 15 * 24, 1000), ...hoursOf("2026-11-16T00:00:00Z", 12, 1000)]
  const result = projectMonth(rows, utc("2026-11-01T00:00:00Z"), utc("2026-11-16T12:30:00Z"))
  expect(result.monthStart).toBe(utc("2026-11-01T00:00:00Z"))
  expect(result.mtd).toBe(372_000)
  expect(result.averageDaily).toBe(24_000)
  expect(result.projection).toBeCloseTo(372_000 + 24_000 * (14 + 11.5 / 24), 6)
})

test("only days on or after the first data day count towards the average", () => {
  const rows = [...hoursOf("2026-11-14T08:00:00Z", 16, 1000), ...hoursOf("2026-11-15T00:00:00Z", 24, 1000), ...hoursOf("2026-11-16T00:00:00Z", 12, 1000)]
  const result = projectMonth(rows, utc("2026-11-14T08:00:00Z"), utc("2026-11-16T12:30:00Z"))
  expect(result.mtd).toBe(52_000)
  expect(result.averageDaily).toBe(20_000)
  expect(result.projection).toBeCloseTo(52_000 + 20_000 * (14 + 11.5 / 24), 6)
})

test("with no complete day yet the projection equals month-to-date, and with no data it is zero", () => {
  const today = hoursOf("2026-11-16T00:00:00Z", 12, 500)
  expect(projectMonth(today, utc("2026-11-16T00:00:00Z"), utc("2026-11-16T12:30:00Z"))).toMatchObject({ mtd: 6000, averageDaily: null, projection: 6000 })
  expect(projectMonth([], null, utc("2026-11-16T12:30:00Z"))).toMatchObject({ mtd: 0, averageDaily: null, projection: 0 })
})

test("at the start of a month the average still comes from the previous month's last days", () => {
  const rows = [...hoursOf("2026-11-24T00:00:00Z", 7 * 24, 1000), ...hoursOf("2026-12-01T00:00:00Z", 1, 1000)]
  const now = utc("2026-12-01T00:30:00Z")
  const result = projectMonth(rows, utc("2026-11-24T00:00:00Z"), now)
  expect(result.mtd).toBe(1000)
  expect(result.averageDaily).toBe(24_000)
  expect(result.projection).toBeCloseTo(1000 + 24_000 * ((Date.UTC(2027, 0, 1) / 1000 - now) / DAY), 6)
})

test("cost uses decimal gigabytes, subtracts the free allowance, and is null without a price or for non-byte metrics", () => {
  expect(costOf(150e9, "bytes", { pricePerGB: 0.08, freeGB: 100 })).toBeCloseTo(4, 9)
  expect(costOf(50e9, "bytes", { pricePerGB: 0.08, freeGB: 100 })).toBe(0)
  expect(costOf(2e9, "bytes", { pricePerGB: 0.5 })).toBe(1)
  expect(costOf(2e9, "bytes", {})).toBeNull()
  expect(costOf(5, "count", { pricePerGB: 1 })).toBeNull()
  expect(costOf(5, "ms", { pricePerGB: 1 })).toBeNull()
})

// ---- surges ------------------------------------------------------------------------------------------------------

const flat = (hours: number, value: number) => Array.from({ length: hours }, (_, i) => hv(at(i), value))
const surgeInput = (hourly: ReturnType<typeof flat>, over: Partial<Parameters<typeof findSurges>[0]> = {}): Parameters<typeof findSurges>[0] => ({
  metric: "nic.tx_bytes", unit: "bytes", hourly, firstHour: at(0), nowHour: at(239), settings: { surgeMinBytes: 0 }, ...over,
})

test("an hour at or above factor times the 168 hour baseline is a surge, with the boundary inclusive", () => {
  const withSpike = (value: number) => [...flat(239, 100), hv(at(239), value)]
  expect(findSurges(surgeInput(withSpike(300)))).toEqual([{ metric: "nic.tx_bytes", hour: at(239), value: 300, baseline: 100, ratio: 3 }])
  expect(findSurges(surgeInput(withSpike(299)))).toEqual([])
  expect(findSurges(surgeInput(withSpike(900), { settings: { surgeMinBytes: 0, surgeFactor: 10 } }))).toEqual([])
  expect(findSurges(surgeInput(withSpike(1000), { settings: { surgeMinBytes: 0, surgeFactor: 10 } }))).toHaveLength(1)
})

test("the minimum is per unit, inclusive, and defaults to 2 GiB for bytes and 1000 for counts", () => {
  const spike = (value: number) => [hv(at(0), 0), hv(at(100), value)]
  const count = (value: number) => findSurges(surgeInput(spike(value), { unit: "count", settings: {}, nowHour: at(110) }))
  expect(count(1000)).toHaveLength(1)
  expect(count(999)).toEqual([])
  const bytes = (value: number, settings = {}) => findSurges(surgeInput(spike(value), { settings, nowHour: at(110) }))
  expect(bytes(2 * 1024 ** 3, {})).toHaveLength(1)
  expect(bytes(2 * 1024 ** 3 - 1, {})).toEqual([])
  expect(bytes(5, { surgeMinBytes: 5 })).toHaveLength(1)
  expect(bytes(4, { surgeMinBytes: 5 })).toEqual([])
  expect(findSurges(surgeInput(spike(5000), { unit: "count", settings: { surgeMinCount: 6000 }, nowHour: at(110) }))).toEqual([])
})

test("an hour is judged only with at least 24 hours of history before it; hours without data count as zero", () => {
  const data = (spikeAt: number) => [hv(at(0), 0), hv(at(spikeAt), 1000)]
  expect(findSurges(surgeInput(data(23), { unit: "count", settings: {}, nowHour: at(30) }))).toEqual([])
  const judged = findSurges(surgeInput(data(24), { unit: "count", settings: {}, nowHour: at(30) }))
  expect(judged).toEqual([{ metric: "nic.tx_bytes", hour: at(24), value: 1000, baseline: 0, ratio: null }])
  expect(findSurges(surgeInput([], { firstHour: null }))).toEqual([])
})

test("only the last 168 hours are reported, newest first, and ms metrics are never checked", () => {
  const base = [hv(at(0), 0), hv(at(30), 1000), hv(at(200), 1000), hv(at(239), 1000)]
  const found = findSurges(surgeInput(base, { unit: "count", settings: {}, nowHour: at(239) }))
  expect(found.map(s => s.hour)).toEqual([at(239), at(200)])
  expect(findSurges(surgeInput(base, { unit: "ms", settings: {}, nowHour: at(239) }))).toEqual([])
})

test("selectSurges keeps the newest 20 across metrics", () => {
  const all: Surge[] = Array.from({ length: 25 }, (_, i) => ({ metric: i % 2 ? "b" : "a", hour: at(i), value: 1, baseline: 0, ratio: null }))
  const picked = selectSurges(all)
  expect(picked).toHaveLength(20)
  expect(picked[0]!.hour).toBe(at(24))
  expect(picked[19]!.hour).toBe(at(5))
})

// ---- non-zero flags ----------------------------------------------------------------------------------------------

test("non-zero flags group by metric and hour, total over dims, and order the breakdown by value", () => {
  const flags = nonZeroFlags([
    { metric: "probe.fail", hour: at(5), dims: { stage: "tls" }, value: 1 },
    { metric: "probe.fail", hour: at(5), dims: { stage: "tcp" }, value: 3 },
    { metric: "probe.fail", hour: at(2), dims: {}, value: 2 },
    { metric: "probe.fail", hour: at(9), dims: { stage: "http" }, value: 0 },
  ])
  expect(flags).toEqual([
    { metric: "probe.fail", hour: at(5), total: 4, breakdown: [{ dims: { stage: "tcp" }, value: 3 }, { dims: { stage: "tls" }, value: 1 }] },
    { metric: "probe.fail", hour: at(2), total: 2, breakdown: [] },
  ])
})

test("non-zero flags cover at most 50 distinct hours, newest first", () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ metric: "m", hour: at(i), dims: {}, value: 1 }))
  const flags = nonZeroFlags(rows)
  expect(flags).toHaveLength(50)
  expect(flags[0]!.hour).toBe(at(59))
  expect(flags[49]!.hour).toBe(at(10))
})

// ---- point-in-time checks ----------------------------------------------------------------------------------------

test("check statuses distinguish passed, failed, no check and not monitored", () => {
  const hours = [3, 4, 5, 6, 7, 8].map(at)
  const values = [hv(at(5), 1), hv(at(7), 0)]
  expect(checkStatuses(hours, values, at(5))).toEqual(["not monitored", "not monitored", "passed", "no check", "failed", "no check"])
  expect(checkStatuses(hours, [], null)).toEqual(hours.map(() => "not monitored"))
})

test("the latest closed hour is judged, and a failure names its stage from the matching .fail flag", () => {
  const flags = nonZeroFlags([{ metric: "probe.fail", hour: at(7), dims: { stage: "tls" }, value: 1 }])
  const values = [hv(at(5), 1), hv(at(7), 0)]
  expect(latestCheck("probe.ok", at(8) + 1800, values, at(5), flags)).toEqual({ metric: "probe.ok", hour: at(7), status: "failed", stage: "tls" })
  expect(latestCheck("probe.ok", at(6) + 60, values, at(5), flags)).toEqual({ metric: "probe.ok", hour: at(5), status: "passed", stage: null })
  expect(latestCheck("probe.ok", at(9) + 600, values, at(5), flags)).toEqual({ metric: "probe.ok", hour: at(8), status: "no check", stage: null })
  expect(latestCheck("probe.ok", at(4) + 600, values, at(5), flags)).toEqual({ metric: "probe.ok", hour: at(3), status: "not monitored", stage: null })
  expect(stageOf(flags, "probe.ok", at(7))).toBe("tls")
  expect(stageOf(flags, "probe.ok", at(6))).toBeNull()
  expect(stageOf(flags, "other.metric", at(7))).toBeNull()
})

// ---- freshness ---------------------------------------------------------------------------------------------------

test("freshness is stale only strictly after the threshold and never for a source that has not pushed yet", () => {
  const now = Date.parse("2026-11-16T12:00:00Z")
  expect(freshness(null, now)).toEqual({ lastPushAt: null, stale: false, staleAfterHours: 2, hoursSincePush: null })
  expect(freshness("2026-11-16T10:00:00.000Z", now).stale).toBe(false)
  expect(freshness("2026-11-16T09:59:59.999Z", now)).toMatchObject({ stale: true, hoursSincePush: 2 })
  expect(freshness("2026-11-16T09:59:59.999Z", now, 3).stale).toBe(false)
  expect(freshness("2026-11-16T11:30:00.000Z", now)).toMatchObject({ stale: false, hoursSincePush: 0 })
})

// ---- series and top ----------------------------------------------------------------------------------------------

test("a series is dense and the remainder after the listed groups becomes one (other) group", () => {
  const built = buildSeries({ from: at(0), to: at(4) }, [hv(at(0), 10), hv(at(1), 20), hv(at(3), 7)], [
    { key: "a", points: [hv(at(0), 6), hv(at(1), 15)] },
    { key: "b", points: [hv(at(0), 2)] },
  ])
  expect(built.hours).toEqual([at(0), at(1), at(2), at(3)])
  expect(built.total).toEqual([10, 20, 0, 7])
  expect(built.groups).toEqual([
    { key: "a", values: [6, 15, 0, 0] }, { key: "b", values: [2, 0, 0, 0] }, { key: "(other)", values: [2, 5, 0, 7] },
  ])
})

test("with no remainder there is no (other) group, and without groups only the total is returned", () => {
  const exact = buildSeries({ from: at(0), to: at(2) }, [hv(at(0), 3)], [{ key: "a", points: [hv(at(0), 3)] }])
  expect(exact.groups.map(g => g.key)).toEqual(["a"])
  expect(buildSeries({ from: at(0), to: at(2) }, [hv(at(1), 4)], [])).toEqual({ hours: [at(0), at(1)], total: [0, 4], groups: [] })
})

test("the top table shares against all groups, compares with the previous period and reports the remainder", () => {
  const top = buildTop(100, [{ key: "a", value: 60 }, { key: "b", value: 30 }], [{ key: "a", value: 30 }])
  expect(top).toEqual({
    total: 100, otherCurrent: 10, otherShare: 0.1,
    rows: [{ key: "a", value: 60, share: 0.6, previous: 30, change: 1 }, { key: "b", value: 30, share: 0.3, previous: 0, change: null }],
  })
  expect(buildTop(0, [], [])).toEqual({ total: 0, rows: [], otherCurrent: 0, otherShare: 0 })
  expect(buildTop(10, [{ key: "a", value: 10 }], [{ key: "a", value: 20 }]).rows[0]!.change).toBe(-0.5)
})

// ---- query windows -----------------------------------------------------------------------------------------------

test("query windows default to the last 24 hours through the current hour and reject misaligned, inverted or oversized ranges", () => {
  const now = utc("2026-11-16T12:34:56Z")
  expect(parseWindow(undefined, undefined, now)).toEqual({ from: utc("2026-11-15T13:00:00Z"), to: utc("2026-11-16T13:00:00Z") })
  expect(parseWindow("2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z", now)).toEqual({ from: utc("2026-11-10T00:00:00Z"), to: utc("2026-11-11T00:00:00Z") })
  expect(parseWindow("2026-11-10T00:00:00Z", undefined, now).to).toBe(utc("2026-11-16T13:00:00Z"))
  expect(parseWindow(undefined, "2026-11-11T00:00:00Z", now).from).toBe(utc("2026-11-10T00:00:00Z"))
  expect(parseWindow("2026-08-18T13:00:00Z", "2026-11-16T13:00:00Z", now).to).toBe(utc("2026-11-16T13:00:00Z"))
  for (const [from, to] of [["2026-11-10T00:30:00Z", undefined], ["2026-11-10", undefined], ["2026-11-11T00:00:00Z", "2026-11-10T00:00:00Z"],
    ["2026-11-10T00:00:00Z", "2026-11-10T00:00:00Z"], ["2026-08-17T13:00:00Z", "2026-11-16T13:00:00Z"]] as const) {
    expect(() => parseWindow(from, to, now)).toThrow(TelemetryError)
  }
})
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test ./packages/gateway/tests/telemetry-analysis.test.ts`
Expected: FAIL (cannot resolve `analysis`).

- [ ] **Step 3: Write the analysis module**

`packages/gateway/src/control-plane/telemetry/analysis.ts`:

```ts
import type { TelemetryContribution, TelemetryDimRow, TelemetryGroupHours, TelemetryGroupTotal, TelemetryHourValue } from "../../repo/telemetry"
import type { TelemetrySettings } from "./protocol"

export const HOUR = 3600
export const DAY = 86_400
export const SURGE_WINDOW_HOURS = 168
export const SURGE_BASELINE_HOURS = 168
export const SURGE_HISTORY_HOURS = 24
export const MAX_SURGES = 20
export const MAX_SURGE_METRICS = 10
export const MAX_FLAG_HOURS = 50
export const DEFAULT_SURGE_FACTOR = 3
export const DEFAULT_SURGE_MIN_BYTES = 2 * 1024 ** 3
export const DEFAULT_SURGE_MIN_COUNT = 1000
export const DEFAULT_STALE_AFTER_HOURS = 2

export const floorHour = (seconds: number) => Math.floor(seconds / HOUR) * HOUR
export const floorDay = (seconds: number) => Math.floor(seconds / DAY) * DAY

export function monthStart(seconds: number): number {
  const date = new Date(seconds * 1000)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000
}

export function nextMonthStart(seconds: number): number {
  const date = new Date(seconds * 1000)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000
}

/** Absorbs floating point residue when a total is compared with the sum of its parts. */
const remainder = (total: number, parts: number) => {
  const value = total - parts
  return Math.abs(value) < 1e-6 ? 0 : Math.max(0, value)
}

// ---- month to date and projection ---------------------------------------------------------------------------------

export interface Projection { monthStart: number; mtd: number; averageDaily: number | null; projection: number }

/**
 * `rows` are hourly totals of the budget metric; they must cover the month so far and the last 7 complete days.
 * MTD runs from the UTC month start through the current hour. Complete days before the first day with data are ignored.
 */
export function projectMonth(rows: readonly TelemetryHourValue[], firstHour: number | null, nowSec: number): Projection {
  const start = monthStart(nowSec)
  const end = floorHour(nowSec) + HOUR
  let mtd = 0
  for (const row of rows) if (row.hour >= start && row.hour < end) mtd += row.value
  const today = floorDay(nowSec)
  const firstDay = firstHour === null ? null : floorDay(firstHour)
  let sum = 0
  let days = 0
  if (firstDay !== null) {
    for (let back = 1; back <= 7; back++) {
      const dayStart = today - back * DAY
      if (dayStart < firstDay) continue
      days++
      for (const row of rows) if (row.hour >= dayStart && row.hour < dayStart + DAY) sum += row.value
    }
  }
  const averageDaily = days > 0 ? sum / days : null
  const remainingDays = (nextMonthStart(nowSec) - nowSec) / DAY
  return { monthStart: start, mtd, averageDaily, projection: mtd + (averageDaily ?? 0) * remainingDays }
}

/** Decimal gigabytes; null for non-byte metrics or when no price is set. */
export function costOf(value: number, unit: string, settings: Pick<TelemetrySettings, "pricePerGB" | "freeGB">): number | null {
  if (unit !== "bytes" || settings.pricePerGB === undefined) return null
  return Math.max(0, value / 1e9 - (settings.freeGB ?? 0)) * settings.pricePerGB
}

// ---- surges -------------------------------------------------------------------------------------------------------

export interface Surge { metric: string; hour: number; value: number; baseline: number; ratio: number | null }

export interface SurgeInput {
  metric: string
  unit: string
  /** Hourly totals covering at least 168 hours before the first judged hour. */
  hourly: readonly TelemetryHourValue[]
  /** The metric's earliest hour on record. */
  firstHour: number | null
  nowHour: number
  settings: TelemetrySettings
}

/** Surges within the last 168 hours up to `nowHour`, newest first. */
export function findSurges(input: SurgeInput): Surge[] {
  if (input.unit === "ms" || input.firstHour === null) return []
  const byHour = new Map(input.hourly.map(row => [row.hour, row.value]))
  const factor = input.settings.surgeFactor ?? DEFAULT_SURGE_FACTOR
  const minimum = input.unit === "bytes" ? input.settings.surgeMinBytes ?? DEFAULT_SURGE_MIN_BYTES : input.settings.surgeMinCount ?? DEFAULT_SURGE_MIN_COUNT
  const found: Surge[] = []
  for (let hour = input.nowHour; hour > input.nowHour - SURGE_WINDOW_HOURS * HOUR; hour -= HOUR) {
    const value = byHour.get(hour) ?? 0
    if (value <= 0 || hour - input.firstHour < SURGE_HISTORY_HOURS * HOUR) continue
    let sum = 0
    for (let back = 1; back <= SURGE_BASELINE_HOURS; back++) sum += byHour.get(hour - back * HOUR) ?? 0
    const baseline = sum / SURGE_BASELINE_HOURS
    if (value >= factor * baseline && value >= minimum) found.push({ metric: input.metric, hour, value, baseline, ratio: baseline > 0 ? value / baseline : null })
  }
  return found
}

export function selectSurges(all: readonly Surge[]): Surge[] {
  return [...all].sort((a, b) => b.hour - a.hour || a.metric.localeCompare(b.metric)).slice(0, MAX_SURGES)
}

export interface SurgeWithContributors extends Surge { contributors: TelemetryContribution[] }

// ---- non-zero flags and point-in-time checks ----------------------------------------------------------------------

export interface FlagEntry { dims: Record<string, string>; value: number }
export interface NonZeroFlag { metric: string; hour: number; total: number; breakdown: FlagEntry[] }

/** Groups non-zero rows by metric and hour, newest first, for at most `maxHours` distinct hours. */
export function nonZeroFlags(rows: readonly TelemetryDimRow[], maxHours = MAX_FLAG_HOURS): NonZeroFlag[] {
  const groups = new Map<string, NonZeroFlag>()
  for (const row of rows) {
    if (row.value <= 0) continue
    const key = `${row.metric}\u0000${row.hour}`
    const flag = groups.get(key) ?? { metric: row.metric, hour: row.hour, total: 0, breakdown: [] }
    flag.total += row.value
    if (Object.keys(row.dims).length > 0) flag.breakdown.push({ dims: row.dims, value: row.value })
    groups.set(key, flag)
  }
  const flags = [...groups.values()].sort((a, b) => b.hour - a.hour || a.metric.localeCompare(b.metric))
  for (const flag of flags) flag.breakdown.sort((a, b) => b.value - a.value || JSON.stringify(a.dims).localeCompare(JSON.stringify(b.dims)))
  const keep = new Set<number>()
  for (const flag of flags) if (keep.size < maxHours) keep.add(flag.hour)
  return flags.filter(flag => keep.has(flag.hour))
}

export type CheckStatus = "passed" | "failed" | "no check" | "not monitored"

/** The metric that records why `<name>.ok` failed: `<name>.fail`. Null for other names. */
export function failMetricOf(checkMetric: string): string | null {
  return checkMetric.endsWith(".ok") ? `${checkMetric.slice(0, -".ok".length)}.fail` : null
}

/**
 * Per hour: `passed` (value > 0), `failed` (value = 0), `no check` (no point at or after the metric's first point) or
 * `not monitored` (before the first point, or the metric has no points at all).
 */
export function checkStatuses(hours: readonly number[], values: readonly TelemetryHourValue[], firstHour: number | null): CheckStatus[] {
  const byHour = new Map(values.map(row => [row.hour, row.value]))
  return hours.map((hour): CheckStatus => {
    if (firstHour === null || hour < firstHour) return "not monitored"
    const value = byHour.get(hour)
    if (value === undefined) return "no check"
    return value > 0 ? "passed" : "failed"
  })
}

/** The failing stage recorded for a check hour, read from the matching `.fail` flag. */
export function stageOf(flags: readonly NonZeroFlag[], checkMetric: string, hour: number): string | null {
  const failMetric = failMetricOf(checkMetric)
  if (failMetric === null) return null
  const flag = flags.find(entry => entry.metric === failMetric && entry.hour === hour)
  return flag?.breakdown.find(entry => entry.dims.stage !== undefined)?.dims.stage ?? null
}

export interface LatestCheck { metric: string; hour: number; status: CheckStatus; stage: string | null }

/** The check result for the latest closed hour. */
export function latestCheck(metric: string, nowSec: number, values: readonly TelemetryHourValue[], firstHour: number | null, flags: readonly NonZeroFlag[]): LatestCheck {
  const hour = floorHour(nowSec) - HOUR
  const status = checkStatuses([hour], values, firstHour)[0]!
  return { metric, hour, status, stage: status === "failed" ? stageOf(flags, metric, hour) : null }
}

// ---- freshness ----------------------------------------------------------------------------------------------------

export interface Freshness { lastPushAt: string | null; stale: boolean; staleAfterHours: number; hoursSincePush: number | null }

export function freshness(lastPushAt: string | null, nowMs: number, staleAfterHours = DEFAULT_STALE_AFTER_HOURS): Freshness {
  if (lastPushAt === null) return { lastPushAt: null, stale: false, staleAfterHours, hoursSincePush: null }
  const age = nowMs - Date.parse(lastPushAt)
  return { lastPushAt, stale: age > staleAfterHours * 3_600_000, staleAfterHours, hoursSincePush: Math.max(0, Math.floor(age / 3_600_000)) }
}

// ---- series and top -----------------------------------------------------------------------------------------------

export interface BuiltSeries { hours: number[]; total: number[]; groups: Array<{ key: string; values: number[] }> }

/** Dense hourly arrays over `[from, to)`. The remainder after the listed groups is one `(other)` group. */
export function buildSeries(window: { from: number; to: number }, totals: readonly TelemetryHourValue[], groups: readonly TelemetryGroupHours[]): BuiltSeries {
  const hours: number[] = []
  for (let hour = window.from; hour < window.to; hour += HOUR) hours.push(hour)
  const totalByHour = new Map(totals.map(row => [row.hour, row.value]))
  const total = hours.map(hour => totalByHour.get(hour) ?? 0)
  const built = groups.map(group => {
    const byHour = new Map(group.points.map(point => [point.hour, point.value]))
    return { key: group.key, values: hours.map(hour => byHour.get(hour) ?? 0) }
  })
  if (built.length === 0) return { hours, total, groups: [] }
  const other = total.map((value, index) => remainder(value, built.reduce((sum, group) => sum + group.values[index]!, 0)))
  if (other.some(value => value > 0)) built.push({ key: "(other)", values: other })
  return { hours, total, groups: built }
}

export interface TopRow { key: string; value: number; share: number; previous: number; change: number | null }
export interface TopResult { total: number; rows: TopRow[]; otherCurrent: number; otherShare: number }

export function buildTop(total: number, groups: readonly TelemetryGroupTotal[], previous: readonly TelemetryGroupTotal[]): TopResult {
  const before = new Map(previous.map(group => [group.key, group.value]))
  const rows = groups.map((group): TopRow => {
    const prior = before.get(group.key) ?? 0
    return { key: group.key, value: group.value, share: total > 0 ? group.value / total : 0, previous: prior, change: prior > 0 ? (group.value - prior) / prior : null }
  })
  const otherCurrent = remainder(total, groups.reduce((sum, group) => sum + group.value, 0))
  return { total, rows, otherCurrent, otherShare: total > 0 ? otherCurrent / total : 0 }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test ./packages/gateway/tests/telemetry-analysis.test.ts`
Expected: PASS. If a floating-point assertion fails by a hair, compare with `toBeCloseTo` in the test rather than loosening the code.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/control-plane/telemetry/analysis.ts packages/gateway/tests/telemetry-analysis.test.ts
git commit -m "$(cat <<'EOF'
feat(telemetry): add pure analysis for projection, surges, flags, checks and series

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 5: Query routes (metrics, series, top, summary)

**Files:**
- Create: `packages/gateway/src/control-plane/telemetry/queries.ts`
- Modify: `packages/gateway/src/control-plane/telemetry/routes.ts`
- Create: `packages/gateway/tests/telemetry-queries.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/gateway/tests/telemetry-queries.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { telemetryClock } from "../src/control-plane/telemetry/common"
import { telemetryManagementRouter } from "../src/control-plane/telemetry/routes"
import type { SessionToken, UserId } from "../src/repo/branded-ids"
import type { TelemetryUnit } from "../src/repo/telemetry"

const owner = "tlm-q-owner" as UserId
const other = "tlm-q-other" as UserId
const tokens = { [owner]: "ses_tlm_q_owner", [other]: "ses_tlm_q_other" } as Record<string, string>
const stamp = "2026-11-16T00:00:00.000Z"
const id = `tls_${"1".repeat(32)}`
const NOW = Date.UTC(2026, 10, 16, 12, 30)
let db: Database
let repo: BunSqliteRepo
let app: Hono

const sec = (iso: string) => Date.parse(iso) / 1000
const pt = (metric: string, hourIso: string, value: number, dims: Record<string, string> = {}, unit: TelemetryUnit = "bytes") =>
  ({ metric, hour: sec(hourIso), dims, value, unit })
const hours = (startIso: string, count: number) => Array.from({ length: count }, (_, i) => new Date(Date.parse(startIso) + i * 3_600_000).toISOString().replace(".000Z", "Z"))
const seed = (points: ReturnType<typeof pt>[], pushedAt = "2026-11-16T12:00:00.000Z") => repo.telemetry.replaceHours(id, points, pushedAt)
const configure = (settings: Record<string, unknown>) => repo.telemetry.updateSource(id, owner, { settings })

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  telemetryClock.now = () => NOW
  for (const user of [owner, other]) {
    await repo.users.create({ id: user, name: user, createdAt: stamp, disabled: false })
    await repo.sessions.create({ token: tokens[user] as SessionToken, userId: user, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  }
  await repo.telemetry.createSourceWithinLimit({ id, ownerId: owner, name: "vm", keyHash: "a".repeat(64), settings: {}, createdAt: stamp, lastPushAt: null }, 16)
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/telemetry", telemetryManagementRouter)
})
afterEach(() => { db.close(); telemetryClock.now = () => Date.now(); __resetPlatformForTests() })

const get = (path: string, user: UserId = owner) =>
  app.request(`https://gw.example/api/telemetry/sources/${id}${path}`, { headers: { authorization: `Bearer ${tokens[user]}` } })
const json = async (path: string) => (await get(path)).json() as Promise<any>

test("every query route is owner-only", async () => {
  for (const path of ["/metrics", "/series?metric=m", "/top?metric=m&groupBy=user", "/summary"]) {
    const response = await get(path, other)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: { code: "source_not_found" } })
  }
})

test("metrics list units, first and last hour and dim keys", async () => {
  await seed([
    pt("proxy.sent_bytes", "2026-11-16T10:00:00Z", 1, { user: "#1", domain: "a.com" }), pt("nic.tx_bytes", "2026-11-10T00:00:00Z", 5),
    pt("probe.latency_ms", "2026-11-16T09:00:00Z", 120, {}, "ms"), pt("old.metric", "2026-09-01T00:00:00Z", 1, {}, "count"),
  ])
  const body = await json("/metrics")
  expect(body.metrics).toEqual([
    { metric: "nic.tx_bytes", unit: "bytes", firstHour: "2026-11-10T00:00:00Z", lastHour: "2026-11-10T00:00:00Z", dims: [] },
    { metric: "probe.latency_ms", unit: "ms", firstHour: "2026-11-16T09:00:00Z", lastHour: "2026-11-16T09:00:00Z", dims: [] },
    { metric: "proxy.sent_bytes", unit: "bytes", firstHour: "2026-11-16T10:00:00Z", lastHour: "2026-11-16T10:00:00Z", dims: ["domain", "user"] },
  ])
})

test("a series defaults to the last 24 hours, is dense and splits by a dim with the top N and one merged (other)", async () => {
  await seed([
    pt("proxy.sent_bytes", "2026-11-16T10:00:00Z", 100, { user: "a" }), pt("proxy.sent_bytes", "2026-11-16T10:00:00Z", 50, { user: "b" }),
    pt("proxy.sent_bytes", "2026-11-16T10:00:00Z", 7, { user: "(other)" }), pt("proxy.sent_bytes", "2026-11-16T11:00:00Z", 10, { user: "a" }),
  ])
  const plain = await json("/series?metric=proxy.sent_bytes")
  expect(plain).toMatchObject({ metric: "proxy.sent_bytes", unit: "bytes", from: "2026-11-15T13:00:00Z", to: "2026-11-16T13:00:00Z", groups: [] })
  expect(plain.hours).toHaveLength(24)
  expect(plain.total[21]).toBe(157)
  expect(plain.total[0]).toBe(0)
  const split = await json("/series?metric=proxy.sent_bytes&groupBy=user&top=1")
  expect(split.groups.map((g: { key: string }) => g.key)).toEqual(["a", "(other)"])
  expect(split.groups[0].values[21]).toBe(100)
  expect(split.groups[0].values[22]).toBe(10)
  expect(split.groups[1].values[21]).toBe(57)
  expect(split.groups[1].values[22]).toBe(0)
})

test("rows without the group key form the empty group", async () => {
  await seed([pt("m", "2026-11-16T10:00:00Z", 4, { domain: "x.com" }), pt("m", "2026-11-16T10:00:00Z", 6, { user: "a" })])
  const split = await json("/series?metric=m&groupBy=user&top=5")
  expect(split.groups.map((g: { key: string }) => g.key).sort()).toEqual(["", "a"])
})

test.each([
  "/series", "/series?metric=Bad Name", "/series?metric=m&from=2026-11-16T10:30:00Z", "/series?metric=m&top=0", "/series?metric=m&top=21",
  "/series?metric=m&top=x", "/series?metric=m&groupBy=Bad", "/series?metric=m&from=2026-08-01T00:00:00Z&to=2026-11-16T13:00:00Z",
  "/top?metric=m", "/top?metric=m&groupBy=user&limit=0", "/top?metric=m&groupBy=user&limit=101",
])("%s is a 400 invalid_request", async path => {
  const response = await get(path)
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ error: { code: "invalid_request" } })
})

test("a check series reports a status per hour and the failing stage from the matching .fail metric", async () => {
  await configure({ checkMetrics: ["probe.ok"], flagNonZeroMetrics: ["probe.fail"] })
  await seed([
    pt("probe.ok", "2026-11-16T08:00:00Z", 1, {}, "count"), pt("probe.ok", "2026-11-16T09:00:00Z", 0, {}, "count"), pt("probe.ok", "2026-11-16T11:00:00Z", 1, {}, "count"),
    pt("probe.fail", "2026-11-16T09:00:00Z", 1, { stage: "tls" }, "count"),
  ])
  const body = await json("/series?metric=probe.ok&from=2026-11-16T07:00:00Z&to=2026-11-16T12:00:00Z")
  expect(body.statuses).toEqual(["not monitored", "passed", "failed", "no check", "passed"])
  expect(body.stages).toEqual([null, null, "tls", null, null])
  expect((await json("/series?metric=proxy.sent_bytes")).statuses).toBeUndefined()
})

test("the top table ranks groups, compares with the previous period and reports the remainder", async () => {
  await seed([
    pt("t", "2026-11-16T03:00:00Z", 60, { user: "a" }), pt("t", "2026-11-16T03:00:00Z", 30, { user: "b" }), pt("t", "2026-11-16T03:00:00Z", 5, { user: "c" }),
    pt("t", "2026-11-15T15:00:00Z", 30, { user: "a" }),
  ])
  const body = await json("/top?metric=t&groupBy=user&from=2026-11-16T00:00:00Z&to=2026-11-16T12:00:00Z&limit=2")
  expect(body).toMatchObject({ metric: "t", unit: "bytes", groupBy: "user", previousFrom: "2026-11-15T12:00:00Z", previousTo: "2026-11-16T00:00:00Z", total: 95 })
  expect(body.rows).toHaveLength(2)
  expect(body.rows[0]).toMatchObject({ key: "a", value: 60, previous: 30, change: 1 })
  expect(body.rows[0].share).toBeCloseTo(60 / 95, 9)
  expect(body.rows[1]).toMatchObject({ key: "b", value: 30, previous: 0, change: null })
  expect(body.otherCurrent).toBe(5)
  expect(body.otherShare).toBeCloseTo(5 / 95, 9)
})

test("the summary of a source with no settings and no data is empty and not stale", async () => {
  const body = await json("/summary")
  expect(body).toMatchObject({ now: "2026-11-16T12:30:00.000Z", budget: null, surges: [], flags: [], checks: [],
    freshness: { lastPushAt: null, stale: false, staleAfterHours: 2, hoursSincePush: null } })
})

test("the summary reports freshness, month-to-date, projection against the limit and cost", async () => {
  await configure({ budgetMetric: "nic.tx_bytes", monthlyLimit: 500e9, pricePerGB: 0.1, freeGB: 100, staleAfterHours: 3 })
  await seed(hours("2026-11-01T00:00:00Z", 372).map(hour => pt("nic.tx_bytes", hour, 1e9)), "2026-11-16T09:00:00.000Z")
  const body = await json("/summary")
  expect(body.freshness).toEqual({ lastPushAt: "2026-11-16T09:00:00.000Z", stale: true, staleAfterHours: 3, hoursSincePush: 3 })
  expect(body.budget).toMatchObject({ metric: "nic.tx_bytes", unit: "bytes", monthStart: "2026-11-01T00:00:00Z", mtd: 372e9, averageDaily: 24e9, monthlyLimit: 500e9, overLimit: true })
  expect(body.budget.projection).toBeCloseTo(719.5e9, -3)
  expect(body.budget.mtdPercent).toBeCloseTo(74.4, 6)
  expect(body.budget.projectionPercent).toBeCloseTo(143.9, 6)
  expect(body.budget.cost.mtd).toBeCloseTo(27.2, 6)
  expect(body.budget.cost.projection).toBeCloseTo(61.95, 6)
})

test("without a limit or price the budget has no percentages, no overLimit and no cost", async () => {
  await configure({ budgetMetric: "proxy.connections" })
  await seed(hours("2026-11-16T00:00:00Z", 4).map(hour => pt("proxy.connections", hour, 10, {}, "count")))
  const { budget } = await json("/summary")
  expect(budget).toMatchObject({ unit: "count", mtd: 40, monthlyLimit: null, mtdPercent: null, projectionPercent: null, overLimit: null, cost: null })
})

test("the summary lists surges with their top contributors and skips ms metrics", async () => {
  const flat = hours("2026-11-10T00:00:00Z", 6 * 24 + 11)
  await seed([
    ...flat.map(hour => pt("proxy.connections", hour, 10, { user: "a" }, "count")),
    pt("proxy.connections", "2026-11-16T11:00:00Z", 4000, { user: "a" }, "count"), pt("proxy.connections", "2026-11-16T11:00:00Z", 1000, { user: "b" }, "count"),
    ...flat.map(hour => pt("probe.latency_ms", hour, 5, {}, "ms")), pt("probe.latency_ms", "2026-11-16T11:00:00Z", 9000, {}, "ms"),
  ])
  const { surges } = await json("/summary")
  expect(surges).toHaveLength(1)
  expect(surges[0]).toMatchObject({ metric: "proxy.connections", hour: "2026-11-16T11:00:00Z", value: 5000 })
  expect(surges[0].ratio).toBeGreaterThan(100)
  expect(surges[0].contributors).toEqual([{ dims: { user: "a" }, value: 4000 }, { dims: { user: "b" }, value: 1000 }])
})

test("flags list non-zero hours of the configured metrics with their breakdown", async () => {
  await configure({ flagNonZeroMetrics: ["probe.fail"] })
  await seed([
    pt("probe.fail", "2026-11-16T09:00:00Z", 1, { stage: "tcp" }, "count"), pt("probe.fail", "2026-11-16T10:00:00Z", 1, { stage: "tls" }, "count"),
    pt("probe.fail", "2026-11-01T10:00:00Z", 1, { stage: "tls" }, "count"),
  ])
  expect((await json("/summary")).flags).toEqual([
    { metric: "probe.fail", hour: "2026-11-16T10:00:00Z", total: 1, breakdown: [{ dims: { stage: "tls" }, value: 1 }] },
    { metric: "probe.fail", hour: "2026-11-16T09:00:00Z", total: 1, breakdown: [{ dims: { stage: "tcp" }, value: 1 }] },
  ])
})

test("the latest closed hour is judged for each check metric: failed with its stage, no check, and not monitored", async () => {
  await configure({ checkMetrics: ["probe.ok"], flagNonZeroMetrics: ["probe.fail"] })
  await seed([pt("probe.ok", "2026-11-16T08:00:00Z", 1, {}, "count"), pt("probe.ok", "2026-11-16T11:00:00Z", 0, {}, "count"), pt("probe.fail", "2026-11-16T11:00:00Z", 1, { stage: "http" }, "count")])
  expect((await json("/summary")).checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T11:00:00Z", status: "failed", stage: "http" }])

  await seed([pt("probe.ok", "2026-11-16T11:00:00Z", 1, {}, "count")])
  expect((await json("/summary")).checks[0]).toMatchObject({ status: "passed", stage: null })

  // No point for the latest closed hour although earlier hours exist: the VM may be down or the agent not running.
  telemetryClock.now = () => Date.UTC(2026, 10, 16, 13, 30)
  expect((await json("/summary")).checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T12:00:00Z", status: "no check", stage: null }])

  // Before the metric's first point the hour is neutral.
  telemetryClock.now = () => Date.UTC(2026, 10, 16, 7, 30)
  expect((await json("/summary")).checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T06:00:00Z", status: "not monitored", stage: null }])
})
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test ./packages/gateway/tests/telemetry-queries.test.ts`
Expected: FAIL (the routes do not exist; responses are 404).

- [ ] **Step 3: Write the query routes**

`packages/gateway/src/control-plane/telemetry/queries.ts`:

```ts
import { Hono } from "hono"
import type { Env } from "../../app"
import { getRepo } from "../../repo"
import type { UserId } from "../../repo/branded-ids"
import type { TelemetrySourceRecord } from "../../repo/telemetry"
import type { FullAuthCtx } from "../../shared/credential-auth"
import {
  DAY, HOUR, MAX_SURGE_METRICS, SURGE_BASELINE_HOURS, SURGE_WINDOW_HOURS, buildSeries, buildTop, checkStatuses, costOf, failMetricOf, findSurges,
  floorDay, floorHour, freshness, latestCheck, monthStart, nonZeroFlags, projectMonth, selectSurges, stageOf, type Surge,
} from "./analysis"
import { TelemetryError, telemetryClock, telemetryFailure, telemetryJson } from "./common"
import { DIM_KEY_PATTERN, formatHour, isMetricName, parseWindow, settingsOf } from "./protocol"
import { ownedSource } from "./sources"

export const telemetryQueriesRouter = new Hono<{ Bindings: Env; Variables: { auth: FullAuthCtx } }>()

const bad = () => new TelemetryError("invalid_request", 400)
type Query = (name: string) => string | undefined

function metricParam(query: Query): string {
  const metric = query("metric")
  if (!isMetricName(metric)) throw bad()
  return metric
}

function groupByParam(query: Query): string | undefined {
  const value = query("groupBy")
  if (value === undefined || value === "") return undefined
  if (!DIM_KEY_PATTERN.test(value)) throw bad()
  return value
}

function intParam(query: Query, name: string, fallback: number, min: number, max: number): number {
  const raw = query(name)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw bad()
  const value = Number(raw)
  if (value < min || value > max) throw bad()
  return value
}

const sourceOf = (ownerId: unknown, id: string) => ownedSource(ownerId as UserId, id)

telemetryQueriesRouter.get("/sources/:id/metrics", async c => {
  try {
    const source = await sourceOf(c.get("auth").userId, c.req.param("id"))
    const since = floorHour(Math.floor(telemetryClock.now() / 1000)) - 30 * DAY
    const metrics = await getRepo().telemetry.listMetrics(source.id, since)
    return telemetryJson({ metrics: metrics.map(m => ({ metric: m.metric, unit: m.unit, firstHour: formatHour(m.firstHour), lastHour: formatHour(m.lastHour), dims: m.dimKeys })) })
  } catch (error) { return telemetryFailure(error) }
})

telemetryQueriesRouter.get("/sources/:id/series", async c => {
  try {
    const source = await sourceOf(c.get("auth").userId, c.req.param("id"))
    const query: Query = name => c.req.query(name)
    const nowSec = Math.floor(telemetryClock.now() / 1000)
    const window = parseWindow(query("from"), query("to"), nowSec)
    const metric = metricParam(query)
    const groupBy = groupByParam(query)
    const top = intParam(query, "top", 10, 1, 20)
    const repo = getRepo().telemetry
    const settings = settingsOf(source)

    const totals = await repo.hourlyTotals(source.id, [metric], window.from, window.to)
    let groups: Awaited<ReturnType<typeof repo.groupHours>> = []
    if (groupBy !== undefined) {
      const ranked = await repo.topGroups(source.id, metric, groupBy, window.from, window.to, top)
      groups = await repo.groupHours(source.id, metric, groupBy, window.from, window.to, ranked.groups.map(group => group.key))
    }
    const built = buildSeries(window, totals, groups)
    const body: Record<string, unknown> = {
      metric, unit: totals[0]?.unit ?? null, from: formatHour(window.from), to: formatHour(window.to),
      hours: built.hours.map(formatHour), total: built.total, groups: built.groups,
    }
    if ((settings.checkMetrics ?? []).includes(metric)) {
      const statuses = checkStatuses(built.hours, totals, await repo.firstHour(source.id, metric))
      const failMetric = failMetricOf(metric)
      const rows = failMetric !== null && (settings.flagNonZeroMetrics ?? []).includes(failMetric)
        ? await repo.nonZeroRows(source.id, [failMetric], window.from, window.to, 5000) : []
      const flags = nonZeroFlags(rows, 2200)
      body.statuses = statuses
      body.stages = built.hours.map((hour, index) => statuses[index] === "failed" ? stageOf(flags, metric, hour) : null)
    }
    return telemetryJson(body)
  } catch (error) { return telemetryFailure(error) }
})

telemetryQueriesRouter.get("/sources/:id/top", async c => {
  try {
    const source = await sourceOf(c.get("auth").userId, c.req.param("id"))
    const query: Query = name => c.req.query(name)
    const window = parseWindow(query("from"), query("to"), Math.floor(telemetryClock.now() / 1000))
    const metric = metricParam(query)
    const groupBy = groupByParam(query)
    if (groupBy === undefined) throw bad()
    const limit = intParam(query, "limit", 20, 1, 100)
    const repo = getRepo().telemetry
    const length = window.to - window.from
    const current = await repo.topGroups(source.id, metric, groupBy, window.from, window.to, limit)
    const previous = await repo.groupTotals(source.id, metric, groupBy, window.from - length, window.from, current.groups.map(group => group.key))
    const top = buildTop(current.total, current.groups, previous)
    return telemetryJson({
      metric, unit: current.unit, groupBy, from: formatHour(window.from), to: formatHour(window.to),
      previousFrom: formatHour(window.from - length), previousTo: formatHour(window.from),
      total: top.total, rows: top.rows, otherCurrent: top.otherCurrent, otherShare: top.otherShare,
    })
  } catch (error) { return telemetryFailure(error) }
})

async function summarize(source: TelemetrySourceRecord, nowMs: number) {
  const repo = getRepo().telemetry
  const settings = settingsOf(source)
  const nowSec = Math.floor(nowMs / 1000)
  const nowHour = floorHour(nowSec)
  const windowStart = nowHour - (SURGE_WINDOW_HOURS - 1) * HOUR
  const windowEnd = nowHour + HOUR

  const flagMetrics = settings.flagNonZeroMetrics ?? []
  const flags = nonZeroFlags(await repo.nonZeroRows(source.id, flagMetrics, windowStart, windowEnd, 5000))

  const checkMetrics = settings.checkMetrics ?? []
  const checks = checkMetrics.length === 0 ? [] : await (async () => {
    const [values, firsts] = await Promise.all([
      repo.hourlyTotals(source.id, checkMetrics, nowHour - HOUR, nowHour),
      Promise.all(checkMetrics.map(metric => repo.firstHour(source.id, metric))),
    ])
    return checkMetrics.map((metric, index) => {
      const check = latestCheck(metric, nowSec, values.filter(row => row.metric === metric), firsts[index] ?? null, flags)
      return { metric, hour: formatHour(check.hour), status: check.status, stage: check.stage }
    })
  })()

  let budget: Record<string, unknown> | null = null
  if (settings.budgetMetric !== undefined) {
    const metric = settings.budgetMetric
    const from = Math.min(monthStart(nowSec), floorDay(nowSec) - 7 * DAY)
    const [rows, first] = await Promise.all([repo.hourlyTotals(source.id, [metric], from, windowEnd), repo.firstHour(source.id, metric)])
    const projection = projectMonth(rows, first, nowSec)
    const unit = rows[0]?.unit ?? null
    const limit = settings.monthlyLimit ?? null
    const mtdCost = unit === null ? null : costOf(projection.mtd, unit, settings)
    budget = {
      metric, unit, monthStart: formatHour(projection.monthStart), mtd: projection.mtd, projection: projection.projection, averageDaily: projection.averageDaily,
      monthlyLimit: limit, mtdPercent: limit === null ? null : projection.mtd / limit * 100,
      projectionPercent: limit === null ? null : projection.projection / limit * 100, overLimit: limit === null ? null : projection.projection > limit,
      cost: mtdCost === null || unit === null ? null : { mtd: mtdCost, projection: costOf(projection.projection, unit, settings) },
    }
  }

  const candidates = settings.surgeMetrics ?? (await repo.listMetrics(source.id, floorHour(nowSec) - 30 * DAY)).filter(info => info.unit !== "ms").map(info => info.metric)
  const surgeMetrics = [...candidates].sort().slice(0, MAX_SURGE_METRICS)
  const found: Surge[] = []
  if (surgeMetrics.length > 0) {
    const [hourly, firsts] = await Promise.all([
      repo.hourlyTotals(source.id, surgeMetrics, windowStart - SURGE_BASELINE_HOURS * HOUR, windowEnd),
      Promise.all(surgeMetrics.map(metric => repo.firstHour(source.id, metric))),
    ])
    surgeMetrics.forEach((metric, index) => {
      const rows = hourly.filter(row => row.metric === metric)
      const unit = rows[0]?.unit
      if (unit !== undefined) found.push(...findSurges({ metric, unit, hourly: rows, firstHour: firsts[index] ?? null, nowHour, settings }))
    })
  }
  const selected = selectSurges(found)
  const contributors = await Promise.all(selected.map(surge => repo.hourContributors(source.id, surge.metric, surge.hour, 5)))

  return {
    now: new Date(nowMs).toISOString(),
    freshness: freshness(source.lastPushAt, nowMs, settings.staleAfterHours),
    budget,
    surges: selected.map((surge, index) => ({ ...surge, hour: formatHour(surge.hour), contributors: contributors[index] ?? [] })),
    flags: flags.map(flag => ({ ...flag, hour: formatHour(flag.hour) })),
    checks,
  }
}

telemetryQueriesRouter.get("/sources/:id/summary", async c => {
  try {
    const source = await sourceOf(c.get("auth").userId, c.req.param("id"))
    return telemetryJson(await summarize(source, telemetryClock.now()))
  } catch (error) { return telemetryFailure(error) }
})
```

In `packages/gateway/src/control-plane/telemetry/routes.ts` add `import { telemetryQueriesRouter } from "./queries"` and, after the sources route, `telemetryManagementRouter.route("/", telemetryQueriesRouter)`.

- [ ] **Step 4: Run the tests**

Run: `bun test ./packages/gateway/tests/telemetry-queries.test.ts ./packages/gateway/tests/telemetry-sources.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/control-plane/telemetry/queries.ts packages/gateway/src/control-plane/telemetry/routes.ts packages/gateway/tests/telemetry-queries.test.ts
git commit -m "$(cat <<'EOF'
feat(telemetry): add metrics, series, top and summary query routes

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 6: Retention in scheduled maintenance

**Files:**
- Modify: `packages/gateway/src/maintenance.ts`
- Create: `packages/gateway/tests/telemetry-retention.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/gateway/tests/telemetry-retention.test.ts`:

```ts
import { afterEach, beforeEach, expect, test, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BunSqliteDatabase } from "@vibe-llm/platform-bun/src/bun-sqlite-database.ts"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { FsFileProvider } from "@vibe-llm/platform-bun/src/fs-file-provider.ts"
import { __resetPlatformForTests, initEnv } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sweepMaintenance } from "../src/maintenance"
import type { UserId } from "../src/repo/branded-ids"

const NOW = Date.UTC(2026, 10, 16, 12)
const id = `tls_${"1".repeat(32)}`
const day = 86_400
let raw: Database
let repo: BunSqliteRepo
let db: BunSqliteDatabase
let files: FsFileProvider
let root: string

const insert = (hour: number, dimsKey: string) => raw.run(
  "INSERT INTO telemetry_points (source_id, metric, hour, dims_key, dims_json, value, unit) VALUES (?, 'm', ?, ?, ?, 1, 'count')",
  [id, hour, dimsKey, dimsKey === "" ? "{}" : dimsKey])
const count = () => raw.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_points").get()?.n

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  root = await mkdtemp(join(tmpdir(), "telemetry-retention-"))
  raw = new Database(join(root, "test.sqlite"))
  repo = new BunSqliteRepo(raw)
  initRepo(repo)
  db = new BunSqliteDatabase(raw)
  files = new FsFileProvider(join(root, "files"))
  await repo.telemetry.createSourceWithinLimit({ id, ownerId: "o" as UserId, name: "vm", keyHash: "a".repeat(64), settings: {}, createdAt: "t", lastPushAt: null }, 16)
})
afterEach(async () => { raw.close(); await rm(root, { recursive: true, force: true }); __resetPlatformForTests() })

test("the maintenance sweep applies telemetry retention: 90 days with dims, 400 days without", async () => {
  const nowSec = NOW / 1000
  insert(nowSec - 91 * day, '{"k":"v"}')
  insert(nowSec - 89 * day, '{"k":"v"}')
  insert(nowSec - 401 * day, "")
  insert(nowSec - 399 * day, "")
  await sweepMaintenance(db, files, NOW)
  expect(count()).toBe(2)
})

test("a failing telemetry task is reported and does not stop the other maintenance tasks", async () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {})
  repo.telemetry.deleteExpired = async () => { throw new Error("boom") }
  await sweepMaintenance(db, files, NOW)
  const logged = warn.mock.calls.map(call => String(call[0]))
  expect(logged.some(line => line.includes("telemetry_retention"))).toBe(true)
  warn.mockRestore()
})
```

- [ ] **Step 2: Run to see it fail**

Run: `bun test ./packages/gateway/tests/telemetry-retention.test.ts`
Expected: FAIL (the first test finds 4 rows; the second finds no `telemetry_retention` warning).

- [ ] **Step 3: Add the task**

In `packages/gateway/src/maintenance.ts`, add this entry to the task list directly after the `dump_file_collection` entry:

```ts
    ["telemetry_retention", () => getRepo().telemetry.deleteExpired(now).then(() => undefined)],
```

- [ ] **Step 4: Run the tests**

Run: `bun test ./packages/gateway/tests/telemetry-retention.test.ts ./packages/gateway/tests/dump-maintenance.test.ts`
Expected: PASS. Both runtimes already call `sweepMaintenance` (`apps/platform-bun/src/server.ts` on its timer, `apps/platform-cloudflare/src/worker.ts` on the cron), so no further wiring is needed.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/maintenance.ts packages/gateway/tests/telemetry-retention.test.ts
git commit -m "$(cat <<'EOF'
feat(telemetry): expire points through scheduled maintenance

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Task 7: Agent core: configuration, log parsing, aggregation and user mapping

The agent is one file, `tools/trojan-telemetry/trojan-telemetry.py`, built over Tasks 7 to 9. Its sections are `configuration`, `users`, `logs` (this task), then `NIC totals`, `state`, `collect`, `push`, `lock` and `command line` (Task 8) and `probe` (Task 9).

**Files:**
- Create: `tools/trojan-telemetry/VERSION`, `tools/trojan-telemetry/trojan-telemetry.py`
- Create: `tools/trojan-telemetry/tests/support.py`, `tools/trojan-telemetry/tests/test_logs.py`

- [ ] **Step 1: Write the support module and the failing tests**

`tools/trojan-telemetry/tests/support.py`:

```python
"""Test helpers: load the hyphenated agent script as a module."""
import importlib.util
import os

AGENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AGENT_PATH = os.path.join(AGENT_DIR, "trojan-telemetry.py")


def load_agent():
    spec = importlib.util.spec_from_file_location("trojan_telemetry", AGENT_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
```

`tools/trojan-telemetry/tests/test_logs.py`:

```python
import json
import os
import tempfile
import unittest
from unittest import mock

from support import load_agent

agent = load_agent()

HASH_A = agent.sha224_hex("pw1")
HASH_B = agent.sha224_hex("pw2")
USERS = {HASH_A: "#1", HASH_B: "#2"}


def line(user_hash, target, sent, recv, stamp="2026-11-16T13:05:12Z"):
    return ('time="%s" level=info msg="user %s from 1.2.3.4:5555 tunneling to %s closed sent: %s recv: %s"'
            % (stamp, user_hash, target, sent, recv))


class UnitsTest(unittest.TestCase):
    def test_log_units_are_1024_based(self):
        self.assertEqual(agent.to_bytes("1.50", "KiB"), 1536)
        self.assertEqual(agent.to_bytes("2", "MiB"), 2 * 1024 ** 2)
        self.assertEqual(agent.to_bytes("0.00", "B"), 0)
        self.assertEqual(agent.to_bytes("1", "GiB"), 1024 ** 3)
        self.assertEqual(agent.to_bytes("1", "TiB"), 1024 ** 4)
        self.assertEqual(agent.to_bytes("1", "KB"), 1024)


class ParseLogTest(unittest.TestCase):
    def test_lines_aggregate_by_user_and_registrable_domain(self):
        text = "\n".join([
            line(HASH_A, "www.google.com:443", "1.00 MiB", "2.00 MiB"),
            line(HASH_A, "mail.google.com:443", "1.00 MiB", "1.00 MiB"),
            line(HASH_B, "example.org:443", "512.00 KiB", "512.00 KiB"),
            "unrelated line", 'time="x" level=info msg="user abc from 1.2.3.4:1 tunneling to a.com:80"',
        ])
        totals = agent.parse_log_text(text, USERS)
        self.assertEqual(totals[("#1", "google.com")], [2 * 1024 ** 2, 3 * 1024 ** 2, 2])
        self.assertEqual(totals[("#2", "example.org")], [524288, 524288, 1])
        self.assertEqual(len(totals), 2)

    def test_unknown_users_map_to_hash_question_mark_and_addresses_are_kept(self):
        text = "\n".join([
            line("f" * 56, "203.0.113.9:443", "1.00 KiB", "1.00 KiB"),
            line(HASH_A, "[2001:db8::1]:443", "1.00 KiB", "2.00 KiB"),
        ])
        totals = agent.parse_log_text(text, USERS)
        self.assertEqual(totals[("#?", "203.0.113.9")], [1024, 1024, 1])
        self.assertEqual(totals[("#1", "2001:db8::1")], [1024, 2048, 1])

    def test_a_hash_in_upper_case_still_maps(self):
        totals = agent.parse_log_text(line(HASH_A.upper(), "a.com:80", "1.00 B", "1.00 B"), USERS)
        self.assertIn(("#1", "a.com"), totals)


class DomainTest(unittest.TestCase):
    def test_registrable_domain_heuristic(self):
        cases = [
            ("www.google.com", "google.com"), ("example.com", "example.com"), ("a.b.c.example.co.uk", "example.co.uk"),
            ("bbc.co.uk", "bbc.co.uk"), ("foo.bar.com.cn", "bar.com.cn"), ("x.gov.au", "x.gov.au"), ("sub.example.de", "example.de"),
            ("a.co.jp", "a.co.jp"), ("localhost", "localhost"), ("EXAMPLE.COM.", "example.com"),
            ("203.0.113.9", "203.0.113.9"), ("2001:db8::1", "2001:db8::1"),
            # Known limit of the heuristic (no public suffix list): longer public suffixes group one level too coarse.
            ("foo.pvt.k12.ma.us", "ma.us"),
        ]
        for host, expected in cases:
            self.assertEqual(agent.registrable_domain(host), expected, host)


class TopTest(unittest.TestCase):
    def totals(self):
        return {
            ("#1", "a.com"): [10, 0, 1], ("#1", "b.com"): [30, 0, 3], ("#1", "c.com"): [20, 0, 2], ("#1", "d.com"): [5, 0, 1],
            ("#1", "e.com"): [5, 0, 4], ("#2", "z.com"): [1, 1, 1],
        }

    def test_domains_beyond_the_top_n_fold_into_other_per_user(self):
        folded = agent.fold_top(self.totals(), 2)
        self.assertEqual(folded[("#1", "b.com")], [30, 0, 3])
        self.assertEqual(folded[("#1", "c.com")], [20, 0, 2])
        self.assertEqual(folded[("#1", "(other)")], [20, 0, 6])
        self.assertEqual(folded[("#2", "z.com")], [1, 1, 1])
        self.assertEqual(len(folded), 4)

    def test_equal_totals_are_ordered_by_domain_and_nothing_folds_when_it_fits(self):
        self.assertEqual(agent.fold_top({("#1", "b.com"): [1, 0, 1], ("#1", "a.com"): [1, 0, 1]}, 1)[("#1", "a.com")], [1, 0, 1])
        self.assertNotIn(("#1", "(other)"), agent.fold_top(self.totals(), 10))

    def test_points_carry_three_proxy_metrics_with_user_and_domain_dims(self):
        hour = 1_794_000_000 - 1_794_000_000 % 3600
        points = agent.build_proxy_points(hour, {("#1", "a.com"): [10, 20, 2]}, 50)
        label = agent.iso_hour(hour)
        dims = {"user": "#1", "domain": "a.com"}
        self.assertEqual(points, [
            {"metric": "proxy.sent_bytes", "hour": label, "dims": dims, "value": 10, "unit": "bytes"},
            {"metric": "proxy.recv_bytes", "hour": label, "dims": dims, "value": 20, "unit": "bytes"},
            {"metric": "proxy.connections", "hour": label, "dims": dims, "value": 2, "unit": "count"},
        ])

    def test_an_hour_is_tightened_until_it_fits_one_batch(self):
        totals = {("#1", "d%02d.com" % i): [i + 1, 0, 1] for i in range(10)}
        with mock.patch.object(agent, "MAX_BATCH_POINTS", 12):
            points = agent.build_proxy_points(0, totals, 10)
        self.assertEqual(len(points), 9)
        self.assertIn("(other)", [p["dims"]["domain"] for p in points])


class UsersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.config = os.path.join(self.tmp, "config.json")
        with open(self.config, "w") as handle:
            json.dump({"password": ["pw1", "pw2"]}, handle)

    def cfg(self, **extra):
        env = {"TELEMETRY_GATEWAY": "http://gw", "TELEMETRY_KEY": "tlm_x"}
        env.update(extra)
        return agent.Config(env)

    def test_passwords_in_file_order_become_numbered_users(self):
        users, passwords = agent.build_user_map(self.cfg(TROJAN_CONFIG=self.config), lambda *a, **k: (1, "", ""))
        self.assertEqual(users, {HASH_A: "#1", HASH_B: "#2"})
        self.assertEqual(passwords, ["pw1", "pw2"])

    def test_trojan_users_wins_and_keeps_its_order(self):
        users, passwords = agent.build_user_map(self.cfg(TROJAN_CONFIG=self.config, TROJAN_USERS="AAA, bbb\nccc"), lambda *a, **k: (1, "", ""))
        self.assertEqual(users, {"aaa": "#1", "bbb": "#2", "ccc": "#3"})
        self.assertEqual(passwords, ["pw1", "pw2"])

    def test_the_config_is_found_through_docker_bind_mounts(self):
        mounts = json.dumps([{"Source": "/nowhere", "Destination": "/data"}, {"Source": self.tmp, "Destination": "/etc/trojan-go"}])
        calls = []

        def runner(args, timeout=300):
            calls.append(args)
            return 0, mounts, ""

        self.assertEqual(agent.find_config_path(self.cfg(), runner), self.config)
        self.assertEqual(calls[0][:2], ["docker", "inspect"])
        file_mount = json.dumps([{"Source": self.config, "Destination": "/etc/trojan-go/config.json"}])
        self.assertEqual(agent.find_config_path(self.cfg(), lambda *a, **k: (0, file_mount, "")), self.config)

    def test_default_locations_are_the_last_resort_and_a_missing_config_is_not_fatal(self):
        with mock.patch.object(agent, "DEFAULT_CONFIG_PATHS", [os.path.join(self.tmp, "missing.json"), self.config]):
            self.assertEqual(agent.find_config_path(self.cfg(), lambda *a, **k: (1, "", "")), self.config)
        with mock.patch.object(agent, "DEFAULT_CONFIG_PATHS", [os.path.join(self.tmp, "missing.json")]):
            self.assertIsNone(agent.find_config_path(self.cfg(), lambda *a, **k: (1, "", "")))
            self.assertEqual(agent.build_user_map(self.cfg(), lambda *a, **k: (1, "", "")), ({}, []))


class ConfigTest(unittest.TestCase):
    def test_defaults_and_overrides(self):
        cfg = agent.Config({"TELEMETRY_GATEWAY": "https://gw.example/", "TELEMETRY_KEY": "tlm_x"})
        self.assertEqual((cfg.gateway, cfg.container, cfg.iface, cfg.top_domains), ("https://gw.example", "trojan", "eth0", 50))
        self.assertEqual((cfg.sni, cfg.probe_host, cfg.probe_port, cfg.probe_target, cfg.probe_timeout),
                         ("trojan.xianliao.de5.net", "trojan.xianliao.de5.net", 443, "www.gstatic.com:80", 15.0))
        custom = agent.Config({"TELEMETRY_GATEWAY": "g", "TELEMETRY_KEY": "k", "TOP_DOMAINS": "5", "PROBE_HOST": "10.0.0.1", "TROJAN_SNI": "x.example"})
        self.assertEqual((custom.top_domains, custom.probe_host, custom.sni), (5, "10.0.0.1", "x.example"))

    def test_missing_or_malformed_values_are_configuration_errors(self):
        for env in [{}, {"TELEMETRY_GATEWAY": "g"}, {"TELEMETRY_KEY": "k"},
                    {"TELEMETRY_GATEWAY": "g", "TELEMETRY_KEY": "k", "TOP_DOMAINS": "0"},
                    {"TELEMETRY_GATEWAY": "g", "TELEMETRY_KEY": "k", "PROBE_TIMEOUT": "x"},
                    {"TELEMETRY_GATEWAY": "g", "TELEMETRY_KEY": "k", "PROBE_TARGET": "nohostport"}]:
            with self.assertRaises(agent.ConfigError):
                agent.Config(env)

    def test_the_env_file_is_parsed_with_quotes_and_never_overrides_the_environment(self):
        path = os.path.join(tempfile.mkdtemp(), "agent.env")
        with open(path, "w") as handle:
            handle.write("# comment\nTELEMETRY_GATEWAY='https://gw.example'\nTELEMETRY_KEY='it'\\''s'\nTROJAN_CONTAINER=plain\nbad line\nlower=1\n")
        env = {"TROJAN_CONTAINER": "from-env"}
        agent.load_env_file(path, env)
        self.assertEqual(env, {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "it's", "TROJAN_CONTAINER": "from-env"})
        agent.load_env_file(os.path.join(path, "missing"), env)


class TimeTest(unittest.TestCase):
    def test_hour_helpers_round_trip(self):
        epoch = agent.parse_iso("2026-11-16T13:00:00Z")
        self.assertEqual(agent.iso_hour(epoch), "2026-11-16T13:00:00Z")
        self.assertEqual(agent.hour_label(epoch), "2026-11-16T13")
        self.assertEqual(agent.parse_hour_label("2026-11-16T13"), epoch)
        self.assertEqual(agent.floor_hour(epoch + 1799), epoch)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to see it fail**

Run: `cd tools/trojan-telemetry && python3 -m unittest discover -s tests -v`
Expected: FAIL (the agent script does not exist yet: `FileNotFoundError` from `support.load_agent`).

- [ ] **Step 3: Create the version file and the agent core**

`tools/trojan-telemetry/VERSION` (one line):

```
1.0.0
```

`tools/trojan-telemetry/trojan-telemetry.py`:

```python
#!/usr/bin/env python3
"""Hourly telemetry agent for a trojan-go proxy.

For every closed hour it computes per-user, per-domain traffic from `docker logs` and NIC totals from `vnstat`, keeps the
result in an outbox, pushes the outbox to a gateway (POST /api/telemetry/push) and probes the proxy end to end once per run.
Python 3 standard library only. See docs/telemetry-v1.md.
"""
import argparse
import calendar
import fcntl
import hashlib
import json
import os
import re
import shlex
import socket
import ssl
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

AGENT_VERSION = "1.0.0"

HOUR = 3600
DAY = 86400
DEFAULT_ENV_FILE = "/etc/trojan-telemetry.env"
DEFAULT_STATE_DIR = "/var/lib/trojan-telemetry"
DEFAULT_CONFIG_PATHS = ["/etc/trojan-go/config.json", "/etc/trojan/config.json"]
BACKFILL_HOURS = 24
MAX_AGE_DAYS = 30
MAX_BATCH_HOURS = 24
MAX_BATCH_POINTS = 10000
MAX_BATCH_BYTES = 1536 * 1024
OTHER = "(other)"
UNKNOWN_USER = "#?"
# Second-level labels that sit under a two-letter country code (example.co.uk, example.com.cn, x.gov.au).
GENERIC_SECOND_LEVEL = frozenset(["com", "co", "net", "org", "gov", "edu", "ac", "or", "ne", "go", "mil", "ltd", "plc", "nhs", "sch", "nom"])
UNITS = {"B": 1, "KB": 1024, "MB": 1024 ** 2, "GB": 1024 ** 3, "TB": 1024 ** 4,
         "KiB": 1024, "MiB": 1024 ** 2, "GiB": 1024 ** 3, "TiB": 1024 ** 4}


class ConfigError(Exception):
    pass


class CollectError(Exception):
    pass


def warn(message):
    sys.stderr.write("trojan-telemetry: %s\n" % message)


# ---- time ----

def floor_hour(epoch):
    return epoch - epoch % HOUR


def iso_hour(epoch):
    return time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(epoch))


def hour_label(epoch):
    return time.strftime("%Y-%m-%dT%H", time.gmtime(epoch))


def parse_iso(text):
    return calendar.timegm(time.strptime(text, "%Y-%m-%dT%H:%M:%SZ"))


def parse_hour_label(text):
    return calendar.timegm(time.strptime(text, "%Y-%m-%dT%H"))


# ---- configuration ----

def _number(env, name, default, low, high, cast):
    raw = env.get(name, "")
    if raw == "":
        return default
    try:
        value = cast(raw)
    except ValueError:
        raise ConfigError("%s must be a number" % name)
    if value < low or value > high:
        raise ConfigError("%s must be between %s and %s" % (name, low, high))
    return value


def split_target(target):
    """'host:port' or '[v6]:port' -> (host, port string)."""
    host, _, port = target.rpartition(":")
    return host.strip("[]"), port


class Config(object):
    def __init__(self, env):
        self.gateway = env.get("TELEMETRY_GATEWAY", "").strip().rstrip("/")
        self.key = env.get("TELEMETRY_KEY", "").strip()
        if not self.gateway or not self.key:
            raise ConfigError("TELEMETRY_GATEWAY and TELEMETRY_KEY are required")
        self.container = env.get("TROJAN_CONTAINER", "") or "trojan"
        self.iface = env.get("TELEMETRY_IFACE", "") or "eth0"
        self.users = env.get("TROJAN_USERS", "")
        self.config_path = env.get("TROJAN_CONFIG", "")
        self.top_domains = _number(env, "TOP_DOMAINS", 50, 1, 1000, int)
        self.sni = env.get("TROJAN_SNI", "") or "trojan.xianliao.de5.net"
        self.probe_host = env.get("PROBE_HOST", "") or self.sni
        self.probe_port = _number(env, "PROBE_PORT", 443, 1, 65535, int)
        self.probe_target = env.get("PROBE_TARGET", "") or "www.gstatic.com:80"
        host, port = split_target(self.probe_target)
        if not host or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise ConfigError("PROBE_TARGET must be host:port")
        self.probe_timeout = _number(env, "PROBE_TIMEOUT", 15.0, 0.5, 120.0, float)
        # Test-only: trust this CA file instead of the system store when verifying the proxy certificate.
        self.ca_file = env.get("PROBE_CA_FILE", "") or None


def load_env_file(path, environ):
    """Reads KEY='value' lines; variables already in the environment win."""
    try:
        handle = open(path)
    except OSError:
        return
    with handle:
        for raw in handle:
            text = raw.strip()
            if not text or text.startswith("#") or "=" not in text:
                continue
            key, value = text.split("=", 1)
            key = key.strip()
            if not re.match(r"^[A-Z][A-Z0-9_]*$", key):
                continue
            try:
                parts = shlex.split(value)
            except ValueError:
                continue
            environ.setdefault(key, parts[0] if parts else "")


def run_command(args, timeout=300):
    """Returns (returncode, stdout, stderr); a missing executable is 127 and a timeout 124."""
    try:
        done = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    except FileNotFoundError:
        return 127, "", "%s: command not found" % args[0]
    except subprocess.TimeoutExpired:
        return 124, "", "%s: timed out" % args[0]
    return done.returncode, done.stdout.decode("utf-8", "replace"), done.stderr.decode("utf-8", "replace")


# ---- users ----

def sha224_hex(password):
    return hashlib.sha224(password.encode("utf-8")).hexdigest()


def read_config_passwords(path):
    with open(path) as handle:
        data = json.load(handle)
    passwords = data.get("password", []) if isinstance(data, dict) else []
    return [p for p in passwords if isinstance(p, str)]


def find_config_path(cfg, runner):
    """TROJAN_CONFIG, else a bind mount of the container that holds config.json, else the usual locations."""
    if cfg.config_path:
        return cfg.config_path
    code, out, _ = runner(["docker", "inspect", "-f", "{{json .Mounts}}", cfg.container])
    if code == 0:
        try:
            mounts = json.loads(out)
        except ValueError:
            mounts = []
        for mount in mounts if isinstance(mounts, list) else []:
            source = mount.get("Source") if isinstance(mount, dict) else None
            if not source:
                continue
            if str(mount.get("Destination", "")).endswith(".json") and os.path.isfile(source):
                return source
            candidate = os.path.join(source, "config.json")
            if os.path.isfile(candidate):
                return candidate
    for path in DEFAULT_CONFIG_PATHS:
        if os.path.isfile(path):
            return path
    return None


def build_user_map(cfg, runner):
    """Returns ({hash: '#n'}, [passwords]). TROJAN_USERS wins over the config's password order."""
    passwords = []
    path = find_config_path(cfg, runner)
    if path:
        try:
            passwords = read_config_passwords(path)
        except (OSError, ValueError) as exc:
            warn("cannot read %s: %s" % (path, exc))
    if cfg.users.strip():
        hashes = [h.lower() for h in re.split(r"[\s,]+", cfg.users.strip()) if h]
        return dict((h, "#%d" % (i + 1)) for i, h in enumerate(hashes)), passwords
    return dict((sha224_hex(p), "#%d" % (i + 1)) for i, p in enumerate(passwords)), passwords


# ---- logs ----

LOG_LINE = re.compile(
    r"user (?P<user>[0-9a-fA-F]+) .*?tunneling to (?P<target>\S+) closed "
    r"sent: (?P<sent>[0-9]+(?:\.[0-9]+)?) (?P<sent_unit>[KMGT]?i?B) "
    r"recv: (?P<recv>[0-9]+(?:\.[0-9]+)?) (?P<recv_unit>[KMGT]?i?B)")


def to_bytes(number, unit):
    return int(round(float(number) * UNITS[unit]))


def is_ip(host):
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            socket.inet_pton(family, host)
            return True
        except (OSError, ValueError):
            continue
    return False


def registrable_domain(host):
    """Heuristic without a public suffix list: IPs are kept, otherwise the last 2 labels (3 under a generic second level)."""
    host = host.strip().rstrip(".").lower()
    if not host or is_ip(host):
        return host
    labels = host.split(".")
    if len(labels) <= 2:
        return host
    if len(labels[-1]) == 2 and labels[-2] in GENERIC_SECOND_LEVEL:
        return ".".join(labels[-3:])
    return ".".join(labels[-2:])


def parse_log_text(text, user_map):
    """{(user, domain): [sent_bytes, recv_bytes, connections]} for every closed-tunnel line."""
    totals = {}
    for raw in text.splitlines():
        match = LOG_LINE.search(raw)
        if not match:
            continue
        host, _ = split_target(match.group("target"))
        key = (user_map.get(match.group("user").lower(), UNKNOWN_USER), registrable_domain(host))
        bucket = totals.setdefault(key, [0, 0, 0])
        bucket[0] += to_bytes(match.group("sent"), match.group("sent_unit"))
        bucket[1] += to_bytes(match.group("recv"), match.group("recv_unit"))
        bucket[2] += 1
    return totals


def fold_top(totals, top_n):
    """Keeps each user's top_n domains by total bytes and folds the rest into '(other)'."""
    by_user = {}
    for (user, domain), values in totals.items():
        by_user.setdefault(user, []).append((domain, values))
    folded = {}
    for user, items in by_user.items():
        items.sort(key=lambda item: (-(item[1][0] + item[1][1]), item[0]))
        for domain, values in items[:top_n]:
            folded[(user, domain)] = list(values)
        rest = items[top_n:]
        if rest:
            other = folded.setdefault((user, OTHER), [0, 0, 0])
            for _, values in rest:
                for index in range(3):
                    other[index] += values[index]
    return folded


def point(metric, hour_iso, dims, value, unit):
    entry = {"metric": metric, "hour": hour_iso, "value": value, "unit": unit}
    if dims:
        entry["dims"] = dims
    return entry


def build_proxy_points(hour_epoch, totals, top_n):
    """Proxy points for one hour; the per-user top N is halved until the hour fits one push batch."""
    label = iso_hour(hour_epoch)
    while True:
        folded = fold_top(totals, top_n)
        points = []
        for (user, domain) in sorted(folded):
            sent, recv, connections = folded[(user, domain)]
            dims = {"user": user, "domain": domain}
            points.append(point("proxy.sent_bytes", label, dict(dims), sent, "bytes"))
            points.append(point("proxy.recv_bytes", label, dict(dims), recv, "bytes"))
            points.append(point("proxy.connections", label, dict(dims), connections, "count"))
        if len(points) <= MAX_BATCH_POINTS or top_n <= 1:
            return points
        top_n = max(1, top_n // 2)
```

(The `point` helper keeps the key order `metric, hour, value, unit, dims`; tests compare dictionaries, so order is irrelevant.)

- [ ] **Step 4: Run the tests**

Run: `cd tools/trojan-telemetry && python3 -m unittest discover -s tests -v`
Expected: every test in `test_logs.py` passes.

- [ ] **Step 5: Commit**

```bash
git add tools/trojan-telemetry/VERSION tools/trojan-telemetry/trojan-telemetry.py tools/trojan-telemetry/tests/support.py tools/trojan-telemetry/tests/test_logs.py
git commit -m "$(cat <<'EOF'
feat(telemetry): add the trojan agent core for log parsing, aggregation and user mapping

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 8: Agent: vnstat, cursor and outbox, push, discard, lock and CLI

**Files:**
- Modify: `tools/trojan-telemetry/trojan-telemetry.py` (append)
- Create: `tools/trojan-telemetry/tests/test_runner.py`

- [ ] **Step 1: Write the failing tests**

`tools/trojan-telemetry/tests/test_runner.py`:

```python
import io
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

from support import load_agent

agent = load_agent()

KEY = "tlm_" + "a" * 64
NOW = "2026-11-16T14:05:00Z"
HASH_A = agent.sha224_hex("pw1")


def line(user_hash, target, sent, recv, stamp):
    return ('time="%s" level=info msg="user %s from 1.2.3.4:5555 tunneling to %s closed sent: %s recv: %s"'
            % (stamp, user_hash, target, sent, recv))


def vnstat_v2(rows):
    entries = [{"id": i, "date": {"year": y, "month": m, "day": d}, "time": {"hour": h, "minute": 0}, "rx": rx, "tx": tx}
               for i, (y, m, d, h, rx, tx) in enumerate(rows)]
    return json.dumps({"vnstatversion": "2.6", "jsonversion": "2", "interfaces": [{"name": "eth0", "traffic": {"hour": entries}}]})


class PushServer(object):
    """Records pushes and answers with scripted statuses (200 once the script runs out)."""

    def __init__(self, statuses=None):
        self.statuses = list(statuses or [])
        self.requests = []
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                outer.requests.append({"path": self.path, "auth": self.headers.get("Authorization"),
                                       "type": self.headers.get("Content-Type"), "body": json.loads(body.decode("utf-8"))})
                status = outer.statuses.pop(0) if outer.statuses else 200
                self.send_response(status)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d" % self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class FakeRunner(object):
    """Stands in for docker and vnstat."""

    def __init__(self):
        self.calls = []
        self.logs = {}
        self.fail_since = set()
        self.vnstat = vnstat_v2([])
        self.vnstat_code = 0

    def __call__(self, args, timeout=300):
        self.calls.append(list(args))
        if args[:2] == ["docker", "logs"]:
            since = args[3]
            if since in self.fail_since:
                return 1, "", "Error: no such container"
            return 0, "", self.logs.get(since, "")
        if args[0] == "vnstat":
            return self.vnstat_code, self.vnstat if self.vnstat_code == 0 else "", "" if self.vnstat_code == 0 else "vnstat: failed"
        return 1, "", "unsupported"

    def since(self):
        return [call[3] for call in self.calls if call[:2] == ["docker", "logs"]]


class RunnerCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.state_dir = os.path.join(self.tmp, "state")
        self.previous_tz = os.environ.get("TZ")
        os.environ["TZ"] = "UTC"
        time.tzset()
        self.addCleanup(self.restore_tz)
        patcher = mock.patch.object(agent, "DEFAULT_CONFIG_PATHS", [])
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = PushServer()
        self.addCleanup(self.close_server)
        self.runner = FakeRunner()
        self.env = {"TELEMETRY_GATEWAY": self.server.url, "TELEMETRY_KEY": KEY, "TROJAN_USERS": HASH_A}

    def restore_tz(self):
        if self.previous_tz is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = self.previous_tz
        time.tzset()

    def close_server(self):
        try:
            self.server.close()
        except Exception:
            pass

    def run_main(self, now=NOW, env=None):
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", io.StringIO()):
            code = agent.main(["run", "--state-dir", self.state_dir, "--env-file", os.path.join(self.tmp, "none.env"), "--now", now],
                              environ=dict(self.env if env is None else env), runner=self.runner)
        return code, out.getvalue()

    def set_cursor(self, iso):
        os.makedirs(os.path.join(self.state_dir, "outbox"), exist_ok=True)
        with open(os.path.join(self.state_dir, "cursor.json"), "w") as handle:
            json.dump({"cursor": iso}, handle)

    def cursor(self):
        with open(os.path.join(self.state_dir, "cursor.json")) as handle:
            return json.load(handle)["cursor"]

    def outbox(self):
        return sorted(os.listdir(os.path.join(self.state_dir, "outbox")))


class CollectTest(RunnerCase):
    def test_catch_up_across_a_gap_processes_each_closed_hour_oldest_first_and_pushes_them(self):
        self.set_cursor("2026-11-16T09:00:00Z")
        self.runner.logs["2026-11-16T11:00:00Z"] = line(HASH_A, "www.google.com:443", "1.00 KiB", "2.00 KiB", "2026-11-16T11:30:00Z")
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(self.runner.since(), ["2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z", "2026-11-16T13:00:00Z"])
        self.assertEqual(len(self.server.requests), 1)
        request = self.server.requests[0]
        self.assertEqual((request["path"], request["auth"], request["type"]), ("/api/telemetry/push", "Bearer " + KEY, "application/json"))
        self.assertEqual(request["body"]["version"], 1)
        self.assertEqual(sorted(set(p["hour"] for p in request["body"]["points"])), ["2026-11-16T11:00:00Z"])
        self.assertEqual(self.cursor(), "2026-11-16T13:00:00Z")
        self.assertEqual(self.outbox(), [])

    def test_a_first_run_backfills_24_hours_and_empty_hours_still_push(self):
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        since = self.runner.since()
        self.assertEqual((len(since), since[0], since[-1]), (24, "2026-11-15T14:00:00Z", "2026-11-16T13:00:00Z"))
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.server.requests[0]["body"], {"version": 1, "points": []})

    def test_a_cursor_older_than_30_days_is_clamped(self):
        self.set_cursor("2026-09-01T00:00:00Z")
        cfg = agent.Config(self.env)
        state = agent.State(self.state_dir)
        state.ensure()
        agent.collect(cfg, state, {}, self.runner, agent.parse_iso(NOW))
        names = self.outbox()
        self.assertEqual((len(names), names[0], names[-1]), (720, "2026-10-17T14.json", "2026-11-16T13.json"))

    def test_a_docker_failure_stops_the_loop_without_advancing_the_cursor(self):
        self.set_cursor("2026-11-16T09:00:00Z")
        self.runner.fail_since = {"2026-11-16T12:00:00Z"}
        code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.runner.since(), ["2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z"])
        self.assertEqual(self.cursor(), "2026-11-16T11:00:00Z")
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.outbox(), [])

    def test_a_vnstat_failure_stops_before_anything_is_recorded(self):
        self.runner.vnstat_code = 1
        code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(os.path.join(self.state_dir, "cursor.json")))
        self.assertEqual(self.outbox(), [])
        self.assertEqual(self.server.requests, [])

    def test_a_missing_vnstat_row_is_not_a_failure(self):
        self.set_cursor("2026-11-16T09:00:00Z")
        self.runner.vnstat = vnstat_v2([(2026, 11, 16, 11, 100, 200)])
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        points = self.server.requests[0]["body"]["points"]
        self.assertEqual(sorted((p["metric"], p["hour"], p["value"]) for p in points),
                         [("nic.rx_bytes", "2026-11-16T11:00:00Z", 100), ("nic.tx_bytes", "2026-11-16T11:00:00Z", 200)])
        self.assertTrue(all(p["unit"] == "bytes" and "dims" not in p for p in points))

    def test_the_outbox_file_exists_before_the_cursor_moves(self):
        self.set_cursor("2026-11-16T12:00:00Z")
        with mock.patch.object(agent.State, "write_cursor", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                self.run_main()
        self.assertEqual(self.outbox(), ["2026-11-16T13.json"])
        self.assertEqual(self.cursor(), "2026-11-16T12:00:00Z")

    def test_nothing_is_left_half_written(self):
        self.run_main()
        self.assertEqual(sorted(os.listdir(self.state_dir)), ["cursor.json", "lock", "outbox"])


class VnstatTest(RunnerCase):
    def test_v2_is_bytes_and_v1_is_kib(self):
        hour = agent.parse_iso("2026-11-16T13:00:00Z")
        self.assertEqual(agent.parse_vnstat(vnstat_v2([(2026, 11, 16, 13, 1000, 2000)]), "eth0"), {hour: (1000, 2000)})
        v1 = json.dumps({"vnstatversion": "1.18", "jsonversion": "1.2", "interfaces": [
            {"id": "eth0", "nick": "eth0", "traffic": {"hours": [{"id": 13, "date": {"year": 2026, "month": 11, "day": 16}, "rx": 1, "tx": 2}]}}]})
        self.assertEqual(agent.parse_vnstat(v1, "eth0"), {hour: (1024, 2048)})
        self.assertEqual(agent.parse_vnstat(vnstat_v2([(2026, 11, 16, 13, 1, 2)]), "wlan0"), {})
        with self.assertRaises(agent.CollectError):
            agent.parse_vnstat("not json", "eth0")

    def test_local_time_hours_are_converted_to_utc(self):
        os.environ["TZ"] = "Asia/Shanghai"
        time.tzset()
        parsed = agent.parse_vnstat(vnstat_v2([(2026, 11, 16, 21, 5, 6)]), "eth0")
        self.assertEqual(list(parsed), [agent.parse_iso("2026-11-16T13:00:00Z")])


class BatchTest(RunnerCase):
    def entries(self, hours, per_hour=1, probe_for=()):
        result = []
        base = agent.parse_iso("2026-11-10T00:00:00Z")
        for index in range(hours):
            epoch = base + index * 3600
            points = [agent.point("m", agent.iso_hour(epoch), {"k": str(i)}, 1, "count") for i in range(per_hour)]
            result.append((epoch, agent.hour_label(epoch) + ".json", points))
            if index in probe_for:
                result.append((epoch, agent.hour_label(epoch) + ".probe.json", [agent.point("probe.ok", agent.iso_hour(epoch), {}, 1, "count")]))
        return result

    def test_at_most_24_hours_per_batch_and_an_hours_probe_file_never_splits_from_it(self):
        batches = agent.plan_batches(self.entries(30, probe_for=(23, 24)))
        self.assertEqual([len(b["hours"]) for b in batches], [24, 6])
        self.assertEqual(sum(len(b["names"]) for b in batches), 32)
        self.assertIn("2026-11-10T23.probe.json", batches[0]["names"])
        self.assertIn("2026-11-11T00.probe.json", batches[1]["names"])

    def test_points_per_batch_are_capped_without_splitting_an_hour(self):
        batches = agent.plan_batches(self.entries(5, per_hour=4000))
        self.assertEqual([len(b["hours"]) for b in batches], [2, 2, 1])
        self.assertTrue(all(len(b["points"]) <= 10000 for b in batches))

    def test_the_body_size_is_capped_and_an_oversized_hour_travels_alone(self):
        with mock.patch.object(agent, "MAX_BATCH_BYTES", 1200):
            batches = agent.plan_batches(self.entries(4, per_hour=5))
            self.assertTrue(all(b["bytes"] <= 1200 or len(b["hours"]) == 1 for b in batches))
            self.assertGreater(len(batches), 1)
            self.assertEqual(sum(len(b["hours"]) for b in batches), 4)
            alone = agent.plan_batches(self.entries(1, per_hour=50))
            self.assertEqual([len(b["hours"]) for b in alone], [1])


class PushTest(RunnerCase):
    def test_a_failed_push_stops_the_rest_and_keeps_their_files(self):
        self.set_cursor("2026-11-16T10:00:00Z")
        self.server.statuses = [200, 500]
        with mock.patch.object(agent, "MAX_BATCH_HOURS", 1):
            code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(len(self.server.requests), 2)
        self.assertEqual(self.outbox(), ["2026-11-16T12.json", "2026-11-16T13.json"])
        self.assertEqual(self.cursor(), "2026-11-16T13:00:00Z")

    def test_an_unreachable_gateway_keeps_every_file_and_fails_the_run(self):
        self.server.close()
        self.set_cursor("2026-11-16T11:00:00Z")
        code, _ = self.run_main()
        self.assertEqual(code, 1)
        self.assertEqual(self.outbox(), ["2026-11-16T12.json", "2026-11-16T13.json"])

    def test_the_next_run_pushes_what_a_failed_run_kept(self):
        self.set_cursor("2026-11-16T11:00:00Z")
        self.server.statuses = [503]
        self.assertEqual(self.run_main()[0], 1)
        self.assertEqual(self.run_main()[0], 0)
        self.assertEqual(self.outbox(), [])
        self.assertEqual(sorted(set(p["hour"] for p in self.server.requests[-1]["body"]["points"])), [])
        self.assertEqual(len(self.server.requests), 2)

    def test_outbox_files_older_than_30_days_are_discarded_unpushed(self):
        state = agent.State(self.state_dir)
        state.ensure()
        state.write_outbox(agent.parse_iso("2026-10-16T14:00:00Z"), [], False)
        state.write_outbox(agent.parse_iso("2026-10-18T14:00:00Z"), [], False)
        agent.discard_expired(state, agent.parse_iso(NOW))
        self.assertEqual(self.outbox(), ["2026-10-18T14.json"])

    def test_an_unreadable_outbox_file_is_removed(self):
        state = agent.State(self.state_dir)
        state.ensure()
        with open(os.path.join(self.state_dir, "outbox", "2026-11-16T10.json"), "w") as handle:
            handle.write("{broken")
        self.assertEqual(agent.load_outbox(state), [])
        self.assertEqual(self.outbox(), [])


class CommandLineTest(RunnerCase):
    def test_a_held_lock_means_exit_zero_without_doing_anything(self):
        os.makedirs(self.state_dir)
        held = agent.acquire_lock(self.state_dir)
        self.assertIsNotNone(held)
        self.assertIsNone(agent.acquire_lock(self.state_dir))
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(self.runner.calls, [])
        self.assertEqual(self.server.requests, [])
        os.close(held)
        again = agent.acquire_lock(self.state_dir)
        self.assertIsNotNone(again)
        os.close(again)

    def test_configuration_and_clock_errors_exit_two(self):
        self.assertEqual(self.run_main(env={"TELEMETRY_GATEWAY": self.server.url})[0], 2)
        self.assertEqual(self.run_main(now="yesterday")[0], 2)

    def test_the_env_file_supplies_the_configuration(self):
        env_path = os.path.join(self.tmp, "agent.env")
        with open(env_path, "w") as handle:
            handle.write("TELEMETRY_GATEWAY='%s'\nTELEMETRY_KEY='%s'\n" % (self.server.url, KEY))
        out = io.StringIO()
        with mock.patch.object(sys, "stdout", out), mock.patch.object(sys, "stderr", io.StringIO()):
            code = agent.main(["run", "--state-dir", self.state_dir, "--env-file", env_path, "--now", NOW], environ={}, runner=self.runner)
        self.assertEqual(code, 0)
        self.assertEqual(self.server.requests[0]["auth"], "Bearer " + KEY)

    def test_the_version_matches_the_version_file(self):
        with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "VERSION")) as handle:
            self.assertEqual(handle.read().strip(), agent.AGENT_VERSION)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to see it fail**

Run: `cd tools/trojan-telemetry && python3 -m unittest tests.test_runner -v 2>&1 | tail -5` (or `python3 -m unittest discover -s tests -p 'test_runner.py'`)
Expected: errors (`AttributeError: module has no attribute 'State'` and similar).

- [ ] **Step 3: Append the rest of the agent**

Append to `tools/trojan-telemetry/trojan-telemetry.py`:

```python


# ---- NIC totals ----

def parse_vnstat(text, iface):
    """{utc hour epoch: (rx_bytes, tx_bytes)} from `vnstat --json h`. JSON v1 counts KiB, v2 bytes; hours are local time."""
    try:
        data = json.loads(text)
    except ValueError as exc:
        raise CollectError("vnstat returned invalid JSON: %s" % exc)
    legacy = str(data.get("jsonversion", "2")).startswith("1")
    scale = 1024 if legacy else 1
    hours = {}
    for entry in data.get("interfaces", []):
        if (entry.get("name") or entry.get("id")) != iface:
            continue
        for row in entry.get("traffic", {}).get("hours" if legacy else "hour", []):
            try:
                date = row["date"]
                hour_of_day = row["time"]["hour"] if "time" in row else row["id"]
                local = (int(date["year"]), int(date["month"]), int(date["day"]), int(hour_of_day), 0, 0, 0, 0, -1)
                epoch = int(time.mktime(local))
                hours[floor_hour(epoch)] = (int(round(float(row["rx"]) * scale)), int(round(float(row["tx"]) * scale)))
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
    return hours


class NicTotals(object):
    """vnstat is read once per run, the first time an hour needs it. vnstat may lag up to five minutes behind the clock."""

    def __init__(self, cfg, runner):
        self.cfg = cfg
        self.runner = runner
        self.hours = None

    def get(self, hour_epoch):
        if self.hours is None:
            code, out, err = self.runner(["vnstat", "--json", "h", "-i", self.cfg.iface])
            if code != 0:
                raise CollectError("vnstat failed (%d): %s" % (code, err.strip()[:200]))
            self.hours = parse_vnstat(out, self.cfg.iface)
        return self.hours.get(hour_epoch)


# ---- state ----

OUTBOX_NAME = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2})(?:\.probe)?\.json$")


def atomic_write(path, text):
    temporary = path + ".tmp"
    with open(temporary, "w") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


class State(object):
    """cursor.json holds the last fully processed hour; outbox/ holds computed, unpushed hours."""

    def __init__(self, directory):
        self.directory = directory
        self.outbox = os.path.join(directory, "outbox")
        self.cursor_path = os.path.join(directory, "cursor.json")

    def ensure(self):
        os.makedirs(self.outbox, exist_ok=True)

    def read_cursor(self):
        try:
            with open(self.cursor_path) as handle:
                return floor_hour(parse_iso(json.load(handle)["cursor"]))
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def write_cursor(self, epoch):
        atomic_write(self.cursor_path, json.dumps({"cursor": iso_hour(epoch)}))

    def write_outbox(self, hour_epoch, points, probe=False):
        name = hour_label(hour_epoch) + (".probe.json" if probe else ".json")
        atomic_write(os.path.join(self.outbox, name), json.dumps({"hour": iso_hour(hour_epoch), "points": points}, separators=(",", ":")))

    def list_outbox(self):
        entries = []
        for name in os.listdir(self.outbox):
            match = OUTBOX_NAME.match(name)
            if not match:
                continue
            try:
                entries.append((parse_hour_label(match.group(1)), name))
            except ValueError:
                continue
        entries.sort()
        return entries

    def read_outbox(self, name):
        try:
            with open(os.path.join(self.outbox, name)) as handle:
                data = json.load(handle)
        except (OSError, ValueError):
            return None
        if isinstance(data, dict) and isinstance(data.get("points"), list):
            return data["points"]
        return None

    def remove(self, name):
        try:
            os.remove(os.path.join(self.outbox, name))
        except OSError:
            pass


# ---- collect ----

def compute_hour(cfg, user_map, nic, hour_epoch, runner):
    label = iso_hour(hour_epoch)
    code, out, err = runner(["docker", "logs", "--since", label, "--until", iso_hour(hour_epoch + HOUR), cfg.container])
    if code != 0:
        raise CollectError("docker logs failed (%d): %s" % (code, err.strip()[:200]))
    # docker replays the container's stderr on ours, and trojan-go logs to stderr.
    points = build_proxy_points(hour_epoch, parse_log_text(out + "\n" + err, user_map), cfg.top_domains)
    row = nic.get(hour_epoch)
    if row is not None:
        rx, tx = row
        points.append(point("nic.tx_bytes", label, {}, tx, "bytes"))
        points.append(point("nic.rx_bytes", label, {}, rx, "bytes"))
    return points


def collect(cfg, state, user_map, runner, now_epoch):
    """Processes every closed hour in (cursor, last closed]. The outbox file is written before the cursor moves."""
    last_closed = floor_hour(now_epoch) - HOUR
    cursor = state.read_cursor()
    if cursor is None:
        cursor = last_closed - BACKFILL_HOURS * HOUR
    cursor = max(cursor, last_closed - MAX_AGE_DAYS * DAY)
    nic = NicTotals(cfg, runner)
    hour = cursor + HOUR
    while hour <= last_closed:
        state.write_outbox(hour, compute_hour(cfg, user_map, nic, hour, runner), False)
        state.write_cursor(hour)
        hour += HOUR


# ---- push ----

def load_outbox(state):
    entries = []
    for hour_epoch, name in state.list_outbox():
        points = state.read_outbox(name)
        if points is None:
            warn("discarding unreadable outbox file %s" % name)
            state.remove(name)
            continue
        entries.append((hour_epoch, name, points))
    return entries


def discard_expired(state, now_epoch):
    limit = floor_hour(now_epoch) - MAX_AGE_DAYS * DAY
    for hour_epoch, name in state.list_outbox():
        if hour_epoch < limit:
            warn("discarding %s: older than %d days" % (name, MAX_AGE_DAYS))
            state.remove(name)


def plan_batches(entries):
    """Groups outbox entries by hour (an hour's hourly and probe files travel together), then fills batches in order."""
    groups = []
    for hour_epoch, name, points in entries:
        if groups and groups[-1]["hour"] == hour_epoch:
            groups[-1]["names"].append(name)
            groups[-1]["points"].extend(points)
        else:
            groups.append({"hour": hour_epoch, "names": [name], "points": list(points)})
    batches = []
    current = None
    for group in groups:
        size = sum(len(json.dumps(p, separators=(",", ":"))) + 1 for p in group["points"])
        count = len(group["points"])
        if current is not None and (len(current["hours"]) >= MAX_BATCH_HOURS or len(current["points"]) + count > MAX_BATCH_POINTS
                                    or current["bytes"] + size > MAX_BATCH_BYTES):
            batches.append(current)
            current = None
        if current is None:
            current = {"hours": [], "names": [], "points": [], "bytes": 0}
        current["hours"].append(group["hour"])
        current["names"].extend(group["names"])
        current["points"].extend(group["points"])
        current["bytes"] += size
    if current is not None:
        batches.append(current)
    return batches


def post_points(cfg, points, timeout=30):
    """Returns the HTTP status, or 0 when the gateway could not be reached."""
    body = json.dumps({"version": 1, "points": points}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(cfg.gateway + "/api/telemetry/push", data=body, method="POST", headers={
        "Authorization": "Bearer " + cfg.key, "Content-Type": "application/json", "User-Agent": "trojan-telemetry/" + AGENT_VERSION})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status
    except urllib.error.HTTPError as exc:
        return exc.code
    except (urllib.error.URLError, OSError, ValueError):
        return 0


def push_outbox(cfg, state, poster=None):
    """Pushes oldest first; deletes each batch's files after a 200 and stops at the first failure."""
    poster = poster or post_points
    for batch in plan_batches(load_outbox(state)):
        status = poster(cfg, batch["points"])
        if status != 200:
            warn("push failed (%s); the remaining outbox files are kept" % ("HTTP %d" % status if status else "gateway unreachable"))
            return False
        for name in batch["names"]:
            state.remove(name)
        print("pushed %d hour(s), %d point(s)" % (len(batch["hours"]), len(batch["points"])))
    return True


# ---- lock ----

def acquire_lock(directory):
    """A non-blocking exclusive lock; None when another run holds it."""
    descriptor = os.open(os.path.join(directory, "lock"), os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (IOError, OSError):
        os.close(descriptor)
        return None
    return descriptor


# ---- command line ----

def run_once(cfg, state, runner, now_epoch):
    ok = True
    user_map, _passwords = build_user_map(cfg, runner)
    try:
        collect(cfg, state, user_map, runner, now_epoch)
    except CollectError as exc:
        warn(str(exc))
        ok = False
    discard_expired(state, now_epoch)
    if not push_outbox(cfg, state):
        ok = False
    return 0 if ok else 1


def main(argv=None, environ=None, runner=run_command, clock=time.time):
    env = os.environ if environ is None else environ
    parser = argparse.ArgumentParser(prog="trojan-telemetry", description="Hourly telemetry agent for a trojan-go proxy.")
    parser.add_argument("command", nargs="?", default="run", choices=["run"])
    parser.add_argument("--env-file", default=DEFAULT_ENV_FILE)
    parser.add_argument("--state-dir", default=None)
    parser.add_argument("--now", default=None, help=argparse.SUPPRESS)
    parser.add_argument("--version", action="version", version="trojan-telemetry " + AGENT_VERSION)
    args = parser.parse_args(argv)
    load_env_file(args.env_file, env)
    try:
        cfg = Config(env)
        now_epoch = parse_iso(args.now) if args.now else int(clock())
    except (ConfigError, ValueError) as exc:
        warn("configuration error: %s" % exc)
        return 2
    state = State(args.state_dir or env.get("TELEMETRY_STATE_DIR") or DEFAULT_STATE_DIR)
    state.ensure()
    lock = acquire_lock(state.directory)
    if lock is None:
        return 0
    try:
        return run_once(cfg, state, runner, now_epoch)
    finally:
        os.close(lock)


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests**

Run: `cd tools/trojan-telemetry && python3 -m unittest discover -s tests -v`
Expected: every test in `test_logs.py` and `test_runner.py` passes.

- [ ] **Step 5: Commit**

```bash
git add tools/trojan-telemetry/trojan-telemetry.py tools/trojan-telemetry/tests/test_runner.py
git commit -m "$(cat <<'EOF'
feat(telemetry): add vnstat reading, cursor, outbox, batched push and the agent CLI

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 9: Agent: end-to-end availability probe

**Files:**
- Modify: `tools/trojan-telemetry/trojan-telemetry.py` (insert a section, edit `run_once`)
- Create: `tools/trojan-telemetry/tests/test_probe.py`

- [ ] **Step 1: Write the failing tests**

`tools/trojan-telemetry/tests/test_probe.py`:

```python
import json
import os
import shutil
import socket
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import unittest

from support import load_agent
from test_runner import NOW, RunnerCase

agent = load_agent()
OPENSSL = shutil.which("openssl")


class FakeTrojan(object):
    """A TLS server that speaks just enough trojan: it checks the password hash, then answers like a proxy would."""

    def __init__(self, cert, key, mode="ok", password="secret"):
        self.mode = mode
        self.password_hash = agent.sha224_hex(password).encode("ascii")
        self.requests = []
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.load_cert_chain(cert, key)
        self.listener = socket.socket()
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(5)
        self.port = self.listener.getsockname()[1]
        threading.Thread(target=self.serve, daemon=True).start()

    def serve(self):
        while True:
            try:
                connection, _ = self.listener.accept()
            except OSError:
                return
            threading.Thread(target=self.handle, args=(connection,), daemon=True).start()

    def handle(self, connection):
        try:
            if self.mode == "plain":
                connection.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
                return
            tls = self.context.wrap_socket(connection, server_side=True)
            data = b""
            while b"\r\n\r\n" not in data:
                chunk = tls.recv(4096)
                if not chunk:
                    break
                data += chunk
            self.requests.append(data)
            if self.mode == "hang":
                time.sleep(3)
            elif self.mode == "http_error":
                tls.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
            elif data.startswith(self.password_hash + b"\r\n"):
                tls.sendall(b"HTTP/1.1 204 No Content\r\n\r\n")
            tls.close()
        except (OSError, ssl.SSLError):
            pass
        finally:
            try:
                connection.close()
            except OSError:
                pass

    def close(self):
        self.listener.close()


def make_certificate(directory):
    conf = os.path.join(directory, "openssl.cnf")
    with open(conf, "w") as handle:
        handle.write("[req]\ndistinguished_name = dn\nx509_extensions = v3\nprompt = no\n[dn]\nCN = localhost\n"
                     "[v3]\nsubjectAltName = DNS:localhost\nbasicConstraints = CA:TRUE\nsubjectKeyIdentifier = hash\n")
    cert, key = os.path.join(directory, "cert.pem"), os.path.join(directory, "key.pem")
    subprocess.check_call([OPENSSL, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-config", conf],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return cert, key


@unittest.skipUnless(OPENSSL, "openssl is needed to create a test certificate")
class ProbeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.mkdtemp()
        cls.cert, cls.key = make_certificate(cls.dir)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.dir, True)

    def server(self, mode="ok"):
        server = FakeTrojan(self.cert, self.key, mode)
        self.addCleanup(server.close)
        return server

    def probe(self, server, password="secret", sni="localhost", timeout=5.0, ca_file="default"):
        return agent.probe("127.0.0.1", server.port, sni, password, "www.gstatic.com:80", timeout, self.cert if ca_file == "default" else ca_file)

    def test_a_working_proxy_answers_204_and_the_request_is_a_trojan_connect_followed_by_a_get(self):
        server = self.server()
        result = self.probe(server)
        self.assertEqual(result[0], "ok")
        self.assertIsInstance(result[1], int)
        self.assertGreaterEqual(result[1], 0)
        prefix = (agent.sha224_hex("secret").encode("ascii") + b"\r\n" + bytes(bytearray([1, 3, len(b"www.gstatic.com")]))
                  + b"www.gstatic.com" + struct.pack(">H", 80) + b"\r\n")
        self.assertTrue(server.requests[0].startswith(prefix))
        self.assertIn(b"GET /generate_204 HTTP/1.1\r\nHost: www.gstatic.com\r\n", server.requests[0][len(prefix):])

    def test_a_wrong_password_is_closed_without_an_answer_and_fails_at_the_tunnel_stage(self):
        self.assertEqual(self.probe(self.server(), password="wrong"), ("fail", "tunnel"))

    def test_a_non_204_answer_fails_at_the_http_stage(self):
        self.assertEqual(self.probe(self.server("http_error")), ("fail", "http"))

    def test_a_server_that_never_answers_times_out(self):
        started = time.time()
        self.assertEqual(self.probe(self.server("hang"), timeout=0.6), ("fail", "timeout"))
        self.assertLess(time.time() - started, 2.5)

    def test_a_server_that_does_not_speak_tls_fails_at_the_tls_stage(self):
        self.assertEqual(self.probe(self.server("plain")), ("fail", "tls"))

    def test_the_certificate_is_verified_against_the_sni_name_and_the_trust_store(self):
        server = self.server()
        self.assertEqual(self.probe(server, sni="wrong.example"), ("fail", "tls"))
        self.assertEqual(self.probe(server, ca_file=None), ("fail", "tls"))

    def test_a_closed_port_fails_at_the_tcp_stage(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.close()
        self.assertEqual(agent.probe("127.0.0.1", port, "localhost", "secret", "www.gstatic.com:80", 2.0, self.cert), ("fail", "tcp"))


class ProbePointsTest(RunnerCase):
    def cfg(self):
        return agent.Config(self.env)

    def test_success_and_failure_points(self):
        hour = agent.parse_iso("2026-11-16T14:00:00Z")
        self.assertEqual(agent.probe_points(hour, ("ok", 42)), [
            {"metric": "probe.ok", "hour": "2026-11-16T14:00:00Z", "value": 1, "unit": "count"},
            {"metric": "probe.latency_ms", "hour": "2026-11-16T14:00:00Z", "value": 42, "unit": "ms"},
        ])
        self.assertEqual(agent.probe_points(hour, ("fail", "tls")), [
            {"metric": "probe.ok", "hour": "2026-11-16T14:00:00Z", "value": 0, "unit": "count"},
            {"metric": "probe.fail", "hour": "2026-11-16T14:00:00Z", "value": 1, "unit": "count", "dims": {"stage": "tls"}},
        ])

    def test_a_probe_has_its_own_outbox_file_and_a_second_probe_in_the_hour_replaces_the_first(self):
        state = agent.State(self.state_dir)
        state.ensure()
        results = [("ok", 42), ("fail", "tls")]
        seen = []

        def prober(*args):
            seen.append(args)
            return results.pop(0)

        now = agent.parse_iso(NOW)
        agent.run_probe(self.cfg(), state, ["pw1", "pw2"], now, prober)
        self.assertEqual(self.outbox(), ["2026-11-16T14.probe.json"])
        self.assertEqual(seen[0], ("trojan.xianliao.de5.net", 443, "trojan.xianliao.de5.net", "pw1", "www.gstatic.com:80", 15.0, None))
        self.assertEqual([p["metric"] for p in state.read_outbox("2026-11-16T14.probe.json")], ["probe.ok", "probe.latency_ms"])
        agent.run_probe(self.cfg(), state, ["pw1"], now + 1200, prober)
        self.assertEqual(self.outbox(), ["2026-11-16T14.probe.json"])
        self.assertEqual([p["metric"] for p in state.read_outbox("2026-11-16T14.probe.json")], ["probe.ok", "probe.fail"])

    def test_without_a_trojan_password_no_probe_runs(self):
        state = agent.State(self.state_dir)
        state.ensure()
        agent.run_probe(self.cfg(), state, [], agent.parse_iso(NOW), lambda *args: self.fail("must not probe"))
        self.assertEqual(self.outbox(), [])


@unittest.skipUnless(OPENSSL, "openssl is needed to create a test certificate")
class ProbeRunTest(RunnerCase):
    def setUp(self):
        RunnerCase.setUp(self)
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        self.cert, self.key = make_certificate(directory)
        self.config = os.path.join(directory, "config.json")
        with open(self.config, "w") as handle:
            json.dump({"password": ["secret", "other"]}, handle)
        self.set_cursor("2026-11-16T13:00:00Z")

    def configure(self, port):
        self.env.update({"TROJAN_CONFIG": self.config, "PROBE_HOST": "127.0.0.1", "TROJAN_SNI": "localhost", "PROBE_PORT": str(port),
                         "PROBE_CA_FILE": self.cert, "PROBE_TIMEOUT": "5"})

    def test_the_run_probes_and_pushes_the_result_for_the_current_hour(self):
        server = FakeTrojan(self.cert, self.key)
        self.addCleanup(server.close)
        self.configure(server.port)
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        points = self.server.requests[0]["body"]["points"]
        self.assertEqual(sorted(p["metric"] for p in points), ["probe.latency_ms", "probe.ok"])
        self.assertEqual(set(p["hour"] for p in points), {"2026-11-16T14:00:00Z"})
        self.assertEqual([p["value"] for p in points if p["metric"] == "probe.ok"], [1])
        self.assertEqual(self.outbox(), [])

    def test_a_failed_probe_is_data_not_a_failed_run(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        listener.close()
        self.configure(port)
        code, _ = self.run_main()
        self.assertEqual(code, 0)
        points = self.server.requests[0]["body"]["points"]
        self.assertEqual([(p["metric"], p["value"], p.get("dims")) for p in points if p["metric"].startswith("probe.")],
                         [("probe.ok", 0, None), ("probe.fail", 1, {"stage": "tcp"})])


if __name__ == "__main__":
    unittest.main()
```


- [ ] **Step 2: Run to see it fail**

Run: `cd tools/trojan-telemetry && python3 -m unittest discover -s tests -p 'test_probe.py' -v 2>&1 | tail -8`
Expected: failures (`AttributeError: module has no attribute 'probe'` and `probe_points`).

- [ ] **Step 3: Add the probe section**

Insert the following section in `tools/trojan-telemetry/trojan-telemetry.py` immediately above the line `# ---- command line ----`:

```python
# ---- probe ----

def probe(host, port, sni, password, target, timeout, ca_file=None, clock=time.monotonic):
    """One end-to-end check: TCP, TLS (SNI, certificate verified), a trojan CONNECT to `target`, then GET /generate_204.

    Returns ("ok", latency_ms) or ("fail", stage) with stage one of tcp, tls, tunnel, http, timeout.
    """
    started = clock()
    deadline = started + timeout

    def remaining():
        return max(0.05, deadline - clock())

    target_host, target_port = split_target(target)
    host_bytes = target_host.encode("idna")
    request = (sha224_hex(password).encode("ascii") + b"\r\n" + bytes(bytearray([1, 3, len(host_bytes)])) + host_bytes
               + struct.pack(">H", int(target_port)) + b"\r\n")
    request += ("GET /generate_204 HTTP/1.1\r\nHost: %s\r\nConnection: close\r\nUser-Agent: trojan-telemetry\r\n\r\n" % target_host).encode("ascii")
    sock = None
    tls = None
    try:
        try:
            sock = socket.create_connection((host, port), timeout=remaining())
        except socket.timeout:
            return ("fail", "timeout")
        except OSError:
            return ("fail", "tcp")
        try:
            context = ssl.create_default_context(cafile=ca_file)
            sock.settimeout(remaining())
            tls = context.wrap_socket(sock, server_hostname=sni)
        except socket.timeout:
            return ("fail", "timeout")
        except (ssl.SSLError, OSError) as exc:
            return ("fail", "timeout" if "timed out" in str(exc) else "tls")
        try:
            tls.settimeout(remaining())
            tls.sendall(request)
            buffer = b""
            while b"\r\n" not in buffer and len(buffer) < 8192:
                tls.settimeout(remaining())
                chunk = tls.recv(4096)
                if not chunk:
                    break
                buffer += chunk
        except socket.timeout:
            return ("fail", "timeout")
        except (ssl.SSLError, OSError):
            return ("fail", "tunnel")
        if not buffer:
            return ("fail", "tunnel")
        if re.match(br"HTTP/1\.[01] 204\b", buffer.split(b"\r\n", 1)[0]):
            return ("ok", int((clock() - started) * 1000))
        return ("fail", "http")
    finally:
        for handle in (tls, sock):
            if handle is not None:
                try:
                    handle.close()
                except OSError:
                    pass


def probe_points(hour_epoch, result):
    label = iso_hour(hour_epoch)
    if result[0] == "ok":
        return [point("probe.ok", label, {}, 1, "count"), point("probe.latency_ms", label, {}, result[1], "ms")]
    return [point("probe.ok", label, {}, 0, "count"), point("probe.fail", label, {"stage": result[1]}, 1, "count")]


def run_probe(cfg, state, passwords, now_epoch, prober=probe):
    """Probes once, attributed to the hour containing the run, as its own outbox file (a second probe replaces the first)."""
    if not passwords:
        warn("no trojan password is readable; skipping the availability probe")
        return
    result = prober(cfg.probe_host, cfg.probe_port, cfg.sni, passwords[0], cfg.probe_target, cfg.probe_timeout, cfg.ca_file)
    hour = floor_hour(now_epoch)
    state.write_outbox(hour, probe_points(hour, result), True)
    print("probe: %s" % (" ".join(str(part) for part in result),))
```

In `run_once`, replace

```python
    user_map, _passwords = build_user_map(cfg, runner)
    try:
        collect(cfg, state, user_map, runner, now_epoch)
    except CollectError as exc:
        warn(str(exc))
        ok = False
    discard_expired(state, now_epoch)
```

with

```python
    user_map, passwords = build_user_map(cfg, runner)
    try:
        collect(cfg, state, user_map, runner, now_epoch)
    except CollectError as exc:
        warn(str(exc))
        ok = False
    run_probe(cfg, state, passwords, now_epoch)
    discard_expired(state, now_epoch)
```

- [ ] **Step 4: Run the whole Python suite**

Run: `cd tools/trojan-telemetry && python3 -m unittest discover -s tests -v`
Expected: all tests pass (the TLS tests are skipped only when `openssl` is missing). The Task 8 tests are unaffected: they have no trojan password, so `run_probe` only prints the skip warning.

- [ ] **Step 5: Commit**

```bash
git add tools/trojan-telemetry/trojan-telemetry.py tools/trojan-telemetry/tests/test_probe.py
git commit -m "$(cat <<'EOF'
feat(telemetry): probe the trojan service end to end once per run

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 10: Installer, systemd units, uninstall, key-exposure reminder and release builder

**Files:**
- Create: `tools/trojan-telemetry/install.sh`, `tools/trojan-telemetry/build-release.sh`
- Create: `tools/trojan-telemetry/tests/test_release.py`

- [ ] **Step 1: Write the failing tests**

`tools/trojan-telemetry/tests/test_release.py`:

```python
import hashlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest

from support import AGENT_DIR, load_agent

agent = load_agent()
BASH = shutil.which("bash")
BUILD = os.path.join(AGENT_DIR, "build-release.sh")
INSTALL = os.path.join(AGENT_DIR, "install.sh")
VERSION = open(os.path.join(AGENT_DIR, "VERSION")).read().strip()


def sh(args, env=None):
    done = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, universal_newlines=True)
    return done.returncode, done.stdout


def sha256(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


@unittest.skipUnless(BASH, "bash is required")
class ReleaseCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = os.path.join(self.tmp, "release")

    def build(self, version=VERSION):
        return sh([BASH, BUILD, version, self.out])


class BuildTest(ReleaseCase):
    def test_the_release_has_the_agent_a_stamped_installer_and_checksums_of_both(self):
        code, output = self.build()
        self.assertEqual(code, 0, output)
        self.assertEqual(sorted(os.listdir(self.out)), ["SHA256SUMS", "install.sh", "trojan-telemetry.py"])
        with open(os.path.join(AGENT_DIR, "trojan-telemetry.py"), "rb") as source, open(os.path.join(self.out, "trojan-telemetry.py"), "rb") as copy:
            self.assertEqual(source.read(), copy.read())
        installer = open(os.path.join(self.out, "install.sh")).read()
        self.assertIn('VERSION="%s"' % VERSION, installer)
        self.assertNotIn("__TELEMETRY_VERSION__", installer)
        self.assertTrue(os.access(os.path.join(self.out, "install.sh"), os.X_OK))
        sums = dict((line.split()[1].lstrip("*"), line.split()[0]) for line in open(os.path.join(self.out, "SHA256SUMS")).read().splitlines())
        self.assertEqual(sums, {"trojan-telemetry.py": sha256(os.path.join(self.out, "trojan-telemetry.py")), "install.sh": sha256(os.path.join(self.out, "install.sh"))})

    def test_the_source_installer_holds_the_placeholder_exactly_once(self):
        self.assertEqual(open(INSTALL).read().count("__TELEMETRY_VERSION__"), 1)

    def test_a_version_that_is_malformed_or_differs_from_the_version_file_is_refused(self):
        self.assertNotEqual(self.build("1.0")[0], 0)
        code, output = self.build("9.9.9")
        self.assertNotEqual(code, 0)
        self.assertIn("VERSION", output)
        self.assertEqual(sh([BASH, BUILD])[0], 2)


class InstallTest(ReleaseCase):
    def setUp(self):
        ReleaseCase.setUp(self)
        self.assertEqual(self.build()[0], 0)
        self.root = os.path.join(self.tmp, "root")
        self.bin = os.path.join(self.tmp, "bin")
        os.makedirs(self.bin)

    def env(self, **extra):
        env = dict((k, v) for k, v in os.environ.items() if not k.startswith(("TELEMETRY_", "TROJAN_", "PROBE_", "TOP_DOMAINS", "FAKE_")))
        env.update({"PATH": self.bin + os.pathsep + os.environ["PATH"], "TELEMETRY_PREFIX": self.root, "TELEMETRY_BASE_URL": "file://" + self.out})
        env.update(extra)
        return env

    def install(self, **extra):
        base = {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "tlm_a'b"}
        base.update(extra)
        return sh([BASH, os.path.join(self.out, "install.sh")], self.env(**base))

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def fake_docker(self, text, code=0):
        script = os.path.join(self.bin, "docker")
        with open(script, "w") as handle:
            handle.write('#!/bin/sh\nprintf "%%s\\n" \'%s\'\nexit %d\n' % (text, code))
        os.chmod(script, 0o755)

    def test_installs_the_agent_env_file_units_and_state_directory(self):
        code, output = self.install()
        self.assertEqual(code, 0, output)
        script = self.path("opt", "trojan-telemetry", "trojan-telemetry.py")
        self.assertEqual(sha256(script), sha256(os.path.join(self.out, "trojan-telemetry.py")))
        self.assertTrue(os.access(script, os.X_OK))
        env_file = self.path("etc", "trojan-telemetry.env")
        self.assertEqual(stat.S_IMODE(os.stat(env_file).st_mode), 0o600)
        loaded = {}
        agent.load_env_file(env_file, loaded)
        self.assertEqual(loaded, {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "tlm_a'b"})
        service = open(self.path("etc", "systemd", "system", "trojan-telemetry.service")).read()
        self.assertIn("Type=oneshot", service)
        self.assertRegex(service, r"ExecStart=\S*python3\S* " + re.escape(script) + " run")
        timer = open(self.path("etc", "systemd", "system", "trojan-telemetry.timer")).read()
        self.assertIn("OnCalendar=*-*-* *:05:00", timer)
        self.assertIn("Persistent=true", timer)
        self.assertIn("WantedBy=timers.target", timer)
        self.assertTrue(os.path.isdir(self.path("var", "lib", "trojan-telemetry")))
        self.assertIn("shell history", output)
        self.assertIn("Initial run skipped", output)

    def test_a_checksum_mismatch_aborts_before_anything_is_installed(self):
        with open(os.path.join(self.out, "trojan-telemetry.py"), "a") as handle:
            handle.write("# tampered\n")
        code, output = self.install()
        self.assertNotEqual(code, 0)
        self.assertIn("checksum mismatch", output)
        self.assertFalse(os.path.exists(self.path("opt")))
        self.assertFalse(os.path.exists(self.path("etc")))

    def test_the_gateway_and_key_are_required(self):
        for missing in ("TELEMETRY_GATEWAY", "TELEMETRY_KEY"):
            env = self.env(TELEMETRY_GATEWAY="https://gw.example", TELEMETRY_KEY="tlm_x")
            del env[missing]
            code, output = sh([BASH, os.path.join(self.out, "install.sh")], env)
            self.assertNotEqual(code, 0)
            self.assertIn(missing, output)

    def test_an_unstamped_installer_refuses_to_guess_a_release(self):
        env = self.env(TELEMETRY_GATEWAY="https://gw.example", TELEMETRY_KEY="tlm_x")
        del env["TELEMETRY_BASE_URL"]
        code, output = sh([BASH, INSTALL], env)
        self.assertNotEqual(code, 0)
        self.assertIn("not a release build", output)

    def test_a_container_without_log_rotation_is_warned_about(self):
        self.fake_docker("json-file {}")
        self.assertIn("no log rotation", self.install()[1])
        self.fake_docker('json-file {"max-size":"200m","max-file":"5"}')
        self.assertNotIn("log rotation", self.install()[1])
        self.fake_docker("", 1)
        self.assertIn("was not found", self.install()[1])

    def test_reinstalling_replaces_the_key_and_keeps_optional_settings_unless_overridden(self):
        self.assertEqual(self.install(TROJAN_CONTAINER="mytrojan", TOP_DOMAINS="20", TELEMETRY_KEY="tlm_first")[0], 0)
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_second")[0], 0)
        loaded = {}
        agent.load_env_file(self.path("etc", "trojan-telemetry.env"), loaded)
        self.assertEqual(loaded, {"TELEMETRY_GATEWAY": "https://gw.example", "TELEMETRY_KEY": "tlm_second", "TROJAN_CONTAINER": "mytrojan", "TOP_DOMAINS": "20"})
        self.assertEqual(self.install(TELEMETRY_KEY="tlm_third", TOP_DOMAINS="5")[0], 0)
        loaded = {}
        agent.load_env_file(self.path("etc", "trojan-telemetry.env"), loaded)
        self.assertEqual((loaded["TOP_DOMAINS"], loaded["TROJAN_CONTAINER"], loaded["TELEMETRY_KEY"]), ("5", "mytrojan", "tlm_third"))

    def test_uninstall_removes_the_program_and_configuration_and_keeps_state_unless_purged(self):
        self.assertEqual(self.install()[0], 0)
        installer = os.path.join(self.out, "install.sh")
        code, output = sh([BASH, installer, "--uninstall"], self.env())
        self.assertEqual(code, 0, output)
        self.assertFalse(os.path.exists(self.path("opt", "trojan-telemetry")))
        self.assertFalse(os.path.exists(self.path("etc", "trojan-telemetry.env")))
        self.assertFalse(os.path.exists(self.path("etc", "systemd", "system", "trojan-telemetry.service")))
        self.assertFalse(os.path.exists(self.path("etc", "systemd", "system", "trojan-telemetry.timer")))
        self.assertTrue(os.path.isdir(self.path("var", "lib", "trojan-telemetry")))
        self.assertEqual(sh([BASH, installer, "--uninstall", "--purge"], self.env())[0], 0)
        self.assertFalse(os.path.exists(self.path("var", "lib", "trojan-telemetry")))

    def test_an_unknown_argument_is_refused(self):
        self.assertNotEqual(sh([BASH, os.path.join(self.out, "install.sh"), "--nope"], self.env())[0], 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run to see it fail**

Run: `cd tools/trojan-telemetry && python3 -m unittest discover -s tests -p 'test_release.py' 2>&1 | tail -5`
Expected: failures (the scripts do not exist).

- [ ] **Step 3: Write the release builder**

`tools/trojan-telemetry/build-release.sh`:

```bash
#!/usr/bin/env bash
# Builds the release assets: build-release.sh <version> <outdir>
# The version must equal VERSION and AGENT_VERSION in trojan-telemetry.py. The installer's version placeholder is stamped.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
version="${1:-}"
outdir="${2:-}"

if [ -z "$version" ] || [ -z "$outdir" ]; then
  echo "usage: build-release.sh <version> <outdir>" >&2
  exit 2
fi
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "version must look like 1.2.3" >&2
  exit 2
fi
if [ "$(tr -d '[:space:]' < "$here/VERSION")" != "$version" ]; then
  echo "VERSION does not match $version" >&2
  exit 1
fi
if ! grep -q "^AGENT_VERSION = \"$version\"\$" "$here/trojan-telemetry.py"; then
  echo "AGENT_VERSION in trojan-telemetry.py does not match $version" >&2
  exit 1
fi

mkdir -p "$outdir"
cp "$here/trojan-telemetry.py" "$outdir/trojan-telemetry.py"
sed "s/__TELEMETRY_VERSION__/$version/" "$here/install.sh" > "$outdir/install.sh"
chmod 755 "$outdir/install.sh"
if ! grep -q "^VERSION=\"$version\"\$" "$outdir/install.sh"; then
  echo "failed to stamp the version into install.sh" >&2
  exit 1
fi
(
  cd "$outdir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum trojan-telemetry.py install.sh > SHA256SUMS
  else
    shasum -a 256 trojan-telemetry.py install.sh > SHA256SUMS
  fi
)
echo "built telemetry agent $version in $outdir"
```

Make it executable: `chmod 755 tools/trojan-telemetry/build-release.sh tools/trojan-telemetry/install.sh` (git records the mode).

- [ ] **Step 4: Write the installer**

`tools/trojan-telemetry/install.sh`:

```bash
#!/usr/bin/env bash
# Installs, updates or removes the trojan telemetry agent (see docs/telemetry-v1.md).
#
#   curl -fsSL <release>/install.sh | sudo TELEMETRY_GATEWAY='https://gateway.example' TELEMETRY_KEY='tlm_...' bash
#   curl -fsSL <release>/install.sh | sudo bash -s -- --uninstall [--purge]
#
# Test hooks: TELEMETRY_PREFIX is a root directory for every path (and skips root, apt, systemctl and the first run);
# TELEMETRY_BASE_URL replaces the download base (file:// is fine).
set -euo pipefail

VERSION="__TELEMETRY_VERSION__"
BASE_URL="${TELEMETRY_BASE_URL:-}"
PREFIX="${TELEMETRY_PREFIX:-}"
APP_DIR="$PREFIX/opt/trojan-telemetry"
ENV_FILE="$PREFIX/etc/trojan-telemetry.env"
STATE_DIR="$PREFIX/var/lib/trojan-telemetry"
UNIT_DIR="$PREFIX/etc/systemd/system"
OPTIONAL_KEYS="TROJAN_CONTAINER TELEMETRY_IFACE TROJAN_USERS TOP_DOMAINS TROJAN_CONFIG TROJAN_SNI PROBE_HOST PROBE_PORT PROBE_TARGET PROBE_TIMEOUT"

say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# POSIX single quoting, readable back by the agent's env-file parser.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'; else shasum -a 256 "$1" | awk '{ print $1 }'; fi
}

existing_line() { { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -n 1; } || true; }

write_env() {
  local tmp="$ENV_FILE.tmp" key line
  mkdir -p "$(dirname "$ENV_FILE")"
  (
    umask 077
    {
      printf 'TELEMETRY_GATEWAY=%s\n' "$(quote "$TELEMETRY_GATEWAY")"
      printf 'TELEMETRY_KEY=%s\n' "$(quote "$TELEMETRY_KEY")"
      for key in $OPTIONAL_KEYS; do
        if [ -n "${!key+x}" ]; then
          printf '%s=%s\n' "$key" "$(quote "${!key}")"
        else
          line="$(existing_line "$key")"
          if [ -n "$line" ]; then printf '%s\n' "$line"; fi
        fi
      done
    } > "$tmp"
  )
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

write_units() {
  cat > "$UNIT_DIR/trojan-telemetry.service" <<UNIT
[Unit]
Description=Trojan hourly telemetry push
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$PYTHON $APP_DIR/trojan-telemetry.py run
UNIT
  cat > "$UNIT_DIR/trojan-telemetry.timer" <<'UNIT'
[Unit]
Description=Run the trojan telemetry agent hourly

[Timer]
OnCalendar=*-*-* *:05:00
Persistent=true

[Install]
WantedBy=timers.target
UNIT
}

ensure_vnstat() {
  [ -z "$PREFIX" ] || return 0
  if ! command -v vnstat >/dev/null 2>&1; then
    command -v apt-get >/dev/null 2>&1 || die "vnstat is not installed and apt-get is not available; install vnstat first"
    DEBIAN_FRONTEND=noninteractive apt-get install -y vnstat </dev/null
  fi
  systemctl enable --now vnstat >/dev/null 2>&1 || warn "could not start the vnstat service"
}

check_log_rotation() {
  command -v docker >/dev/null 2>&1 || return 0
  local container="${TROJAN_CONTAINER:-trojan}" info
  if ! info="$(docker inspect -f '{{.HostConfig.LogConfig.Type}} {{json .HostConfig.LogConfig.Config}}' "$container" 2>/dev/null)"; then
    warn "docker container '$container' was not found; set TROJAN_CONTAINER if it has another name"
    return 0
  fi
  case "$info" in
    "json-file "*max-size*) ;;
    *) warn "container '$container' has no log rotation (json-file with max-size). Hours whose logs have rotated away cannot be recomputed after an outage. Suggested: max-size 200m, max-file 5 (change the trojan deployment yourself; this installer does not)." ;;
  esac
}

install_agent() {
  case "$VERSION" in
    __*) [ -n "$BASE_URL" ] || die "this install.sh is not a release build (no version stamped); set TELEMETRY_BASE_URL to a built release" ;;
  esac
  BASE_URL="${BASE_URL:-https://github.com/xuangong/copilot-api-gateway/releases/download/telemetry-agent-v$VERSION}"
  [ -n "${TELEMETRY_GATEWAY:-}" ] || die "TELEMETRY_GATEWAY is required"
  [ -n "${TELEMETRY_KEY:-}" ] || die "TELEMETRY_KEY is required"
  if [ -z "$PREFIX" ] && [ "$(id -u)" -ne 0 ]; then die "run as root (for example with sudo)"; fi
  PYTHON="$(command -v python3)" || die "python3 is required"

  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  for name in trojan-telemetry.py SHA256SUMS; do
    curl -fsSL "$BASE_URL/$name" -o "$work/$name" || die "could not download $name from $BASE_URL"
  done
  local expected
  expected="$(awk '{ name = $2; sub(/^\*/, "", name); if (name == "trojan-telemetry.py") print $1 }' "$work/SHA256SUMS")"
  [ -n "$expected" ] || die "SHA256SUMS has no entry for trojan-telemetry.py"
  [ "$expected" = "$(sha256_of "$work/trojan-telemetry.py")" ] || die "checksum mismatch for trojan-telemetry.py; nothing was installed"

  ensure_vnstat
  mkdir -p "$APP_DIR" "$STATE_DIR" "$UNIT_DIR"
  chmod 700 "$STATE_DIR"
  install -m 755 "$work/trojan-telemetry.py" "$APP_DIR/trojan-telemetry.py"
  write_env
  write_units
  if [ -z "$PREFIX" ]; then
    systemctl daemon-reload
    systemctl enable --now trojan-telemetry.timer
  fi
  check_log_rotation

  local status=0
  if [ -z "$PREFIX" ]; then
    say "Running the agent once..."
    "$PYTHON" "$APP_DIR/trojan-telemetry.py" run </dev/null || status=$?
    if [ "$status" -eq 0 ]; then
      say "Initial run finished: the first hours were pushed."
    else
      warn "the initial run failed (exit $status); see 'systemctl status trojan-telemetry.service' and 'journalctl -u trojan-telemetry'"
    fi
  else
    say "Initial run skipped (test prefix)."
  fi
  say "Installed trojan-telemetry $VERSION; the timer runs at minute 5 of every hour."
  say "Note: the key you passed is visible in your shell history and the process list. If that matters, rotate it in the dashboard (Telemetry, rotate key) and run this installer again with the new key."
  return "$status"
}

uninstall_agent() {
  local purge="$1"
  if [ -z "$PREFIX" ]; then systemctl disable --now trojan-telemetry.timer >/dev/null 2>&1 || true; fi
  rm -f "$UNIT_DIR/trojan-telemetry.service" "$UNIT_DIR/trojan-telemetry.timer"
  if [ -z "$PREFIX" ]; then systemctl daemon-reload || true; fi
  rm -rf "$APP_DIR"
  rm -f "$ENV_FILE"
  if [ "$purge" = 1 ]; then
    rm -rf "$STATE_DIR"
    say "Removed the agent, its configuration and its state."
  else
    say "Removed the agent and its configuration. State is kept in $STATE_DIR (add --purge to remove it)."
  fi
}

main() {
  local mode=install purge=0 arg
  for arg in "$@"; do
    case "$arg" in
      --uninstall) mode=uninstall ;;
      --purge) purge=1 ;;
      *) die "unknown argument: $arg" ;;
    esac
  done
  if [ "$mode" = uninstall ]; then uninstall_agent "$purge"; else install_agent; fi
}

main "$@"
```

- [ ] **Step 5: Run the Python suite**

```bash
chmod 755 tools/trojan-telemetry/build-release.sh tools/trojan-telemetry/install.sh
cd tools/trojan-telemetry && python3 -m unittest discover -s tests -v
```

Expected: all tests pass. If a bash incompatibility shows up on the local shell (macOS ships bash 3.2), fix the script, not the test: the script must run on both bash 3.2 and bash 5.

- [ ] **Step 6: Commit**

```bash
git add tools/trojan-telemetry/install.sh tools/trojan-telemetry/build-release.sh tools/trojan-telemetry/tests/test_release.py
git commit -m "$(cat <<'EOF'
feat(telemetry): add the installer, systemd units, uninstall and release builder

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Task 11: Release workflow, CI Python step and version consistency

**Files:**
- Create: `.github/workflows/telemetry-agent-release.yml`
- Modify: `.github/workflows/vnext-ci.yml`, `package.json`
- Create: `packages/gateway/tests/telemetry-agent-release-consistency.test.ts`

- [ ] **Step 1: Confirm which workflows exist**

Run: `ls ../.github/workflows` (from `vnext/`)
Expected: `vnext-ci.yml` and `vnext-remote-compat.yml` only; there is no Python step and no release workflow.

- [ ] **Step 2: Write the failing consistency test**

`packages/gateway/tests/telemetry-agent-release-consistency.test.ts`:

```ts
import { expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { TELEMETRY_AGENT_VERSION } from "../src/control-plane/telemetry/agent-release"

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
const agent = (name: string) => read(`../../../tools/trojan-telemetry/${name}`)

test("the version the install command pins equals VERSION and the agent's own constant", () => {
  expect(TELEMETRY_AGENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  expect(agent("VERSION").trim()).toBe(TELEMETRY_AGENT_VERSION)
  expect(/^AGENT_VERSION = "(.+)"$/m.exec(agent("trojan-telemetry.py"))?.[1]).toBe(TELEMETRY_AGENT_VERSION)
})

test("the installer carries exactly one version placeholder for build-release.sh to stamp", () => {
  expect(agent("install.sh").match(/__TELEMETRY_VERSION__/g)).toHaveLength(1)
})

test("the release workflow builds on telemetry-agent tags, checks every version source and uses the release builder", () => {
  const path = "../../../../.github/workflows/telemetry-agent-release.yml"
  expect(existsSync(fileURLToPath(new URL(path, import.meta.url)))).toBe(true)
  const workflow = read(path)
  expect(workflow).toContain("telemetry-agent-v*")
  expect(workflow).toContain("TELEMETRY_AGENT_VERSION")
  expect(workflow).toContain("AGENT_VERSION")
  expect(workflow).toContain("tools/trojan-telemetry/VERSION")
  expect(workflow).toContain("build-release.sh")
  expect(workflow).toContain("SHA256SUMS")
})

test("CI runs the agent tests", () => {
  expect(read("../../../../.github/workflows/vnext-ci.yml")).toContain("bun run test:agent")
  expect(JSON.parse(read("../../../package.json")).scripts["ci:local"]).toContain("bun run test:agent")
})
```

Run: `bun test ./packages/gateway/tests/telemetry-agent-release-consistency.test.ts`
Expected: the first two tests pass; the last two FAIL.

- [ ] **Step 3: Add the release workflow**

`.github/workflows/telemetry-agent-release.yml`:

```yaml
name: Telemetry agent release

# Publishes the trojan telemetry agent when a telemetry-agent-v<semver> tag is pushed. Pushing the tag is an
# owner-confirmed rollout step; nothing here runs on branches or pull requests.
on:
  push:
    tags:
      - 'telemetry-agent-v*'

permissions:
  contents: write

jobs:
  release:
    name: Build and publish the agent
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Check the tag against every version source
        id: version
        run: |
          set -euo pipefail
          version="${GITHUB_REF_NAME#telemetry-agent-v}"
          file_version="$(tr -d '[:space:]' < vnext/tools/trojan-telemetry/VERSION)"
          script_version="$(sed -n 's/^AGENT_VERSION = "\(.*\)"$/\1/p' vnext/tools/trojan-telemetry/trojan-telemetry.py)"
          gateway_version="$(sed -n 's/^export const TELEMETRY_AGENT_VERSION = "\(.*\)"$/\1/p' vnext/packages/gateway/src/control-plane/telemetry/agent-release.ts)"
          echo "tag=$version VERSION=$file_version AGENT_VERSION=$script_version TELEMETRY_AGENT_VERSION=$gateway_version"
          for found in "$file_version" "$script_version" "$gateway_version"; do
            if [ "$found" != "$version" ]; then
              echo "::error::the tag ($version) does not match every version source"
              exit 1
            fi
          done
          echo "version=$version" >> "$GITHUB_OUTPUT"

      - name: Setup Python
        uses: actions/setup-python@v5
        with:
          python-version: '3.8'

      - name: Test the agent
        working-directory: vnext/tools/trojan-telemetry
        run: python3 -m unittest discover -s tests -v

      - name: Build the release assets
        run: bash vnext/tools/trojan-telemetry/build-release.sh "${{ steps.version.outputs.version }}" dist

      - name: Publish
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "$GITHUB_REF_NAME" dist/trojan-telemetry.py dist/install.sh dist/SHA256SUMS \
            --verify-tag \
            --title "Telemetry agent v${{ steps.version.outputs.version }}" \
            --notes "Trojan telemetry agent ${{ steps.version.outputs.version }}. Install from the dashboard's Telemetry page; verify downloads against SHA256SUMS."
```

- [ ] **Step 4: Add the Python step to CI and the scripts**

In `.github/workflows/vnext-ci.yml` make two edits. Update the header comment line

```yaml
#   framework-purity → typecheck → tests → lint → dashboard build → CFW dry-run
```

to

```yaml
#   framework-purity → typecheck → tests → agent tests → lint → dashboard build → CFW dry-run
```

and insert, directly before the `- name: Lint` step (after `- name: Tests` / `run: bun test`):

```yaml
      - name: Setup Python (telemetry agent)
        uses: actions/setup-python@v5
        with:
          python-version: '3.8'

      - name: Telemetry agent tests
        run: bun run test:agent

```

In `package.json` add the script after the `"test"` line:

```json
    "test:agent": "cd tools/trojan-telemetry && python3 -m unittest discover -s tests",
```

and in `ci:local` replace `&& bun test && bun run lint` with `&& bun test && bun run test:agent && bun run lint`.

- [ ] **Step 5: Run the tests**

```bash
bun run test:agent
bun test ./packages/gateway/tests/telemetry-agent-release-consistency.test.ts
```

Expected: both pass. Validate the workflow syntax with `python3 -c "import yaml,sys; yaml.safe_load(open('../.github/workflows/telemetry-agent-release.yml'))"` if PyYAML is installed (skip otherwise); do not trigger it.

- [ ] **Step 6: Commit**

```bash
git add ../.github/workflows/telemetry-agent-release.yml ../.github/workflows/vnext-ci.yml package.json packages/gateway/tests/telemetry-agent-release-consistency.test.ts
git commit -m "$(cat <<'EOF'
ci(telemetry): run the agent tests in CI and add the tag-triggered release workflow

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Task 12: End-to-end test: real agent against a real gateway

**Files:**
- Create: `packages/gateway/tests/telemetry-e2e.test.ts`

- [ ] **Step 1: Write the test**

`packages/gateway/tests/telemetry-e2e.test.ts`:

```ts
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { app } from "../src/app"
import { telemetryClock } from "../src/control-plane/telemetry/common"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const python = Bun.which("python3")
const agentPath = fileURLToPath(new URL("../../../tools/trojan-telemetry/trojan-telemetry.py", import.meta.url))
const owner = "e2e-owner" as UserId
const stamp = "2026-11-16T00:00:00.000Z"
const sourceId = `tls_${"e".repeat(32)}`
const key = `tlm_${"e".repeat(64)}`
const session = "ses_e2e_owner"
const sha224 = (value: string) => createHash("sha224").update(value).digest("hex")
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

const log = (hash: string, target: string, sent: string, recv: string, at: string) =>
  `time="${at}" level=info msg="user ${hash} from 1.2.3.4:5555 tunneling to ${target} closed sent: ${sent} recv: ${recv}"`
const LOG = [
  log(sha224("pw1"), "www.google.com:443", "1.00 MiB", "2.00 MiB", "2026-11-16T10:15:00Z"),
  log(sha224("pw1"), "mail.google.com:443", "1.00 MiB", "1.00 MiB", "2026-11-16T10:20:00Z"),
  log(sha224("pw2"), "example.org:443", "512.00 KiB", "512.00 KiB", "2026-11-16T10:40:00Z"),
  log(sha224("pw1"), "cdn.example.co.uk:443", "1.00 GiB", "4.00 GiB", "2026-11-16T11:30:00Z"),
  log("f".repeat(56), "203.0.113.9:443", "1.00 KiB", "1.00 KiB", "2026-11-16T13:10:00Z"),
].join("\n") + "\n"
const vnstat = JSON.stringify({ vnstatversion: "2.6", jsonversion: "2", interfaces: [{ name: "eth0", traffic: { hour: [10, 11, 12, 13].map((hour, index) => ({
  id: index, date: { year: 2026, month: 11, day: 16 }, time: { hour, minute: 0 }, rx: (index + 1) * 10, tx: (index + 1) * 111 })) } }] })
const FAKE_DOCKER = `#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if args[:1] == ["logs"]:
    since, until = args[args.index("--since") + 1], args[args.index("--until") + 1]
    for raw in open(os.environ["FAKE_DOCKER_LOG"]):
        stamp = raw.split('time="', 1)[1].split('"', 1)[0]
        if since <= stamp < until:
            sys.stderr.write(raw)
    sys.exit(0)
sys.exit(1)
`

let dir: string
let db: Database
let repo: BunSqliteRepo
let server: ReturnType<typeof Bun.serve>
let closedPort = 0

beforeAll(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  initRuntimeLocation("bun")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  await repo.users.create({ id: owner, name: owner, createdAt: stamp, disabled: false })
  await repo.sessions.create({ token: session as SessionToken, userId: owner, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  await repo.telemetry.createSourceWithinLimit({ id: sourceId, ownerId: owner, name: "trojan-vm", keyHash: sha256(key), settings: {}, createdAt: stamp, lastPushAt: null }, 16)
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => app.fetch(request) })
  const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  closedPort = closed.port
  closed.stop(true)
  dir = mkdtempSync(join(tmpdir(), "telemetry-e2e-"))
  mkdirSync(join(dir, "bin"))
  writeFileSync(join(dir, "bin", "docker"), FAKE_DOCKER)
  writeFileSync(join(dir, "bin", "vnstat"), '#!/bin/sh\ncat "$FAKE_VNSTAT_JSON"\n')
  chmodSync(join(dir, "bin", "docker"), 0o755)
  chmodSync(join(dir, "bin", "vnstat"), 0o755)
  writeFileSync(join(dir, "docker.log"), LOG)
  writeFileSync(join(dir, "vnstat.json"), vnstat)
  writeFileSync(join(dir, "config.json"), JSON.stringify({ password: ["pw1", "pw2"] }))
  // The last agent run before the first scheduled hour: the cursor sits at 09:00, so hours 10 to 13 are computed.
  mkdirSync(join(dir, "state"))
  writeFileSync(join(dir, "state", "cursor.json"), JSON.stringify({ cursor: "2026-11-16T09:00:00Z" }))
})
afterAll(() => { server?.stop(true); db?.close(); if (dir) rmSync(dir, { recursive: true, force: true }); telemetryClock.now = () => Date.now(); __resetPlatformForTests() })

async function runAgent(nowIso: string) {
  telemetryClock.now = () => Date.parse(nowIso)
  const child = Bun.spawn([python!, agentPath, "run", "--state-dir", join(dir, "state"), "--env-file", join(dir, "none.env"), "--now", nowIso], {
    env: {
      PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`, TZ: "UTC", HOME: dir,
      TELEMETRY_GATEWAY: `http://127.0.0.1:${server.port}`, TELEMETRY_KEY: key, TROJAN_CONFIG: join(dir, "config.json"),
      PROBE_HOST: "127.0.0.1", PROBE_PORT: String(closedPort), PROBE_TIMEOUT: "2",
      FAKE_DOCKER_LOG: join(dir, "docker.log"), FAKE_VNSTAT_JSON: join(dir, "vnstat.json"),
    },
    stdout: "pipe", stderr: "pipe",
  })
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  return { code, out, err }
}

const get = async (path: string) => {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/telemetry/sources/${sourceId}${path}`, { headers: { authorization: `Bearer ${session}` } })
  expect(response.status).toBe(200)
  return await response.json() as any
}
const window = "from=2026-11-16T10:00:00Z&to=2026-11-16T14:00:00Z"

test.skipIf(!python)("the real agent pushes computed hours and the gateway reports the expected numbers", async () => {
  await repo.telemetry.updateSource(sourceId, owner, { settings: { checkMetrics: ["probe.ok"], flagNonZeroMetrics: ["probe.fail"] } })
  const first = await runAgent("2026-11-16T14:05:00Z")
  expect(first.code, first.err).toBe(0)

  const metrics = (await get("/metrics")).metrics.map((m: { metric: string }) => m.metric)
  expect(metrics).toEqual(["nic.rx_bytes", "nic.tx_bytes", "probe.fail", "probe.ok", "proxy.connections", "proxy.recv_bytes", "proxy.sent_bytes"])

  const byDomain = await get(`/series?metric=proxy.sent_bytes&groupBy=domain&top=10&${window}`)
  const values = (key: string) => byDomain.groups.find((g: { key: string }) => g.key === key)?.values
  expect(values("google.com")).toEqual([2 * 1024 ** 2, 0, 0, 0])
  expect(values("example.org")).toEqual([512 * 1024, 0, 0, 0])
  expect(values("example.co.uk")).toEqual([0, 1024 ** 3, 0, 0])
  expect(values("203.0.113.9")).toEqual([0, 0, 0, 1024])
  expect(byDomain.groups.map((g: { key: string }) => g.key)).not.toContain("(other)")
  expect(byDomain.total).toEqual([2 * 1024 ** 2 + 512 * 1024, 1024 ** 3, 0, 1024])

  const byUser = await get(`/top?metric=proxy.sent_bytes&groupBy=user&${window}`)
  expect(byUser.rows.map((r: { key: string; value: number }) => [r.key, r.value])).toEqual([["#1", 2 * 1024 ** 2 + 1024 ** 3], ["#2", 512 * 1024], ["#?", 1024]])
  expect(byUser.total).toBe(2 * 1024 ** 2 + 1024 ** 3 + 512 * 1024 + 1024)
  expect(byUser.otherCurrent).toBe(0)

  const connections = await get(`/top?metric=proxy.connections&groupBy=domain&${window}`)
  expect(connections.rows.find((r: { key: string }) => r.key === "google.com").value).toBe(2)

  const nic = await get(`/series?metric=nic.tx_bytes&${window}`)
  expect(nic.total).toEqual([111, 222, 333, 444])

  const summary = await get("/summary")
  expect(summary.freshness).toMatchObject({ lastPushAt: "2026-11-16T14:05:00.000Z", stale: false })
  // The probe could not connect (nothing listens on its port): a failed check at the current hour, with its stage.
  expect(summary.flags).toEqual([{ metric: "probe.fail", hour: "2026-11-16T14:00:00Z", total: 1, breakdown: [{ dims: { stage: "tcp" }, value: 1 }] }])
  // The latest closed hour (13:00) precedes the first probe point, so it is not monitored rather than a warning.
  expect(summary.checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T13:00:00Z", status: "not monitored", stage: null }])
}, 60_000)

test.skipIf(!python)("a later run only adds the new hour, re-running is idempotent and the failed check shows its stage", async () => {
  const second = await runAgent("2026-11-16T15:05:00Z")
  expect(second.code, second.err).toBe(0)
  const before = await get(`/series?metric=proxy.sent_bytes&groupBy=domain&top=10&${window}`)
  const third = await runAgent("2026-11-16T15:05:00Z")
  expect(third.code, third.err).toBe(0)
  expect(await get(`/series?metric=proxy.sent_bytes&groupBy=domain&top=10&${window}`)).toEqual(before)
  const checks = await get(`/series?metric=probe.ok&from=2026-11-16T13:00:00Z&to=2026-11-16T16:00:00Z`)
  expect(checks.statuses).toEqual(["not monitored", "failed", "failed"])
  expect(checks.stages).toEqual([null, "tcp", "tcp"])
  const summary = await get("/summary")
  expect(summary.checks).toEqual([{ metric: "probe.ok", hour: "2026-11-16T14:00:00Z", status: "failed", stage: "tcp" }])
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM telemetry_points WHERE metric = 'probe.ok'").get()?.n).toBe(2)
}, 60_000)
```

- [ ] **Step 2: Run the test**

Run: `bun test ./packages/gateway/tests/telemetry-e2e.test.ts`
Expected: PASS (both tests), or both skipped with `python3` missing. If the first test fails on `metrics`, read the agent's stderr in the assertion message (`first.err`) before changing anything: the usual causes are a PATH without `python3` for the fake `docker` shebang or a timezone other than UTC in the spawned process.

- [ ] **Step 3: Run the neighbouring gateway tests**

Run: `bun test ./packages/gateway/tests/telemetry-push.test.ts ./packages/gateway/tests/telemetry-queries.test.ts ./packages/gateway/tests/telemetry-e2e.test.ts`
Expected: PASS together (the e2e test changes `telemetryClock.now`; its `afterAll` restores it).

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/tests/telemetry-e2e.test.ts
git commit -m "$(cat <<'EOF'
test(telemetry): run the real agent against a real gateway end to end

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 13: Dashboard: Telemetry page with sources, create, rotate, delete and the install command

**Files:**
- Create: `apps/dashboard/src/api/telemetry.ts`
- Create: `apps/dashboard/src/tabs/telemetry/telemetry-errors.ts`, `telemetry-errors.test.ts`, `telemetry-sources.ts`, `telemetry-sources.test.ts`
- Create: `apps/dashboard/src/tabs/telemetry/SourceList.tsx`, `SourceList.test.tsx`, `TelemetryTab.tsx`
- Modify: `apps/dashboard/src/shell/navigation.ts`, `navigation.test.ts`, `apps/dashboard/src/App.tsx`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts`

- [ ] **Step 1: Write the failing tests**

`apps/dashboard/src/tabs/telemetry/telemetry-errors.test.ts`:

```ts
import { expect, test } from "bun:test"
import { ApiError } from "../../api/client"
import { telemetryErrorKey } from "./telemetry-errors"

const failure = (status: number, code: string) => new ApiError(status, { error: { code } }, code)

test("known server codes map to their own copy and everything else to the generic message", () => {
  expect(telemetryErrorKey(failure(400, "https_required"))).toBe("dash.tlmHttpsRequired")
  expect(telemetryErrorKey(failure(409, "source_limit"))).toBe("dash.tlmLimit")
  expect(telemetryErrorKey(failure(400, "invalid_request"))).toBe("dash.tlmInvalid")
  expect(telemetryErrorKey(failure(404, "source_not_found"))).toBe("dash.tlmGone")
  expect(telemetryErrorKey(failure(503, "temporarily_unavailable"))).toBe("dash.tlmError")
  expect(telemetryErrorKey(new Error("network"))).toBe("dash.tlmError")
})
```

`apps/dashboard/src/tabs/telemetry/telemetry-sources.test.ts`:

```ts
import { expect, test } from "bun:test"
import { canCreateSource, sourceBadge } from "./telemetry-sources"

const now = Date.parse("2026-11-16T12:00:00Z")

test("a source is fresh until strictly more than its threshold has passed, and never-pushed is its own state", () => {
  expect(sourceBadge({ lastPushAt: null, settings: {} }, now)).toBe("never")
  expect(sourceBadge({ lastPushAt: "2026-11-16T10:00:00.000Z", settings: {} }, now)).toBe("fresh")
  expect(sourceBadge({ lastPushAt: "2026-11-16T09:59:59.999Z", settings: {} }, now)).toBe("stale")
  expect(sourceBadge({ lastPushAt: "2026-11-16T09:59:59.999Z", settings: { staleAfterHours: 3 } }, now)).toBe("fresh")
})

test("a name needs 1 to 64 characters after trimming and no request in flight", () => {
  expect(canCreateSource("trojan-vm", false)).toBe(true)
  expect(canCreateSource("   ", false)).toBe(false)
  expect(canCreateSource("x".repeat(65), false)).toBe(false)
  expect(canCreateSource("trojan-vm", true)).toBe(false)
})
```

`apps/dashboard/src/tabs/telemetry/SourceList.test.tsx`:

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { IssuedKeyPanel, SourceListView, type SourceListViewProps } from "./SourceList"

const noop = () => {}
const now = Date.parse("2026-11-16T12:00:00Z")
const source = (over: Record<string, unknown> = {}) => ({ id: `tls_${"1".repeat(32)}`, name: "trojan-vm", createdAt: "2026-11-01T00:00:00.000Z", lastPushAt: "2026-11-16T11:30:00.000Z", settings: {}, ...over })
const issued = { sourceName: "trojan-vm", key: `tlm_${"a".repeat(64)}`, install: "curl -fsSL https://example/install.sh | sudo TELEMETRY_KEY='k' bash" }
const view = (over: Partial<SourceListViewProps> = {}) => renderToStaticMarkup(<SourceListView sources={[]} nowMs={now} newName="" issued={null} busy={false} error=""
  copied={null} secureOrigin onName={noop} onCreate={noop} onRotate={noop} onDelete={noop} onCopy={noop} onDismissIssued={noop} {...over} />)

test("with no sources the page explains itself and offers to create one", () => {
  const html = view()
  expect(html).toContain("dash.tlmSources")
  expect(html).toContain("dash.tlmDescription")
  expect(html).toContain("dash.tlmNone")
  expect(html).toContain("dash.tlmCreate")
})

test("each source shows its name, a freshness badge, the last push and rotate and delete actions", () => {
  const html = view({ sources: [source(), source({ id: `tls_${"2".repeat(32)}`, name: "stale-vm", lastPushAt: "2026-11-16T08:00:00.000Z" }),
    source({ id: `tls_${"3".repeat(32)}`, name: "new-vm", lastPushAt: null })] })
  expect(html).toContain("trojan-vm")
  expect(html).toContain("stale-vm")
  expect(html).toContain("new-vm")
  expect(html).toContain("dash.tlmFresh")
  expect(html).toContain("dash.tlmStale")
  expect(html).toContain("dash.tlmNeverPushed")
  expect(html.match(/dash\.tlmRotate/g)).toHaveLength(3)
  expect(html.match(/dash\.delete/g)).toHaveLength(3)
  expect(html).not.toContain("dash.tlmOpen")
})

test("an Open action appears only when the page can open a source", () => {
  expect(view({ sources: [source()], onOpen: noop })).toContain("dash.tlmOpen")
})

test("the create button needs a name and no request in flight, and plain HTTP warns and blocks creation", () => {
  const disabled = (html: string) => /<button[^>]*\sdisabled=""[^>]*>[^<]*dash\.tlmCreate/.test(html)
  expect(disabled(view({ newName: "" }))).toBe(true)
  expect(disabled(view({ newName: "vm" }))).toBe(false)
  expect(disabled(view({ newName: "vm", busy: true }))).toBe(true)
  const plain = view({ newName: "vm", secureOrigin: false })
  expect(plain).toContain("dash.tlmHttpsRequired")
  expect(disabled(plain)).toBe(true)
})

test("an issued key shows the install command and the key once, with copy buttons and a dismiss", () => {
  const html = view({ issued })
  expect(html).toContain("dash.tlmKeyHint")
  expect(html).toContain("TELEMETRY_KEY=&#x27;k&#x27;")
  expect(html).toContain(issued.key)
  expect(html).toContain("dash.tlmCopyCommand")
  expect(html).toContain("dash.tlmCopyKey")
  expect(html).toContain("dash.tlmDismiss")
  expect(renderToStaticMarkup(<IssuedKeyPanel issued={issued} copied="install" onCopy={noop} onDismiss={noop} />)).toContain("dash.tlmCopied")
})

test("errors are announced as alerts", () => {
  expect(view({ error: "dash.tlmError" })).toContain('role="alert"')
})
```

In `apps/dashboard/src/shell/navigation.test.ts` update the three expectations: the admin and non-admin observe groups become `["usage", "latency", "telemetry"]`, and add `"telemetry"` to the list in `pages outside the sidebar stay reachable by their old addresses`:

```ts
    ["observe", ["usage", "latency", "telemetry"]],
```
(in both the admin and the non-admin test), and

```ts
  for (const id of ["upstreams", "proxies", "users", "keys", "models", "pricing", "usage", "latency", "telemetry", "clients", "agent-remote", "settings"]) {
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test ./apps/dashboard/src/tabs/telemetry ./apps/dashboard/src/shell/navigation.test.ts`
Expected: FAIL (modules missing; navigation expectations differ).

- [ ] **Step 3: Write the API client**

`apps/dashboard/src/api/telemetry.ts`:

```ts
import { api } from "./client"

export type TelemetryUnit = "bytes" | "count" | "ms"
export type CheckStatus = "passed" | "failed" | "no check" | "not monitored"

export interface TelemetrySettings {
  budgetMetric?: string
  monthlyLimit?: number
  pricePerGB?: number
  freeGB?: number
  surgeMetrics?: string[]
  surgeFactor?: number
  surgeMinBytes?: number
  surgeMinCount?: number
  flagNonZeroMetrics?: string[]
  checkMetrics?: string[]
  labels?: Record<string, Record<string, string>>
  staleAfterHours?: number
}

export interface TelemetrySource {
  id: string
  name: string
  createdAt: string
  lastPushAt: string | null
  settings: TelemetrySettings
}

/** Shown once, at creation or rotation. */
export interface IssuedTelemetryKey { key: string; install: string }

const base = "/api/telemetry/sources"
const path = (id: string, rest = "") => `${base}/${encodeURIComponent(id)}${rest}`

export const listTelemetrySources = () => api<{ sources: TelemetrySource[] }>(base)
export const createTelemetrySource = (name: string) => api<{ source: TelemetrySource } & IssuedTelemetryKey>(base, { method: "POST", body: { name } })
export const updateTelemetrySource = (id: string, body: { name?: string; settings?: TelemetrySettings }) =>
  api<{ source: TelemetrySource }>(path(id), { method: "PATCH", body })
export const rotateTelemetryKey = (id: string) => api<IssuedTelemetryKey>(path(id, "/rotate-key"), { method: "POST" })
export const deleteTelemetrySource = (id: string) => api<{ sources: TelemetrySource[] }>(path(id), { method: "DELETE" })
```

- [ ] **Step 4: Write the pure helpers**

`apps/dashboard/src/tabs/telemetry/telemetry-errors.ts`:

```ts
import { settingsError } from "../upstreams/loki-errors"

/** Copy key for a failed telemetry request. */
export function telemetryErrorKey(error: unknown): string {
  switch (settingsError(error)) {
    case "https_required": return "dash.tlmHttpsRequired"
    case "source_limit": return "dash.tlmLimit"
    case "invalid_request": return "dash.tlmInvalid"
    case "source_not_found": return "dash.tlmGone"
    default: return "dash.tlmError"
  }
}
```

`apps/dashboard/src/tabs/telemetry/telemetry-sources.ts`:

```ts
import type { TelemetrySource } from "../../api/telemetry"

export const MAX_TELEMETRY_SOURCES = 16
const DEFAULT_STALE_AFTER_HOURS = 2

export type SourceBadge = "never" | "fresh" | "stale"

/** Stale is strictly more than the threshold (default 2 hours); a source that never pushed has no age. */
export function sourceBadge(source: Pick<TelemetrySource, "lastPushAt" | "settings">, nowMs: number): SourceBadge {
  if (source.lastPushAt === null) return "never"
  const limit = (source.settings.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS) * 3_600_000
  return nowMs - Date.parse(source.lastPushAt) > limit ? "stale" : "fresh"
}

export const canCreateSource = (name: string, busy: boolean): boolean => !busy && name.trim().length > 0 && name.trim().length <= 64
```

- [ ] **Step 5: Write the list view and container**

`apps/dashboard/src/tabs/telemetry/SourceList.tsx`:

```tsx
import { useCallback, useEffect, useId, useState } from "react"
import { createTelemetrySource, deleteTelemetrySource, listTelemetrySources, rotateTelemetryKey, type IssuedTelemetryKey, type TelemetrySource } from "../../api/telemetry"
import { useConfirm } from "../../state/confirm"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { telemetryErrorKey } from "./telemetry-errors"
import { canCreateSource, sourceBadge } from "./telemetry-sources"

export interface IssuedKeyView extends IssuedTelemetryKey { sourceName: string }
export type CopyTarget = "install" | "key"

export function IssuedKeyPanel({ issued, copied, onCopy, onDismiss }: { issued: IssuedKeyView; copied: CopyTarget | null; onCopy: (what: CopyTarget) => void; onDismiss: () => void }) {
  const t = useT()
  return <div className="space-y-2 rounded-md border border-border bg-panel p-3">
    <p className="text-body font-medium text-fg">{issued.sourceName}</p>
    <p className="text-xs text-fg-subtle">{t("dash.tlmKeyHint")}</p>
    <label className="block text-xs font-medium text-fg-muted">{t("dash.tlmInstallCommand")}
      <textarea readOnly spellCheck={false} value={issued.install} rows={4} className="mt-1 w-full bg-muted font-mono text-xs" onFocus={event => event.target.select()} />
    </label>
    <label className="block text-xs font-medium text-fg-muted">{t("dash.tlmKeyLabel")}
      <input readOnly spellCheck={false} value={issued.key} className="mt-1 w-full bg-muted font-mono text-xs" onFocus={event => event.target.select()} />
    </label>
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" size="sm" onClick={() => onCopy("install")}>{t(copied === "install" ? "dash.tlmCopied" : "dash.tlmCopyCommand")}</Button>
      <Button variant="secondary" size="sm" onClick={() => onCopy("key")}>{t(copied === "key" ? "dash.tlmCopied" : "dash.tlmCopyKey")}</Button>
      <Button variant="ghost" size="sm" onClick={onDismiss}>{t("dash.tlmDismiss")}</Button>
    </div>
  </div>
}

export interface SourceListViewProps {
  sources: TelemetrySource[]
  nowMs: number
  newName: string
  issued: IssuedKeyView | null
  busy: boolean
  /** An already translated message. */
  error: string
  copied: CopyTarget | null
  secureOrigin: boolean
  onName: (value: string) => void
  onCreate: () => void
  onRotate: (source: TelemetrySource) => void
  onDelete: (source: TelemetrySource) => void
  onCopy: (what: CopyTarget) => void
  onDismissIssued: () => void
  /** Opens the source's page; the button is shown only when this is given. */
  onOpen?: (source: TelemetrySource) => void
}

const BADGES = { never: { tone: "neutral", key: "dash.tlmNeverPushed" }, fresh: { tone: "success", key: "dash.tlmFresh" }, stale: { tone: "warn", key: "dash.tlmStale" } } as const

export function SourceListView(props: SourceListViewProps) {
  const t = useT()
  const titleId = useId()
  const { sources, busy } = props
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmSources")}</SectionHeading>
    <p className="text-body text-fg-muted">{t("dash.tlmDescription")}</p>
    {!props.secureOrigin ? <Notice tone="warn" role="status">{t("dash.tlmHttpsRequired")}</Notice> : null}
    {sources.length ? <ul className="space-y-1 text-body">
      {sources.map(source => {
        const badge = BADGES[sourceBadge(source, props.nowMs)]
        return <li key={source.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-fg">{source.name}</span>
            <Badge tone={badge.tone}>{t(badge.key)}</Badge>
            {source.lastPushAt ? <span className="text-fg-muted">{t("dash.tlmLastPush", { at: new Date(source.lastPushAt).toLocaleString() })}</span> : null}
          </span>
          <span className="flex gap-1">
            {props.onOpen ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => props.onOpen?.(source)}>{t("dash.tlmOpen")}</Button> : null}
            <Button variant="ghost" size="sm" disabled={busy || !props.secureOrigin} onClick={() => props.onRotate(source)}>{t("dash.tlmRotate")}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => props.onDelete(source)} className="text-danger hover:text-danger">{t("dash.delete")}</Button>
          </span>
        </li>
      })}
    </ul> : <p className="text-body text-fg-subtle">{t("dash.tlmNone")}</p>}
    <form className="flex flex-wrap items-center gap-2 border-t border-border pt-3" onSubmit={event => { event.preventDefault(); props.onCreate() }}>
      <input type="text" value={props.newName} maxLength={64} placeholder={t("dash.tlmName")} aria-label={t("dash.tlmName")} disabled={busy}
        onChange={event => props.onName(event.target.value)} />
      <Button type="submit" variant="primary" size="sm" disabled={!props.secureOrigin || !canCreateSource(props.newName, busy)}>{t("dash.tlmCreate")}</Button>
    </form>
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
    {props.issued ? <IssuedKeyPanel issued={props.issued} copied={props.copied} onCopy={props.onCopy} onDismiss={props.onDismissIssued} /> : null}
  </Card>
}

export function SourceListSection({ onOpen, onSourcesChanged }: { onOpen?: (source: TelemetrySource) => void; onSourcesChanged?: (sources: TelemetrySource[]) => void }) {
  const t = useT()
  const confirm = useConfirm()
  const [sources, setSources] = useState<TelemetrySource[]>([])
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [newName, setNewName] = useState("")
  const [issued, setIssued] = useState<IssuedKeyView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [copied, setCopied] = useState<CopyTarget | null>(null)
  const secureOrigin = window.location.protocol === "https:"

  const apply = useCallback((next: TelemetrySource[]) => { setSources(next); setNowMs(Date.now()); onSourcesChanged?.(next) }, [onSourcesChanged])
  const reload = useCallback(() => listTelemetrySources().then(result => apply(result.sources)).catch(() => setError(t("dash.tlmLoadError"))), [apply, t])
  useEffect(() => { void reload() }, [reload])

  const create = async () => {
    setBusy(true); setError(""); setCopied(null)
    try {
      const result = await createTelemetrySource(newName.trim())
      apply([...sources, result.source])
      setIssued({ sourceName: result.source.name, key: result.key, install: result.install })
      setNewName("")
    } catch (failure) { setError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const rotate = async (source: TelemetrySource) => {
    const sure = await confirm({ title: t("dash.tlmRotateConfirmTitle", { name: source.name }), description: t("dash.tlmRotateConfirmHint"), confirmLabel: t("dash.tlmRotate"), danger: true })
    if (!sure) return
    setBusy(true); setError(""); setCopied(null)
    try {
      const result = await rotateTelemetryKey(source.id)
      setIssued({ sourceName: source.name, key: result.key, install: result.install })
    } catch (failure) { setError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const remove = async (source: TelemetrySource) => {
    const sure = await confirm({ title: t("dash.tlmDeleteConfirmTitle", { name: source.name }), description: t("dash.tlmDeleteConfirmHint"), confirmLabel: t("dash.delete"), danger: true })
    if (!sure) return
    setBusy(true); setError("")
    try { apply((await deleteTelemetrySource(source.id)).sources); setIssued(null) }
    catch (failure) { setError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }

  return <SourceListView sources={sources} nowMs={nowMs} newName={newName} issued={issued} busy={busy} error={error} copied={copied} secureOrigin={secureOrigin}
    onName={setNewName} onCreate={() => void create()} onRotate={source => void rotate(source)} onDelete={source => void remove(source)} onOpen={onOpen}
    onCopy={async what => {
      if (!issued) return
      try { await navigator.clipboard.writeText(what === "install" ? issued.install : issued.key); setCopied(what) }
      catch { setError(t("dash.tlmCopyError")) }
    }}
    onDismissIssued={() => { setIssued(null); setCopied(null) }} />
}
```

`apps/dashboard/src/tabs/telemetry/TelemetryTab.tsx`:

```tsx
import { useT } from "../../state/i18n"
import { PageHeader } from "../../ui/page-header"
import { SourceListSection } from "./SourceList"

export function TelemetryTab() {
  const t = useT()
  return <div>
    <PageHeader title={t("dash.telemetry")} description={t("dash.telemetryDescription")} />
    <SourceListSection />
  </div>
}
```

- [ ] **Step 6: Add the navigation item and route**

In `apps/dashboard/src/shell/navigation.ts` add `Radar` to the lucide import (`import { Activity, ChartColumn, Boxes, Cable, CircleDollarSign, KeyRound, Network, Radar, RadioTower, Users } from "lucide-react"`) and add this item after the `latency` item of the observe group:

```ts
        { id: "telemetry", label: t("dash.telemetry"), icon: Radar },
```

In `apps/dashboard/src/App.tsx` add `import { TelemetryTab } from "./tabs/telemetry/TelemetryTab"` and, in `TabBody`, after the `latency` case:

```tsx
    case "telemetry":
      return <TelemetryTab />
```

- [ ] **Step 7: Add the copy (EN and ZH)**

In `packages/gateway/src/shared/edge/ui-pages/i18n.ts`, insert directly after the English line `      "dash.latency": "Latency",`:

```ts
      "dash.telemetry": "Telemetry",
      "dash.telemetryDescription": "Hourly metrics pushed by your own systems: where traffic goes, whether it is surging, and month-to-date usage against a limit.",
      "dash.tlmSources": "Telemetry sources",
      "dash.tlmDescription": "A source is an external system that pushes hourly metrics here with a push-only key. Create one, then run its install command on the machine to monitor.",
      "dash.tlmName": "Source name",
      "dash.tlmCreate": "Create source",
      "dash.tlmNone": "No sources yet.",
      "dash.tlmLastPush": "last push {at}",
      "dash.tlmNeverPushed": "never pushed",
      "dash.tlmFresh": "receiving",
      "dash.tlmStale": "stale",
      "dash.tlmOpen": "Open",
      "dash.tlmRotate": "Rotate key",
      "dash.tlmRotateConfirmTitle": "Rotate the key of {name}?",
      "dash.tlmRotateConfirmHint": "The current key stops working immediately. Run the new install command on the machine.",
      "dash.tlmDeleteConfirmTitle": "Delete {name}?",
      "dash.tlmDeleteConfirmHint": "The source and all of its data are deleted.",
      "dash.tlmKeyHint": "Shown once. Run the command on the machine as a user who can sudo. The key stays in that shell's history; rotate it here if that matters.",
      "dash.tlmInstallCommand": "Install command",
      "dash.tlmKeyLabel": "Push key",
      "dash.tlmCopyCommand": "Copy command",
      "dash.tlmCopyKey": "Copy key",
      "dash.tlmCopied": "Copied",
      "dash.tlmDismiss": "Done",
      "dash.tlmHttpsRequired": "Open this gateway over HTTPS to create a source or rotate a key.",
      "dash.tlmLimit": "You already have 16 sources. Delete one first.",
      "dash.tlmInvalid": "That request was not accepted. Check the values and try again.",
      "dash.tlmGone": "That source no longer exists. Refresh and try again.",
      "dash.tlmError": "Could not update telemetry. Refresh and try again.",
      "dash.tlmLoadError": "Could not load telemetry sources. Refresh and try again.",
      "dash.tlmCopyError": "Could not copy. Select the text and copy it by hand.",
```

and directly after the Chinese line `      "dash.latency": "延迟",`:

```ts
      "dash.telemetry": "遥测",
      "dash.telemetryDescription": "由你自己的系统每小时推送的指标：流量去了哪里、是否激增，以及本月用量相对上限的情况。",
      "dash.tlmSources": "遥测来源",
      "dash.tlmDescription": "来源是通过只能推送的密钥向这里每小时推送指标的外部系统。创建一个来源，然后在要监控的机器上运行它的安装命令。",
      "dash.tlmName": "来源名称",
      "dash.tlmCreate": "创建来源",
      "dash.tlmNone": "还没有来源。",
      "dash.tlmLastPush": "最近推送 {at}",
      "dash.tlmNeverPushed": "从未推送",
      "dash.tlmFresh": "正在接收",
      "dash.tlmStale": "已停滞",
      "dash.tlmOpen": "打开",
      "dash.tlmRotate": "轮换密钥",
      "dash.tlmRotateConfirmTitle": "轮换 {name} 的密钥？",
      "dash.tlmRotateConfirmHint": "当前密钥立即失效。请在机器上运行新的安装命令。",
      "dash.tlmDeleteConfirmTitle": "删除 {name}？",
      "dash.tlmDeleteConfirmHint": "该来源及其全部数据都会被删除。",
      "dash.tlmKeyHint": "仅显示一次。请在机器上以可 sudo 的用户运行该命令。密钥会留在该 shell 的历史记录中，如有顾虑请在此轮换。",
      "dash.tlmInstallCommand": "安装命令",
      "dash.tlmKeyLabel": "推送密钥",
      "dash.tlmCopyCommand": "复制命令",
      "dash.tlmCopyKey": "复制密钥",
      "dash.tlmCopied": "已复制",
      "dash.tlmDismiss": "完成",
      "dash.tlmHttpsRequired": "请通过 HTTPS 打开此网关，才能创建来源或轮换密钥。",
      "dash.tlmLimit": "你已有 16 个来源，请先删除一个。",
      "dash.tlmInvalid": "请求未被接受。请检查输入后重试。",
      "dash.tlmGone": "该来源已不存在。请刷新后重试。",
      "dash.tlmError": "无法更新遥测。请刷新后重试。",
      "dash.tlmLoadError": "无法加载遥测来源。请刷新后重试。",
      "dash.tlmCopyError": "无法复制。请选中文本后手动复制。",
```

- [ ] **Step 8: Run the tests and typecheck**

```bash
bun test ./apps/dashboard/src/tabs/telemetry ./apps/dashboard/src/shell ./packages/gateway/tests/i18n-keys.test.ts ./apps/dashboard/src/type-scale.test.ts
bun run --filter '@vibe-llm/dashboard' typecheck
```

Expected: PASS. The i18n key test proves every `t("...")` literal exists in both locales.

- [ ] **Step 9: Commit**

```bash
git add apps/dashboard/src/api/telemetry.ts apps/dashboard/src/tabs/telemetry/telemetry-errors.ts apps/dashboard/src/tabs/telemetry/telemetry-errors.test.ts \
  apps/dashboard/src/tabs/telemetry/telemetry-sources.ts apps/dashboard/src/tabs/telemetry/telemetry-sources.test.ts \
  apps/dashboard/src/tabs/telemetry/SourceList.tsx apps/dashboard/src/tabs/telemetry/SourceList.test.tsx apps/dashboard/src/tabs/telemetry/TelemetryTab.tsx \
  apps/dashboard/src/shell/navigation.ts apps/dashboard/src/shell/navigation.test.ts apps/dashboard/src/App.tsx packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "$(cat <<'EOF'
feat(telemetry): add the dashboard Telemetry page with source management and install command

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 14: Dashboard: source page with freshness, budget, chart, top table, flagged hours and settings

**Files:**
- Modify: `apps/dashboard/src/api/telemetry.ts`, `apps/dashboard/src/components/TimeSeriesChart.tsx`, `apps/dashboard/src/components/TimeSeriesChart.test.ts`
- Create: `apps/dashboard/src/tabs/telemetry/telemetry-format.ts`, `telemetry-format.test.ts`, `telemetry-settings-form.ts`, `telemetry-settings-form.test.ts`
- Create: `apps/dashboard/src/tabs/telemetry/Panels.tsx`, `ChartPanel.tsx`, `SettingsPanel.tsx`, `panels.test.tsx`, `SourcePage.tsx`
- Modify: `apps/dashboard/src/tabs/telemetry/TelemetryTab.tsx`, `packages/gateway/src/shared/edge/ui-pages/i18n.ts`

- [ ] **Step 1: Write the failing tests for the pure helpers**

`apps/dashboard/src/tabs/telemetry/telemetry-format.test.ts`:

```ts
import { expect, test } from "bun:test"
import type { TelemetryBudget, TelemetrySeries, TelemetrySummary } from "../../api/telemetry"
import {
  budgetView, chartFromSeries, defaultMetric, dimsLabel, formatChange, formatShare, formatValue, freshnessNotices, groupLabel, hourRange, hourShort,
  rangeWindow, statusTone,
} from "./telemetry-format"

test("values render in the unit of their metric", () => {
  expect(formatValue(0, "bytes")).toBe("0 B")
  expect(formatValue(999, "bytes")).toBe("999 B")
  expect(formatValue(1500, "bytes")).toBe("1.5 KB")
  expect(formatValue(1_234_000_000, "bytes")).toBe("1.23 GB")
  expect(formatValue(2.5e12, "bytes")).toBe("2.5 TB")
  expect(formatValue(120, "ms")).toBe("120 ms")
  expect(formatValue(1500, "ms")).toBe("1.5 s")
  expect(formatValue(1_234_567, "count")).toBe("1,234,567")
  expect(formatValue(0.5, "count")).toBe("0.5")
  expect(formatValue(7, null)).toBe("7")
})

test("change and share are percentages and a missing change is a dash", () => {
  expect(formatChange(1)).toBe("+100%")
  expect(formatChange(-0.104)).toBe("-10%")
  expect(formatChange(0)).toBe("0%")
  expect(formatChange(null)).toBe("—")
  expect(formatShare(0.6)).toBe("60.0%")
})

test("group and dim labels use the configured names and fall back to the raw value", () => {
  const settings = { labels: { user: { "#1": "MacBook" } } }
  expect(groupLabel(settings, "user", "#1", "(none)")).toBe("MacBook")
  expect(groupLabel(settings, "user", "#2", "(none)")).toBe("#2")
  expect(groupLabel(settings, "domain", "a.com", "(none)")).toBe("a.com")
  expect(groupLabel(settings, "user", "", "(none)")).toBe("(none)")
  expect(dimsLabel(settings, { user: "#1", domain: "a.com" })).toBe("domain=a.com, user=MacBook")
})

test("hours are shown in UTC as a range and as a short label", () => {
  expect(hourRange("2026-11-16T13:00:00Z")).toBe("13:00–14:00 UTC")
  expect(hourRange("2026-11-16T23:00:00Z")).toBe("23:00–00:00 UTC")
  expect(hourShort("2026-11-16T13:00:00Z")).toBe("11-16 13:00")
})

const summary = (over: Partial<TelemetrySummary> = {}): TelemetrySummary => ({
  now: "2026-11-16T12:30:00.000Z", freshness: { lastPushAt: "2026-11-16T09:00:00.000Z", stale: false, staleAfterHours: 2, hoursSincePush: 3 }, budget: null,
  surges: [], flags: [], checks: [], ...over,
})
const check = (status: "passed" | "failed" | "no check" | "not monitored") => ({ metric: "probe.ok", hour: "2026-11-16T11:00:00Z", status, stage: null })

test("a stale source warns, and a latest closed hour with no check warns alongside it; the other statuses never warn", () => {
  expect(freshnessNotices(summary())).toEqual([])
  const stale = { ...summary().freshness, stale: true }
  expect(freshnessNotices(summary({ freshness: stale }))).toEqual([{ kind: "stale", hours: 3 }])
  expect(freshnessNotices(summary({ checks: [check("no check")] }))).toEqual([{ kind: "noCheck", metric: "probe.ok", hour: "2026-11-16T11:00:00Z" }])
  expect(freshnessNotices(summary({ freshness: stale, checks: [check("no check")] })).map(n => n.kind)).toEqual(["stale", "noCheck"])
  for (const status of ["passed", "failed", "not monitored"] as const) expect(freshnessNotices(summary({ checks: [check(status)] }))).toEqual([])
})

test("check statuses have their own tones: passed green, failed red, no check a warning, not monitored neutral", () => {
  expect([statusTone("passed"), statusTone("failed"), statusTone("no check"), statusTone("not monitored")]).toEqual(["success", "danger", "warn", "neutral"])
})

const budget = (over: Partial<TelemetryBudget> = {}): TelemetryBudget => ({
  metric: "nic.tx_bytes", unit: "bytes", monthStart: "2026-11-01T00:00:00Z", mtd: 372e9, projection: 719.5e9, averageDaily: 24e9, monthlyLimit: 500e9,
  mtdPercent: 74.4, projectionPercent: 143.9, overLimit: true, cost: null, ...over,
})

test("the budget bar is red when the projection exceeds the limit and otherwise follows the usage thresholds", () => {
  expect(budgetView(budget())).toEqual({ percent: 74.4, tone: "danger", over: true })
  expect(budgetView(budget({ overLimit: false, mtdPercent: 40, projectionPercent: 80 }))).toEqual({ percent: 40, tone: "brand", over: false })
  expect(budgetView(budget({ overLimit: false, mtdPercent: 80 })).tone).toBe("warn")
  expect(budgetView(budget({ overLimit: false, mtdPercent: 95 })).tone).toBe("danger")
  expect(budgetView(budget({ monthlyLimit: null, mtdPercent: null, projectionPercent: null, overLimit: null }))).toEqual({ percent: null, tone: "brand", over: false })
})

test("range windows end after the current hour and span 24 hours, 7 days or 30 days", () => {
  const now = Date.parse("2026-11-16T12:34:56Z")
  expect(rangeWindow("24h", now)).toEqual({ from: "2026-11-15T13:00:00Z", to: "2026-11-16T13:00:00Z" })
  expect(rangeWindow("7d", now).from).toBe("2026-11-09T13:00:00Z")
  expect(rangeWindow("30d", now).from).toBe("2026-10-17T13:00:00Z")
})

test("the first metric to show is the budget metric, else a non-check metric, else any", () => {
  const info = (metric: string) => ({ metric, unit: "count" as const, firstHour: "", lastHour: "", dims: [] })
  const metrics = [info("probe.ok"), info("nic.tx_bytes"), info("proxy.sent_bytes")]
  expect(defaultMetric(metrics, { budgetMetric: "proxy.sent_bytes" })).toBe("proxy.sent_bytes")
  expect(defaultMetric(metrics, { checkMetrics: ["probe.ok"] })).toBe("nic.tx_bytes")
  expect(defaultMetric([info("probe.ok")], { checkMetrics: ["probe.ok"] })).toBe("probe.ok")
  expect(defaultMetric([], {})).toBe("")
})

const series = (over: Partial<TelemetrySeries> = {}): TelemetrySeries => ({
  metric: "m", unit: "bytes", from: "2026-11-16T10:00:00Z", to: "2026-11-16T13:00:00Z", hours: ["2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z"],
  total: [3, 9, 2], groups: [], ...over,
})
const palette = ["#111111", "#222222", "#333333"]

test("a chart has one line per group plus a dashed total, labelled by the configured names, with surge hours highlighted on the total", () => {
  const chart = chartFromSeries({
    series: series({ groups: [{ key: "#1", values: [1, 5, 1] }, { key: "(other)", values: [2, 4, 1] }] }),
    settings: { labels: { user: { "#1": "MacBook" } } }, groupBy: "user", palette, totalLabel: "Total", otherLabel: "Other", noneLabel: "(none)",
    surgeHours: new Set(["2026-11-16T11:00:00Z"]),
  })
  expect(chart.labels).toEqual(["11-16 10:00", "11-16 11:00", "11-16 12:00"])
  expect(chart.datasets.map(d => [d.label, d.color, d.dashed ?? false, d.fill])).toEqual([
    ["MacBook", "#111111", false, false], ["Other", "#8a8a8a", false, false], ["Total", "#6b7280", true, false],
  ])
  expect(chart.datasets[2]!.highlight).toEqual([false, true, false])
  expect(chart.datasets[0]!.highlight).toBeUndefined()
})

test("without groups the total is the only, solid, filled line", () => {
  const chart = chartFromSeries({ series: series(), settings: {}, groupBy: "", palette, totalLabel: "Total", otherLabel: "Other", noneLabel: "(none)", surgeHours: new Set() })
  expect(chart.datasets).toEqual([{ label: "Total", data: [3, 9, 2], color: "#111111", fill: true }])
})
```

`apps/dashboard/src/tabs/telemetry/telemetry-settings-form.test.ts`:

```ts
import { expect, test } from "bun:test"
import { formToSettings, settingsToForm, type SettingsForm } from "./telemetry-settings-form"

const empty = settingsToForm({}, null)

test("an empty form means no settings", () => {
  expect(formToSettings(empty, null)).toEqual({ ok: true, settings: {} })
})

test("settings round-trip through the form, with byte limits shown in decimal gigabytes", () => {
  const settings = {
    budgetMetric: "nic.tx_bytes", monthlyLimit: 500e9, pricePerGB: 0.08, freeGB: 100, surgeMetrics: ["nic.tx_bytes", "proxy.sent_bytes"], surgeFactor: 4,
    surgeMinBytes: 1.5e9, surgeMinCount: 500, flagNonZeroMetrics: ["probe.fail"], checkMetrics: ["probe.ok"], staleAfterHours: 3,
    labels: { domain: { "a.com": "A" }, user: { "#1": "MacBook", "#2": "Phone" } },
  }
  const form = settingsToForm(settings, "bytes")
  expect(form.monthlyLimit).toBe("500")
  expect(form.surgeMinGB).toBe("1.5")
  expect(form.labels).toBe("domain:a.com=A\nuser:#1=MacBook\nuser:#2=Phone")
  expect(formToSettings(form, "bytes")).toEqual({ ok: true, settings })
})

test("a limit on a non-byte metric is used as is", () => {
  const form = { ...empty, budgetMetric: "proxy.connections", monthlyLimit: "5000" }
  expect(formToSettings(form, "count")).toEqual({ ok: true, settings: { budgetMetric: "proxy.connections", monthlyLimit: 5000 } })
  expect(settingsToForm({ monthlyLimit: 5000 }, "count").monthlyLimit).toBe("5000")
})

test("lists accept commas and spaces and drop duplicates", () => {
  expect(formToSettings({ ...empty, surgeMetrics: "a.b, c  a.b\nd" }, null)).toEqual({ ok: true, settings: { surgeMetrics: ["a.b", "c", "d"] } })
})

test.each<[Partial<SettingsForm>, keyof SettingsForm]>([
  [{ budgetMetric: "Bad Name" }, "budgetMetric"], [{ monthlyLimit: "0" }, "monthlyLimit"], [{ monthlyLimit: "abc" }, "monthlyLimit"],
  [{ pricePerGB: "-1" }, "pricePerGB"], [{ freeGB: "x" }, "freeGB"], [{ surgeFactor: "1" }, "surgeFactor"], [{ surgeFactor: "1001" }, "surgeFactor"],
  [{ surgeMinGB: "-2" }, "surgeMinGB"], [{ surgeMinCount: "1e99" }, "surgeMinCount"], [{ staleAfterHours: "0" }, "staleAfterHours"], [{ staleAfterHours: "2.5" }, "staleAfterHours"],
  [{ surgeMetrics: Array.from({ length: 11 }, (_, i) => `m${i}`).join(",") }, "surgeMetrics"],
  [{ flagNonZeroMetrics: Array.from({ length: 21 }, (_, i) => `m${i}`).join(",") }, "flagNonZeroMetrics"],
  [{ checkMetrics: "Bad-Name" }, "checkMetrics"],
  [{ labels: "no equals sign" }, "labels"], [{ labels: "user:=Empty value" }, "labels"], [{ labels: "Bad:x=y" }, "labels"], [{ labels: "user:x=" }, "labels"],
  [{ labels: "user:x=" + "y".repeat(65) }, "labels"],
])("%j is rejected at the field %s", (over, field) => {
  expect(formToSettings({ ...empty, ...over }, null)).toEqual({ ok: false, field })
})

test("a label value may contain a colon, as an IPv6 address does", () => {
  expect(formToSettings({ ...empty, labels: "domain:2001:db8::1=Router" }, null)).toEqual({ ok: true, settings: { labels: { domain: { "2001:db8::1": "Router" } } } })
})
```

Append to `apps/dashboard/src/components/TimeSeriesChart.test.ts` (and add `pointStyle` to the import on its second line):

```ts
describe("pointStyle", () => {
  test("a dataset without highlights draws no markers", () => {
    expect(pointStyle({ color: "#112233" })).toEqual({ radius: 0, background: "#112233" })
  })

  test("highlighted points become large alert-coloured markers and the rest stay hidden", () => {
    expect(pointStyle({ color: "#112233", highlight: [false, true] }, "#ff0000")).toEqual({ radius: [0, 5], background: ["#112233", "#ff0000"] })
  })
})
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test ./apps/dashboard/src/tabs/telemetry ./apps/dashboard/src/components/TimeSeriesChart.test.ts`
Expected: FAIL (modules and `pointStyle` missing).

- [ ] **Step 3: Extend the API client**

Append to `apps/dashboard/src/api/telemetry.ts`:

```ts

export interface TelemetryMetricInfo { metric: string; unit: TelemetryUnit; firstHour: string; lastHour: string; dims: string[] }

export interface TelemetrySeries {
  metric: string
  unit: TelemetryUnit | null
  from: string
  to: string
  hours: string[]
  total: number[]
  groups: Array<{ key: string; values: number[] }>
  /** Only for `checkMetrics`: one status and, for a failure, one stage per hour. */
  statuses?: CheckStatus[]
  stages?: Array<string | null>
}

export interface TelemetryTopRow { key: string; value: number; share: number; previous: number; change: number | null }
export interface TelemetryTop {
  metric: string
  unit: TelemetryUnit | null
  groupBy: string
  from: string
  to: string
  previousFrom: string
  previousTo: string
  total: number
  rows: TelemetryTopRow[]
  otherCurrent: number
  otherShare: number
}

export interface TelemetryBudget {
  metric: string
  unit: TelemetryUnit | null
  monthStart: string
  mtd: number
  projection: number
  averageDaily: number | null
  monthlyLimit: number | null
  mtdPercent: number | null
  projectionPercent: number | null
  overLimit: boolean | null
  cost: { mtd: number; projection: number | null } | null
}

export interface TelemetryContribution { dims: Record<string, string>; value: number }
export interface TelemetrySurge { metric: string; hour: string; value: number; baseline: number; ratio: number | null; contributors: TelemetryContribution[] }
export interface TelemetryFlag { metric: string; hour: string; total: number; breakdown: TelemetryContribution[] }
export interface TelemetryCheck { metric: string; hour: string; status: CheckStatus; stage: string | null }

export interface TelemetrySummary {
  now: string
  freshness: { lastPushAt: string | null; stale: boolean; staleAfterHours: number; hoursSincePush: number | null }
  budget: TelemetryBudget | null
  surges: TelemetrySurge[]
  flags: TelemetryFlag[]
  checks: TelemetryCheck[]
}

export const telemetryMetrics = (id: string) => api<{ metrics: TelemetryMetricInfo[] }>(path(id, "/metrics"))
export const telemetrySeries = (id: string, query: { metric: string; from: string; to: string; groupBy?: string; top?: number }) =>
  api<TelemetrySeries>(path(id, "/series"), { query })
export const telemetryTop = (id: string, query: { metric: string; from: string; to: string; groupBy: string; limit?: number }) =>
  api<TelemetryTop>(path(id, "/top"), { query })
export const telemetrySummary = (id: string) => api<TelemetrySummary>(path(id, "/summary"))
```

- [ ] **Step 4: Write the format helpers**

`apps/dashboard/src/tabs/telemetry/telemetry-format.ts`:

```ts
import type { CheckStatus, TelemetryBudget, TelemetryMetricInfo, TelemetrySeries, TelemetrySettings, TelemetrySummary, TelemetryUnit } from "../../api/telemetry"
import type { ChartDataset } from "../../components/TimeSeriesChart"
import { meterTone, type MeterTone } from "../../ui/meter"

export type RangeId = "24h" | "7d" | "30d"
export const RANGE_HOURS: Record<RangeId, number> = { "24h": 24, "7d": 168, "30d": 720 }
export const STATUS_KEYS: Record<CheckStatus, string> = {
  passed: "dash.tlmStatusPassed", failed: "dash.tlmStatusFailed", "no check": "dash.tlmStatusNoCheck", "not monitored": "dash.tlmStatusNotMonitored",
}
export const CHECK_SENTENCE_KEYS: Record<CheckStatus, string> = {
  passed: "dash.tlmCheckPassed", failed: "dash.tlmCheckFailed", "no check": "dash.tlmCheckNoCheck", "not monitored": "dash.tlmCheckNotMonitored",
}

const trim = (value: number) => String(parseFloat(value.toFixed(2)))
const grouped = (value: number) => String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
const pad = (value: number) => String(value).padStart(2, "0")

/** Decimal units (1 KB = 1000 B), matching the cost conversion. */
export function formatValue(value: number, unit: TelemetryUnit | null): string {
  if (unit === "bytes") {
    const steps = ["B", "KB", "MB", "GB", "TB", "PB"]
    let scaled = Math.abs(value)
    let index = 0
    while (scaled >= 1000 && index < steps.length - 1) { scaled /= 1000; index++ }
    return `${value < 0 ? "-" : ""}${trim(scaled)} ${steps[index]}`
  }
  if (unit === "ms") return value >= 1000 ? `${trim(value / 1000)} s` : `${trim(value)} ms`
  return Number.isInteger(value) ? grouped(value) : trim(value)
}

export function formatChange(change: number | null): string {
  if (change === null) return "—"
  const percent = Math.round(change * 100)
  return `${percent > 0 ? "+" : ""}${percent}%`
}

export const formatShare = (share: number): string => `${(share * 100).toFixed(1)}%`

/** The owner's name for a dim value, the raw value when there is none, and `noneLabel` for the empty group. */
export function groupLabel(settings: TelemetrySettings, dimKey: string, value: string, noneLabel: string): string {
  if (value === "") return noneLabel
  return settings.labels?.[dimKey]?.[value] ?? value
}

export function dimsLabel(settings: TelemetrySettings, dims: Record<string, string>): string {
  return Object.keys(dims).sort().map(key => `${key}=${groupLabel(settings, key, dims[key]!, "")}`).join(", ")
}

export function hourRange(iso: string): string {
  const start = new Date(iso)
  const end = new Date(start.getTime() + 3_600_000)
  return `${pad(start.getUTCHours())}:00–${pad(end.getUTCHours())}:00 UTC`
}

export function hourShort(iso: string): string {
  const date = new Date(iso)
  return `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:00`
}

export type FreshnessNotice = { kind: "stale"; hours: number } | { kind: "noCheck"; metric: string; hour: string }

/** The staleness warning and, alongside it, one warning for each check metric whose latest closed hour has no check. */
export function freshnessNotices(summary: Pick<TelemetrySummary, "freshness" | "checks">): FreshnessNotice[] {
  const notices: FreshnessNotice[] = []
  if (summary.freshness.stale) notices.push({ kind: "stale", hours: summary.freshness.hoursSincePush ?? 0 })
  for (const check of summary.checks) if (check.status === "no check") notices.push({ kind: "noCheck", metric: check.metric, hour: check.hour })
  return notices
}

export type StatusTone = "success" | "danger" | "warn" | "neutral"
export const statusTone = (status: CheckStatus): StatusTone =>
  status === "passed" ? "success" : status === "failed" ? "danger" : status === "no check" ? "warn" : "neutral"

export interface BudgetView { percent: number | null; tone: MeterTone; over: boolean }

export function budgetView(budget: TelemetryBudget): BudgetView {
  const over = budget.overLimit === true
  const percent = budget.mtdPercent
  return { percent, over, tone: over ? "danger" : percent === null ? "brand" : meterTone(percent) }
}

const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z")

/** `to` is the end of the current hour, so the (partial) current hour is included. */
export function rangeWindow(range: RangeId, nowMs: number): { from: string; to: string } {
  const to = Math.floor(nowMs / 3_600_000) * 3_600_000 + 3_600_000
  return { from: iso(to - RANGE_HOURS[range] * 3_600_000), to: iso(to) }
}

export function defaultMetric(metrics: readonly TelemetryMetricInfo[], settings: TelemetrySettings): string {
  if (settings.budgetMetric && metrics.some(info => info.metric === settings.budgetMetric)) return settings.budgetMetric
  const checks = settings.checkMetrics ?? []
  return (metrics.find(info => !checks.includes(info.metric)) ?? metrics[0])?.metric ?? ""
}

export interface ChartInput {
  series: TelemetrySeries
  settings: TelemetrySettings
  groupBy: string
  palette: readonly string[]
  totalLabel: string
  otherLabel: string
  noneLabel: string
  surgeHours: ReadonlySet<string>
}

/** One line per group plus a dashed total; without groups the total is the single filled line. */
export function chartFromSeries(input: ChartInput): { labels: string[]; datasets: ChartDataset[] } {
  const { series, palette } = input
  const labels = series.hours.map(hourShort)
  const highlight = series.hours.map(hour => input.surgeHours.has(hour))
  const flagged = highlight.some(Boolean) ? { highlight } : {}
  if (series.groups.length === 0) {
    return { labels, datasets: [{ label: input.totalLabel, data: series.total, color: palette[0] ?? "#4E6CF5", fill: true, ...flagged }] }
  }
  const lines: ChartDataset[] = series.groups.map((group, index) => ({
    label: group.key === "(other)" ? input.otherLabel : groupLabel(input.settings, input.groupBy, group.key, input.noneLabel),
    data: group.values, color: group.key === "(other)" ? "#8a8a8a" : palette[index % palette.length] ?? "#4E6CF5", fill: false,
  }))
  lines.push({ label: input.totalLabel, data: series.total, color: "#6b7280", dashed: true, fill: false, ...flagged })
  return { labels, datasets: lines }
}
```

- [ ] **Step 5: Write the settings form helpers**

`apps/dashboard/src/tabs/telemetry/telemetry-settings-form.ts`:

```ts
import type { TelemetrySettings, TelemetryUnit } from "../../api/telemetry"

/** Every field is text; limits and byte minimums are decimal gigabytes (1 GB = 1e9 bytes) for byte metrics. */
export interface SettingsForm {
  budgetMetric: string
  monthlyLimit: string
  pricePerGB: string
  freeGB: string
  surgeMetrics: string
  surgeFactor: string
  surgeMinGB: string
  surgeMinCount: string
  flagNonZeroMetrics: string
  checkMetrics: string
  staleAfterHours: string
  labels: string
}

export type FormResult = { ok: true; settings: TelemetrySettings } | { ok: false; field: keyof SettingsForm }

const GB = 1e9
const METRIC = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/
const DIM_KEY = /^[a-z][a-z0-9_]{0,31}$/

const text = (value: number | undefined, scale = 1) => value === undefined ? "" : String(parseFloat((value / scale).toFixed(6)))

function labelsToText(labels: TelemetrySettings["labels"]): string {
  const lines: string[] = []
  for (const dim of Object.keys(labels ?? {}).sort()) {
    const values = labels![dim]!
    for (const value of Object.keys(values).sort()) lines.push(`${dim}:${value}=${values[value]}`)
  }
  return lines.join("\n")
}

export function settingsToForm(settings: TelemetrySettings, budgetUnit: TelemetryUnit | null): SettingsForm {
  return {
    budgetMetric: settings.budgetMetric ?? "",
    monthlyLimit: text(settings.monthlyLimit, budgetUnit === "bytes" ? GB : 1),
    pricePerGB: text(settings.pricePerGB),
    freeGB: text(settings.freeGB),
    surgeMetrics: (settings.surgeMetrics ?? []).join(", "),
    surgeFactor: text(settings.surgeFactor),
    surgeMinGB: text(settings.surgeMinBytes, GB),
    surgeMinCount: text(settings.surgeMinCount),
    flagNonZeroMetrics: (settings.flagNonZeroMetrics ?? []).join(", "),
    checkMetrics: (settings.checkMetrics ?? []).join(", "),
    staleAfterHours: text(settings.staleAfterHours),
    labels: labelsToText(settings.labels),
  }
}

type Parsed<T> = { ok: true; value: T | undefined } | { ok: false }

function parseNumber(raw: string, rule: { min: number; max: number; integer?: boolean; above?: boolean }): Parsed<number> {
  const trimmed = raw.trim()
  if (trimmed === "") return { ok: true, value: undefined }
  const value = Number(trimmed)
  const low = rule.above ? value <= rule.min : value < rule.min
  if (!Number.isFinite(value) || low || value > rule.max || (rule.integer && !Number.isInteger(value))) return { ok: false }
  return { ok: true, value }
}

function parseList(raw: string, max: number): Parsed<string[]> {
  const items = [...new Set(raw.split(/[\s,]+/).filter(Boolean))]
  if (items.length === 0) return { ok: true, value: undefined }
  if (items.length > max || items.some(item => item.length > 64 || !METRIC.test(item))) return { ok: false }
  return { ok: true, value: items }
}

/** One `dimension:value=Name` per line; the value may contain colons (IPv6), the name may contain `=`. */
function parseLabels(raw: string): Parsed<Record<string, Record<string, string>>> {
  const labels: Record<string, Record<string, string>> = {}
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    const colon = trimmed.indexOf(":")
    const equals = colon < 0 ? -1 : trimmed.indexOf("=", colon + 1)
    if (colon < 1 || equals < 0) return { ok: false }
    const dim = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1, equals).trim()
    const name = trimmed.slice(equals + 1).trim()
    if (!DIM_KEY.test(dim) || value.length < 1 || value.length > 256 || name.length < 1 || name.length > 64) return { ok: false }
    ;(labels[dim] ??= {})[value] = name
  }
  const dims = Object.keys(labels)
  if (dims.length === 0) return { ok: true, value: undefined }
  return dims.length > 8 ? { ok: false } : { ok: true, value: labels }
}

export function formToSettings(form: SettingsForm, budgetUnit: TelemetryUnit | null): FormResult {
  const settings: TelemetrySettings = {}
  const budgetMetric = form.budgetMetric.trim()
  if (budgetMetric !== "") {
    if (budgetMetric.length > 64 || !METRIC.test(budgetMetric)) return { ok: false, field: "budgetMetric" }
    settings.budgetMetric = budgetMetric
  }
  const bytes = budgetUnit === "bytes"
  const limit = parseNumber(form.monthlyLimit, { min: 0, above: true, max: bytes ? 1e6 : 1e15 })
  if (!limit.ok) return { ok: false, field: "monthlyLimit" }
  if (limit.value !== undefined) settings.monthlyLimit = bytes ? Math.round(limit.value * GB) : limit.value
  const price = parseNumber(form.pricePerGB, { min: 0, max: 1e6 })
  if (!price.ok) return { ok: false, field: "pricePerGB" }
  if (price.value !== undefined) settings.pricePerGB = price.value
  const free = parseNumber(form.freeGB, { min: 0, max: 1e9 })
  if (!free.ok) return { ok: false, field: "freeGB" }
  if (free.value !== undefined) settings.freeGB = free.value
  const surge = parseList(form.surgeMetrics, 10)
  if (!surge.ok) return { ok: false, field: "surgeMetrics" }
  if (surge.value) settings.surgeMetrics = surge.value
  const factor = parseNumber(form.surgeFactor, { min: 1, above: true, max: 1000 })
  if (!factor.ok) return { ok: false, field: "surgeFactor" }
  if (factor.value !== undefined) settings.surgeFactor = factor.value
  const minGb = parseNumber(form.surgeMinGB, { min: 0, max: 1e6 })
  if (!minGb.ok) return { ok: false, field: "surgeMinGB" }
  if (minGb.value !== undefined) settings.surgeMinBytes = Math.round(minGb.value * GB)
  const minCount = parseNumber(form.surgeMinCount, { min: 0, max: 1e15 })
  if (!minCount.ok) return { ok: false, field: "surgeMinCount" }
  if (minCount.value !== undefined) settings.surgeMinCount = minCount.value
  const flags = parseList(form.flagNonZeroMetrics, 20)
  if (!flags.ok) return { ok: false, field: "flagNonZeroMetrics" }
  if (flags.value) settings.flagNonZeroMetrics = flags.value
  const checks = parseList(form.checkMetrics, 20)
  if (!checks.ok) return { ok: false, field: "checkMetrics" }
  if (checks.value) settings.checkMetrics = checks.value
  const stale = parseNumber(form.staleAfterHours, { min: 1, max: 720, integer: true })
  if (!stale.ok) return { ok: false, field: "staleAfterHours" }
  if (stale.value !== undefined) settings.staleAfterHours = stale.value
  const labels = parseLabels(form.labels)
  if (!labels.ok) return { ok: false, field: "labels" }
  if (labels.value) settings.labels = labels.value
  return { ok: true, settings }
}
```

- [ ] **Step 6: Add per-point highlight to the chart**

In `apps/dashboard/src/components/TimeSeriesChart.tsx`, add to `interface ChartDataset` (after `cacheData`):

```ts
  /**
   * Per-bucket flags, aligned with `data`. Flagged points are drawn as large alert-coloured markers (surge hours);
   * the rest stay hidden, as on every other line.
   */
  highlight?: boolean[]
```

add this exported helper above the component (next to `paletteFor`):

```ts
/** Per-point radius and fill for a dataset: flagged points are large and in the alert colour, the rest are hidden. */
export function pointStyle(dataset: Pick<ChartDataset, "color" | "highlight">, alertColor = "#dc2626"): { radius: number | number[]; background: string | string[] } {
  if (!dataset.highlight) return { radius: 0, background: dataset.color }
  return {
    radius: dataset.highlight.map(flag => flag ? 5 : 0),
    background: dataset.highlight.map(flag => flag ? alertColor : dataset.color),
  }
}
```

and replace the line `      pointRadius: 0,` in the `cjDatasets` mapping with:

```ts
      pointRadius: pointStyle(d).radius,
      pointBackgroundColor: pointStyle(d).background,
```

Update the test import to `import { pointStyle, tooltipPlacement } from "./TimeSeriesChart"`.

- [ ] **Step 7: Run the helper tests**

Run: `bun test ./apps/dashboard/src/tabs/telemetry/telemetry-format.test.ts ./apps/dashboard/src/tabs/telemetry/telemetry-settings-form.test.ts ./apps/dashboard/src/components/TimeSeriesChart.test.ts`
Expected: PASS.

- [ ] **Step 8: Write the failing view tests**

`apps/dashboard/src/tabs/telemetry/panels.test.tsx`:

```tsx
import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { TelemetryBudget, TelemetrySummary, TelemetryTop } from "../../api/telemetry"
import { installDictionary } from "../../state/i18n-fixture"
import { BudgetPanel, CheckStrip, FlaggedPanel, FreshnessPanel, TopPanel } from "./Panels"
import { SETTINGS_FIELDS, SettingsPanel, type SettingsPanelProps } from "./SettingsPanel"
import { settingsToForm } from "./telemetry-settings-form"

const summary = (over: Partial<TelemetrySummary> = {}): TelemetrySummary => ({
  now: "2026-11-16T12:30:00.000Z", freshness: { lastPushAt: "2026-11-16T09:00:00.000Z", stale: false, staleAfterHours: 2, hoursSincePush: 3 }, budget: null,
  surges: [], flags: [], checks: [], ...over,
})
const check = (status: "passed" | "failed" | "no check" | "not monitored", stage: string | null = null) => ({ metric: "probe.ok", hour: "2026-11-16T11:00:00Z", status, stage })

test("freshness shows the last push, and a stale source gets the staleness warning", () => {
  expect(renderToStaticMarkup(<FreshnessPanel summary={null} />)).toContain("dash.loadingShort")
  const fresh = renderToStaticMarkup(<FreshnessPanel summary={summary()} />)
  expect(fresh).toContain("dash.tlmLastPush")
  expect(fresh).not.toContain("dash.tlmStaleWarning")
  expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ freshness: { lastPushAt: null, stale: false, staleAfterHours: 2, hoursSincePush: null } })} />)).toContain("dash.tlmNeverPushed")
  expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ freshness: { lastPushAt: "x", stale: true, staleAfterHours: 2, hoursSincePush: 5 } })} />)).toContain("dash.tlmStaleWarning")
})

test("each check status is worded as a single check, and only no check warns, alongside a staleness warning when both apply", () => {
  const html = (status: Parameters<typeof check>[0], stage: string | null = null, stale = false) => renderToStaticMarkup(
    <FreshnessPanel summary={summary({ checks: [check(status, stage)], freshness: { lastPushAt: "2026-11-16T09:00:00.000Z", stale, staleAfterHours: 2, hoursSincePush: 3 } })} />)
  expect(html("passed")).toContain("dash.tlmCheckPassed")
  expect(html("passed")).not.toContain("dash.tlmNoCheckWarning")
  const failed = html("failed", "tls")
  expect(failed).toContain("dash.tlmCheckFailed")
  expect(failed).toContain("dash.tlmCheckStage")
  expect(html("not monitored")).toContain("dash.tlmCheckNotMonitored")
  expect(html("not monitored")).not.toContain("dash.tlmNoCheckWarning")
  const none = html("no check")
  expect(none).toContain("dash.tlmCheckNoCheck")
  expect(none).toContain("dash.tlmNoCheckWarning")
  expect(none).not.toContain("dash.tlmStaleWarning")
  const both = html("no check", null, true)
  expect(both).toContain("dash.tlmStaleWarning")
  expect(both).toContain("dash.tlmNoCheckWarning")
})

test("the single-check sentence says it reflects only the moment of the check, in both languages", () => {
  for (const language of ["en", "zh"] as const) {
    const restore = installDictionary(language)
    try {
      const html = renderToStaticMarkup(<FreshnessPanel summary={summary({ checks: [check("passed")] })} />)
      expect(html).toContain("11:00–12:00 UTC")
      expect(html).not.toContain("dash.tlmCheckPassed")
    } finally { restore() }
  }
  const restore = installDictionary("en")
  try {
    expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ checks: [check("passed")] })} />)).toContain("only the moment of the check")
    expect(renderToStaticMarkup(<FreshnessPanel summary={summary({ checks: [check("no check")] })} />)).toContain("the VM may be down or the agent not running")
  } finally { restore() }
})

const budget = (over: Partial<TelemetryBudget> = {}): TelemetryBudget => ({
  metric: "nic.tx_bytes", unit: "bytes", monthStart: "2026-11-01T00:00:00Z", mtd: 372e9, projection: 719.5e9, averageDaily: 24e9, monthlyLimit: 500e9,
  mtdPercent: 74.4, projectionPercent: 143.9, overLimit: true, cost: { mtd: 27.2, projection: 61.95 }, ...over,
})

test("the budget panel shows month-to-date, the projection, a red bar and an alert when the projection exceeds the limit, and the cost", () => {
  expect(renderToStaticMarkup(<BudgetPanel budget={null} />)).toContain("dash.tlmBudgetUnset")
  const html = renderToStaticMarkup(<BudgetPanel budget={budget()} />)
  expect(html).toContain("372 GB")
  expect(html).toContain("719.5 GB")
  expect(html).toContain("500 GB")
  expect(html).toContain("bg-danger")
  expect(html).toContain("dash.tlmOverLimit")
  expect(html).toContain('role="alert"')
  expect(html).toContain("dash.tlmCost")
  const calm = renderToStaticMarkup(<BudgetPanel budget={budget({ overLimit: false, mtdPercent: 40, projection: 450e9, cost: null })} />)
  expect(calm).toContain("bg-brand")
  expect(calm).not.toContain("dash.tlmOverLimit")
  expect(calm).not.toContain("dash.tlmCost")
  expect(renderToStaticMarkup(<BudgetPanel budget={budget({ monthlyLimit: null, mtdPercent: null, projectionPercent: null, overLimit: null, cost: null })} />)).not.toContain("dash.tlmPercentOfLimit")
})

test("the check strip marks every hour: passed green, failed red, no check amber and not monitored neutral, never a percentage", () => {
  const hours = ["2026-11-16T09:00:00Z", "2026-11-16T10:00:00Z", "2026-11-16T11:00:00Z", "2026-11-16T12:00:00Z"]
  const html = renderToStaticMarkup(<CheckStrip hours={hours} statuses={["not monitored", "passed", "failed", "no check"]} stages={[null, null, "tls", null]} />)
  const markers = html.match(/<span[^>]*data-status="[^"]*"[^>]*>/g) ?? []
  expect(markers).toHaveLength(4)
  expect(markers[0]).toContain("bg-fg-subtle")
  expect(markers[1]).toContain("bg-success")
  expect(markers[2]).toContain("bg-danger")
  expect(markers[3]).toContain("bg-warn")
  expect(html).toContain("11-16 11:00 dash.tlmStatusFailed (tls)")
  expect(html).not.toContain("%")
})

const top = (over: Partial<TelemetryTop> = {}): TelemetryTop => ({
  metric: "proxy.sent_bytes", unit: "bytes", groupBy: "user", from: "a", to: "b", previousFrom: "c", previousTo: "d", total: 100e9,
  rows: [{ key: "#1", value: 60e9, share: 0.6, previous: 30e9, change: 1 }, { key: "", value: 20e9, share: 0.2, previous: 0, change: null }], otherCurrent: 20e9, otherShare: 0.2, ...over,
})

test("the top table shows labelled groups with value, share and change, the empty group and the remainder", () => {
  const html = renderToStaticMarkup(<TopPanel top={top()} settings={{ labels: { user: { "#1": "MacBook" } } }} groupBy="user" />)
  expect(html).toContain("MacBook")
  expect(html).toContain("60 GB")
  expect(html).toContain("60.0%")
  expect(html).toContain("+100%")
  expect(html).toContain("dash.tlmNoGroup")
  expect(html).toContain("dash.tlmOtherLabel")
  expect(html).toContain("—")
  expect(renderToStaticMarkup(<TopPanel top={null} settings={{}} groupBy="" />)).toContain("dash.tlmTopPick")
  expect(renderToStaticMarkup(<TopPanel top={top({ rows: [], total: 0, otherCurrent: 0, otherShare: 0 })} settings={{}} groupBy="user" />)).toContain("dash.tlmNoData")
})

test("flagged hours list surges with ratio and contributors and non-zero hours with their breakdown", () => {
  const html = renderToStaticMarkup(<FlaggedPanel units={{ "nic.tx_bytes": "bytes", "probe.fail": "count" }} settings={{ labels: { user: { "#1": "MacBook" } } }} summary={summary({
    surges: [{ metric: "nic.tx_bytes", hour: "2026-11-16T11:00:00Z", value: 5e9, baseline: 1e9, ratio: 5, contributors: [{ dims: { user: "#1" }, value: 4e9 }] }],
    flags: [{ metric: "probe.fail", hour: "2026-11-16T09:00:00Z", total: 1, breakdown: [{ dims: { stage: "tls" }, value: 1 }] }],
  })} />)
  expect(html).toContain("dash.tlmSurges")
  expect(html).toContain("5 GB")
  expect(html).toContain("×5.0")
  expect(html).toContain("user=MacBook")
  expect(html).toContain("dash.tlmNonZero")
  expect(html).toContain("stage=tls")
  expect(renderToStaticMarkup(<FlaggedPanel units={{}} settings={{}} summary={summary()} />)).toContain("dash.tlmNoFlags")
})

const noop = () => {}
const settingsProps = (over: Partial<SettingsPanelProps> = {}): SettingsPanelProps => ({
  form: settingsToForm({}, null), name: "trojan-vm", busy: false, error: "", saved: false, invalidField: null, onField: noop, onName: noop, onSave: noop,
  onRename: noop, onRotate: noop, onDelete: noop, ...over,
})

test("the settings panel has every setting, rename, rotate and delete, and marks an invalid field", () => {
  const html = renderToStaticMarkup(<SettingsPanel {...settingsProps()} />)
  for (const field of SETTINGS_FIELDS) expect(html).toContain(field.labelKey)
  expect(html).toContain("dash.save")
  expect(html).toContain("dash.tlmRename")
  expect(html).toContain("dash.tlmRotate")
  expect(html).toContain("dash.delete")
  expect(renderToStaticMarkup(<SettingsPanel {...settingsProps({ invalidField: "surgeFactor" })} />)).toContain('aria-invalid="true"')
  expect(renderToStaticMarkup(<SettingsPanel {...settingsProps({ saved: true })} />)).toContain("dash.tlmSettingsSaved")
  expect(renderToStaticMarkup(<SettingsPanel {...settingsProps({ error: "dash.tlmError" })} />)).toContain('role="alert"')
})

test("every settings label exists in English and Chinese", () => {
  for (const language of ["en", "zh"] as const) {
    const restore = installDictionary(language)
    try {
      const html = renderToStaticMarkup(<SettingsPanel {...settingsProps()} />)
      expect(html).not.toContain("dash.tlm")
    } finally { restore() }
  }
})
```

(`SettingsPanel` calls `t(field.labelKey)`; with a dictionary installed an unknown key would remain as the raw `dash.tlm...` string, which is what the last test catches.)

- [ ] **Step 9: Write the panels**

`apps/dashboard/src/tabs/telemetry/Panels.tsx`:

```tsx
import { useId } from "react"
import type { CheckStatus, TelemetryBudget, TelemetrySettings, TelemetrySummary, TelemetryTop, TelemetryUnit } from "../../api/telemetry"
import { useT } from "../../state/i18n"
import { Badge } from "../../ui/badge"
import { Card, SectionHeading } from "../../ui/card"
import { cn } from "../../ui/cn"
import { Meter } from "../../ui/meter"
import { Notice } from "../../ui/notice"
import { Table, TBody, Td, Th } from "../../ui/table"
import {
  CHECK_SENTENCE_KEYS, STATUS_KEYS, budgetView, dimsLabel, formatChange, formatShare, formatValue, freshnessNotices, groupLabel, hourRange, hourShort, statusTone,
} from "./telemetry-format"

const money = (value: number | null) => value === null ? "—" : `$${value.toFixed(2)}`

export function FreshnessPanel({ summary }: { summary: TelemetrySummary | null }) {
  const t = useT()
  const titleId = useId()
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmFreshness")}</SectionHeading>
    {summary === null ? <p className="text-body text-fg-subtle">{t("dash.loadingShort")}</p> : <>
      <p className="text-body text-fg-muted">
        {summary.freshness.lastPushAt ? t("dash.tlmLastPush", { at: new Date(summary.freshness.lastPushAt).toLocaleString() }) : t("dash.tlmNeverPushed")}
      </p>
      {freshnessNotices(summary).map(notice => notice.kind === "stale"
        ? <Notice key="stale" tone="warn" role="status">{t("dash.tlmStaleWarning", { n: notice.hours })}</Notice>
        : <Notice key={`no-check-${notice.metric}`} tone="warn" role="status">{t("dash.tlmNoCheckWarning", { range: hourRange(notice.hour) })}</Notice>)}
      {summary.checks.map(check => <p key={check.metric} className="flex flex-wrap items-center gap-2 text-body text-fg-muted">
        <Badge tone={statusTone(check.status)}>{t(STATUS_KEYS[check.status])}</Badge>
        <span>{t(CHECK_SENTENCE_KEYS[check.status], { range: hourRange(check.hour) })}{check.status === "failed" && check.stage ? ` ${t("dash.tlmCheckStage", { stage: check.stage })}` : ""}</span>
      </p>)}
    </>}
  </Card>
}

export function BudgetPanel({ budget }: { budget: TelemetryBudget | null }) {
  const t = useT()
  const titleId = useId()
  const view = budget ? budgetView(budget) : null
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmBudget")}</SectionHeading>
    {budget === null || view === null ? <p className="text-body text-fg-subtle">{t("dash.tlmBudgetUnset")}</p> : <>
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-body text-fg-muted">
        <span>{t("dash.tlmMtd")}: <b className="text-fg">{formatValue(budget.mtd, budget.unit)}</b></span>
        <span>{t("dash.tlmProjection")}: <b className="text-fg">{formatValue(budget.projection, budget.unit)}</b></span>
        {budget.monthlyLimit !== null ? <span>{t("dash.tlmMonthlyLimit")}: <b className="text-fg">{formatValue(budget.monthlyLimit, budget.unit)}</b></span> : null}
      </div>
      {view.percent !== null ? <>
        <Meter percent={view.percent} tone={view.tone} />
        <p className="text-xs text-fg-subtle">{t("dash.tlmPercentOfLimit", { p: view.percent.toFixed(1) })}</p>
      </> : null}
      {view.over && budget.projectionPercent !== null ? <Notice tone="danger">{t("dash.tlmOverLimit", { p: budget.projectionPercent.toFixed(0) })}</Notice> : null}
      {budget.cost ? <p className="text-body text-fg-muted">{t("dash.tlmCost", { mtd: money(budget.cost.mtd), projection: money(budget.cost.projection) })}</p> : null}
    </>}
  </Card>
}

const MARKER_CLASS: Record<CheckStatus, string> = { passed: "bg-success", failed: "bg-danger", "no check": "bg-warn", "not monitored": "bg-fg-subtle/30" }

/** One marker per hour; a check is one point in time, so it is never summarised as a percentage. */
export function CheckStrip({ hours, statuses, stages }: { hours: string[]; statuses: CheckStatus[]; stages: Array<string | null> }) {
  const t = useT()
  return <div className="space-y-2">
    <div role="list" className="flex flex-wrap gap-0.5">
      {hours.map((hour, index) => {
        const status = statuses[index] ?? "not monitored"
        const label = `${hourShort(hour)} ${t(STATUS_KEYS[status])}${stages[index] ? ` (${stages[index]})` : ""}`
        return <span key={hour} role="listitem" aria-label={label} title={label} data-status={status} className={cn("h-5 w-2 rounded-sm", MARKER_CLASS[status])} />
      })}
    </div>
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
      {(Object.keys(STATUS_KEYS) as CheckStatus[]).map(status => <li key={status} className="flex items-center gap-1">
        <span aria-hidden="true" className={cn("inline-block h-3 w-2 rounded-sm", MARKER_CLASS[status])} />{t(STATUS_KEYS[status])}
      </li>)}
    </ul>
  </div>
}

export function TopPanel({ top, settings, groupBy }: { top: TelemetryTop | null; settings: TelemetrySettings; groupBy: string }) {
  const t = useT()
  const titleId = useId()
  const none = t("dash.tlmNoGroup")
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmTop")}</SectionHeading>
    {groupBy === "" ? <p className="text-body text-fg-subtle">{t("dash.tlmTopPick")}</p>
      : top === null ? <p className="text-body text-fg-subtle">{t("dash.loadingShort")}</p>
      : top.rows.length === 0 && top.total === 0 ? <p className="text-body text-fg-subtle">{t("dash.tlmNoData")}</p>
      : <Table label={t("dash.tlmTop")}>
        <thead><tr><Th>{t("dash.tlmColGroup")}</Th><Th numeric>{t("dash.tlmColValue")}</Th><Th numeric>{t("dash.tlmColShare")}</Th><Th numeric>{t("dash.tlmColChange")}</Th></tr></thead>
        <TBody>
          {top.rows.map(row => <tr key={row.key}>
            <Td>{groupLabel(settings, groupBy, row.key, none)}</Td><Td numeric>{formatValue(row.value, top.unit)}</Td>
            <Td numeric>{formatShare(row.share)}</Td><Td numeric>{formatChange(row.change)}</Td>
          </tr>)}
          {top.otherCurrent > 0 ? <tr>
            <Td>{t("dash.tlmOtherLabel")}</Td><Td numeric>{formatValue(top.otherCurrent, top.unit)}</Td><Td numeric>{formatShare(top.otherShare)}</Td><Td numeric>—</Td>
          </tr> : null}
        </TBody>
      </Table>}
  </Card>
}

export function FlaggedPanel({ summary, settings, units }: { summary: TelemetrySummary | null; settings: TelemetrySettings; units: Record<string, TelemetryUnit> }) {
  const t = useT()
  const titleId = useId()
  const surges = summary?.surges ?? []
  const flags = summary?.flags ?? []
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmFlagged")}</SectionHeading>
    {summary === null ? <p className="text-body text-fg-subtle">{t("dash.loadingShort")}</p>
      : surges.length === 0 && flags.length === 0 ? <p className="text-body text-fg-subtle">{t("dash.tlmNoFlags")}</p> : <>
      {surges.length ? <>
        <SectionHeading as="h3">{t("dash.tlmSurges")}</SectionHeading>
        <Table label={t("dash.tlmSurges")}>
          <thead><tr>
            <Th>{t("dash.tlmColHour")}</Th><Th>{t("dash.tlmMetric")}</Th><Th numeric>{t("dash.tlmColValue")}</Th><Th numeric>{t("dash.tlmColBaseline")}</Th>
            <Th numeric>{t("dash.tlmColRatio")}</Th><Th>{t("dash.tlmColContributors")}</Th>
          </tr></thead>
          <TBody>{surges.map(surge => <tr key={`${surge.metric}-${surge.hour}`}>
            <Td>{hourShort(surge.hour)}</Td><Td>{surge.metric}</Td><Td numeric>{formatValue(surge.value, units[surge.metric] ?? null)}</Td>
            <Td numeric>{formatValue(surge.baseline, units[surge.metric] ?? null)}</Td><Td numeric>{surge.ratio === null ? "—" : `×${surge.ratio.toFixed(1)}`}</Td>
            <Td>{surge.contributors.map(c => `${dimsLabel(settings, c.dims)} (${formatValue(c.value, units[surge.metric] ?? null)})`).join("; ")}</Td>
          </tr>)}</TBody>
        </Table>
      </> : null}
      {flags.length ? <>
        <SectionHeading as="h3">{t("dash.tlmNonZero")}</SectionHeading>
        <Table label={t("dash.tlmNonZero")}>
          <thead><tr><Th>{t("dash.tlmColHour")}</Th><Th>{t("dash.tlmMetric")}</Th><Th numeric>{t("dash.tlmColTotal")}</Th><Th>{t("dash.tlmColBreakdown")}</Th></tr></thead>
          <TBody>{flags.map(flag => <tr key={`${flag.metric}-${flag.hour}`}>
            <Td>{hourShort(flag.hour)}</Td><Td>{flag.metric}</Td><Td numeric>{formatValue(flag.total, units[flag.metric] ?? null)}</Td>
            <Td>{flag.breakdown.map(entry => dimsLabel(settings, entry.dims)).join("; ")}</Td>
          </tr>)}</TBody>
        </Table>
      </> : null}
    </>}
  </Card>
}
```

`apps/dashboard/src/tabs/telemetry/ChartPanel.tsx`:

```tsx
import { useId } from "react"
import type { TelemetryMetricInfo, TelemetrySeries, TelemetrySettings } from "../../api/telemetry"
import { TimeSeriesChart, paletteFor } from "../../components/TimeSeriesChart"
import { useT } from "../../state/i18n"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import { SegmentedControl, type SegmentedOption } from "../../ui/segmented-control"
import { Select } from "../../ui/select"
import { CheckStrip } from "./Panels"
import { chartFromSeries, formatValue, type RangeId } from "./telemetry-format"

export interface ChartPanelProps {
  metrics: TelemetryMetricInfo[]
  metric: string
  range: RangeId
  groupBy: string
  series: TelemetrySeries | null
  settings: TelemetrySettings
  surgeHours: ReadonlySet<string>
  dark: boolean
  /** An already translated message. */
  error: string
  onMetric: (metric: string) => void
  onRange: (range: RangeId) => void
  onGroupBy: (groupBy: string) => void
}

export function ChartPanel(props: ChartPanelProps) {
  const t = useT()
  const titleId = useId()
  const { metrics, metric, series, settings } = props
  const isCheck = (settings.checkMetrics ?? []).includes(metric)
  const dims = metrics.find(info => info.metric === metric)?.dims ?? []
  const ranges: Array<SegmentedOption<RangeId>> = [
    { value: "24h", label: t("dash.tlmRange24h") }, { value: "7d", label: t("dash.tlmRange7d") }, { value: "30d", label: t("dash.tlmRange30d") },
  ]
  const chart = series && !isCheck ? chartFromSeries({
    series, settings, groupBy: props.groupBy, palette: paletteFor(props.dark ? "dark" : "light"), totalLabel: t("dash.tlmTotal"),
    otherLabel: t("dash.tlmOtherLabel"), noneLabel: t("dash.tlmNoGroup"), surgeHours: props.surgeHours,
  }) : null
  return <Card aria-labelledby={titleId} className="space-y-3">
    <SectionHeading id={titleId}>{t("dash.tlmChart")}</SectionHeading>
    {metrics.length === 0 ? <p className="text-body text-fg-subtle">{t("dash.tlmNoMetrics")}</p> : <>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={metric} ariaLabel={t("dash.tlmMetric")} size="sm" onChange={props.onMetric}
          options={metrics.map(info => ({ value: info.metric, label: info.metric }))} />
        {isCheck ? null : <Select value={props.groupBy} ariaLabel={t("dash.tlmGroupBy")} size="sm" onChange={props.onGroupBy}
          options={[{ value: "", label: t("dash.tlmGroupNone") }, ...dims.map(dim => ({ value: dim, label: dim }))]} />}
        <SegmentedControl options={ranges} value={props.range} onChange={props.onRange} ariaLabel={t("dash.tlmRangeLabel")} size="sm" />
      </div>
      {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
      {series === null ? <p className="text-body text-fg-subtle">{t("dash.loadingShort")}</p>
        : isCheck ? <CheckStrip hours={series.hours} statuses={series.statuses ?? series.hours.map(() => "not monitored" as const)} stages={series.stages ?? []} />
        : chart ? <TimeSeriesChart labels={chart.labels} datasets={chart.datasets} height={280} yTickFormat={value => formatValue(value, series.unit)} /> : null}
    </>}
  </Card>
}
```

`apps/dashboard/src/tabs/telemetry/SettingsPanel.tsx`:

```tsx
import { useId } from "react"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { Card, SectionHeading } from "../../ui/card"
import { Notice } from "../../ui/notice"
import type { SettingsForm } from "./telemetry-settings-form"

export const SETTINGS_FIELDS: Array<{ key: keyof SettingsForm; labelKey: string; area?: boolean }> = [
  { key: "budgetMetric", labelKey: "dash.tlmSetBudgetMetric" },
  { key: "monthlyLimit", labelKey: "dash.tlmSetMonthlyLimit" },
  { key: "pricePerGB", labelKey: "dash.tlmSetPricePerGB" },
  { key: "freeGB", labelKey: "dash.tlmSetFreeGB" },
  { key: "surgeMetrics", labelKey: "dash.tlmSetSurgeMetrics" },
  { key: "surgeFactor", labelKey: "dash.tlmSetSurgeFactor" },
  { key: "surgeMinGB", labelKey: "dash.tlmSetSurgeMinGB" },
  { key: "surgeMinCount", labelKey: "dash.tlmSetSurgeMinCount" },
  { key: "flagNonZeroMetrics", labelKey: "dash.tlmSetFlagMetrics" },
  { key: "checkMetrics", labelKey: "dash.tlmSetCheckMetrics" },
  { key: "staleAfterHours", labelKey: "dash.tlmSetStaleAfter" },
  { key: "labels", labelKey: "dash.tlmSetLabels", area: true },
]

export interface SettingsPanelProps {
  form: SettingsForm
  name: string
  busy: boolean
  /** An already translated message. */
  error: string
  saved: boolean
  invalidField: keyof SettingsForm | null
  onField: (field: keyof SettingsForm, value: string) => void
  onName: (value: string) => void
  onSave: () => void
  onRename: () => void
  onRotate: () => void
  onDelete: () => void
}

export function SettingsPanel(props: SettingsPanelProps) {
  const t = useT()
  const titleId = useId()
  const { form, busy } = props
  return <Card aria-labelledby={titleId} className="space-y-4">
    <SectionHeading id={titleId}>{t("dash.tlmSettings")}</SectionHeading>
    <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); props.onRename() }}>
      <input type="text" value={props.name} maxLength={64} aria-label={t("dash.tlmName")} disabled={busy} onChange={event => props.onName(event.target.value)} />
      <Button type="submit" variant="secondary" size="sm" disabled={busy || props.name.trim() === ""}>{t("dash.tlmRename")}</Button>
    </form>
    <form className="space-y-3" onSubmit={event => { event.preventDefault(); props.onSave() }}>
      <div className="grid gap-3 sm:grid-cols-2">
        {SETTINGS_FIELDS.map(field => <label key={field.key} className={`block text-xs font-medium text-fg-muted ${field.area ? "sm:col-span-2" : ""}`}>
          {t(field.labelKey)}
          {field.area
            ? <textarea value={form[field.key]} rows={4} spellCheck={false} disabled={busy} aria-invalid={props.invalidField === field.key ? "true" : undefined}
              className="mt-1 w-full font-mono text-xs" onChange={event => props.onField(field.key, event.target.value)} />
            : <input type="text" value={form[field.key]} disabled={busy} aria-invalid={props.invalidField === field.key ? "true" : undefined}
              className="mt-1 w-full" onChange={event => props.onField(field.key, event.target.value)} />}
        </label>)}
      </div>
      <p className="text-xs text-fg-subtle">{t("dash.tlmSetLabelsHint")}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={busy}>{busy ? t("dash.savingShort") : t("dash.save")}</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={props.onRotate}>{t("dash.tlmRotate")}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={props.onDelete} className="text-danger hover:text-danger">{t("dash.delete")}</Button>
      </div>
    </form>
    {props.saved ? <Notice tone="success" role="status">{t("dash.tlmSettingsSaved")}</Notice> : null}
    {props.error ? <Notice tone="danger">{props.error}</Notice> : null}
  </Card>
}
```

- [ ] **Step 10: Write the page container and wire it in**

`apps/dashboard/src/tabs/telemetry/SourcePage.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useState } from "react"
import {
  deleteTelemetrySource, rotateTelemetryKey, telemetryMetrics, telemetrySeries, telemetrySummary, telemetryTop, updateTelemetrySource,
  type TelemetryMetricInfo, type TelemetrySeries, type TelemetrySource, type TelemetrySummary, type TelemetryTop, type TelemetryUnit,
} from "../../api/telemetry"
import { useConfirm } from "../../state/confirm"
import { useT } from "../../state/i18n"
import { Button } from "../../ui/button"
import { PageHeader } from "../../ui/page-header"
import { ChartPanel } from "./ChartPanel"
import { BudgetPanel, FlaggedPanel, FreshnessPanel, TopPanel } from "./Panels"
import { SettingsPanel } from "./SettingsPanel"
import { IssuedKeyPanel, type CopyTarget, type IssuedKeyView } from "./SourceList"
import { telemetryErrorKey } from "./telemetry-errors"
import { defaultMetric, rangeWindow, type RangeId } from "./telemetry-format"
import { formToSettings, settingsToForm, type SettingsForm } from "./telemetry-settings-form"

export function SourcePage({ source, onBack, onSourceChanged, onDeleted }: {
  source: TelemetrySource
  onBack: () => void
  onSourceChanged: (source: TelemetrySource) => void
  onDeleted: () => void
}) {
  const t = useT()
  const confirm = useConfirm()
  const [summary, setSummary] = useState<TelemetrySummary | null>(null)
  const [metrics, setMetrics] = useState<TelemetryMetricInfo[]>([])
  const [metric, setMetric] = useState("")
  const [range, setRange] = useState<RangeId>("24h")
  const [groupBy, setGroupBy] = useState("")
  const [series, setSeries] = useState<TelemetrySeries | null>(null)
  const [top, setTop] = useState<TelemetryTop | null>(null)
  const [error, setError] = useState("")
  const [tick, setTick] = useState(0)

  const budgetUnit: TelemetryUnit | null = metrics.find(info => info.metric === source.settings.budgetMetric)?.unit ?? null
  const [form, setForm] = useState<SettingsForm>(() => settingsToForm(source.settings, null))
  const [name, setName] = useState(source.name)
  const [invalidField, setInvalidField] = useState<keyof SettingsForm | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [settingsError, setSettingsError] = useState("")
  const [issued, setIssued] = useState<IssuedKeyView | null>(null)
  const [copied, setCopied] = useState<CopyTarget | null>(null)

  useEffect(() => { setForm(settingsToForm(source.settings, budgetUnit)); setName(source.name) }, [source, budgetUnit])

  useEffect(() => {
    let live = true
    Promise.all([telemetrySummary(source.id), telemetryMetrics(source.id)]).then(([nextSummary, nextMetrics]) => {
      if (!live) return
      setSummary(nextSummary)
      setMetrics(nextMetrics.metrics)
      setMetric(current => nextMetrics.metrics.some(info => info.metric === current) ? current : defaultMetric(nextMetrics.metrics, source.settings))
      setError("")
    }).catch(() => { if (live) setError(t("dash.tlmLoadError")) })
    return () => { live = false }
  }, [source.id, source.settings, tick, t])

  useEffect(() => {
    if (metric === "") return
    let live = true
    const span = rangeWindow(range, Date.now())
    setSeries(null)
    telemetrySeries(source.id, { metric, ...span, groupBy: groupBy || undefined, top: 10 })
      .then(next => { if (live) setSeries(next) }).catch(() => { if (live) setError(t("dash.tlmLoadError")) })
    setTop(null)
    if (groupBy !== "") {
      telemetryTop(source.id, { metric, ...span, groupBy, limit: 20 })
        .then(next => { if (live) setTop(next) }).catch(() => { if (live) setError(t("dash.tlmLoadError")) })
    }
    return () => { live = false }
  }, [source.id, metric, range, groupBy, tick, t])

  // A dim that the newly chosen metric lacks cannot stay selected.
  const dims = useMemo(() => metrics.find(info => info.metric === metric)?.dims ?? [], [metrics, metric])
  useEffect(() => { if (groupBy !== "" && !dims.includes(groupBy)) setGroupBy("") }, [dims, groupBy])

  const units = useMemo(() => Object.fromEntries(metrics.map(info => [info.metric, info.unit])) as Record<string, TelemetryUnit>, [metrics])
  const surgeHours = useMemo(() => new Set((summary?.surges ?? []).filter(surge => surge.metric === metric).map(surge => surge.hour)), [summary, metric])
  const dark = typeof document !== "undefined" && document.documentElement.getAttribute("data-theme") !== "light"

  const save = async () => {
    // The limit is read in the unit of the metric typed in the form (decimal GB for bytes).
    const result = formToSettings(form, metrics.find(info => info.metric === form.budgetMetric.trim())?.unit ?? null)
    if (!result.ok) { setInvalidField(result.field); setSettingsError(t("dash.tlmSettingsInvalid")); setSaved(false); return }
    setBusy(true); setInvalidField(null); setSettingsError(""); setSaved(false)
    try {
      onSourceChanged((await updateTelemetrySource(source.id, { settings: result.settings })).source)
      setSaved(true)
      setTick(value => value + 1)
    } catch (failure) { setSettingsError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const rename = async () => {
    setBusy(true); setSettingsError("")
    try { onSourceChanged((await updateTelemetrySource(source.id, { name: name.trim() })).source) }
    catch (failure) { setSettingsError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const rotate = async () => {
    const sure = await confirm({ title: t("dash.tlmRotateConfirmTitle", { name: source.name }), description: t("dash.tlmRotateConfirmHint"), confirmLabel: t("dash.tlmRotate"), danger: true })
    if (!sure) return
    setBusy(true); setSettingsError(""); setCopied(null)
    try {
      const result = await rotateTelemetryKey(source.id)
      setIssued({ sourceName: source.name, key: result.key, install: result.install })
    } catch (failure) { setSettingsError(t(telemetryErrorKey(failure))) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    const sure = await confirm({ title: t("dash.tlmDeleteConfirmTitle", { name: source.name }), description: t("dash.tlmDeleteConfirmHint"), confirmLabel: t("dash.delete"), danger: true })
    if (!sure) return
    setBusy(true); setSettingsError("")
    try { await deleteTelemetrySource(source.id); onDeleted() }
    catch (failure) { setSettingsError(t(telemetryErrorKey(failure))); setBusy(false) }
  }
  const refresh = useCallback(() => setTick(value => value + 1), [])

  return <div className="space-y-4">
    <PageHeader title={source.name} description={t("dash.telemetryDescription")} actions={<>
      <Button variant="secondary" size="sm" onClick={refresh}>{t("dash.tlmRefresh")}</Button>
      <Button variant="ghost" size="sm" onClick={onBack}>{t("dash.tlmBack")}</Button>
    </>} />
    <FreshnessPanel summary={summary} />
    <BudgetPanel budget={summary?.budget ?? null} />
    <ChartPanel metrics={metrics} metric={metric} range={range} groupBy={groupBy} series={series} settings={source.settings} surgeHours={surgeHours} dark={dark}
      error={error} onMetric={setMetric} onRange={setRange} onGroupBy={setGroupBy} />
    <TopPanel top={top} settings={source.settings} groupBy={groupBy} />
    <FlaggedPanel summary={summary} settings={source.settings} units={units} />
    {issued ? <IssuedKeyPanel issued={issued} copied={copied} onDismiss={() => { setIssued(null); setCopied(null) }}
      onCopy={async what => {
        try { await navigator.clipboard.writeText(what === "install" ? issued.install : issued.key); setCopied(what) }
        catch { setSettingsError(t("dash.tlmCopyError")) }
      }} /> : null}
    <SettingsPanel form={form} name={name} busy={busy} error={settingsError} saved={saved} invalidField={invalidField}
      onField={(field, value) => { setForm(current => ({ ...current, [field]: value })); setSaved(false) }} onName={setName}
      onSave={() => void save()} onRename={() => void rename()} onRotate={() => void rotate()} onDelete={() => void remove()} />
  </div>
}
```

Replace `apps/dashboard/src/tabs/telemetry/TelemetryTab.tsx`:

```tsx
import { useState } from "react"
import type { TelemetrySource } from "../../api/telemetry"
import { useT } from "../../state/i18n"
import { PageHeader } from "../../ui/page-header"
import { SourceListSection } from "./SourceList"
import { SourcePage } from "./SourcePage"

/** The selected source is component state: the hash router has a single segment. */
export function TelemetryTab() {
  const t = useT()
  const [selected, setSelected] = useState<TelemetrySource | null>(null)
  if (selected) {
    return <SourcePage source={selected} onBack={() => setSelected(null)} onSourceChanged={setSelected} onDeleted={() => setSelected(null)} />
  }
  return <div>
    <PageHeader title={t("dash.telemetry")} description={t("dash.telemetryDescription")} />
    <SourceListSection onOpen={setSelected} />
  </div>
}
```

- [ ] **Step 11: Add the remaining copy (EN and ZH)**

In `packages/gateway/src/shared/edge/ui-pages/i18n.ts`, insert directly after the English line `      "dash.tlmCopyError": "Could not copy. Select the text and copy it by hand.",`:

```ts
      "dash.tlmBack": "All sources",
      "dash.tlmRefresh": "Refresh",
      "dash.tlmFreshness": "Freshness",
      "dash.tlmStaleWarning": "No data for {n} hours — the VM may be stopped or the agent failing.",
      "dash.tlmNoCheckWarning": "No check during {range} — the VM may be down or the agent not running.",
      "dash.tlmCheckPassed": "One check during {range}: passed (this reflects only the moment of the check).",
      "dash.tlmCheckFailed": "One check during {range}: failed.",
      "dash.tlmCheckStage": "Failing stage: {stage}.",
      "dash.tlmCheckNoCheck": "No check was recorded during {range}.",
      "dash.tlmCheckNotMonitored": "{range} is before the first check, so it was not monitored.",
      "dash.tlmStatusPassed": "passed",
      "dash.tlmStatusFailed": "failed",
      "dash.tlmStatusNoCheck": "no check",
      "dash.tlmStatusNotMonitored": "not monitored",
      "dash.tlmBudget": "Month to date",
      "dash.tlmBudgetUnset": "Choose a budget metric in the settings to see month-to-date usage and a projection.",
      "dash.tlmMtd": "Month to date",
      "dash.tlmProjection": "Projected month end",
      "dash.tlmMonthlyLimit": "Monthly limit",
      "dash.tlmPercentOfLimit": "{p}% of the limit so far",
      "dash.tlmOverLimit": "The projection is {p}% of the limit.",
      "dash.tlmCost": "Cost: {mtd} so far, about {projection} by month end.",
      "dash.tlmChart": "Hourly",
      "dash.tlmMetric": "Metric",
      "dash.tlmRangeLabel": "Time range",
      "dash.tlmRange24h": "24 hours",
      "dash.tlmRange7d": "7 days",
      "dash.tlmRange30d": "30 days",
      "dash.tlmGroupBy": "Split by",
      "dash.tlmGroupNone": "No split",
      "dash.tlmTotal": "Total",
      "dash.tlmOtherLabel": "(other)",
      "dash.tlmNoData": "No data for this range.",
      "dash.tlmNoMetrics": "No metrics yet. Data appears after the first push.",
      "dash.tlmTop": "Top",
      "dash.tlmTopPick": "Pick a dimension to split by to see the top groups.",
      "dash.tlmColGroup": "Group",
      "dash.tlmColValue": "Value",
      "dash.tlmColShare": "Share",
      "dash.tlmColChange": "Change vs previous period",
      "dash.tlmNoGroup": "(none)",
      "dash.tlmFlagged": "Flagged hours",
      "dash.tlmSurges": "Surges",
      "dash.tlmNonZero": "Non-zero hours",
      "dash.tlmColHour": "Hour (UTC)",
      "dash.tlmColBaseline": "Baseline",
      "dash.tlmColRatio": "Ratio",
      "dash.tlmColContributors": "Top contributors",
      "dash.tlmColBreakdown": "Breakdown",
      "dash.tlmColTotal": "Total",
      "dash.tlmNoFlags": "Nothing flagged in the last 7 days.",
      "dash.tlmSettings": "Settings",
      "dash.tlmRename": "Rename",
      "dash.tlmSetBudgetMetric": "Budget metric",
      "dash.tlmSetMonthlyLimit": "Monthly limit (GB for byte metrics)",
      "dash.tlmSetPricePerGB": "Price per GB",
      "dash.tlmSetFreeGB": "Free GB per month",
      "dash.tlmSetSurgeMetrics": "Surge metrics (default: all)",
      "dash.tlmSetSurgeFactor": "Surge factor (default 3)",
      "dash.tlmSetSurgeMinGB": "Surge minimum for byte metrics (GB, default 2.15)",
      "dash.tlmSetSurgeMinCount": "Surge minimum for count metrics (default 1000)",
      "dash.tlmSetFlagMetrics": "Flag any non-zero hour of",
      "dash.tlmSetCheckMetrics": "Single-check metrics (1 = passed)",
      "dash.tlmSetStaleAfter": "Stale after (hours, default 2)",
      "dash.tlmSetLabels": "Display names",
      "dash.tlmSetLabelsHint": "Lists take metric names separated by commas. Display names: one per line as dimension:value=Name, for example user:#1=MacBook.",
      "dash.tlmSettingsSaved": "Settings saved.",
      "dash.tlmSettingsInvalid": "A value is not valid. Check the highlighted field.",
```

and directly after the Chinese line `      "dash.tlmCopyError": "无法复制。请选中文本后手动复制。",`:

```ts
      "dash.tlmBack": "全部来源",
      "dash.tlmRefresh": "刷新",
      "dash.tlmFreshness": "数据新鲜度",
      "dash.tlmStaleWarning": "已有 {n} 小时没有数据——机器可能已停机，或代理出现故障。",
      "dash.tlmNoCheckWarning": "{range} 内没有检查记录——机器可能已宕机，或代理没有运行。",
      "dash.tlmCheckPassed": "{range} 内的一次检查：通过（仅代表检查那一刻的状态）。",
      "dash.tlmCheckFailed": "{range} 内的一次检查：失败。",
      "dash.tlmCheckStage": "失败阶段：{stage}。",
      "dash.tlmCheckNoCheck": "{range} 内没有记录到检查。",
      "dash.tlmCheckNotMonitored": "{range} 早于第一次检查，因此未监控。",
      "dash.tlmStatusPassed": "通过",
      "dash.tlmStatusFailed": "失败",
      "dash.tlmStatusNoCheck": "无检查",
      "dash.tlmStatusNotMonitored": "未监控",
      "dash.tlmBudget": "本月累计",
      "dash.tlmBudgetUnset": "在设置中选择预算指标，即可查看本月累计用量和预测。",
      "dash.tlmMtd": "本月累计",
      "dash.tlmProjection": "预计月底用量",
      "dash.tlmMonthlyLimit": "月度上限",
      "dash.tlmPercentOfLimit": "已达上限的 {p}%",
      "dash.tlmOverLimit": "预测用量为上限的 {p}%。",
      "dash.tlmCost": "费用：目前 {mtd}，月底约 {projection}。",
      "dash.tlmChart": "按小时",
      "dash.tlmMetric": "指标",
      "dash.tlmRangeLabel": "时间范围",
      "dash.tlmRange24h": "24 小时",
      "dash.tlmRange7d": "7 天",
      "dash.tlmRange30d": "30 天",
      "dash.tlmGroupBy": "拆分维度",
      "dash.tlmGroupNone": "不拆分",
      "dash.tlmTotal": "合计",
      "dash.tlmOtherLabel": "（其他）",
      "dash.tlmNoData": "此范围内没有数据。",
      "dash.tlmNoMetrics": "还没有指标。首次推送后会出现数据。",
      "dash.tlmTop": "排行",
      "dash.tlmTopPick": "选择一个拆分维度即可查看排行。",
      "dash.tlmColGroup": "分组",
      "dash.tlmColValue": "数值",
      "dash.tlmColShare": "占比",
      "dash.tlmColChange": "较上一周期的变化",
      "dash.tlmNoGroup": "（无）",
      "dash.tlmFlagged": "标记的小时",
      "dash.tlmSurges": "激增",
      "dash.tlmNonZero": "非零小时",
      "dash.tlmColHour": "小时（UTC）",
      "dash.tlmColBaseline": "基线",
      "dash.tlmColRatio": "倍数",
      "dash.tlmColContributors": "主要贡献者",
      "dash.tlmColBreakdown": "明细",
      "dash.tlmColTotal": "合计",
      "dash.tlmNoFlags": "最近 7 天没有标记。",
      "dash.tlmSettings": "设置",
      "dash.tlmRename": "重命名",
      "dash.tlmSetBudgetMetric": "预算指标",
      "dash.tlmSetMonthlyLimit": "月度上限（字节类指标按 GB）",
      "dash.tlmSetPricePerGB": "每 GB 单价",
      "dash.tlmSetFreeGB": "每月免费 GB",
      "dash.tlmSetSurgeMetrics": "激增检测指标（默认全部）",
      "dash.tlmSetSurgeFactor": "激增倍数（默认 3）",
      "dash.tlmSetSurgeMinGB": "字节类指标的激增下限（GB，默认 2.15）",
      "dash.tlmSetSurgeMinCount": "计数类指标的激增下限（默认 1000）",
      "dash.tlmSetFlagMetrics": "任何非零小时都标记的指标",
      "dash.tlmSetCheckMetrics": "单次检查指标（1 表示通过）",
      "dash.tlmSetStaleAfter": "停滞阈值（小时，默认 2）",
      "dash.tlmSetLabels": "显示名称",
      "dash.tlmSetLabelsHint": "列表项用逗号分隔指标名。显示名称：每行一条，格式为 维度:值=名称，例如 user:#1=MacBook。",
      "dash.tlmSettingsSaved": "设置已保存。",
      "dash.tlmSettingsInvalid": "有数值无效，请检查高亮的字段。",
```

- [ ] **Step 12: Run the dashboard tests and typecheck**

```bash
bun test ./apps/dashboard/src ./packages/gateway/tests/i18n-keys.test.ts ./packages/gateway/tests/i18n-interpolation.test.ts
bun run --filter '@vibe-llm/dashboard' typecheck
bun run lint
```

Expected: PASS. The `every settings label exists in English and Chinese` test fails if any `dash.tlmSet*` key is missing from either dictionary. `bun run build:ui` (part of `ci:local`) also type-checks and bundles the page, run it in Task 15.

- [ ] **Step 13: Commit**

```bash
git add apps/dashboard/src/api/telemetry.ts apps/dashboard/src/components/TimeSeriesChart.tsx apps/dashboard/src/components/TimeSeriesChart.test.ts \
  apps/dashboard/src/tabs/telemetry/telemetry-format.ts apps/dashboard/src/tabs/telemetry/telemetry-format.test.ts \
  apps/dashboard/src/tabs/telemetry/telemetry-settings-form.ts apps/dashboard/src/tabs/telemetry/telemetry-settings-form.test.ts \
  apps/dashboard/src/tabs/telemetry/Panels.tsx apps/dashboard/src/tabs/telemetry/ChartPanel.tsx apps/dashboard/src/tabs/telemetry/SettingsPanel.tsx \
  apps/dashboard/src/tabs/telemetry/panels.test.tsx apps/dashboard/src/tabs/telemetry/SourcePage.tsx apps/dashboard/src/tabs/telemetry/TelemetryTab.tsx \
  packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "$(cat <<'EOF'
feat(telemetry): add the source page with freshness, budget, chart, top table, flags and settings

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```


## Task 15: Documentation and full verification

**Files:**
- Create: `docs/telemetry-v1.md`

- [ ] **Step 1: Write the documentation**

`docs/telemetry-v1.md`:

````markdown
# Telemetry v1

External systems push hourly metrics to the gateway with a push-only key; the gateway stores them as a generic time series and shows freshness, month-to-date usage with a projection, hourly charts, top groups, surges, failure flags and single-check results in the dashboard. The first source is a trojan proxy VM, served by an agent in `tools/trojan-telemetry/`. Nothing is sent from the gateway: no email, no chat message. Set a billing-accurate budget alert in your cloud account as well.

Telemetry is owner-only. Sources, data and settings are visible to and manageable by the owning user; administrators get no override (`404 source_not_found`). Configuration export and import never include telemetry. Do not confuse it with the gateway's internal request-usage recording, which is unrelated.

## Data model

A point is `{ metric, hour, dims?, value, unit }`.

| Field | Rule |
| --- | --- |
| `metric` | `^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$`, 1..64 characters |
| `hour` | ISO 8601 UTC at the top of an hour, `2026-11-16T13:00:00Z` |
| `dims` | object of 0..3 entries; keys `^[a-z][a-z0-9_]{0,31}$`, values strings of 1..256 characters |
| `value` | finite number, 0 to 1e15 |
| `unit` | `bytes`, `count` or `ms` |

Tables `telemetry_sources` (`id` `tls_` + 32 hex, owner, name, SHA-256 of the key, settings JSON, `created_at`, `last_push_at`) and `telemetry_points` (`source_id`, `metric`, `hour` in unix seconds, canonical `dims_key`, `dims_json`, `value`, `unit`; primary key `(source_id, metric, hour, dims_key)`). The key is `tlm_` + 64 hex, shown once at creation or rotation; only its hash is stored.

Retention (scheduled maintenance task `telemetry_retention`): points with dims 90 days, points without dims 400 days. Deleting a source removes only its row; its points are purged by scheduled maintenance shortly after (at most 20 delete statements per sweep, so a large purge spans several sweeps).

## Push API

`POST /api/telemetry/push` with `Authorization: Bearer tlm_<64 hex>` (scheme case-insensitive) and `{ "version": 1, "points": [...] }`. It is mounted before session auth and the key can do nothing else: every other route answers a `tlm_` credential with `401 invalid_key`.

- Authentication happens before the body is read. A missing, malformed, unknown or deleted-source key and a disabled owner all answer `401 { "error": { "code": "invalid_key" } }`.
- Body at most 2 MiB (`413 body_too_large`); at most 20 000 points, 20 distinct metrics and 168 distinct hours; one unit per metric per body; no duplicate (metric, hour, dims); unknown fields rejected; a point older than its retention or more than one hour in the future is rejected. Every failure is `400 invalid_request`. An empty `points` is a valid heartbeat that only stamps `last_push_at`.
- Every distinct (metric, hour) in the body is replaced atomically: its existing rows are deleted and the pushed rows inserted in one transaction, so retries and recomputation never double-count and a dimension value that left a top N does not linger.
- `200 { "accepted": <points> }`; all responses carry `Cache-Control: no-store`; bodies and headers are not logged.

## Management and query API

Session-guarded (a real `ses_` session; a `key` query parameter is refused), owner-only.

- `GET /api/telemetry/sources` returns `{ sources: [{ id, name, createdAt, lastPushAt, settings }] }`.
- `POST /api/telemetry/sources` with `{ name }` (1..64) returns `201 { source, key, install }`. The request must be HTTPS (`400 https_required`); at most 16 sources per owner (`409 source_limit`). `install` is the ready-to-run install command for this gateway origin and key.
- `PATCH /api/telemetry/sources/{id}` with `{ name?, settings? }`; `settings` replaces the whole object (strict schema, at most 32 KiB).
- `POST /api/telemetry/sources/{id}/rotate-key` returns `{ key, install }` (HTTPS required); the old key stops working at once.
- `DELETE /api/telemetry/sources/{id}` returns `{ sources }`.
- `GET .../metrics` lists metrics with unit, first and last hour over the last 30 days and the dim keys seen in the 24 hours before each metric's newest hour.
- `GET .../series?metric=&from=&to=&groupBy=&top=` returns dense hourly `total` and, with `groupBy`, one line per group (`top` 1..20, default 10) plus one `(other)` group for the remainder merged with any real `(other)` group. Rows lacking the `groupBy` key form the group `""`. For a `checkMetrics` metric it also returns `statuses` and `stages` aligned to `hours`.
- `GET .../top?metric=&from=&to=&groupBy=&limit=` returns the top groups (`limit` 1..100, default 20) with `share` of all groups, the previous period (the equal-length window before `from`) and `change` (`null` when the previous value is 0), plus `otherCurrent`.
- `GET .../summary` returns freshness, the budget block, surges, non-zero flags and the latest check results.

`from` is inclusive and `to` exclusive, both hour-aligned ISO; the default is the last 24 hours through the current hour; the window is at most 90 days.

## Settings

| Setting | Meaning | Default |
| --- | --- | --- |
| `budgetMetric` | metric for month-to-date and projection | none |
| `monthlyLimit` | limit in the metric's unit (the form takes decimal GB for byte metrics) | none |
| `pricePerGB`, `freeGB` | cost conversion for `bytes` metrics, decimal GB (1e9 bytes) | none |
| `surgeMetrics` | metrics checked for surges (at most 10) | all metrics except `ms`, summed over dims |
| `surgeFactor` | multiple of baseline | 3 |
| `surgeMinBytes`, `surgeMinCount` | minimum hourly value to flag | 2 GiB, 1000 |
| `flagNonZeroMetrics` | metrics where any non-zero hour is flagged (at most 20), for example `probe.fail` | none |
| `checkMetrics` | single point-in-time checks, 1 = passed, 0 = failed (at most 20), for example `probe.ok` | none |
| `labels` | display names per dim key and value, `{ "user": { "#1": "MacBook" } }` | none |
| `staleAfterHours` | freshness warning threshold | 2 |

## Analysis semantics

- **Month to date** sums the budget metric over all dims from the UTC month start through the current hour. **Projection** = month to date + the average daily total of the last 7 complete UTC days (only days on or after the first day with data) x the fractional days left in the month. **Cost** = max(0, GB - freeGB) x pricePerGB, null for non-byte metrics or without a price.
- **Surge**: for each surge metric (summed over dims) and each hour of the last 7 days, baseline = the average hourly value over the preceding 168 hours (hours without data count as 0). An hour is flagged when `value >= surgeFactor x baseline` and `value >=` the minimum for its unit. An hour is judged only when the metric has at least 24 hours of history before it, so the backfill after a fresh install is not flagged. `ms` metrics are never checked. At most 20 surges are reported, each with its top 5 dim contributions.
- **Non-zero flags**: every hour in which a `flagNonZeroMetrics` metric (summed over dims) is above zero, with its dim breakdown (the failing probe stage), for at most 50 hours.
- **Point-in-time checks** are per hour `passed` (value > 0), `failed` (value = 0), `no check` (no point at or after the metric's first point) or `not monitored` (before the first point). `no check` is a warning: the VM may be down or the agent not running. When the latest closed hour has no check the dashboard shows that warning next to any staleness warning. No uptime or availability percentage is ever computed: one check per hour says nothing about the rest of the hour.
- **Freshness**: stale when `now - last_push_at` is strictly greater than `staleAfterHours`; a source that never pushed is not stale.

## The trojan agent

`tools/trojan-telemetry/trojan-telemetry.py` (Python 3, standard library only) runs as root from a systemd timer (`OnCalendar=*-*-* *:05:00`, `Persistent=true`) with a non-blocking file lock (a second run exits 0 at once).

Configuration `/etc/trojan-telemetry.env` (mode 600; values single-quoted): `TELEMETRY_GATEWAY`, `TELEMETRY_KEY`, `TROJAN_CONTAINER` (default `trojan`), `TELEMETRY_IFACE` (default `eth0`), `TROJAN_USERS` (ordered user hashes, mapped to `#1`, `#2`...), `TROJAN_CONFIG`, `TOP_DOMAINS` (default 50), `TROJAN_SNI` (default `trojan.xianliao.de5.net`), `PROBE_HOST` (default: the SNI host, resolved by DNS), `PROBE_PORT` (default 443), `PROBE_TARGET` (default `www.gstatic.com:80`), `PROBE_TIMEOUT` (default 15 seconds). Variables already in the environment win over the file.

State `/var/lib/trojan-telemetry/`: `cursor.json` (the last fully processed hour), `outbox/<YYYY-MM-DDTHH>.json` (computed, unpushed hours), `outbox/<YYYY-MM-DDTHH>.probe.json` (the probe result of that hour) and `lock`.

Each run:

1. **Compute** every closed hour in `(cursor, lastClosed]` (a first run backfills 24 hours; a cursor older than 30 days is clamped to 30 days). `docker logs --since/--until` for the hour yields `user <hash> ... tunneling to <host>:<port> closed sent: <n> <unit> recv: <n> <unit>` lines (units are 1024-based; traffic is attributed to the hour in which the connection closed), aggregated by user and registrable domain into `proxy.sent_bytes`, `proxy.recv_bytes` (bytes) and `proxy.connections` (count). The top `TOP_DOMAINS` domains per user are kept and the rest folded into `(other)`. `vnstat --json h -i IFACE` yields `nic.tx_bytes` and `nic.rx_bytes` (no dims); JSON v1 counts KiB and v2 bytes; hours are VM-local time converted to UTC; vnstat may lag up to 5 minutes, which the `:05` offset absorbs. Every hour writes an outbox file, even with no points. A docker or vnstat failure stops the loop without advancing the cursor and makes the run exit 1; a missing vnstat row for an hour is not a failure.
2. **Probe** once: TCP to the proxy, TLS with the configured SNI (certificate verified), a trojan request with the first configured password to `PROBE_TARGET`, then `GET /generate_204`, expecting `204` within the timeout. Metrics `probe.ok` (1 or 0), `probe.fail` (1, dim `stage` = `tcp`, `tls`, `tunnel`, `http` or `timeout`) and `probe.latency_ms` (successful probes). The result belongs to the hour containing the run and is its own outbox file; a second probe in the same hour replaces the first. A past hour cannot be probed. The password never leaves the VM. A failed probe is data, not a failed run.
3. **Push** outbox files oldest first in batches of at most 24 hours, 10 000 points and 1.5 MiB (an hour is never split). Each batch's files are deleted after a `200`; the first failure stops the push and the run exits 1 so `systemctl status` shows it. Files older than 30 days are discarded unpushed. Because any non-200 stops the push, a permanently rejected file blocks later hours until it is removed by hand.

User mapping: `TROJAN_USERS` wins; otherwise the sha224 hex of each `password` entry of the trojan-go JSON config, in file order. The config is `TROJAN_CONFIG`, else a bind mount of the container found with `docker inspect`, else `/etc/trojan-go/config.json`, then `/etc/trojan/config.json`. An unknown hash is `#?`.

Registrable domain heuristic (no public suffix list): IP literals are kept; otherwise the last 2 labels, or the last 3 when the TLD is two letters and the second label is a generic second-level label (`com`, `co`, `net`, `org`, `gov`, `edu`, `ac`, `or`, `ne`, `go`, `mil`, `ltd`, `plc`, `nhs`, `sch`, `nom`). Longer public suffixes (for example `foo.pvt.k12.ma.us`) group one level too coarse.

Hours missed because of a stop or a failed push are recomputed or re-pushed when the VM returns, as long as the logs and vnstat history still hold them: give the trojan container log rotation (`json-file`, `max-size: 200m`, `max-file: 5`). The installer warns when it is missing; changing the trojan deployment is a separate, manual step.

## Install, rotate and remove

Create a source on the dashboard's Telemetry page (over HTTPS) and run the command it shows once on the VM:

```bash
curl -fsSL https://github.com/xuangong/copilot-api-gateway/releases/download/telemetry-agent-v<version>/install.sh | sudo TELEMETRY_GATEWAY='https://gateway.example' TELEMETRY_KEY='tlm_...' bash
```

The installer downloads the same version, verifies `trojan-telemetry.py` against `SHA256SUMS` (a mismatch aborts before anything is installed), installs `vnstat` with apt when missing, installs the agent under `/opt/trojan-telemetry/`, writes the env file (mode 600), the state directory and the systemd service and timer, runs the agent once and prints the push result, warns when the container has no log rotation and reminds you that the key sits in your shell history and the process list. Rotate it on the dashboard and run the installer again with the new key if that matters; optional settings already in the env file are kept unless overridden. Remove it with `... | sudo bash -s -- --uninstall` (add `--purge` to delete the state too).

## Releases

A GitHub Actions workflow builds a release when a tag `telemetry-agent-v<semver>` is pushed: it checks the tag against `tools/trojan-telemetry/VERSION`, the agent's `AGENT_VERSION` and the gateway's `TELEMETRY_AGENT_VERSION` (`packages/gateway/src/control-plane/telemetry/agent-release.ts`), runs the Python tests, builds `trojan-telemetry.py`, a version-stamped `install.sh` and `SHA256SUMS` with `build-release.sh`, and publishes them. The dashboard's install command pins the version the gateway was built with, so a new agent version means bumping all three sources together and deploying the gateway.

## Rollout

1. Merge, push, apply the D1 migration `0026_telemetry.sql`, deploy the Worker.
2. Publish `telemetry-agent-v1.0.0` (the owner confirms before the tag is pushed).
3. Create the source "trojan-vm" on the dashboard and run its install command on the VM.
4. Add log rotation to the trojan compose file and recreate the container (the owner confirms; a few seconds of proxy downtime).
5. Configure budget metric `nic.tx_bytes`, the monthly limit, price, user labels, `flagNonZeroMetrics: ["probe.fail"]` and `checkMetrics: ["probe.ok"]`.

## Out of scope

Notifications, sources declaring their own views, sub-hourly data, pulling from sources and editing the trojan deployment from the installer.
````

- [ ] **Step 2: Re-check the lockfile and name collisions**

```bash
git diff --quiet cf94bd93 -- bun.lock && echo unchanged
grep -rnE "TelemetrySource|TelemetryPoint|TelemetryRepo|telemetry_sources|telemetry_points|/api/telemetry|control-plane/telemetry|TELEMETRY_AGENT|dash\.telemetry|dash\.tlm" --include='*.ts' --include='*.tsx' --include='*.sql' packages apps | grep -v node_modules | grep -vE "control-plane/telemetry/|repo/(shared/)?telemetry\.ts|tests/telemetry-|tabs/telemetry/|api/telemetry\.ts|ui-pages/i18n\.ts|migrations/0026|schema-baseline|bun-sqlite-repo|d1-repo|repo/(types|index)\.ts|shared/repos\.ts|app\.ts|control-plane/routes\.ts|control-plane-auth|App\.tsx|navigation|maintenance\.ts|auth/routes\.ts|session-auth" | head
```

Expected: `unchanged`, and the second command prints nothing: every hit is inside a file this plan created or edited. Also run `git status --short` and confirm the only untracked paths are the files this plan created plus the untouched `docs/loki-safety-check-2026-11-14.md`.

- [ ] **Step 3: Run every telemetry test**

```bash
bun test ./packages/gateway/tests/telemetry-repo.sqlite.test.ts ./packages/gateway/tests/telemetry-repo.d1.test.ts ./packages/gateway/tests/telemetry-push.test.ts \
  ./packages/gateway/tests/telemetry-sources.test.ts ./packages/gateway/tests/telemetry-agent-release.test.ts ./packages/gateway/tests/telemetry-analysis.test.ts \
  ./packages/gateway/tests/telemetry-queries.test.ts ./packages/gateway/tests/telemetry-retention.test.ts ./packages/gateway/tests/telemetry-agent-release-consistency.test.ts \
  ./packages/gateway/tests/telemetry-e2e.test.ts ./packages/gateway/tests/migrations.test.ts ./packages/gateway/tests/control-plane-auth.test.ts
bun test ./apps/dashboard/src
bun run test:agent
```

Expected: all pass.

- [ ] **Step 4: Run the full gate and compare with the baseline**

Run: `bun run ci:local 2>&1 | tee /tmp/telemetry-ci.log`
Expected: framework purity, typecheck, lint, the dashboard build and the Cloudflare dry run pass; `bun test` reports only the known baseline failures (11 pre-existing: provider-cancellation-forwarding, the respond-json JSON fallback and terminal tests, and the `docs/superpowers/research` harness tests) plus, intermittently, `apps/platform-cloudflare/src/setup-leases.d1.test.ts`. List the failing test names (`grep -E "^\(fail\)" /tmp/telemetry-ci.log | sort -u`) and confirm none is in a file this plan touched. Any other failure is a regression: fix it before finishing. If `ci:prepare` needs network access that is unavailable, run the remaining steps of `ci:local` individually (`bun run build:ui`, `bun run scripts/check-framework-purity.ts`, `bun run typecheck`, `bun test`, `bun run test:agent`, `bun run lint`, `bun run --filter '@vibe-llm/platform-cloudflare' deploy:dry`) and say so in the hand-off.

- [ ] **Step 5: Commit**

```bash
git add docs/telemetry-v1.md
git commit -m "$(cat <<'EOF'
docs(telemetry): document the telemetry protocol, analysis, agent and rollout

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

Do not push, tag or create a release. Hand the branch back with this note for the owner: after merge, the rollout steps in `docs/telemetry-v1.md` (apply `0026`, deploy, publish `telemetry-agent-v1.0.0`, install on the VM, add log rotation, configure settings) are theirs to confirm and run.

## Self-review against the spec

| Spec requirement | Task |
| --- | --- |
| Generic hourly series, push not pull, hour replacement, dashboard only, owner-only, push-only key | 1, 2, 3, 13 |
| Data model rules, tables, retention 90/400 days, delete cascades, key format `tlm_` + 64 hex shown once | 1, 2, 3, 6 |
| Push API: bearer, uniform 401, `tlm_` rejected elsewhere, 2 MiB, 20 000 points, age and future limits, duplicate rejection, atomic replacement, `last_push_at`, `{accepted}`, `no-store` | 1, 2 |
| Management API: list, create (`install`), 16 limit, PATCH, rotate, DELETE, session-guarded owner-only 404 | 3 |
| Query API: metrics, series (dense, top N, `(other)`), top (previous period, change), summary | 4, 5 |
| Settings table (all keys including `flagNonZeroMetrics`, `checkMetrics`, `labels`, `staleAfterHours`) | 2 (schema), 3, 14 (form) |
| Month to date, projection, cost; surge incl. 24 h history rule; non-zero flags; check statuses (four, `no check` warns, `not monitored` neutral); freshness | 4, 5 |
| Dashboard: sources list with stale badge, create with one-time key and Copy, source page panels 1 to 6, EN and ZH, units | 13, 14 |
| Latest-closed-hour `no check` warning alongside staleness; markers green, red, amber, neutral; never a percentage | 4, 5, 14 |
| Agent: env config, state dir, compute, probe stages and metrics, push batches, discard, exit codes, lock | 7, 8, 9 |
| Distribution: tag `telemetry-agent-v<semver>`, assets, installer steps, checksum abort, key reminder, log-rotation warning, uninstall, pinned version | 3, 10, 11 |
| Testing list (gateway SQLite and D1, agent, e2e, dashboard, acceptance `ci:local`) | 1 to 15 |
| Rollout steps | 15 (documented, owner-confirmed, not performed) |

Checks run while writing: every code step is complete code or an exact edit; no "similar to Task N"; names are consistent (`telemetry` repo property, `TelemetryRepo`, `telemetryClock`, `requireBrowserSessionAllowingQuery`, `plan_batches`, `run_probe`, `STATUS_KEYS`). Differences from the research decisions are listed in the hand-off, not hidden here.
