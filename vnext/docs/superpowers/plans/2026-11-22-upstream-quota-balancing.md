# Upstream Quota Balancing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner group Copilot upstreams so that new sessions are spread by projected month-end share of each account's own allowance, keep prompt-cache hits high by sticking to one member per session, read GitHub's quota endpoint rarely (adaptive estimator, reads only per the floors), cut a member off at the hard line through an upstream-protection pause, and show everything on the Upstreams page. Source of truth: `vnext/docs/superpowers/specs/2026-11-22-upstream-quota-balancing-design.md`.

**Architecture:** One neutral module `packages/gateway/src/quota-balance/` (pure estimator, read scheduler, selection and session-key modules; per-isolate caches for the group directory, member facts and session assignments; a cost tracker, a quota reader with an injected fetcher, hard-line cut-off, a sweep) sits on a new `QuotaBalanceRepo` (`repo/quota-balance.ts` interface, `repo/shared/quota-balance.ts` SQL shared by D1 and bun:sqlite, migration `0028_upstream_quota_balancing.sql`). Group membership is the column `upstreams.group_id`, read only through the quota repo; routing orders a group as one item through a cached directory in `registry.ts`, and `select-binding.ts` / `resolveBinding` reorder the candidates of a group dynamically (fail-open). Session identity is derived once per request in the HTTP handlers (before `prompt_cache_key` is stripped) and carried as `auth.balanceSession`. Cost is recorded next to `repo.usage.record` for group members only, in the background. The hard line reuses protection pauses (`trigger: "quota"`). A session-guarded owner-only API feeds the dashboard (group card as one reorderable item, live quota, refresh/calibrate, settings, banner).

**Tech Stack:** Bun + TypeScript monorepo (`vnext/`), Hono, zod, Cloudflare Worker + D1 (`apps/platform-cloudflare`), Bun + SQLite (`apps/platform-bun`), shared code `packages/gateway`, React dashboard (`apps/dashboard`), `bun test`.

---

## Conventions used by every task

- All commands run from `/Users/xian/projects/copilot-api-gateway/vnext` unless a `cd` is shown. Never run plain `bun install` (it rewrites `bun.lock` to a registry mirror).
- Test: `bun test <path>` for the listed files only. The whole repository `bun test` is SIGKILLed for memory; run tests per file or per package directory (`bun test packages/gateway/tests/<file>`). Known baseline failures that are not ours: respond-json "JSON terminal/fallback preserves serialization errors" (2), "Custom caller disconnect closes the real upstream localhost socket", and 8 `docs/superpowers/research` harness tests.
- Gateway typecheck: `bun run --filter '@vibe-llm/gateway' typecheck` (if it complains about missing setup assets run `bun run build:setup` once). Dashboard typecheck: `bun run --filter '@vibe-llm/dashboard' typecheck`. Lint: `bunx eslint <paths>`.
- Commit: `git add <listed paths>` then `git commit -m "<subject>" -m "Co-Authored-By: Claude <noreply@anthropic.com>"`. Never stage `vnext/docs/loki-safety-check-2026-11-14.md`.
- DLP: never paste keys, tokens or hashes into tests, fixtures, logs or this plan. Tests use obviously fake placeholders (`fake_github_token_a`, `up_test_*`, `key_test_*`, `ug_` + 32 hex of one repeated digit).
- Import boundaries (eslint `import/no-restricted-paths`): `data-plane` must not import `control-plane`; `repo/` and `shared/` must not import either plane. `src/quota-balance/` is a neutral directory both planes may import; it may import `repo/` and `protection/`, never a plane. `repo/` must not import `quota-balance/` (group settings defaults and the lenient parser live in `repo/quota-balance.ts`).
- Test IDs and shapes: fake upstreams `up_test_*`, fake keys `key_test_*`, group ids `ug_` followed by 32 hex digits (`"ug_" + "1".repeat(32)`).
- **Percentages only.** Every comparison between members is a comparison of shares (a member's used amount divided by that member's own latest entitlement). No code or test compares absolute used amounts across members; the estimator, the selection, the thresholds and the dashboard bars are all in shares.

## Decisions (choices the spec leaves open)

- **D1 Membership is a column, group data is cached outside the configuration snapshot.** `upstreams.group_id TEXT NULL` (migration 0028) is read and written only by `QuotaBalanceRepo`; `UpstreamRecord`, the `configuration_upstreams_update` trigger and the sync documents stay untouched (grouping is device-local like `enabled`/`sortOrder`). Groups (`upstream_groups`) and memberships are served to the data plane by `GroupDirectoryCache` (per isolate, 10 s TTL, stale-while-refresh, fail-open to "no groups", like `ProtectionRuntime.activePauses`). Changes made through the API patch the local isolate at once; other isolates see them within the TTL. The dashboard list DTO merges `groupId`.
- **D2 A group is one routing item.** `listVisibleUpstreams` sorts by an effective item key: an ungrouped upstream uses its own `(sortOrder, createdAt, id)`; a member uses its group's `(sortOrder, createdAt, id)` and members of one group stay contiguous, ordered by their own `(createdAt, id)`. With a per-key whitelist the whitelist order replaces this as today and the balancer (D7) moves the whole group to the position of its first whitelisted member. Groups and upstreams share one `sort_order` number space per owner; the dashboard reorders both with one `ReorderController`.
- **D3 Shares, not amounts.** `share = used ÷ entitlement` using each read's own entitlement; the estimator state is `k` (share per gateway USD), `o` (share per hour), the last read's share and the gateway cost counters. The displayed "used / entitlement" is `estimatedShare × latest entitlement`. `used` from GitHub is `entitlement − remaining` (may exceed the entitlement when overage is permitted). Unlimited snapshots give share 0 and never trigger lines.
- **D4 Entitlement changes (owner clarification).** A read whose entitlement differs (relative 1e-6) from the previous read's: the interval spanning it is not used (no `k`, `o` or prediction error from it), the learning window restarts at that read, `k` and `o` are rescaled by `old ÷ new` and `kSamples` restarts at 0 (conservative bias again), the next read interval is reset to the 1 h minimum, and `entitlement_from/to/changed_at` are stored and exposed ("entitlement changed from X to Y"). Shares always use the latest read's entitlement.
- **D5 Cost recording.** `upstream_quota_state` carries `cost_total_usd` (cumulative), `cost_at_read_usd` (the total at the last read), `month_key` and `month_cost_usd`; `upstream_cost_buckets` holds 10-minute buckets for the burn rate. One `UPDATE` plus one upsert (plus one `UPDATE` of the session row) go in one `batch`, scheduled with `scheduleBackground`, only when the upstream is a group member (the directory is cached, so non-members cost nothing). Gateway cost since a read is `cost_total_usd − cost_at_read_usd` (O(1) row), the burn rate is an exponentially weighted sum over the buckets of the last 3 hours with a 1 h time constant. This avoids a month-to-date scan of `usage` (only hour indexes exist) and any `exp()` in SQL.
- **D6 Session identity plumbing.** HTTP handlers (`chat-completions`, `messages`, `responses`, `gemini`, and the Responses WebSocket turn) call `withBalanceSession(auth, protocol, raw, headers)` right after parsing the body, which sets `auth.balanceSession = { input, assigned? }`. `input` holds plain strings (explicit id or system+first-user fingerprint); SHA-256 runs lazily in the balancer only when a group is present. The serve layers forward `balanceSession`; `kitDeps.buildTelemetryCtx` copies it to `telemetryCtx.quotaSession`, which is how `recordUsage` attributes cost to a session.
- **D7 Balancer position.** `selectBindingForProtocol` calls `QuotaBalance.balance(...)` on `enumeration.candidates` before `selectAffinityCandidate` and `commit(upstreamId)` once the first candidate is materialised, so the stored assignment is the member the request was dispatched to (there is no cross-member retry after dispatch: a member that then fails the request keeps the session, and the next request sees the failure through the usual protection pause or cut-off; a new session is created before dispatch only when its group is first in the order, otherwise at commit, in the background). Balancing failures are fail-open (original order). `resolveBinding` (embeddings, images, decision, count tokens) balances per request with no session and writes no assignment (least-projected choice inside the tolerance band, random tie-break). Other `enumerateBindingCandidates` callers (alpha search) are not balanced (known limit: they ignore the soft line; docs task). Sessionless `messages_count_tokens` calls through `resolveBinding` ignore the soft line (D32).
- **D8 Bypasses.** Pinned requests (`up_<id>/<model>`), requests with affinity route constraints (`affinity.analysis.hasRouteConstraints`) skip balancing and touch no assignment. A group with a single eligible candidate skips only the ranking: the soft line (no new session at or above `softShare` unless the policy is `overage`) and the hard line (cut-off members are not candidates) still apply, so "eligible" for a new session already excludes members at or above the soft line. Because affinity-constrained requests never reach the balancer, "affinity-bound sessions are never moved" holds by construction.
- **D9 Eligibility.** A member is a group candidate only when `enumerateBindingCandidates` returned it (visible, enabled, serves the model, allowed by the key whitelist, not protection-paused or cut off). Members without any read are not eligible for new sessions (assignments that already exist stay). A disabled group drops all its candidates (it is not an "exhausted" skip). Under `stop`, members at or above `softShare` take no new sessions; under `overage` the soft line is ignored.
- **D10 `group_quota_exhausted`.** The existing `upstream-paused` selection kind gains an optional `code`; the four attempts render `code: sel.code ?? 'upstream_paused'`, `pausedBody`/`UpstreamPausedError` accept the new code. `Retry-After` is the earliest of the next 00:00 UTC on the 1st and the earliest end of a protection pause among the request's paused candidates. The group name is shown only to the group's owner; others get "an upstream group".
- **D11 Hard cut-off reuses protection pauses.** `PauseReason.trigger` gains `"quota"` plus an optional `quota` object (`groupId`, `groupName`, `share`, `hardShare`, `source`, `provisional`); the flood fields are zero. `ProtectionRuntime.insertExternal` inserts and patches the local cache. `pausedRoute` and the dashboard summary branch on `trigger`. A real read below `hardShare` resolves an active quota pause (`resolved_by: 'auto'`); an owner resume suppresses a provisional (estimate) cut-off until the next real read; a real read at or above the line cuts again. `ends_at` is the next 00:00 UTC on the 1st, so the member returns at the reset by expiry.
- **D12 Where evaluation runs.** `QuotaReader.evaluateMember` runs from the minute sweep (backstop) and, throttled to once per 60 s per member per isolate, from the cost tracker right after a cost is recorded (prompt reaction to the soft/hard lines). Scheduled, join and monthly reads are capped at 2 per sweep (stagger); early triggers are not capped but obey the floors.
- **D13 Reader is injected.** `QuotaReader` takes `fetcherFor(upstreamId)`; `maintenance.ts` and the API wire `resolveControlPlaneFetcher({ upstreamId, runtimeLocation })` (the upstream's own proxy chain) and use `config.githubToken` / `config.githubHost` of the Copilot upstream row. The call is `fetchCopilotUser(token, host, fetcher)` with a 15 s timeout. Only `provider === "copilot"` rows can join a group.
- **D14 Read recording is two steps.** `recordRead` stores the read (the cost total is captured by `INSERT … SELECT` in the same batch that moves the state's base) so no cost is lost between the two; `saveEstimatorState` then writes `k`, `o`, interval and `next_read_at` from the pure `learn`. Between the steps the estimate uses the new base with the previous `k`/`o`.
- **D15 Manual calibration.** `at` defaults to now and may be at most 24 h in the past; the cost snapshot of the read is back-adjusted by the bucketed cost since `at`. It counts as a read for learning and for the floor (10 minutes). `used`/`entitlement` or `usedShare` are accepted.
- **D16 Scheduling.** `next_read_at` is stored: `now + interval ± 30 min jitter`, capped at the next 00:00 UTC on the 1st plus 30–60 min (the first read after the reset). A new member gets `next_read_at = now` (read at the next sweep). A failed attempt counts toward the floor, sets `failures += 1` and `next_read_at = now + min(2^(failures-1) h, readIntervalHours)`. Floors are measured from `last_attempt_at`: 1 h scheduled/early, 10 min manual and page open.
- **D17 Estimator constants.** `K_QUANTILE = 0.25`, window 7 days, half-life 1 day (so a price change is absorbed in about 2 days of reads), intervals need Δcost ≥ $1, `MIN_K_SAMPLES = 3` (fewer: `max(k, fallback)`), `o` EWMA α = 0.5 over intervals of at least 0.5 h, burn time constant 1 h. The fallback `k` is the median `k` of group members with enough samples, else `DEFAULT_K_SHARE_PER_USD`, a deliberately high constant fixed from the Task 1 findings.
- **D18 Session touch interval.** `last_seen_at` is written at most every `min(10, idleRebalanceMinutes / 5)` minutes (spec said 10): the stored value lags the real last request by up to that interval, so a session can be judged idle up to `idleRebalanceMinutes / 5` early (a bounded, harmless early rebalance: with the default 10 minute threshold at most 2 minutes). The in-isolate cache holds the exact value.
- **D19 API.** Mounted at `/api/upstream-groups` and `/api/upstreams/:id/{group,quota/refresh,quota/calibrate}` behind `requireBrowserSession`, ownership through `loadOwned` (admins see all). An admin may add global upstreams to a group; everyone else only their own upstreams. `/api/upstream-groups` joins the paths for which `sessionAuthMiddleware` skips the Copilot-token prefetch (the dashboard polls it every minute).
- **D20 Dashboard ordering.** `ReorderController` becomes generic over `ReorderRow = { id; ownerId?; enabled; sortOrder }`; the page feeds it the ungrouped upstreams plus one pseudo-row per group (id `ug_…`), and its patch callback sends group ids to `PATCH /api/upstream-groups/:id`. Members are rendered inside the group card without drag handles.
- **D21 Live quota on the page.** Opening the page calls `POST /api/upstreams/:id/quota/refresh` for each member (the 10 minute manual floor makes a recent read a reuse: the response says `reused: true`). While the page is visible `GET /api/upstream-groups/:id/status` is polled every 60 s through `startPolling` (no GitHub reads).
- **D22 Banner.** A cut-off is a protection pause and already reaches the banner; `GET /api/upstream-groups/alerts` adds `stopped` and `overage` groups, polled with the protection store.
- **D23 Retention.** Hourly (at the telemetry orphan minute) or while a chunk was full: idle assignments (per group `sessionIdleHours`), reads older than 90 days, cost buckets older than 10 days, rows of deleted groups or upstreams; chunks of 5000, at most 10 statements per table.
- **D24 Not recorded or balanced in v1.** Non-Copilot upstreams cannot join. Costs of non-members are not tracked. `count_tokens` is balanced sessionless through `resolveBinding`.
- **D25 i18n.** Keys `dash.qb*`, EN and ZH in `shared/edge/ui-pages/i18n.ts`; text-xs minimum; times through `telemetry-format.ts` helpers.
- **D26 Unlimited.** An unlimited snapshot makes the member always eligible with share 0 and projected 0; no early triggers; scheduled reads continue at the normal interval to notice a plan change.
- **D28 Settings invariants (owner correction).** `softShare` must stay below `hardShare` (rejected). Lowering `softShare` below the stored `confirmShare` clamps `confirmShare` to `softShare` instead of rejecting (an explicitly submitted `confirmShare` above `softShare` is still rejected); the dashboard form (Task 18) must mirror this and not block on it.
- **D29 Review corrections to Tasks 7-9 and known limits.** (a) The owner-resume check applies to both cut-off sources: a read (or estimate) taken before an owner resume of a quota pause never cuts again. (b) A quota pause may coexist with a flood pause of the same upstream (`insertPauseIfNone` scopes its "already exists" test to quota rows for a quota insert; flood behaviour is unchanged); `lastOwnerResolvedQuotaAt` only sees owner resolves of quota rows, and `lastOwnerResolvedAt` ignores them. (c) A provisional cut-off confirmed by a real read is updated in place (`updatePauseReason`). (d) Real reads taken in the first 30 minutes after 00:00 UTC on the 1st never cut (the guard applies to `source: "real"` only; estimates already use the month-to-date basis), and `apply` throws when a real read comes without `readAt`. The first read of a month is due 30-60 minutes after the reset (the monthly trigger waits until 00:30 UTC; the monthly cap is the reset plus 30 minutes plus 0-30 minutes of jitter). (e) Failed member-facts loads: members with cached facts keep using them; members without are `unavailable` (eligible, ranked last, never the baseline or the source of a forced move), never skipped as a group. (f) A new session is inserted with `AssignmentStore.create` (`ON CONFLICT DO NOTHING` plus read-back: the stored member wins), moves use `AssignmentStore.move` (conditional on the previous member), and `AssignmentStore.get` returns `undefined` on a failed lookup: the balancer then chooses without writing an assignment. (g) Known limit: costs are not tracked while the group directory cache is down (non-members are not recorded either), so the estimate runs behind until the next real read.
- **D30 Read claim, fail-closed egress and quiet minutes (review of Tasks 10-12).** (a) Before any request leaves, `QuotaBalanceRepo.claimRead(upstreamId, now, floorMs, { intervalHours })` creates the state row of a member when missing and stamps `last_attempt_at = now` only when the previous attempt is at least `floorMs` ago (one atomic UPDATE; `floorMs` from `readFloorMs`: 10 min manual/page-open, else 1 h or the failure back-off). Only the winner fetches; calibration claims the same way. (b) The default quota fetcher factory throws "quota fetcher not configured" (recorded as a failed read; the global `fetch` is never used); the proxy-chain factory is registered by importing `control-plane/quota-balance/fetcher.ts` in the composition roots `app.ts` and `maintenance.ts`. A member without a saved chain is read directly only through that registered resolver (the Users page behaviour). (c) The fetcher receives an `AbortSignal` that fires after 15 s (`timeoutMs`), and the body of a non-OK response is cancelled unread; the stored error is a status, `timeout` or an error name, never a body. (d) Nothing is read in the first 30 minutes of a month: `join` waits for 00:30 UTC, and a read taken inside that window (page open, manual) is recorded but is not the month base (`memberEstimate` and `triggerOf` treat it like a previous-month read: the first read after 00:30, floor permitting, replaces it). (e) Cost is added to the isolate's facts only after the write succeeded. (f) The sweep first runs `hasEnabledGroups()` (one statement; with no enabled group a minute costs that and nothing else); retention runs in the hourly orphan minute and continues on following sweeps while a pass used a full chunk: a date-based backlog continues without the orphan scans, an orphan backlog (`deleteExpired(...).orphans`, the total of the orphan drains) with them.
- **D31 Skipped group: quota or unknown (Tasks 13-14).** A group is one routing item; when it cannot serve (no member serves the model, all members with a read at or above the soft line under `stop`, cut off or paused, no reads) it is skipped and matching continues with later items. `BalanceOutcome` reports `skipped` (every member with data is at the soft line: a quota statement) and `unknown` (no member has any data yet). Only when nothing in the whole order can serve and every skipped group was skipped for quota does the client get 503 `group_quota_exhausted` with Retry-After (the earlier of the next 1st 00:00 UTC and the end of a pause among the candidates). If any skipped group was `unknown`, the generic answer applies (chat: `no-eligible-binding`; `resolveBinding`: no binding), never a quota claim. Pins and affinity-constrained requests bypass balancing.
- **D32 Failing reads and count_tokens (review of Tasks 13-14).** A member that has had a successful read (GitHub or manual) at some time and whose reads keep failing (at least one failed attempt and either no successful read this month, or a failed last read that is older than two read intervals) stays eligible: its share is `failingEstimate` (facts.ts): k = max(the group's learned fallback k, `DEFAULT_K_SHARE_PER_USD`) (never its own, possibly low, k), plus its last known outside rate `o`, from the month's gateway cost when it has no read this month (errs high; the soft line applies). Because no real read protects such a member, when this estimate reaches `hardShare` it is cut off provisionally (`QuotaReader.evaluateMember`, `kLearned` not required, under `stop` and `overage` alike); the next successful read lifts or confirms it (D11), ranked by that projection, and flagged `readFailing` on its `MemberView` (`isReadFailing` in `facts.ts`) for the dashboard and banner. A member that was never attempted waits for its join read (D9). A member that was NEVER read successfully stays ineligible (`no_read`) until it is read or calibrated, even after failed join reads (a missing read must not look like 0 %); status and alerts flag it as `read_failing` with reason `never_read`. Final-review additions: membership changes keep the read throttle (only the estimate restarts), at most 12 GitHub reads per member per UTC day (manual exempt), joining needs a stored credential, members of a disabled group are still evaluated, the sweep has a 30 s budget and loads the pauses once, and the Task 1 scripts (`scripts/quota-spike.ts`, `scripts/quota-spike-redact.ts`) and the redaction test were removed (the parser and fixtures stay). Sessionless `messages_count_tokens` calls ignore the soft line (`ignoreSoftLine`: members with data ranked by projection, members without data last) because they consume no premium quota; embeddings, images and decisions keep it.
- **D33 Peer-seeded k (owner-approved follow-up).** A member whose own `k` is not learned (`kSamples < 3`) uses `seedKFor` (facts.ts) instead of the group-median / default fallback when a peer qualifies: another member of any group of the same owner (the GROUP's owner) with a learned `k`, the same latest entitlement, snapshot key and unit form (all known, not unlimited). Seed = MAX of the peers' learned `k` x `K_SEED_MARGIN` (1.2) (k is a low quantile and plans mix models, so the highest peer is the cautious choice). It feeds estimates, projections, soft-line eligibility and the status, but is NOT learned: the provisional cut-off still requires the member's own `kLearned` (`Estimate.kLearned` is computed from its own params). D32's failing estimate uses `max(group fallback, seed)` then `max(.., DEFAULT)`, so never below before. Own `k` takes over at 3 samples (below that `effectiveK` keeps `max(own, seed)`). Peers come from one query `QuotaBalanceRepo.listPlanFacts()` (grouped members joined to their group's owner, state and the latest read's snapshot key / unit form), cached in `MemberFactsCache.plans()` with the facts TTL (cold waits, stale served and refreshed in the background, failure keeps the previous answer or none = current fallback; `invalidate()` clears it). `MemberStatusDto.kSource` is `own | peer{peers} | default` (default also covers the group-median fallback); the dashboard member details line shows it (EN+ZH `dash.qbKOwn/qbKPeer/qbKDefault`). The seed also feeds `estimatedShareBefore` (and so the prediction error) and the `o` residual at read time, since both use the member's `kFallback`; the residual is only learned once own k is learned, so in practice it affects `estimatedShareBefore`. A member with 0 samples and a seed below the default stays under the soft line only while its seeded estimate is below `softShare` (pinned by a test). The status uses the cached plans (no forced reload).
- **D27 One provider-kind check.** "Is this row a Copilot row with a stored GitHub credential" lives in `quota-balance/credential.ts` (`isCopilotUpstream`, `copilotCredentialOf`); the reader and the routes call it. It adds one comparison to the architecture ratchet, whose limit is raised from 16 to 17 with its documented reason (Task 15).

## File structure

Create:

| File | Responsibility |
| --- | --- |
| ~~`scripts/quota-spike.ts`, `scripts/quota-spike-redact.ts`~~ | Task 1 diagnostic, removed in the final review (parser and fixtures stay) |
| `packages/gateway/tests/fixtures/copilot-quota/*.json` | Redacted response fixtures |
| `packages/gateway/migrations/0028_upstream_quota_balancing.sql` | `upstream_groups`, `upstreams.group_id`, `session_assignments`, `quota_reads`, `upstream_quota_state`, `upstream_cost_buckets` |
| `packages/gateway/src/repo/quota-balance.ts` | Types, settings defaults/limits, lenient parser, `QuotaBalanceRepo` |
| `packages/gateway/src/repo/shared/quota-balance.ts` | `SharedQuotaBalanceRepo` SQL for D1 and SQLite |
| `packages/gateway/src/quota-balance/snapshot.ts` | `parseQuotaSnapshot` |
| `packages/gateway/src/quota-balance/time.ts` | UTC month helpers |
| `packages/gateway/src/quota-balance/settings.ts` | strict `normalizeGroupSettings` |
| `packages/gateway/src/quota-balance/session-key.ts` | `deriveSessionInput`, `resolveSessionKey`, `newBalanceSession` |
| `packages/gateway/src/quota-balance/estimator.ts` | `estimateShare`, `burnRateUsdPerHour`, `projectShare`, `learn` |
| `packages/gateway/src/quota-balance/read-schedule.ts` | intervals, jitter, floors, backoff, `readDecision` |
| `packages/gateway/src/quota-balance/selection.ts` | rendezvous hash, `rankMembers`, `planGroupChoice`, `groupState` |
| `packages/gateway/src/quota-balance/deps.ts` | `QuotaDeps`, `scheduleBackground` re-export |
| `packages/gateway/src/quota-balance/directory.ts` | `GroupDirectoryCache` |
| `packages/gateway/src/quota-balance/assignments.ts` | `AssignmentStore` |
| `packages/gateway/src/quota-balance/facts.ts` | `MemberFactsCache`, `viewMembers` |
| `packages/gateway/src/quota-balance/cost-tracker.ts` | `QuotaCostTracker` |
| `packages/gateway/src/quota-balance/cutoff.ts` | `QuotaCutoff` (hard line through protection) |
| `packages/gateway/src/quota-balance/credential.ts` | `isCopilotUpstream`, `copilotCredentialOf` (the one provider-kind check) |
| `packages/gateway/src/quota-balance/reader.ts` | `QuotaReader` (read, calibrate, evaluate) |
| `packages/gateway/src/quota-balance/sweep.ts` | `sweepQuotaBalance`, `sweepQuotaRetention` |
| `packages/gateway/src/quota-balance/balance.ts` | `balanceCandidates` used by `QuotaBalance.balance` |
| `packages/gateway/src/quota-balance/runtime.ts` | `QuotaBalance` container, `getQuotaBalance`, `setQuotaBalanceForTests` |
| `packages/gateway/src/data-plane/chat-flow/shared/balance-session.ts` | `withBalanceSession` |
| `packages/gateway/src/control-plane/quota-balance/routes.ts`, `dto.ts` | API |
| `packages/gateway/tests/quota-*.ts(x)` | Tests listed per task |
| `apps/dashboard/src/api/upstream-groups.ts` | Typed API client |
| `apps/dashboard/src/state/upstream-groups.ts`, `group-items.ts`, `quota-format.ts` | Store, ordered items, number/time formatting |
| `apps/dashboard/src/tabs/upstreams/groups/*` | `GroupCard.tsx`, `MemberQuotaRow.tsx`, `GroupSettingsForm.tsx`, `CalibrateForm.tsx`, `group-form.ts`, `use-group-status.ts` |
| `docs/upstream-quota-balancing-v1.md` | Short reference |

Modify:

| File | Change |
| --- | --- |
| `packages/gateway/src/repo/types.ts` (Repo, ~L634), `repo/shared/repos.ts` (~L1462) | Add `quotaBalance` |
| `apps/platform-bun/src/bun-sqlite-repo.ts`, `apps/platform-cloudflare/src/d1-repo.ts` | Expose `quotaBalance` |
| `packages/gateway/src/repo/protection.ts`, `repo/shared/protection.ts` | `PauseReason.trigger: "quota"`, `quota?` |
| `packages/gateway/src/protection/runtime.ts`, `protection/messages.ts` | `insertExternal`; quota wording |
| `packages/gateway/src/data-plane/providers/registry.ts` | Group-aware `sortUpstreams` |
| `packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts`, `routing/binding-resolver.ts` | Balance; `group_quota_exhausted` |
| `chat-flow/{chat-completions,messages,responses,gemini}/{http,serve,attempt}.ts`, `responses/session.ts`, `shared/kit-deps.ts`, `shared/telemetry-ctx.ts` | Session plumbing and error code |
| `data-plane/errors/upstream-paused.ts`, `data-plane/models/routes.ts` (`DataPlaneAuthCtx`) | New code; `balanceSession` |
| `chat-flow/shared/respond-telemetry.ts`, `observability/attempts/embeddings-attempt.ts`, `data-plane/shared/token-usage.ts` | Cost hook |
| `packages/gateway/src/maintenance.ts` | Sweep and retention |
| `packages/gateway/src/control-plane/routes.ts`, `control-plane/auth/session-auth.ts`, `control-plane/upstreams/routes.ts`, `public-dto.ts` | Mounts, exemption, `groupId` |
| `packages/gateway/src/shared/edge/ui-pages/i18n.ts` | EN + ZH keys |
| `apps/dashboard/src/{state/reorder-upstreams.ts,state/upstreams.ts,tabs/upstreams/UpstreamsTab.tsx,tabs/upstreams/UpstreamRow.tsx,components/protection-banner-model.ts,components/ProtectionBanner.tsx,state/protection.tsx,api/types.ts,api/protection.ts,api/upstreams.ts}` | UI wiring |
| `packages/gateway/tests/schema-baseline.txt` | Regenerated |
| `packages/gateway/tests/architecture/provider-kind-branches-ratchet.test.ts` | `MAX` 16 to 17 (done with Task 10, when `credential.ts` appeared) |

---

## Task 1: Spike — capture a redacted quota response and write the snapshot parser

The estimator only uses shares, so the unit of GitHub's snapshot (normalised 1,000,000 parts of the allowance, or absolute AI Credits) does not change the rule, but the spec asks to confirm which snapshot reflects AI Credits, its unit and the reset behaviour before anything depends on it. This task adds a read-only diagnostic script with a redaction helper, a robust parser that works for either unit, synthetic fixtures for both shapes, and (when a live account is available) captured fixtures.

**Files:**
- Create: `scripts/quota-spike-redact.ts`
- Create: `scripts/quota-spike.ts`
- Create: `packages/gateway/src/quota-balance/snapshot.ts`
- Create: `packages/gateway/tests/quota-spike-redact.test.ts`
- Create: `packages/gateway/tests/quota-snapshot.test.ts`
- Create: `packages/gateway/tests/fixtures/copilot-quota/synthetic-normalized.json`, `synthetic-credits.json`, `synthetic-unlimited.json`, `synthetic-overage.json`

- [ ] **Step 1: Write the failing redaction test**

```ts
// packages/gateway/tests/quota-spike-redact.test.ts
import { expect, test } from "bun:test"
import { redactQuotaResponse } from "../../../scripts/quota-spike-redact.ts"

test("numbers, booleans and null survive; free strings are masked; known enum strings are kept", () => {
  const out = redactQuotaResponse({
    login: "some-user", analytics_tracking_id: "abc123", copilot_plan: "individual", quota_reset_date: "2026-12-01",
    organization_login_list: ["acme"], chat_enabled: true,
    quota_snapshots: { premium_interactions: { entitlement: 1500, remaining: 600.5, unlimited: false, quota_id: "premium_interactions", timestamp_utc: "2026-11-22T10:00:00.000Z", note: null } },
  }) as Record<string, any>
  expect(out.login).toBe("<redacted:9>")
  expect(out.analytics_tracking_id).toBe("<redacted:6>")
  expect(out.organization_login_list).toEqual(["<redacted:4>"])
  expect(out.copilot_plan).toBe("individual")
  expect(out.quota_reset_date).toBe("2026-12-01")
  expect(out.chat_enabled).toBe(true)
  expect(out.quota_snapshots.premium_interactions).toEqual({
    entitlement: 1500, remaining: 600.5, unlimited: false, quota_id: "premium_interactions", timestamp_utc: "2026-11-22T10:00:00.000Z", note: null,
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/gateway/tests/quota-spike-redact.test.ts`
Expected: FAIL, cannot find module `scripts/quota-spike-redact.ts`.

- [ ] **Step 3: Implement the redaction helper and the script**

```ts
// scripts/quota-spike-redact.ts
/** String values that carry no personal data and are needed to read the shape of the response. */
const KEEP_STRING_KEYS = new Set(["copilot_plan", "access_type_sku", "quota_id", "quota_reset_date", "quota_reset_date_utc", "timestamp_utc"])

/** Numbers, booleans and null are kept; every other string becomes `<redacted:N>` (N is its length) unless its key is listed above. */
export function redactQuotaResponse(value: unknown, key = ""): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return KEEP_STRING_KEYS.has(key) ? value : `<redacted:${value.length}>`
  if (Array.isArray(value)) return value.map(item => redactQuotaResponse(item, key))
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactQuotaResponse(v, k)]))
  }
  return null
}
```

```ts
// scripts/quota-spike.ts
// Usage: VNEXT_DB_PATH=<sqlite file> bun scripts/quota-spike.ts <copilot upstream id> [fixture label]
// Reads GET /copilot_internal/user once with the stored upstream's own GitHub credential (read-only database access, direct egress),
// prints a redacted copy and a summary, and with a label saves the redacted copy as a fixture. It never prints the credential.
import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import { fetchCopilotUser } from "../packages/provider-copilot/src/github.ts"
import { redactQuotaResponse } from "./quota-spike-redact.ts"

const [upstreamId, label] = process.argv.slice(2)
if (!upstreamId) { console.error("usage: bun scripts/quota-spike.ts <copilot upstream id> [fixture label]"); process.exit(2) }
const db = new Database(process.env.VNEXT_DB_PATH ?? ".vnext-local.sqlite", { readonly: true })
const row = db.query<{ provider: string; config_json: string }, [string]>("SELECT provider, config_json FROM upstreams WHERE id = ?").get(upstreamId)
const config = row ? JSON.parse(row.config_json) as { githubToken?: unknown; githubHost?: unknown } : null
if (!row || row.provider !== "copilot" || typeof config?.githubToken !== "string") { console.error("not a Copilot upstream with a stored GitHub credential"); process.exit(1) }

const response = await fetchCopilotUser(config.githubToken, typeof config.githubHost === "string" ? config.githubHost : undefined, fetch)
const body: unknown = await response.json().catch(() => null)
const redacted = redactQuotaResponse(body)
console.log(JSON.stringify({ status: response.status, redacted }, null, 2))
const snaps = (redacted as { quota_snapshots?: Record<string, { entitlement?: number; remaining?: number; unlimited?: boolean }> } | null)?.quota_snapshots ?? {}
for (const [key, snap] of Object.entries(snaps)) {
  const share = typeof snap.entitlement === "number" && typeof snap.remaining === "number" && snap.entitlement > 0 ? ((snap.entitlement - snap.remaining) / snap.entitlement) : null
  console.log(`snapshot ${key}: entitlement=${snap.entitlement} remaining=${snap.remaining} unlimited=${snap.unlimited} usedShare=${share === null ? "n/a" : share.toFixed(4)}`)
}
if (label) {
  mkdirSync("packages/gateway/tests/fixtures/copilot-quota", { recursive: true })
  writeFileSync(`packages/gateway/tests/fixtures/copilot-quota/${label}.json`, JSON.stringify(redacted, null, 2) + "\n")
  console.log(`saved fixture ${label}.json`)
}
```

- [ ] **Step 4: Run the redaction test**

Run: `bun test packages/gateway/tests/quota-spike-redact.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing parser test and the synthetic fixtures**

Fixtures (shapes follow `CopilotQuotaResponse` in `apps/dashboard/src/api/users.ts`: `quota_snapshots.<key> = { entitlement, remaining, unlimited }`):

`packages/gateway/tests/fixtures/copilot-quota/synthetic-normalized.json`:

```json
{ "copilot_plan": "individual", "quota_reset_date": "2026-12-01",
  "quota_snapshots": { "chat": { "unlimited": true, "entitlement": 0, "remaining": 0 },
    "premium_interactions": { "entitlement": 1000000, "remaining": 250000, "unlimited": false, "quota_id": "premium_interactions" } } }
```
`packages/gateway/tests/fixtures/copilot-quota/synthetic-credits.json`:

```json
{ "copilot_plan": "individual", "quota_reset_date_utc": "2026-12-01T00:00:00.000Z",
  "quota_snapshots": { "premium_interactions": { "entitlement": 1500, "remaining": 600, "unlimited": false, "quota_id": "premium_interactions" } } }
```
`packages/gateway/tests/fixtures/copilot-quota/synthetic-unlimited.json`:

```json
{ "copilot_plan": "business", "quota_snapshots": { "premium_interactions": { "unlimited": true, "entitlement": 0, "remaining": 0 } } }
```
`packages/gateway/tests/fixtures/copilot-quota/synthetic-overage.json`:

```json
{ "copilot_plan": "individual", "quota_snapshots": { "premium_interactions": { "entitlement": 300, "remaining": -30, "unlimited": false } } }
```

```ts
// packages/gateway/tests/quota-snapshot.test.ts
import { expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { parseQuotaSnapshot } from "../src/quota-balance/snapshot"

const dir = new URL("./fixtures/copilot-quota/", import.meta.url)
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(name, dir), "utf8"))

test("a normalised unit and an absolute credit unit give shares through the same rule", () => {
  expect(parseQuotaSnapshot(fixture("synthetic-normalized.json"))).toEqual({ key: "premium_interactions", unlimited: false, used: 750000, entitlement: 1000000, resetAt: "2026-12-01" })
  expect(parseQuotaSnapshot(fixture("synthetic-credits.json"))).toEqual({ key: "premium_interactions", unlimited: false, used: 900, entitlement: 1500, resetAt: "2026-12-01T00:00:00.000Z" })
})

test("an unlimited snapshot is reported as unlimited with nothing used", () => {
  expect(parseQuotaSnapshot(fixture("synthetic-unlimited.json"))).toMatchObject({ unlimited: true, used: 0, entitlement: 0 })
})

test("overage keeps used above the entitlement so the share exceeds 1", () => {
  const parsed = parseQuotaSnapshot(fixture("synthetic-overage.json"))
  expect(parsed?.used).toBe(330)
  expect(parsed!.used / parsed!.entitlement).toBeCloseTo(1.1)
})

test("the preferred snapshot key wins and a percent-only snapshot is understood", () => {
  expect(parseQuotaSnapshot({ quota_snapshots: { chat: { entitlement: 50, remaining: 10 }, premium_interactions: { entitlement: 100, remaining: 40 } } })?.key).toBe("premium_interactions")
  expect(parseQuotaSnapshot({ quota_snapshots: { ai_credits: { percent_remaining: 25 } } })).toMatchObject({ key: "ai_credits", used: 75, entitlement: 100 })
})

test("unusable bodies give null", () => {
  for (const body of [null, 5, {}, { quota_snapshots: {} }, { quota_snapshots: { premium_interactions: { entitlement: "x", remaining: 1 } } }, { quota_snapshots: { premium_interactions: { entitlement: 0, remaining: 0 } } }]) {
    expect(parseQuotaSnapshot(body)).toBeNull()
  }
})

test("every captured fixture parses", () => {
  for (const name of readdirSync(dir).filter(name => name.startsWith("captured-"))) {
    expect(parseQuotaSnapshot(fixture(name))).not.toBeNull()
  }
})
```

- [ ] **Step 6: Run it to see it fail**

Run: `bun test packages/gateway/tests/quota-snapshot.test.ts`
Expected: FAIL, cannot find module `../src/quota-balance/snapshot`.

- [ ] **Step 7: Implement the parser**

```ts
// packages/gateway/src/quota-balance/snapshot.ts
/**
 * GET /copilot_internal/user -> the monthly allowance of one account.
 * Task 1 findings (fill in from the captured fixtures): the snapshot that reflects AI Credits is `premium_interactions`; its unit
 * is <normalised parts | absolute credits>; the reset is 00:00 UTC on the 1st (`quota_reset_date`). Balancing uses only shares, so the unit
 * does not change any rule. The key order mirrors the Users page (`formatQuotaChip`).
 */
export const QUOTA_SNAPSHOT_KEYS = ["premium_interactions", "chat", "completions"] as const

export interface ParsedQuota {
  /** Which snapshot was read. */
  key: string
  unlimited: boolean
  /** `entitlement - remaining`; may exceed the entitlement under overage; 0 when unlimited. */
  used: number
  /** 0 when unlimited. */
  entitlement: number
  resetAt: string | null
}

const num = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null

function fromSnapshot(key: string, snap: Record<string, unknown> | null, resetAt: string | null): ParsedQuota | null {
  if (!snap) return null
  if (snap.unlimited === true) return { key, unlimited: true, used: 0, entitlement: 0, resetAt }
  const entitlement = num(snap.entitlement)
  const remaining = num(snap.remaining)
  if (entitlement !== null && entitlement > 0 && remaining !== null) return { key, unlimited: false, used: Math.max(0, entitlement - remaining), entitlement, resetAt }
  const percent = num(snap.percent_remaining)
  if (percent !== null) return { key, unlimited: false, used: Math.max(0, 100 - percent), entitlement: 100, resetAt }
  return null
}

/** The first usable snapshot in the preferred key order, then any other; null when the body has none. */
export function parseQuotaSnapshot(body: unknown): ParsedQuota | null {
  const root = record(body)
  const snaps = record(root?.quota_snapshots)
  if (!root || !snaps) return null
  const resetAt = typeof root.quota_reset_date_utc === "string" ? root.quota_reset_date_utc : typeof root.quota_reset_date === "string" ? root.quota_reset_date : null
  const keys = [...QUOTA_SNAPSHOT_KEYS, ...Object.keys(snaps).filter(key => !(QUOTA_SNAPSHOT_KEYS as readonly string[]).includes(key))]
  for (const key of keys) {
    const parsed = fromSnapshot(key, record(snaps[key]), resetAt)
    if (parsed) return parsed
  }
  return null
}
```

Note the overage test: `entitlement 300, remaining -30` gives `used = 330`.

- [ ] **Step 8: Run the parser tests**

Run: `bun test packages/gateway/tests/quota-snapshot.test.ts packages/gateway/tests/quota-spike-redact.test.ts`
Expected: PASS (6 + 1 tests).

- [ ] **Step 9: Capture real fixtures (needs a live local database; skip and say so if none is available)**

Ask the owner for the local database path and the ids of one individual-plan Copilot upstream and, if one exists, a business/enterprise one. Then run, from `vnext/`:

```bash
VNEXT_DB_PATH=<path to the local sqlite file> bun scripts/quota-spike.ts <upstream id> captured-individual
VNEXT_DB_PATH=<path to the local sqlite file> bun scripts/quota-spike.ts <other upstream id> captured-other
```

Read the printed summary and answer in the code comment at the top of `snapshot.ts` (replace the bracketed text): which snapshot key holds the AI Credits allowance; whether `entitlement` is `1000000` (normalised) or a credit count; whether `remaining` can go negative; the reset field. Rules that follow from the answer, no other code changes:
- If the AI Credits snapshot is not `premium_interactions`, put its key first in `QUOTA_SNAPSHOT_KEYS` and add a case to `quota-snapshot.test.ts`.
- Set `DEFAULT_K_SHARE_PER_USD` in Task 5 to `1 / (monthly allowance of the smallest plan in USD)` rounded up to one significant digit (a high value errs on the side of caution); if the allowance in USD is not known, keep the `0.1` given there (10 % of an allowance per gateway dollar).

Run: `bun test packages/gateway/tests/quota-snapshot.test.ts` (the "every captured fixture parses" test now covers the new files).
Expected: PASS. Open the captured files and check that no login, token, id or e-mail text is left (every string should be `<redacted:N>` or an allowed enum).

- [ ] **Step 10: Commit**

```bash
git add scripts/quota-spike.ts scripts/quota-spike-redact.ts packages/gateway/src/quota-balance/snapshot.ts packages/gateway/tests/quota-spike-redact.test.ts packages/gateway/tests/quota-snapshot.test.ts packages/gateway/tests/fixtures/copilot-quota
git commit -m "feat(quota-balance): quota snapshot parser and spike diagnostic" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: Migration 0028 and schema baseline

**Files:**
- Create: `packages/gateway/migrations/0028_upstream_quota_balancing.sql`
- Create: `packages/gateway/tests/upstream-quota-balancing-migration.test.ts`
- Modify: `packages/gateway/tests/schema-baseline.txt` (regenerated, do not hand edit)

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/upstream-quota-balancing-migration.test.ts
import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { applyMigrations } from "@vibe-llm/platform-bun/src/migrate.ts"

const columns = (db: Database, table: string): string[] =>
  db.query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).all().map(row => row.name)

test("migration 0028 creates the quota balancing tables and the membership column", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    expect(columns(db, "upstream_groups")).toEqual(["id", "owner_id", "name", "enabled", "sort_order", "settings_json", "created_at", "updated_at"])
    expect(columns(db, "upstreams")).toContain("group_id")
    expect(columns(db, "session_assignments")).toEqual(
      ["group_id", "session_key", "upstream_id", "created_at", "last_seen_at", "moved_at", "recent_cost_usd", "recent_cost_at"])
    expect(columns(db, "quota_reads")).toEqual(
      ["upstream_id", "at", "source", "used", "entitlement", "unlimited", "share", "cost_total_usd", "estimated_share_before", "error_points", "snapshot_key", "reset_at"])
    expect(columns(db, "upstream_quota_state")).toEqual([
      "upstream_id", "k", "k_prev", "k_samples", "o", "interval_hours", "learn_since", "last_read_at", "last_read_share", "last_read_unlimited", "last_read_source",
      "last_attempt_at", "failures", "last_error", "next_read_at", "last_error_points", "entitlement", "entitlement_from", "entitlement_changed_at",
      "cost_total_usd", "cost_at_read_usd", "month_key", "month_cost_usd", "updated_at"])
    expect(columns(db, "upstream_cost_buckets")).toEqual(["upstream_id", "bucket", "cost_usd"])
  } finally { db.close() }
})

test("group ids are ug_ plus 32 characters, a session has one assignment per group, a read is unique per instant", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    const group = (id: string) => db.run("INSERT INTO upstream_groups (id, owner_id, name, created_at, updated_at) VALUES (?, 'u', 'g', 'now', 'now')", [id])
    expect(() => group("ug_short")).toThrow()
    expect(() => group("xx_" + "1".repeat(32))).toThrow()
    group("ug_" + "1".repeat(32))
    const assign = () => db.run("INSERT INTO session_assignments (group_id, session_key, upstream_id, created_at, last_seen_at, moved_at) VALUES ('g', 's', 'up', 1, 1, 1)")
    assign()
    expect(assign).toThrow()
    const read = () => db.run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up', 5, 'github', 1, 2, 0.5, 0)")
    read()
    expect(read).toThrow()
    expect(() => db.run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up', 6, 'telepathy', 1, 2, 0.5, 0)")).toThrow()
  } finally { db.close() }
})

test("membership lookups and the idle-assignment sweep use their indexes", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    const plan = (sql: string) => db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map(row => row.detail).join("\n")
    expect(plan("SELECT id FROM upstreams WHERE group_id = 'ug_x'")).toContain("idx_upstreams_group")
    expect(plan("SELECT rowid FROM session_assignments WHERE last_seen_at < 5")).toContain("idx_session_assignments_seen")
    expect(plan("SELECT 1 FROM session_assignments WHERE upstream_id = 'up'")).toContain("idx_session_assignments_upstream")
    expect(plan("SELECT bucket FROM upstream_cost_buckets WHERE bucket < 5")).toContain("idx_upstream_cost_buckets_bucket")
    expect(plan("SELECT at FROM quota_reads WHERE at < 5")).toContain("idx_quota_reads_at")
  } finally { db.close() }
})

test("grouping an upstream does not bump the configuration revision", () => {
  const db = new Database(":memory:")
  try {
    applyMigrations(db)
    db.run(`INSERT INTO upstreams (catalog_generation, credential_generation, row_incarnation, id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at)
            VALUES (0, 0, 'r', 'up_test_a', 'u', 'copilot', 'A', 1, 0, '{}', '{}', '[]', NULL, '[]', 'now', 'now')`)
    const revision = () => db.query<{ revision: number }, []>("SELECT revision FROM configuration_revision WHERE id = 1").get()!.revision
    const before = revision()
    db.run("UPDATE upstreams SET group_id = 'ug_x' WHERE id = 'up_test_a'")
    expect(revision()).toBe(before)
  } finally { db.close() }
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/gateway/tests/upstream-quota-balancing-migration.test.ts`
Expected: FAIL (no such table `upstream_groups`).

- [ ] **Step 3: Write the migration**

```sql
-- packages/gateway/migrations/0028_upstream_quota_balancing.sql
-- Upstream groups with quota balancing: groups, membership, session assignments, quota reads, estimator state and gateway cost counters.

-- A group is one item in the routing order (sort_order shares the number space of its owner's upstreams). Settings JSON is validated by the control plane.
CREATE TABLE upstream_groups (
  id TEXT PRIMARY KEY CHECK (length(id) = 35 AND id GLOB 'ug_*'),
  owner_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_upstream_groups_owner ON upstream_groups (owner_id, sort_order, created_at);

-- Membership. Deliberately not part of the configuration-revision triggers: the data plane reads it through the group directory cache.
ALTER TABLE upstreams ADD COLUMN group_id TEXT;
CREATE INDEX idx_upstreams_group ON upstreams (group_id) WHERE group_id IS NOT NULL;

-- One row per (group, session). Times are unix ms. recent_cost_usd is the exponentially weighted (1 h) gateway spend as of recent_cost_at.
CREATE TABLE session_assignments (
  group_id TEXT NOT NULL,
  session_key TEXT NOT NULL,
  upstream_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  moved_at INTEGER NOT NULL,
  recent_cost_usd REAL NOT NULL DEFAULT 0,
  recent_cost_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (group_id, session_key)
);
CREATE INDEX idx_session_assignments_seen ON session_assignments (last_seen_at);
CREATE INDEX idx_session_assignments_upstream ON session_assignments (upstream_id);

-- Real (github) and calibrated (manual) quota reads. `at` is unix ms; share = used / entitlement of this read; cost_total_usd is the member's
-- cumulative gateway cost when the read was recorded (the difference of two reads is the cost of their interval).
CREATE TABLE quota_reads (
  upstream_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('github', 'manual')),
  used REAL NOT NULL,
  entitlement REAL NOT NULL,
  unlimited INTEGER NOT NULL DEFAULT 0,
  share REAL NOT NULL,
  cost_total_usd REAL NOT NULL,
  estimated_share_before REAL,
  error_points REAL,
  snapshot_key TEXT,
  reset_at TEXT,
  PRIMARY KEY (upstream_id, at)
);
CREATE INDEX idx_quota_reads_at ON quota_reads (at);

-- Estimator, scheduling and cost counters of one group member. k is share per gateway USD, o is share per hour.
CREATE TABLE upstream_quota_state (
  upstream_id TEXT PRIMARY KEY,
  k REAL,
  k_prev REAL,
  k_samples INTEGER NOT NULL DEFAULT 0,
  o REAL NOT NULL DEFAULT 0,
  interval_hours REAL NOT NULL,
  learn_since INTEGER NOT NULL DEFAULT 0,
  last_read_at INTEGER,
  last_read_share REAL,
  last_read_unlimited INTEGER NOT NULL DEFAULT 0,
  last_read_source TEXT,
  last_attempt_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_read_at INTEGER NOT NULL,
  last_error_points REAL,
  entitlement REAL,
  entitlement_from REAL,
  entitlement_changed_at INTEGER,
  cost_total_usd REAL NOT NULL DEFAULT 0,
  cost_at_read_usd REAL NOT NULL DEFAULT 0,
  month_key TEXT NOT NULL DEFAULT '',
  month_cost_usd REAL NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Gateway cost per member in 10-minute buckets (bucket = floor(unix ms / 600000)) for the recent burn rate.
CREATE TABLE upstream_cost_buckets (
  upstream_id TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (upstream_id, bucket)
);
CREATE INDEX idx_upstream_cost_buckets_bucket ON upstream_cost_buckets (bucket);
```

- [ ] **Step 4: Run the test**

Run: `bun test packages/gateway/tests/upstream-quota-balancing-migration.test.ts`
Expected: PASS (4 tests). If the `upstreams` insert in the last test fails with a NOT NULL error, copy the column list of an existing insert from `packages/gateway/src/repo/shared/repos.ts` (`UPSTREAM_INSERT_COLS`) and give the missing columns values.

- [ ] **Step 5: Regenerate the schema baseline and run the corpus test**

Run: `UPDATE_SCHEMA_BASELINE=1 bun test packages/gateway/tests/migrations.test.ts && bun test packages/gateway/tests/migrations.test.ts`
Expected: PASS; `git diff packages/gateway/tests/schema-baseline.txt` shows only the new tables, the `group_id` column and the new indexes.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/migrations/0028_upstream_quota_balancing.sql packages/gateway/tests/upstream-quota-balancing-migration.test.ts packages/gateway/tests/schema-baseline.txt
git commit -m "feat(quota-balance): migration 0028 for groups, assignments, reads and cost counters" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: Quota balance repository (types, shared SQL, D1 and SQLite, contract tests)

**Files:**
- Create: `packages/gateway/src/repo/quota-balance.ts`
- Create: `packages/gateway/src/repo/shared/quota-balance.ts`
- Create: `packages/gateway/tests/quota-balance-repo-contract.ts`, `quota-balance-repo.sqlite.test.ts`, `quota-balance-repo.d1.test.ts`
- Modify: `packages/gateway/src/repo/types.ts` (import near L17, `Repo` near L636), `packages/gateway/src/repo/shared/repos.ts` (import near L11, factory near L1462), `apps/platform-bun/src/bun-sqlite-repo.ts` (field near L63, constructor near L95), `apps/platform-cloudflare/src/d1-repo.ts` (field near L217, constructor near L248)

- [ ] **Step 1: Write the failing contract test and its two runners**

```ts
// packages/gateway/tests/quota-balance-repo-contract.ts
import { expect, test } from "bun:test"
import type { NewQuotaRead, QuotaBalanceRepo, UpstreamGroup } from "../src/repo/quota-balance"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"

const HOUR = 3_600_000
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % HOUR)
const gid = (n: number) => `ug_${n.toString(16).padStart(32, "0")}`
const group = (n: number, over: Partial<UpstreamGroup> = {}): UpstreamGroup => ({
  id: gid(n), ownerId: "user_test_o", name: `Group ${n}`, enabled: true, sortOrder: n, settings: { ...DEFAULT_GROUP_SETTINGS }, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over,
})
const read = (over: Partial<NewQuotaRead> = {}): NewQuotaRead => ({
  upstreamId: "up_test_a", at: T0, source: "github", used: 100, entitlement: 1000, unlimited: false, estimatedShareBefore: null, errorPoints: null,
  snapshotKey: "premium_interactions", resetAt: null, costAdjustUsd: 0, entitlementChange: null, ...over,
})

export function quotaBalanceRepoContract(getRepo: () => QuotaBalanceRepo, run: (sql: string, binds?: unknown[]) => Promise<void>) {
  const insertUpstream = (id: string, owner = "user_test_o", provider = "copilot") => run(
    `INSERT INTO upstreams (catalog_generation, credential_generation, row_incarnation, id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at)
     VALUES (0, 0, 'r', ?, ?, ?, ?, 1, 0, '{}', '{}', '[]', NULL, '[]', 'now', 'now')`, [id, owner, provider, id])

  test.serial("groups round-trip, list by sort order and read stored settings leniently", async () => {
    const repo = getRepo()
    await repo.createGroup(group(2)); await repo.createGroup(group(1)); await repo.createGroup(group(3, { ownerId: "user_test_other" }))
    expect((await repo.listGroups()).map(g => g.id)).toEqual([gid(1), gid(2), gid(3)])
    expect((await repo.listGroups({ ownerId: "user_test_o" })).map(g => g.id)).toEqual([gid(1), gid(2)])
    await run("UPDATE upstream_groups SET settings_json = ? WHERE id = ?", [JSON.stringify({ softShare: 0.8, hardShare: "bad", exhaustedPolicy: "overage" }), gid(1)])
    const stored = await repo.getGroup(gid(1))
    expect(stored?.settings).toEqual({ ...DEFAULT_GROUP_SETTINGS, softShare: 0.8, exhaustedPolicy: "overage" })
    const patched = await repo.updateGroup(gid(2), { name: "Renamed", enabled: false, sortOrder: 9, settings: { ...DEFAULT_GROUP_SETTINGS, toleranceShare: 0.1 } }, "2026-11-02T00:00:00Z")
    expect(patched).toMatchObject({ name: "Renamed", enabled: false, sortOrder: 9, updatedAt: "2026-11-02T00:00:00Z", settings: { toleranceShare: 0.1 } })
    expect(await repo.updateGroup(gid(99), { name: "x" }, "now")).toBeNull()
  })

  test.serial("joining creates the quota state row, leaving or switching groups removes assignments, deleting a group releases its members", async () => {
    const repo = getRepo()
    await repo.createGroup(group(11)); await repo.createGroup(group(12))
    await insertUpstream("up_test_m1"); await insertUpstream("up_test_m2")
    expect(await repo.setMembership("up_test_m1", gid(11), { nowMs: T0, intervalHours: 6 })).toBe(true)
    expect(await repo.setMembership("up_test_m2", gid(11), { nowMs: T0, intervalHours: 6 })).toBe(true)
    expect(await repo.setMembership("up_test_nope", gid(11), { nowMs: T0, intervalHours: 6 })).toBe(false)
    expect((await repo.listMemberships()).filter(m => m.groupId === gid(11)).map(m => m.upstreamId).sort()).toEqual(["up_test_m1", "up_test_m2"])
    const [state] = [...(await repo.getStates(["up_test_m1"])).values()]
    expect(state).toMatchObject({ upstreamId: "up_test_m1", intervalHours: 6, nextReadAt: T0, k: null, kSamples: 0, o: 0, failures: 0, lastReadAt: null })

    await repo.putAssignment({ groupId: gid(11), sessionKey: "s1", upstreamId: "up_test_m1", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
    await repo.putAssignment({ groupId: gid(11), sessionKey: "s2", upstreamId: "up_test_m2", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
    await repo.setMembership("up_test_m1", gid(12), { nowMs: T0, intervalHours: 6 }) // switching groups drops the old group's assignments of this member
    expect(await repo.getAssignment(gid(11), "s1")).toBeNull()
    expect(await repo.getAssignment(gid(11), "s2")).not.toBeNull()
    await repo.setMembership("up_test_m2", null, { nowMs: T0, intervalHours: 6 })
    expect(await repo.getAssignment(gid(11), "s2")).toBeNull()
    expect((await repo.getStates(["up_test_m2"])).size).toBe(0)
    expect(await repo.deleteGroup(gid(12))).toBe(true)
    expect((await repo.listMemberships()).some(m => m.upstreamId === "up_test_m1")).toBe(false)
    expect((await repo.getStates(["up_test_m1"])).size).toBe(0)
    expect(await repo.deleteGroup(gid(12))).toBe(false)
  })

  test.serial("assignments are replaced without losing created_at, touched forward only and counted per member", async () => {
    const repo = getRepo()
    await repo.createGroup(group(21))
    const base = { groupId: gid(21), sessionKey: "k1", upstreamId: "up_test_x", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 1, recentCostAt: T0 }
    await repo.putAssignment(base)
    await repo.putAssignment({ ...base, upstreamId: "up_test_y", createdAt: T0 + 5, lastSeenAt: T0 + 10, movedAt: T0 + 10, recentCostUsd: 2, recentCostAt: T0 + 10 })
    expect(await repo.getAssignment(gid(21), "k1")).toEqual({ ...base, upstreamId: "up_test_y", createdAt: T0, lastSeenAt: T0 + 10, movedAt: T0 + 10, recentCostUsd: 2, recentCostAt: T0 + 10 })
    await repo.touchAssignment(gid(21), "k1", T0 + 5)
    expect((await repo.getAssignment(gid(21), "k1"))?.lastSeenAt).toBe(T0 + 10)
    await repo.touchAssignment(gid(21), "k1", T0 + 50)
    expect((await repo.getAssignment(gid(21), "k1"))?.lastSeenAt).toBe(T0 + 50)
    await repo.putAssignment({ ...base, sessionKey: "k2", upstreamId: "up_test_y", lastSeenAt: T0 - 10 * HOUR })
    expect([...(await repo.countActiveSessions(gid(21), T0 - HOUR)).entries()]).toEqual([["up_test_y", 1]])
  })

  test.serial("cost counters add up, the cost since a read is the difference of the counters, and the month counter restarts", async () => {
    const repo = getRepo()
    await repo.createGroup(group(31)); await insertUpstream("up_test_c")
    await repo.setMembership("up_test_c", gid(31), { nowMs: T0, intervalHours: 6 })
    await repo.recordCost({ upstreamId: "up_test_c", nowMs: T0, costUsd: 1.5, monthKey: "2026-11" })
    await repo.recordCost({ upstreamId: "up_test_c", nowMs: T0 + 60_000, costUsd: 0.5, monthKey: "2026-11" })
    let facts = (await repo.loadFacts(["up_test_c"], T0 + 120_000, "2026-11")).get("up_test_c")!
    expect(facts.costSinceReadUsd).toBeCloseTo(2)
    expect(facts.monthCostUsd).toBeCloseTo(2)
    expect(facts.burnBuckets).toEqual([{ bucket: Math.floor(T0 / 600_000), costUsd: 2 }])
    const stored = await repo.recordRead(read({ upstreamId: "up_test_c", at: T0 + 120_000, used: 50, entitlement: 500 }), T0 + 120_000)
    expect(stored).toMatchObject({ upstreamId: "up_test_c", share: 0.1, costTotalUsd: 2, source: "github", snapshotKey: "premium_interactions" })
    await repo.recordCost({ upstreamId: "up_test_c", nowMs: T0 + 180_000, costUsd: 1, monthKey: "2026-11" })
    facts = (await repo.loadFacts(["up_test_c"], T0 + 200_000, "2026-11")).get("up_test_c")!
    expect(facts.costSinceReadUsd).toBeCloseTo(1)
    expect(facts.state).toMatchObject({ lastReadAt: T0 + 120_000, lastReadShare: 0.1, lastReadUnlimited: false, lastReadSource: "github", entitlement: 500, failures: 0 })
    await repo.recordCost({ upstreamId: "up_test_c", nowMs: T0 + 40 * 24 * HOUR, costUsd: 4, monthKey: "2026-12" })
    facts = (await repo.loadFacts(["up_test_c"], T0 + 40 * 24 * HOUR, "2026-12")).get("up_test_c")!
    expect(facts.monthCostUsd).toBeCloseTo(4)
    expect((await repo.loadFacts(["up_test_c"], T0 + 40 * 24 * HOUR, "2027-01")).get("up_test_c")!.monthCostUsd).toBe(0)
    expect(await repo.costBetween("up_test_c", T0, T0 + 5 * 60_000)).toBeCloseTo(3)
  })

  test.serial("a session cost update rides in the same batch; an entitlement change and a back-dated cost snapshot are stored", async () => {
    const repo = getRepo()
    await repo.createGroup(group(41)); await insertUpstream("up_test_e")
    await repo.setMembership("up_test_e", gid(41), { nowMs: T0, intervalHours: 6 })
    await repo.putAssignment({ groupId: gid(41), sessionKey: "s", upstreamId: "up_test_e", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
    await repo.recordCost({ upstreamId: "up_test_e", nowMs: T0, costUsd: 3, monthKey: "2026-11", session: { groupId: gid(41), sessionKey: "s", recentCostUsd: 3, recentCostAt: T0 } })
    expect(await repo.getAssignment(gid(41), "s")).toMatchObject({ recentCostUsd: 3, recentCostAt: T0 })
    await repo.recordRead(read({ upstreamId: "up_test_e", at: T0, used: 10, entitlement: 100 }), T0)
    await repo.recordRead(read({ upstreamId: "up_test_e", at: T0 + HOUR, used: 20, entitlement: 400, entitlementChange: { from: 100, to: 400 }, costAdjustUsd: 1 }), T0 + HOUR)
    const [state] = [...(await repo.getStates(["up_test_e"])).values()]
    expect(state).toMatchObject({ entitlement: 400, entitlementFrom: 100, entitlementChangedAt: T0 + HOUR, costTotalUsd: 3, costAtReadUsd: 2 })
    expect((await repo.listReads("up_test_e", T0 - 1)).map(r => [r.at, r.costTotalUsd, r.share])).toEqual([[T0, 3, 0.1], [T0 + HOUR, 2, 0.05]])
    await repo.recordRead(read({ upstreamId: "up_test_e", at: T0 + 2 * HOUR, used: 0, entitlement: 0, unlimited: true }), T0 + 2 * HOUR)
    expect((await repo.getStates(["up_test_e"])).get("up_test_e")).toMatchObject({ entitlement: 400, lastReadUnlimited: true, lastReadShare: 0 })
  })

  test.serial("estimator state, failures and reads are saved; unknown members are ignored", async () => {
    const repo = getRepo()
    await repo.createGroup(group(51)); await insertUpstream("up_test_f")
    await repo.setMembership("up_test_f", gid(51), { nowMs: T0, intervalHours: 6 })
    await repo.saveEstimator("up_test_f", { k: 0.02, kPrev: 0.03, kSamples: 4, o: 0.001, intervalHours: 3, learnSince: T0, nextReadAt: T0 + 3 * HOUR, lastErrorPoints: -2.5 }, T0)
    await repo.recordFailure("up_test_f", T0 + HOUR, T0 + 2 * HOUR, "HTTP 502")
    await repo.recordFailure("up_test_f", T0 + 2 * HOUR, T0 + 4 * HOUR, "HTTP 502")
    expect((await repo.getStates(["up_test_f"])).get("up_test_f")).toMatchObject({
      k: 0.02, kPrev: 0.03, kSamples: 4, o: 0.001, intervalHours: 3, learnSince: T0, nextReadAt: T0 + 4 * HOUR, lastErrorPoints: -2.5, failures: 2, lastError: "HTTP 502", lastAttemptAt: T0 + 2 * HOUR,
    })
    await repo.recordRead(read({ upstreamId: "up_test_f", at: T0 + 5 * HOUR }), T0 + 5 * HOUR)
    expect((await repo.getStates(["up_test_f"])).get("up_test_f")).toMatchObject({ failures: 0, lastError: null, lastAttemptAt: T0 + 5 * HOUR })
    expect((await repo.getStates([])).size).toBe(0)
    await repo.saveEstimator("up_test_none", { k: 1, kPrev: null, kSamples: 1, o: 0, intervalHours: 1, learnSince: 0, nextReadAt: 0, lastErrorPoints: null }, T0)
    expect((await repo.getStates(["up_test_none"])).size).toBe(0)
  })

  test.serial("retention deletes idle assignments by the group's idle hours, old reads and buckets, and orphans", async () => {
    const repo = getRepo()
    await repo.createGroup(group(61, { settings: { ...DEFAULT_GROUP_SETTINGS, sessionIdleHours: 2 } }))
    const a = { groupId: gid(61), upstreamId: "up_test_r", createdAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 }
    await repo.putAssignment({ ...a, sessionKey: "fresh", lastSeenAt: T0 - HOUR })
    await repo.putAssignment({ ...a, sessionKey: "idle", lastSeenAt: T0 - 3 * HOUR })
    await repo.putAssignment({ ...a, groupId: gid(62), sessionKey: "orphan", lastSeenAt: T0 })
    await run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up_test_r', ?, 'github', 1, 2, 0.5, 0)", [T0 - 100 * 24 * HOUR])
    await run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up_test_r', ?, 'github', 1, 2, 0.5, 0)", [T0])
    await run("INSERT INTO upstream_cost_buckets (upstream_id, bucket, cost_usd) VALUES ('up_test_r', ?, 1), ('up_test_r', ?, 1)", [Math.floor((T0 - 11 * 24 * HOUR) / 600_000), Math.floor(T0 / 600_000)])
    const first = await repo.deleteExpired(T0, { orphans: false })
    expect(first).toMatchObject({ assignments: 1, reads: 1, buckets: 1 })
    expect(await repo.getAssignment(gid(61), "idle")).toBeNull()
    expect(await repo.getAssignment(gid(61), "fresh")).not.toBeNull()
    expect(await repo.getAssignment(gid(62), "orphan")).not.toBeNull()
    const second = await repo.deleteExpired(T0, { orphans: true })
    expect(second.assignments).toBeGreaterThanOrEqual(1)
    expect(await repo.getAssignment(gid(62), "orphan")).toBeNull()
    expect(await repo.deleteExpired(T0, { chunk: 1, maxChunks: 1 })).toBeDefined()
  })
}
```

```ts
// packages/gateway/tests/quota-balance-repo.sqlite.test.ts
import { afterAll, beforeAll } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { quotaBalanceRepoContract } from "./quota-balance-repo-contract"

let db: Database
let repo: BunSqliteRepo
beforeAll(() => { db = new Database(":memory:"); repo = new BunSqliteRepo(db) })
afterAll(() => db.close())

quotaBalanceRepoContract(() => repo.quotaBalance, async (sql, binds = []) => { db.run(sql, binds as never[]) })
```

```ts
// packages/gateway/tests/quota-balance-repo.d1.test.ts
import { afterAll, beforeAll } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Miniflare } from "miniflare"
import { unstable_splitSqlQuery } from "wrangler"
import { D1Repo, type D1Database } from "@vibe-llm/platform-cloudflare/src/d1-repo.ts"
import { migrationsDir } from "../src/migrations-dir.ts"
import { quotaBalanceRepoContract } from "./quota-balance-repo-contract"

let dir: string
let mf: Miniflare
let repo: D1Repo
let d1: { prepare(sql: string): { bind(...values: unknown[]): { run(): Promise<unknown> }; run(): Promise<unknown> } }

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "quota-balance-repo-d1-"))
  mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('fixture') } }",
    host: "127.0.0.1", port: 0, compatibilityDate: "2025-06-01", d1Databases: { DB: "quota-balance-repo" }, d1Persist: join(dir, "d1") })
  const db = await mf.getD1Database("DB")
  const source = fileURLToPath(migrationsDir)
  for (const name of readdirSync(source).filter(name => name.endsWith(".sql")).sort()) {
    for (const sql of unstable_splitSqlQuery(readFileSync(join(source, name), "utf8"))) await db.prepare(sql).run()
  }
  d1 = db as unknown as typeof d1
  repo = new D1Repo(db as unknown as D1Database)
})
afterAll(async () => { await mf?.dispose(); if (dir) rmSync(dir, { recursive: true, force: true }) })

quotaBalanceRepoContract(() => repo.quotaBalance, async (sql, binds = []) => { await (binds.length ? d1.prepare(sql).bind(...binds) : d1.prepare(sql)).run() })
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/gateway/tests/quota-balance-repo.sqlite.test.ts`
Expected: FAIL, `../src/repo/quota-balance` cannot be resolved.

- [ ] **Step 3: Write the types and the lenient settings parser**

```ts
// packages/gateway/src/repo/quota-balance.ts
export const GROUP_ID_PREFIX = "ug_"
export type ExhaustedPolicy = "stop" | "overage"

export interface GroupSettings {
  /** Band above the minimum projected share treated as equal. */
  toleranceShare: number
  /** Used share at which a member stops taking new sessions. */
  softShare: number
  /** Used share at which a member is cut off. */
  hardShare: number
  idleRebalanceMinutes: number
  /** Projected-share gap above the group minimum that moves an active session. */
  migrateShare: number
  burnHorizonHours: number
  heavySessionUsdPerHour: number
  migrateMinHours: number
  exhaustedPolicy: ExhaustedPolicy
  readIntervalHours: number
  confirmShare: number
  driftShare: number
  sessionIdleHours: number
}
export const DEFAULT_GROUP_SETTINGS: GroupSettings = {
  toleranceShare: 0.05, softShare: 0.9, hardShare: 0.95, idleRebalanceMinutes: 10, migrateShare: 0.1, burnHorizonHours: 6, heavySessionUsdPerHour: 5,
  migrateMinHours: 12, exhaustedPolicy: "stop", readIntervalHours: 6, confirmShare: 0.9, driftShare: 0.1, sessionIdleHours: 24,
}
/** Inclusive [min, max] per numeric field. */
export const GROUP_SETTINGS_LIMITS = {
  toleranceShare: [0, 0.5], softShare: [0.5, 1], hardShare: [0.5, 1], idleRebalanceMinutes: [1, 1440], migrateShare: [0.01, 1], burnHorizonHours: [0, 72],
  heavySessionUsdPerHour: [0, 10000], migrateMinHours: [0, 720], readIntervalHours: [1, 48], confirmShare: [0.5, 1], driftShare: [0.01, 1], sessionIdleHours: [1, 720],
} as const satisfies Record<Exclude<keyof GroupSettings, "exhaustedPolicy">, readonly [number, number]>
export type GroupNumericField = keyof typeof GROUP_SETTINGS_LIMITS
export const GROUP_NUMERIC_FIELDS = Object.keys(GROUP_SETTINGS_LIMITS) as GroupNumericField[]

/** Lenient read of stored JSON: an invalid or missing field takes its default; never throws. */
export function resolveGroupSettings(raw: unknown): GroupSettings {
  const out: GroupSettings = { ...DEFAULT_GROUP_SETTINGS }
  const stored = typeof raw === "string" ? safeParse(raw) : raw
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return out
  const values = stored as Record<string, unknown>
  for (const field of GROUP_NUMERIC_FIELDS) {
    const value = values[field]
    const [min, max] = GROUP_SETTINGS_LIMITS[field]
    if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) out[field] = value
  }
  if (values.exhaustedPolicy === "stop" || values.exhaustedPolicy === "overage") out.exhaustedPolicy = values.exhaustedPolicy
  if (out.hardShare < out.softShare) out.hardShare = out.softShare
  return out
}
function safeParse(json: string): unknown { try { return JSON.parse(json) } catch { return null } }

export interface UpstreamGroup {
  id: string
  /** '' = global (admin-owned). */
  ownerId: string
  name: string
  enabled: boolean
  sortOrder: number
  settings: GroupSettings
  createdAt: string
  updatedAt: string
}
export interface GroupMembership { upstreamId: string; groupId: string; ownerId: string; enabled: boolean }

/** Times are unix ms. */
export interface SessionAssignment {
  groupId: string
  sessionKey: string
  upstreamId: string
  createdAt: number
  lastSeenAt: number
  movedAt: number
  /** Exponentially weighted (1 h) gateway spend as of `recentCostAt`. */
  recentCostUsd: number
  recentCostAt: number
}

export type QuotaReadSource = "github" | "manual"
export interface QuotaRead {
  upstreamId: string
  at: number
  source: QuotaReadSource
  used: number
  entitlement: number
  unlimited: boolean
  /** used / entitlement of this read; 0 when unlimited. */
  share: number
  /** Cumulative gateway cost of the member when the read was recorded. */
  costTotalUsd: number
  estimatedShareBefore: number | null
  /** Estimated share just before the read minus the real share, in percentage points. */
  errorPoints: number | null
  snapshotKey: string | null
  resetAt: string | null
}
export interface NewQuotaRead {
  upstreamId: string
  at: number
  source: QuotaReadSource
  used: number
  entitlement: number
  unlimited: boolean
  estimatedShareBefore: number | null
  errorPoints: number | null
  snapshotKey: string | null
  resetAt: string | null
  /** Gateway cost in USD between `at` and now (a back-dated manual read); subtracted from the cost snapshot. */
  costAdjustUsd: number
  entitlementChange: { from: number; to: number } | null
}

export interface QuotaState {
  upstreamId: string
  /** Share per gateway USD; null until learned. */
  k: number | null
  kPrev: number | null
  kSamples: number
  /** Outside usage, share per hour. */
  o: number
  intervalHours: number
  /** Reads before this instant do not count for learning (restart after an entitlement change). */
  learnSince: number
  lastReadAt: number | null
  lastReadShare: number | null
  lastReadUnlimited: boolean
  lastReadSource: QuotaReadSource | null
  lastAttemptAt: number | null
  failures: number
  lastError: string | null
  nextReadAt: number
  lastErrorPoints: number | null
  /** Latest read's entitlement. */
  entitlement: number | null
  entitlementFrom: number | null
  entitlementChangedAt: number | null
  costTotalUsd: number
  costAtReadUsd: number
  monthKey: string
  monthCostUsd: number
  updatedAt: number
}
export interface CostBucket { /** floor(unix ms / COST_BUCKET_MS) */ bucket: number; costUsd: number }
export interface MemberFacts {
  state: QuotaState | null
  /** cost_total_usd - cost_at_read_usd */
  costSinceReadUsd: number
  /** The member's cost this month (0 when the counter belongs to an earlier month). */
  monthCostUsd: number
  burnBuckets: CostBucket[]
}
export interface EstimatorPatch {
  k: number | null
  kPrev: number | null
  kSamples: number
  o: number
  intervalHours: number
  learnSince: number
  nextReadAt: number
  lastErrorPoints: number | null
}
export interface CostEntry {
  upstreamId: string
  nowMs: number
  costUsd: number
  monthKey: string
  session?: { groupId: string; sessionKey: string; recentCostUsd: number; recentCostAt: number }
}

export const COST_BUCKET_MS = 600_000
export const COST_BURN_WINDOW_MS = 3 * 3_600_000
export const QUOTA_READS_RETENTION_DAYS = 90
export const COST_BUCKETS_RETENTION_DAYS = 10
export const QUOTA_PURGE_CHUNK = 5000
export const QUOTA_PURGE_MAX_CHUNKS = 10
export const QUOTA_READS_PER_MEMBER_LIMIT = 400

export interface QuotaBalanceRepo {
  listGroups(filter?: { ownerId?: string }): Promise<UpstreamGroup[]>
  getGroup(id: string): Promise<UpstreamGroup | null>
  createGroup(group: UpstreamGroup): Promise<void>
  /** Null when the group does not exist. */
  updateGroup(id: string, patch: Partial<Pick<UpstreamGroup, "name" | "enabled" | "sortOrder" | "settings">>, nowIso: string): Promise<UpstreamGroup | null>
  /** Releases the members, deletes their quota state and the group's assignments; false when the group does not exist. */
  deleteGroup(id: string): Promise<boolean>

  /** Every upstream that has a group. */
  listMemberships(): Promise<GroupMembership[]>
  /** `groupId` null removes the upstream from its group. False when the upstream does not exist. Joining creates the quota state (`next_read_at = nowMs`). */
  setMembership(upstreamId: string, groupId: string | null, init: { nowMs: number; intervalHours: number }): Promise<boolean>

  getAssignment(groupId: string, sessionKey: string): Promise<SessionAssignment | null>
  /** Insert or replace; `created_at` of an existing row is kept. */
  putAssignment(assignment: SessionAssignment): Promise<void>
  /** `last_seen_at = max(last_seen_at, at)`. */
  touchAssignment(groupId: string, sessionKey: string, at: number): Promise<void>
  /** Sessions seen at or after `sinceMs`, per member. */
  countActiveSessions(groupId: string, sinceMs: number): Promise<Map<string, number>>

  getStates(upstreamIds: readonly string[]): Promise<Map<string, QuotaState>>
  /** States plus the cost since each read, the month cost and the burn buckets of the last 3 hours. */
  loadFacts(upstreamIds: readonly string[], nowMs: number, monthKey: string): Promise<Map<string, MemberFacts>>
  recordCost(entry: CostEntry): Promise<void>
  /** Cost between two instants from the 10-minute buckets (bucket resolution). */
  costBetween(upstreamId: string, fromMs: number, toMs: number): Promise<number>
  /** Stores the read (cost snapshot taken atomically) and moves the state's base to it. */
  recordRead(read: NewQuotaRead, nowMs: number): Promise<QuotaRead>
  saveEstimator(upstreamId: string, patch: EstimatorPatch, nowMs: number): Promise<void>
  recordFailure(upstreamId: string, nowMs: number, nextReadAt: number, error: string): Promise<void>
  /** Oldest first. */
  listReads(upstreamId: string, sinceMs: number): Promise<QuotaRead[]>

  /** Retention; bounded statements. `orphans: false` skips the anti-join scans. */
  deleteExpired(nowMs: number, options?: { chunk?: number; maxChunks?: number; orphans?: boolean }):
    Promise<{ assignments: number; reads: number; buckets: number; states: number }>
}
```

- [ ] **Step 4: Write the shared SQL implementation**

```ts
// packages/gateway/src/repo/shared/quota-balance.ts
import {
  COST_BUCKETS_RETENTION_DAYS, COST_BUCKET_MS, COST_BURN_WINDOW_MS, QUOTA_PURGE_CHUNK, QUOTA_PURGE_MAX_CHUNKS, QUOTA_READS_PER_MEMBER_LIMIT, QUOTA_READS_RETENTION_DAYS,
  resolveGroupSettings,
  type CostBucket, type CostEntry, type EstimatorPatch, type GroupMembership, type MemberFacts, type NewQuotaRead, type QuotaBalanceRepo, type QuotaRead, type QuotaReadSource,
  type QuotaState, type SessionAssignment, type UpstreamGroup,
} from "../quota-balance.ts"
import type { SqlExecutor, SqlStatement } from "./executor.ts"

interface GroupRow { id: string; owner_id: string; name: string; enabled: number; sort_order: number; settings_json: string; created_at: string; updated_at: string }
const GROUP_COLS = "id, owner_id, name, enabled, sort_order, settings_json, created_at, updated_at"
const toGroup = (row: GroupRow): UpstreamGroup => ({
  id: row.id, ownerId: row.owner_id, name: row.name, enabled: row.enabled !== 0, sortOrder: Number(row.sort_order),
  settings: resolveGroupSettings(row.settings_json), createdAt: row.created_at, updatedAt: row.updated_at,
})

interface AssignmentRow { group_id: string; session_key: string; upstream_id: string; created_at: number; last_seen_at: number; moved_at: number; recent_cost_usd: number; recent_cost_at: number }
const ASSIGNMENT_COLS = "group_id, session_key, upstream_id, created_at, last_seen_at, moved_at, recent_cost_usd, recent_cost_at"
const toAssignment = (row: AssignmentRow): SessionAssignment => ({
  groupId: row.group_id, sessionKey: row.session_key, upstreamId: row.upstream_id, createdAt: Number(row.created_at), lastSeenAt: Number(row.last_seen_at),
  movedAt: Number(row.moved_at), recentCostUsd: Number(row.recent_cost_usd), recentCostAt: Number(row.recent_cost_at),
})

interface StateRow {
  upstream_id: string; k: number | null; k_prev: number | null; k_samples: number; o: number; interval_hours: number; learn_since: number
  last_read_at: number | null; last_read_share: number | null; last_read_unlimited: number; last_read_source: QuotaReadSource | null
  last_attempt_at: number | null; failures: number; last_error: string | null; next_read_at: number; last_error_points: number | null
  entitlement: number | null; entitlement_from: number | null; entitlement_changed_at: number | null
  cost_total_usd: number; cost_at_read_usd: number; month_key: string; month_cost_usd: number; updated_at: number
}
const STATE_COLS = `upstream_id, k, k_prev, k_samples, o, interval_hours, learn_since, last_read_at, last_read_share, last_read_unlimited, last_read_source, last_attempt_at,
  failures, last_error, next_read_at, last_error_points, entitlement, entitlement_from, entitlement_changed_at, cost_total_usd, cost_at_read_usd, month_key, month_cost_usd, updated_at`
const opt = (value: number | null): number | null => value === null || value === undefined ? null : Number(value)
const toState = (row: StateRow): QuotaState => ({
  upstreamId: row.upstream_id, k: opt(row.k), kPrev: opt(row.k_prev), kSamples: Number(row.k_samples), o: Number(row.o), oSamples: Number(row.o_samples), intervalHours: Number(row.interval_hours),
  learnSince: Number(row.learn_since), lastReadAt: opt(row.last_read_at), lastReadShare: opt(row.last_read_share), lastReadUnlimited: row.last_read_unlimited !== 0,
  lastReadSource: row.last_read_source, lastAttemptAt: opt(row.last_attempt_at), failures: Number(row.failures), lastError: row.last_error, nextReadAt: Number(row.next_read_at),
  lastErrorPoints: opt(row.last_error_points), entitlement: opt(row.entitlement), entitlementFrom: opt(row.entitlement_from), entitlementChangedAt: opt(row.entitlement_changed_at),
  costTotalUsd: Number(row.cost_total_usd), costAtReadUsd: Number(row.cost_at_read_usd), monthKey: row.month_key, monthCostUsd: Number(row.month_cost_usd), updatedAt: Number(row.updated_at),
})

interface ReadRow {
  upstream_id: string; at: number; source: QuotaReadSource; used: number; entitlement: number; unlimited: number; share: number; cost_total_usd: number
  estimated_share_before: number | null; error_points: number | null; snapshot_key: string | null; reset_at: string | null
}
const READ_COLS = "upstream_id, at, source, used, entitlement, unlimited, share, cost_total_usd, estimated_share_before, error_points, snapshot_key, reset_at"
const toRead = (row: ReadRow): QuotaRead => ({
  upstreamId: row.upstream_id, at: Number(row.at), source: row.source, used: Number(row.used), entitlement: Number(row.entitlement), unlimited: row.unlimited !== 0,
  share: Number(row.share), costTotalUsd: Number(row.cost_total_usd), estimatedShareBefore: opt(row.estimated_share_before), errorPoints: opt(row.error_points),
  snapshotKey: row.snapshot_key, resetAt: row.reset_at,
})

export class SharedQuotaBalanceRepo implements QuotaBalanceRepo {
  constructor(private readonly x: SqlExecutor) {}

  private batch(statements: readonly SqlStatement[]) {
    if (!this.x.batch) throw new Error("quota balancing needs an executor with batch support")
    return this.x.batch(statements)
  }

  async listGroups(filter: { ownerId?: string } = {}): Promise<UpstreamGroup[]> {
    const where = filter.ownerId === undefined ? "" : " WHERE owner_id = ?"
    const rows = await this.x.all<GroupRow>(`SELECT ${GROUP_COLS} FROM upstream_groups${where} ORDER BY sort_order ASC, created_at ASC, id ASC`, filter.ownerId === undefined ? [] : [filter.ownerId])
    return rows.map(toGroup)
  }

  async getGroup(id: string): Promise<UpstreamGroup | null> {
    const row = await this.x.first<GroupRow>(`SELECT ${GROUP_COLS} FROM upstream_groups WHERE id = ?`, [id])
    return row ? toGroup(row) : null
  }

  async createGroup(group: UpstreamGroup): Promise<void> {
    await this.x.run(
      `INSERT INTO upstream_groups (${GROUP_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [group.id, group.ownerId, group.name, group.enabled ? 1 : 0, group.sortOrder, JSON.stringify(group.settings), group.createdAt, group.updatedAt])
  }

  async updateGroup(id: string, patch: Partial<Pick<UpstreamGroup, "name" | "enabled" | "sortOrder" | "settings">>, nowIso: string): Promise<UpstreamGroup | null> {
    const current = await this.getGroup(id)
    if (!current) return null
    const next = { ...current, ...patch, updatedAt: nowIso }
    await this.x.run("UPDATE upstream_groups SET name = ?, enabled = ?, sort_order = ?, settings_json = ?, updated_at = ? WHERE id = ?",
      [next.name, next.enabled ? 1 : 0, next.sortOrder, JSON.stringify(next.settings), nowIso, id])
    return next
  }

  async deleteGroup(id: string): Promise<boolean> {
    const results = await this.batch([
      { sql: "DELETE FROM upstream_quota_state WHERE upstream_id IN (SELECT id FROM upstreams WHERE group_id = ?)", binds: [id] },
      { sql: "UPDATE upstreams SET group_id = NULL WHERE group_id = ?", binds: [id] },
      { sql: "DELETE FROM session_assignments WHERE group_id = ?", binds: [id] },
      { sql: "DELETE FROM upstream_groups WHERE id = ?", binds: [id] },
    ])
    return (results[3]?.changes ?? 0) > 0
  }

  async listMemberships(): Promise<GroupMembership[]> {
    const rows = await this.x.all<{ id: string; group_id: string; owner_id: string | null; enabled: number }>(
      "SELECT id, group_id, owner_id, enabled FROM upstreams WHERE group_id IS NOT NULL", [])
    return rows.map(row => ({ upstreamId: row.id, groupId: row.group_id, ownerId: row.owner_id ?? "", enabled: row.enabled !== 0 }))
  }

  async setMembership(upstreamId: string, groupId: string | null, init: { nowMs: number; intervalHours: number }): Promise<boolean> {
    const exists = await this.x.first<{ id: string }>("SELECT id FROM upstreams WHERE id = ?", [upstreamId])
    if (!exists) return false
    const common: SqlStatement[] = [{ sql: "DELETE FROM session_assignments WHERE upstream_id = ?", binds: [upstreamId] }]
    if (groupId === null) {
      await this.batch([...common,
        { sql: "DELETE FROM upstream_quota_state WHERE upstream_id = ?", binds: [upstreamId] },
        { sql: "UPDATE upstreams SET group_id = NULL WHERE id = ?", binds: [upstreamId] }])
      return true
    }
    await this.batch([...common,
      { sql: "UPDATE upstreams SET group_id = ? WHERE id = ?", binds: [groupId, upstreamId] },
      { sql: "INSERT INTO upstream_quota_state (upstream_id, interval_hours, next_read_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (upstream_id) DO NOTHING",
        binds: [upstreamId, init.intervalHours, init.nowMs, init.nowMs] }])
    return true
  }

  async getAssignment(groupId: string, sessionKey: string): Promise<SessionAssignment | null> {
    const row = await this.x.first<AssignmentRow>(`SELECT ${ASSIGNMENT_COLS} FROM session_assignments WHERE group_id = ? AND session_key = ?`, [groupId, sessionKey])
    return row ? toAssignment(row) : null
  }

  async putAssignment(a: SessionAssignment): Promise<void> {
    await this.x.run(
      `INSERT INTO session_assignments (${ASSIGNMENT_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (group_id, session_key) DO UPDATE SET upstream_id = excluded.upstream_id, last_seen_at = excluded.last_seen_at, moved_at = excluded.moved_at,
         recent_cost_usd = excluded.recent_cost_usd, recent_cost_at = excluded.recent_cost_at`,
      [a.groupId, a.sessionKey, a.upstreamId, a.createdAt, a.lastSeenAt, a.movedAt, a.recentCostUsd, a.recentCostAt])
  }

  async touchAssignment(groupId: string, sessionKey: string, at: number): Promise<void> {
    await this.x.run("UPDATE session_assignments SET last_seen_at = MAX(last_seen_at, ?) WHERE group_id = ? AND session_key = ?", [at, groupId, sessionKey])
  }

  async countActiveSessions(groupId: string, sinceMs: number): Promise<Map<string, number>> {
    const rows = await this.x.all<{ upstream_id: string; n: number }>(
      "SELECT upstream_id, COUNT(*) AS n FROM session_assignments WHERE group_id = ? AND last_seen_at >= ? GROUP BY upstream_id", [groupId, sinceMs])
    return new Map(rows.map(row => [row.upstream_id, Number(row.n)]))
  }

  async getStates(upstreamIds: readonly string[]): Promise<Map<string, QuotaState>> {
    const out = new Map<string, QuotaState>()
    if (upstreamIds.length === 0) return out
    const rows = await this.x.all<StateRow>(`SELECT ${STATE_COLS} FROM upstream_quota_state WHERE upstream_id IN (SELECT value FROM json_each(?))`, [JSON.stringify(upstreamIds)])
    for (const row of rows) out.set(row.upstream_id, toState(row))
    return out
  }

  async loadFacts(upstreamIds: readonly string[], nowMs: number, monthKey: string): Promise<Map<string, MemberFacts>> {
    const out = new Map<string, MemberFacts>()
    if (upstreamIds.length === 0) return out
    const states = await this.getStates(upstreamIds)
    const rows = await this.x.all<{ upstream_id: string; bucket: number; cost_usd: number }>(
      `SELECT upstream_id, bucket, cost_usd FROM upstream_cost_buckets WHERE upstream_id IN (SELECT value FROM json_each(?)) AND bucket >= ? ORDER BY bucket ASC`,
      [JSON.stringify(upstreamIds), Math.floor((nowMs - COST_BURN_WINDOW_MS) / COST_BUCKET_MS)])
    const buckets = new Map<string, CostBucket[]>()
    for (const row of rows) buckets.set(row.upstream_id, [...(buckets.get(row.upstream_id) ?? []), { bucket: Number(row.bucket), costUsd: Number(row.cost_usd) }])
    for (const id of upstreamIds) {
      const state = states.get(id) ?? null
      out.set(id, {
        state,
        costSinceReadUsd: state ? Math.max(0, state.costTotalUsd - state.costAtReadUsd) : 0,
        monthCostUsd: state && state.monthKey === monthKey ? state.monthCostUsd : 0,
        burnBuckets: buckets.get(id) ?? [],
      })
    }
    return out
  }

  async recordCost(entry: CostEntry): Promise<void> {
    const statements: SqlStatement[] = [
      { sql: `UPDATE upstream_quota_state SET cost_total_usd = cost_total_usd + ?,
                month_cost_usd = CASE WHEN month_key = ? THEN month_cost_usd + ? ELSE ? END, month_key = ?, updated_at = ? WHERE upstream_id = ?`,
        binds: [entry.costUsd, entry.monthKey, entry.costUsd, entry.costUsd, entry.monthKey, entry.nowMs, entry.upstreamId] },
      { sql: `INSERT INTO upstream_cost_buckets (upstream_id, bucket, cost_usd) VALUES (?, ?, ?)
              ON CONFLICT (upstream_id, bucket) DO UPDATE SET cost_usd = cost_usd + excluded.cost_usd`,
        binds: [entry.upstreamId, Math.floor(entry.nowMs / COST_BUCKET_MS), entry.costUsd] },
    ]
    if (entry.session) {
      statements.push({ sql: "UPDATE session_assignments SET recent_cost_usd = ?, recent_cost_at = ? WHERE group_id = ? AND session_key = ?",
        binds: [entry.session.recentCostUsd, entry.session.recentCostAt, entry.session.groupId, entry.session.sessionKey] })
    }
    await this.batch(statements)
  }

  async costBetween(upstreamId: string, fromMs: number, toMs: number): Promise<number> {
    const row = await this.x.first<{ usd: number | null }>(
      "SELECT SUM(cost_usd) AS usd FROM upstream_cost_buckets WHERE upstream_id = ? AND bucket >= ? AND bucket <= ?",
      [upstreamId, Math.floor(fromMs / COST_BUCKET_MS), Math.floor(toMs / COST_BUCKET_MS)])
    return Number(row?.usd ?? 0)
  }

  async recordRead(read: NewQuotaRead, nowMs: number): Promise<QuotaRead> {
    const share = read.unlimited || read.entitlement <= 0 ? 0 : read.used / read.entitlement
    const change = read.entitlementChange
    await this.batch([
      { sql: `INSERT INTO quota_reads (${READ_COLS})
              SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT cost_total_usd FROM upstream_quota_state WHERE upstream_id = ?), 0) - ?, ?, ?, ?, ?`,
        binds: [read.upstreamId, read.at, read.source, read.used, read.entitlement, read.unlimited ? 1 : 0, share, read.upstreamId, read.costAdjustUsd,
          read.estimatedShareBefore, read.errorPoints, read.snapshotKey, read.resetAt] },
      { sql: `UPDATE upstream_quota_state SET last_read_at = ?, last_read_share = ?, last_read_unlimited = ?, last_read_source = ?, last_attempt_at = ?, failures = 0, last_error = NULL,
                cost_at_read_usd = cost_total_usd - ?, entitlement = COALESCE(?, entitlement), entitlement_from = COALESCE(?, entitlement_from),
                entitlement_changed_at = COALESCE(?, entitlement_changed_at), updated_at = ? WHERE upstream_id = ?`,
        binds: [read.at, share, read.unlimited ? 1 : 0, read.source, nowMs, read.costAdjustUsd, read.unlimited ? null : read.entitlement, change ? change.from : null,
          change ? read.at : null, nowMs, read.upstreamId] },
    ])
    const stored = await this.x.first<ReadRow>(`SELECT ${READ_COLS} FROM quota_reads WHERE upstream_id = ? AND at = ?`, [read.upstreamId, read.at])
    if (!stored) throw new Error("quota read was not stored")
    return toRead(stored)
  }

  async saveEstimator(upstreamId: string, patch: EstimatorPatch, nowMs: number): Promise<void> {
    await this.x.run(
      `UPDATE upstream_quota_state SET k = ?, k_prev = ?, k_samples = ?, o = ?, interval_hours = ?, learn_since = ?, next_read_at = ?, last_error_points = ?, updated_at = ? WHERE upstream_id = ?`,
      [patch.k, patch.kPrev, patch.kSamples, patch.o, patch.intervalHours, patch.learnSince, patch.nextReadAt, patch.lastErrorPoints, nowMs, upstreamId])
  }

  async recordFailure(upstreamId: string, nowMs: number, nextReadAt: number, error: string): Promise<void> {
    await this.x.run(
      "UPDATE upstream_quota_state SET last_attempt_at = ?, failures = failures + 1, last_error = ?, next_read_at = ?, updated_at = ? WHERE upstream_id = ?",
      [nowMs, error.slice(0, 200), nextReadAt, nowMs, upstreamId])
  }

  async listReads(upstreamId: string, sinceMs: number): Promise<QuotaRead[]> {
    const rows = await this.x.all<ReadRow>(
      `SELECT ${READ_COLS} FROM quota_reads WHERE upstream_id = ? AND at >= ? ORDER BY at ASC LIMIT ${QUOTA_READS_PER_MEMBER_LIMIT}`, [upstreamId, sinceMs])
    return rows.map(toRead)
  }

  async deleteExpired(nowMs: number, options: { chunk?: number; maxChunks?: number; orphans?: boolean } = {}) {
    const orphans = options.orphans ?? true
    const chunk = options.chunk ?? QUOTA_PURGE_CHUNK
    const maxChunks = options.maxChunks ?? QUOTA_PURGE_MAX_CHUNKS
    const drain = async (sql: string, binds: unknown[]): Promise<number> => {
      let total = 0
      for (let i = 0; i < maxChunks; i++) {
        const { changes } = await this.x.run(sql, [...binds, chunk])
        total += changes
        if (changes < chunk) break
      }
      return total
    }
    const assignments = await drain(
      `DELETE FROM session_assignments WHERE rowid IN (
         SELECT a.rowid FROM session_assignments a JOIN upstream_groups g ON g.id = a.group_id
         WHERE a.last_seen_at < ? - COALESCE(json_extract(g.settings_json, '$.sessionIdleHours'), 24) * 3600000.0 LIMIT ?)`, [nowMs])
    const reads = await drain(
      "DELETE FROM quota_reads WHERE rowid IN (SELECT rowid FROM quota_reads WHERE at < ? LIMIT ?)", [nowMs - QUOTA_READS_RETENTION_DAYS * 86_400_000])
    const buckets = await drain(
      "DELETE FROM upstream_cost_buckets WHERE rowid IN (SELECT rowid FROM upstream_cost_buckets WHERE bucket < ? LIMIT ?)",
      [Math.floor((nowMs - COST_BUCKETS_RETENTION_DAYS * 86_400_000) / COST_BUCKET_MS)])
    let states = 0
    if (orphans) {
      const orphanAssignments = await drain(
        `DELETE FROM session_assignments WHERE rowid IN (
           SELECT a.rowid FROM session_assignments a WHERE NOT EXISTS (SELECT 1 FROM upstream_groups g WHERE g.id = a.group_id) LIMIT ?)`, [])
      await drain(
        `DELETE FROM quota_reads WHERE rowid IN (SELECT r.rowid FROM quota_reads r WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = r.upstream_id) LIMIT ?)`, [])
      await drain(
        `DELETE FROM upstream_cost_buckets WHERE rowid IN (SELECT c.rowid FROM upstream_cost_buckets c WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = c.upstream_id) LIMIT ?)`, [])
      states = await drain(
        `DELETE FROM upstream_quota_state WHERE upstream_id IN (
           SELECT s.upstream_id FROM upstream_quota_state s WHERE NOT EXISTS (SELECT 1 FROM upstreams u WHERE u.id = s.upstream_id AND u.group_id IS NOT NULL) LIMIT ?)`, [])
      return { assignments: assignments + orphanAssignments, reads, buckets, states }
    }
    return { assignments, reads, buckets, states }
  }
}
```

- [ ] **Step 5: Wire the repo into `Repo`, the shared factory and both platforms**

In `packages/gateway/src/repo/types.ts` add the import next to the protection import and the field after `protection: ProtectionRepo`:

```ts
import type { QuotaBalanceRepo } from "./quota-balance.ts"
// ...
  protection: ProtectionRepo
  quotaBalance: QuotaBalanceRepo
```

In `packages/gateway/src/repo/shared/repos.ts` add `import { SharedQuotaBalanceRepo } from "./quota-balance.ts"` next to `SharedProtectionRepo` and in the object returned by `buildSharedRepo` after `protection: new SharedProtectionRepo(x),` add `quotaBalance: new SharedQuotaBalanceRepo(x),`.

In `apps/platform-bun/src/bun-sqlite-repo.ts` and `apps/platform-cloudflare/src/d1-repo.ts` add next to `protection`:

```ts
  quotaBalance: Repo["quotaBalance"]
  // constructor:
    this.quotaBalance = shared.quotaBalance
```

- [ ] **Step 6: Run the contract tests and the typecheck**

Run: `bun test packages/gateway/tests/quota-balance-repo.sqlite.test.ts packages/gateway/tests/quota-balance-repo.d1.test.ts`
Expected: PASS (7 tests per runner).

Run: `bun run --filter '@vibe-llm/gateway' typecheck`
Expected: no errors. Any test fixture that builds a complete `Repo` literal now needs `quotaBalance`; the compiler lists them; give each `quotaBalance: {} as Repo["quotaBalance"]`.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/repo packages/gateway/tests/quota-balance-repo-contract.ts packages/gateway/tests/quota-balance-repo.sqlite.test.ts packages/gateway/tests/quota-balance-repo.d1.test.ts apps/platform-bun/src/bun-sqlite-repo.ts apps/platform-cloudflare/src/d1-repo.ts
git commit -m "feat(quota-balance): quota balance repository for D1 and SQLite" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Time helpers, group settings validation and session identity (pure)

**Files:**
- Create: `packages/gateway/src/quota-balance/time.ts`
- Create: `packages/gateway/src/quota-balance/settings.ts`
- Create: `packages/gateway/src/quota-balance/session-key.ts`
- Create: `packages/gateway/tests/quota-time-settings.test.ts`
- Create: `packages/gateway/tests/quota-session-key.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-time-settings.test.ts
import { expect, test } from "bun:test"
import { hoursLeftInMonth, monthKey, monthStartMs, nextMonthStartMs } from "../src/quota-balance/time"
import { GroupSettingsError, normalizeGroupSettings } from "../src/quota-balance/settings"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"

test("UTC month boundaries", () => {
  const t = Date.UTC(2026, 10, 22, 13, 30)
  expect(monthStartMs(t)).toBe(Date.UTC(2026, 10, 1))
  expect(nextMonthStartMs(t)).toBe(Date.UTC(2026, 11, 1))
  expect(nextMonthStartMs(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1))
  expect(monthKey(t)).toBe("2026-11")
  expect(hoursLeftInMonth(Date.UTC(2026, 10, 30, 12))).toBe(12)
})

test("settings: absent keys keep the current value, unknown keys and out-of-range values throw without echoing the value", () => {
  expect(normalizeGroupSettings({ softShare: 0.8 })).toEqual({ ...DEFAULT_GROUP_SETTINGS, softShare: 0.8 })
  expect(normalizeGroupSettings({ exhaustedPolicy: "overage" }, { ...DEFAULT_GROUP_SETTINGS, softShare: 0.7 })).toEqual({ ...DEFAULT_GROUP_SETTINGS, softShare: 0.7, exhaustedPolicy: "overage" })
  expect(() => normalizeGroupSettings({ nope: 1 })).toThrow(GroupSettingsError)
  expect(() => normalizeGroupSettings({ toleranceShare: 0.9 })).toThrow("settings.toleranceShare must be a number between 0 and 0.5")
  expect(() => normalizeGroupSettings({ idleRebalanceMinutes: 2.5 })).toThrow("settings.idleRebalanceMinutes must be an integer between 1 and 1440")
  expect(() => normalizeGroupSettings({ exhaustedPolicy: "ignore" })).toThrow("settings.exhaustedPolicy must be stop or overage")
  expect(() => normalizeGroupSettings({ softShare: 0.96 })).toThrow("settings.softShare must not exceed hardShare")
  expect(() => normalizeGroupSettings([])).toThrow("settings must be an object")
  try { normalizeGroupSettings({ softShare: 123456 }) } catch (error) { expect(String(error)).not.toContain("123456") }
})
```

```ts
// packages/gateway/tests/quota-session-key.test.ts
import { expect, test } from "bun:test"
import { deriveSessionInput, newBalanceSession, resolveSessionKey } from "../src/quota-balance/session-key"

const key = async (protocol: Parameters<typeof deriveSessionInput>[0], payload: unknown, headers: Record<string, string> = {}, apiKeyId = "key_test_1") =>
  resolveSessionKey(newBalanceSession(deriveSessionInput(protocol, payload, new Headers(headers), apiKeyId)))

test("chat completions: prompt_cache_key wins, and is read from the payload before any interceptor strips it", async () => {
  const body = { model: "m", prompt_cache_key: "conv-1", messages: [{ role: "user", content: "hello" }] }
  const a = await key("chat_completions", body)
  expect(a).toMatch(/^[0-9a-f]{32}$/)
  expect(await key("chat_completions", { ...body, messages: [{ role: "user", content: "something else" }] })).toBe(a)
  expect(await key("chat_completions", { ...body, prompt_cache_key: "conv-2" })).not.toBe(a)
  expect(await key("chat_completions", body, {}, "key_test_2")).not.toBe(a)
})

test("the fallback fingerprint is the system prompt plus the first user message and is stable while the conversation grows", async () => {
  const first = { model: "m", messages: [{ role: "system", content: "You are terse." }, { role: "user", content: "What is 2+2?" }] }
  const grown = { model: "m", messages: [...first.messages, { role: "assistant", content: "4" }, { role: "user", content: "And 3+3?" }] }
  const k = await key("chat_completions", first)
  expect(await key("chat_completions", grown)).toBe(k)
  expect(await key("chat_completions", { model: "m", messages: [{ role: "system", content: "You are verbose." }, first.messages[1]] })).not.toBe(k)
  expect(await key("chat_completions", { model: "m", messages: [first.messages[0], { role: "user", content: [{ type: "text", text: "Different question" }] }] })).not.toBe(k)
})

test("a bare single message without a system prompt still gets a key; a request without any text has none", async () => {
  expect(await key("chat_completions", { messages: [{ role: "user", content: "just this" }] })).toMatch(/^[0-9a-f]{32}$/)
  expect(await key("chat_completions", { messages: [] })).toBeNull()
  expect(await key("chat_completions", null)).toBeNull()
})

test("responses: prompt_cache_key, Codex session headers, then instructions plus the first user input", async () => {
  const body = { model: "m", instructions: "be brief", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi there" }] }] }
  const byInput = await key("responses", body)
  expect(await key("responses", { ...body, input: [...body.input, { type: "message", role: "assistant", content: [{ type: "output_text", text: "hello" }] }, { type: "message", role: "user", content: [{ type: "input_text", text: "more" }] }] })).toBe(byInput)
  const byHeader = await key("responses", body, { session_id: "codex-session-1" })
  expect(byHeader).not.toBe(byInput)
  expect(await key("responses", { ...body, instructions: "other" }, { session_id: "codex-session-1" })).toBe(byHeader)
  expect(await key("responses", body, { "conversation-id": "codex-session-1" })).toBe(byHeader)
  expect(await key("responses", { ...body, prompt_cache_key: "pck" }, { session_id: "codex-session-1" })).not.toBe(byHeader)
  expect(await key("responses", { model: "m", input: "plain string input" })).toMatch(/^[0-9a-f]{32}$/)
})

test("messages: Claude Code session header, then the session part of metadata.user_id in both formats, then the fingerprint", async () => {
  const body = { model: "m", system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=aaaa;" }, { type: "text", text: "You are Claude Code." }], messages: [{ role: "user", content: [{ type: "text", text: "start" }] }] }
  const byHeader = await key("messages", body, { "x-claude-code-session-id": "11111111-2222-3333-4444-555555555555" })
  const legacy = await key("messages", { ...body, metadata: { user_id: "user_abc_account_def_session_11111111-2222-3333-4444-555555555555" } })
  const json = await key("messages", { ...body, metadata: { user_id: JSON.stringify({ device_id: "d", account_uuid: "a", session_id: "11111111-2222-3333-4444-555555555555" }) } })
  expect(legacy).toBe(byHeader)
  expect(json).toBe(byHeader)
  // The billing attribution block changes on every request and must not leak into the fingerprint.
  const a = await key("messages", body)
  const b = await key("messages", { ...body, system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=1; cch=bbbb;" }, body.system[1]] })
  expect(b).toBe(a)
  expect(a).not.toBe(byHeader)
})

test("gemini: system instruction plus the first user content", async () => {
  const body = { systemInstruction: { parts: [{ text: "be nice" }] }, contents: [{ role: "user", parts: [{ text: "hello" }] }] }
  const k = await key("gemini", body)
  expect(k).toMatch(/^[0-9a-f]{32}$/)
  expect(await key("gemini", { ...body, contents: [...body.contents, { role: "model", parts: [{ text: "hi" }] }, { role: "user", parts: [{ text: "again" }] }] })).toBe(k)
})

test("the hash runs once per session object", async () => {
  const session = newBalanceSession(deriveSessionInput("chat_completions", { messages: [{ role: "user", content: "x" }] }, undefined, "key_test_1"))
  const first = resolveSessionKey(session)
  expect(resolveSessionKey(session)).toBe(first)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/gateway/tests/quota-time-settings.test.ts packages/gateway/tests/quota-session-key.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/quota-balance/time.ts
export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000

export const monthStartMs = (nowMs: number): number => { const d = new Date(nowMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) }
/** The next 00:00 UTC on the 1st: when every allowance resets. */
export const nextMonthStartMs = (nowMs: number): number => { const d = new Date(nowMs); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) }
export const monthKey = (nowMs: number): string => new Date(nowMs).toISOString().slice(0, 7)
export const hoursLeftInMonth = (nowMs: number): number => (nextMonthStartMs(nowMs) - nowMs) / HOUR_MS
```

```ts
// packages/gateway/src/quota-balance/settings.ts
import { DEFAULT_GROUP_SETTINGS, GROUP_NUMERIC_FIELDS, GROUP_SETTINGS_LIMITS, type GroupNumericField, type GroupSettings } from "../repo/quota-balance.ts"

export { resolveGroupSettings } from "../repo/quota-balance.ts"
export class GroupSettingsError extends Error {}

const INTEGER = new Set<GroupNumericField>(["idleRebalanceMinutes", "sessionIdleHours"])
const fieldOk = (field: GroupNumericField, value: unknown): value is number => {
  const [min, max] = GROUP_SETTINGS_LIMITS[field]
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!INTEGER.has(field) || Number.isInteger(value))
}

/**
 * Strict validation for the API: unknown keys and out-of-range values throw; absent keys keep their value from `current`.
 * Messages name fields and ranges, never the submitted value.
 */
export function normalizeGroupSettings(input: unknown, current: GroupSettings = DEFAULT_GROUP_SETTINGS): GroupSettings {
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new GroupSettingsError("settings must be an object")
  const raw = input as Record<string, unknown>
  const known = new Set<string>(["exhaustedPolicy", ...GROUP_NUMERIC_FIELDS])
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new GroupSettingsError("unknown group setting")
  const out: GroupSettings = { ...current }
  if (raw.exhaustedPolicy !== undefined) {
    if (raw.exhaustedPolicy !== "stop" && raw.exhaustedPolicy !== "overage") throw new GroupSettingsError("settings.exhaustedPolicy must be stop or overage")
    out.exhaustedPolicy = raw.exhaustedPolicy
  }
  for (const field of GROUP_NUMERIC_FIELDS) {
    const value = raw[field]
    if (value === undefined) continue
    if (!fieldOk(field, value)) {
      const [min, max] = GROUP_SETTINGS_LIMITS[field]
      throw new GroupSettingsError(`settings.${field} must be ${INTEGER.has(field) ? "an integer" : "a number"} between ${min} and ${max}`)
    }
    out[field] = value
  }
  if (out.softShare > out.hardShare) throw new GroupSettingsError("settings.softShare must not exceed hardShare")
  return out
}
```

```ts
// packages/gateway/src/quota-balance/session-key.ts
export type BalanceProtocol = "chat_completions" | "messages" | "responses" | "gemini"

/** Plain strings only: the hash is computed lazily, and only when a request meets a group. */
export interface SessionInput {
  apiKeyId: string
  /** A client session identifier, when the request carries one. */
  explicitId: string | null
  /** System prompt + first user message (each cut to 2 KiB), the fallback identity. */
  fingerprint: string | null
}

/** One per request, created by the HTTP handler. The balancer fills `assigned`; the cost hook reads it through `telemetryCtx.quotaSession`. */
export interface BalanceSession {
  readonly input: SessionInput
  assigned?: { groupId: string; sessionKey: string; upstreamId: string }
  key?: Promise<string | null>
}
export const newBalanceSession = (input: SessionInput): BalanceSession => ({ input })

const LIMIT = 2048
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
const str = (value: unknown): string | null => typeof value === "string" && value.length > 0 ? value : null

/** Text of a message content: a string, or an array of parts carrying `text`. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map(part => typeof part === "string" ? part : str(record(part)?.text) ?? "").filter(Boolean).join("\n")
}
const cut = (text: string): string => text.slice(0, LIMIT)

function fingerprintOf(system: string, user: string): string | null {
  const s = cut(system.trim())
  const u = cut(user.trim())
  return s === "" && u === "" ? null : `${s}\u0000${u}`
}

function chatFingerprint(payload: Record<string, unknown>): string | null {
  const messages = Array.isArray(payload.messages) ? payload.messages.map(record) : []
  const system = messages.find(m => m?.role === "system" || m?.role === "developer")
  const user = messages.find(m => m?.role === "user")
  return fingerprintOf(textOf(system?.content), textOf(user?.content))
}

function responsesFingerprint(payload: Record<string, unknown>): string | null {
  const instructions = typeof payload.instructions === "string" ? payload.instructions : ""
  if (typeof payload.input === "string") return fingerprintOf(instructions, payload.input)
  const items = Array.isArray(payload.input) ? payload.input.map(record) : []
  const system = instructions || textOf(items.find(i => i?.role === "system" || i?.role === "developer")?.content)
  const user = items.find(i => i?.role === "user" && (i.type === undefined || i.type === "message"))
  return fingerprintOf(system, textOf(user?.content))
}

function messagesFingerprint(payload: Record<string, unknown>): string | null {
  const blocks = typeof payload.system === "string" ? [payload.system] : Array.isArray(payload.system) ? payload.system : []
  // Claude Code puts a billing attribution block into `system` that changes on every request.
  const system = blocks.map(block => typeof block === "string" ? block : str(record(block)?.text) ?? "").filter(text => text && !text.startsWith("x-anthropic-billing-header")).join("\n")
  const user = (Array.isArray(payload.messages) ? payload.messages.map(record) : []).find(m => m?.role === "user")
  return fingerprintOf(system, textOf(user?.content))
}

function geminiFingerprint(payload: Record<string, unknown>): string | null {
  const instruction = record(payload.systemInstruction) ?? record(payload.system_instruction)
  const parts = (value: unknown): string => Array.isArray(value) ? value.map(part => str(record(part)?.text) ?? "").filter(Boolean).join("\n") : ""
  const contents = (Array.isArray(payload.contents) ? payload.contents.map(record) : []).find(c => c !== null && (c.role === undefined || c.role === "user"))
  return fingerprintOf(parts(instruction?.parts), parts(contents?.parts))
}

/** Claude Code's `metadata.user_id`: either `..._session_<uuid>` or a JSON string with `session_id`. */
function claudeSessionFromUserId(userId: unknown): string | null {
  const text = str(userId)
  if (!text) return null
  if (text.startsWith("{")) { try { return str(record(JSON.parse(text))?.session_id) } catch { return null } }
  return /_session_([0-9a-zA-Z-]{8,})$/.exec(text)?.[1] ?? null
}

/**
 * Reads the identity from the parsed request body (before any interceptor can strip `prompt_cache_key`) and the inbound headers.
 * Client identifiers first (`prompt_cache_key`, Claude Code session header or `metadata.user_id`, Codex `session_id` / `conversation-id`),
 * otherwise the system prompt plus the first user message.
 */
export function deriveSessionInput(protocol: BalanceProtocol, payload: unknown, headers: Headers | undefined, apiKeyId: string): SessionInput {
  const body = record(payload)
  if (!body) return { apiKeyId, explicitId: null, fingerprint: null }
  const explicitId = str(body.prompt_cache_key)
    ?? str(headers?.get("x-claude-code-session-id"))
    ?? claudeSessionFromUserId(record(body.metadata)?.user_id)
    ?? str(headers?.get("session_id"))
    ?? str(headers?.get("conversation-id"))
  const fingerprint = protocol === "chat_completions" ? chatFingerprint(body)
    : protocol === "responses" ? responsesFingerprint(body)
      : protocol === "messages" ? messagesFingerprint(body)
        : geminiFingerprint(body)
  return { apiKeyId, explicitId, fingerprint }
}

const hex = (bytes: ArrayBuffer): string => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("")

/** SHA-256 of the API key id plus the identity, first 32 hex digits; null when the request has no identity at all. Computed once per session object. */
export function resolveSessionKey(session: BalanceSession): Promise<string | null> {
  return session.key ??= (async () => {
    const { apiKeyId, explicitId, fingerprint } = session.input
    const identity = explicitId !== null ? `sid\u0000${explicitId}` : fingerprint !== null ? `msg\u0000${fingerprint}` : null
    if (identity === null) return null
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`qb1\u0000${apiKeyId}\u0000${identity}`))
    return hex(digest).slice(0, 32)
  })()
}
```

Note: the test "the hash runs once per session object" compares two promises for identity, which holds because `resolveSessionKey` memoises the promise on the session.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/quota-time-settings.test.ts packages/gateway/tests/quota-session-key.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/quota-balance/time.ts packages/gateway/src/quota-balance/settings.ts packages/gateway/src/quota-balance/session-key.ts packages/gateway/tests/quota-time-settings.test.ts packages/gateway/tests/quota-session-key.test.ts
git commit -m "feat(quota-balance): time helpers, group settings validation, session identity" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: Estimator (pure): estimate, projection, burn rate, learning of `k` and `o`, entitlement changes

All values are shares of the member's own latest entitlement; nothing here compares absolute amounts.

**Files:**
- Create: `packages/gateway/src/quota-balance/estimator.ts`
- Create: `packages/gateway/tests/quota-estimator.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-estimator.test.ts
import { expect, test } from "bun:test"
import {
  DEFAULT_K_SHARE_PER_USD, burnRateUsdPerHour, effectiveK, estimateShare, learn, projectShare, weightedQuantile,
  type EstimatorParams, type LearnResult, type ReadPoint,
} from "../src/quota-balance/estimator"

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 3)
const params = (over: Partial<EstimatorParams> = {}): EstimatorParams => ({ k: 0.02, kSamples: 5, o: 0.001, ...over })

test("estimated share = last read + k x gateway cost since the read + o x hours since the read", () => {
  const at = T0
  const e = estimateShare({ lastRead: { at, share: 0.5, unlimited: false }, params: params(), costSinceReadUsd: 10, monthCostUsd: 99, now: at + 10 * H })
  expect(e).toMatchObject({ known: true, unlimited: false })
  expect(e.usedShare).toBeCloseTo(0.71, 10)
})

test("few samples err high: the conservative k is at least the fallback, learned k is used once there are enough samples", () => {
  expect(effectiveK({ k: 0.01, kSamples: 1 })).toBe(DEFAULT_K_SHARE_PER_USD)
  expect(effectiveK({ k: null, kSamples: 0 })).toBe(DEFAULT_K_SHARE_PER_USD)
  expect(effectiveK({ k: 0.5, kSamples: 2 })).toBe(0.5)
  expect(effectiveK({ k: 0.01, kSamples: 3 })).toBe(0.01)
  expect(effectiveK({ k: 0.01, kSamples: 0 }, 0.3)).toBe(0.3)
})

test("a member without a read is unknown; an unlimited one is known with nothing used", () => {
  expect(estimateShare({ lastRead: null, params: params(), costSinceReadUsd: 5, monthCostUsd: 5, now: T0 })).toEqual({ known: false, unlimited: false, usedShare: 0 })
  expect(estimateShare({ lastRead: { at: T0, share: 0, unlimited: true }, params: params(), costSinceReadUsd: 5, monthCostUsd: 5, now: T0 + H })).toEqual({ known: true, unlimited: true, usedShare: 0 })
})

test("after the monthly reset the base is zero: the month's gateway cost and the outside rate since the month began", () => {
  const lastRead = { at: Date.UTC(2026, 9, 31, 12), share: 0.93, unlimited: false }
  const now = Date.UTC(2026, 10, 3, 12) // 60 h into November
  const e = estimateShare({ lastRead, params: params(), costSinceReadUsd: 400, monthCostUsd: 5, now })
  expect(e.usedShare).toBeCloseTo(0.02 * 5 + 0.001 * 60)
})

test("projected month-end share adds outside usage for the hours left and the recent burn over the horizon", () => {
  const now = Date.UTC(2026, 10, 22) // 216 h left
  const projected = projectShare({ usedShare: 0.3, params: params(), burnUsdPerHour: 2, burnHorizonHours: 6, now })
  expect(projected).toBeCloseTo(0.3 + 0.001 * 216 + 0.02 * 2 * 6)
  expect(projectShare({ usedShare: 0.3, params: params(), burnUsdPerHour: 2, burnHorizonHours: 6, now, unlimited: true })).toBe(0)
})

test("burn rate is an exponentially weighted spend per hour over the recent buckets", () => {
  const now = 1_800_000_000_000 - (1_800_000_000_000 % 600_000) + 600_000 // a bucket boundary
  const buckets = Array.from({ length: 18 }, (_, i) => ({ bucket: now / 600_000 - 1 - i, costUsd: 1 })) // $1 per 10 min = $6/h for 3 h
  expect(burnRateUsdPerHour(buckets, now)).toBeCloseTo(5.7, 1)
  expect(burnRateUsdPerHour([], now)).toBe(0)
})

test("weighted low quantile", () => {
  expect(weightedQuantile([], 0.25)).toBeNull()
  expect(weightedQuantile([{ value: 3, weight: 1 }, { value: 1, weight: 1 }, { value: 2, weight: 1 }], 0.25)).toBe(1)
  expect(weightedQuantile([{ value: 1, weight: 1 }, { value: 2, weight: 10 }], 0.25)).toBe(2)
})

interface Plan { ratio?: (i: number) => number; outsidePerHour?: (i: number) => number; entitlement?: (i: number) => number; cost?: number }
/** Reads every 6 h from T0. The share of an interval is ratio x cost + outside x 6 h; a different entitlement rescales the share (same credits). */
function history(n: number, plan: Plan): ReadPoint[] {
  const reads: ReadPoint[] = [{ at: T0, share: 0.05, entitlement: plan.entitlement?.(0) ?? 1000, unlimited: false, costTotalUsd: 0 }]
  for (let i = 1; i <= n; i++) {
    const prev = reads[i - 1]!
    const cost = plan.cost ?? 10
    const entitlement = plan.entitlement?.(i) ?? prev.entitlement
    const grown = prev.share * prev.entitlement + ((plan.ratio?.(i) ?? 0.02) * cost + (plan.outsidePerHour?.(i) ?? 0) * 6) * prev.entitlement
    reads.push({ at: T0 + i * 6 * H, share: grown / entitlement, entitlement, unlimited: false, costTotalUsd: prev.costTotalUsd + cost })
  }
  return reads
}
/** Feeds the reads one at a time, like the reader does. */
function run(reads: ReadPoint[], start: EstimatorParams = { k: null, kSamples: 0, o: 0 }): { results: LearnResult[]; params: EstimatorParams; learnSince: number } {
  let current = start
  let learnSince = 0
  const results: LearnResult[] = []
  for (let i = 1; i < reads.length; i++) {
    const result = learn({ prev: current, reads: reads.slice(0, i + 1), learnSince, previousEntitlement: reads[i - 1]!.entitlement, estimatedShareBefore: null })
    results.push(result)
    current = { k: result.k, kSamples: result.kSamples, o: result.o }
    learnSince = result.learnSince
  }
  return { results, params: current, learnSince }
}

test("k is the low end of the observed share per gateway dollar: outside usage only raises the ratio", () => {
  const reads = history(16, { ratio: () => 0.02, outsidePerHour: i => (i % 2 === 0 ? 0.02 : 0) })
  const { params: p } = run(reads)
  expect(p.k).toBeCloseTo(0.02, 4)
  expect(p.kSamples).toBe(16)
})

test("a price or discount change is absorbed within a couple of days of reads", () => {
  const reads = history(32, { ratio: i => (i <= 20 ? 0.02 : 0.04) })
  expect(run(reads.slice(0, 22)).params.k).toBeCloseTo(0.02, 4) // one read after the change: still the old regime
  expect(run(reads).params.k).toBeCloseTo(0.04, 4) // three days after the change
})

test("intervals older than seven days do not count", () => {
  const reads = history(40, { ratio: i => (i <= 8 ? 0.01 : 0.02) })
  expect(run(reads).params.k).toBeCloseTo(0.02, 4)
})

test("outside usage showing up and going away is tracked by o within a few reads", () => {
  const reads = history(16, { ratio: () => 0.02, outsidePerHour: i => (i > 8 && i <= 12 ? 0.01 : 0) })
  const { results } = run(reads)
  expect(results[7]!.o).toBeCloseTo(0, 6)
  expect(results[11]!.o).toBeGreaterThan(0.009) // four intervals into the outside usage: 0.009375
  expect(results[11]!.k).toBeCloseTo(0.02, 4)
  expect(results[14]!.o).toBeLessThan(0.0012) // three clean intervals later
})

test("an interval with little gateway cost does not teach k but still updates o", () => {
  const reads = history(6, { ratio: () => 0.02, cost: 10 })
  const quiet: ReadPoint = { at: reads.at(-1)!.at + 6 * H, share: reads.at(-1)!.share + 0.06, entitlement: 1000, unlimited: false, costTotalUsd: reads.at(-1)!.costTotalUsd + 0.2 }
  const before = run(reads).params
  const after = learn({ prev: before, reads: [...reads, quiet], learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: null })
  expect(after.k).toBeCloseTo(before.k!, 6)
  expect(after.kSamples).toBe(before.kSamples)
  expect(after.o).toBeGreaterThan(before.o)
})

test("the prediction error is the estimate before the read minus the real share, in percentage points", () => {
  const reads = history(3, {})
  const result = learn({ prev: params(), reads, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: reads.at(-1)!.share + 0.05 })
  expect(result.errorPoints).toBeCloseTo(5, 6)
  const first = learn({ prev: { k: null, kSamples: 0, o: 0 }, reads: reads.slice(0, 1), learnSince: 0, previousEntitlement: null, estimatedShareBefore: null })
  expect(first.errorPoints).toBeNull()
})

test("intervals that cross the monthly reset or show a falling share teach nothing", () => {
  const read = (at: number, share: number, cost: number): ReadPoint => ({ at, share, entitlement: 1000, unlimited: false, costTotalUsd: cost })
  const reads = [read(Date.UTC(2026, 10, 29), 0.7, 0), read(Date.UTC(2026, 10, 30, 18), 0.9, 10), read(Date.UTC(2026, 11, 1, 6), 0.02, 20), read(Date.UTC(2026, 11, 1, 12), 0.1, 24)]
  const { params: p } = run(reads)
  expect(p.kSamples).toBe(2) // Nov 29 -> Nov 30 and Dec 1 06:00 -> 12:00 only
})

test("an entitlement change drops the spanning interval, rescales k and o by old/new, restarts the window and clears the error", () => {
  const before = history(5, { ratio: () => 0.02 })
  const changeAt = before.at(-1)!.at + 6 * H
  const afterChange: ReadPoint = { at: changeAt, share: (before.at(-1)!.share + 0.2) / 2, entitlement: 2000, unlimited: false, costTotalUsd: before.at(-1)!.costTotalUsd + 10 }
  const start = run(before).params
  const result = learn({ prev: { ...start, o: 0.002 }, reads: [...before, afterChange], learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: 0.9 })
  expect(result.entitlementChange).toEqual({ from: 1000, to: 2000 })
  expect(result.k).toBeCloseTo(0.01, 6)
  expect(result.o).toBeCloseTo(0.001, 9)
  expect(result.kSamples).toBe(0)
  expect(result.errorPoints).toBeNull()
  expect(result.learnSince).toBe(changeAt)
})

test("after an entitlement change only the intervals after it are used, and with few of them the estimate stays conservative", () => {
  const entitlement = (i: number) => (i <= 5 ? 1000 : 2000)
  const reads = history(8, { entitlement, ratio: i => (i <= 5 ? 0.02 : 0.01) })
  const { params: p, learnSince } = run(reads)
  expect(learnSince).toBe(reads[6]!.at)
  expect(p.k).toBeCloseTo(0.01, 4)
  expect(p.kSamples).toBe(2) // reads 6 -> 7 and 7 -> 8; the interval 5 -> 6 spans the change
  expect(effectiveK(p)).toBe(DEFAULT_K_SHARE_PER_USD)
})

test("an unlimited read leaves the parameters alone", () => {
  const reads = [...history(3, {}), { at: T0 + 30 * H, share: 0, entitlement: 0, unlimited: true, costTotalUsd: 40 }]
  const result = learn({ prev: params(), reads, learnSince: 0, previousEntitlement: 1000, estimatedShareBefore: 0.4 })
  expect(result).toMatchObject({ k: 0.02, kSamples: 5, o: 0.001, errorPoints: null, entitlementChange: null })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/gateway/tests/quota-estimator.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the estimator**

```ts
// packages/gateway/src/quota-balance/estimator.ts
import { COST_BUCKET_MS, type CostBucket } from "../repo/quota-balance.ts"
import { HOUR_MS, hoursLeftInMonth, monthKey, monthStartMs } from "./time.ts"

/**
 * Share of the allowance per gateway USD assumed for a member that has not taught us its own k yet. Deliberately high (errs towards
 * "more used"); set from the Task 1 findings: 1 / (smallest plan's monthly allowance in USD), rounded up to one significant digit.
 */
export const DEFAULT_K_SHARE_PER_USD = 0.1
export const MIN_K_SAMPLES = 3
export const K_WINDOW_MS = 7 * 24 * HOUR_MS
export const K_HALF_LIFE_MS = 24 * HOUR_MS
export const K_QUANTILE = 0.25
export const K_MIN_INTERVAL_COST_USD = 1
export const O_ALPHA = 0.5
export const O_MIN_INTERVAL_HOURS = 0.5
export const BURN_TAU_MS = HOUR_MS

export interface EstimatorParams {
  /** Share per gateway USD; null until learned. */
  k: number | null
  /** Usable intervals behind `k`. */
  kSamples: number
  /** Outside usage, share per hour. */
  o: number
}
export interface ReadPoint { at: number; share: number; entitlement: number; unlimited: boolean; costTotalUsd: number }

/** Learned k, or at least the fallback while there are fewer than MIN_K_SAMPLES intervals: an under-estimate must not send sessions to a nearly exhausted account. */
export function effectiveK(params: Pick<EstimatorParams, "k" | "kSamples">, fallback: number = DEFAULT_K_SHARE_PER_USD): number {
  if (params.k === null) return fallback
  return params.kSamples >= MIN_K_SAMPLES ? params.k : Math.max(params.k, fallback)
}

export interface EstimateInput {
  lastRead: { at: number; share: number; unlimited: boolean } | null
  params: EstimatorParams
  /** Gateway cost since the last read. */
  costSinceReadUsd: number
  /** Gateway cost since the start of this UTC month (the base after a reset). */
  monthCostUsd: number
  now: number
  kFallback?: number
}
export interface Estimate { known: boolean; unlimited: boolean; usedShare: number }

export function estimateShare(input: EstimateInput): Estimate {
  const { lastRead, params, now } = input
  if (!lastRead) return { known: false, unlimited: false, usedShare: 0 }
  if (lastRead.unlimited) return { known: true, unlimited: true, usedShare: 0 }
  const k = effectiveK(params, input.kFallback)
  const monthStart = monthStartMs(now)
  if (lastRead.at < monthStart) {
    return { known: true, unlimited: false, usedShare: k * Math.max(0, input.monthCostUsd) + params.o * Math.max(0, now - monthStart) / HOUR_MS }
  }
  return { known: true, unlimited: false, usedShare: lastRead.share + k * Math.max(0, input.costSinceReadUsd) + params.o * Math.max(0, now - lastRead.at) / HOUR_MS }
}

/** Gateway spend per hour, exponentially weighted (time constant 1 h) over the given 10-minute buckets. */
export function burnRateUsdPerHour(buckets: readonly CostBucket[], now: number): number {
  let weighted = 0
  for (const bucket of buckets) {
    const age = Math.max(0, now - (bucket.bucket + 0.5) * COST_BUCKET_MS)
    weighted += bucket.costUsd * Math.exp(-age / BURN_TAU_MS)
  }
  return weighted / (BURN_TAU_MS / HOUR_MS)
}

export interface ProjectInput {
  usedShare: number
  params: EstimatorParams
  burnUsdPerHour: number
  burnHorizonHours: number
  now: number
  kFallback?: number
  unlimited?: boolean
}
/** Projected month-end share: used + outside rate x hours left + k x recent burn x horizon. */
export function projectShare(input: ProjectInput): number {
  if (input.unlimited) return 0
  const k = effectiveK(input.params, input.kFallback)
  return input.usedShare + input.params.o * hoursLeftInMonth(input.now) + k * input.burnUsdPerHour * input.burnHorizonHours
}

export function weightedQuantile(samples: ReadonlyArray<{ value: number; weight: number }>, q: number): number | null {
  if (samples.length === 0) return null
  const sorted = [...samples].sort((a, b) => a.value - b.value)
  const total = sorted.reduce((sum, sample) => sum + sample.weight, 0)
  let cumulative = 0
  for (const sample of sorted) {
    cumulative += sample.weight
    if (cumulative >= q * total - 1e-12) return sample.value
  }
  return sorted[sorted.length - 1]!.value
}

interface Interval { from: ReadPoint; to: ReadPoint; dCost: number; dShare: number; hours: number }
const entitlementChanged = (a: number, b: number): boolean => Math.abs(a - b) > 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1)

/** Consecutive reads that can teach: after `learnSince`, same entitlement, same UTC month, share not falling, metered. */
function usableIntervals(reads: readonly ReadPoint[], learnSince: number): Interval[] {
  const out: Interval[] = []
  for (let i = 1; i < reads.length; i++) {
    const from = reads[i - 1]!
    const to = reads[i]!
    if (from.unlimited || to.unlimited || from.at < learnSince) continue
    if (entitlementChanged(from.entitlement, to.entitlement) || monthKey(from.at) !== monthKey(to.at)) continue
    const dShare = to.share - from.share
    const dCost = to.costTotalUsd - from.costTotalUsd
    if (dShare < 0 || dCost < 0) continue
    out.push({ from, to, dCost, dShare, hours: (to.at - from.at) / HOUR_MS })
  }
  return out
}

export interface LearnInput {
  prev: EstimatorParams
  /** Reads of the member, oldest first, the new read last (at least the last seven days). */
  reads: readonly ReadPoint[]
  /** Reads before this instant do not count (restart after an entitlement change). */
  learnSince: number
  /** Entitlement of the previous read (the state before the new read); null for the first read. */
  previousEntitlement: number | null
  /** Estimated share just before the new read; null when the member was unknown. */
  estimatedShareBefore: number | null
  kFallback?: number
}
export interface LearnResult extends EstimatorParams {
  /** Percentage points: estimate before the read minus the real share; null when not comparable. */
  errorPoints: number | null
  learnSince: number
  entitlementChange: { from: number; to: number } | null
}

export function learn(input: LearnInput): LearnResult {
  const newest = input.reads[input.reads.length - 1]
  if (!newest) throw new Error("learn needs the new read")
  const { prev } = input
  if (newest.unlimited) return { ...prev, errorPoints: null, learnSince: input.learnSince, entitlementChange: null }
  if (input.previousEntitlement !== null && input.previousEntitlement > 0 && entitlementChanged(input.previousEntitlement, newest.entitlement)) {
    // The same credits are a different share of the new total; relearn from here with the conservative bias.
    const scale = input.previousEntitlement / newest.entitlement
    return {
      k: prev.k === null ? null : prev.k * scale, kSamples: 0, o: prev.o * scale, errorPoints: null, learnSince: newest.at,
      entitlementChange: { from: input.previousEntitlement, to: newest.entitlement },
    }
  }
  const hasPrevious = input.reads.length > 1
  const errorPoints = input.estimatedShareBefore === null || !hasPrevious ? null : (input.estimatedShareBefore - newest.share) * 100
  const samples = usableIntervals(input.reads, input.learnSince)
    .filter(i => i.dCost >= K_MIN_INTERVAL_COST_USD && newest.at - i.to.at <= K_WINDOW_MS)
    .map(i => ({ value: i.dShare / i.dCost, weight: Math.pow(0.5, (newest.at - i.to.at) / K_HALF_LIFE_MS) }))
  const k = weightedQuantile(samples, K_QUANTILE) ?? prev.k
  const kSamples = samples.length
  let o = prev.o
  const last = usableIntervals(input.reads.slice(-2), input.learnSince)[0]
  if (last && last.hours >= O_MIN_INTERVAL_HOURS) {
    const residual = Math.max(0, last.dShare - effectiveK({ k, kSamples }, input.kFallback) * last.dCost) / last.hours
    o = O_ALPHA * residual + (1 - O_ALPHA) * prev.o
  }
  return { k, kSamples, o, errorPoints, learnSince: input.learnSince, entitlementChange: null }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/quota-estimator.test.ts`
Expected: PASS (14 tests). If the price-change or o-tracking numbers differ in the last digit, the arithmetic of the helper `history` is the first suspect (shares are rebuilt from credits); do not loosen the constants in `estimator.ts` to fit.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/quota-balance/estimator.ts packages/gateway/tests/quota-estimator.test.ts
git commit -m "feat(quota-balance): adaptive share estimator with k and o learning and entitlement changes" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 6: Read scheduler (pure): adaptive interval, jitter, floors, backoff, triggers

**Files:**
- Create: `packages/gateway/src/quota-balance/read-schedule.ts`
- Create: `packages/gateway/tests/quota-read-schedule.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-read-schedule.test.ts
import { expect, test } from "bun:test"
import {
  MANUAL_MIN_READ_GAP_MS, MIN_READ_GAP_MS, backoffHours, nextIntervalHours, readAllowedAt, readDecision, scheduleNextRead, type SchedState,
} from "../src/quota-balance/read-schedule"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"

const H = 3_600_000
const M = 60_000
const NOW = Date.UTC(2026, 10, 10, 12)
const settings = { ...DEFAULT_GROUP_SETTINGS }
const state = (over: Partial<SchedState> = {}): SchedState => ({ lastReadAt: NOW - 3 * H, lastReadShare: 0.4, lastAttemptAt: NOW - 3 * H, nextReadAt: NOW + 3 * H, failures: 0, unlimited: false, ...over })
const decide = (s: SchedState, estimatedShare: number, extra: { manual?: boolean; settings?: Partial<typeof settings>; now?: number } = {}) =>
  readDecision({ now: extra.now ?? NOW, state: s, estimatedShare, settings: { ...settings, ...extra.settings }, manual: extra.manual })

test("the interval halves after a large error (floor 1 h) and grows back by 1.5x after small errors (cap at the setting)", () => {
  expect(nextIntervalHours(6, 6.1, 6)).toBe(3)
  expect(nextIntervalHours(6, -5.5, 6)).toBe(3)
  expect(nextIntervalHours(1.5, 9, 6)).toBe(1)
  expect(nextIntervalHours(1, 9, 6)).toBe(1)
  expect(nextIntervalHours(3, 1, 6)).toBe(4.5)
  expect(nextIntervalHours(4.5, -2.9, 6)).toBe(6)
  expect(nextIntervalHours(3, 4, 6)).toBe(3)
  expect(nextIntervalHours(3, null, 6)).toBe(3)
  expect(nextIntervalHours(8, 4, 6)).toBe(6)
})

test("failed reads back off 1 h, 2 h, 4 h, capped at the read interval", () => {
  expect([1, 2, 3, 4, 5].map(f => backoffHours(f, 6))).toEqual([1, 2, 4, 6, 6])
  expect(backoffHours(3, 2)).toBe(2)
})

test("the next read is the interval plus up to 30 minutes of jitter either way, never sooner than the floor, and no later than the first read of next month", () => {
  expect(scheduleNextRead(NOW, 6, () => 0.5)).toBe(NOW + 6 * H)
  expect(scheduleNextRead(NOW, 6, () => 0)).toBe(NOW + 6 * H - 30 * M)
  expect(scheduleNextRead(NOW, 6, () => 1)).toBe(NOW + 6 * H + 30 * M)
  expect(scheduleNextRead(NOW, 1, () => 0)).toBe(NOW + MIN_READ_GAP_MS)
  const lateNovember = Date.UTC(2026, 10, 30, 23)
  const draws = [0.5, 0.5]
  expect(scheduleNextRead(lateNovember, 6, () => draws.shift() ?? 0.5)).toBe(Date.UTC(2026, 11, 1) + 15 * M)
})

test("a member that was never read is read once (join); a scheduled read is due when its time has come", () => {
  expect(decide(state({ lastReadAt: null, lastReadShare: null, lastAttemptAt: null, nextReadAt: NOW }), 0)).toEqual({ read: true, reason: "join", blockedUntil: null })
  expect(decide(state(), 0.4)).toEqual({ read: false, reason: null, blockedUntil: null })
  expect(decide(state({ nextReadAt: NOW - 1 }), 0.4)).toEqual({ read: true, reason: "scheduled", blockedUntil: null })
})

test("the floor is one hour from the last attempt, ten minutes for a manual read, and a failed attempt counts", () => {
  const recent = state({ lastAttemptAt: NOW - 30 * M, nextReadAt: NOW - 1 })
  expect(decide(recent, 0.4)).toEqual({ read: false, reason: "scheduled", blockedUntil: NOW + 30 * M })
  expect(decide(state({ lastAttemptAt: NOW - 15 * M }), 0.4, { manual: true })).toEqual({ read: true, reason: "manual", blockedUntil: null })
  expect(decide(state({ lastAttemptAt: NOW - 5 * M }), 0.4, { manual: true })).toEqual({ read: false, reason: "manual", blockedUntil: NOW + 5 * M })
  expect(readAllowedAt(state({ lastAttemptAt: NOW, failures: 2 }), settings, false)).toBe(NOW + 2 * H)
  expect(readAllowedAt(state({ lastAttemptAt: NOW, failures: 2 }), settings, true)).toBe(NOW + MANUAL_MIN_READ_GAP_MS)
  expect(readAllowedAt(state({ lastAttemptAt: null }), settings, false)).toBe(0)
})

test("early triggers: drift, confirm, soft line and hard line fire when the estimate crosses them and the last read had not", () => {
  expect(decide(state({ lastReadShare: 0.40 }), 0.51).reason).toBe("drift")
  expect(decide(state({ lastReadShare: 0.40 }), 0.49).reason).toBeNull()
  const wide = { softShare: 0.95, hardShare: 0.98 }
  expect(decide(state({ lastReadShare: 0.85 }), 0.92, { settings: wide }).reason).toBe("confirm")
  expect(decide(state({ lastReadShare: 0.85 }), 0.96, { settings: wide }).reason).toBe("soft")
  expect(decide(state({ lastReadShare: 0.85 }), 0.99, { settings: wide }).reason).toBe("hard")
  // A real read already at or above the line makes a confirming read pointless.
  expect(decide(state({ lastReadShare: 0.96 }), 0.97).reason).toBeNull()
  expect(decide(state({ lastReadShare: 0.92 }), 0.96).reason).toBe("hard")
})

test("the first read after the monthly reset is due in the jitter window, from a state whose last read is from the previous month", () => {
  const novemberNow = Date.UTC(2026, 11, 1, 0, 20)
  const s = state({ lastReadAt: Date.UTC(2026, 10, 30, 22), lastReadShare: 0.9, lastAttemptAt: Date.UTC(2026, 10, 30, 22), nextReadAt: Date.UTC(2026, 11, 1, 0, 15) })
  expect(decide(s, 0.05, { now: novemberNow }).reason).toBe("monthly")
  expect(decide(s, 0.05, { now: Date.UTC(2026, 11, 1, 0, 5) }).reason).toBeNull()
})

test("an unlimited member has no early triggers", () => {
  expect(decide(state({ unlimited: true, lastReadShare: 0 }), 0.99).reason).toBeNull()
  expect(decide(state({ unlimited: true, nextReadAt: NOW - 1 }), 0).reason).toBe("scheduled")
})

test("under any mix of triggers a read is never allowed inside the floors", () => {
  let seed = 12345
  const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296
  for (let i = 0; i < 2000; i++) {
    const s = state({
      lastReadAt: rnd() < 0.1 ? null : NOW - rnd() * 30 * H, lastReadShare: rnd(), lastAttemptAt: rnd() < 0.1 ? null : NOW - rnd() * 3 * H,
      nextReadAt: NOW + (rnd() - 0.5) * 12 * H, failures: Math.floor(rnd() * 5), unlimited: rnd() < 0.1,
    })
    const manual = rnd() < 0.3
    const d = decide(s, rnd() * 1.2, { manual })
    if (d.read) expect(NOW).toBeGreaterThanOrEqual(readAllowedAt(s, settings, manual))
    if (!d.read && d.reason !== null) expect(d.blockedUntil).toBe(readAllowedAt(s, settings, manual))
  }
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/gateway/tests/quota-read-schedule.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/quota-balance/read-schedule.ts
import type { GroupSettings } from "../repo/quota-balance.ts"
import { HOUR_MS, MINUTE_MS, monthStartMs, nextMonthStartMs } from "./time.ts"

/** Never two reads of one member closer than this (a failed attempt counts). */
export const MIN_READ_GAP_MS = HOUR_MS
/** Floor for a manual refresh and for the page-open read. */
export const MANUAL_MIN_READ_GAP_MS = 10 * MINUTE_MS
export const MIN_INTERVAL_HOURS = 1
export const JITTER_MS = 30 * MINUTE_MS

export type ReadReason = "manual" | "join" | "monthly" | "hard" | "soft" | "confirm" | "drift" | "scheduled"

/** After |error| > 5 points the interval halves (floor 1 h); after |error| < 3 points it grows by 1.5x up to the setting. */
export function nextIntervalHours(previous: number, errorPoints: number | null, maxHours: number): number {
  const clamp = (hours: number) => Math.max(MIN_INTERVAL_HOURS, Math.min(maxHours, hours))
  if (errorPoints === null) return clamp(previous)
  const size = Math.abs(errorPoints)
  if (size > 5) return clamp(previous / 2)
  if (size < 3) return clamp(previous * 1.5)
  return clamp(previous)
}

/** 1 h, 2 h, 4 h ... after consecutive failures, capped at the read interval. */
export function backoffHours(failures: number, maxHours: number): number {
  return Math.min(Math.max(MIN_INTERVAL_HOURS, maxHours), 2 ** Math.max(0, failures - 1))
}

/** `now + interval` with up to 30 minutes of jitter either way, at least the floor away, and not later than the first read of next month (00:00 UTC on the 1st plus 0-30 minutes). */
export function scheduleNextRead(now: number, intervalHours: number, random: () => number): number {
  const jitter = (random() * 2 - 1) * JITTER_MS
  const planned = Math.max(now + MIN_READ_GAP_MS, now + intervalHours * HOUR_MS + jitter)
  return Math.min(planned, nextMonthStartMs(now) + random() * JITTER_MS)
}

export interface SchedState {
  lastReadAt: number | null
  lastReadShare: number | null
  lastAttemptAt: number | null
  nextReadAt: number
  failures: number
  unlimited: boolean
}
type Lines = Pick<GroupSettings, "softShare" | "hardShare" | "confirmShare" | "driftShare" | "readIntervalHours">

/** The earliest instant a read of this member is allowed. */
export function readAllowedAt(state: SchedState, settings: Pick<GroupSettings, "readIntervalHours">, manual: boolean): number {
  if (state.lastAttemptAt === null) return 0
  if (manual) return state.lastAttemptAt + MANUAL_MIN_READ_GAP_MS
  const gap = state.failures > 0 ? Math.max(MIN_READ_GAP_MS, backoffHours(state.failures, settings.readIntervalHours) * HOUR_MS) : MIN_READ_GAP_MS
  return state.lastAttemptAt + gap
}

export interface ReadDecision {
  read: boolean
  /** What asks for the read, also when the floor blocks it. */
  reason: ReadReason | null
  /** When the floor lets the read through; null unless blocked. */
  blockedUntil: number | null
}

export function readDecision(input: { now: number; state: SchedState; estimatedShare: number; settings: Lines; manual?: boolean }): ReadDecision {
  const { now, state, settings } = input
  const manual = input.manual === true
  const trigger = manual ? "manual" : triggerOf(now, state, input.estimatedShare, settings)
  if (trigger === null) return { read: false, reason: null, blockedUntil: null }
  const allowedAt = readAllowedAt(state, settings, manual)
  return now >= allowedAt ? { read: true, reason: trigger, blockedUntil: null } : { read: false, reason: trigger, blockedUntil: allowedAt }
}

function triggerOf(now: number, state: SchedState, estimate: number, settings: Lines): ReadReason | null {
  if (state.lastReadAt === null) return "join"
  const monthly = state.lastReadAt < monthStartMs(now)
  if (monthly && now >= state.nextReadAt) return "monthly"
  if (!state.unlimited) {
    // A read from an earlier month says nothing about this month's share.
    const base = monthly ? 0 : state.lastReadShare ?? 0
    const crossed = (line: number) => estimate >= line && base < line
    if (crossed(settings.hardShare)) return "hard"
    if (crossed(settings.softShare)) return "soft"
    if (crossed(settings.confirmShare)) return "confirm"
    if (Math.abs(estimate - base) > settings.driftShare) return "drift"
  }
  return now >= state.nextReadAt ? "scheduled" : null
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/quota-read-schedule.test.ts`
Expected: PASS (8 tests). In the jitter test with `lateNovember` the two draws are `0.5` (no jitter) and `0.5` (15 minutes into the monthly window).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/quota-balance/read-schedule.ts packages/gateway/tests/quota-read-schedule.test.ts
git commit -m "feat(quota-balance): read scheduler with adaptive interval, floors, backoff and triggers" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 7: Selection (pure): rendezvous hash, tolerance band, heavy sessions, sticky/idle/forced rules, group state

**Files:**
- Create: `packages/gateway/src/quota-balance/selection.ts`
- Create: `packages/gateway/tests/quota-selection.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-selection.test.ts
import { expect, test } from "bun:test"
import { groupState, planGroupChoice, rankMembers, rendezvousScore, decayedRecentCost, type AssignmentView, type MemberView } from "../src/quota-balance/selection"
import { burnRateUsdPerHour, projectShare } from "../src/quota-balance/estimator"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"

const H = 3_600_000
const M = 60_000
const NOW = Date.UTC(2026, 10, 10, 12)
const S = { ...DEFAULT_GROUP_SETTINGS }
const member = (upstreamId: string, usedShare: number, projectedShare: number, known = true): MemberView => ({ upstreamId, usedShare, projectedShare, known })
const keyWhere = (wins: string, over: string): string => {
  for (let i = 0; i < 5000; i++) { const key = `k${i}`; if (rendezvousScore(key, wins) > rendezvousScore(key, over)) return key }
  throw new Error("no key found")
}
const assignment = (over: Partial<AssignmentView> = {}): AssignmentView =>
  ({ upstreamId: "A", lastSeenAt: NOW - M, movedAt: NOW - 20 * H, recentCostUsd: 0, recentCostAt: NOW, ...over })

test("the rendezvous score is stable, differs per member and spreads sessions evenly over equal members", () => {
  expect(rendezvousScore("session", "A")).toBe(rendezvousScore("session", "A"))
  expect(rendezvousScore("session", "A")).not.toBe(rendezvousScore("session", "B"))
  let a = 0
  for (let i = 0; i < 2000; i++) if (rendezvousScore(`s${i}`, "A") > rendezvousScore(`s${i}`, "B")) a++
  expect(a).toBeGreaterThan(900)
  expect(a).toBeLessThan(1100)
})

test("the member with the lowest projected share wins when the others are more than the tolerance above it", () => {
  const members = [member("A", 0.2, 0.30), member("B", 0.2, 0.36), member("C", 0.2, 0.50)]
  for (let i = 0; i < 20; i++) expect(rankMembers({ members, settings: S, sessionKey: `k${i}`, heavy: false, ignoreSoft: false })[0]).toBe("A")
})

test("members within the tolerance band count as equal and the stable hash of the session decides; the rest follow as fallbacks", () => {
  const members = [member("A", 0.2, 0.30), member("B", 0.2, 0.34), member("C", 0.2, 0.50)]
  const aWins = keyWhere("A", "B")
  const bWins = keyWhere("B", "A")
  expect(rankMembers({ members, settings: S, sessionKey: aWins, heavy: false, ignoreSoft: false })).toEqual(["A", "B", "C"])
  expect(rankMembers({ members, settings: S, sessionKey: bWins, heavy: false, ignoreSoft: false })).toEqual(["B", "A", "C"])
})

test("a heavy session is placed without the band: the single lowest member", () => {
  const members = [member("A", 0.2, 0.30), member("B", 0.2, 0.34)]
  const bWins = keyWhere("B", "A")
  expect(rankMembers({ members, settings: S, sessionKey: bWins, heavy: true, ignoreSoft: false })[0]).toBe("A")
})

test("an account used heavily outside the gateway, or running heavy sessions right now, receives fewer new sessions", () => {
  const now = Date.UTC(2026, 10, 10)
  const base = { params: { k: 0.02, kSamples: 5, o: 0 }, now, burnHorizonHours: 6 }
  const quiet = member("quiet", 0.3, projectShare({ ...base, usedShare: 0.3, burnUsdPerHour: 0 }))
  const outside = member("outside", 0.3, projectShare({ ...base, params: { k: 0.02, kSamples: 5, o: 0.001 }, usedShare: 0.3, burnUsdPerHour: 0 }))
  const burning = member("burning", 0.3, projectShare({ ...base, usedShare: 0.3, burnUsdPerHour: burnRateUsdPerHour([{ bucket: Math.floor(now / 600_000) - 1, costUsd: 5 }], now) }))
  const wins: Record<string, number> = { quiet: 0, outside: 0, burning: 0 }
  for (let i = 0; i < 300; i++) {
    const first = rankMembers({ members: [quiet, outside, burning], settings: S, sessionKey: `s${i}`, heavy: false, ignoreSoft: false })[0]!
    wins[first] = (wins[first] ?? 0) + 1
  }
  expect(wins.quiet).toBe(300)
  expect(projectShare({ ...base, params: { k: 0.02, kSamples: 5, o: 0.001 }, usedShare: 0.3, burnUsdPerHour: 0 })).toBeGreaterThan(0.3 + 0.2)
  expect(burning.projectedShare).toBeGreaterThan(quiet.projectedShare)
})

test("members at or above the soft line, and members without a read, take no new sessions; overage ignores the soft line but still needs a read", () => {
  const members = [member("A", 0.91, 0.5), member("B", 0.5, 0.9), member("U", 0, 0, false)]
  expect(rankMembers({ members, settings: S, sessionKey: "k", heavy: false, ignoreSoft: false })).toEqual(["B"])
  expect(rankMembers({ members, settings: S, sessionKey: "k", heavy: false, ignoreSoft: true })[0]).toBe("A")
  expect(rankMembers({ members, settings: S, sessionKey: "k", heavy: false, ignoreSoft: true })).not.toContain("U")
  expect(rankMembers({ members: [member("A", 0.95, 0.5)], settings: S, sessionKey: "k", heavy: false, ignoreSoft: false })).toEqual([])
})

test("a new session is assigned; an existing one stays (assigned member first); an assignment to a member that is no longer eligible is replaced", () => {
  const members = [member("A", 0.5, 0.60), member("B", 0.2, 0.30)]
  const fresh = planGroupChoice({ assignment: null, members, settings: S, sessionKey: "k1", now: NOW })
  expect(fresh).toMatchObject({ kind: "assign", reason: "new" })
  expect(fresh.kind === "assign" && fresh.ordered[0]).toBe("B")
  const close = [member("A", 0.4, 0.35), member("B", 0.2, 0.30)]
  expect(planGroupChoice({ assignment: assignment(), members: close, settings: S, sessionKey: "k1", now: NOW })).toEqual({ kind: "keep", ordered: ["A", "B"] })
  const gone = planGroupChoice({ assignment: assignment({ upstreamId: "X" }), members, settings: S, sessionKey: "k1", now: NOW })
  expect(gone).toMatchObject({ kind: "assign", reason: "invalid" })
})

test("the soft line alone does not move an existing session", () => {
  const members = [member("A", 0.92, 0.95), member("B", 0.89, 0.92)]
  expect(planGroupChoice({ assignment: assignment(), members, settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "keep", ordered: ["A", "B"] })
})

test("a session that resumes after the idle time is re-chosen for free, a heavy one without the band", () => {
  const members = [member("A", 0.5, 0.34), member("B", 0.2, 0.30)]
  const idle = assignment({ lastSeenAt: NOW - 11 * M })
  const aWins = keyWhere("A", "B")
  const normal = planGroupChoice({ assignment: idle, members, settings: S, sessionKey: aWins, now: NOW })
  expect(normal).toMatchObject({ kind: "assign", reason: "idle" })
  expect(normal.kind === "assign" && normal.ordered[0]).toBe("A") // inside the band: the hash decides, possibly the same member
  const heavy = planGroupChoice({ assignment: { ...idle, recentCostUsd: 6, recentCostAt: NOW }, members, settings: S, sessionKey: aWins, now: NOW })
  expect(heavy.kind === "assign" && heavy.ordered[0]).toBe("B")
  expect(planGroupChoice({ assignment: assignment({ lastSeenAt: NOW - 9 * M }), members, settings: S, sessionKey: aWins, now: NOW }).kind).toBe("keep")
  // With nobody below the soft line an idle session stays where it is.
  const full = [member("A", 0.92, 0.95), member("B", 0.93, 0.96)]
  expect(planGroupChoice({ assignment: idle, members: full, settings: S, sessionKey: "k", now: NOW }).kind).toBe("keep")
})

test("recent spend decays with a one hour time constant", () => {
  expect(decayedRecentCost({ recentCostUsd: 6, recentCostAt: NOW - H }, NOW)).toBeCloseTo(6 * Math.exp(-1))
  expect(decayedRecentCost({ recentCostUsd: 6, recentCostAt: NOW }, NOW)).toBe(6)
})

test("a forced move needs a projected gap above migrateShare and a quiet period since the last move; it costs one cache miss and is rare", () => {
  const members = [member("A", 0.5, 0.60), member("B", 0.2, 0.40)]
  const moved = planGroupChoice({ assignment: assignment(), members, settings: S, sessionKey: "k", now: NOW })
  expect(moved).toMatchObject({ kind: "assign", reason: "forced" })
  expect(moved.kind === "assign" && moved.ordered[0]).toBe("B")
  expect(planGroupChoice({ assignment: assignment({ movedAt: NOW - 2 * H }), members, settings: S, sessionKey: "k", now: NOW }).kind).toBe("keep")
  expect(planGroupChoice({ assignment: assignment(), members: [member("A", 0.5, 0.49), member("B", 0.2, 0.40)], settings: S, sessionKey: "k", now: NOW }).kind).toBe("keep")
})

test("when nobody is below the soft line: stop skips the group for a new session, overage serves it", () => {
  const members = [member("A", 0.92, 0.95), member("B", 0.93, 0.96)]
  expect(planGroupChoice({ assignment: null, members, settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "skip" })
  const overage = planGroupChoice({ assignment: null, members, settings: { ...S, exhaustedPolicy: "overage" }, sessionKey: keyWhere("A", "B"), now: NOW })
  expect(overage).toMatchObject({ kind: "assign", reason: "new" })
  expect(overage.kind === "assign" && overage.ordered[0]).toBe("A")
})

test("group state for the dashboard: normal, stopped or overage; a group without any read is not reported as stopped", () => {
  expect(groupState([member("A", 0.5, 0.6)], S)).toBe("normal")
  expect(groupState([member("A", 0.95, 0.99)], S)).toBe("stopped")
  expect(groupState([member("A", 0.95, 0.99)], { ...S, exhaustedPolicy: "overage" })).toBe("overage")
  expect(groupState([member("U", 0, 0, false)], S)).toBe("normal")
  expect(groupState([], S)).toBe("normal")
})

test("a group with a single eligible member skips only the ranking: the soft line and the hard line still apply", () => {
  const one = [member("A", 0.5, 0.6)]
  expect(rankMembers({ members: one, settings: S, sessionKey: "k", heavy: false, ignoreSoft: false })).toEqual(["A"])
  expect(planGroupChoice({ assignment: null, members: one, settings: S, sessionKey: "k", now: NOW })).toMatchObject({ kind: "assign", reason: "new", ordered: ["A"] })
  // The only member sits at the soft line: no new session under stop, served under overage.
  const atSoft = [member("A", 0.91, 0.95)]
  expect(planGroupChoice({ assignment: null, members: atSoft, settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "skip" })
  expect(planGroupChoice({ assignment: null, members: atSoft, settings: { ...S, exhaustedPolicy: "overage" }, sessionKey: "k", now: NOW })).toMatchObject({ kind: "assign", ordered: ["A"] })
  // An existing session stays on its single member even above the soft line.
  expect(planGroupChoice({ assignment: assignment(), members: atSoft, settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "keep", ordered: ["A"] })
  // A single member that was cut off at the hard line never reaches the selection (it is not a candidate), so nothing is chosen.
  expect(planGroupChoice({ assignment: null, members: [], settings: S, sessionKey: "k", now: NOW })).toEqual({ kind: "skip" })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/gateway/tests/quota-selection.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/quota-balance/selection.ts
import type { GroupSettings, SessionAssignment } from "../repo/quota-balance.ts"
import { HOUR_MS, MINUTE_MS } from "./time.ts"

/** One eligible group member as the selection sees it. Shares only: used and projected month-end share of the member's own allowance. */
export interface MemberView { upstreamId: string; usedShare: number; projectedShare: number; known: boolean }

/** cyrb53: a small stable 53-bit hash; the rendezvous score of a member for a session. */
export function rendezvousScore(sessionKey: string, upstreamId: string): number {
  const text = `${sessionKey}\u0000${upstreamId}`
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

export interface RankArgs {
  members: readonly MemberView[]
  settings: Pick<GroupSettings, "toleranceShare" | "softShare">
  sessionKey: string
  /** No tolerance band: the single lowest member. */
  heavy: boolean
  ignoreSoft: boolean
}

/**
 * Member ids in the order to try them: first the band (projected share within `toleranceShare` of the minimum, highest rendezvous score first),
 * then the others by projected share. Members without a read, and (unless `ignoreSoft`) members at or above the soft line, are left out.
 */
export function rankMembers(args: RankArgs): string[] {
  const pool = args.members.filter(m => m.known && (args.ignoreSoft || m.usedShare < args.settings.softShare))
  if (pool.length === 0) return []
  const min = Math.min(...pool.map(m => m.projectedShare))
  const limit = min + (args.heavy ? 0 : args.settings.toleranceShare) + 1e-12
  const score = (m: MemberView) => rendezvousScore(args.sessionKey, m.upstreamId)
  const band = pool.filter(m => m.projectedShare <= limit).sort((a, b) => score(b) - score(a))
  const rest = pool.filter(m => m.projectedShare > limit).sort((a, b) => a.projectedShare - b.projectedShare || score(b) - score(a))
  return [...band, ...rest].map(m => m.upstreamId)
}

export type AssignmentView = Pick<SessionAssignment, "upstreamId" | "lastSeenAt" | "movedAt" | "recentCostUsd" | "recentCostAt">
/** The session's gateway spend per hour: an exponentially weighted (1 h) sum decayed to `now`. */
export const decayedRecentCost = (a: Pick<SessionAssignment, "recentCostUsd" | "recentCostAt">, now: number): number =>
  a.recentCostUsd * Math.exp(-Math.max(0, now - a.recentCostAt) / HOUR_MS)

export type AssignReason = "new" | "invalid" | "idle" | "forced"
export type GroupChoice =
  | { kind: "skip" }
  /** Keep the session where it is: the assigned member first, the others as fallbacks. */
  | { kind: "keep"; ordered: string[] }
  | { kind: "assign"; reason: AssignReason; ordered: string[] }

export interface PlanArgs {
  assignment: AssignmentView | null
  /** The group's eligible members for this request. */
  members: readonly MemberView[]
  settings: GroupSettings
  sessionKey: string
  now: number
}

/** Spec "Assignment": steps 1-3 for one group. A `heavySessionUsdPerHour` of 0 switches heavy-session handling off. */
export function planGroupChoice(args: PlanArgs): GroupChoice {
  const { assignment, members, settings, now } = args
  const ignoreSoft = settings.exhaustedPolicy === "overage"
  const rank = (heavy: boolean) => rankMembers({ members, settings, sessionKey: args.sessionKey, heavy, ignoreSoft })
  const assigned = assignment ? members.find(m => m.upstreamId === assignment.upstreamId) : undefined
  if (!assignment || !assigned) {
    const ordered = rank(false)
    return ordered.length === 0 ? { kind: "skip" } : { kind: "assign", reason: assignment ? "invalid" : "new", ordered }
  }
  const keep = (): GroupChoice => ({ kind: "keep", ordered: [assigned.upstreamId, ...rank(false).filter(id => id !== assigned.upstreamId)] })
  // Idle rebalance: the upstream prompt cache is cold, so choosing again is free.
  if (now - assignment.lastSeenAt > settings.idleRebalanceMinutes * MINUTE_MS) {
    const heavy = settings.heavySessionUsdPerHour > 0 && decayedRecentCost(assignment, now) >= settings.heavySessionUsdPerHour
    const ordered = rank(heavy)
    return ordered.length > 0 ? { kind: "assign", reason: "idle", ordered } : keep()
  }
  // Forced move: one cache miss, only when the member is far above the lowest one and was not moved recently.
  const known = members.filter(m => m.known)
  const lowest = known.length > 0 ? Math.min(...known.map(m => m.projectedShare)) : assigned.projectedShare
  if (assigned.projectedShare - lowest > settings.migrateShare && now - assignment.movedAt >= settings.migrateMinHours * HOUR_MS) {
    const ordered = rank(false)
    if (ordered.length > 0 && ordered[0] !== assigned.upstreamId) return { kind: "assign", reason: "forced", ordered }
  }
  return keep()
}

export type GroupState = "normal" | "stopped" | "overage"
/** For the dashboard: no member can take a new session (`stopped`, or `overage` under that policy). Not reported while no member has been read yet. */
export function groupState(members: readonly MemberView[], settings: Pick<GroupSettings, "softShare" | "exhaustedPolicy">): GroupState {
  if (!members.some(m => m.known)) return "normal"
  if (members.some(m => m.known && m.usedShare < settings.softShare)) return "normal"
  return settings.exhaustedPolicy === "overage" ? "overage" : "stopped"
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/quota-selection.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/quota-balance/selection.ts packages/gateway/tests/quota-selection.test.ts
git commit -m "feat(quota-balance): member selection with band, rendezvous hash, idle and forced moves" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 8: Per-isolate caches: group directory, session assignments, member facts

**Files:**
- Create: `packages/gateway/src/quota-balance/deps.ts`
- Create: `packages/gateway/src/quota-balance/directory.ts`
- Create: `packages/gateway/src/quota-balance/assignments.ts`
- Create: `packages/gateway/src/quota-balance/facts.ts`
- Create: `packages/gateway/tests/quota-caches-fixture.ts`
- Create: `packages/gateway/tests/quota-caches.test.ts`

- [ ] **Step 1: Write the shared fixture and the failing tests**

```ts
// packages/gateway/tests/quota-caches-fixture.ts
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import type { QuotaDeps } from "../src/quota-balance/deps"
import { DEFAULT_GROUP_SETTINGS, type UpstreamGroup } from "../src/repo/quota-balance"

export const T0 = Date.UTC(2026, 10, 10, 12)
export const gid = (n: number) => `ug_${n.toString(16).padStart(32, "0")}`

export interface Fixture {
  db: Database
  repo: BunSqliteRepo
  clock: { now: number }
  pending: Array<Promise<unknown>>
  deps: QuotaDeps
  idle: () => Promise<void>
  close: () => void
  addUpstream: (id: string, owner?: string) => void
  addGroup: (n: number, over?: Partial<UpstreamGroup>) => Promise<UpstreamGroup>
}

/** A real SQLite repo with an injected clock; background work is collected and awaited with `idle()`. */
export function quotaFixture(): Fixture {
  const db = new Database(":memory:")
  const repo = new BunSqliteRepo(db)
  const clock = { now: T0 }
  const pending: Array<Promise<unknown>> = []
  const deps: QuotaDeps = { repo: () => repo, now: () => clock.now, schedule: work => { pending.push(work.catch(() => {})) }, random: () => 0.5 }
  return {
    db, repo, clock, pending, deps,
    idle: async () => { while (pending.length) await Promise.all(pending.splice(0)) },
    close: () => db.close(),
    addUpstream: (id, owner = "user_test_o") => {
      db.run(`INSERT INTO upstreams (catalog_generation, credential_generation, row_incarnation, id, owner_id, provider, name, enabled, sort_order, config_json, flag_overrides, disabled_public_model_ids, state_json, proxy_fallback_list_json, created_at, updated_at)
              VALUES (0, 0, 'r', ?, ?, 'copilot', ?, 1, 0, '{}', '{}', '[]', NULL, '[]', 'now', 'now')`, [id, owner, id])
    },
    addGroup: async (n, over = {}) => {
      const group: UpstreamGroup = { id: gid(n), ownerId: "user_test_o", name: `Group ${n}`, enabled: true, sortOrder: n, settings: { ...DEFAULT_GROUP_SETTINGS }, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", ...over }
      await repo.quotaBalance.createGroup(group)
      return group
    },
  }
}
```

```ts
// packages/gateway/tests/quota-caches.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { GroupDirectoryCache } from "../src/quota-balance/directory"
import { AssignmentStore, touchIntervalMs } from "../src/quota-balance/assignments"
import { MemberFactsCache, kFallbackOf, viewMembers } from "../src/quota-balance/facts"
import { DEFAULT_K_SHARE_PER_USD } from "../src/quota-balance/estimator"
import { DEFAULT_GROUP_SETTINGS, type NewQuotaRead } from "../src/repo/quota-balance"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

const H = 3_600_000
let f: Fixture
beforeEach(() => { f = quotaFixture() })
afterEach(() => f.close())

const read = (upstreamId: string, at: number, used: number, entitlement = 1000): NewQuotaRead =>
  ({ upstreamId, at, source: "github", used, entitlement, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: "premium_interactions", resetAt: null, costAdjustUsd: 0, entitlementChange: null })

test("the directory maps members to their group, serves a stale copy while it refreshes in the background, and fails open", async () => {
  const dir = new GroupDirectoryCache(f.deps, 10_000)
  expect((await dir.get()).memberOf.size).toBe(0)
  await f.addGroup(1)
  f.addUpstream("up_test_a")
  await f.repo.quotaBalance.setMembership("up_test_a", gid(1), { nowMs: T0, intervalHours: 6 })
  expect((await dir.get()).memberOf.size).toBe(0) // within the TTL: still the old answer
  f.clock.now += 11_000
  expect((await dir.get()).memberOf.size).toBe(0) // stale answer, refresh scheduled
  await f.idle()
  const fresh = await dir.get()
  expect(fresh.memberOf.get("up_test_a")).toBe(gid(1))
  expect(fresh.groups.get(gid(1))?.name).toBe("Group 1")
  await f.repo.quotaBalance.deleteGroup(gid(1))
  expect((await dir.get({ fresh: true })).memberOf.size).toBe(0)

  const broken = new GroupDirectoryCache({ ...f.deps, repo: () => { throw new Error("storage down") } }, 10_000)
  expect((await broken.get()).groups.size).toBe(0)
})

test("a membership row that points at a missing group is ignored", async () => {
  f.addUpstream("up_test_a")
  f.db.run("UPDATE upstreams SET group_id = ? WHERE id = 'up_test_a'", [gid(9)])
  expect((await new GroupDirectoryCache(f.deps).get()).memberOf.size).toBe(0)
})

test("assignments: a put is visible at once and stored in the background; a touch is written only when the touch interval has passed", async () => {
  await f.addGroup(1)
  const store = new AssignmentStore(f.deps)
  const a = { groupId: gid(1), sessionKey: "s1", upstreamId: "up_test_a", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 }
  store.put(a)
  expect(await store.get(gid(1), "s1")).toEqual(a)
  await f.idle()
  expect(await f.repo.quotaBalance.getAssignment(gid(1), "s1")).toEqual(a)
  const interval = touchIntervalMs(DEFAULT_GROUP_SETTINGS.idleRebalanceMinutes)
  expect(interval).toBe(2 * 60_000)
  f.clock.now = T0 + 60_000
  store.touch(a, f.clock.now, interval)
  await f.idle()
  expect((await f.repo.quotaBalance.getAssignment(gid(1), "s1"))?.lastSeenAt).toBe(T0) // too soon to write
  expect((await store.get(gid(1), "s1"))?.lastSeenAt).toBe(T0 + 60_000) // the cache is exact
  f.clock.now = T0 + 3 * 60_000
  store.touch(a, f.clock.now, interval)
  await f.idle()
  expect((await f.repo.quotaBalance.getAssignment(gid(1), "s1"))?.lastSeenAt).toBe(T0 + 3 * 60_000)
  expect(await store.get(gid(1), "missing")).toBeNull()
})

test("the touch interval is a fifth of the idle time, between 30 s and 10 min", () => {
  expect(touchIntervalMs(10)).toBe(120_000)
  expect(touchIntervalMs(1)).toBe(30_000)
  expect(touchIntervalMs(120)).toBe(600_000)
})

test("session spend decays over an hour and accumulates", async () => {
  await f.addGroup(1)
  const store = new AssignmentStore(f.deps)
  store.put({ groupId: gid(1), sessionKey: "s", upstreamId: "up_test_a", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
  expect(store.addCost(gid(1), "s", 2, T0)).toEqual({ recentCostUsd: 2, recentCostAt: T0 })
  const later = store.addCost(gid(1), "s", 1, T0 + H)!
  expect(later.recentCostUsd).toBeCloseTo(2 * Math.exp(-1) + 1)
  expect(store.addCost(gid(1), "unknown", 1, T0)).toBeNull()
})

test("member facts: loaded together, local cost shows at once and is not counted twice after the next load", async () => {
  await f.addGroup(1)
  f.addUpstream("up_test_a"); f.addUpstream("up_test_b")
  for (const id of ["up_test_a", "up_test_b"]) await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 })
  await f.repo.quotaBalance.recordRead(read("up_test_a", T0, 100), T0)
  const cache = new MemberFactsCache(f.deps, 20_000)
  let facts = await cache.get(["up_test_a", "up_test_b"])
  expect(facts.get("up_test_a")!.state?.lastReadShare).toBe(0.1)
  expect(facts.get("up_test_b")!.state?.lastReadAt).toBeNull()
  cache.addLocalCost("up_test_a", 3)
  facts = await cache.get(["up_test_a"])
  expect(facts.get("up_test_a")!.costSinceReadUsd).toBeCloseTo(3)
  expect(facts.get("up_test_a")!.burnBuckets.reduce((sum, b) => sum + b.costUsd, 0)).toBeCloseTo(3)
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0, costUsd: 3, monthKey: "2026-11" }) // the same cost reaches the database
  f.clock.now += 21_000
  await cache.get(["up_test_a"], { fresh: true })
  expect((await cache.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBeCloseTo(3)
  cache.addLocalCost("up_test_a", 1)
  expect((await cache.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBeCloseTo(4)
})

test("member facts fail open to empty facts", async () => {
  const cache = new MemberFactsCache({ ...f.deps, repo: () => { throw new Error("down") } })
  const facts = await cache.get(["up_test_x"])
  expect(facts.get("up_test_x")).toEqual({ state: null, costSinceReadUsd: 0, monthCostUsd: 0, burnBuckets: [] })
})

test("views: an unread member is unknown, a read member's used and projected shares follow the estimator, the fallback k is the median of learned members", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) { f.addUpstream(id); await f.repo.quotaBalance.setMembership(id, gid(1), { nowMs: T0, intervalHours: 6 }) }
  await f.repo.quotaBalance.recordRead(read("up_test_a", T0, 500), T0)
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0 + H, costUsd: 5, monthKey: "2026-11" })
  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)
  await f.repo.quotaBalance.saveEstimator("up_test_b", { k: 0.04, kPrev: null, kSamples: 4, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)
  const cache = new MemberFactsCache(f.deps)
  const ids = ["up_test_a", "up_test_b", "up_test_c"]
  const facts = await cache.get(ids)
  expect(kFallbackOf(ids.map(id => facts.get(id)!.state))).toBeCloseTo(0.03)
  expect(kFallbackOf([null])).toBe(DEFAULT_K_SHARE_PER_USD)
  const views = viewMembers(ids, facts, { burnHorizonHours: 0 }, T0 + H)
  expect(views[0]).toMatchObject({ upstreamId: "up_test_a", known: true })
  expect(views[0]!.usedShare).toBeCloseTo(0.5 + 0.02 * 5)
  expect(views[1]!.known).toBe(false)
  expect(views[2]).toMatchObject({ known: false, usedShare: 0 })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/gateway/tests/quota-caches.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/quota-balance/deps.ts
import { getRepo } from "../repo/index.ts"
import type { Repo } from "../repo/types.ts"
import { scheduleBackground } from "../protection/runtime.ts"

/** Injectable collaborators of every quota-balance class: tests pass a fake clock, a collecting scheduler and a fixed random. */
export interface QuotaDeps {
  repo: () => Repo
  /** Unix ms. */
  now: () => number
  schedule: (work: Promise<unknown>) => void
  random: () => number
}
export const defaultDeps = (): QuotaDeps => ({ repo: getRepo, now: Date.now, schedule: scheduleBackground, random: Math.random })
export const warn = (evt: string, error?: unknown): void => { console.warn(JSON.stringify({ evt, error: error instanceof Error ? error.name : "unknown" })) }
```

```ts
// packages/gateway/src/quota-balance/directory.ts
import type { UpstreamGroup } from "../repo/quota-balance.ts"
import { warn, type QuotaDeps } from "./deps.ts"

export interface GroupDirectory {
  groups: ReadonlyMap<string, UpstreamGroup>
  /** upstream id -> group id */
  memberOf: ReadonlyMap<string, string>
}
export const EMPTY_DIRECTORY: GroupDirectory = { groups: new Map(), memberOf: new Map() }

/**
 * Groups and memberships for the data plane. A cold cache waits for its first load; a stale one answers at once and refreshes in the
 * background (one load in flight). Fail-open: a failed load keeps the previous answer (or "no groups"), so a storage problem never blocks routing.
 */
export class GroupDirectoryCache {
  private cache: { at: number; value: GroupDirectory } | null = null
  private inflight: Promise<void> | null = null

  constructor(private readonly deps: QuotaDeps, readonly ttlMs = 10_000) {}

  async get(options: { fresh?: boolean } = {}): Promise<GroupDirectory> {
    const now = this.deps.now()
    if (!this.cache || options.fresh) await this.refresh(now)
    else if (now - this.cache.at >= this.ttlMs && !this.inflight) this.deps.schedule(this.refresh(now))
    return this.cache?.value ?? EMPTY_DIRECTORY
  }

  /** The next `get` waits for a fresh load (this isolate just changed a group or a membership). */
  invalidate(): void { this.cache = null }

  private refresh(now: number): Promise<void> {
    if (this.inflight) return this.inflight
    const work: Promise<void> = this.load(now).finally(() => { if (this.inflight === work) this.inflight = null })
    this.inflight = work
    return work
  }

  private async load(now: number): Promise<void> {
    try {
      const repo = this.deps.repo().quotaBalance
      const [groups, memberships] = await Promise.all([repo.listGroups(), repo.listMemberships()])
      const byId = new Map(groups.map(group => [group.id, group]))
      const memberOf = new Map<string, string>()
      for (const membership of memberships) if (byId.has(membership.groupId)) memberOf.set(membership.upstreamId, membership.groupId)
      this.cache = { at: now, value: { groups: byId, memberOf } }
    } catch (error) {
      warn("quota_directory_refresh_failed", error)
      this.cache = { at: now, value: this.cache?.value ?? EMPTY_DIRECTORY }
    }
  }
}
```

```ts
// packages/gateway/src/quota-balance/assignments.ts
import type { SessionAssignment } from "../repo/quota-balance.ts"
import { HOUR_MS, MINUTE_MS } from "./time.ts"
import { warn, type QuotaDeps } from "./deps.ts"

/** `last_seen_at` is written at most this often: a fifth of the idle time (30 s .. 10 min), so a stale stored value can not make an active session look idle. */
export const touchIntervalMs = (idleRebalanceMinutes: number): number => Math.min(10 * MINUTE_MS, Math.max(30_000, (idleRebalanceMinutes * MINUTE_MS) / 5))

interface Entry { value: SessionAssignment; loadedAt: number; writtenAt: number }

/** Session -> member assignments with a per-isolate LRU cache (60 s TTL). Writes go to the database in the background. */
export class AssignmentStore {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly deps: QuotaDeps, private readonly max = 2000, readonly ttlMs = 60_000) {}

  private static key(groupId: string, sessionKey: string): string { return `${groupId}\u0000${sessionKey}` }

  private remember(key: string, entry: Entry): void {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  async get(groupId: string, sessionKey: string): Promise<SessionAssignment | null> {
    const key = AssignmentStore.key(groupId, sessionKey)
    const now = this.deps.now()
    const hit = this.entries.get(key)
    if (hit && now - hit.loadedAt < this.ttlMs) { this.remember(key, hit); return hit.value }
    try {
      const row = await this.deps.repo().quotaBalance.getAssignment(groupId, sessionKey)
      if (!row) { this.entries.delete(key); return null }
      // The cache holds the exact last-seen time and spend; the stored copy may lag by the touch interval.
      const value = hit && hit.value.lastSeenAt > row.lastSeenAt ? { ...row, lastSeenAt: hit.value.lastSeenAt, recentCostUsd: hit.value.recentCostUsd, recentCostAt: hit.value.recentCostAt } : row
      this.remember(key, { value, loadedAt: now, writtenAt: row.lastSeenAt })
      return value
    } catch (error) {
      warn("quota_assignment_read_failed", error)
      return hit?.value ?? null
    }
  }

  /** Insert or replace: visible at once, stored in the background. */
  put(assignment: SessionAssignment): void {
    const now = this.deps.now()
    this.remember(AssignmentStore.key(assignment.groupId, assignment.sessionKey), { value: assignment, loadedAt: now, writtenAt: now })
    this.deps.schedule(this.deps.repo().quotaBalance.putAssignment(assignment).catch(error => warn("quota_assignment_write_failed", error)))
  }

  /** Marks the session seen now; the database write happens at most once per `intervalMs`. */
  touch(assignment: SessionAssignment, now: number, intervalMs: number): void {
    const key = AssignmentStore.key(assignment.groupId, assignment.sessionKey)
    const entry = this.entries.get(key) ?? { value: assignment, loadedAt: now, writtenAt: assignment.lastSeenAt }
    entry.value = { ...entry.value, lastSeenAt: Math.max(entry.value.lastSeenAt, now) }
    if (now - entry.writtenAt >= intervalMs) {
      entry.writtenAt = now
      this.deps.schedule(this.deps.repo().quotaBalance.touchAssignment(assignment.groupId, assignment.sessionKey, now).catch(error => warn("quota_assignment_write_failed", error)))
    }
    this.remember(key, entry)
  }

  /** Adds a request's cost to the cached session spend (decayed to `now`); null when the session is not cached (nothing to attribute). */
  addCost(groupId: string, sessionKey: string, costUsd: number, now: number): { recentCostUsd: number; recentCostAt: number } | null {
    const key = AssignmentStore.key(groupId, sessionKey)
    const entry = this.entries.get(key)
    if (!entry) return null
    const decayed = entry.value.recentCostUsd * Math.exp(-Math.max(0, now - entry.value.recentCostAt) / HOUR_MS)
    entry.value = { ...entry.value, recentCostUsd: decayed + costUsd, recentCostAt: now }
    return { recentCostUsd: entry.value.recentCostUsd, recentCostAt: now }
  }
}
```

```ts
// packages/gateway/src/quota-balance/facts.ts
import { COST_BUCKET_MS, type GroupSettings, type MemberFacts, type QuotaState } from "../repo/quota-balance.ts"
import { DEFAULT_K_SHARE_PER_USD, MIN_K_SAMPLES, burnRateUsdPerHour, estimateShare, projectShare, type Estimate, type EstimatorParams } from "./estimator.ts"
import { warn, type QuotaDeps } from "./deps.ts"
import type { MemberView } from "./selection.ts"
import { monthKey } from "./time.ts"

const EMPTY_FACTS: MemberFacts = { state: null, costSinceReadUsd: 0, monthCostUsd: 0, burnBuckets: [] }

/**
 * Estimator state and gateway cost of group members, per isolate (20 s TTL). The cost this isolate records itself is added at once
 * (`addLocalCost`), so balancing sees the gateway's own traffic immediately; costs recorded before a load started are assumed to be in its result.
 * A cold id waits for its load; a stale one is served and refreshed in the background. Fail-open to empty facts.
 */
export class MemberFactsCache {
  private readonly entries = new Map<string, { facts: MemberFacts; at: number; localAtLoad: number }>()
  private readonly local = new Map<string, number>()

  constructor(private readonly deps: QuotaDeps, readonly ttlMs = 20_000) {}

  async get(ids: readonly string[], options: { fresh?: boolean } = {}): Promise<Map<string, MemberFacts>> {
    const now = this.deps.now()
    const cold = ids.filter(id => options.fresh || !this.entries.has(id))
    const stale = ids.filter(id => !cold.includes(id) && now - this.entries.get(id)!.at >= this.ttlMs)
    if (cold.length > 0) await this.load(cold, now)
    if (stale.length > 0) this.deps.schedule(this.load(stale, now))
    return new Map(ids.map(id => [id, this.view(id, now)]))
  }

  addLocalCost(upstreamId: string, costUsd: number): void { this.local.set(upstreamId, (this.local.get(upstreamId) ?? 0) + costUsd) }
  invalidate(upstreamId?: string): void { if (upstreamId === undefined) this.entries.clear(); else this.entries.delete(upstreamId) }

  private view(id: string, now: number): MemberFacts {
    const entry = this.entries.get(id)
    if (!entry) return EMPTY_FACTS
    const delta = Math.max(0, (this.local.get(id) ?? 0) - entry.localAtLoad)
    if (delta === 0) return entry.facts
    const bucket = Math.floor(now / COST_BUCKET_MS)
    return {
      state: entry.facts.state,
      costSinceReadUsd: entry.facts.costSinceReadUsd + delta,
      monthCostUsd: entry.facts.monthCostUsd + delta,
      burnBuckets: [...entry.facts.burnBuckets, { bucket, costUsd: delta }],
    }
  }

  private async load(ids: readonly string[], now: number): Promise<void> {
    const started = new Map(ids.map(id => [id, this.local.get(id) ?? 0]))
    try {
      const loaded = await this.deps.repo().quotaBalance.loadFacts(ids, now, monthKey(now))
      for (const id of ids) this.entries.set(id, { facts: loaded.get(id) ?? EMPTY_FACTS, at: now, localAtLoad: started.get(id) ?? 0 })
    } catch (error) {
      warn("quota_facts_refresh_failed", error)
      for (const id of ids) this.entries.set(id, { facts: this.entries.get(id)?.facts ?? EMPTY_FACTS, at: now, localAtLoad: started.get(id) ?? 0 })
    }
  }
}

/** The `k` to assume for a member that has not learned its own: the median of the learned ones in the group, else the global default. */
export function kFallbackOf(states: ReadonlyArray<QuotaState | null>): number {
  const learned = states.flatMap(state => state && state.k !== null && state.kSamples >= MIN_K_SAMPLES ? [state.k] : []).sort((a, b) => a - b)
  if (learned.length === 0) return DEFAULT_K_SHARE_PER_USD
  const middle = Math.floor(learned.length / 2)
  return learned.length % 2 === 1 ? learned[middle]! : (learned[middle - 1]! + learned[middle]!) / 2
}

export const paramsOf = (state: QuotaState | null): EstimatorParams => ({ k: state?.k ?? null, kSamples: state?.kSamples ?? 0, o: state?.o ?? 0 })

/** Estimated used share of one member now (from the facts), with the parameters it used. */
export function memberEstimate(facts: MemberFacts | undefined, now: number, kFallback: number): Estimate & { params: EstimatorParams } {
  const state = facts?.state ?? null
  const params = paramsOf(state)
  const estimate = estimateShare({
    lastRead: state && state.lastReadAt !== null ? { at: state.lastReadAt, share: state.lastReadShare ?? 0, unlimited: state.lastReadUnlimited } : null,
    params, costSinceReadUsd: facts?.costSinceReadUsd ?? 0, monthCostUsd: facts?.monthCostUsd ?? 0, now, kFallback,
  })
  return { ...estimate, params }
}

/** Selection views (shares only) of the given members. */
export function viewMembers(ids: readonly string[], facts: ReadonlyMap<string, MemberFacts>, settings: Pick<GroupSettings, "burnHorizonHours">, now: number): MemberView[] {
  const kFallback = kFallbackOf(ids.map(id => facts.get(id)?.state ?? null))
  return ids.map(id => {
    const f = facts.get(id)
    const estimate = memberEstimate(f, now, kFallback)
    const projectedShare = projectShare({
      usedShare: estimate.usedShare, params: estimate.params, burnUsdPerHour: burnRateUsdPerHour(f?.burnBuckets ?? [], now),
      burnHorizonHours: settings.burnHorizonHours, now, kFallback, unlimited: estimate.unlimited,
    })
    return { upstreamId: id, known: estimate.known, usedShare: estimate.usedShare, projectedShare }
  })
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/quota-caches.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck and commit**

Run: `bun run --filter '@vibe-llm/gateway' typecheck`
Expected: no errors.

```bash
git add packages/gateway/src/quota-balance/deps.ts packages/gateway/src/quota-balance/directory.ts packages/gateway/src/quota-balance/assignments.ts packages/gateway/src/quota-balance/facts.ts packages/gateway/tests/quota-caches-fixture.ts packages/gateway/tests/quota-caches.test.ts
git commit -m "feat(quota-balance): group directory, assignment store and member facts caches" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 9: Hard cut-off through protection pauses (`trigger: "quota"`), recovery and wording

> **Estimator contract (added after the Task 4-6 review).** A provisional cut-off on the estimate is allowed only through `provisionalCutoffAllowed({ kLearned, estimatedShare, unlimited, settings })` (`read-schedule.ts`); `kLearned` comes from `estimateShare(...).kLearned` (k learned from at least 3 intervals). With the fallback k, reaching the hard line cuts nothing: it only asks for an immediate read (floor permitting). `QuotaCutoff.apply` with `source: "estimate"` must refuse unless the caller passes `kLearned: true`; add a test for the refusal.

**Files:**
- Modify: `packages/gateway/src/repo/protection.ts` (`PauseReason`, ~L68-L82)
- Modify: `packages/gateway/src/protection/runtime.ts` (add `insertExternal`, after `evaluate`, ~L150)
- Modify: `packages/gateway/src/protection/messages.ts` (`pausedRoute`, ~L21-L39)
- Create: `packages/gateway/src/quota-balance/cutoff.ts`
- Create: `packages/gateway/tests/quota-cutoff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/tests/quota-cutoff.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { ProtectionRuntime } from "../src/protection/runtime"
import { pausedRoute } from "../src/protection/messages"
import { QuotaCutoff } from "../src/quota-balance/cutoff"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

let f: Fixture
let protection: ProtectionRuntime
let cutoff: QuotaCutoff
beforeEach(async () => {
  f = quotaFixture()
  f.addUpstream("up_test_a")
  await f.addGroup(1)
  protection = new ProtectionRuntime({ repo: () => f.repo, now: () => f.clock.now, schedule: work => { f.pending.push(work.catch(() => {})) }, cacheTtlMs: 0 })
  cutoff = new QuotaCutoff(f.deps, () => protection)
})
afterEach(() => f.close())

const input = (over: Partial<Parameters<QuotaCutoff["apply"]>[0]> = {}) =>
  ({ upstreamId: "up_test_a", groupId: gid(1), groupName: "Group 1", hardShare: 0.95, share: 0.96, source: "real" as const, kLearned: true, readAt: T0 - 3_600_000, ...over })

test("a real read at or above the hard line pauses the member until the next monthly reset and the pause is enforced at once", async () => {
  expect(await cutoff.apply(input())).toBe("cut")
  const paused = await protection.pausedUpstreams()
  const row = paused.get("up_test_a")!
  expect(row).toMatchObject({ mode: "pause", targetKind: "upstream", endsAt: Date.UTC(2026, 11, 1) })
  expect(row.reason).toMatchObject({ trigger: "quota", upstreamName: "up_test_a", quota: { groupId: gid(1), groupName: "Group 1", share: 0.96, hardShare: 0.95, source: "real", provisional: false } })
  expect(await cutoff.apply(input())).toBe("none") // already cut off
})

test("the estimate with a fallback k (not learned) never cuts a member off, however high it is", async () => {
  expect(await cutoff.apply(input({ share: 0.99, source: "estimate", kLearned: false }))).toBe("none")
  expect(await cutoff.apply(input({ share: 0.99, source: "estimate", kLearned: undefined }))).toBe("none")
  expect((await protection.pausedUpstreams()).size).toBe(0)
  expect(await cutoff.apply(input({ share: 0.99, source: "estimate" }))).toBe("cut") // learned k: provisional cut-off
})

test("a read below the line lifts the pause (a plan upgrade); an estimate never lifts it", async () => {
  await cutoff.apply(input())
  expect(await cutoff.apply(input({ share: 0.5, source: "estimate" }))).toBe("none")
  expect((await protection.pausedUpstreams()).size).toBe(1)
  expect(await cutoff.apply(input({ share: 0.5 }))).toBe("lifted")
  expect((await protection.pausedUpstreams()).size).toBe(0)
  const [history] = await f.repo.protection.listPauses("up_test_a", 5)
  expect(history).toMatchObject({ resolvedBy: "auto" })
})

test("the estimate reaching the line cuts the member provisionally; the next real read confirms it or lifts it", async () => {
  expect(await cutoff.apply(input({ share: 0.97, source: "estimate" }))).toBe("cut")
  expect((await protection.pausedUpstreams()).get("up_test_a")!.reason.quota).toMatchObject({ provisional: true, source: "estimate" })
  expect(await cutoff.apply(input({ share: 0.97, source: "estimate" }))).toBe("none")
  expect(await cutoff.apply(input({ share: 0.96 }))).toBe("cut") // confirmed: the provisional row is replaced by a real one
  const row = (await protection.pausedUpstreams()).get("up_test_a")!
  expect(row.reason.quota).toMatchObject({ provisional: false, source: "real" })
  expect(await f.repo.protection.listPauses("up_test_a", 5)).toHaveLength(2)

  await cutoff.apply(input({ share: 0.5 }))
  expect(await cutoff.apply(input({ share: 0.97, source: "estimate" }))).toBe("cut")
  expect(await cutoff.apply(input({ share: 0.6 }))).toBe("lifted") // not confirmed
})

test("an owner resume suppresses a provisional cut-off until a real read at the line cuts again", async () => {
  await cutoff.apply(input())
  const row = (await protection.pausedUpstreams()).get("up_test_a")!
  f.clock.now += 60_000
  expect(await protection.resume(row.id, "owner")).toBe(true)
  expect((await protection.pausedUpstreams()).size).toBe(0)
  expect(await cutoff.apply(input({ share: 0.99, source: "estimate" }))).toBe("none")
  expect(await cutoff.apply(input({ share: 0.99, source: "real", readAt: f.clock.now }))).toBe("cut")
})

test("the 503 wording names the usage allowance for a quota pause and keeps the error-flood wording otherwise", async () => {
  await cutoff.apply(input())
  const paused = await protection.pausedUpstreams()
  const route = pausedRoute(["up_test_a"], paused, f.clock.now)!
  expect(route.message).toContain("monthly usage allowance")
  expect(route.message).not.toContain("error flood")
  expect(route.retryAfterSeconds).toBe(Math.ceil((Date.UTC(2026, 11, 1) - f.clock.now) / 1000))
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/gateway/tests/quota-cutoff.test.ts`
Expected: FAIL, module `../src/quota-balance/cutoff` not found.

- [ ] **Step 3: Extend the pause reason type**

In `packages/gateway/src/repo/protection.ts` replace the `PauseReason` interface with:

```ts
/** Why a member of a quota-balancing group was cut off (`trigger: "quota"`); the flood fields of such a reason are zero. */
export interface QuotaPauseInfo {
  groupId: string
  groupName: string
  /** Used share that crossed the line. */
  share: number
  hardShare: number
  /** `estimate`: the line was crossed by the estimator before a read could confirm it. */
  source: "real" | "estimate"
  provisional: boolean
}
export interface PauseReason {
  windowMinutes: number
  requests: number
  risky: number
  counts: Omit<ClassCounts, "requests">
  failureRatio: number
  topKeys: Array<{ keyId: string; risky: number }>
  trigger: "ratio" | "authBurst" | "quota"
  /** Share of the risky errors caused by the attributed key, when there is one. */
  keyShare: number | null
  upstreamName?: string
  targetName?: string
  quota?: QuotaPauseInfo
}
```

(`repo/shared/protection.ts` stores and parses the reason as JSON, so `quota` round-trips without a change.)

- [ ] **Step 4: Add `insertExternal` to the protection runtime and the quota wording**

In `packages/gateway/src/protection/runtime.ts`, inside `ProtectionRuntime` after `evaluate`:

```ts
  /**
   * Inserts a pause that was not detected from error counts (the quota hard line). False/null when an unresolved, unexpired row
   * of the same target already covers it. This isolate enforces the new row at once; others see it within `cacheTtlMs`.
   */
  async insertExternal(pause: NewPause): Promise<PauseRecord | null> {
    if (!(await this.repo().protection.insertPauseIfNone(pause, this.now()))) return null
    const created: PauseRecord = { ...pause, resolvedAt: null, resolvedBy: null }
    this.localEdit(rows => [...rows.filter(row => row.id !== created.id), created])
    return created
  }
```

In `packages/gateway/src/protection/messages.ts` replace the returned object of `pausedRoute` so the cause follows the trigger (the flood wording is unchanged):

```ts
  const plural = rows.length > 1
  const allQuota = rows.every(row => row.reason.trigger === "quota")
  const cause = allQuota
    ? "paused because the monthly usage allowance is nearly used up"
    : rows.some(row => row.reason.trigger === "quota")
      ? "paused (nearly used-up monthly usage allowance or error flood)"
      : "paused to protect the account after an error flood"
  return {
    retryAfterSeconds: seconds,
    message: `${subject} ${plural ? "are" : "is"} ${cause}; service resumes at ${new Date(resumesAt).toISOString()}. Retry after ${seconds} seconds.`,
  }
```

- [ ] **Step 5: Implement the cut-off**

```ts
// packages/gateway/src/quota-balance/cutoff.ts
import type { NewPause, PauseReason, PauseRecord } from "../repo/protection.ts"
import type { UpstreamId } from "../repo/branded-ids.ts"
import { getProtection, type ProtectionRuntime } from "../protection/runtime.ts"
import type { QuotaDeps } from "./deps.ts"
import { provisionalCutoffAllowed } from "./read-schedule.ts"
import { nextMonthStartMs } from "./time.ts"

export interface CutoffInput {
  upstreamId: string
  groupId: string
  groupName: string
  hardShare: number
  /** Used share: the real read's, or the estimate's. */
  share: number
  source: "real" | "estimate"
  /** Whether k is learned (`estimateShare(...).kLearned`); an estimate cut-off is refused otherwise. */
  kLearned?: boolean
  /** The last real read's time (limits how far back an owner resume counts for a provisional cut-off). */
  readAt: number | null
}
export type CutoffResult = "cut" | "lifted" | "none"

const ZERO_COUNTS = { rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }

/**
 * The hard line: a member at or above `hardShare` gets a protection pause (reason `quota`) that ends at the next 00:00 UTC on the 1st,
 * so routing skips it like any paused upstream and the member returns at the reset by expiry. A real read below the line resolves the pause;
 * the estimate may cut provisionally but never lifts. An owner resume holds back a provisional cut-off until a real read is at the line again.
 */
export class QuotaCutoff {
  constructor(private readonly deps: QuotaDeps, private readonly protection: () => ProtectionRuntime = getProtection) {}

  async activeQuotaPause(upstreamId: string): Promise<PauseRecord | null> {
    const rows = await this.deps.repo().protection.listActive(this.deps.now())
    return rows.find(row => row.mode === "pause" && row.targetKind === "upstream" && row.targetId === upstreamId && row.reason.trigger === "quota") ?? null
  }

  async apply(input: CutoffInput): Promise<CutoffResult> {
    // With the fallback k the estimate may order members and ask for a read, but must not cut a member off, and never lifts.
    if (input.source === "estimate" && !provisionalCutoffAllowed({ kLearned: input.kLearned === true, estimatedShare: input.share, unlimited: false, settings: { hardShare: input.hardShare } })) return "none"
    const protection = this.protection()
    const active = await this.activeQuotaPause(input.upstreamId)
    if (input.share < input.hardShare) {
      if (active && input.source === "real") { await protection.resume(active.id, "auto"); return "lifted" }
      return "none"
    }
    if (active) {
      // A real read confirms a provisional cut-off: replace it by a confirmed row. Anything else is already cut off.
      if (input.source === "real" && active.reason.quota?.provisional) await protection.resume(active.id, "auto")
      else return "none"
    }
    if (input.source === "estimate") {
      const resumed = await this.deps.repo().protection.lastOwnerResolvedAt(input.upstreamId, input.readAt ?? 0)
      if (resumed !== null) return "none"
    }
    const now = this.deps.now()
    let upstreamName: string | undefined
    try { upstreamName = (await this.deps.repo().upstreams.getById(input.upstreamId as UpstreamId))?.name } catch { /* optional */ }
    const reason: PauseReason = {
      windowMinutes: 0, requests: 0, risky: 0, counts: ZERO_COUNTS, failureRatio: 0, topKeys: [], trigger: "quota", keyShare: null,
      ...(upstreamName ? { upstreamName, targetName: upstreamName } : {}),
      quota: { groupId: input.groupId, groupName: input.groupName, share: input.share, hardShare: input.hardShare, source: input.source, provisional: input.source === "estimate" },
    }
    const pause: NewPause = {
      id: `pp_${crypto.randomUUID().replace(/-/g, "")}`, targetKind: "upstream", targetId: input.upstreamId, upstreamId: input.upstreamId, mode: "pause",
      reason, startedAt: now, endsAt: nextMonthStartMs(now),
    }
    return (await protection.insertExternal(pause)) ? "cut" : "none"
  }
}
```

- [ ] **Step 6: Run the tests (new and existing protection tests)**

Run: `bun test packages/gateway/tests/quota-cutoff.test.ts packages/gateway/tests/protection-paused-render.test.ts packages/gateway/tests/protection-cache.test.ts packages/gateway/tests/protection-evaluate.test.ts`
Expected: PASS. The existing flood wording tests are unchanged.

Run: `bun run --filter '@vibe-llm/gateway' typecheck` — expected: no errors (the dashboard's own `PauseReason` is updated in Task 19).

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/repo/protection.ts packages/gateway/src/protection/runtime.ts packages/gateway/src/protection/messages.ts packages/gateway/src/quota-balance/cutoff.ts packages/gateway/tests/quota-cutoff.test.ts
git commit -m "feat(quota-balance): hard-line cut-off as a protection pause with recovery" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 10: Quota reader: read through the member's own credential and proxy chain, learn, schedule, calibrate, evaluate

> **Estimator contract (added after the Task 4-6 review).** `learn` takes the new read explicitly (`read`; `reads` may contain back-dated points in any order), `ReadPoint` carries `snapshotKey` and `unitForm` (stored as `quota_reads.snapshot_key` / `unit_form`, from `ParsedQuota`; manual reads use null), and the state keeps `o_samples` (`EstimatorPatch.oSamples`, from `LearnResult.oSamples`). `LearnResult.reset` (`entitlement`, `unlimited`, `source`) says why learning restarted; `entitlementChange` is set for entitlement and unlimited/metered switches and is what `recordRead` stores. A snapshot key or unit form change restarts the window with `k` unset, without a rescale.

**Files:**
- Create: `packages/gateway/src/quota-balance/credential.ts`
- Create: `packages/gateway/src/quota-balance/reader.ts`
- Create: `packages/gateway/tests/quota-reader.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-reader.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import { ProtectionRuntime } from "../src/protection/runtime"
import { GroupDirectoryCache } from "../src/quota-balance/directory"
import { MemberFactsCache } from "../src/quota-balance/facts"
import { QuotaCutoff } from "../src/quota-balance/cutoff"
import { CalibrationError, QuotaReader } from "../src/quota-balance/reader"
import { QuotaBalance, setQuotaFetcherFactory } from "../src/quota-balance/runtime"
import { memberEstimate } from "../src/quota-balance/facts"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

const H = 3_600_000
const TOKEN = "fake_github_token_a"
let f: Fixture
let reader: QuotaReader
let protection: ProtectionRuntime
let facts: MemberFactsCache
let calls: Array<{ url: string; authorization: string | null }>
let respond: () => Response

const snapshot = (remaining: number, entitlement = 1000) => Response.json({ quota_snapshots: { premium_interactions: { entitlement, remaining, unlimited: false } } })

beforeEach(async () => {
  f = quotaFixture()
  f.addUpstream("up_test_a")
  f.db.run("UPDATE upstreams SET config_json = ? WHERE id = 'up_test_a'", [JSON.stringify({ githubToken: TOKEN })])
  await f.addGroup(1)
  await f.repo.quotaBalance.setMembership("up_test_a", gid(1), { nowMs: T0, intervalHours: 6 })
  calls = []
  respond = () => snapshot(700)
  const fetcher: Fetcher = async (input, init) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") })
    return respond()
  }
  protection = new ProtectionRuntime({ repo: () => f.repo, now: () => f.clock.now, schedule: work => { f.pending.push(work.catch(() => {})) }, cacheTtlMs: 0 })
  facts = new MemberFactsCache(f.deps)
  reader = new QuotaReader(f.deps, { directory: new GroupDirectoryCache(f.deps), facts, cutoff: new QuotaCutoff(f.deps, () => protection), fetcherFor: async () => fetcher })
})
afterEach(() => f.close())

const state = async () => (await f.repo.quotaBalance.getStates(["up_test_a"])).get("up_test_a")!

test("a new member is read once with its own credential; the read becomes the estimator's base and the next read is scheduled", async () => {
  const outcome = await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect(outcome).toMatchObject({ status: "read", read: { source: "github", share: 0.3, entitlement: 1000, used: 300 } })
  expect(calls).toHaveLength(1)
  expect(calls[0]).toEqual({ url: "https://api.github.com/copilot_internal/user", authorization: `token ${TOKEN}` })
  expect(await state()).toMatchObject({ lastReadAt: T0, lastReadShare: 0.3, lastReadSource: "github", entitlement: 1000, intervalHours: 6, nextReadAt: T0 + 6 * H, failures: 0 })
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(1)
})

test("scheduled and join reads wait when the sweep has used up its stagger budget", async () => {
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(0)
})

test("a big prediction error halves the interval and the interval between two reads teaches k", async () => {
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  f.clock.now = T0 + 6 * H
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0 + 3 * H, costUsd: 10, monthKey: "2026-11" })
  respond = () => snapshot(500)
  const outcome = await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect(outcome).toMatchObject({ status: "read", read: { share: 0.5 } })
  // The conservative estimate before the read was 0.3 + 0.1 x 10 = 1.3, so the error is +80 points.
  expect(outcome.status === "read" && outcome.read.errorPoints).toBeCloseTo(80, 6)
  const s = await state()
  expect(s).toMatchObject({ intervalHours: 3, nextReadAt: T0 + 9 * H, kSamples: 1 })
  expect(s.lastErrorPoints).toBeCloseTo(80, 6)
  expect(s.k).toBeCloseTo(0.02, 6)
})

test("an entitlement change is recorded, drops the interval, rescales k and o, restarts learning and brings the next read forward", async () => {
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.02, kPrev: null, kSamples: 5, o: 0.002, oSamples: 2, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: 1 }, T0)
  f.clock.now = T0 + 6 * H
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0 + 3 * H, costUsd: 10, monthKey: "2026-11" })
  respond = () => snapshot(1500, 2000)
  const outcome = await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect(outcome).toMatchObject({ status: "read", read: { share: 0.25, entitlement: 2000, errorPoints: null } })
  const s = await state()
  expect(s).toMatchObject({ entitlement: 2000, entitlementFrom: 1000, entitlementChangedAt: T0 + 6 * H, kSamples: 0, intervalHours: 1, nextReadAt: T0 + 7 * H, learnSince: T0 + 6 * H })
  expect(s.k).toBeCloseTo(0.01, 9)
  expect(s.o).toBeCloseTo(0.001, 9)
})

test("a failed read counts toward the floor, backs off and is reported without the response body", async () => {
  respond = () => new Response("secret upstream text", { status: 502 })
  const outcome = await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect(outcome).toEqual({ status: "error", error: "HTTP 502" })
  expect(await state()).toMatchObject({ failures: 1, lastError: "HTTP 502", lastAttemptAt: T0, nextReadAt: T0 + H, lastReadAt: null })
  f.clock.now = T0 + 30 * 60_000
  expect(await reader.readNow("up_test_a", { reason: "scheduled", manual: false })).toMatchObject({ status: "floor", blockedUntil: T0 + H })
  expect(calls).toHaveLength(1)
  respond = () => Response.json({ quota_snapshots: {} })
  f.clock.now = T0 + H
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "error", error: "unreadable quota response" })
  expect((await state()).nextReadAt).toBe(T0 + 3 * H) // second failure: 2 h back-off
})

test("a manual read respects the ten minute floor; a page open within it reuses the stored read", async () => {
  await reader.readNow("up_test_a", { reason: "manual", manual: true })
  f.clock.now = T0 + 5 * 60_000
  expect(await reader.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "floor", reason: "manual", blockedUntil: T0 + 10 * 60_000 })
  f.clock.now = T0 + 11 * 60_000
  expect((await reader.readNow("up_test_a", { reason: "manual", manual: true })).status).toBe("read")
  expect(calls).toHaveLength(2)
})

test("only Copilot members with a stored credential can be read", async () => {
  f.addUpstream("up_test_custom")
  await f.repo.quotaBalance.setMembership("up_test_custom", gid(1), { nowMs: T0, intervalHours: 6 })
  expect(await reader.readNow("up_test_custom", { reason: "manual", manual: true })).toMatchObject({ status: "unsupported" })
  expect(await reader.readNow("up_test_nobody", { reason: "manual", manual: true })).toMatchObject({ status: "unsupported" })
})

test("a real read at the hard line cuts the member off; a later read below it lifts the cut-off", async () => {
  respond = () => snapshot(20)
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ share: 0.98, source: "real", provisional: false })
  f.clock.now = T0 + 2 * H
  respond = () => snapshot(900)
  await reader.readNow("up_test_a", { reason: "manual", manual: true })
  expect((await protection.pausedUpstreams()).size).toBe(0)
})

test("the estimate crossing a line asks for an early read; when the floor blocks it and the line is the hard line the member is cut off provisionally", async () => {
  respond = () => snapshot(150) // share 0.85
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)
  facts.invalidate()
  f.clock.now = T0 + 90 * 60_000
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: f.clock.now, costUsd: 3, monthKey: "2026-11" }) // 0.85 + 0.06 = 0.91: the soft line
  respond = () => snapshot(90) // 0.91
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toMatchObject({ status: "read" })
  expect(calls).toHaveLength(2)

  // The read just re-learned k from a single interval; give the member a trusted k again so that the estimate may cut.
  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 8 * H, lastErrorPoints: null }, f.clock.now)
  f.clock.now = T0 + 100 * 60_000 // ten minutes after that read: the floor blocks the next one
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: f.clock.now, costUsd: 3, monthKey: "2026-11" }) // 0.91 + 0.06 = 0.97 >= hard line
  facts.invalidate()
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(2)
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "estimate", provisional: true })
})

test("calibration stores a manual read, back-adjusts the cost snapshot for a past time and validates its input", async () => {
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: T0 - 30 * 60_000, costUsd: 4, monthKey: "2026-11" })
  const read = await reader.calibrate("up_test_a", { usedShare: 0.4, at: T0 - H })
  expect(read).toMatchObject({ status: "read", read: { source: "manual", at: T0 - H, share: 0.4, entitlement: 100, used: 40 } })
  facts.invalidate()
  expect((await facts.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBeCloseTo(4)
  expect(calls).toHaveLength(0) // calibration never calls GitHub
  f.clock.now = T0 + 20 * 60_000
  await expect(reader.calibrate("up_test_a", { used: 10, entitlement: 100, at: T0 - 2 * H })).rejects.toThrow(CalibrationError)
  await expect(reader.calibrate("up_test_a", { used: 10, entitlement: 100, at: f.clock.now - 30 * H })).rejects.toThrow("at must be within the last 24 hours")
  await expect(reader.calibrate("up_test_a", { used: -1, entitlement: 100 })).rejects.toThrow("used must be a number")
  await expect(reader.calibrate("up_test_a", { used: 10 })).resolves.toMatchObject({ status: "read", read: { entitlement: 100, share: 0.1 } })
})

test("every evaluation re-applies the last real share: a cut-off that was lost is restored, an owner resume is respected until a later real read", async () => {
  respond = () => snapshot(20)
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  const [row] = [...(await protection.pausedUpstreams()).values()]
  f.db.run("DELETE FROM protection_pauses") // the pause was lost (a failed insert elsewhere)
  await protection.pausedUpstreams(); await f.idle() // the isolate's cache refreshes
  expect((await protection.pausedUpstreams()).size).toBe(0)
  f.clock.now = T0 + 60_000
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "idle" })
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "real", provisional: false })
  const restored = (await protection.pausedUpstreams()).get("up_test_a")!
  expect(restored.id).not.toBe(row!.id)
  f.clock.now = T0 + 2 * 60_000
  expect(await protection.resume(restored.id, "owner")).toBe(true)
  f.clock.now = T0 + 3 * 60_000
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  expect((await protection.pausedUpstreams()).size).toBe(0)
})

test("a fresh member whose estimate crosses the hard line with the fallback k is read when the floor allows and is never cut off provisionally when it does not", async () => {
  respond = () => snapshot(900) // share 0.1, k not learned
  await reader.evaluateMember("up_test_a", { allowScheduled: true })
  f.clock.now = T0 + 20 * 60_000 // inside the one hour floor
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: f.clock.now, costUsd: 20, monthKey: "2026-11" }) // 0.1 + 0.1 x 20: far above the line
  facts.invalidate()
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: false })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(1)
  expect((await protection.pausedUpstreams()).size).toBe(0)
})

test("two concurrent reads of one member send exactly one request (the read is claimed atomically before the fetch); calibrations race the same way", async () => {
  const outcomes = await Promise.all([reader.readNow("up_test_a", { reason: "scheduled", manual: false }), reader.readNow("up_test_a", { reason: "scheduled", manual: false }), reader.readNow("up_test_a", { reason: "manual", manual: true })])
  expect(calls).toHaveLength(1)
  expect(outcomes.map(o => o.status).sort()).toEqual(["floor", "floor", "read"])
  f.clock.now = T0 + 11 * 60_000
  const calibrations = await Promise.allSettled([reader.calibrate("up_test_a", { used: 10, entitlement: 100 }), reader.calibrate("up_test_a", { used: 20, entitlement: 100 })])
  const statuses = calibrations.map(c => c.status === "fulfilled" ? c.value.status : "rejected").sort()
  expect(statuses).toEqual(["floor", "read"])
})

test("the fetcher gets the member id, a cancellable signal and the member's credential; a resolver failure is a recorded failure with no direct fetch", async () => {
  const ids: string[] = []
  const signals: Array<AbortSignal | null | undefined> = []
  const original = globalThis.fetch
  let direct = 0
  globalThis.fetch = (async () => { direct++; return snapshot(700) }) as unknown as typeof fetch
  try {
    const watched = new QuotaReader(f.deps, { directory: new GroupDirectoryCache(f.deps), facts, cutoff: new QuotaCutoff(f.deps, () => protection),
      fetcherFor: async id => { ids.push(id); return async (_input, init) => { signals.push(init?.signal); return snapshot(700) } } })
    expect((await watched.readNow("up_test_a", { reason: "manual", manual: true })).status).toBe("read")
    expect(ids).toEqual(["up_test_a"])
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[0]!.aborted).toBe(false)

    const broken = new QuotaReader(f.deps, { directory: new GroupDirectoryCache(f.deps), facts, cutoff: new QuotaCutoff(f.deps, () => protection), fetcherFor: async () => { throw new Error("no chain: socks5://user:pw@host") } })
    f.clock.now = T0 + 11 * 60_000
    expect(await broken.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "error", error: "Error" })
    expect(await state()).toMatchObject({ failures: 1, lastError: "Error" })
    expect(direct).toBe(0)
  } finally { globalThis.fetch = original }
})

test("an unconfigured runtime fails closed: no read ever uses the global fetch, the failure is recorded", async () => {
  setQuotaFetcherFactory(null)
  const original = globalThis.fetch
  let direct = 0
  globalThis.fetch = (async () => { direct++; return snapshot(700) }) as unknown as typeof fetch
  try {
    const qb = new QuotaBalance(f.deps, { protection: () => protection })
    expect(await qb.reader.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "error", error: "Error" })
    expect(direct).toBe(0)
    expect(await state()).toMatchObject({ failures: 1, lastError: "Error", lastReadAt: null })
  } finally { globalThis.fetch = original }
})

test("a slow read is cancelled through its signal at the timeout; the body of a failed response is cancelled unread", async () => {
  let seen: AbortSignal | null | undefined
  const slow = new QuotaReader(f.deps, { directory: new GroupDirectoryCache(f.deps), facts, cutoff: new QuotaCutoff(f.deps, () => protection), timeoutMs: 20,
    fetcherFor: async () => (_input, init) => { seen = init?.signal; return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))) } })
  expect(await slow.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "error", error: "timeout" })
  expect(seen?.aborted).toBe(true)
  expect(await state()).toMatchObject({ failures: 1, lastError: "timeout" })

  let cancelled = false
  respond = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("secret upstream text")) }, cancel() { cancelled = true } }), { status: 502 })
  f.clock.now = T0 + 11 * 60_000
  expect(await reader.readNow("up_test_a", { reason: "manual", manual: true })).toEqual({ status: "error", error: "HTTP 502" })
  expect(cancelled).toBe(true)
})

test("nothing is read in the first 30 minutes of a month: a join waits, and a read taken in the window is not the month base", async () => {
  const first = Date.UTC(2026, 11, 1)
  f.clock.now = first + 10 * 60_000
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "idle" })
  expect(calls).toHaveLength(0)
  // A manual refresh in the window is recorded ...
  respond = () => snapshot(100) // share 0.9: last month's number
  expect((await reader.readNow("up_test_a", { reason: "manual", manual: true })).status).toBe("read")
  expect(await state()).toMatchObject({ lastReadShare: 0.9 })
  // ... but the estimate is the month-to-date basis, not that share.
  facts.invalidate()
  const estimate = memberEstimate((await facts.get(["up_test_a"])).get("up_test_a"), f.clock.now, 0.1)
  expect(estimate.usedShare).toBeLessThan(0.1)
  f.clock.now = first + 31 * 60_000
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toEqual({ status: "idle" }) // the one hour floor from the 00:10 attempt
  respond = () => snapshot(900)
  f.clock.now = first + 71 * 60_000
  expect(await reader.evaluateMember("up_test_a", { allowScheduled: true })).toMatchObject({ status: "read", read: { share: 0.1 } })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/gateway/tests/quota-reader.test.ts`
Expected: FAIL, module `../src/quota-balance/reader` not found.

- [ ] **Step 3: Implement the reader**

The one place that knows "this row is a Copilot row with a stored GitHub credential" (the architecture ratchet `provider-kind-branches-ratchet.test.ts` counts provider-kind comparisons, so there is exactly one, here; Task 15 raises its limit by this one):

```ts
// packages/gateway/src/quota-balance/credential.ts
export interface CopilotCredential { token: string; host: string | undefined }

/** Only Copilot upstreams have a quota this gateway can read: is this row a Copilot row? */
export const isCopilotUpstream = (upstream: { provider: string } | null | undefined): boolean => upstream?.provider === "copilot"

/** The stored GitHub credential of a Copilot upstream row (`config.githubToken`, `config.githubHost`), or null. Never log or return it to a client. */
export function copilotCredentialOf(upstream: { provider: string; config: Record<string, unknown> } | null | undefined): CopilotCredential | null {
  if (!upstream || !isCopilotUpstream(upstream)) return null
  const { githubToken, githubHost } = upstream.config
  return typeof githubToken === "string" && githubToken !== "" ? { token: githubToken, host: typeof githubHost === "string" ? githubHost : undefined } : null
}
```

```ts
// packages/gateway/src/quota-balance/reader.ts
import { fetchCopilotUser } from "@vibe-llm/provider-copilot/github"
import type { Fetcher } from "@vibe-core/upstream"
import type { UpstreamId } from "../repo/branded-ids.ts"
import type { QuotaRead, QuotaState, UpstreamGroup } from "../repo/quota-balance.ts"
import { copilotCredentialOf } from "./credential.ts"
import type { QuotaCutoff } from "./cutoff.ts"
import { warn, type QuotaDeps } from "./deps.ts"
import type { GroupDirectoryCache } from "./directory.ts"
import { K_WINDOW_MS, learn, type ReadPoint } from "./estimator.ts"
import { kFallbackOf, memberEstimate, paramsOf, type MemberFactsCache } from "./facts.ts"
import {
  MIN_INTERVAL_HOURS, backoffHours, nextIntervalHours, readAllowedAt, readDecision, readFloorMs, scheduleNextRead, type ReadReason, type SchedState,
} from "./read-schedule.ts"
import { parseQuotaSnapshot, type ParsedQuota } from "./snapshot.ts"
import { HOUR_MS, MINUTE_MS } from "./time.ts"

const READ_TIMEOUT_MS = 15_000
const CALIBRATION_WINDOW_MS = 24 * HOUR_MS

export class CalibrationError extends Error {}

export type ReadOutcome =
  | { status: "read"; read: QuotaRead }
  | { status: "floor"; reason: ReadReason | null; blockedUntil: number }
  | { status: "error"; error: string }
  | { status: "unsupported"; error: string }
  | { status: "idle" }

export interface ReaderParts {
  directory: GroupDirectoryCache
  facts: MemberFactsCache
  cutoff: QuotaCutoff
  /** The member's own egress: its saved proxy chain (the path the Users page uses), or plain fetch. */
  fetcherFor: (upstreamId: string) => Promise<Fetcher>
  /** Defaults to 15 s. */
  timeoutMs?: number
}

export const schedStateOf = (state: QuotaState): SchedState => ({
  lastReadAt: state.lastReadAt, lastReadShare: state.lastReadShare, lastAttemptAt: state.lastAttemptAt, nextReadAt: state.nextReadAt,
  failures: state.failures, unlimited: state.lastReadUnlimited,
})

/** Runs `work` with an abort signal that fires after `ms`: the request is cancelled, and a fetcher that ignores the signal is still given up on. */
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")) }, ms) })
  try { return await Promise.race([work(controller.signal), expired]) } finally { clearTimeout(timer) }
}

interface Member { upstreamId: string; group: UpstreamGroup; state: QuotaState; kFallback: number }

export class QuotaReader {
  private readonly lastEvaluated = new Map<string, number>()

  constructor(private readonly deps: QuotaDeps, private readonly parts: ReaderParts) {}

  /** The member's group, state and the fallback k, or null when it is not a group member. */
  private async member(upstreamId: string, fresh: boolean): Promise<Member | null> {
    const directory = await this.parts.directory.get()
    const groupId = directory.memberOf.get(upstreamId)
    const group = groupId ? directory.groups.get(groupId) : undefined
    if (!group) return null
    const siblings = [...directory.memberOf].flatMap(([id, g]) => g === group.id ? [id] : [])
    const all = await this.parts.facts.get(siblings, { fresh })
    const state = all.get(upstreamId)?.state
    if (!state) return null
    return { upstreamId, group, state, kFallback: kFallbackOf(siblings.map(id => all.get(id)?.state ?? null)) }
  }

  /**
   * One GitHub read (floors enforced here, whoever asks). The result becomes the estimator's base, `k`/`o` are re-learned, the next read
   * is scheduled and the hard line is applied.
   */
  async readNow(upstreamId: string, options: { reason: ReadReason; manual: boolean }): Promise<ReadOutcome> {
    const now = this.deps.now()
    const upstream = await this.deps.repo().upstreams.getById(upstreamId as UpstreamId)
    const credential = copilotCredentialOf(upstream)
    if (!credential) return { status: "unsupported", error: "not a Copilot upstream with a stored GitHub credential" }
    const member = await this.member(upstreamId, true)
    if (!member) return { status: "unsupported", error: "not a group member" }
    const allowedAt = readAllowedAt(schedStateOf(member.state), member.group.settings, options.manual)
    if (now < allowedAt) return { status: "floor", reason: options.reason, blockedUntil: allowedAt }
    const floorMs = readFloorMs(member.state, member.group.settings, options.manual)
    // Claim the read before any request leaves: concurrent callers (other isolates, a page open and the sweep) cannot both get through the floor.
    if (!(await this.deps.repo().quotaBalance.claimRead(upstreamId, now, floorMs, { intervalHours: member.group.settings.readIntervalHours }))) {
      return { status: "floor", reason: options.reason, blockedUntil: now + floorMs }
    }

    let parsed: ParsedQuota | null = null
    let failure: string | null
    try {
      const fetcher = await this.parts.fetcherFor(upstreamId)
      const outcome = await withTimeout(async signal => {
        const response = await fetchCopilotUser(credential.token, credential.host, (input, init) => fetcher(input, { ...init, signal }))
        if (!response.ok) {
          await response.body?.cancel().catch(() => {}) // the body is never read (it could carry anything)
          return { failure: `HTTP ${response.status}`, parsed: null }
        }
        const body = parseQuotaSnapshot(await response.json().catch(() => null))
        return body ? { failure: null, parsed: body } : { failure: "unreadable quota response", parsed: null }
      }, this.parts.timeoutMs ?? READ_TIMEOUT_MS)
      failure = outcome.failure
      parsed = outcome.parsed
    } catch (error) { failure = error instanceof Error ? (error.message === "timeout" ? "timeout" : error.name) : "error" }
    if (failure !== null || parsed === null) {
      const next = now + backoffHours(member.state.failures + 1, member.group.settings.readIntervalHours) * HOUR_MS
      await this.deps.repo().quotaBalance.recordFailure(upstreamId, now, next, failure ?? "error")
      this.parts.facts.invalidate(upstreamId)
      return { status: "error", error: failure ?? "error" }
    }
    const read = await this.finish(member, { at: now, source: "github", used: parsed.used, entitlement: parsed.entitlement, unlimited: parsed.unlimited, snapshotKey: parsed.key, unitForm: parsed.unitForm, resetAt: parsed.resetAt, costAdjustUsd: 0 })
    return { status: "read", read }
  }

  /** Owner-entered used / entitlement (or used share) as of `at` (default now, at most 24 h back), stored as a manual read. */
  async calibrate(upstreamId: string, input: { used?: number; entitlement?: number; usedShare?: number; at?: number }): Promise<ReadOutcome> {
    const now = this.deps.now()
    const num = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value)
    const at = input.at ?? now
    if (!num(at) || at > now + MINUTE_MS || now - at > CALIBRATION_WINDOW_MS) throw new CalibrationError("at must be within the last 24 hours")
    const member = await this.member(upstreamId, true)
    if (!member) return { status: "unsupported", error: "not a group member" }
    const entitlement = input.entitlement !== undefined ? input.entitlement : member.state.entitlement ?? 100
    if (!num(entitlement) || entitlement <= 0) throw new CalibrationError("entitlement must be a positive number")
    const used = input.used !== undefined ? input.used : input.usedShare !== undefined ? input.usedShare * entitlement : undefined
    if (used === undefined || !num(used) || used < 0) throw new CalibrationError("used must be a number of at least 0")
    const allowedAt = readAllowedAt(schedStateOf(member.state), member.group.settings, true)
    if (now < allowedAt) return { status: "floor", reason: "manual", blockedUntil: allowedAt }
    if (member.state.lastReadAt !== null && at <= member.state.lastReadAt) throw new CalibrationError("at must be after the last read")
    if (!(await this.deps.repo().quotaBalance.claimRead(upstreamId, now, readFloorMs(member.state, member.group.settings, true), { intervalHours: member.group.settings.readIntervalHours }))) {
      return { status: "floor", reason: "manual", blockedUntil: now + readFloorMs(member.state, member.group.settings, true) }
    }
    const costAdjustUsd = now - at > 10 * MINUTE_MS ? await this.deps.repo().quotaBalance.costBetween(upstreamId, at, now) : 0
    const read = await this.finish(member, { at, source: "manual", used, entitlement, unlimited: false, snapshotKey: null, unitForm: null, resetAt: null, costAdjustUsd })
    return { status: "read", read }
  }

  private async finish(member: Member, value: { at: number; source: "github" | "manual"; used: number; entitlement: number; unlimited: boolean; snapshotKey: string | null; unitForm: string | null; resetAt: string | null; costAdjustUsd: number }): Promise<QuotaRead> {
    const now = this.deps.now()
    const repo = this.deps.repo().quotaBalance
    const { state, group } = member
    const facts = (await this.parts.facts.get([member.upstreamId])).get(member.upstreamId)
    const estimate = memberEstimate(facts, now, member.kFallback)
    const estimatedShareBefore = estimate.known && !estimate.unlimited ? estimate.usedShare : null
    const share = value.unlimited || value.entitlement <= 0 ? 0 : value.used / value.entitlement
    const change = !value.unlimited && state.entitlement !== null && state.entitlement > 0 && Math.abs(state.entitlement - value.entitlement) > 1e-6 * Math.max(state.entitlement, value.entitlement)
      ? { from: state.entitlement, to: value.entitlement } : null
    const errorPoints = estimatedShareBefore === null || change ? null : (estimatedShareBefore - share) * 100
    const read = await repo.recordRead({
      upstreamId: member.upstreamId, at: value.at, source: value.source, used: value.used, entitlement: value.entitlement, unlimited: value.unlimited,
      estimatedShareBefore, errorPoints, snapshotKey: value.snapshotKey, unitForm: value.unitForm, resetAt: value.resetAt, costAdjustUsd: value.costAdjustUsd, entitlementChange: change,
    }, now)
    const history = await repo.listReads(member.upstreamId, value.at - K_WINDOW_MS - 24 * HOUR_MS)
    const points: ReadPoint[] = history.map(r => ({ at: r.at, share: r.share, entitlement: r.entitlement, unlimited: r.unlimited, costTotalUsd: r.costTotalUsd, snapshotKey: r.snapshotKey, unitForm: r.unitForm }))
    const newPoint = points.find(point => point.at === read.at)!
    const learned = learn({ prev: paramsOf(state), reads: points, read: newPoint, learnSince: state.learnSince, previousEntitlement: state.entitlement, estimatedShareBefore, kFallback: member.kFallback })
    const intervalHours = learned.entitlementChange ? MIN_INTERVAL_HOURS : nextIntervalHours(state.intervalHours, learned.errorPoints, group.settings.readIntervalHours)
    const kPrev = state.k !== null && learned.k !== null && Math.abs(learned.k - state.k) > 0.01 * state.k ? state.k : state.kPrev
    await repo.saveEstimator(member.upstreamId, {
      k: learned.k, kPrev, kSamples: learned.kSamples, o: learned.o, oSamples: learned.oSamples, intervalHours, learnSince: learned.learnSince,
      nextReadAt: scheduleNextRead(now, intervalHours, this.deps.random), lastErrorPoints: learned.errorPoints,
    }, now)
    this.parts.facts.invalidate(member.upstreamId)
    try {
      await this.parts.cutoff.apply({ upstreamId: member.upstreamId, groupId: group.id, groupName: group.name, hardShare: group.settings.hardShare, share, source: "real", readAt: value.at })
    } catch (error) { warn("quota_cutoff_failed", error) }
    return read
  }

  /**
   * One member's turn in the sweep or after a recorded cost: reads when the scheduler says so (join, monthly, scheduled, drift, confirm, soft or hard line),
   * and cuts the member off provisionally when the estimate is at the hard line but the floor blocks the confirming read.
   * `allowScheduled: false` holds back join/monthly/scheduled reads (the sweep staggers those); the early triggers are never held back.
   */
  async evaluateMember(upstreamId: string, options: { allowScheduled: boolean; fresh?: boolean }): Promise<ReadOutcome> {
    const now = this.deps.now()
    const member = await this.member(upstreamId, options.fresh ?? true)
    if (!member || !member.group.enabled) return { status: "idle" }
    const facts = (await this.parts.facts.get([upstreamId])).get(upstreamId)
    const estimate = memberEstimate(facts, now, member.kFallback)
    const decision = readDecision({ now, state: schedStateOf(member.state), estimatedShare: estimate.usedShare, settings: member.group.settings })
    if (decision.read && decision.reason !== null) {
      if (!options.allowScheduled && (decision.reason === "scheduled" || decision.reason === "join" || decision.reason === "monthly")) return { status: "idle" }
      return this.readNow(upstreamId, { reason: decision.reason, manual: false })
    }
    try {
      if (decision.reason === "hard" && estimate.known && !estimate.unlimited) {
        // Provisional: the cut-off refuses it unless k is learned (with the fallback k the hard line only asks for the read, floor permitting).
        await this.parts.cutoff.apply({
          upstreamId, groupId: member.group.id, groupName: member.group.name, hardShare: member.group.settings.hardShare, share: estimate.usedShare, source: "estimate",
          kLearned: estimate.kLearned === true, readAt: member.state.lastReadAt,
        })
      } else if (member.state.lastReadAt !== null && member.state.lastReadShare !== null && !member.state.lastReadUnlimited) {
        // Idempotent re-apply of the last real share: restores a lost cut-off, keeps an existing one, respects an owner resume.
        await this.parts.cutoff.apply({
          upstreamId, groupId: member.group.id, groupName: member.group.name, hardShare: member.group.settings.hardShare, share: member.state.lastReadShare, source: "real", readAt: member.state.lastReadAt,
        })
      }
    } catch (error) { warn("quota_cutoff_failed", error) }
    return { status: "idle" }
  }

  /** From the cost tracker: at most one evaluation per member and minute per isolate. Never throws. */
  async evaluateSoon(upstreamId: string): Promise<void> {
    const now = this.deps.now()
    const last = this.lastEvaluated.get(upstreamId)
    if (last !== undefined && now - last < MINUTE_MS) return
    this.lastEvaluated.set(upstreamId, now)
    try { await this.evaluateMember(upstreamId, { allowScheduled: false, fresh: false }) } catch (error) { warn("quota_evaluate_failed", error) }
  }
}

```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/quota-reader.test.ts`
Expected: PASS (17 tests). If the provisional cut-off test fails on the soft-line read count, check that `readDecision` sees `lastReadShare` 0.85 and the estimate 0.91: the recorded cost of $3 at `k = 0.02` adds 0.06.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run --filter '@vibe-llm/gateway' typecheck`
Expected: no errors.

```bash
git add packages/gateway/src/quota-balance/credential.ts packages/gateway/src/quota-balance/reader.ts packages/gateway/tests/quota-reader.test.ts
git commit -m "feat(quota-balance): quota reader with learning, scheduling, calibration and early evaluation" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 11: The `QuotaBalance` container, the cost tracker and the cost hook

Gateway cost is recorded for group members only, in the background, right beside `repo.usage.record`. The container wires the caches, the reader and the tracker so that every consumer (hook, routing, sweep, API) shares one set of per-isolate caches.

**Files:**
- Create: `packages/gateway/src/quota-balance/cost-tracker.ts`
- Create: `packages/gateway/src/quota-balance/cost-hook.ts`
- Create: `packages/gateway/src/quota-balance/runtime.ts`
- Create: `packages/gateway/src/control-plane/quota-balance/fetcher.ts`
- Modify: `packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts` (add `quotaSession`)
- Modify: `packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts` (`buildTelemetryCtx`, ~L76)
- Modify: `packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts` (`recordUsage`, ~L221-L248)
- Modify: `packages/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts` (~L76-L81)
- Modify: `packages/gateway/src/data-plane/shared/token-usage.ts` (~L150)
- Create: `packages/gateway/tests/quota-cost-tracker.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-cost-tracker.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QuotaBalance, getQuotaBalance, setQuotaBalanceForTests } from "../src/quota-balance/runtime"
import { trackQuotaCost } from "../src/quota-balance/cost-hook"
import { newBalanceSession } from "../src/quota-balance/session-key"
import { recordUsage } from "../src/data-plane/chat-flow/shared/respond-telemetry"
import { recordTokenUsage } from "../src/data-plane/shared/token-usage"
import type { UsageRecord } from "../src/repo/types"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

let f: Fixture
let qb: QuotaBalance
let evaluated: string[]
beforeEach(async () => {
  f = quotaFixture()
  f.addUpstream("up_test_a"); f.addUpstream("up_test_free")
  await f.addGroup(1)
  await f.repo.quotaBalance.setMembership("up_test_a", gid(1), { nowMs: T0, intervalHours: 6 })
  qb = new QuotaBalance(f.deps)
  evaluated = []
  qb.reader.evaluateSoon = async id => { evaluated.push(id) }
  setQuotaBalanceForTests(qb)
})
afterEach(() => { setQuotaBalanceForTests(null); f.close() })

const row = (upstream: string | null, tokens: UsageRecord["tokens"] = { input: 1_000_000, output: 100_000 }): UsageRecord =>
  ({ keyId: "key_test_1" as never, incomingModel: "m", model: "m", modelKey: "m", upstream, client: "", hour: "2026-11-10T12", requests: 1, tokens, cost: { input: 3, output: 15 } })
const state = async () => (await f.repo.quotaBalance.getStates(["up_test_a"])).get("up_test_a")!

test("a member's cost is added to its counters, the isolate's facts and the 10-minute bucket, then the member is evaluated", async () => {
  qb.costs.record({ upstreamId: "up_test_a", costUsd: 4.5 })
  await f.idle()
  expect(await state()).toMatchObject({ costTotalUsd: 4.5, monthCostUsd: 4.5, monthKey: "2026-11" })
  expect((await qb.facts.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBeCloseTo(4.5)
  expect(await f.repo.quotaBalance.costBetween("up_test_a", T0, T0)).toBeCloseTo(4.5)
  expect(evaluated).toEqual(["up_test_a"])
})

test("a cost of an upstream that is not a member, or of zero, writes nothing", async () => {
  qb.costs.record({ upstreamId: "up_test_free", costUsd: 5 })
  qb.costs.record({ upstreamId: "up_test_a", costUsd: 0 })
  qb.costs.record({ upstreamId: "up_test_a", costUsd: Number.NaN })
  await f.idle()
  expect((await state()).costTotalUsd).toBe(0)
  expect(evaluated).toEqual([])
})

test("the session that sent the request is charged: its recent spend is updated with the same write", async () => {
  qb.assignments.put({ groupId: gid(1), sessionKey: "s1", upstreamId: "up_test_a", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
  const session = newBalanceSession({ apiKeyId: "key_test_1", explicitId: "x", fingerprint: null })
  session.assigned = { groupId: gid(1), sessionKey: "s1", upstreamId: "up_test_a" }
  qb.costs.record({ upstreamId: "up_test_a", costUsd: 2, session })
  qb.costs.record({ upstreamId: "up_test_a", costUsd: 3, session: { ...session, assigned: { groupId: gid(1), sessionKey: "s1", upstreamId: "up_test_other" } } }) // served elsewhere: not this session's member
  await f.idle()
  expect(await f.repo.quotaBalance.getAssignment(gid(1), "s1")).toMatchObject({ recentCostUsd: 2, recentCostAt: T0 })
})

test("a failing repository never reaches the caller", async () => {
  const broken = new QuotaBalance({ ...f.deps, repo: () => { throw new Error("down") } })
  expect(() => broken.costs.record({ upstreamId: "up_test_a", costUsd: 1 })).not.toThrow()
  await f.idle()
  const throwingScheduler = new QuotaBalance({ ...f.deps, schedule: () => { throw new Error("no executor") } })
  expect(() => throwingScheduler.costs.record({ upstreamId: "up_test_a", costUsd: 1 })).not.toThrow()
})

test("recordUsage prices the request from its frozen pricing snapshot and charges the member and the session", async () => {
  qb.assignments.put({ groupId: gid(1), sessionKey: "s2", upstreamId: "up_test_a", createdAt: T0, lastSeenAt: T0, movedAt: T0, recentCostUsd: 0, recentCostAt: T0 })
  const quotaSession = newBalanceSession({ apiKeyId: "key_test_1", explicitId: "x", fingerprint: null })
  quotaSession.assigned = { groupId: gid(1), sessionKey: "s2", upstreamId: "up_test_a" }
  const ctx = { apiKeyId: "key_test_1", userAgent: null, quotaSession } as never
  await recordUsage(ctx, { incomingModel: "m", model: "m", upstream: "up_test_a", modelKey: "m", cost: { input: 3, output: 15 } } as never, { input: 1_000_000, output: 100_000 }, f.repo)
  await f.idle()
  expect((await state()).costTotalUsd).toBeCloseTo(4.5) // 1M x $3 + 100k x $15, per million
  expect((await f.repo.quotaBalance.getAssignment(gid(1), "s2"))?.recentCostUsd).toBeCloseTo(4.5)
})

test("image server-tool usage and the generic hook charge the member too", async () => {
  await recordTokenUsage("key_test_1" as never, { incomingModel: "m", model: "img", upstream: "up_test_a", modelKey: "img", cost: { input: 2, output: 8 }, client: "" }, { input: 1_000_000 }, f.repo)
  trackQuotaCost(row("up_test_a", { output: 1_000_000 })) // $15
  trackQuotaCost(row(null)) // pre-port rows have no upstream
  await f.idle()
  expect((await state()).costTotalUsd).toBeCloseTo(2 + 15)
  expect(getQuotaBalance()).toBe(qb)
})

test("a failed write leaves no phantom cost in the isolate's estimate", async () => {
  const failing = new Proxy(f.repo, {
    get(target, key) {
      if (key === "quotaBalance") return new Proxy(target.quotaBalance, { get(q, method) { if (method === "recordCost") return async () => { throw new Error("down") }; const v = (q as never)[method] as unknown; return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(q) : v } })
      const v = (target as never)[key] as unknown
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v
    },
  })
  const broken = new QuotaBalance({ ...f.deps, repo: () => failing })
  await broken.facts.get(["up_test_a"]) // cached before the cost arrives: the isolate's own additions show on top of it
  await broken.costs.recordNow({ upstreamId: "up_test_a", costUsd: 7 }).catch(() => {})
  expect((await broken.facts.get(["up_test_a"])).get("up_test_a")!.costSinceReadUsd).toBe(0)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/gateway/tests/quota-cost-tracker.test.ts`
Expected: FAIL, `../src/quota-balance/runtime` not found.

- [ ] **Step 3: Implement the tracker**

```ts
// packages/gateway/src/quota-balance/cost-tracker.ts
import { warn, type QuotaDeps } from "./deps.ts"
import type { GroupDirectoryCache } from "./directory.ts"
import type { AssignmentStore } from "./assignments.ts"
import type { MemberFactsCache } from "./facts.ts"
import type { BalanceSession } from "./session-key.ts"
import { monthKey } from "./time.ts"

export interface CostInput { upstreamId: string; costUsd: number; session?: BalanceSession }
export interface CostTrackerParts {
  directory: GroupDirectoryCache
  facts: MemberFactsCache
  assignments: AssignmentStore
  /** Called after a member's cost is stored (throttled by the callee): early reads and the hard line. */
  evaluate: (upstreamId: string) => Promise<void>
}

/**
 * Gateway cost of group members, recorded in the background with `repo.usage.record`'s timing. Non-members (the vast majority of requests when
 * no group exists) cost one cached directory lookup and no write. Never throws, never delays the response.
 */
export class QuotaCostTracker {
  constructor(private readonly deps: QuotaDeps, private readonly parts: CostTrackerParts) {}

  record(input: CostInput): void {
    if (!(input.costUsd > 0)) return
    try { this.deps.schedule(this.recordNow(input).catch(error => warn("quota_cost_failed", error))) } catch (error) { warn("quota_cost_schedule_failed", error) }
  }

  async recordNow(input: CostInput): Promise<void> {
    const directory = await this.parts.directory.get()
    const groupId = directory.memberOf.get(input.upstreamId)
    if (!groupId || !directory.groups.has(groupId)) return
    const now = this.deps.now()
    const assigned = input.session?.assigned
    // Only the member that served the session's request counts as the session's spend on its assignment.
    const spend = assigned && assigned.groupId === groupId && assigned.upstreamId === input.upstreamId
      ? this.parts.assignments.addCost(groupId, assigned.sessionKey, input.costUsd, now) : null
    await this.deps.repo().quotaBalance.recordCost({
      upstreamId: input.upstreamId, nowMs: now, costUsd: input.costUsd, monthKey: monthKey(now),
      ...(spend && assigned ? { session: { groupId, sessionKey: assigned.sessionKey, ...spend } } : {}),
    })
    // Only after the write succeeded: a failed write must not leave a phantom cost in this isolate's estimate.
    this.parts.facts.addLocalCost(input.upstreamId, input.costUsd)
    await this.parts.evaluate(input.upstreamId)
  }
}
```

```ts
// packages/gateway/src/quota-balance/cost-hook.ts
import type { UsageRecord } from "../repo/types.ts"
import { recordCostUsd } from "../shared/usage-cost.ts"
import { getQuotaBalance } from "./runtime.ts"
import type { BalanceSession } from "./session-key.ts"

/** Next to every `repo.usage.record(row)`: charges the row's gateway cost to its upstream when that upstream is a group member. Synchronous, never throws. */
export function trackQuotaCost(row: UsageRecord, session?: BalanceSession): void {
  try {
    if (!row.upstream) return
    const costUsd = recordCostUsd(row)
    if (costUsd > 0) getQuotaBalance().costs.record({ upstreamId: row.upstream, costUsd, session })
  } catch { /* the request must never feel this */ }
}
```

```ts
// packages/gateway/src/quota-balance/runtime.ts
import { __registerPlatformReset } from "@vibe-core/platform"
import type { Fetcher } from "@vibe-core/upstream"
import { getProtection, type ProtectionRuntime } from "../protection/runtime.ts"
import { AssignmentStore } from "./assignments.ts"
import { QuotaCostTracker } from "./cost-tracker.ts"
import { QuotaCutoff } from "./cutoff.ts"
import { defaultDeps, type QuotaDeps } from "./deps.ts"
import { GroupDirectoryCache } from "./directory.ts"
import { MemberFactsCache } from "./facts.ts"
import { QuotaReader } from "./reader.ts"

type FetcherFactory = (upstreamId: string) => Promise<Fetcher>
/** Fails closed: a read must leave through the member's own proxy chain, never directly from this process. */
const unconfigured: FetcherFactory = async () => { throw new Error("quota fetcher not configured") }
let fetcherFactory: FetcherFactory = unconfigured
/** The composition roots (`app.ts`, `maintenance.ts`) import `control-plane/quota-balance/fetcher.ts`, which registers the proxy-chain aware factory; until then every read fails and is recorded as a failure. */
export function setQuotaFetcherFactory(factory: FetcherFactory | null): void { fetcherFactory = factory ?? unconfigured }

/** The per-isolate quota-balance services, sharing one set of caches. */
export class QuotaBalance {
  readonly directory: GroupDirectoryCache
  readonly facts: MemberFactsCache
  readonly assignments: AssignmentStore
  readonly cutoff: QuotaCutoff
  readonly reader: QuotaReader
  readonly costs: QuotaCostTracker

  constructor(readonly deps: QuotaDeps = defaultDeps(), options: { protection?: () => ProtectionRuntime } = {}) {
    this.directory = new GroupDirectoryCache(deps)
    this.facts = new MemberFactsCache(deps)
    this.assignments = new AssignmentStore(deps)
    this.cutoff = new QuotaCutoff(deps, options.protection ?? getProtection)
    this.reader = new QuotaReader(deps, { directory: this.directory, facts: this.facts, cutoff: this.cutoff, fetcherFor: id => fetcherFactory(id) })
    this.costs = new QuotaCostTracker(deps, { directory: this.directory, facts: this.facts, assignments: this.assignments, evaluate: id => this.reader.evaluateSoon(id) })
  }
}

let current: QuotaBalance | null = null
/** The process-wide services: real repo, wall clock, `waitUntil`. */
export function getQuotaBalance(): QuotaBalance { return current ??= new QuotaBalance() }
export function setQuotaBalanceForTests(value: QuotaBalance | null): void { current = value }
__registerPlatformReset(() => { current = null })
```

```ts
// packages/gateway/src/control-plane/quota-balance/fetcher.ts
import { getRuntimeLocation } from "@vibe-core/platform"
import { setQuotaFetcherFactory } from "../../quota-balance/runtime.ts"
import { resolveControlPlaneFetcher } from "../upstreams/proxy-resolution.ts"

/** The member's own egress: its saved proxy chain, as the Users page quota read uses it; plain `fetch` when it has none. Imported for its effect. */
setQuotaFetcherFactory(async upstreamId => (await resolveControlPlaneFetcher({ upstreamId, runtimeLocation: getRuntimeLocation() })) ?? fetch)
```

- [ ] **Step 4: Wire the hook (three call sites) and the session reference**

`packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts`: add the import and the field.

```ts
import type { BalanceSession } from '../../../quota-balance/session-key.ts'
// inside TelemetryRequestContext:
  /** The quota-balancing session of this request (set by the HTTP handler); the cost hook charges the session's assigned member. */
  readonly quotaSession?: BalanceSession
```

`packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts`, in `buildTelemetryCtx` add after `sourceApi: ...,`:

```ts
    quotaSession: (auth as { balanceSession?: BalanceSession }).balanceSession,
```
and `import type { BalanceSession } from '../../../quota-balance/session-key.ts'`.

`packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts`, `recordUsage`: add `import { trackQuotaCost } from '../../../quota-balance/cost-hook.ts'` and after the `await Promise.all([...])`:

```ts
  trackQuotaCost(row, telemetryCtx.quotaSession)
```

`packages/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts`, after the `await Promise.all([repo.usage.record(rec), repo.apiKeys.touchLastUsed(keyId)])` add `trackQuotaCost(rec)` (import from `'../../../quota-balance/cost-hook.ts'`).

`packages/gateway/src/data-plane/shared/token-usage.ts`, after `await repo.usage.record(row)` add `trackQuotaCost(row)` (import from `'../../quota-balance/cost-hook.ts'`).

- [ ] **Step 5: Run the tests, existing usage tests and the typecheck**

Run: `bun test packages/gateway/tests/quota-cost-tracker.test.ts packages/gateway/tests/embeddings.e2e.test.ts packages/gateway/tests/images.e2e.test.ts packages/gateway/tests/chat.e2e.test.ts`
Expected: PASS (the e2e files run with no groups: the hook finds no member and does nothing).

Run: `bun run --filter '@vibe-llm/gateway' typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/quota-balance/cost-tracker.ts packages/gateway/src/quota-balance/cost-hook.ts packages/gateway/src/quota-balance/runtime.ts packages/gateway/src/control-plane/quota-balance/fetcher.ts packages/gateway/src/data-plane/chat-flow/shared/telemetry-ctx.ts packages/gateway/src/data-plane/chat-flow/shared/kit-deps.ts packages/gateway/src/data-plane/chat-flow/shared/respond-telemetry.ts packages/gateway/src/data-plane/observability/attempts/embeddings-attempt.ts packages/gateway/src/data-plane/shared/token-usage.ts packages/gateway/tests/quota-cost-tracker.test.ts
git commit -m "feat(quota-balance): cost tracker, container and the cost hook beside usage recording" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 12: Maintenance: the minute sweep (reads, early triggers, provisional cut-off) and retention

> **Estimator contract (added after the Task 4-6 review).** The sweep's provisional cut-off must call `provisionalCutoffAllowed` with `kLearned` from the estimate: while the member still uses the fallback k (fewer than 3 usable intervals), reaching the hard line triggers the read (floor permitting) and nothing else; the soft line may still use the estimate. Add a test with a fresh member whose estimate crosses the hard line while the floor blocks the read: no pause is inserted. Every sweep re-applies the last real share through `QuotaCutoff.apply` (with the last read's time as `readAt`); this is idempotent: an existing quota pause is kept, a lifted one stays lifted, and an owner-resumed one is not cut again until a later real read.

**Files:**
- Create: `packages/gateway/src/quota-balance/sweep.ts`
- Modify: `packages/gateway/src/maintenance.ts` (imports ~L1-L8, `resetTelemetryRetentionState` ~L22, task list ~L47-L56)
- Create: `packages/gateway/tests/quota-sweep.test.ts`
- Create: `packages/gateway/tests/quota-retention.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-sweep.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { Fetcher } from "@vibe-core/upstream"
import { ProtectionRuntime } from "../src/protection/runtime"
import { QuotaBalance, setQuotaFetcherFactory } from "../src/quota-balance/runtime"
import { sweepQuotaBalance } from "../src/quota-balance/sweep"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

let f: Fixture
let qb: QuotaBalance
let calls: string[]
let protection: ProtectionRuntime
beforeEach(() => {
  f = quotaFixture()
  calls = []
  setQuotaFetcherFactory(async upstreamId => (async () => { calls.push(upstreamId); return Response.json({ quota_snapshots: { premium_interactions: { entitlement: 1000, remaining: 700, unlimited: false } } }) }) as Fetcher)
  protection = new ProtectionRuntime({ repo: () => f.repo, now: () => f.clock.now, schedule: work => { f.pending.push(work.catch(() => {})) }, cacheTtlMs: 0 })
  qb = new QuotaBalance(f.deps, { protection: () => protection })
})
afterEach(() => { setQuotaFetcherFactory(null); f.close() })

async function member(id: string, groupNumber: number) {
  f.addUpstream(id)
  f.db.run("UPDATE upstreams SET config_json = ? WHERE id = ?", [JSON.stringify({ githubToken: `fake_token_${id}` }), id])
  await f.repo.quotaBalance.setMembership(id, gid(groupNumber), { nowMs: T0, intervalHours: 6 })
}

test("new members of an enabled group are read, at most two scheduled reads per sweep, the rest on the next one", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) await member(id, 1)
  const first = await sweepQuotaBalance(T0, qb)
  expect(first.reads).toBe(2)
  expect(calls).toHaveLength(2)
  f.clock.now += 60_000
  const second = await sweepQuotaBalance(f.clock.now, qb)
  expect(second.reads).toBe(1)
  expect(new Set(calls).size).toBe(3)
  f.clock.now += 60_000
  expect((await sweepQuotaBalance(f.clock.now, qb)).reads).toBe(0)
})

test("members of a disabled group are left alone", async () => {
  await f.addGroup(1, { enabled: false })
  await member("up_test_a", 1)
  expect((await sweepQuotaBalance(T0, qb)).reads).toBe(0)
  expect(calls).toEqual([])
})

test("an early trigger is not held back by the stagger budget", async () => {
  await f.addGroup(1)
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) await member(id, 1)
  await sweepQuotaBalance(T0, qb)
  await sweepQuotaBalance(T0 + 60_000, qb) // all three have a base read (share 0.3)
  calls.length = 0
  f.clock.now = T0 + 2 * 3_600_000
  for (const id of ["up_test_a", "up_test_b", "up_test_c"]) {
    await f.repo.quotaBalance.recordCost({ upstreamId: id, nowMs: f.clock.now, costUsd: 4, monthKey: "2026-11" }) // 0.3 + 0.1 x 4: the conservative k pushes each past the drift limit
  }
  const swept = await sweepQuotaBalance(f.clock.now, qb)
  expect(swept.reads).toBe(3)
  expect(calls).toHaveLength(3)
})

test("the provisional cut-off: a fresh member (fallback k) is only read, a member with a learned k is cut off when the floor blocks the read", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1)
  await sweepQuotaBalance(T0, qb) // base read, share 0.3
  calls.length = 0
  f.clock.now = T0 + 20 * 60_000 // inside the one hour floor
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: f.clock.now, costUsd: 20, monthKey: "2026-11" }) // far above the hard line with the fallback k
  qb.facts.invalidate()
  await sweepQuotaBalance(f.clock.now, qb)
  expect(calls).toEqual([])
  expect((await protection.pausedUpstreams()).size).toBe(0)

  await f.repo.quotaBalance.saveEstimator("up_test_a", { k: 0.05, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * 3_600_000, lastErrorPoints: null }, f.clock.now)
  qb.facts.invalidate()
  await sweepQuotaBalance(f.clock.now, qb)
  expect(calls).toEqual([])
  expect((await protection.pausedUpstreams()).get("up_test_a")?.reason.quota).toMatchObject({ source: "estimate", provisional: true })
})
```

```ts
// packages/gateway/tests/quota-retention.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
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
import { setQuotaBalanceForTests } from "../src/quota-balance/runtime"
import { sweepQuotaRetention } from "../src/quota-balance/sweep"
import { DEFAULT_GROUP_SETTINGS, QUOTA_PURGE_CHUNK } from "../src/repo/quota-balance"

const ORPHAN_MINUTE = Date.UTC(2026, 10, 17, 12, 17)
const OFF_MINUTE = Date.UTC(2026, 10, 17, 12, 0)
let raw: Database
let repo: BunSqliteRepo
let db: BunSqliteDatabase
let files: FsFileProvider
let root: string

beforeEach(async () => {
  resetTelemetryRetentionState()
  __resetPlatformForTests()
  setQuotaBalanceForTests(null)
  initEnv(() => "")
  root = await mkdtemp(join(tmpdir(), "quota-retention-"))
  raw = new Database(join(root, "test.sqlite"))
  repo = new BunSqliteRepo(raw)
  initRepo(repo)
  db = new BunSqliteDatabase(raw)
  files = new FsFileProvider(join(root, "files"))
})
afterEach(async () => { raw.close(); await rm(root, { recursive: true, force: true }); __resetPlatformForTests() })

const count = (table: string) => raw.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n

test("retention runs in the hourly orphan minute: idle assignments by the group's idle hours, old reads and buckets, then orphans; other minutes touch nothing", async () => {
  const g = `ug_${"1".repeat(32)}`
  await repo.quotaBalance.createGroup({ id: g, ownerId: "u", name: "G", enabled: true, sortOrder: 0, settings: { ...DEFAULT_GROUP_SETTINGS, sessionIdleHours: 2 }, createdAt: "t", updatedAt: "t" })
  const base = { upstreamId: "up_test_a", createdAt: OFF_MINUTE, movedAt: OFF_MINUTE, recentCostUsd: 0, recentCostAt: OFF_MINUTE }
  await repo.quotaBalance.putAssignment({ ...base, groupId: g, sessionKey: "fresh", lastSeenAt: ORPHAN_MINUTE - 3_600_000 })
  await repo.quotaBalance.putAssignment({ ...base, groupId: g, sessionKey: "idle", lastSeenAt: ORPHAN_MINUTE - 3 * 3_600_000 })
  await repo.quotaBalance.putAssignment({ ...base, groupId: `ug_${"2".repeat(32)}`, sessionKey: "orphan", lastSeenAt: ORPHAN_MINUTE })
  raw.run("INSERT INTO quota_reads (upstream_id, at, source, used, entitlement, share, cost_total_usd) VALUES ('up_test_a', ?, 'github', 1, 2, 0.5, 0)", [OFF_MINUTE - 100 * 86_400_000])

  await sweepMaintenance(db, files, OFF_MINUTE)
  expect(count("session_assignments")).toBe(3) // not the retention minute: nothing is deleted
  expect(count("quota_reads")).toBe(1)

  await sweepMaintenance(db, files, ORPHAN_MINUTE)
  expect(count("session_assignments")).toBe(1) // idle and orphan assignments are gone
  expect(count("quota_reads")).toBe(0)
})

test("a backlog continues on the next sweep: date-based backlog does not turn on the orphan scans, an orphan backlog does", async () => {
  const calls: Array<{ orphans?: boolean }> = []
  const result = { assignments: 0, reads: 0, buckets: 0, states: 0, orphans: 0 }
  const answers = [{ ...result, reads: QUOTA_PURGE_CHUNK }, { ...result }, { ...result, orphans: QUOTA_PURGE_CHUNK }, { ...result }]
  const fake = { quotaBalance: { deleteExpired: async (_now: number, options?: { orphans?: boolean }) => { calls.push({ orphans: options?.orphans }); return answers.shift()! } } }
  const real = repo.quotaBalance
  ;(repo as unknown as { quotaBalance: unknown }).quotaBalance = fake.quotaBalance
  try {
    await sweepQuotaRetention(OFF_MINUTE, false)
    expect(calls).toEqual([]) // not the retention minute and no backlog: no statement at all
    await sweepQuotaRetention(ORPHAN_MINUTE, true)
    expect(calls).toEqual([{ orphans: true }])
    await sweepQuotaRetention(ORPHAN_MINUTE + 60_000, false) // a full chunk of old reads continues, without the orphan scans
    expect(calls.at(-1)).toEqual({ orphans: false })
    await sweepQuotaRetention(ORPHAN_MINUTE + 120_000, false) // drained
    expect(calls).toHaveLength(2)
    await sweepQuotaRetention(ORPHAN_MINUTE + 3_600_000, true)
    expect(calls.at(-1)).toEqual({ orphans: true }) // answered with a full chunk of orphans
    await sweepQuotaRetention(ORPHAN_MINUTE + 3_660_000, false)
    expect(calls.at(-1)).toEqual({ orphans: true }) // the orphan backlog continues with the orphan scans
    await sweepQuotaRetention(ORPHAN_MINUTE + 3_720_000, false)
    expect(calls).toHaveLength(4)
  } finally { (repo as unknown as { quotaBalance: unknown }).quotaBalance = real }
})

test("a minute with no group at all costs one statement in total (no retention, no directory load)", async () => {
  const names: string[] = []
  const real = repo.quotaBalance
  ;(repo as unknown as { quotaBalance: unknown }).quotaBalance = new Proxy(real, {
    get(target, key) { const value = (target as never)[key] as unknown; if (typeof value !== "function") return value; return (...args: unknown[]) => { names.push(String(key)); return (value as (...a: unknown[]) => unknown).apply(target, args) } },
  })
  try {
    await sweepMaintenance(db, files, OFF_MINUTE)
    expect(names).toEqual(["hasEnabledGroups"])
  } finally { (repo as unknown as { quotaBalance: unknown }).quotaBalance = real }
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/gateway/tests/quota-sweep.test.ts packages/gateway/tests/quota-retention.test.ts`
Expected: FAIL, `../src/quota-balance/sweep` not found / assignments not swept.

- [ ] **Step 3: Implement the sweep**

```ts
// packages/gateway/src/quota-balance/sweep.ts
import { getRepo } from "../repo/index.ts"
import { QUOTA_PURGE_CHUNK } from "../repo/quota-balance.ts"
import { warn } from "./deps.ts"
import { getQuotaBalance, type QuotaBalance } from "./runtime.ts"

/** Join, monthly and scheduled reads are staggered: at most this many GitHub reads per member-sweep (early triggers are not held back). */
export const MAX_READS_PER_SWEEP = 2

/**
 * One minute's turn over every member of an enabled group: reads whose time has come, early triggers, and the provisional cut-off when the estimate
 * is at the hard line but the floor blocks the confirming read. The start member rotates so the same one is not always first.
 */
export async function sweepQuotaBalance(now: number, qb: QuotaBalance = getQuotaBalance()): Promise<{ members: number; reads: number }> {
  // With no enabled group (the common case) a minute costs this one statement and nothing else.
  if (!(await qb.deps.repo().quotaBalance.hasEnabledGroups())) return { members: 0, reads: 0 }
  const directory = await qb.directory.get({ fresh: true })
  const ids = [...directory.memberOf].flatMap(([id, groupId]) => directory.groups.get(groupId)?.enabled ? [id] : [])
  if (ids.length === 0) return { members: 0, reads: 0 }
  await qb.facts.get(ids, { fresh: true })
  const start = Math.floor(now / 60_000) % ids.length
  let reads = 0
  for (const id of [...ids.slice(start), ...ids.slice(0, start)]) {
    try {
      const outcome = await qb.reader.evaluateMember(id, { allowScheduled: reads < MAX_READS_PER_SWEEP, fresh: false })
      if (outcome.status === "read" || outcome.status === "error") reads++
    } catch (error) { warn("quota_sweep_member_failed", error) }
  }
  return { members: ids.length, reads }
}

let dateBacklog = false
let orphanBacklog = false
export const resetQuotaRetentionState = (): void => { dateBacklog = false; orphanBacklog = false }

/**
 * Retention (idle assignments, reads older than 90 days, cost buckets older than 10 days, orphan scans) runs in the hourly orphan minute (D23), and
 * again on the next sweeps while a pass used up a full chunk: a date-based backlog continues without the orphan scans, an orphan backlog with them.
 * Any other minute issues no statement.
 */
export async function sweepQuotaRetention(now: number, orphanMinute: boolean): Promise<void> {
  if (!orphanMinute && !dateBacklog && !orphanBacklog) return
  const orphans = orphanMinute || orphanBacklog
  const result = await getRepo().quotaBalance.deleteExpired(now, { orphans })
  dateBacklog = [result.assignments, result.reads, result.buckets].some(n => n >= QUOTA_PURGE_CHUNK)
  orphanBacklog = orphans && result.orphans >= QUOTA_PURGE_CHUNK
}
```

In `packages/gateway/src/maintenance.ts` add the imports, reset the backlog in `resetTelemetryRetentionState`, and add two tasks to the list (the control-plane import registers the proxy-chain aware fetcher for the reads):

```ts
import "./control-plane/quota-balance/fetcher.ts"
import { resetQuotaRetentionState, sweepQuotaBalance, sweepQuotaRetention } from "./quota-balance/sweep.ts"
// ...
export const resetTelemetryRetentionState = (): void => { orphanBacklog = false; protectionOrphanBacklog = false; resetQuotaRetentionState() }
// ... in the task list, after "protection_retention":
    // Quota balancing: one cached directory read per minute when no group exists; with groups, the reads the scheduler asks for (staggered, at most a few a day per member).
    ["quota_balance", () => sweepQuotaBalance(now).then(() => {})],
    ["quota_balance_retention", () => sweepQuotaRetention(now, isTelemetryRetentionDue(now))],
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/tests/quota-sweep.test.ts packages/gateway/tests/quota-retention.test.ts packages/gateway/tests/protection-retention.test.ts`
Expected: PASS. If `quota-sweep` fails on the early-trigger test, check that after the base reads each member's state has `nextReadAt` six hours out so that only the drift/soft triggers can fire at `T0 + 2 h`.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run --filter '@vibe-llm/gateway' typecheck`
Expected: no errors.

```bash
git add packages/gateway/src/quota-balance/sweep.ts packages/gateway/src/maintenance.ts packages/gateway/tests/quota-sweep.test.ts packages/gateway/tests/quota-retention.test.ts
git commit -m "feat(quota-balance): minute sweep for reads and cut-off, and retention" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 13: A group as one routing item, and the balancer that orders a group's members for a request

> **Contract from the Task 7-9 review (D29).** The balancer must: pass a single candidate through `planGroupChoice` (it skips only the ranking); view members with `viewMembers(..., facts.unavailable)` so a facts load failure does not skip the group; treat `assignments.get(...) === undefined` as a failed lookup (choose without writing, no `create`/`move`); write a new session with `await assignments.create(...)` and put the returned (stored) member first when it differs from the chosen one; write a move with `assignments.move(assignment, previousUpstreamId)`. The code below still uses `put` and a `block.length === 1` shortcut in places: replace them as described.

**Files:**
- Create: `packages/gateway/src/quota-balance/ordering.ts`
- Create: `packages/gateway/src/quota-balance/balance.ts`
- Modify: `packages/gateway/src/quota-balance/runtime.ts` (add `balance`)
- Modify: `packages/gateway/src/data-plane/providers/registry.ts` (`sortUpstreams` ~L295, `listVisibleUpstreams` ~L301)
- Create: `packages/gateway/tests/quota-ordering.test.ts`
- Create: `packages/gateway/tests/quota-balance.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-ordering.test.ts
import { expect, test } from "bun:test"
import { orderUpstreamsForRouting } from "../src/quota-balance/ordering"
import type { GroupDirectory } from "../src/quota-balance/directory"
import { DEFAULT_GROUP_SETTINGS, type UpstreamGroup } from "../src/repo/quota-balance"

const up = (id: string, sortOrder: number, createdAt = "2026-01-01T00:00:00Z") => ({ id, sortOrder, createdAt })
const group = (id: string, sortOrder: number, createdAt = "2026-01-01T00:00:00Z"): UpstreamGroup =>
  ({ id, ownerId: "o", name: id, enabled: true, sortOrder, settings: DEFAULT_GROUP_SETTINGS, createdAt, updatedAt: createdAt })
const directory = (groups: UpstreamGroup[], members: Record<string, string>): GroupDirectory =>
  ({ groups: new Map(groups.map(g => [g.id, g])), memberOf: new Map(Object.entries(members)) })

test("without groups the order is sort_order, created_at, id as before", () => {
  const list = [up("b", 1), up("a", 1), up("c", 0), up("d", 1, "2025-01-01T00:00:00Z")]
  expect(orderUpstreamsForRouting(list, directory([], {})).map(u => u.id)).toEqual(["c", "d", "a", "b"])
})

test("a group takes its own place among ungrouped upstreams; members stay together and ignore their own sort_order", () => {
  const g = group("ug_" + "1".repeat(32), 5)
  const list = [up("u0", 0), up("m1", 100, "2026-02-01T00:00:00Z"), up("m2", -50, "2026-01-01T00:00:00Z"), up("u1", 10), up("u2", 3)]
  const ordered = orderUpstreamsForRouting(list, directory([g], { m1: g.id, m2: g.id })).map(u => u.id)
  expect(ordered).toEqual(["u0", "u2", "m2", "m1", "u1"])
})

test("two groups and ties: the item key is (sort_order, created_at, id) of the group or the ungrouped upstream", () => {
  const g1 = group("ug_" + "1".repeat(32), 2, "2026-03-01T00:00:00Z")
  const g2 = group("ug_" + "2".repeat(32), 2, "2026-02-01T00:00:00Z")
  const list = [up("x", 2, "2026-02-15T00:00:00Z"), up("a1", 9), up("b1", 9)]
  const ordered = orderUpstreamsForRouting(list, directory([g1, g2], { a1: g1.id, b1: g2.id })).map(u => u.id)
  expect(ordered).toEqual(["b1", "x", "a1"])
})

test("a membership that points at an unknown group is ignored", () => {
  const list = [up("a", 1), up("b", 0)]
  expect(orderUpstreamsForRouting(list, directory([], { a: "ug_" + "9".repeat(32) })).map(u => u.id)).toEqual(["b", "a"])
})
```

```ts
// packages/gateway/tests/quota-balance.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { QuotaBalance } from "../src/quota-balance/runtime"
import { newBalanceSession, resolveSessionKey, type BalanceSession } from "../src/quota-balance/session-key"
import { rendezvousScore } from "../src/quota-balance/selection"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"
import { T0, gid, quotaFixture, type Fixture } from "./quota-caches-fixture"

const H = 3_600_000
const M = 60_000
let f: Fixture
let qb: QuotaBalance
beforeEach(() => { f = quotaFixture(); qb = new QuotaBalance(f.deps) })
afterEach(() => f.close())

type Item = { upstream: string }
const items = (...ids: string[]): Item[] => ids.map(upstream => ({ upstream }))
const ids = (list: readonly Item[]) => list.map(i => i.upstream)
const sessionOf = (explicitId: string): BalanceSession => newBalanceSession({ apiKeyId: "key_test_1", explicitId, fingerprint: null })
/** A session whose stable hash ranks `wins` above `over` (the rendezvous score uses the derived session key, so search over explicit ids). */
async function sessionWhere(wins: string, over: string): Promise<BalanceSession> {
  for (let i = 0; i < 5000; i++) {
    const session = sessionOf(`client-session-${i}`)
    const key = (await resolveSessionKey(session))!
    if (rendezvousScore(key, wins) > rendezvousScore(key, over)) return session
  }
  throw new Error("no session found")
}
const balance = (list: Item[], session?: BalanceSession) => qb.balance({ items: list, upstreamOf: i => i.upstream, session })

/** A member of group `n` with a real read at `share` of its own entitlement and a learned k (so the estimate does not run on the conservative fallback). */
async function member(id: string, n: number, share: number | null, over: { entitlement?: number } = {}) {
  f.addUpstream(id)
  await f.repo.quotaBalance.setMembership(id, gid(n), { nowMs: T0, intervalHours: 6 })
  if (share === null) return
  const entitlement = over.entitlement ?? 1000
  await f.repo.quotaBalance.recordRead({ upstreamId: id, at: T0 - H, source: "github", used: share * entitlement, entitlement, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: null, unitForm: null, resetAt: null, costAdjustUsd: 0, entitlementChange: null }, T0 - H)
  await f.repo.quotaBalance.saveEstimator(id, { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: T0 + 6 * H, lastErrorPoints: null }, T0)
}
const assign = (key: string, upstreamId: string, over: { lastSeenAt?: number; movedAt?: number } = {}) =>
  qb.assignments.put({ groupId: gid(1), sessionKey: key, upstreamId, createdAt: T0 - H, lastSeenAt: over.lastSeenAt ?? T0 - M, movedAt: over.movedAt ?? T0, recentCostUsd: 0, recentCostAt: T0 })

test("without any group the candidates pass through untouched", async () => {
  const out = await balance(items("x", "y"))
  expect(ids(out.ordered)).toEqual(["x", "y"])
  expect(out.skipped).toEqual([])
})

test("a group is one item among ungrouped upstreams, ordered inside by the lowest projected share; shares, not amounts, decide", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.5, { entitlement: 1000 })
  await member("up_test_b", 1, 0.2, { entitlement: 100 }) // 20 used of 100: a tiny absolute amount, a low share
  await member("up_test_c", 1, 0.7, { entitlement: 100000 }) // 70000 used: a huge amount, but only 70 %
  const out = await balance(items("x", "up_test_a", "up_test_b", "up_test_c", "y"), sessionOf("s1"))
  expect(ids(out.ordered)).toEqual(["x", "up_test_b", "up_test_a", "up_test_c", "y"])
})

test("members within the tolerance band are chosen between by the session's stable hash", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.33)
  expect(ids((await balance(items("up_test_a", "up_test_b"), await sessionWhere("up_test_a", "up_test_b"))).ordered)[0]).toBe("up_test_a")
  expect(ids((await balance(items("up_test_a", "up_test_b"), await sessionWhere("up_test_b", "up_test_a"))).ordered)[0]).toBe("up_test_b")
})

test("a session sticks to the member that served it, and the assignment is stored after the winner is known", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.33)
  const session = await sessionWhere("up_test_b", "up_test_a")
  const first = await balance(items("up_test_a", "up_test_b"), session)
  expect(ids(first.ordered)[0]).toBe("up_test_b")
  first.commit("up_test_b")
  expect(session.assigned).toMatchObject({ groupId: gid(1), upstreamId: "up_test_b" })
  await f.idle()
  const key = session.assigned!.sessionKey
  expect(await f.repo.quotaBalance.getAssignment(gid(1), key)).toMatchObject({ upstreamId: "up_test_b", createdAt: T0, movedAt: T0 })

  f.clock.now = T0 + M
  await f.repo.quotaBalance.recordCost({ upstreamId: "up_test_b", nowMs: f.clock.now, costUsd: 1, monthKey: "2026-11" }) // b gets a little fuller (0.35 vs 0.30): still sticky
  qb.facts.invalidate()
  const second = await balance(items("up_test_a", "up_test_b"), sessionOf(session.input.explicitId!))
  expect(ids(second.ordered)).toEqual(["up_test_b", "up_test_a"])
})

test("when the first choice cannot be materialised the assignment follows the member that actually served", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.60)
  const session = sessionOf("fallback")
  const out = await balance(items("up_test_a", "up_test_b"), session)
  expect(ids(out.ordered)).toEqual(["up_test_a", "up_test_b"])
  out.commit("up_test_b")
  await f.idle()
  expect(await f.repo.quotaBalance.getAssignment(gid(1), session.assigned!.sessionKey)).toMatchObject({ upstreamId: "up_test_b" })
})

test("a session that comes back after the idle time is re-chosen (free); one that comes back in time is not", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.33)
  const session = await sessionWhere("up_test_a", "up_test_b")
  const key = (await resolveSessionKey(session))!
  assign(key, "up_test_b", { lastSeenAt: T0 - 11 * M })
  expect(ids((await balance(items("up_test_a", "up_test_b"), session)).ordered)[0]).toBe("up_test_a") // idle: the band is decided by the hash again
  assign(key, "up_test_b", { lastSeenAt: T0 - 5 * M })
  expect(ids((await balance(items("up_test_a", "up_test_b"), session)).ordered)[0]).toBe("up_test_b")
})

test("an assignment to a member that is no longer a candidate (removed, paused, cut off, wrong model) is replaced on the next request", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.30)
  await member("up_test_b", 1, 0.33)
  const session = sessionOf("replace-me")
  const key = (await resolveSessionKey(session))!
  assign(key, "up_test_gone")
  const out = await balance(items("up_test_a", "up_test_b"), session)
  const first = ids(out.ordered)[0]!
  out.commit(first)
  await f.idle()
  expect(await f.repo.quotaBalance.getAssignment(gid(1), key)).toMatchObject({ upstreamId: first, createdAt: T0 - H, movedAt: T0 })
})

test("stop: members at the soft line take no new sessions, the group is skipped and matching continues; overage serves them", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.92)
  await member("up_test_b", 1, 0.93)
  const out = await balance(items("up_test_a", "up_test_b", "later"), sessionOf("s"))
  expect(ids(out.ordered)).toEqual(["later"])
  expect(out.skipped).toEqual([{ groupId: gid(1), name: "Group 1", ownerId: "user_test_o" }])
  await f.repo.quotaBalance.updateGroup(gid(1), { settings: { ...DEFAULT_GROUP_SETTINGS, exhaustedPolicy: "overage" } }, "now")
  await qb.directory.get({ fresh: true })
  const over = await balance(items("up_test_a", "up_test_b", "later"), await sessionWhere("up_test_a", "up_test_b"))
  expect(ids(over.ordered)).toEqual(["up_test_a", "up_test_b", "later"])
  expect(over.skipped).toEqual([])
})

test("the soft line alone does not move an existing session", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.92)
  await member("up_test_b", 1, 0.85)
  const session = sessionOf("stays")
  assign((await resolveSessionKey(session))!, "up_test_a")
  const out = await balance(items("up_test_a", "up_test_b"), session)
  expect(ids(out.ordered)).toEqual(["up_test_a", "up_test_b"])
})

test("a member without any read takes no new sessions; a single eligible candidate skips only the ranking (it is still subject to the soft line); a disabled group is dropped", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.3)
  await member("up_test_unread", 1, null)
  expect(ids((await balance(items("up_test_a", "up_test_unread"), sessionOf("s"))).ordered)).toEqual(["up_test_a"])
  expect(ids((await balance(items("up_test_unread"), sessionOf("s"))).ordered)).toEqual([]) // one candidate without a read takes no new session
  await f.repo.quotaBalance.updateGroup(gid(1), { enabled: false }, "now")
  await qb.directory.get({ fresh: true })
  const dropped = await balance(items("up_test_a", "up_test_unread", "later"), sessionOf("s"))
  expect(ids(dropped.ordered)).toEqual(["later"])
  expect(dropped.skipped).toEqual([])
})

test("a per-key whitelist puts the group at the position of its first whitelisted member", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.5)
  await member("up_test_b", 1, 0.2)
  const out = await balance(items("up_test_b", "x", "up_test_a"), sessionOf("s"))
  expect(ids(out.ordered)).toEqual(["up_test_b", "up_test_a", "x"])
})

test("requests without a session are balanced per request and write no assignment", async () => {
  await f.addGroup(1)
  await member("up_test_a", 1, 0.2)
  await member("up_test_b", 1, 0.6)
  const out = await balance(items("up_test_a", "up_test_b"))
  expect(ids(out.ordered)).toEqual(["up_test_a", "up_test_b"])
  out.commit("up_test_a")
  await f.idle()
  expect(f.db.query("SELECT COUNT(*) AS n FROM session_assignments").get()).toEqual({ n: 0 })
  const noIdentity = newBalanceSession({ apiKeyId: "key_test_1", explicitId: null, fingerprint: null })
  const bare = await balance(items("up_test_a", "up_test_b"), noIdentity)
  bare.commit("up_test_a")
  await f.idle()
  expect(noIdentity.assigned).toBeUndefined()
})

test("a failing repository leaves the original order", async () => {
  const broken = new QuotaBalance({ ...f.deps, repo: () => { throw new Error("down") } })
  const out = await broken.balance({ items: items("a", "b"), upstreamOf: i => i.upstream })
  expect(ids(out.ordered)).toEqual(["a", "b"])
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/gateway/tests/quota-ordering.test.ts packages/gateway/tests/quota-balance.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the ordering and the balancer**

```ts
// packages/gateway/src/quota-balance/ordering.ts
import type { GroupDirectory } from "./directory.ts"

interface Orderable { id: string; sortOrder: number; createdAt: string }

/**
 * Routing order of upstreams with groups: an ungrouped upstream sorts by its own (sortOrder, createdAt, id), a group member by its group's, so the group is
 * one item; members of one group stay together, ordered by their own (createdAt, id). A member's own sortOrder is ignored while it is in a group.
 */
export function orderUpstreamsForRouting<T extends Orderable>(upstreams: T[], directory: GroupDirectory): T[] {
  const itemOf = (upstream: T): { sortOrder: number; createdAt: string; id: string } => {
    const groupId = directory.memberOf.get(upstream.id)
    const group = groupId ? directory.groups.get(groupId) : undefined
    return group ? { sortOrder: group.sortOrder, createdAt: group.createdAt, id: group.id } : { sortOrder: upstream.sortOrder, createdAt: upstream.createdAt, id: upstream.id }
  }
  return upstreams.sort((a, b) => {
    const x = itemOf(a)
    const y = itemOf(b)
    return x.sortOrder - y.sortOrder || x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  })
}
```

```ts
// packages/gateway/src/quota-balance/balance.ts
import type { UpstreamGroup } from "../repo/quota-balance.ts"
import { touchIntervalMs, type AssignmentStore } from "./assignments.ts"
import { warn, type QuotaDeps } from "./deps.ts"
import type { GroupDirectoryCache } from "./directory.ts"
import { viewMembers, type MemberFactsCache } from "./facts.ts"
import { planGroupChoice, type GroupChoice } from "./selection.ts"
import { resolveSessionKey, type BalanceSession } from "./session-key.ts"

export interface BalanceParts { deps: QuotaDeps; directory: GroupDirectoryCache; facts: MemberFactsCache; assignments: AssignmentStore }
export interface BalanceArgs<T> {
  /** Candidates in routing order (a group's members are contiguous, or scattered under a key whitelist). */
  items: readonly T[]
  upstreamOf: (item: T) => string
  /** Absent for requests without a session (embeddings, images, count tokens): balanced per request, nothing is stored. */
  session?: BalanceSession
}
export interface SkippedGroup { groupId: string; name: string; ownerId: string }
export interface BalanceOutcome<T> {
  ordered: T[]
  /** Groups left out because no member could take the request (`stop` at the soft line, or no member with a read). */
  skipped: SkippedGroup[]
  /** Call with the upstream that actually served; stores or refreshes the session's assignment. */
  commit(servedUpstreamId: string): void
}

/** Fail-open: any error leaves the candidates as they were. */
export async function balanceCandidates<T>(parts: BalanceParts, args: BalanceArgs<T>): Promise<BalanceOutcome<T>> {
  try { return await balance(parts, args) } catch (error) {
    warn("quota_balance_failed", error)
    return { ordered: [...args.items], skipped: [], commit: () => {} }
  }
}

async function balance<T>(parts: BalanceParts, args: BalanceArgs<T>): Promise<BalanceOutcome<T>> {
  const passthrough: BalanceOutcome<T> = { ordered: [...args.items], skipped: [], commit: () => {} }
  const directory = await parts.directory.get()
  if (directory.memberOf.size === 0) return passthrough
  const blocks = new Map<string, T[]>()
  const order: Array<{ item: T } | { groupId: string }> = []
  for (const item of args.items) {
    const groupId = directory.memberOf.get(args.upstreamOf(item))
    if (!groupId || !directory.groups.has(groupId)) { order.push({ item }); continue }
    let block = blocks.get(groupId)
    if (!block) { block = []; blocks.set(groupId, block); order.push({ groupId }) }
    block.push(item)
  }
  if (blocks.size === 0) return passthrough

  const now = parts.deps.now()
  const sessionKey = args.session ? await resolveSessionKey(args.session) : null
  const nonce = crypto.randomUUID()
  const ordered: T[] = []
  const skipped: SkippedGroup[] = []
  const commits = new Map<string, (served: string) => void>()
  for (const entry of order) {
    if ("item" in entry) { ordered.push(entry.item); continue }
    const group = directory.groups.get(entry.groupId)!
    const block = blocks.get(entry.groupId)!
    if (!group.enabled) continue
    // A single candidate skips only the ranking: `planGroupChoice` still applies the soft line (skip or overage) and the assignment is still remembered.
    const memberIds = block.map(args.upstreamOf)
    const facts = await parts.facts.get(memberIds)
    const members = viewMembers(memberIds, facts, group.settings, now, parts.facts.unavailable)
    const assignment = sessionKey !== null ? await parts.assignments.get(group.id, sessionKey) : null
    const choice = planGroupChoice({ assignment, members, settings: group.settings, sessionKey: sessionKey ?? nonce, now })
    if (choice.kind === "skip") { skipped.push({ groupId: group.id, name: group.name, ownerId: group.ownerId }); continue }
    const byId = new Map(block.map(item => [args.upstreamOf(item), item]))
    for (const id of choice.ordered) ordered.push(byId.get(id)!)
    if (sessionKey !== null) commits.set(group.id, served => commitChoice(parts, args.session, group, sessionKey, assignment, choice, served, now))
  }
  return {
    ordered, skipped,
    commit(served) {
      const groupId = directory.memberOf.get(served)
      if (groupId) commits.get(groupId)?.(served)
    },
  }
}

function commitChoice(
  parts: BalanceParts, session: BalanceSession | undefined, group: UpstreamGroup, sessionKey: string,
  current: Awaited<ReturnType<AssignmentStore["get"]>>, choice: Exclude<GroupChoice, { kind: "skip" }>, served: string, now: number,
): void {
  if (choice.kind === "assign") {
    parts.assignments.put({
      groupId: group.id, sessionKey, upstreamId: served, createdAt: current?.createdAt ?? now, lastSeenAt: now,
      movedAt: current && current.upstreamId === served ? current.movedAt : now, recentCostUsd: current?.recentCostUsd ?? 0, recentCostAt: current?.recentCostAt ?? now,
    })
  } else if (current && current.upstreamId === served) {
    parts.assignments.touch(current, now, touchIntervalMs(group.settings.idleRebalanceMinutes))
  } else return // a fallback served a kept session: the assignment stays where it is
  if (session) session.assigned = { groupId: group.id, sessionKey, upstreamId: served }
}
```

In `packages/gateway/src/quota-balance/runtime.ts` add the import `import { balanceCandidates, type BalanceArgs, type BalanceOutcome } from "./balance.ts"` and the method on `QuotaBalance`:

```ts
  /** Orders the candidates of every group for this request (see balance.ts). Fail-open. */
  balance<T>(args: BalanceArgs<T>): Promise<BalanceOutcome<T>> { return balanceCandidates(this, args) }
```
(`this` satisfies `BalanceParts`: it has `deps`, `directory`, `facts`, `assignments`.)

- [ ] **Step 4: Use the directory in the registry's ordering**

In `packages/gateway/src/data-plane/providers/registry.ts` add imports and change the sort so `listVisibleUpstreams` orders with the directory (the directory is fail-open and cached 10 s):

```ts
import { orderUpstreamsForRouting } from '../../quota-balance/ordering.ts'
import { getQuotaBalance } from '../../quota-balance/runtime.ts'

async function sortUpstreams(upstreams: StoredUpstreamRecord[]): Promise<StoredUpstreamRecord[]> {
  return orderUpstreamsForRouting(upstreams, await getQuotaBalance().directory.get())
}

async function listVisibleUpstreams(ownerId?: UserId, allOwners = false): Promise<StoredUpstreamRecord[]> {
  if (allOwners) return sortUpstreams(await getDataPlaneConfiguration().upstreams.list({}))
  if (ownerId !== undefined) {
    const [globalUpstreams, ownerUpstreams] = await Promise.all([
      getDataPlaneConfiguration().upstreams.list({ ownerId: '' as UserId }),
      getDataPlaneConfiguration().upstreams.list({ ownerId }),
    ])
    const byId = new Map([...globalUpstreams, ...ownerUpstreams].map((u) => [u.id, u]))
    return sortUpstreams([...byId.values()])
  }
  return getDataPlaneConfiguration().upstreams.list({ ownerId: '' as UserId })
}
```
(Only the two `sortUpstreams(...)` call sites change from sync to `return sortUpstreams(...)` of a promise; the function is already async.)

- [ ] **Step 5: Run the tests, the routing regressions and the typecheck**

Run: `bun test packages/gateway/tests/quota-ordering.test.ts packages/gateway/tests/quota-balance.test.ts packages/gateway/tests/routing-materialization.sqlite.test.ts packages/gateway/tests/api-key-upstreams.sqlite.test.ts packages/gateway/tests/mapped-model-routing.e2e.test.ts`
Expected: PASS. In `quota-balance.test.ts`, the whitelist test passes items in the order `[b, x, a]` as the registry would produce them for a whitelist.

Run: `bun run --filter '@vibe-llm/gateway' typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/quota-balance/ordering.ts packages/gateway/src/quota-balance/balance.ts packages/gateway/src/quota-balance/runtime.ts packages/gateway/src/data-plane/providers/registry.ts packages/gateway/tests/quota-ordering.test.ts packages/gateway/tests/quota-balance.test.ts
git commit -m "feat(quota-balance): group as one routing item and dynamic member order per request" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 14: Routing integration: session plumbing, balancing in the chat flows and `resolveBinding`, `group_quota_exhausted`

**Files:**
- Create: `packages/gateway/src/data-plane/chat-flow/shared/balance-session.ts`
- Modify: `packages/gateway/src/data-plane/models/routes.ts` (`DataPlaneAuthCtx`, ~L107)
- Modify: `chat-flow/chat-completions/http.ts`, `chat-flow/messages/http.ts`, `chat-flow/responses/http.ts`, `chat-flow/gemini/http.ts`, `chat-flow/responses/session.ts` (~L196)
- Modify: `chat-flow/chat-completions/serve.ts` (~L122), `chat-flow/messages/serve.ts` (~L129), `chat-flow/responses/serve.ts` (~L276) (gemini spreads `args.auth`)
- Modify: `packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts` (types ~L28-L44, selection ~L90-L137)
- Modify: `packages/gateway/src/data-plane/routing/paused-route.ts` (add `describeGroupExhausted`)
- Modify: `packages/gateway/src/data-plane/routing/binding-resolver.ts` (loop ~L54-L70)
- Modify: `packages/gateway/src/data-plane/errors/upstream-paused.ts`
- Modify: `chat-flow/{chat-completions,messages,responses,gemini}/attempt.ts` (the `upstream-paused` line)
- Create: `packages/gateway/tests/quota-routing.sqlite.test.ts`
- Create: `packages/gateway/tests/quota-balance-session.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-balance-session.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { __resetPlatformForTests, initRuntimeLocation } from "@vibe-core/platform"
import { withBalanceSession } from "../src/data-plane/chat-flow/shared/balance-session"
import { kitDeps } from "../src/data-plane/chat-flow/shared/kit-deps"
import { resolveSessionKey } from "../src/quota-balance/session-key"

beforeEach(() => { initRuntimeLocation("bun") })
afterEach(() => { __resetPlatformForTests() })

test("withBalanceSession reads the identity from the body and headers and keeps the rest of the auth context", async () => {
  const auth = { userId: "user_test_1" as never, apiKeyId: "key_test_1" as never, routingPolicy: undefined }
  const out = withBalanceSession(auth, "chat_completions", { prompt_cache_key: "conv-7", messages: [{ role: "user", content: "x" }] }, new Headers())
  expect(out).toMatchObject({ userId: "user_test_1", apiKeyId: "key_test_1" })
  expect(out.balanceSession?.input).toEqual({ apiKeyId: "key_test_1", explicitId: "conv-7", fingerprint: expect.any(String) })
  expect(await resolveSessionKey(out.balanceSession!)).toMatch(/^[0-9a-f]{32}$/)
  expect(auth).not.toHaveProperty("balanceSession") // the original context is not mutated
})

test("a body that cannot be read leaves the context alone", () => {
  const auth = { apiKeyId: "key_test_1" as never }
  expect(withBalanceSession(auth, "messages", { messages: [] }, undefined).balanceSession?.input.explicitId).toBeNull()
})

test("the telemetry context carries the session, which is how the cost hook finds it", () => {
  const session = { input: { apiKeyId: "k", explicitId: "e", fingerprint: null } }
  const ctx = kitDeps.buildTelemetryCtx({
    auth: { apiKeyId: "key_test_1", balanceSession: session } as never, obsCtx: {} as never, extra: { incomingModel: "m" }, isStreaming: false, requestStartedAt: 0, endpointTag: "chat_completions",
  } as never)
  expect(ctx.quotaSession).toBe(session)
})
```

```ts
// packages/gateway/tests/quota-routing.sqlite.test.ts
import { afterEach, expect, test } from "bun:test"
import { __resetPlatformForTests } from "@vibe-core/platform"
import { selectBindingForChatCompletions } from "../src/data-plane/chat-flow/shared/select-binding"
import { resolveBinding } from "../src/data-plane/routing/binding-resolver"
import { UpstreamPausedError } from "../src/data-plane/errors/upstream-paused"
import { describeGroupExhausted } from "../src/data-plane/routing/paused-route"
import { QuotaBalance, setQuotaBalanceForTests } from "../src/quota-balance/runtime"
import { newBalanceSession } from "../src/quota-balance/session-key"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"
import { NOW, enforcementFixture } from "./protection-enforcement-fixture"

const H = 3_600_000
const OWNER = "user_test_owner"
const G = `ug_${"1".repeat(32)}`
let fixture: Awaited<ReturnType<typeof enforcementFixture>>
let qb: QuotaBalance
const pending: Array<Promise<unknown>> = []
afterEach(() => { setQuotaBalanceForTests(null); fixture?.close(); __resetPlatformForTests() })

/** Custom upstreams (they serve model "shared" on chat and embeddings) owned by OWNER; a and b become group members in `group`. */
async function setup(ids: string[] = ["up_test_a", "up_test_b", "up_test_free"]) {
  fixture = await enforcementFixture(ids, { ownerId: OWNER })
  qb = new QuotaBalance({ repo: () => fixture.repo, now: () => fixture.clock.now, schedule: w => { pending.push(w.catch(() => {})) }, random: () => 0.5 }, { protection: () => fixture.runtime })
  setQuotaBalanceForTests(qb)
}
const read = (id: string, share: number, at = NOW - H) => fixture.repo.quotaBalance.recordRead(
  { upstreamId: id, at, source: "github", used: share * 1000, entitlement: 1000, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: null, unitForm: null, resetAt: null, costAdjustUsd: 0, entitlementChange: null }, at)
async function group(sortOrder: number, shares: { a: number; b: number }, settings = DEFAULT_GROUP_SETTINGS) {
  await fixture.repo.quotaBalance.createGroup({ id: G, ownerId: OWNER, name: "Pool", enabled: true, sortOrder, settings, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" })
  for (const [id, share] of [["up_test_a", shares.a], ["up_test_b", shares.b]] as const) {
    await fixture.repo.quotaBalance.setMembership(id, G, { nowMs: NOW, intervalHours: 6 })
    await read(id, share)
    await fixture.repo.quotaBalance.saveEstimator(id, { k: 0.02, kPrev: null, kSamples: 5, o: 0, oSamples: 0, intervalHours: 6, learnSince: 0, nextReadAt: NOW + 6 * H, lastErrorPoints: null }, NOW)
  }
  await qb.directory.get({ fresh: true })
}
const chat = (auth: Record<string, unknown> = {}) =>
  selectBindingForChatCompletions({ model: "shared", auth: { ownerId: OWNER, balanceSession: newBalanceSession({ apiKeyId: "key_test_1", explicitId: "conv-1", fingerprint: null }), ...auth } })
const servedBy = async (auth?: Record<string, unknown>) => { const sel = await chat(auth); return sel.kind === "ok" ? sel.binding.upstream : sel }

test("the group is one item: it sits where its own sort order puts it, and the member with the lowest projected share serves", async () => {
  await setup()
  await group(5, { a: 0.6, b: 0.2 }) // free has sort order 2: it comes first
  expect(await servedBy()).toBe("up_test_free")
  await fixture.repo.quotaBalance.updateGroup(G, { sortOrder: -1 }, "now")
  await qb.directory.get({ fresh: true })
  expect(await servedBy()).toBe("up_test_b")
})

test("the assignment is stored for the member that served and the next request keeps it", async () => {
  await setup()
  await group(-1, { a: 0.30, b: 0.33 })
  const first = await servedBy()
  expect(["up_test_a", "up_test_b"]).toContain(first)
  await Promise.all(pending.splice(0))
  expect(fixture.db.query("SELECT upstream_id FROM session_assignments").all()).toEqual([{ upstream_id: first }])
  expect(await servedBy()).toBe(first)
})

test("pinned requests bypass balancing and go to the pinned upstream even at the soft line", async () => {
  await setup()
  await group(-1, { a: 0.93, b: 0.2 })
  expect(await servedBy({ pin: "up_test_a" })).toBe("up_test_a")
  expect(fixture.db.query("SELECT COUNT(*) AS n FROM session_assignments").get()).toEqual({ n: 0 })
})

test("with every member at the soft line the group is skipped and matching continues", async () => {
  await setup()
  await group(-1, { a: 0.92, b: 0.93 })
  expect(await servedBy()).toBe("up_test_free")
})

test("with nothing else to serve the client gets group_quota_exhausted with Retry-After to the next reset, naming the group for its owner", async () => {
  await setup(["up_test_a", "up_test_b"])
  await group(-1, { a: 0.92, b: 0.93 })
  const sel = await chat()
  expect(sel).toMatchObject({ kind: "upstream-paused", code: "group_quota_exhausted", retryAfterSeconds: Math.ceil((Date.UTC(2026, 11, 1) - NOW) / 1000) })
  expect(sel.kind === "upstream-paused" && sel.message).toContain('"Pool"')
})

test("the overage policy lets new sessions use members above the soft line", async () => {
  await setup(["up_test_a", "up_test_b"])
  await group(-1, { a: 0.92, b: 0.93 }, { ...DEFAULT_GROUP_SETTINGS, exhaustedPolicy: "overage" })
  expect(["up_test_a", "up_test_b"]).toContain(await servedBy())
})

test("a cut-off member is out of the candidates and the other member serves directly", async () => {
  await setup()
  await group(-1, { a: 0.5, b: 0.6 })
  await fixture.pause({ targetId: "up_test_a" })
  await fixture.tick()
  expect(await servedBy()).toBe("up_test_b")
})

test("embeddings and other resolveBinding callers balance per request", async () => {
  await setup()
  await group(-1, { a: 0.6, b: 0.2 })
  expect((await resolveBinding("shared", "embeddings", { ownerId: OWNER }))?.upstream).toBe("up_test_b")
  await read("up_test_b", 0.7, NOW - 30 * 60_000)
  await fixture.repo.quotaBalance.updateGroup(G, { settings: { ...DEFAULT_GROUP_SETTINGS, softShare: 0.5 } }, "now")
  await qb.directory.get({ fresh: true })
  qb.facts.invalidate()
  expect((await resolveBinding("shared", "embeddings", { ownerId: OWNER }))?.upstream).toBe("up_test_free") // both members are at the soft line now
})

test("resolveBinding reports exhaustion as a 503 with the group_quota_exhausted code when nothing else can serve", async () => {
  await setup(["up_test_a", "up_test_b"])
  await group(-1, { a: 0.92, b: 0.93 })
  const error = await resolveBinding("shared", "embeddings", { ownerId: OWNER }).catch(e => e)
  expect(error).toBeInstanceOf(UpstreamPausedError)
  const response = (error as UpstreamPausedError).getResponse()
  expect(response.status).toBe(503)
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0)
  expect(await response.json()).toMatchObject({ error: { code: "group_quota_exhausted" } })
})

test("Retry-After is the earlier of the monthly reset and the end of a pause among the candidates; names are shown to the group's owner only", () => {
  const skipped = [{ groupId: G, name: "Pool", ownerId: OWNER }]
  const reset = Math.ceil((Date.UTC(2026, 11, 1) - NOW) / 1000)
  expect(describeGroupExhausted(skipped, [], OWNER, NOW).retryAfterSeconds).toBe(reset)
  expect(describeGroupExhausted(skipped, [NOW + 90_000], OWNER, NOW)).toMatchObject({ retryAfterSeconds: 90 })
  expect(describeGroupExhausted(skipped, [], OWNER, NOW).message).toContain('Upstream group "Pool"')
  expect(describeGroupExhausted(skipped, [], undefined, NOW).message).toContain("An upstream group")
  expect(describeGroupExhausted(skipped, [], undefined, NOW).message).not.toContain("Pool")
  expect(describeGroupExhausted([...skipped, { groupId: "ug_x", name: "Other", ownerId: "someone" }], [], OWNER, NOW).message).toContain('"Pool" and 1 other upstream group')
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test packages/gateway/tests/quota-balance-session.test.ts packages/gateway/tests/quota-routing.sqlite.test.ts`
Expected: FAIL (`balance-session` and `describeGroupExhausted` do not exist).

- [ ] **Step 3: Session plumbing**

```ts
// packages/gateway/src/data-plane/chat-flow/shared/balance-session.ts
import type { DataPlaneAuthCtx } from "../../models/routes.ts"
import { deriveSessionInput, newBalanceSession, type BalanceProtocol } from "../../../quota-balance/session-key.ts"

/**
 * Called by the HTTP handlers right after the body is parsed (before any interceptor can strip `prompt_cache_key`): attaches the request's
 * session identity for quota balancing. Cheap string work only; the hash is computed later and only when the request meets a group.
 */
export function withBalanceSession(auth: DataPlaneAuthCtx, protocol: BalanceProtocol, raw: unknown, headers: Headers | undefined): DataPlaneAuthCtx {
  try {
    return { ...auth, balanceSession: newBalanceSession(deriveSessionInput(protocol, raw, headers, auth.apiKeyId ?? auth.userId ?? "")) }
  } catch { return auth }
}
```

In `packages/gateway/src/data-plane/models/routes.ts` add to `DataPlaneAuthCtx` (and `import type { BalanceSession } from '../../quota-balance/session-key.ts'`):

```ts
  /** Quota-balancing session of this request, attached by the HTTP handler; the balancer reads it and records the assigned member on it. */
  balanceSession?: BalanceSession
```

In `select-binding.ts`'s `SelectBindingAuth` add `readonly balanceSession?: BalanceSession` (same import path adjusted: `'../../../quota-balance/session-key.ts'`).

HTTP handlers, after the body is parsed (`raw` known), attach the session and pass that auth to `serve*` (the dump opening before it keeps the original `auth`):

```ts
// chat-completions/http.ts
import { withBalanceSession } from '../shared/balance-session'
  ...
  return disconnect.wrap(await serveChatCompletions({ raw, auth: withBalanceSession(auth, 'chat_completions', raw, c.req.raw.headers), obsCtx: readObsCtx(c, auth), signal: disconnect.controller.signal, dump }))

// messages/http.ts
  return disconnect.wrap(await serveMessages({ raw, auth: withBalanceSession(auth, 'messages', raw, c.req.raw.headers), obsCtx: readObsCtx(c, auth), signal: disconnect.controller.signal, dump, inboundHeaders: c.req.raw.headers }))

// responses/http.ts (responsesHandlerCore): replace `auth,` in the serveResponses call
    auth: withBalanceSession(auth, 'responses', raw, c.req.raw.headers),

// gemini/http.ts: in the serveGemini call (not countTokens)
    auth: withBalanceSession(auth, 'gemini', raw, c.req.raw.headers),
```

For the Responses WebSocket turn (`responses/session.ts`, in `startResponsesTurn({ raw: message.raw, auth, ... })`) use `auth: withBalanceSession(auth, "responses", message.raw, headers)` (`headers` is the upgrade request's headers already used on the next lines; import `withBalanceSession` from `./../shared/balance-session`). (`FullAuthCtx` is assignable to `DataPlaneAuthCtx`, so this compiles as is.)

Serve layers forward the field where they build `auth` explicitly:

```ts
// chat-completions/serve.ts (~L122), messages/serve.ts (~L129), responses/serve.ts (~L276): add to the auth literal
    balanceSession: args.auth.balanceSession,
```
(`gemini/serve.ts` spreads `...args.auth`, so it is forwarded already.)

- [ ] **Step 4: Balancing in `selectBindingForProtocol` and the new error code**

In `select-binding.ts`:

```ts
import { getQuotaBalance } from '../../../quota-balance/runtime.ts'
import type { BalanceSession } from '../../../quota-balance/session-key.ts'
import { getProtection } from '../../../protection/runtime.ts'
// and extend the existing paused-route import: import { describeGroupExhausted, describePausedRoute } from '../../routing/paused-route.ts'

export interface UpstreamPausedSelection { kind: 'upstream-paused'; bareModel: string; message: string; retryAfterSeconds: number; code?: 'upstream_paused' | 'group_quota_exhausted' }
```
Then in `selectBindingForProtocol`, replace the selection part (from `let first` to the `!first` block) with:

```ts
  // Quota balancing: not for pinned requests, not for requests whose owned opaque state binds them to an upstream. Fail-open (the original order).
  const constrained = !!args.affinity && 'analysis' in args.affinity && args.affinity.analysis.hasRouteConstraints
  const candidates = enumeration.candidates
  const balance = constrained || args.auth.pin || enumeration.upstreamPin
    ? undefined
    : await getQuotaBalance().balance({ items: candidates, upstreamOf: candidate => candidate.binding.upstream, session: args.auth.balanceSession })
  let first
  try {
    first = await selectAffinityCandidate(balance?.ordered ?? candidates, args.affinity, bareModel, args.affinityOptions, enumeration.materialize)
  } catch (error) {
    // (unchanged affinity error handling)
  }
  if (first) balance?.commit(first.binding.upstream)
  if (!first) {
    if (enumeration.catalogUnavailable) return catalogUnavailable()
    if (!enumeration.sawModel) return { kind: "model-not-found", bareModel }
    if (balance && balance.skipped.length > 0) {
      const ends = (enumeration.pausedCandidates ?? []).flatMap(candidate => { const row = enumeration.pausedUpstreams?.get(candidate.binding.upstream); return row ? [row.endsAt] : [] })
      const exhausted = describeGroupExhausted(balance.skipped, ends, args.auth.ownerId, getProtection().now())
      return { kind: "upstream-paused", bareModel, code: "group_quota_exhausted", ...exhausted }
    }
    const paused = await pausedFor()
    if (paused) return { kind: "upstream-paused", bareModel, ...paused }
    return { kind: "no-eligible-binding", bareModel }
  }
```
(also `import { getProtection } from '../../../protection/runtime.ts'`; the existing `catch` block body stays exactly as it is.)

In `routing/paused-route.ts` add:

```ts
import { nextMonthStartMs } from '../../quota-balance/time.ts'
import type { SkippedGroup } from '../../quota-balance/balance.ts'
import { retryAfterSeconds } from '../../protection/messages.ts'

/**
 * The 503 for a request whose only candidates were groups with no member that can take a new session (all at the soft line under `stop`).
 * Retry-After: the earlier of the next 00:00 UTC on the 1st and the end of a pause among the request's paused candidates (`pauseEnds`, unix ms).
 * A group is named only for its owner.
 */
export function describeGroupExhausted(skipped: readonly SkippedGroup[], pauseEnds: readonly number[], ownerId: string | undefined, nowMs: number): PausedRoute {
  const resumesAt = Math.min(nextMonthStartMs(nowMs), ...pauseEnds)
  const seconds = retryAfterSeconds(resumesAt, nowMs)
  const named = skipped.filter(group => ownerId !== undefined && group.ownerId === ownerId).map(group => `"${group.name}"`)
  const hidden = skipped.length - named.length
  const subject = hidden === 0
    ? `Upstream group${named.length > 1 ? "s" : ""} ${named.join(", ")}`
    : named.length === 0
      ? (hidden === 1 ? "An upstream group" : `${hidden} upstream groups`)
      : `Upstream group${named.length > 1 ? "s" : ""} ${named.join(", ")} and ${hidden} other upstream group${hidden > 1 ? "s" : ""}`
  const plural = skipped.length > 1
  return {
    retryAfterSeconds: seconds,
    message: `${subject} ${plural ? "have" : "has"} no member with monthly usage allowance left for new sessions; service resumes at ${new Date(resumesAt).toISOString()}. Retry after ${seconds} seconds.`,
  }
}
```
(`PausedRoute` is already imported from `'../../protection/messages.ts'` in this file; add `retryAfterSeconds` to that import instead of a second import statement.)

`errors/upstream-paused.ts`: widen the code and let the error carry it:

```ts
export type PausedCode = 'upstream_paused' | 'key_paused' | 'group_quota_exhausted'
export function pausedBody(code: PausedCode, message: string, format?: 'gemini' | 'anthropic'): unknown { /* unchanged body */ }
export class UpstreamPausedError extends HTTPException {
  constructor(message: string, retryAfterSeconds: number, format?: 'gemini' | 'anthropic', code: Exclude<PausedCode, 'key_paused'> = 'upstream_paused') {
    super(503, { message, res: Response.json(pausedBody(code, message, format), { status: 503, headers: { 'retry-after': String(retryAfterSeconds) } }) })
  }
}
```

In each of the four attempts change the `upstream-paused` mapping (chat-completions/attempt.ts:119, messages/attempt.ts:326, responses/attempt.ts:324, gemini/attempt.ts:168) to carry the code:

```ts
    if (sel.kind === 'upstream-paused') return llmInternalErrorResult(503, new Error(sel.message), undefined, 'upstream-paused', { code: sel.code ?? 'upstream_paused', retryAfterSeconds: sel.retryAfterSeconds })
```

- [ ] **Step 5: Balancing in `resolveBinding`**

In `binding-resolver.ts` replace the loop and the error part (from `const skipped: string[] = []` to the final `throw`) with:

```ts
  const skipped: string[] = []
  const exhaustedGroups: SkippedGroup[] = []
  // This resolver intentionally prefers all direct matches before any base fallback; chat candidate enumeration preserves upstream order instead.
  for (const id of ids) {
    const usable: RoutingBindingDescriptor[] = []
    for (const descriptor of bindings.find([id])) {
      if ((upstreamPin && descriptor.upstream !== upstreamPin) || descriptor.model.endpoints[endpoint] === undefined) continue
      if (paused.has(descriptor.upstream)) { skipped.push(descriptor.upstream); continue }
      usable.push(descriptor)
    }
    // Groups: balanced per request without a session (embeddings, images, decisions, count tokens); a pinned request is not balanced.
    const balance = upstreamPin ? undefined : await getQuotaBalance().balance({ items: usable, upstreamOf: descriptor => descriptor.upstream })
    exhaustedGroups.push(...(balance?.skipped ?? []))
    for (const descriptor of balance?.ordered ?? usable) {
      const binding = await bindings.materialize(descriptor)
      if (binding) return binding
    }
  }
  await bindings.reconcile()

  if (exhaustedGroups.length > 0) {
    const ends = skipped.flatMap(upstreamId => { const row = paused.get(upstreamId); return row ? [row.endsAt] : [] })
    const route = describeGroupExhausted(exhaustedGroups, ends, opts.ownerId, getProtection().now())
    throw new UpstreamPausedError(route.message, route.retryAfterSeconds, opts.errorFormat ?? (opts.anthropicErrors ? 'anthropic' : undefined), 'group_quota_exhausted')
  }
  // A candidate dropped only because it is paused is a known answer: prefer it over an unrelated failed catalog (as chat does).
  const route = await describePausedRoute(skipped, paused, opts.ownerId)
  if (route) throw new UpstreamPausedError(route.message, route.retryAfterSeconds, opts.errorFormat ?? (opts.anthropicErrors ? 'anthropic' : undefined))
  if (incomplete) throw new ModelCatalogUnavailableError(opts.errorFormat)
  return null
```
with the imports `import { getQuotaBalance } from '../../quota-balance/runtime.ts'`, `import type { SkippedGroup } from '../../quota-balance/balance.ts'`, `import type { RoutingBindingDescriptor } from '../providers/routing-projection.ts'` and `describeGroupExhausted` added to the `./paused-route.ts` import.

- [ ] **Step 6: Run the tests, the routing and protection regressions and the typecheck**

Run: `bun test packages/gateway/tests/quota-balance-session.test.ts packages/gateway/tests/quota-routing.sqlite.test.ts packages/gateway/tests/protection-resolve-binding.sqlite.test.ts packages/gateway/tests/protection-enforcement.sqlite.test.ts packages/gateway/tests/protection-paused-render.test.ts packages/gateway/tests/chat.e2e.test.ts packages/gateway/tests/messages.e2e.test.ts packages/gateway/tests/responses.e2e.test.ts packages/gateway/tests/gemini.e2e.test.ts`
Expected: PASS.

Run: `bun run --filter '@vibe-llm/gateway' typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/data-plane packages/gateway/tests/quota-balance-session.test.ts packages/gateway/tests/quota-routing.sqlite.test.ts
git commit -m "feat(quota-balance): balance new sessions in chat flows and resolveBinding, group_quota_exhausted" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 15: Control-plane API

**Files:**
- Create: `packages/gateway/src/control-plane/quota-balance/dto.ts`
- Create: `packages/gateway/src/control-plane/quota-balance/routes.ts`
- Modify: `packages/gateway/src/control-plane/routes.ts` (imports ~L33, mounts ~L47)
- Modify: `packages/gateway/src/control-plane/auth/session-auth.ts` (~L92)
- Modify: `packages/gateway/src/control-plane/upstreams/routes.ts` (list handler ~L311-L325), `public-dto.ts` (`groupId`)
- Create: `packages/gateway/tests/quota-api.test.ts`

Endpoints (all behind `requireBrowserSession`; owners see and change their own groups, admins all; strangers get `404`):

| Method and path | Body | Answer |
| --- | --- | --- |
| `GET /api/upstream-groups` | | `{ groups: GroupDto[] }` |
| `POST /api/upstream-groups` | `{ name, ownerId?, enabled?, sortOrder?, settings? }` (`ownerId` admin only) | `201 { group }` |
| `PATCH /api/upstream-groups/:id` | `{ name?, enabled?, sortOrder?, settings? }` | `{ group }` |
| `DELETE /api/upstream-groups/:id` | | `{ ok: true }` |
| `GET /api/upstream-groups/alerts` | | `{ alerts: [{ kind: "stopped" \| "overage", groupId, groupName }] }` |
| `GET /api/upstream-groups/:id/status` | | `GroupStatusDto` (estimates from the gateway's own data, no GitHub read) |
| `PUT /api/upstreams/:id/group` | `{ groupId: string \| null }` | `{ ok: true, groupId }` |
| `POST /api/upstreams/:id/quota/refresh` | | `{ status: "read" \| "reused" \| "error" \| "unsupported", lastReadAt?, blockedUntil?, error? }` |
| `POST /api/upstreams/:id/quota/calibrate` | `{ used?, entitlement?, usedShare?, at? }` | `{ status: "read" }`, `400 invalid_calibration`, `429 too_soon` |

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-api.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Hono } from "hono"
import type { Fetcher } from "@vibe-core/upstream"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { initRepo } from "../src/repo/index"
import { sessionAuthMiddleware } from "../src/control-plane/auth/session-auth"
import { upstreamGroupsRouter, upstreamQuotaRouter } from "../src/control-plane/quota-balance/routes"
import { upstreamsRouter } from "../src/control-plane/upstreams/routes"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime"
import { QuotaBalance, setQuotaBalanceForTests, setQuotaFetcherFactory } from "../src/quota-balance/runtime"
import { DEFAULT_GROUP_SETTINGS } from "../src/repo/quota-balance"
import type { SessionToken, UserId } from "../src/repo/branded-ids"

const owner = "qb-owner" as UserId
const other = "qb-other" as UserId
const tokens = { [owner]: "ses_qb_owner", [other]: "ses_qb_other" } as Record<string, string>
const stamp = "2026-11-22T00:00:00.000Z"
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0)
const H = 3_600_000
let db: Database
let repo: BunSqliteRepo
let app: Hono
let clock: { now: number }
let remaining: number
let fetchCalls: number
const originalFetch = globalThis.fetch

beforeEach(async () => {
  __resetPlatformForTests()
  // The session middleware prefetches a Copilot token for the caller's upstreams; keep that off the network.
  globalThis.fetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch
  initEnv(() => "")
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  initRuntimeLocation("bun")
  clock = { now: NOW }
  remaining = 700
  fetchCalls = 0
  seedCount = 0
  const deps = { repo: () => repo, now: () => clock.now, schedule: (w: Promise<unknown>) => { void w.catch(() => {}) }, random: () => 0.5 }
  const protection = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: () => {}, cacheTtlMs: 0 })
  setProtectionForTests(protection)
  setQuotaBalanceForTests(new QuotaBalance(deps, { protection: () => protection }))
  setQuotaFetcherFactory(async () => (async () => { fetchCalls++; return Response.json({ quota_snapshots: { premium_interactions: { entitlement: 1000, remaining, unlimited: false } } }) }) as Fetcher)
  for (const id of [owner, other]) await repo.users.create({ id, name: id, createdAt: stamp, disabled: false })
  for (const [userId, token] of Object.entries(tokens)) await repo.sessions.create({ token: token as SessionToken, userId: userId as UserId, createdAt: stamp, expiresAt: "2099-01-01T00:00:00.000Z" })
  const save = (id: string, ownerId: UserId, provider: string, config: Record<string, unknown>) => repo.upstreams.save({
    id, ownerId, provider: provider as never, name: id, enabled: true, sortOrder: 0, config, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], state: null, createdAt: stamp, updatedAt: stamp })
  await save("up_test_a", owner, "copilot", { githubToken: "fake_github_token_a", accountType: "individual", user: { id: 1, login: "a" } })
  await save("up_test_b", owner, "copilot", { githubToken: "fake_github_token_b", accountType: "individual", user: { id: 2, login: "b" } })
  await save("up_test_custom", owner, "custom", { name: "c", baseUrl: "https://c.invalid", authStyle: "none", endpoints: ["chat_completions"], models: ["m"] })
  await save("up_test_foreign", other, "copilot", { githubToken: "fake_github_token_f", accountType: "individual", user: { id: 3, login: "f" } })
  app = new Hono()
  app.use("*", sessionAuthMiddleware)
  app.route("/api/upstream-groups", upstreamGroupsRouter)
  app.route("/api/upstreams", upstreamsRouter)
  app.route("/api/upstreams", upstreamQuotaRouter)
})
afterEach(() => { globalThis.fetch = originalFetch; setQuotaBalanceForTests(null); setProtectionForTests(null); setQuotaFetcherFactory(async () => fetch); db.close(); __resetPlatformForTests() })

const call = (path: string, method = "GET", user: UserId = owner, body?: unknown) =>
  app.request(`https://gw.example${path}`, { method, headers: { authorization: `Bearer ${tokens[user]}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const json = async (response: Response) => (await response.json()) as any
const create = async (over: Record<string, unknown> = {}) => (await json(await call("/api/upstream-groups", "POST", owner, { name: "Pool", ...over }))).group as { id: string }

test("a group is created with defaults and the next sort order, listed for its owner only, renamed, reordered and deleted", async () => {
  const response = await call("/api/upstream-groups", "POST", owner, { name: "  Pool  " })
  expect(response.status).toBe(201)
  const { group } = await json(response)
  expect(group).toMatchObject({ name: "Pool", enabled: true, ownerId: owner, settings: DEFAULT_GROUP_SETTINGS, memberIds: [], sortOrder: 1 }) // the owner's upstreams use 0
  expect(group.id).toMatch(/^ug_[0-9a-f]{32}$/)
  expect((await json(await call("/api/upstream-groups"))).groups).toHaveLength(1)
  expect((await json(await call("/api/upstream-groups", "GET", other))).groups).toEqual([])
  const patched = await json(await call(`/api/upstream-groups/${group.id}`, "PATCH", owner, { name: "Renamed", enabled: false, sortOrder: 7, settings: { exhaustedPolicy: "overage", softShare: 0.8 } }))
  expect(patched.group).toMatchObject({ name: "Renamed", enabled: false, sortOrder: 7, settings: { ...DEFAULT_GROUP_SETTINGS, exhaustedPolicy: "overage", softShare: 0.8 } })
  expect((await call(`/api/upstream-groups/${group.id}`, "PATCH", other, { name: "x" })).status).toBe(404)
  expect((await call(`/api/upstream-groups/${group.id}`, "DELETE", other)).status).toBe(404)
  expect((await call(`/api/upstream-groups/${group.id}`, "DELETE")).status).toBe(200)
  expect((await json(await call("/api/upstream-groups"))).groups).toEqual([])
})

test("invalid names and settings are a 400 with a code, and no session is a 401", async () => {
  expect((await call("/api/upstream-groups", "POST", owner, { name: " " })).status).toBe(400)
  const { id } = await create()
  const bad = await call(`/api/upstream-groups/${id}`, "PATCH", owner, { settings: { softShare: 0.97 } })
  expect([bad.status, await bad.json()]).toEqual([400, { error: { code: "invalid_settings", message: "settings.softShare must not exceed hardShare" } }])
  expect((await call(`/api/upstream-groups/${id}`, "PATCH", owner, { settings: { bogus: 1 } })).status).toBe(400)
  expect((await app.request("https://gw.example/api/upstream-groups")).status).toBe(401)
})

test("only the owner's Copilot upstreams join the owner's group; leaving clears it; the upstream list carries groupId", async () => {
  const { id } = await create()
  const put = (upstream: string, groupId: string | null, user: UserId = owner) => call(`/api/upstreams/${upstream}/group`, "PUT", user, { groupId })
  expect((await put("up_test_a", id)).status).toBe(200)
  expect((await put("up_test_custom", id)).status).toBe(400) // only Copilot upstreams
  expect((await put("up_test_foreign", id)).status).toBe(404) // not the caller's upstream
  expect((await put("up_test_b", id, other)).status).toBe(404) // not the caller's upstream
  expect((await put("up_test_a", `ug_${"9".repeat(32)}`)).status).toBe(404) // unknown group
  expect((await json(await call("/api/upstream-groups"))).groups[0].memberIds).toEqual(["up_test_a"])
  const list = (await json(await call("/api/upstreams"))).upstreams as Array<{ id: string; groupId?: string | null }>
  expect(list.find(u => u.id === "up_test_a")?.groupId).toBe(id)
  expect(list.find(u => u.id === "up_test_b")?.groupId).toBeNull()
  expect((await repo.quotaBalance.getStates(["up_test_a"])).get("up_test_a")).toMatchObject({ nextReadAt: NOW, intervalHours: 6 })
  expect((await put("up_test_a", null)).status).toBe(200)
  expect((await json(await call("/api/upstream-groups"))).groups[0].memberIds).toEqual([])
  expect((await repo.quotaBalance.getStates(["up_test_a"])).size).toBe(0)
})

test("deleting a group releases its members", async () => {
  const { id } = await create()
  await call("/api/upstreams/up_test_a/group", "PUT", owner, { groupId: id })
  await call(`/api/upstream-groups/${id}`, "DELETE")
  expect((await repo.quotaBalance.listMemberships())).toEqual([])
})

let seedCount = 0
async function seed(id: string, share: number, over: { entitlement?: number } = {}) {
  const entitlement = over.entitlement ?? 1000
  const at = NOW - H + ++seedCount * 1000 // every read of a member needs its own instant
  await repo.quotaBalance.recordRead({ upstreamId: id, at, source: "github", used: share * entitlement, entitlement, unlimited: false, estimatedShareBefore: null, errorPoints: null, snapshotKey: null, unitForm: null, resetAt: null, costAdjustUsd: 0, entitlementChange: null }, at)
  await repo.quotaBalance.saveEstimator(id, { k: 0.02, kPrev: 0.03, kSamples: 5, o: 0.001, intervalHours: 3, learnSince: 0, nextReadAt: NOW + 3 * H, lastErrorPoints: -2 }, NOW)
}

test("the status shows per member the estimated share, the last read, the learned parameters, eligibility with its reason, sessions and the group state", async () => {
  const { id } = await create()
  for (const upstream of ["up_test_a", "up_test_b"]) await call(`/api/upstreams/${upstream}/group`, "PUT", owner, { groupId: id })
  await seed("up_test_a", 0.5)
  await repo.quotaBalance.recordCost({ upstreamId: "up_test_a", nowMs: NOW - 30 * 60_000, costUsd: 5, monthKey: "2026-11" })
  await repo.quotaBalance.putAssignment({ groupId: id, sessionKey: "s1", upstreamId: "up_test_a", createdAt: NOW, lastSeenAt: NOW, movedAt: NOW, recentCostUsd: 0, recentCostAt: NOW })
  const status = await json(await call(`/api/upstream-groups/${id}/status`))
  expect(status.state).toBe("normal")
  const a = status.members.find((m: any) => m.upstreamId === "up_test_a")
  expect(a).toMatchObject({ name: "up_test_a", login: "a", entitlement: 1000, unlimited: false, k: 0.02, kPrevious: 0.03, kSamples: 5, outsideRate: 0.001, lastErrorPoints: -2, intervalHours: 3, activeSessions: 1, eligibility: { eligible: true, reason: null } })
  expect(a.lastRead).toEqual({ at: NOW - H + 1000, source: "github", used: 500, entitlement: 1000, share: 0.5 })
  expect(a.usedShare).toBeCloseTo(0.5 + 0.02 * 5 + 0.001 * 1, 6) // read + k x gateway cost + o x hours since the read
  expect(a.estimatedUsed).toBeCloseTo(a.usedShare * 1000, 6)
  expect(a.projectedShare).toBeGreaterThan(a.usedShare)
  expect(a.outsideShareLastDay).toBeCloseTo((0.001 * 24) / (0.001 * 24 + 0.02 * 5), 6)
  const b = status.members.find((m: any) => m.upstreamId === "up_test_b")
  expect(b).toMatchObject({ lastRead: null, usedShare: null, eligibility: { eligible: false, reason: "no_read" } })
})

test("soft line, cut-off, other pauses and a disabled upstream are reported as the reason a member takes no new sessions, and the group state follows", async () => {
  const { id } = await create()
  for (const upstream of ["up_test_a", "up_test_b"]) await call(`/api/upstreams/${upstream}/group`, "PUT", owner, { groupId: id })
  await seed("up_test_a", 0.93)
  await seed("up_test_b", 0.5)
  let status = await json(await call(`/api/upstream-groups/${id}/status`))
  expect(status.members.find((m: any) => m.upstreamId === "up_test_a").eligibility).toEqual({ eligible: false, reason: "soft_line" })
  expect(status.state).toBe("normal")
  await seed("up_test_b", 0.92)
  status = await json(await call(`/api/upstream-groups/${id}/status`))
  expect(status.state).toBe("stopped")
  expect((await json(await call("/api/upstream-groups/alerts"))).alerts).toEqual([{ kind: "stopped", groupId: id, groupName: "Pool" }])
  await call(`/api/upstream-groups/${id}`, "PATCH", owner, { settings: { exhaustedPolicy: "overage" } })
  expect((await json(await call("/api/upstream-groups/alerts"))).alerts).toEqual([{ kind: "overage", groupId: id, groupName: "Pool" }])

  const protection = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: () => {}, cacheTtlMs: 0 })
  setProtectionForTests(protection)
  await protection.insertExternal({ id: `pp_${"1".repeat(32)}`, targetKind: "upstream", targetId: "up_test_a", upstreamId: "up_test_a", mode: "pause", startedAt: NOW, endsAt: Date.UTC(2026, 11, 1),
    reason: { windowMinutes: 0, requests: 0, risky: 0, counts: { rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 }, failureRatio: 0, topKeys: [], trigger: "quota", keyShare: null, quota: { groupId: id, groupName: "Pool", share: 0.96, hardShare: 0.95, source: "real", provisional: false } } })
  status = await json(await call(`/api/upstream-groups/${id}/status`))
  const a = status.members.find((m: any) => m.upstreamId === "up_test_a")
  expect(a.eligibility).toEqual({ eligible: false, reason: "cut_off" })
  expect(a.cutOff).toEqual({ until: Date.UTC(2026, 11, 1), provisional: false, share: 0.96 })
})

test("an entitlement change and a failing or inaccurate estimate are listed as attention items", async () => {
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  await seed("up_test_a", 0.4)
  db.run("UPDATE upstream_quota_state SET entitlement = 2000, entitlement_from = 1000, entitlement_changed_at = ?, failures = 3, last_error = 'HTTP 502', last_error_points = 14 WHERE upstream_id = 'up_test_a'", [NOW - 2 * H])
  const status = await json(await call(`/api/upstream-groups/${id}/status`))
  const a = status.members[0]
  expect(a.entitlementChange).toEqual({ from: 1000, to: 2000, at: NOW - 2 * H })
  expect(status.attention.map((x: any) => x.kind).sort()).toEqual(["entitlement_changed", "large_error", "read_failing"])
})

test("refresh reads once with the member's credential, then answers from the stored read while the floor holds; calibration validates and respects the floor", async () => {
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  const first = await json(await call("/api/upstreams/up_test_a/quota/refresh", "POST"))
  expect(first).toMatchObject({ status: "read", lastReadAt: NOW })
  expect(fetchCalls).toBe(1)
  clock.now += 5 * 60_000
  const again = await json(await call("/api/upstreams/up_test_a/quota/refresh", "POST"))
  expect(again).toMatchObject({ status: "reused", lastReadAt: NOW, blockedUntil: NOW + 10 * 60_000 })
  expect(fetchCalls).toBe(1)
  remaining = 0
  clock.now += 10 * 60_000
  expect(await json(await call("/api/upstreams/up_test_a/quota/refresh", "POST"))).toMatchObject({ status: "read" })
  expect(fetchCalls).toBe(2)

  const bad = await call("/api/upstreams/up_test_a/quota/calibrate", "POST", owner, { used: -5, entitlement: 100 })
  expect([bad.status, (await json(bad)).error.code]).toEqual([400, "invalid_calibration"])
  clock.now += 11 * 60_000
  const ok = await call("/api/upstreams/up_test_a/quota/calibrate", "POST", owner, { usedShare: 0.25 })
  expect([ok.status, await json(ok)]).toEqual([200, { status: "read" }])
  const tooSoon = await call("/api/upstreams/up_test_a/quota/calibrate", "POST", owner, { usedShare: 0.3 })
  expect(tooSoon.status).toBe(429)
  expect((await call("/api/upstreams/up_test_b/quota/refresh", "POST")).status).toBe(400) // not a member
  expect((await call("/api/upstreams/up_test_foreign/quota/refresh", "POST")).status).toBe(404)
  expect((await call("/api/upstreams/up_test_custom/quota/refresh", "POST")).status).toBe(400)
})

test("a failing read is a 502 with a code and no upstream text", async () => {
  setQuotaFetcherFactory(async () => (async () => new Response("secret upstream text", { status: 500 })) as Fetcher)
  const { id } = await create()
  await call(`/api/upstreams/up_test_a/group`, "PUT", owner, { groupId: id })
  const response = await call("/api/upstreams/up_test_a/quota/refresh", "POST")
  expect(response.status).toBe(502)
  expect(JSON.stringify(await json(response))).not.toContain("secret")
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test packages/gateway/tests/quota-api.test.ts`
Expected: FAIL, `../src/control-plane/quota-balance/routes` not found.

- [ ] **Step 3: Implement the DTO builders**

```ts
// packages/gateway/src/control-plane/quota-balance/dto.ts
import { getRepo } from "../../repo/index.ts"
import type { UpstreamId } from "../../repo/branded-ids.ts"
import type { GroupSettings, QuotaReadSource, UpstreamGroup } from "../../repo/quota-balance.ts"
import { getProtection } from "../../protection/runtime.ts"
import { effectiveK } from "../../quota-balance/estimator.ts"
import { kFallbackOf, memberEstimate, viewMembers } from "../../quota-balance/facts.ts"
import { getQuotaBalance } from "../../quota-balance/runtime.ts"
import { groupState, type GroupState } from "../../quota-balance/selection.ts"
import { HOUR_MS } from "../../quota-balance/time.ts"

export interface GroupDto {
  id: string
  ownerId: string
  name: string
  enabled: boolean
  sortOrder: number
  settings: GroupSettings
  memberIds: string[]
  createdAt: string
  updatedAt: string
}
export const toGroupDto = (group: UpstreamGroup, memberIds: string[]): GroupDto => ({ ...group, memberIds })

export type IneligibleReason = "disabled" | "cut_off" | "paused" | "no_read" | "soft_line"
export interface MemberStatusDto {
  upstreamId: string
  name: string
  login: string | null
  enabled: boolean
  unlimited: boolean
  /** Estimated used share now (read + k x gateway cost + o x time); null before the first read. */
  usedShare: number | null
  entitlement: number | null
  /** usedShare x the latest entitlement. */
  estimatedUsed: number | null
  projectedShare: number | null
  lastRead: { at: number; source: QuotaReadSource; used: number; entitlement: number; share: number } | null
  k: number | null
  kPrevious: number | null
  kSamples: number
  /** Share per hour. */
  outsideRate: number
  /** Share of the last day's consumption that did not go through the gateway; null without data. */
  outsideShareLastDay: number | null
  lastErrorPoints: number | null
  intervalHours: number
  nextReadAt: number
  failures: number
  lastError: string | null
  entitlementChange: { from: number; to: number; at: number } | null
  cutOff: { until: number; provisional: boolean; share: number } | null
  eligibility: { eligible: boolean; reason: IneligibleReason | null }
  activeSessions: number
}
export interface AttentionDto { upstreamId: string; kind: "large_error" | "read_failing" | "entitlement_changed" }
export interface GroupStatusDto { group: GroupDto; state: GroupState; members: MemberStatusDto[]; attention: AttentionDto[]; nowMs: number }

const DAY_MS = 24 * HOUR_MS

export async function buildGroupStatus(group: UpstreamGroup, nowMs: number): Promise<GroupStatusDto> {
  const repo = getRepo()
  const qb = getQuotaBalance()
  const ids = (await repo.quotaBalance.listMemberships()).filter(m => m.groupId === group.id).map(m => m.upstreamId)
  const facts = await qb.facts.get(ids, { fresh: true })
  const views = viewMembers(ids, facts, group.settings, nowMs, qb.facts.unavailable)
  const kFallback = kFallbackOf(ids.map(id => facts.get(id)?.state ?? null))
  const paused = await getProtection().pausedUpstreams()
  const sessions = await repo.quotaBalance.countActiveSessions(group.id, nowMs - group.settings.sessionIdleHours * HOUR_MS)
  const attention: AttentionDto[] = []
  const eligibleViews = []
  const members: MemberStatusDto[] = []
  for (const [index, id] of ids.entries()) {
    const f = facts.get(id)
    const state = f?.state ?? null
    const view = views[index]!
    const upstream = await repo.upstreams.getById(id as UpstreamId)
    const estimate = memberEstimate(f, nowMs, kFallback)
    const pause = paused.get(id)
    const quotaPause = pause?.reason.trigger === "quota" ? pause : undefined
    const entitlement = state?.entitlement ?? null
    const k = state?.k ?? null
    const cost24h = await repo.quotaBalance.costBetween(id, nowMs - DAY_MS, nowMs)
    const outside = (state?.o ?? 0) * 24
    const denominator = outside + effectiveK({ k, kSamples: state?.kSamples ?? 0 }, kFallback) * cost24h
    let reason: IneligibleReason | null = null
    if (!upstream?.enabled) reason = "disabled"
    else if (quotaPause) reason = "cut_off"
    else if (pause) reason = "paused"
    else if (!view.known) reason = "no_read"
    else if (group.settings.exhaustedPolicy === "stop" && view.usedShare >= group.settings.softShare) reason = "soft_line"
    if (reason === null || reason === "soft_line" || reason === "no_read") eligibleViews.push(view)
    const change = state && state.entitlementChangedAt !== null && state.entitlementFrom !== null && state.entitlement !== null
      ? { from: state.entitlementFrom, to: state.entitlement, at: state.entitlementChangedAt } : null
    if (state && state.lastErrorPoints !== null && Math.abs(state.lastErrorPoints) > 10) attention.push({ upstreamId: id, kind: "large_error" })
    if (state && state.failures >= 2) attention.push({ upstreamId: id, kind: "read_failing" })
    if (change && nowMs - change.at < 7 * DAY_MS) attention.push({ upstreamId: id, kind: "entitlement_changed" })
    const config = upstream?.config as { user?: { login?: unknown } } | undefined
    members.push({
      upstreamId: id, name: upstream?.name ?? id, login: typeof config?.user?.login === "string" ? config.user.login : null, enabled: upstream?.enabled ?? false,
      unlimited: estimate.unlimited,
      usedShare: view.known ? view.usedShare : null, entitlement,
      estimatedUsed: view.known && entitlement !== null ? view.usedShare * entitlement : null,
      projectedShare: view.known ? view.projectedShare : null,
      lastRead: state && state.lastReadAt !== null && state.lastReadShare !== null && entitlement !== null && state.lastReadSource
        ? { at: state.lastReadAt, source: state.lastReadSource, used: state.lastReadShare * entitlement, entitlement, share: state.lastReadShare } : null,
      k, kPrevious: state?.kPrev ?? null, kSamples: state?.kSamples ?? 0, outsideRate: state?.o ?? 0,
      outsideShareLastDay: denominator > 0 ? outside / denominator : null,
      lastErrorPoints: state?.lastErrorPoints ?? null, intervalHours: state?.intervalHours ?? group.settings.readIntervalHours, nextReadAt: state?.nextReadAt ?? 0,
      failures: state?.failures ?? 0, lastError: state?.lastError ?? null, entitlementChange: change,
      cutOff: quotaPause?.reason.quota ? { until: quotaPause.endsAt, provisional: quotaPause.reason.quota.provisional, share: quotaPause.reason.quota.share } : null,
      eligibility: { eligible: reason === null, reason },
      activeSessions: sessions.get(id) ?? 0,
    })
  }
  return { group: toGroupDto(group, ids), state: groupState(eligibleViews, group.settings), members, attention, nowMs }
}

export interface AlertDto { kind: "stopped" | "overage"; groupId: string; groupName: string }

/** Groups that cannot take new sessions (`stopped`) or serve them above the soft line (`overage`). Disabled groups are not reported. */
export async function buildAlerts(groups: readonly UpstreamGroup[], nowMs: number): Promise<AlertDto[]> {
  const alerts: AlertDto[] = []
  for (const group of groups) {
    if (!group.enabled) continue
    const { state } = await buildGroupStatus(group, nowMs)
    if (state !== "normal") alerts.push({ kind: state, groupId: group.id, groupName: group.name })
  }
  return alerts
}
```

- [ ] **Step 4: Implement the routes**

```ts
// packages/gateway/src/control-plane/quota-balance/routes.ts
import { Hono } from "hono"
import { z } from "zod"
import type { Env } from "../../app.ts"
import { getRepo } from "../../repo/index.ts"
import type { UpstreamId } from "../../repo/branded-ids.ts"
import { DEFAULT_GROUP_SETTINGS, type UpstreamGroup } from "../../repo/quota-balance.ts"
import type { FullAuthCtx } from "../../shared/credential-auth.ts"
import { isCopilotUpstream } from "../../quota-balance/credential.ts"
import { CalibrationError } from "../../quota-balance/reader.ts"
import { getQuotaBalance } from "../../quota-balance/runtime.ts"
import { GroupSettingsError, normalizeGroupSettings } from "../../quota-balance/settings.ts"
import { requireBrowserSession } from "../shared/session-guard.ts"
import { loadOwned } from "../shared/ownership.ts"
import { buildAlerts, buildGroupStatus, toGroupDto } from "./dto.ts"
import "./fetcher.ts"

type Vars = { auth: FullAuthCtx }
const NO_STORE = { "cache-control": "no-store" }
const fail = (status: 400 | 404 | 429 | 502, code: string, message?: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ error: { code, ...(message ? { message } : {}) }, ...extra }), { status, headers: { "content-type": "application/json", ...NO_STORE } })
const notFound = () => fail(404, "not_found")
const GROUP_ID = /^ug_[0-9a-f]{32}$/
const now = () => getQuotaBalance().deps.now()

const createBody = z.object({ name: z.string(), ownerId: z.string().optional(), enabled: z.boolean().optional(), sortOrder: z.number().finite().optional(), settings: z.unknown().optional() })
const patchBody = z.object({ name: z.string().optional(), enabled: z.boolean().optional(), sortOrder: z.number().finite().optional(), settings: z.unknown().optional() })
const calibrateBody = z.object({ used: z.number().optional(), entitlement: z.number().optional(), usedShare: z.number().optional(), at: z.number().optional() })

const ownedGroup = (auth: FullAuthCtx | undefined, id: string) => GROUP_ID.test(id) ? loadOwned(auth, () => getRepo().quotaBalance.getGroup(id)) : Promise.resolve(null)
const ownedUpstream = (auth: FullAuthCtx | undefined, id: string) => loadOwned(auth, () => getRepo().upstreams.getById(id as UpstreamId))
const membersOf = async (groupId: string) => (await getRepo().quotaBalance.listMemberships()).filter(m => m.groupId === groupId).map(m => m.upstreamId)
const changed = () => { const qb = getQuotaBalance(); qb.directory.invalidate(); qb.facts.invalidate() }
const cleanName = (value: string) => value.trim().slice(0, 80)

/** `/api/upstream-groups`: session-guarded, owner-only (admins see all). */
export const upstreamGroupsRouter = new Hono<{ Bindings: Env; Variables: Vars }>()
upstreamGroupsRouter.use("*", requireBrowserSession)

const visibleGroups = (auth: FullAuthCtx) => getRepo().quotaBalance.listGroups(auth.isAdmin ? {} : { ownerId: auth.userId })

upstreamGroupsRouter.get("/", async (c) => {
  const groups = await visibleGroups(c.get("auth"))
  const memberships = await getRepo().quotaBalance.listMemberships()
  return c.json({ groups: groups.map(group => toGroupDto(group, memberships.filter(m => m.groupId === group.id).map(m => m.upstreamId))) }, 200, NO_STORE)
})

upstreamGroupsRouter.get("/alerts", async (c) => {
  return c.json({ alerts: await buildAlerts(await visibleGroups(c.get("auth")), now()) }, 200, NO_STORE)
})

upstreamGroupsRouter.post("/", async (c) => {
  const auth = c.get("auth")
  const parsed = createBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(400, "invalid_body")
  const name = cleanName(parsed.data.name)
  if (name === "") return fail(400, "invalid_name", "name required")
  const ownerId = auth.isAdmin && parsed.data.ownerId !== undefined ? parsed.data.ownerId : auth.userId ?? ""
  let settings = DEFAULT_GROUP_SETTINGS
  try { if (parsed.data.settings !== undefined) settings = normalizeGroupSettings(parsed.data.settings) } catch (error) {
    if (error instanceof GroupSettingsError) return fail(400, "invalid_settings", error.message)
    throw error
  }
  const repo = getRepo()
  // The same number space as the owner's upstreams: the new group goes after everything the owner has.
  const siblings = [...(await repo.quotaBalance.listGroups({ ownerId })).map(g => g.sortOrder), ...(await repo.upstreams.list({ ownerId: ownerId as never, includeDisabled: true })).map(u => u.sortOrder)]
  const stamp = new Date(now()).toISOString()
  const group: UpstreamGroup = {
    id: `ug_${crypto.randomUUID().replace(/-/g, "")}`, ownerId, name, enabled: parsed.data.enabled !== false,
    sortOrder: parsed.data.sortOrder ?? Math.max(-1, ...siblings) + 1, settings, createdAt: stamp, updatedAt: stamp,
  }
  await repo.quotaBalance.createGroup(group)
  changed()
  return c.json({ group: toGroupDto(group, []) }, 201, NO_STORE)
})

upstreamGroupsRouter.patch("/:id", async (c) => {
  const group = await ownedGroup(c.get("auth"), c.req.param("id"))
  if (!group) return notFound()
  const parsed = patchBody.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return fail(400, "invalid_body")
  const patch: Parameters<ReturnType<typeof getRepo>["quotaBalance"]["updateGroup"]>[1] = {}
  if (parsed.data.name !== undefined) {
    const name = cleanName(parsed.data.name)
    if (name === "") return fail(400, "invalid_name", "name required")
    patch.name = name
  }
  if (parsed.data.enabled !== undefined) patch.enabled = parsed.data.enabled
  if (parsed.data.sortOrder !== undefined) patch.sortOrder = parsed.data.sortOrder
  if (parsed.data.settings !== undefined) {
    try { patch.settings = normalizeGroupSettings(parsed.data.settings, group.settings) } catch (error) {
      if (error instanceof GroupSettingsError) return fail(400, "invalid_settings", error.message)
      throw error
    }
  }
  const updated = await getRepo().quotaBalance.updateGroup(group.id, patch, new Date(now()).toISOString())
  if (!updated) return notFound()
  changed()
  return c.json({ group: toGroupDto(updated, await membersOf(group.id)) }, 200, NO_STORE)
})

upstreamGroupsRouter.delete("/:id", async (c) => {
  const group = await ownedGroup(c.get("auth"), c.req.param("id"))
  if (!group || !(await getRepo().quotaBalance.deleteGroup(group.id))) return notFound()
  changed()
  return c.json({ ok: true }, 200, NO_STORE)
})

upstreamGroupsRouter.get("/:id/status", async (c) => {
  const group = await ownedGroup(c.get("auth"), c.req.param("id"))
  if (!group) return notFound()
  return c.json(await buildGroupStatus(group, now()), 200, NO_STORE)
})

/** `/api/upstreams/:id/{group,quota/*}`: mounted next to `upstreamsRouter`. */
export const upstreamQuotaRouter = new Hono<{ Bindings: Env; Variables: Vars }>()

upstreamQuotaRouter.put("/:id/group", requireBrowserSession, async (c) => {
  const auth = c.get("auth")
  const upstream = await ownedUpstream(auth, c.req.param("id"))
  if (!upstream) return notFound()
  const body = z.object({ groupId: z.string().nullable() }).safeParse(await c.req.json().catch(() => null))
  if (!body.success) return fail(400, "invalid_body")
  const repo = getRepo()
  if (body.data.groupId === null) {
    await repo.quotaBalance.setMembership(upstream.id, null, { nowMs: now(), intervalHours: DEFAULT_GROUP_SETTINGS.readIntervalHours })
    changed()
    return c.json({ ok: true, groupId: null }, 200, NO_STORE)
  }
  if (!isCopilotUpstream(upstream)) return fail(400, "unsupported_provider", "only Copilot upstreams can join a group")
  const group = await ownedGroup(auth, body.data.groupId)
  if (!group) return notFound()
  // The group's owner's upstreams only; an admin may also add global upstreams.
  const upstreamOwner = upstream.ownerId ?? ""
  if (upstreamOwner !== group.ownerId && !(auth.isAdmin && upstreamOwner === "")) return fail(400, "owner_mismatch", "the upstream and the group must have the same owner")
  await repo.quotaBalance.setMembership(upstream.id, group.id, { nowMs: now(), intervalHours: group.settings.readIntervalHours })
  changed()
  return c.json({ ok: true, groupId: group.id }, 200, NO_STORE)
})

/** The member's group, or null when the upstream is not (or no longer) in one. */
const memberGroup = async (upstreamId: string) => {
  const directory = await getQuotaBalance().directory.get({ fresh: true })
  const groupId = directory.memberOf.get(upstreamId)
  return groupId ? directory.groups.get(groupId) ?? null : null
}

upstreamQuotaRouter.post("/:id/quota/refresh", requireBrowserSession, async (c) => {
  const upstream = await ownedUpstream(c.get("auth"), c.req.param("id"))
  if (!upstream) return notFound()
  if (!isCopilotUpstream(upstream)) return fail(400, "unsupported_provider", "only Copilot upstreams have a readable quota")
  if (!(await memberGroup(upstream.id))) return fail(400, "not_a_member", "the upstream is not in a group")
  const qb = getQuotaBalance()
  const outcome = await qb.reader.readNow(upstream.id, { reason: "manual", manual: true })
  if (outcome.status === "read") return c.json({ status: "read", lastReadAt: outcome.read.at }, 200, NO_STORE)
  if (outcome.status === "floor") {
    // Within the floor the stored read is reused (opening the page must not turn into frequent reads).
    const state = (await getRepo().quotaBalance.getStates([upstream.id])).get(upstream.id)
    return c.json({ status: "reused", lastReadAt: state?.lastReadAt ?? null, blockedUntil: outcome.blockedUntil }, 200, NO_STORE)
  }
  if (outcome.status === "error") return fail(502, "read_failed", outcome.error)
  return fail(400, "unsupported", outcome.status === "unsupported" ? outcome.error : undefined)
})

upstreamQuotaRouter.post("/:id/quota/calibrate", requireBrowserSession, async (c) => {
  const upstream = await ownedUpstream(c.get("auth"), c.req.param("id"))
  if (!upstream) return notFound()
  if (!isCopilotUpstream(upstream)) return fail(400, "unsupported_provider", "only Copilot upstreams can be calibrated")
  if (!(await memberGroup(upstream.id))) return fail(400, "not_a_member", "the upstream is not in a group")
  const body = calibrateBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return fail(400, "invalid_calibration", "used, entitlement, usedShare and at must be numbers")
  try {
    const outcome = await getQuotaBalance().reader.calibrate(upstream.id, body.data)
    if (outcome.status === "read") return c.json({ status: "read" }, 200, NO_STORE)
    if (outcome.status === "floor") return fail(429, "too_soon", "a manual read is allowed every 10 minutes", { blockedUntil: outcome.blockedUntil })
    return fail(400, "unsupported", outcome.status === "unsupported" ? outcome.error : undefined)
  } catch (error) {
    if (error instanceof CalibrationError) return fail(400, "invalid_calibration", error.message)
    throw error
  }
})
```

- [ ] **Step 5: Mounts, session-auth exemption and the list DTO**

`packages/gateway/src/control-plane/routes.ts`: add `import { upstreamGroupsRouter, upstreamQuotaRouter } from './quota-balance/routes.ts'` and after the two protection mounts:

```ts
controlPlane.route('/api/upstream-groups', upstreamGroupsRouter)
controlPlane.route('/api/upstreams', upstreamQuotaRouter)
```

`packages/gateway/src/control-plane/auth/session-auth.ts` (~L92), the dashboard polls the group status every minute, so skip the Copilot-token prefetch for it like the other polled management paths:

```ts
  const quotaGroupManagement = c.req.path.startsWith('/api/upstream-groups')
  if (ctx && resolvedUserId && !hasConfigurationSnapshot() && !credentialManagementPath && !quotaObservationPath && !capabilityRead && !setupManagement && !lokiManagement && !telemetryManagement && !protectionManagement && !quotaGroupManagement) {
```

`packages/gateway/src/control-plane/upstreams/public-dto.ts`: add `/** The quota-balancing group this upstream belongs to (null: none). */ groupId?: string | null` to `PublicUpstream`, and an option `groupId?: string | null` in `serializeUpstream`'s options with `if (options.groupId !== undefined) dto.groupId = options.groupId` before `return dto`.

`packages/gateway/src/control-plane/upstreams/routes.ts` list handler: read memberships next to the protection settings and pass them:

```ts
  let groupOf = new Map<string, string>()
  try { groupOf = new Map((await getRepo().quotaBalance.listMemberships()).map(m => [m.upstreamId, m.groupId])) } catch (err) { warnProtection('quota_membership_read_failed', err) }
  return c.json({ upstreams: upstreams.map((upstream) => serializeUpstream(upstream, { syncOrigin, protection: resolveProtection(settings.get(upstream.id)), groupId: groupOf.get(upstream.id) ?? null })) })
```

- [ ] **Step 6: Account for the one new provider-kind comparison in the architecture ratchet** (already done in the commit after Task 10, which added `credential.ts`; nothing to do here)

`packages/gateway/tests/architecture/provider-kind-branches-ratchet.test.ts` counts `provider === "copilot"`-style comparisons in gateway source (the limit may only go down). `quota-balance/credential.ts` adds exactly one (an identity check of the kind the file's header lists first: "is this row really a Copilot row?"). Change `const MAX = 16` to `const MAX = 17` and add this bullet to the header comment under the identity checks: `quota-balance/credential.ts (is this row a Copilot row with a stored credential, for quota reads and group membership)`.

- [ ] **Step 7: Run the tests, related regressions and the typecheck**

Run: `bun test packages/gateway/tests/quota-api.test.ts packages/gateway/tests/architecture packages/gateway/tests/protection-upstream-api.test.ts packages/gateway/tests/protection-api.test.ts packages/gateway/tests/upstream-dto-races.sqlite.test.ts`
Expected: PASS.

Run: `bun run --filter '@vibe-llm/gateway' typecheck && bunx eslint packages/gateway/src/quota-balance packages/gateway/src/control-plane/quota-balance packages/gateway/src/data-plane/chat-flow/shared`
Expected: no errors (warnings only for existing code).

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/control-plane packages/gateway/tests/quota-api.test.ts packages/gateway/tests/architecture/provider-kind-branches-ratchet.test.ts
git commit -m "feat(quota-balance): group, membership, status, refresh and calibration API" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 16: Dashboard data layer: API client, generic reorder (groups move as one item), ordered items, formatting, status controller, i18n

**Files:**
- Create: `apps/dashboard/src/api/upstream-groups.ts`
- Modify: `apps/dashboard/src/api/types.ts` (`UpstreamRecord.groupId`, ~L45)
- Modify: `apps/dashboard/src/state/reorder-upstreams.ts` (generic rows)
- Create: `apps/dashboard/src/state/group-items.ts`
- Create: `apps/dashboard/src/state/quota-format.ts`
- Create: `apps/dashboard/src/state/group-status-controller.ts`
- Modify: `packages/gateway/src/shared/edge/ui-pages/i18n.ts` (EN after `dash.protSummary` ~L433, ZH after `dash.protSummary` ~L2106)
- Create: `apps/dashboard/src/state/group-items.test.ts`, `reorder-upstreams.groups.test.ts`, `quota-format.test.ts`, `group-status-controller.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/dashboard/src/state/group-items.test.ts
import { expect, test } from "bun:test"
import type { UpstreamRecord } from "../api/types"
import type { UpstreamGroup } from "../api/upstream-groups"
import { applyRowOrder, buildOrderItems, toRows } from "./group-items"

const row = (id: string, sortOrder: number, over: Partial<UpstreamRecord> = {}): UpstreamRecord =>
  ({ id, ownerId: "me", provider: "copilot", name: id, enabled: true, sortOrder, config: {}, disabledPublicModelIds: [], createdAt: "2026-01-01T00:00:00Z", updatedAt: "", ...over }) as UpstreamRecord
const group = (id: string, sortOrder: number, over: Partial<UpstreamGroup> = {}): UpstreamGroup =>
  ({ id, ownerId: "me", name: id, enabled: true, sortOrder, memberIds: [], settings: {} as never, createdAt: "2026-01-01T00:00:00Z", updatedAt: "", ...over })

test("a group is one item among ungrouped upstreams; members are not items of their own", () => {
  const items = buildOrderItems(
    [row("u0", 0), row("m1", 50, { groupId: "ug_1" }), row("m2", -5, { groupId: "ug_1" }), row("u1", 10), row("u2", 3)],
    [group("ug_1", 5)],
  )
  expect(items.map(i => `${i.kind}:${i.id}`)).toEqual(["upstream:u0", "upstream:u2", "group:ug_1", "upstream:u1"])
  const g = items.find(i => i.kind === "group")!
  expect(g.kind === "group" && g.members.map(m => m.id)).toEqual(["m1", "m2"]) // members keep no order of their own: stable by creation, then id
})

test("disabled items sort after enabled ones, as the upstream list does", () => {
  const items = buildOrderItems([row("off", 0, { enabled: false }), row("on", 9)], [group("ug_1", 1, { enabled: false })])
  expect(items.map(i => i.id)).toEqual(["on", "off", "ug_1"])
})

test("a member whose group is unknown is shown as an ordinary upstream", () => {
  expect(buildOrderItems([row("m", 0, { groupId: "ug_gone" })], []).map(i => i.kind)).toEqual(["upstream"])
})

test("the reorder rows carry only what ordering needs, and a snapshot order is applied back to the items", () => {
  const items = buildOrderItems([row("a", 0), row("b", 1)], [group("ug_1", 2)])
  expect(toRows(items)).toEqual([
    { id: "a", ownerId: "me", enabled: true, sortOrder: 0 }, { id: "b", ownerId: "me", enabled: true, sortOrder: 1 }, { id: "ug_1", ownerId: "me", enabled: true, sortOrder: 2 },
  ])
  const reordered = applyRowOrder(items, [{ id: "ug_1", sortOrder: 0 }, { id: "a", sortOrder: 1 }])
  expect(reordered.map(i => i.id)).toEqual(["ug_1", "a", "b"]) // items missing from the rows keep their place at the end
})
```

```ts
// apps/dashboard/src/state/reorder-upstreams.groups.test.ts
import { expect, test } from "bun:test"
import { ReorderController, moveUpstream, partitionPosition, sortValueForMove, type ReorderRow } from "./reorder-upstreams"

const r = (id: string, sortOrder: number, over: Partial<ReorderRow> = {}): ReorderRow => ({ id, ownerId: "me", enabled: true, sortOrder, ...over })
const rows = [r("a", 0), r("ug_1", 10), r("b", 20)]

test("a group row is moved among upstream rows like any other row", () => {
  expect(moveUpstream(rows, "ug_1", "a", "me").map(x => x.id)).toEqual(["ug_1", "a", "b"])
  expect(moveUpstream(rows, "a", "b", "me").map(x => x.id)).toEqual(["ug_1", "b", "a"])
  expect(partitionPosition(rows, "ug_1", "me")).toEqual({ position: 2, total: 3 })
  expect(sortValueForMove(rows, "ug_1", "a", "me")).toBe(-1)
})

test("the controller saves a moved group through the same patch callback, by id", async () => {
  const saved: Array<[string, number]> = []
  const controller = new ReorderController<ReorderRow>(rows, async (id, sortOrder) => { saved.push([id, sortOrder]) })
  expect(controller.move("ug_1", "a", "me")).toBe(true)
  await controller.idle()
  expect(saved).toEqual([["ug_1", -1]])
  expect(controller.snapshot().map(x => x.id)).toEqual(["ug_1", "a", "b"])
})
```

```ts
// apps/dashboard/src/state/quota-format.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { MemberStatus } from "../api/upstream-groups"
import { installDictionary } from "./i18n-fixture"
import { amountText, barSegments, entitlementChangeText, memberTone, percentText, reasonKey, sourceLabel, usedOfText } from "./quota-format"

const NOW = Date.UTC(2026, 10, 22, 12, 0)
let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())
const member = (over: Partial<MemberStatus> = {}): MemberStatus => ({
  upstreamId: "up_a", name: "A", login: "a", enabled: true, unlimited: false, usedShare: 0.5, entitlement: 1000, estimatedUsed: 500, projectedShare: 0.7,
  lastRead: { at: NOW - 3 * 3_600_000, source: "github", used: 450, entitlement: 1000, share: 0.45 }, k: 0.02, kPrevious: null, kSamples: 5, outsideRate: 0, outsideShareLastDay: null,
  lastErrorPoints: null, intervalHours: 6, nextReadAt: NOW, failures: 0, lastError: null, entitlementChange: null, cutOff: null, eligibility: { eligible: true, reason: null }, activeSessions: 0, ...over,
})

test("shares are percentages, small ones with a decimal; amounts are grouped", () => {
  expect(percentText(0.5)).toBe("50%")
  expect(percentText(0.036)).toBe("3.6%")
  expect(percentText(1.1)).toBe("110%")
  expect(percentText(null)).toBe("—")
  expect(amountText(1234567)).toBe("1,234,567")
  expect(usedOfText(member())).toBe("500 / 1,000")
  expect(usedOfText(member({ usedShare: null, estimatedUsed: null }))).toBeNull()
})

test("the bar has a solid part (the last read) and a shaded part (the estimate on top), never beyond 100%", () => {
  expect(barSegments(member())).toEqual({ read: 45, estimated: 5, total: 50 })
  expect(barSegments(member({ usedShare: 1.2, lastRead: { at: NOW, source: "github", used: 1100, entitlement: 1000, share: 1.1 } }))).toEqual({ read: 100, estimated: 0, total: 100 })
  expect(barSegments(member({ usedShare: null, lastRead: null }))).toEqual({ read: 0, estimated: 0, total: 0 })
})

test("the tone follows the group's lines", () => {
  expect(memberTone(0.5, 0.9, 0.95)).toBe("brand")
  expect(memberTone(0.9, 0.9, 0.95)).toBe("warn")
  expect(memberTone(0.95, 0.9, 0.95)).toBe("danger")
})

test("the source label says where the number comes from and how old it is", () => {
  const t = window.t!
  expect(sourceLabel(member({ lastRead: { at: NOW - 20_000, source: "github", used: 500, entitlement: 1000, share: 0.5 } }), NOW, t)).toBe("GitHub, live · just now")
  expect(sourceLabel(member(), NOW, t)).toBe("estimate · last read 3 hours ago")
  expect(sourceLabel(member({ usedShare: 0.45 }), NOW, t)).toBe("GitHub · read 3 hours ago")
  expect(sourceLabel(member({ lastRead: { at: NOW - 3_600_000, source: "manual", used: 450, entitlement: 1000, share: 0.45 } }), NOW, t)).toBe("calibrated by hand · 1 hour ago")
  expect(sourceLabel(member({ lastRead: null, usedShare: null }), NOW, t)).toBe("Not read yet: takes no new sessions until it is read or calibrated")
})

test("an entitlement change reads 'from X to Y' with the local time", () => {
  expect(entitlementChangeText({ from: 1000, to: 2000, at: NOW - 3_600_000 }, window.t!, NOW)).toBe("Entitlement changed from 1,000 to 2,000 (1 hour ago)")
})

test("every ineligibility reason has a text key", () => {
  for (const reason of ["disabled", "cut_off", "paused", "no_read", "soft_line"] as const) expect(window.t!(reasonKey(reason))).not.toStartWith("dash.")
})
```

```ts
// apps/dashboard/src/state/group-status-controller.test.ts
import { expect, test } from "bun:test"
import type { GroupStatus, UpstreamGroup } from "../api/upstream-groups"
import { createGroupStatusController } from "./group-status-controller"

const group = (id: string, memberIds: string[]): UpstreamGroup => ({ id, memberIds, name: id, ownerId: "me", enabled: true, sortOrder: 0, settings: {} as never, createdAt: "", updatedAt: "" })
const status = (id: string) => ({ group: group(id, []), state: "normal", members: [], attention: [], nowMs: 0 }) as GroupStatus
const visible = { hidden: () => false, subscribe: () => () => {} }
const fakeTimers = () => { const ticks: Array<() => void> = []; return { ticks, timers: { setInterval: (fn: () => void) => { ticks.push(fn); return ticks.length }, clearInterval: () => {} } } }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(over: Partial<Parameters<typeof createGroupStatusController>[0]> = {}) {
  const calls: string[] = []
  const seen: string[][] = []
  const f = fakeTimers()
  const controller = createGroupStatusController({
    listGroups: async () => ({ groups: [group("ug_1", ["up_a", "up_b"]), group("ug_2", ["up_c"])] }),
    getStatus: async id => status(id),
    refreshQuota: async id => { calls.push(id); return { status: "read" } },
    onStatuses: statuses => seen.push([...statuses.keys()]),
    timers: f.timers, visibility: visible, ...over,
  })
  return { calls, seen, f, controller }
}

test("a refresh loads the groups and every status; a group whose status fails is left out", async () => {
  const { controller, seen } = setup({ getStatus: async id => { if (id === "ug_2") throw new Error("x"); return status(id) } })
  await controller.refresh()
  expect(seen).toEqual([["ug_1"]])
})

test("a slow older refresh cannot overwrite a newer one", async () => {
  const releases: Array<() => void> = []
  let n = 0
  const { controller, seen } = setup({ listGroups: () => { const mine = n++; return new Promise(resolve => releases.push(() => resolve({ groups: [group(`ug_${mine}`, [])] }))) } })
  const slow = controller.refresh()
  const fast = controller.refresh()
  releases[1]!(); await fast
  releases[0]!(); await slow
  expect(seen).toEqual([["ug_1"]])
})

test("opening the page reads every member live, one after the other, then refreshes; a failing member does not stop the others", async () => {
  const order: string[] = []
  const { controller, seen } = setup({ refreshQuota: async id => { order.push(id); if (id === "up_a") throw new Error("floor"); return { status: "reused" } } })
  await controller.readLive()
  expect(order).toEqual(["up_a", "up_b", "up_c"])
  expect(seen.length).toBe(1)
})

test("start reads live once and then only refreshes estimates every minute; stop ends the polling", async () => {
  const { controller, calls, f, seen } = setup()
  const stop = controller.start()
  await settle()
  expect(calls).toEqual(["up_a", "up_b", "up_c"])
  const before = seen.length
  f.ticks[0]!()
  await settle()
  expect(seen.length).toBe(before + 1)
  expect(calls).toHaveLength(3) // polling never reads GitHub
  stop()
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/dashboard && bun test src/state/group-items.test.ts src/state/reorder-upstreams.groups.test.ts src/state/quota-format.test.ts src/state/group-status-controller.test.ts`
Expected: FAIL (modules missing; `ReorderRow` not exported).

- [ ] **Step 3: API client and types**

```ts
// apps/dashboard/src/api/upstream-groups.ts
import { api } from "./client"

export interface GroupSettings {
  toleranceShare: number
  softShare: number
  hardShare: number
  idleRebalanceMinutes: number
  migrateShare: number
  burnHorizonHours: number
  heavySessionUsdPerHour: number
  migrateMinHours: number
  exhaustedPolicy: "stop" | "overage"
  readIntervalHours: number
  confirmShare: number
  driftShare: number
  sessionIdleHours: number
}
export interface UpstreamGroup {
  id: string
  ownerId: string
  name: string
  enabled: boolean
  sortOrder: number
  settings: GroupSettings
  memberIds: string[]
  createdAt: string
  updatedAt: string
}
export type IneligibleReason = "disabled" | "cut_off" | "paused" | "no_read" | "soft_line"
export interface MemberStatus {
  upstreamId: string
  name: string
  login: string | null
  enabled: boolean
  unlimited: boolean
  usedShare: number | null
  entitlement: number | null
  estimatedUsed: number | null
  projectedShare: number | null
  lastRead: { at: number; source: "github" | "manual"; used: number; entitlement: number; share: number } | null
  k: number | null
  kPrevious: number | null
  kSamples: number
  outsideRate: number
  outsideShareLastDay: number | null
  lastErrorPoints: number | null
  intervalHours: number
  nextReadAt: number
  failures: number
  lastError: string | null
  entitlementChange: { from: number; to: number; at: number } | null
  cutOff: { until: number; provisional: boolean; share: number } | null
  eligibility: { eligible: boolean; reason: IneligibleReason | null }
  activeSessions: number
}
export interface GroupStatus {
  group: UpstreamGroup
  state: "normal" | "stopped" | "overage"
  members: MemberStatus[]
  attention: Array<{ upstreamId: string; kind: "large_error" | "read_failing" | "entitlement_changed" }>
  nowMs: number
}
export interface GroupAlert { kind: "stopped" | "overage"; groupId: string; groupName: string }
export interface RefreshResult { status: "read" | "reused" | "error" | "unsupported"; lastReadAt?: number | null; blockedUntil?: number }
export interface GroupCreate { name: string; settings?: Partial<GroupSettings>; sortOrder?: number }
export interface GroupPatch { name?: string; enabled?: boolean; sortOrder?: number; settings?: Partial<GroupSettings> }
export interface Calibration { used?: number; entitlement?: number; usedShare?: number; at?: number }

const group = (id: string) => `/api/upstream-groups/${encodeURIComponent(id)}`
const quota = (upstreamId: string, rest: string) => `/api/upstreams/${encodeURIComponent(upstreamId)}/${rest}`

export const listGroups = () => api<{ groups: UpstreamGroup[] }>("/api/upstream-groups")
export const createGroup = (body: GroupCreate) => api<{ group: UpstreamGroup }>("/api/upstream-groups", { method: "POST", body })
export const patchGroup = (id: string, body: GroupPatch) => api<{ group: UpstreamGroup }>(group(id), { method: "PATCH", body })
export const deleteGroup = (id: string) => api<{ ok: true }>(group(id), { method: "DELETE" })
export const getGroupStatus = (id: string) => api<GroupStatus>(`${group(id)}/status`)
export const getGroupAlerts = () => api<{ alerts: GroupAlert[] }>("/api/upstream-groups/alerts")
export const setUpstreamGroup = (upstreamId: string, groupId: string | null) => api<{ ok: true; groupId: string | null }>(quota(upstreamId, "group"), { method: "PUT", body: { groupId } })
/** The server reads GitHub at most every 10 minutes per member and otherwise answers `reused`. */
export const refreshQuota = (upstreamId: string) => api<RefreshResult>(quota(upstreamId, "quota/refresh"), { method: "POST" })
export const calibrateQuota = (upstreamId: string, body: Calibration) => api<{ status: "read" }>(quota(upstreamId, "quota/calibrate"), { method: "POST", body })
```

In `apps/dashboard/src/api/types.ts` `UpstreamRecord` add after `protection?: ProtectionSettings`:

```ts
  /** The quota-balancing group this upstream belongs to (null or absent: none). */
  groupId?: string | null
```

- [ ] **Step 4: Make the reorder helpers generic**

In `apps/dashboard/src/state/reorder-upstreams.ts` replace the `UpstreamRecord` import and types by a structural row type and make every helper generic over it (behaviour unchanged; `UpstreamRecord` satisfies `ReorderRow`):

```ts
import type { UpstreamRecord } from "../api/types"

/** What ordering needs of a row: an upstream, or a group (id `ug_…`) which is reordered with the ungrouped upstreams as one item. */
export interface ReorderRow { id: string; ownerId?: string; enabled: boolean; sortOrder: number }

function partition(row: ReorderRow, ownerId: string, enabled: boolean): boolean {
  return (row.ownerId ?? "") === ownerId && row.enabled === enabled
}
export function moveUpstream<T extends ReorderRow>(rows: readonly T[], sourceId: string, targetId: string, ownerId: string): T[] { /* body unchanged: `rows as T[]`, `row: T` */ }
export function partitionPosition<T extends ReorderRow>(rows: readonly T[], id: string, ownerId: string): { position: number; total: number } | null { /* unchanged */ }
export function sortValueForMove<T extends ReorderRow>(rows: readonly T[], sourceId: string, targetId: string, ownerId: string): number | null { /* unchanged */ }
function targetForMove<T extends ReorderRow>(rows: readonly T[], move: Move): string | null { /* unchanged */ }
function applyMove<T extends ReorderRow>(rows: readonly T[], move: Move): T[] { /* unchanged */ }

export class ReorderController<T extends ReorderRow = UpstreamRecord> {
  private confirmed: T[]
  constructor(
    rows: T[],
    private readonly patch: (id: string, sortOrder: number) => Promise<void>,
    private readonly onError: (error: unknown) => void = () => {},
    private readonly onDrained: () => void = () => {},
    private readonly load?: () => Promise<T[]>,
  ) { this.confirmed = rows }
  snapshot(): T[] { /* pending.reduce<T[]>(...) */ }
  replace(rows: T[]) { /* unchanged */ }
  // `this.confirmed = moved.map((row) => { const sortOrder = values.get(row.id); return sortOrder === undefined ? row : { ...row, sortOrder } as T })`
}
```
Every place that said `UpstreamRecord[]`/`UpstreamRecord` inside the file becomes `T[]`/`T` (including the casts `rows as UpstreamRecord[]` in `moveUpstream` and `applyMove`, which become `rows as T[]`); the `Move` type and the queue logic are untouched. The existing `state/reorder-upstreams.test.ts` and `state/upstreams.ts` keep compiling because `T` defaults to `UpstreamRecord`.

- [ ] **Step 5: Ordered items, formatting, controller**

```ts
// apps/dashboard/src/state/group-items.ts
import type { UpstreamRecord } from "../api/types"
import type { UpstreamGroup } from "../api/upstream-groups"
import type { ReorderRow } from "./reorder-upstreams"

export interface UpstreamItem extends ReorderRow { kind: "upstream"; ownerId: string; upstream: UpstreamRecord }
export interface GroupItem extends ReorderRow { kind: "group"; ownerId: string; group: UpstreamGroup; members: UpstreamRecord[] }
export type OrderItem = UpstreamItem | GroupItem

type Keyed = OrderItem & { createdAt: string }
const order = (a: Keyed, b: Keyed): number =>
  (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1) || a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

/**
 * The reorderable items of the Upstreams page: every ungrouped upstream and every group (members are inside their group's item and have no order of
 * their own), in the display order of the list (enabled first, then sort order). A member whose group is unknown is shown as an ordinary upstream.
 */
export function buildOrderItems(upstreams: readonly UpstreamRecord[], groups: readonly UpstreamGroup[]): OrderItem[] {
  const known = new Set(groups.map(group => group.id))
  const members = new Map<string, UpstreamRecord[]>()
  const items: Keyed[] = []
  for (const upstream of upstreams) {
    if (upstream.groupId && known.has(upstream.groupId)) members.set(upstream.groupId, [...(members.get(upstream.groupId) ?? []), upstream])
    else items.push({ kind: "upstream", id: upstream.id, ownerId: upstream.ownerId ?? "", enabled: upstream.enabled, sortOrder: upstream.sortOrder, upstream, createdAt: upstream.createdAt })
  }
  for (const group of groups) {
    const list = [...(members.get(group.id) ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    items.push({ kind: "group", id: group.id, ownerId: group.ownerId, enabled: group.enabled, sortOrder: group.sortOrder, group, members: list, createdAt: group.createdAt })
  }
  return items.sort(order).map(({ createdAt: _createdAt, ...item }) => item as OrderItem)
}

/** The rows the reorder controller works on. */
export const toRows = (items: readonly OrderItem[]): ReorderRow[] => items.map(({ id, ownerId, enabled, sortOrder }) => ({ id, ownerId, enabled, sortOrder }))

/** Items in the order of `rows` (the controller's snapshot, pending moves included); items the rows do not know keep their place at the end. */
export function applyRowOrder<T extends { id: string }>(items: readonly T[], rows: ReadonlyArray<Partial<ReorderRow> & { id: string }>): T[] {
  const byId = new Map(items.map(item => [item.id, item]))
  const ordered = rows.flatMap(row => { const item = byId.get(row.id); return item ? [item] : [] })
  const placed = new Set(ordered.map(item => item.id))
  return [...ordered, ...items.filter(item => !placed.has(item.id))]
}
```

```ts
// apps/dashboard/src/state/quota-format.ts
import type { IneligibleReason, MemberStatus } from "../api/upstream-groups"
import type { MeterTone } from "../ui/meter"
import { formatInstantMs } from "../tabs/telemetry/telemetry-format"
import { timeAgo } from "./time-ago"

export type Translate = (key: string, vars?: Record<string, string | number>) => string

/** A share as a percent number without float noise (0.45 -> 45, 0.9 -> 90). */
export const shareToPercent = (share: number): number => Math.round(share * 1e8) / 1e6
export const percentText = (share: number | null): string => share === null ? "—" : `${(share * 100).toFixed(share < 0.1 ? 1 : 0)}%`
export const amountText = (value: number): string => Math.round(value).toLocaleString("en-US")
export const usedOfText = (m: MemberStatus): string | null => m.estimatedUsed === null || m.entitlement === null ? null : `${amountText(m.estimatedUsed)} / ${amountText(m.entitlement)}`

/** Solid part: the last read. Shaded part: what the estimator adds on top (gateway cost and outside usage since the read). Percent of the allowance, at most 100 in total. */
export function barSegments(m: MemberStatus): { read: number; estimated: number; total: number } {
  if (m.usedShare === null || m.lastRead === null) return { read: 0, estimated: 0, total: 0 }
  const total = Math.max(0, Math.min(100, shareToPercent(m.usedShare)))
  const read = Math.max(0, Math.min(total, shareToPercent(m.lastRead.share)))
  return { read, estimated: Math.round((total - read) * 1e6) / 1e6, total }
}

export const memberTone = (usedShare: number, softShare: number, hardShare: number): MeterTone => usedShare >= hardShare ? "danger" : usedShare >= softShare ? "warn" : "brand"

const ago = (ms: number, nowMs: number): string => timeAgo(new Date(ms).toISOString(), nowMs, "long")

/** "GitHub, live · just now", "estimate · last read 2 hours ago", "calibrated by hand · ..." or the not-read-yet notice. */
export function sourceLabel(m: MemberStatus, nowMs: number, t: Translate): string {
  if (m.lastRead === null) return t("dash.qbNoRead")
  const age = ago(m.lastRead.at, nowMs)
  if (m.lastRead.source === "manual") return t("dash.qbSourceManual", { ago: age })
  if (nowMs - m.lastRead.at < 90_000) return t("dash.qbSourceLive")
  const drift = (m.usedShare ?? m.lastRead.share) - m.lastRead.share
  return t(Math.abs(drift) < 0.0005 ? "dash.qbSourceRead" : "dash.qbSourceEstimate", { ago: age })
}

export function entitlementChangeText(change: { from: number; to: number; at: number }, t: Translate, nowMs: number): string {
  return t("dash.qbEntitlementChanged", { from: amountText(change.from), to: amountText(change.to), when: Math.abs(nowMs - change.at) < 30 * 86_400_000 ? ago(change.at, nowMs) : formatInstantMs(change.at) })
}

const REASON_KEYS: Record<IneligibleReason, string> = {
  disabled: "dash.qbReasonDisabled", cut_off: "dash.qbReasonCutOff", paused: "dash.qbReasonPaused", no_read: "dash.qbReasonNoRead", soft_line: "dash.qbReasonSoftLine",
}
export const reasonKey = (reason: IneligibleReason): string => REASON_KEYS[reason]
```

```ts
// apps/dashboard/src/state/group-status-controller.ts
import type { GroupStatus, RefreshResult, UpstreamGroup } from "../api/upstream-groups"
import { startPolling, type PollingTimers, type PollingVisibility } from "./protection-poll"

export const GROUP_POLL_MS = 60_000

export interface GroupStatusDeps {
  listGroups: () => Promise<{ groups: UpstreamGroup[] }>
  getStatus: (groupId: string) => Promise<GroupStatus>
  /** Reads one member's quota (the server reuses a read newer than 10 minutes). */
  refreshQuota: (upstreamId: string) => Promise<RefreshResult | unknown>
  onStatuses: (statuses: ReadonlyMap<string, GroupStatus>, groups: readonly UpstreamGroup[]) => void
  timers?: PollingTimers
  visibility?: PollingVisibility
}

/**
 * The group status store's logic without React. `refresh` re-reads the estimates (gateway data only, newest answer wins); `readLive` is the page-open
 * live read of every member, one after the other, followed by a refresh; `start` does the live read once and then refreshes every minute while the page is visible.
 */
export function createGroupStatusController(deps: GroupStatusDeps) {
  let latest = 0
  let stopped = false
  const refresh = async (): Promise<void> => {
    const seq = ++latest
    try {
      const { groups } = await deps.listGroups()
      const results = await Promise.allSettled(groups.map(group => deps.getStatus(group.id)))
      if (stopped || seq !== latest) return
      const statuses = new Map<string, GroupStatus>()
      results.forEach((result, index) => { if (result.status === "fulfilled") statuses.set(groups[index]!.id, result.value) })
      deps.onStatuses(statuses, groups)
    } catch { /* keep the last answer; the next poll retries */ }
  }
  const readLive = async (): Promise<void> => {
    try {
      const { groups } = await deps.listGroups()
      for (const group of groups) for (const upstreamId of group.memberIds) {
        if (stopped) return
        await Promise.resolve(deps.refreshQuota(upstreamId)).catch(() => {})
      }
    } catch { /* fall through to the refresh */ }
    await refresh()
  }
  const start = (): (() => void) => {
    stopped = false
    void readLive()
    const stop = startPolling(refresh, GROUP_POLL_MS, deps.timers, deps.visibility)
    return () => { stopped = true; stop() }
  }
  return { refresh, readLive, start }
}
```

- [ ] **Step 6: Add the EN and ZH texts**

In `packages/gateway/src/shared/edge/ui-pages/i18n.ts` add right after the `"dash.protSummary"` line of the `en` dictionary (one key per line, six spaces of indentation like its neighbours):

```
      "dash.qbGroup": "Group",
      "dash.qbMembers": "{n} members",
      "dash.qbStateNormal": "Balancing by projected month-end share",
      "dash.qbStateStopped": "No member can take new sessions",
      "dash.qbStateOverage": "Overage: new sessions may use members above the soft line",
      "dash.qbGroupOff": "Group disabled",
      "dash.qbNoMembers": "No members yet. Add a Copilot upstream to balance usage.",
      "dash.qbAddMember": "Add upstream",
      "dash.qbAddMemberPick": "Choose an upstream",
      "dash.qbRemoveMember": "Remove from group",
      "dash.qbNewGroup": "New group",
      "dash.qbGroupName": "Group name",
      "dash.qbCreate": "Create",
      "dash.qbRename": "Rename",
      "dash.qbSave": "Save",
      "dash.qbCancel": "Cancel",
      "dash.qbDeleteGroup": "Delete group",
      "dash.qbConfirmDelete": "Delete group {name}?",
      "dash.qbConfirmDeleteHint": "Its members become ordinary upstreams; sessions already running are not affected.",
      "dash.qbSettings": "Group settings",
      "dash.qbSettingsDefaults": "Defaults",
      "dash.qbSettingsSaved": "Group settings saved",
      "dash.qbFieldRange": "Default {value}, from {min} to {max}",
      "dash.qbErrNumber": "Enter a number",
      "dash.qbErrInteger": "Enter a whole number",
      "dash.qbErrRange": "Must be between {min} and {max}",
      "dash.qbErrOrder": "The soft line must not exceed the hard line",
      "dash.qbReorderGroupHandle": "Reorder group {name}",
      "dash.qbNoRead": "Not read yet: takes no new sessions until it is read or calibrated",
      "dash.qbUnlimited": "Unlimited",
      "dash.qbSourceLive": "GitHub, live · just now",
      "dash.qbSourceRead": "GitHub · read {ago}",
      "dash.qbSourceEstimate": "estimate · last read {ago}",
      "dash.qbSourceManual": "calibrated by hand · {ago}",
      "dash.qbProjected": "Projected month end {percent}",
      "dash.qbMarkers": "Soft line {soft} · hard line {hard}",
      "dash.qbSessions": "{n} active sessions",
      "dash.qbOutside": "{percent} of the last day's usage came from outside the gateway",
      "dash.qbError": "Last estimate error {points} points",
      "dash.qbInterval": "Read every {hours} h",
      "dash.qbKTrend": "k {k} (before {prev})",
      "dash.qbCutOff": "Cut off until {until}",
      "dash.qbCutOffProvisional": "Cut off on the estimate until {until}; the next read confirms or lifts it",
      "dash.qbReasonDisabled": "Takes no new sessions: upstream disabled",
      "dash.qbReasonCutOff": "Takes no new sessions: cut off at the hard line",
      "dash.qbReasonPaused": "Takes no new sessions: paused by protection",
      "dash.qbReasonNoRead": "Takes no new sessions: not read yet",
      "dash.qbReasonSoftLine": "Takes no new sessions: at the soft line",
      "dash.qbRefresh": "Refresh",
      "dash.qbRefreshed": "Read from GitHub",
      "dash.qbReused": "Read {ago}, reused: the next read is allowed in {minutes} min",
      "dash.qbRefreshFailed": "Could not read the quota",
      "dash.qbCalibrate": "Calibrate",
      "dash.qbCalTitle": "Enter the current usage",
      "dash.qbCalUsed": "Used",
      "dash.qbCalEntitlement": "Entitlement",
      "dash.qbCalShare": "or used share (%)",
      "dash.qbCalAt": "Taken how many minutes ago (0 to 1440)",
      "dash.qbCalInvalid": "Enter valid numbers",
      "dash.qbCalTooSoon": "A manual read is allowed every 10 minutes",
      "dash.qbCalSaved": "Quota calibrated",
      "dash.qbEntitlementChanged": "Entitlement changed from {from} to {to} ({when})",
      "dash.qbAttLargeError": "{name}: estimates were off by more than 10 points",
      "dash.qbAttReadFailing": "{name}: reads keep failing",
      "dash.qbAttEntitlement": "{name}: entitlement changed recently",
      "dash.qbBannerStopped": "Group {name}: no member can take new sessions",
      "dash.qbBannerOverage": "Group {name} is in overage: new sessions use members above the soft line",
      "dash.qbPauseSummary": "usage reached {percent} of the monthly allowance (hard line {hard})",
      "dash.qbPauseSummaryProvisional": "estimated usage reached {percent} of the monthly allowance (hard line {hard}); the next read confirms it",
      "dash.qbPolicyStop": "Stop: skip the group",
      "dash.qbPolicyOverage": "Allow overage",
      "dash.qbSet.toleranceShare": "Balance tolerance (%)",
      "dash.qbSetHelp.toleranceShare": "Members within this many points of the lowest projected share count as equal; the session's stable hash chooses between them.",
      "dash.qbSet.softShare": "Soft line (%)",
      "dash.qbSetHelp.softShare": "Used share at which a member takes no new sessions; running sessions continue.",
      "dash.qbSet.hardShare": "Hard line (%)",
      "dash.qbSetHelp.hardShare": "Used share at which a member is cut off until the monthly reset.",
      "dash.qbSet.idleRebalanceMinutes": "Idle rebalance (minutes)",
      "dash.qbSetHelp.idleRebalanceMinutes": "A session idle this long (its prompt cache is cold) is placed again for free.",
      "dash.qbSet.migrateShare": "Move gap (%)",
      "dash.qbSetHelp.migrateShare": "Projected-share gap above the lowest member that moves an active session, rarely, at the cost of one cache miss.",
      "dash.qbSet.burnHorizonHours": "Burn horizon (hours)",
      "dash.qbSetHelp.burnHorizonHours": "How far the recent gateway spend rate is projected forward.",
      "dash.qbSet.heavySessionUsdPerHour": "Heavy session (USD per hour)",
      "dash.qbSetHelp.heavySessionUsdPerHour": "Sessions spending at least this much per hour are spread without the tolerance band. 0 switches it off.",
      "dash.qbSet.migrateMinHours": "Minimum time between moves (hours)",
      "dash.qbSetHelp.migrateMinHours": "A session is not moved again within this time.",
      "dash.qbSet.exhaustedPolicy": "When no member can take a new session",
      "dash.qbSetHelp.exhaustedPolicy": "Stop skips the group (the client gets 503 only if nothing else can serve); overage lets new sessions use members up to the hard line.",
      "dash.qbSet.readIntervalHours": "Read interval (hours)",
      "dash.qbSetHelp.readIntervalHours": "The longest time between two GitHub quota reads of a member; reads come sooner when estimates were off.",
      "dash.qbSet.confirmShare": "Confirming read at (%)",
      "dash.qbSetHelp.confirmShare": "Estimated used share that triggers an early confirming read.",
      "dash.qbSet.driftShare": "Drift that triggers a read (%)",
      "dash.qbSetHelp.driftShare": "Change in the estimated share since the last read that triggers an early read.",
      "dash.qbSet.sessionIdleHours": "Session memory (hours)",
      "dash.qbSetHelp.sessionIdleHours": "A session not seen for this long is forgotten.",
```

and after `"dash.protSummary"` of the `zh` dictionary:

```
      "dash.qbGroup": "分组",
      "dash.qbMembers": "{n} 个成员",
      "dash.qbStateNormal": "按预计月底占比均衡",
      "dash.qbStateStopped": "没有成员可接收新会话",
      "dash.qbStateOverage": "超额模式：新会话可使用已过软限制的成员",
      "dash.qbGroupOff": "分组已停用",
      "dash.qbNoMembers": "还没有成员。添加 Copilot 上游以均衡用量。",
      "dash.qbAddMember": "添加上游",
      "dash.qbAddMemberPick": "选择上游",
      "dash.qbRemoveMember": "移出分组",
      "dash.qbNewGroup": "新建分组",
      "dash.qbGroupName": "分组名称",
      "dash.qbCreate": "创建",
      "dash.qbRename": "重命名",
      "dash.qbSave": "保存",
      "dash.qbCancel": "取消",
      "dash.qbDeleteGroup": "删除分组",
      "dash.qbConfirmDelete": "删除分组 {name}？",
      "dash.qbConfirmDeleteHint": "成员将变为普通上游；已在进行的会话不受影响。",
      "dash.qbSettings": "分组设置",
      "dash.qbSettingsDefaults": "恢复默认",
      "dash.qbSettingsSaved": "分组设置已保存",
      "dash.qbFieldRange": "默认 {value}，范围 {min} 到 {max}",
      "dash.qbErrNumber": "请输入数字",
      "dash.qbErrInteger": "请输入整数",
      "dash.qbErrRange": "必须在 {min} 到 {max} 之间",
      "dash.qbErrOrder": "软限制不能高于硬限制",
      "dash.qbReorderGroupHandle": "调整分组 {name} 的顺序",
      "dash.qbNoRead": "尚未读取：读取或校准之前不接收新会话",
      "dash.qbUnlimited": "不限量",
      "dash.qbSourceLive": "GitHub 实时 · 刚刚",
      "dash.qbSourceRead": "GitHub · {ago}读取",
      "dash.qbSourceEstimate": "估算 · 上次读取 {ago}",
      "dash.qbSourceManual": "手动校准 · {ago}",
      "dash.qbProjected": "预计月底 {percent}",
      "dash.qbMarkers": "软限制 {soft} · 硬限制 {hard}",
      "dash.qbSessions": "{n} 个活跃会话",
      "dash.qbOutside": "最近一天的用量中有 {percent} 来自网关之外",
      "dash.qbError": "上次估算误差 {points} 个百分点",
      "dash.qbInterval": "每 {hours} 小时读取一次",
      "dash.qbKTrend": "k {k}（此前 {prev}）",
      "dash.qbCutOff": "已切断，至 {until}",
      "dash.qbCutOffProvisional": "按估算暂时切断，至 {until}；下次读取将确认或解除",
      "dash.qbReasonDisabled": "不接收新会话：上游已停用",
      "dash.qbReasonCutOff": "不接收新会话：已在硬限制处切断",
      "dash.qbReasonPaused": "不接收新会话：被防护暂停",
      "dash.qbReasonNoRead": "不接收新会话：尚未读取",
      "dash.qbReasonSoftLine": "不接收新会话：已达软限制",
      "dash.qbRefresh": "刷新",
      "dash.qbRefreshed": "已从 GitHub 读取",
      "dash.qbReused": "{ago}已读取，沿用该结果：{minutes} 分钟后可再次读取",
      "dash.qbRefreshFailed": "无法读取额度",
      "dash.qbCalibrate": "校准",
      "dash.qbCalTitle": "输入当前用量",
      "dash.qbCalUsed": "已用",
      "dash.qbCalEntitlement": "总额度",
      "dash.qbCalShare": "或已用占比（%）",
      "dash.qbCalAt": "多少分钟前取得（0 到 1440）",
      "dash.qbCalInvalid": "请输入有效数字",
      "dash.qbCalTooSoon": "手动读取最短间隔 10 分钟",
      "dash.qbCalSaved": "额度已校准",
      "dash.qbEntitlementChanged": "总额度已从 {from} 变为 {to}（{when}）",
      "dash.qbAttLargeError": "{name}：估算偏差超过 10 个百分点",
      "dash.qbAttReadFailing": "{name}：读取持续失败",
      "dash.qbAttEntitlement": "{name}：总额度最近有变化",
      "dash.qbBannerStopped": "分组 {name}：没有成员可接收新会话",
      "dash.qbBannerOverage": "分组 {name} 处于超额模式：新会话使用已过软限制的成员",
      "dash.qbPauseSummary": "用量已达月度额度的 {percent}（硬限制 {hard}）",
      "dash.qbPauseSummaryProvisional": "估算用量已达月度额度的 {percent}（硬限制 {hard}），下次读取将确认",
      "dash.qbPolicyStop": "停止：跳过该分组",
      "dash.qbPolicyOverage": "允许超额",
      "dash.qbSet.toleranceShare": "均衡容差（%）",
      "dash.qbSetHelp.toleranceShare": "预计占比与最低者相差在此范围内的成员视为相同，由会话的稳定哈希选择。",
      "dash.qbSet.softShare": "软限制（%）",
      "dash.qbSetHelp.softShare": "成员的已用占比达到此值后不再接收新会话；已有会话继续。",
      "dash.qbSet.hardShare": "硬限制（%）",
      "dash.qbSetHelp.hardShare": "成员的已用占比达到此值后被切断，直到月度重置。",
      "dash.qbSet.idleRebalanceMinutes": "空闲重新分配（分钟）",
      "dash.qbSetHelp.idleRebalanceMinutes": "会话空闲这么久（提示缓存已失效）后免费重新分配。",
      "dash.qbSet.migrateShare": "迁移差距（%）",
      "dash.qbSetHelp.migrateShare": "预计占比高出最低成员此值时，偶尔迁移一个活跃会话，代价是一次缓存未命中。",
      "dash.qbSet.burnHorizonHours": "消耗预测时长（小时）",
      "dash.qbSetHelp.burnHorizonHours": "把最近的网关消耗速率向前外推的时长。",
      "dash.qbSet.heavySessionUsdPerHour": "重度会话（美元/小时）",
      "dash.qbSetHelp.heavySessionUsdPerHour": "每小时花费不低于此值的会话不使用容差带分散。0 表示关闭。",
      "dash.qbSet.migrateMinHours": "两次迁移的最短间隔（小时）",
      "dash.qbSetHelp.migrateMinHours": "会话在此时间内不会再次被迁移。",
      "dash.qbSet.exhaustedPolicy": "没有成员可接收新会话时",
      "dash.qbSetHelp.exhaustedPolicy": "停止：跳过该分组（其他条目都无法服务时客户端才收到 503）；允许超额：新会话可使用直到硬限制的成员。",
      "dash.qbSet.readIntervalHours": "读取间隔（小时）",
      "dash.qbSetHelp.readIntervalHours": "两次读取成员 GitHub 额度的最长间隔；估算偏差较大时会更早读取。",
      "dash.qbSet.confirmShare": "确认读取阈值（%）",
      "dash.qbSetHelp.confirmShare": "估算已用占比达到此值时提前读取确认。",
      "dash.qbSet.driftShare": "触发读取的漂移（%）",
      "dash.qbSetHelp.driftShare": "估算占比相对上次读取变化超过此值时提前读取。",
      "dash.qbSet.sessionIdleHours": "会话记忆（小时）",
      "dash.qbSetHelp.sessionIdleHours": "超过此时间未出现的会话会被遗忘。",
```

- [ ] **Step 7: Run the tests and the typechecks**

Run: `cd apps/dashboard && bun test src/state/group-items.test.ts src/state/reorder-upstreams.groups.test.ts src/state/reorder-upstreams.test.ts src/state/quota-format.test.ts src/state/group-status-controller.test.ts`
Expected: PASS (the pre-existing reorder tests prove the generic rewrite did not change behaviour).

Run: `bun test packages/gateway/tests/i18n-keys.test.ts packages/gateway/tests/i18n-interpolation.test.ts` and `bun run --filter '@vibe-llm/dashboard' typecheck`
Expected: PASS / no errors (new keys exist in both languages).

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/api/upstream-groups.ts apps/dashboard/src/api/types.ts apps/dashboard/src/state/reorder-upstreams.ts apps/dashboard/src/state/group-items.ts apps/dashboard/src/state/quota-format.ts apps/dashboard/src/state/group-status-controller.ts apps/dashboard/src/state/group-items.test.ts apps/dashboard/src/state/reorder-upstreams.groups.test.ts apps/dashboard/src/state/quota-format.test.ts apps/dashboard/src/state/group-status-controller.test.ts packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(quota-balance): dashboard data layer, generic reorder, formatting and texts" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 17: Dashboard: the group card as one reorderable item, member quota rows, live numbers

**Files:**
- Modify: `apps/dashboard/src/state/group-items.ts` (add `ownerSections`)
- Modify: `apps/dashboard/src/state/upstreams.ts` (groups and items)
- Create: `apps/dashboard/src/tabs/upstreams/groups/use-group-status.ts`
- Create: `apps/dashboard/src/tabs/upstreams/groups/MemberQuotaRow.tsx`
- Create: `apps/dashboard/src/tabs/upstreams/groups/GroupCard.tsx`
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx` (`orderable` prop)
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx` (items instead of rows)
- Create: `apps/dashboard/src/tabs/upstreams/groups/MemberQuotaRow.test.tsx`, `GroupCard.test.tsx`; extend `state/group-items.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/dashboard/src/state/group-items.test.ts`:

```ts
import { ownerSections } from "./group-items"

test("items are sectioned by owner, the viewer's own first, labelled by the Copilot login when there is one", () => {
  const items = buildOrderItems(
    [row("mine", 0, { config: { user: { id: 1, login: "me-login" } } }), row("theirs", 1, { ownerId: "zed", config: { user: { id: 2, login: "alice" } } }), row("shared", 2, { ownerId: "" }), row("m", 3, { groupId: "ug_1", ownerId: "zed", config: { user: { id: 3, login: "bob" } } })],
    [group("ug_1", 4, { ownerId: "zed" })],
  )
  const sections = ownerSections(items, "me", "Global")
  expect(sections.map(s => [s.ownerId, s.label, s.isMine, s.items.map(i => i.id)])).toEqual([
    ["me", "@me-login", true, ["mine"]], ["zed", "@alice", false, ["theirs", "ug_1"]], ["", "Global", false, ["shared"]],
  ])
})
```

```tsx
// apps/dashboard/src/tabs/upstreams/groups/MemberQuotaRow.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { MemberStatus, UpstreamGroup } from "../../../api/upstream-groups"
import { installDictionary } from "../../../state/i18n-fixture"
import { setDisplayZone } from "../../telemetry/telemetry-format"
import { MemberQuotaRow } from "./MemberQuotaRow"

const NOW = Date.UTC(2026, 10, 22, 12, 0)
let restore: () => void = () => {}
beforeEach(() => { setDisplayZone("UTC"); restore = installDictionary("en") })
afterEach(() => { restore(); setDisplayZone(null) })
const group = { id: "ug_1", settings: { softShare: 0.9, hardShare: 0.95 } } as UpstreamGroup
const member = (over: Partial<MemberStatus> = {}): MemberStatus => ({
  upstreamId: "up_a", name: "A", login: "a", enabled: true, unlimited: false, usedShare: 0.5, entitlement: 1000, estimatedUsed: 500, projectedShare: 0.7,
  lastRead: { at: NOW - 2 * 3_600_000, source: "github", used: 450, entitlement: 1000, share: 0.45 }, k: 0.02, kPrevious: 0.03, kSamples: 5, outsideRate: 0.001, outsideShareLastDay: 0.25,
  lastErrorPoints: -2.4, intervalHours: 3, nextReadAt: NOW, failures: 0, lastError: null, entitlementChange: null, cutOff: null, eligibility: { eligible: true, reason: null }, activeSessions: 2, ...over,
})
const html = (m: MemberStatus, extra: { busy?: boolean; readOnly?: boolean } = {}) =>
  renderToStaticMarkup(<MemberQuotaRow member={m} group={group} nowMs={NOW} busy={extra.busy ?? false} readOnly={extra.readOnly ?? false} onRefresh={() => {}} onCalibrate={() => {}} onRemove={() => {}} />)

test("a member row shows used / entitlement and share, the source and age, the projection, the lines and the details", () => {
  const out = html(member())
  expect(out).toContain("500 / 1,000")
  expect(out).toContain("50%")
  expect(out).toContain("estimate · last read 2 hours ago")
  expect(out).toContain("Projected month end 70%")
  expect(out).toContain("Soft line 90% · hard line 95%")
  expect(out).toContain("2 active sessions")
  expect(out).toContain("25% of the last day&#x27;s usage came from outside the gateway")
  expect(out).toContain("Last estimate error -2.4 points")
  expect(out).toContain("Read every 3 h")
  expect(out).toContain("k 0.02 (before 0.03)")
})

test("the bar has a solid read part, a shaded estimated part and the two line markers", () => {
  const out = html(member())
  expect(out).toContain("width:45%")
  expect(out).toContain("width:5%")
  expect(out).toContain("left:90%")
  expect(out).toContain("left:95%")
})

test("a member that was never read says so and has no figures", () => {
  const out = html(member({ lastRead: null, usedShare: null, estimatedUsed: null, projectedShare: null, eligibility: { eligible: false, reason: "no_read" } }))
  expect(out).toContain("Not read yet: takes no new sessions until it is read or calibrated")
  expect(out).not.toContain("Projected month end")
})

test("an unlimited account shows no bar and no lines", () => {
  const out = html(member({ unlimited: true, usedShare: 0, estimatedUsed: 0, entitlement: null }))
  expect(out).toContain("Unlimited")
  expect(out).not.toContain("left:90%")
})

test("a cut-off member shows until when, a provisional one says the next read decides, an ineligible one says why", () => {
  expect(html(member({ cutOff: { until: Date.UTC(2026, 11, 1), provisional: false, share: 0.96 }, eligibility: { eligible: false, reason: "cut_off" } }))).toContain("Cut off until 12-01 00:00")
  expect(html(member({ cutOff: { until: Date.UTC(2026, 11, 1), provisional: true, share: 0.96 }, eligibility: { eligible: false, reason: "cut_off" } }))).toContain("the next read confirms or lifts it")
  expect(html(member({ usedShare: 0.92, eligibility: { eligible: false, reason: "soft_line" } }))).toContain("Takes no new sessions: at the soft line")
})

test("an entitlement change is shown with both values", () => {
  expect(html(member({ entitlementChange: { from: 1000, to: 2000, at: NOW - 3_600_000 } }))).toContain("Entitlement changed from 1,000 to 2,000 (1 hour ago)")
})

test("Refresh and Calibrate are buttons; a read-only viewer sees none; busy disables Refresh", () => {
  expect(html(member())).toContain(">Refresh<")
  expect(html(member())).toContain(">Calibrate<")
  expect(html(member(), { readOnly: true })).not.toContain(">Refresh<")
  expect(html(member(), { busy: true })).toMatch(/<button[^>]*\sdisabled=""[^>]*>…</)
  expect(html(member())).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Refresh</)
})

test("the same row in Chinese", () => {
  restore(); restore = installDictionary("zh")
  const out = html(member())
  expect(out).toContain("预计月底 70%")
  expect(out).toContain("软限制 90% · 硬限制 95%")
})
```

```tsx
// apps/dashboard/src/tabs/upstreams/groups/GroupCard.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { UpstreamGroup } from "../../../api/upstream-groups"
import type { GroupItem } from "../../../state/group-items"
import { installDictionary } from "../../../state/i18n-fixture"
import { GroupCard } from "./GroupCard"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())
const group = (over: Partial<UpstreamGroup> = {}): UpstreamGroup => ({ id: "ug_1", ownerId: "me", name: "Pool", enabled: true, sortOrder: 0, memberIds: [], settings: {} as never, createdAt: "", updatedAt: "", ...over })
const item = (g = group(), memberCount = 2): GroupItem => ({ kind: "group", id: g.id, ownerId: g.ownerId, enabled: g.enabled, sortOrder: g.sortOrder, group: g, members: Array.from({ length: memberCount }, (_, i) => ({ id: `m${i}` }) as never) })
const render = (over: Partial<Parameters<typeof GroupCard>[0]> = {}) => renderToStaticMarkup(
  <GroupCard item={item()} index={1} total={3} dragging={false} dropTarget={false} readOnly={false} busy={false}
    onReorder={() => {}} onToggleEnabled={() => {}} onRename={() => {}} onDelete={() => {}} onToggleSettings={() => {}} settingsOpen={false} {...over}>
    <div>members go here</div>
  </GroupCard>)

test("the card names the group, counts members and renders its children", () => {
  const out = render()
  expect(out).toContain("Pool")
  expect(out).toContain("2 members")
  expect(out).toContain("members go here")
  expect(out).toContain("Balancing by projected month-end share")
  expect(out).toContain('aria-label="Reorder group Pool"')
})

test("the state is shown: stopped in a danger badge, overage in a warning, a disabled group says so", () => {
  expect(render({ status: { state: "stopped", group: group(), members: [], attention: [], nowMs: 0 } })).toContain("No member can take new sessions")
  expect(render({ status: { state: "overage", group: group(), members: [], attention: [], nowMs: 0 } })).toContain("Overage: new sessions may use members above the soft line")
  expect(render({ item: item(group({ enabled: false })) })).toContain("Group disabled")
})

test("a group without members shows the hint instead of an empty list", () => {
  const out = renderToStaticMarkup(<GroupCard item={item(group(), 0)} index={0} total={1} dragging={false} dropTarget={false} readOnly={false} busy={false}
    onReorder={() => {}} onToggleEnabled={() => {}} onRename={() => {}} onDelete={() => {}} onToggleSettings={() => {}} settingsOpen={false}><div>kids</div></GroupCard>)
  expect(out).toContain("No members yet. Add a Copilot upstream to balance usage.")
  expect(out).not.toContain("kids")
})

test("attention items name the member and the problem", () => {
  const out = render({ status: { state: "normal", group: group(), nowMs: 0, members: [{ upstreamId: "m0", name: "Alpha" } as never], attention: [{ upstreamId: "m0", kind: "read_failing" }] } })
  expect(out).toContain("Alpha: reads keep failing")
})

test("a read-only viewer gets no controls", () => {
  const out = render({ readOnly: true })
  expect(out).not.toContain("Delete group")
  expect(out).not.toContain("Rename")
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/dashboard && bun test src/state/group-items.test.ts src/tabs/upstreams/groups`
Expected: FAIL (components and `ownerSections` missing).

- [ ] **Step 3: Owner sections**

Append to `apps/dashboard/src/state/group-items.ts`:

```ts
export interface OwnerSection { ownerId: string; label: string; items: OrderItem[]; isMine: boolean }

/** Items grouped by owner (the viewer's own first, then by label); an owner is labelled by its Copilot login when one of its upstreams has it. */
export function ownerSections(items: readonly OrderItem[], myOwnerId: string, globalLabel: string): OwnerSection[] {
  const sections = new Map<string, OwnerSection>()
  for (const item of items) {
    let section = sections.get(item.ownerId)
    if (!section) { section = { ownerId: item.ownerId, label: "", items: [], isMine: item.ownerId === myOwnerId }; sections.set(item.ownerId, section) }
    section.items.push(item)
  }
  for (const section of sections.values()) {
    const rows = section.items.flatMap(item => item.kind === "upstream" ? [item.upstream] : item.members)
    const login = rows.find(row => row.provider === "copilot" && row.config?.user?.login)?.config?.user?.login
    section.label = login ? `@${login}` : section.ownerId ? `#${section.ownerId.slice(0, 8)}` : globalLabel
  }
  return [...sections.values()].sort((a, b) => (a.isMine !== b.isMine ? (a.isMine ? -1 : 1) : a.label.localeCompare(b.label)))
}
```
(Labels are compared with `localeCompare`; ICU sorts the `@login` label before `Global`.)

- [ ] **Step 4: Groups in the upstreams store**

In `apps/dashboard/src/state/upstreams.ts`:

```ts
import * as groupApi from "../api/upstream-groups"
import { ReorderController, partitionPosition, type ReorderRow } from "./reorder-upstreams"
import { applyRowOrder, buildOrderItems, toRows, type OrderItem } from "./group-items"

function sortUpstreams(list: UpstreamRecord[]): UpstreamRecord[] { /* unchanged */ }

async function loadItems(): Promise<{ upstreams: UpstreamRecord[]; groups: groupApi.UpstreamGroup[]; items: OrderItem[] }> {
  const [{ upstreams }, { groups }] = await Promise.all([api.listUpstreams(), groupApi.listGroups().catch(() => ({ groups: [] as groupApi.UpstreamGroup[] }))])
  const sorted = sortUpstreams(upstreams)
  return { upstreams: sorted, groups, items: buildOrderItems(sorted, groups) }
}
```
inside `useUpstreams()`: replace the controller construction, the `upstreams` state wiring and `reload`:

```ts
  const [upstreams, setUpstreams] = useState<UpstreamRecord[]>([])
  const [groups, setGroups] = useState<groupApi.UpstreamGroup[]>([])
  const [orderRows, setOrderRows] = useState<ReorderRow[]>([])
  ...
  if (!controllerRef.current) {
    controllerRef.current = new ReorderController<ReorderRow>(
      [],
      // A group is saved like an upstream, by id: both live in one sort-order number space per owner.
      (id, sortOrder) => (id.startsWith("ug_") ? groupApi.patchGroup(id, { sortOrder }) : api.patchUpstream(id, { sortOrder })).then(() => {}),
      (error) => toastRef.current(upstreamErrorText(error, tRef.current), "error"),
      () => { void reloadRef.current() },
      async () => toRows((await loadItems()).items),
    )
  }
  ...
  useEffect(() => controller.subscribe(() => setOrderRows(controller.snapshot())), [controller])

  const reload = useCallback(async () => {
    const generation = ++reloadGeneration.current
    setLoading(true)
    try {
      const loaded = await loadItems()
      if (generation === reloadGeneration.current) {
        setUpstreams(loaded.upstreams)
        setGroups(loaded.groups)
        controller.replace(toRows(loaded.items)) // ignored while moves are still being saved
        setOrderRows(controller.snapshot())
      }
      loadModels()
    } catch (e) { toast(e instanceof Error ? e.message : String(e), "error") }
    finally { if (generation === reloadGeneration.current) setLoading(false) }
  }, [toast, loadModels, controller])
```
and in the returned object add:

```ts
    groups,
    /** Ungrouped upstreams and groups in display order (pending moves included); members are inside their group's item. */
    items: applyRowOrder(buildOrderItems(upstreams, groups), orderRows) as OrderItem[],
    positionOf: (id: string, ownerId: string) => partitionPosition(controller.snapshot(), id, ownerId),
```
(`reorderTo`, `reorder` keep their names and call `controller.move` / `controller.moveStep`; `upstreams` is still the full list for the sync sections and the model lists. The controller ref is typed `useRef<ReorderController<ReorderRow> | null>(null)`.)

- [ ] **Step 5: The status hook, the member row and the card**

```ts
// apps/dashboard/src/tabs/upstreams/groups/use-group-status.ts
import { useEffect, useMemo, useState } from "react"
import { getGroupStatus, listGroups, refreshQuota, type GroupStatus } from "../../../api/upstream-groups"
import { createGroupStatusController } from "../../../state/group-status-controller"

/**
 * Group statuses for the Upstreams page. Mounting reads every member's quota live once (the server reuses a read newer than 10 minutes, so
 * switching pages cannot cause frequent reads); while the page is visible the estimates are refreshed every minute from the gateway's own data.
 */
export function useGroupStatuses(): { statuses: ReadonlyMap<string, GroupStatus>; nowMs: number; refresh: () => Promise<void> } {
  const [statuses, setStatuses] = useState<ReadonlyMap<string, GroupStatus>>(new Map())
  const [nowMs, setNowMs] = useState(() => Date.now())
  const controller = useMemo(() => createGroupStatusController({
    listGroups, getStatus: getGroupStatus, refreshQuota,
    onStatuses: next => { setStatuses(next); setNowMs(Date.now()) },
  }), [])
  useEffect(() => controller.start(), [controller])
  return { statuses, nowMs, refresh: controller.refresh }
}
```

```tsx
// apps/dashboard/src/tabs/upstreams/groups/MemberQuotaRow.tsx
import type { MemberStatus, UpstreamGroup } from "../../../api/upstream-groups"
import { useT } from "../../../state/i18n"
import { barSegments, entitlementChangeText, memberTone, percentText, reasonKey, shareToPercent, sourceLabel, usedOfText } from "../../../state/quota-format"
import { formatUntil } from "../../telemetry/telemetry-format"
import { Badge } from "../../../ui/badge"
import { Button } from "../../../ui/button"
import { cn } from "../../../ui/cn"

const FILL = { brand: "bg-brand", warn: "bg-warn", danger: "bg-danger", muted: "bg-fg-subtle", faint: "bg-fg-subtle/40" } as const
const SHADE = { brand: "bg-brand/40", warn: "bg-warn/40", danger: "bg-danger/40", muted: "bg-fg-subtle/30", faint: "bg-fg-subtle/20" } as const

interface Props {
  member: MemberStatus
  group: Pick<UpstreamGroup, "id" | "settings">
  nowMs: number
  busy: boolean
  readOnly: boolean
  onRefresh: () => void
  onCalibrate: () => void
  onRemove: () => void
}

/** The quota of one group member: the Users page's used / entitlement with a share bar, where the figure comes from, and what the balancer knows about it. */
export function MemberQuotaRow({ member: m, group, nowMs, busy, readOnly, onRefresh, onCalibrate, onRemove }: Props) {
  const t = useT()
  const { softShare, hardShare } = group.settings
  const bar = barSegments(m)
  const tone = m.usedShare === null ? "brand" : memberTone(m.usedShare, softShare, hardShare)
  const used = usedOfText(m)
  const details = [
    m.activeSessions > 0 ? t("dash.qbSessions", { n: m.activeSessions }) : null,
    m.outsideShareLastDay !== null ? t("dash.qbOutside", { percent: percentText(m.outsideShareLastDay) }) : null,
    m.lastErrorPoints !== null ? t("dash.qbError", { points: m.lastErrorPoints.toFixed(1) }) : null,
    t("dash.qbInterval", { hours: m.intervalHours }),
    m.k !== null && m.kPrevious !== null ? t("dash.qbKTrend", { k: m.k.toFixed(2), prev: m.kPrevious.toFixed(2) }) : null,
  ].filter((text): text is string => text !== null)
  return (
    <div data-quota-member={m.upstreamId} className="mt-2 space-y-1.5 border-t border-border pt-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-fg-muted">{sourceLabel(m, nowMs, t)}</div>
        {!readOnly ? (
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={onRefresh} disabled={busy}>{busy ? "…" : t("dash.qbRefresh")}</Button>
            <Button variant="ghost" size="sm" onClick={onCalibrate} disabled={busy}>{t("dash.qbCalibrate")}</Button>
            <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy}>{t("dash.qbRemoveMember")}</Button>
          </div>
        ) : null}
      </div>
      {m.unlimited ? <div className="text-xs text-fg">{t("dash.qbUnlimited")}</div> : m.usedShare !== null ? (
        <>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="tabular-nums text-fg">{used ? `${used} ` : ""}({percentText(m.usedShare)})</span>
            {m.projectedShare !== null ? <span className="tabular-nums text-fg-subtle">{t("dash.qbProjected", { percent: percentText(m.projectedShare) })}</span> : null}
          </div>
          <div aria-hidden="true" className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className={cn("absolute inset-y-0 left-0", FILL[tone])} style={{ width: `${bar.read}%` }} />
            <div className={cn("absolute inset-y-0", SHADE[tone])} style={{ left: `${bar.read}%`, width: `${bar.estimated}%` }} />
            <div className="absolute inset-y-0 w-px bg-fg-subtle" style={{ left: `${shareToPercent(softShare)}%` }} />
            <div className="absolute inset-y-0 w-px bg-danger" style={{ left: `${shareToPercent(hardShare)}%` }} />
          </div>
          <div className="text-xs text-fg-subtle">{t("dash.qbMarkers", { soft: percentText(softShare), hard: percentText(hardShare) })}</div>
        </>
      ) : null}
      {details.length > 0 ? <div className="text-xs text-fg-subtle">{details.join(" · ")}</div> : null}
      {m.cutOff ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone="danger">{t("dash.qbCutOff", { until: formatUntil(m.cutOff.until, nowMs) })}</Badge>
          {m.cutOff.provisional ? <span className="text-fg-muted">{t("dash.qbCutOffProvisional", { until: formatUntil(m.cutOff.until, nowMs) })}</span> : null}
        </div>
      ) : null}
      {!m.eligibility.eligible && m.eligibility.reason && m.eligibility.reason !== "cut_off" ? <div className="text-xs text-warn-text">{t(reasonKey(m.eligibility.reason))}</div> : null}
      {m.entitlementChange ? <div className="text-xs text-fg-muted">{entitlementChangeText(m.entitlementChange, t, nowMs)}</div> : null}
      {m.lastError ? <div className="text-xs text-danger-text">{t("dash.qbRefreshFailed")}: {m.lastError}</div> : null}
    </div>
  )
}
```
```tsx
// apps/dashboard/src/tabs/upstreams/groups/GroupCard.tsx
import { useId, type DragEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react"
import { ChevronDown, ChevronUp, GripVertical, Layers } from "lucide-react"
import type { GroupStatus } from "../../../api/upstream-groups"
import type { GroupItem } from "../../../state/group-items"
import { useT } from "../../../state/i18n"
import { Badge } from "../../../ui/badge"
import { Button } from "../../../ui/button"
import { cn } from "../../../ui/cn"

interface Props {
  item: GroupItem
  status?: GroupStatus
  /** Position among the items it can be reordered with. */
  index: number
  total: number
  dragging: boolean
  dropTarget: boolean
  readOnly: boolean
  busy: boolean
  onDragStart?: (event: DragEvent<HTMLButtonElement>) => void
  onDragOver?: (event: DragEvent<HTMLElement>) => void
  onDrop?: (event: DragEvent<HTMLElement>) => void
  onDragEnd?: () => void
  onHandlePointerDown?: (event: PointerEvent<HTMLButtonElement>) => void
  onReorder: (direction: "up" | "down") => void
  onToggleEnabled: () => void
  onRename: () => void
  onDelete: () => void
  onToggleSettings: () => void
  settingsOpen: boolean
  children?: ReactNode
  /** Below the members: the add-member control, the settings panel. */
  footer?: ReactNode
}

const STATE_KEYS = { normal: "dash.qbStateNormal", stopped: "dash.qbStateStopped", overage: "dash.qbStateOverage" } as const
const ATTENTION_KEYS = { large_error: "dash.qbAttLargeError", read_failing: "dash.qbAttReadFailing", entitlement_changed: "dash.qbAttEntitlement" } as const

/** A group is one card in the upstream list: dragged and reordered as a unit, its members inside without an order of their own. */
export function GroupCard({
  item, status, index, total, dragging, dropTarget, readOnly, busy, onDragStart, onDragOver, onDrop, onDragEnd, onHandlePointerDown, onReorder,
  onToggleEnabled, onRename, onDelete, onToggleSettings, settingsOpen, children, footer,
}: Props) {
  const t = useT()
  const nameId = useId()
  const { group, members } = item
  const state = status?.state ?? "normal"
  const onHandleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); onReorder(event.key === "ArrowUp" ? "up" : "down") }
  }
  const nameOf = (upstreamId: string) => status?.members.find(m => m.upstreamId === upstreamId)?.name ?? upstreamId
  return (
    <section
      data-group-id={group.id} aria-labelledby={nameId} onDragOver={onDragOver} onDrop={onDrop}
      className={cn("rounded-lg border border-brand-text/40 bg-panel p-3 sm:p-4 transition-colors", dragging && "opacity-50", dropTarget && "ring-2 ring-brand-text")}
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="size-4 shrink-0 text-brand-text" aria-hidden="true" />
          <h3 id={nameId} className="truncate text-body font-medium text-fg">{group.name}</h3>
          <Badge tone="brand">{t("dash.qbGroup")}</Badge>
          <span className="shrink-0 text-xs text-fg-subtle">{t("dash.qbMembers", { n: members.length })}</span>
          {!group.enabled ? <Badge>{t("dash.qbGroupOff")}</Badge> : null}
          {state === "stopped" ? <Badge tone="danger">{t("dash.qbStateStopped")}</Badge> : state === "overage" ? <Badge tone="warn">{t("dash.qbStateOverage")}</Badge> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button variant="ghost" size="icon-sm" draggable={!readOnly} disabled={readOnly} onDragStart={onDragStart} onDragEnd={onDragEnd} onPointerDown={onHandlePointerDown} onKeyDown={onHandleKeyDown}
            aria-label={t("dash.qbReorderGroupHandle", { name: group.name })} title={t("dash.qbReorderGroupHandle", { name: group.name })} className="cursor-grab enabled:active:cursor-grabbing touch-none">
            <GripVertical aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => onReorder("up")} disabled={readOnly || index === 0} title={t("dash.moveUp")} aria-label={t("dash.moveUp")}><ChevronUp aria-hidden="true" /></Button>
          <Button variant="ghost" size="icon-sm" onClick={() => onReorder("down")} disabled={readOnly || index === total - 1} title={t("dash.moveDown")} aria-label={t("dash.moveDown")}><ChevronDown aria-hidden="true" /></Button>
          <label className={cn("ml-1 flex select-none items-center gap-1 text-xs text-fg-muted", readOnly || busy ? "cursor-not-allowed" : "cursor-pointer")}>
            <input type="checkbox" role="switch" checked={group.enabled} onChange={onToggleEnabled} disabled={readOnly || busy} aria-describedby={nameId} className="accent-brand" />
            <span>{group.enabled ? t("dash.onLabel") : t("dash.offLabel")}</span>
          </label>
          {!readOnly ? (
            <>
              <Button variant="ghost" size="sm" onClick={onToggleSettings} aria-expanded={settingsOpen} disabled={busy}>{settingsOpen ? t("dash.closeBtn") : t("dash.qbSettings")}</Button>
              <Button variant="ghost" size="sm" onClick={onRename} disabled={busy}>{t("dash.qbRename")}</Button>
              <Button variant="ghost" size="sm" onClick={onDelete} disabled={busy} className="text-danger hover:text-danger">{t("dash.qbDeleteGroup")}</Button>
            </>
          ) : null}
        </div>
      </header>
      {state === "normal" ? <p className="mt-1 text-xs text-fg-subtle">{t(STATE_KEYS.normal)}</p> : null}
      {status && status.attention.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-xs text-warn-text">
          {status.attention.map(a => <li key={`${a.upstreamId}:${a.kind}`}>{t(ATTENTION_KEYS[a.kind], { name: nameOf(a.upstreamId) })}</li>)}
        </ul>
      ) : null}
      <div className="mt-3 space-y-2">
        {members.length === 0 ? <p className="text-xs text-fg-muted">{t("dash.qbNoMembers")}</p> : children}
      </div>
      {footer}
    </section>
  )
}
```

`UpstreamRow.tsx`: add `orderable?: boolean` (default `true`) to `Props` and the destructuring, and wrap the three reorder buttons (the drag handle, up and down) in `{orderable ? (<>…</>) : null}`; group members are rendered with `orderable={false}`.

- [ ] **Step 6: Use items in the Upstreams tab**

In `UpstreamsTab.tsx`:

1. Imports: `import { ownerSections, type OrderItem } from "../../state/group-items"`, `GroupCard`, `MemberQuotaRow`, `NewGroupControl`, `useGroupActions` (Task 18) and `useGroupStatuses` from `./groups/...`.
2. Delete the `OwnerGroup` interface and add next to the other state: `const { statuses, nowMs, refresh: refreshStatuses } = useGroupStatuses()`.
3. The drag preview and drop rules work on items (replace `previewRows`, `canDropOn`, `announceMove`, and in `touchDrag` the two `store.upstreams.find(...)` calls by `store.items.find(...)`):

```tsx
  const previewItems = useMemo(
    () => drag?.targetId ? moveUpstream(store.items, drag.sourceId, drag.targetId, myOwnerId) : store.items,
    [store.items, drag, myOwnerId],
  )
  const canDropOn = (sourceId: string, target: OrderItem) => {
    const source = store.items.find((item) => item.id === sourceId)
    return !!source && source.id !== target.id && source.ownerId === myOwnerId && target.ownerId === myOwnerId && source.enabled === target.enabled
  }
  // A move gives a screen reader user no feedback of its own; say where the item landed.
  const announceMove = (item: OrderItem, moved: boolean) => {
    if (!moved) return
    const at = store.positionOf(item.id, myOwnerId)
    const name = item.kind === "group" ? item.group.name : item.upstream.name
    if (at) setAnnouncement(t("dash.reorderUpstreamAnnounce", { name, n: at.position, total: at.total }))
  }
```
4. Replace the owner-group memo by `const groups = useMemo(() => ownerSections(previewItems, myOwnerId, t("dash.globalOwner")), [previewItems, myOwnerId, t])` and add, before the `return`, `const groupActions = ...` (the Task 18 hook; until then this stub keeps the task compiling: `const groupActions = { busy: false, settingsOpenId: null as string | null, toggleEnabled: (_g: UpstreamGroup) => {}, rename: (_g: UpstreamGroup) => {}, remove: (_g: UpstreamGroup) => {}, toggleSettings: (_id: string) => {}, footer: (_item: GroupItem): React.ReactNode => null, refreshMember: (id: string) => { void refreshQuota(id).then(refreshStatuses) }, calibrate: (_id: string) => {}, removeMember: (_u: UpstreamRecord) => {} }`).
5. Move the body of the former `g.rows.map((u, idx) => (<div key={u.id}>…</div>))` into a function declared before the `return` (every reference to `u`, `g`, `editingId`, `proxyId`, … stays as it is). Three edits inside it: `index={position}` and `total={total}` plus a new `orderable={orderable}` prop replace the two `g.rows…` computations; the five drag props (`onDragStart` … `onHandlePointerDown`) are replaced by `{...(dragHandlers ?? {})}`; `announceMove(u, …)` becomes `announceMove(itemOf(u), …)`:

```tsx
  const itemOf = (u: UpstreamRecord): OrderItem => ({ kind: "upstream", id: u.id, ownerId: u.ownerId ?? "", enabled: u.enabled, sortOrder: u.sortOrder, upstream: u })
  /** One upstream row with its edit, proxy and protection panels: an ungrouped upstream, or a group member (`orderable: false`: no drag handle or move buttons). */
  const renderUpstream = (
    u: UpstreamRecord,
    { g, position, total, orderable, dragHandlers }: { g: { isMine: boolean }; position: number; total: number; orderable: boolean; dragHandlers: Record<string, unknown> | null },
  ) => (
    <div key={u.id}>
      {/* the former row JSX, unchanged apart from the three edits above */}
    </div>
  )
```
6. In the owner section header count, `g.rows.length` becomes `g.items.reduce((n, item) => n + (item.kind === "group" ? item.members.length : 1), 0)`, and the list body is:

```tsx
{g.items.map((item, idx) => {
  const peers = g.items.filter((other) => other.enabled === item.enabled)
  const position = g.items.slice(0, idx).filter((other) => other.enabled === item.enabled).length
  const dragHandlers = {
    onDragStart: (event: React.DragEvent<HTMLButtonElement>) => {
      if (!g.isMine) { event.preventDefault(); return }
      event.dataTransfer.effectAllowed = "move"
      event.dataTransfer.setData("text/plain", item.id)
      setDrag({ sourceId: item.id, targetId: null })
    },
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!drag || !canDropOn(drag.sourceId, item)) return
      event.preventDefault()
      event.dataTransfer.dropEffect = "move"
      if (drag.targetId !== item.id) setDrag({ ...drag, targetId: item.id })
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (!drag || !canDropOn(drag.sourceId, item)) return
      event.preventDefault()
      const source = store.items.find((row) => row.id === drag.sourceId)
      const moved = store.reorderTo(drag.sourceId, item.id, myOwnerId)
      if (source) announceMove(source, moved)
      setDrag(null)
    },
    onDragEnd: () => setDrag(null),
    onHandlePointerDown: g.isMine ? (event: React.PointerEvent<HTMLButtonElement>) => touchDrag.begin(event, item.id) : undefined,
  }
  if (item.kind === "upstream") return renderUpstream(item.upstream, { g, position, total: peers.length, orderable: true, dragHandlers })
  const status = statuses.get(item.id)
  return (
    <GroupCard key={item.id} item={item} status={status} index={position} total={peers.length} dragging={drag?.sourceId === item.id} dropTarget={drag?.targetId === item.id}
      readOnly={!g.isMine} busy={groupActions.busy} {...dragHandlers}
      onReorder={(d) => announceMove(item, store.reorder(item.id, d, myOwnerId))}
      onToggleEnabled={() => groupActions.toggleEnabled(item.group)} onRename={() => groupActions.rename(item.group)} onDelete={() => groupActions.remove(item.group)}
      onToggleSettings={() => groupActions.toggleSettings(item.group.id)} settingsOpen={groupActions.settingsOpenId === item.group.id}
      footer={groupActions.footer(item)}>
      {item.members.map((u) => {
        const member = status?.members.find((m) => m.upstreamId === u.id)
        return (
          <div key={u.id}>
            {renderUpstream(u, { g, position: 0, total: 1, orderable: false, dragHandlers: null })}
            {member ? <MemberQuotaRow member={member} group={item.group} nowMs={nowMs} busy={!!store.busy[u.id] || groupActions.busy} readOnly={!g.isMine}
              onRefresh={() => groupActions.refreshMember(u.id)} onCalibrate={() => groupActions.calibrate(u.id)} onRemove={() => groupActions.removeMember(u)} /> : null}
          </div>
        )
      })}
    </GroupCard>
  )
})}
```

- [ ] **Step 7: Run the tests, the dashboard test suite and the typecheck**

Run: `cd apps/dashboard && bun test src/state src/tabs/upstreams src/type-scale.test.ts src/components`
Expected: PASS. Existing `UpstreamRow.*.test.tsx` still pass (the new prop defaults to `true`).

Run: `bun run --filter '@vibe-llm/dashboard' typecheck && bunx eslint apps/dashboard/src/tabs/upstreams apps/dashboard/src/state`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/state apps/dashboard/src/tabs/upstreams
git commit -m "feat(quota-balance): dashboard group card, member quota rows and reorder as one item" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 18: Dashboard: create, rename, enable, delete groups; settings form; add and remove members; Refresh and Calibrate

**Files:**
- Create: `apps/dashboard/src/tabs/upstreams/groups/group-form.ts`
- Create: `apps/dashboard/src/tabs/upstreams/groups/calibrate-form.ts`
- Create: `apps/dashboard/src/tabs/upstreams/groups/group-actions.ts` (pure helpers)
- Create: `apps/dashboard/src/tabs/upstreams/groups/GroupSettingsForm.tsx`, `CalibrateForm.tsx`, `AddMemberControl.tsx`, `NewGroupControl.tsx`
- Create: `apps/dashboard/src/tabs/upstreams/groups/use-group-actions.tsx`
- Modify: `apps/dashboard/src/tabs/upstreams/UpstreamsTab.tsx` (replace the Task 17 stub, header control)
- Create: `apps/dashboard/src/tabs/upstreams/groups/group-form.test.ts`, `calibrate-form.test.ts`, `group-actions.test.ts`, `GroupSettingsForm.test.tsx`
- Create: `packages/gateway/tests/quota-defaults-parity.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/gateway/tests/quota-defaults-parity.test.ts
import { expect, test } from "bun:test"
import { DEFAULT_GROUP_SETTINGS, GROUP_SETTINGS_LIMITS } from "../src/repo/quota-balance"
import { GROUP_DEFAULTS, GROUP_LIMITS } from "../../../apps/dashboard/src/tabs/upstreams/groups/group-form"

test("the dashboard's copy of the group defaults and limits matches the gateway's", () => {
  expect(GROUP_DEFAULTS).toEqual(DEFAULT_GROUP_SETTINGS)
  expect(GROUP_LIMITS).toEqual(GROUP_SETTINGS_LIMITS)
})
```

```ts
// apps/dashboard/src/tabs/upstreams/groups/group-form.test.ts
import { expect, test } from "bun:test"
import { GROUP_DEFAULTS, isDirty, parseForm, resetToDefaults, toForm, displayRange } from "./group-form"

test("shares are edited as percentages, everything else as stored", () => {
  const form = toForm(GROUP_DEFAULTS)
  expect(form.values.softShare).toBe("90")
  expect(form.values.toleranceShare).toBe("5")
  expect(form.values.idleRebalanceMinutes).toBe("10")
  expect(form.policy).toBe("stop")
  expect(displayRange("softShare")).toEqual([50, 100])
  expect(displayRange("readIntervalHours")).toEqual([1, 48])
})

test("a valid form converts back to settings", () => {
  const form = toForm(GROUP_DEFAULTS)
  form.values.softShare = "85"
  form.values.heavySessionUsdPerHour = "0"
  form.policy = "overage"
  expect(parseForm(form)).toEqual({ ok: true, settings: { ...GROUP_DEFAULTS, softShare: 0.85, heavySessionUsdPerHour: 0, exhaustedPolicy: "overage" } })
})

test("each field reports what is wrong with it; the soft line must not exceed the hard line", () => {
  const form = toForm(GROUP_DEFAULTS)
  form.values.toleranceShare = "abc"
  form.values.idleRebalanceMinutes = "2.5"
  form.values.readIntervalHours = "99"
  form.values.softShare = "97"
  expect(parseForm(form)).toEqual({ ok: false, errors: { toleranceShare: "number", idleRebalanceMinutes: "integer", readIntervalHours: "range", softShare: "order" } })
})

test("dirty tracking and reset keep the chosen policy out of the way", () => {
  const form = toForm(GROUP_DEFAULTS)
  expect(isDirty(form, GROUP_DEFAULTS)).toBe(false)
  expect(isDirty({ ...form, policy: "overage" }, GROUP_DEFAULTS)).toBe(true)
  const edited = { ...form, values: { ...form.values, driftShare: "20" } }
  expect(isDirty(edited, GROUP_DEFAULTS)).toBe(true)
  expect(resetToDefaults({ ...edited, policy: "overage" })).toEqual({ ...toForm(GROUP_DEFAULTS), policy: "overage" })
})
```

```ts
// apps/dashboard/src/tabs/upstreams/groups/calibrate-form.test.ts
import { expect, test } from "bun:test"
import { parseCalibration } from "./calibrate-form"

const NOW = 1_800_000_000_000
const form = (over: Partial<Parameters<typeof parseCalibration>[0]> = {}) => ({ used: "", entitlement: "", share: "", minutesAgo: "", ...over })

test("used and entitlement, or a used share, with the time as minutes ago", () => {
  expect(parseCalibration(form({ used: "450", entitlement: "1000" }), NOW)).toEqual({ ok: true, body: { used: 450, entitlement: 1000 } })
  expect(parseCalibration(form({ share: "37.5" }), NOW)).toEqual({ ok: true, body: { usedShare: 0.375 } })
  expect(parseCalibration(form({ share: "40", minutesAgo: "90" }), NOW)).toEqual({ ok: true, body: { usedShare: 0.4, at: NOW - 90 * 60_000 } })
})

test("incomplete or invalid input is refused", () => {
  expect(parseCalibration(form(), NOW)).toEqual({ ok: false })
  expect(parseCalibration(form({ used: "450" }), NOW)).toEqual({ ok: false })
  expect(parseCalibration(form({ used: "-1", entitlement: "10" }), NOW)).toEqual({ ok: false })
  expect(parseCalibration(form({ share: "x" }), NOW)).toEqual({ ok: false })
  expect(parseCalibration(form({ share: "10", minutesAgo: "2000" }), NOW)).toEqual({ ok: false })
  expect(parseCalibration(form({ share: "10", minutesAgo: "-5" }), NOW)).toEqual({ ok: false })
  expect(parseCalibration(form({ used: "12", share: "50" }), NOW)).toEqual({ ok: false }) // an amount needs its entitlement
})
```

```ts
// apps/dashboard/src/tabs/upstreams/groups/group-actions.test.ts
import { afterEach, beforeEach, expect, test } from "bun:test"
import type { UpstreamRecord } from "../../../api/types"
import type { UpstreamGroup } from "../../../api/upstream-groups"
import { installDictionary } from "../../../state/i18n-fixture"
import { memberCandidates, refreshNotice } from "./group-actions"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())
const up = (id: string, over: Partial<UpstreamRecord> = {}): UpstreamRecord => ({ id, ownerId: "me", provider: "copilot", name: id, enabled: true, sortOrder: 0, config: {}, disabledPublicModelIds: [], createdAt: "", updatedAt: "", ...over }) as UpstreamRecord
const group = (over: Partial<UpstreamGroup> = {}): UpstreamGroup => ({ id: "ug_1", ownerId: "me", name: "G", enabled: true, sortOrder: 0, memberIds: [], settings: {} as never, createdAt: "", updatedAt: "", ...over })

test("only the group owner's ungrouped Copilot upstreams can be added; an admin may also add global ones", () => {
  const rows = [up("a"), up("b", { groupId: "ug_9" }), up("c", { provider: "custom" }), up("d", { ownerId: "other" }), up("g", { ownerId: "" })]
  expect(memberCandidates(rows, group(), false).map(u => u.id)).toEqual(["a"])
  expect(memberCandidates(rows, group(), true).map(u => u.id)).toEqual(["a", "g"])
})

test("the refresh toast says whether GitHub was read, reused a recent read, or failed", () => {
  const t = window.t!
  const NOW = Date.UTC(2026, 10, 22, 12, 0)
  expect(refreshNotice({ status: "read" }, t, NOW)).toEqual({ text: "Read from GitHub", tone: "success" })
  expect(refreshNotice({ status: "reused", lastReadAt: NOW - 5 * 60_000, blockedUntil: NOW + 5 * 60_000 }, t, NOW)).toEqual({ text: "Read 5 minutes ago, reused: the next read is allowed in 5 min", tone: "info" })
  expect(refreshNotice({ status: "error" }, t, NOW)).toEqual({ text: "Could not read the quota", tone: "error" })
})
```

```tsx
// apps/dashboard/src/tabs/upstreams/groups/GroupSettingsForm.test.tsx
import { afterEach, beforeEach, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { installDictionary } from "../../../state/i18n-fixture"
import { GroupFields } from "./GroupSettingsForm"
import { GROUP_DEFAULTS, toForm } from "./group-form"

let restore: () => void = () => {}
beforeEach(() => { restore = installDictionary("en") })
afterEach(() => restore())
const noop = () => {}
const render = (over: Partial<Parameters<typeof GroupFields>[0]> = {}) => renderToStaticMarkup(
  <GroupFields form={toForm(GROUP_DEFAULTS)} errors={{}} dirty={false} saving={false} disabled={false} onPolicy={noop} onValue={noop} onReset={noop} onSave={noop} {...over} />)

test("every setting has a labelled input with its default and range, shares shown as percentages", () => {
  const out = render()
  for (const label of ["Balance tolerance (%)", "Soft line (%)", "Hard line (%)", "Idle rebalance (minutes)", "Move gap (%)", "Burn horizon (hours)", "Heavy session (USD per hour)", "Minimum time between moves (hours)", "Read interval (hours)", "Confirming read at (%)", "Drift that triggers a read (%)", "Session memory (hours)"]) {
    expect(out).toContain(label)
  }
  expect(out).toContain("Default 90, from 50 to 100")
  expect(out).toContain('value="90"')
  expect(out).toContain("Stop: skip the group")
  expect(out).toContain("Allow overage")
})

test("errors are shown in place of the hint and Save is disabled until something changed and is valid", () => {
  const bad = render({ errors: { softShare: "order", readIntervalHours: "range" }, dirty: true })
  expect(bad).toContain("The soft line must not exceed the hard line")
  expect(bad).toContain("Must be between 1 and 48")
  expect(bad).toMatch(/<button[^>]*\sdisabled=""[^>]*>Save</)
  expect(render({ dirty: true })).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Save</)
  expect(render()).toMatch(/<button[^>]*\sdisabled=""[^>]*>Save</)
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/dashboard && bun test src/tabs/upstreams/groups` and `cd ../.. && bun test packages/gateway/tests/quota-defaults-parity.test.ts`
Expected: FAIL (modules missing).

- [ ] **Step 3: The forms' logic**

```ts
// apps/dashboard/src/tabs/upstreams/groups/group-form.ts
import type { GroupSettings } from "../../../api/upstream-groups"
import { shareToPercent } from "../../../state/quota-format"

/** Mirrors `DEFAULT_GROUP_SETTINGS` / `GROUP_SETTINGS_LIMITS` in the gateway (a gateway test fails if they drift). */
export const GROUP_DEFAULTS: GroupSettings = {
  toleranceShare: 0.05, softShare: 0.9, hardShare: 0.95, idleRebalanceMinutes: 10, migrateShare: 0.1, burnHorizonHours: 6, heavySessionUsdPerHour: 5,
  migrateMinHours: 12, exhaustedPolicy: "stop", readIntervalHours: 6, confirmShare: 0.9, driftShare: 0.1, sessionIdleHours: 24,
}
export const GROUP_LIMITS = {
  toleranceShare: [0, 0.5], softShare: [0.5, 1], hardShare: [0.5, 1], idleRebalanceMinutes: [1, 1440], migrateShare: [0.01, 1], burnHorizonHours: [0, 72],
  heavySessionUsdPerHour: [0, 10000], migrateMinHours: [0, 720], readIntervalHours: [1, 48], confirmShare: [0.5, 1], driftShare: [0.01, 1], sessionIdleHours: [1, 720],
} as const

export type NumericField = keyof typeof GROUP_LIMITS
export const NUMERIC_FIELDS = Object.keys(GROUP_LIMITS) as NumericField[]
const SHARE_FIELDS: ReadonlySet<NumericField> = new Set<NumericField>(["toleranceShare", "softShare", "hardShare", "migrateShare", "confirmShare", "driftShare"])
const INTEGER_FIELDS: ReadonlySet<NumericField> = new Set<NumericField>(["idleRebalanceMinutes", "sessionIdleHours"])

export interface GroupForm { policy: GroupSettings["exhaustedPolicy"]; values: Record<NumericField, string> }
export type FieldErrorKind = "number" | "integer" | "range" | "order"
export type FieldErrors = Partial<Record<NumericField, FieldErrorKind>>

const toDisplay = (field: NumericField, value: number): string => String(SHARE_FIELDS.has(field) ? shareToPercent(value) : value)
/** The range as the user sees it: percent for shares. */
export const displayRange = (field: NumericField): [number, number] => {
  const [min, max] = GROUP_LIMITS[field]
  return SHARE_FIELDS.has(field) ? [shareToPercent(min), shareToPercent(max)] : [min, max]
}
export const defaultText = (field: NumericField): string => toDisplay(field, GROUP_DEFAULTS[field])

export const toForm = (settings: GroupSettings): GroupForm => ({
  policy: settings.exhaustedPolicy,
  values: Object.fromEntries(NUMERIC_FIELDS.map(field => [field, toDisplay(field, settings[field])])) as Record<NumericField, string>,
})

export function parseForm(form: GroupForm): { ok: true; settings: GroupSettings } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {}
  const settings: GroupSettings = { ...GROUP_DEFAULTS, exhaustedPolicy: form.policy }
  for (const field of NUMERIC_FIELDS) {
    const text = form.values[field].trim()
    const shown = text === "" ? Number.NaN : Number(text)
    const [min, max] = displayRange(field)
    if (!Number.isFinite(shown)) errors[field] = "number"
    else if (INTEGER_FIELDS.has(field) && !Number.isInteger(shown)) errors[field] = "integer"
    else if (shown < min || shown > max) errors[field] = "range"
    else settings[field] = SHARE_FIELDS.has(field) ? Math.round(shown * 1e4) / 1e6 : shown
  }
  if (!errors.softShare && !errors.hardShare && settings.softShare > settings.hardShare) errors.softShare = "order"
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, settings }
}

export const resetToDefaults = (form: GroupForm): GroupForm => ({ ...toForm(GROUP_DEFAULTS), policy: form.policy })

export function isDirty(form: GroupForm, saved: GroupSettings): boolean {
  const base = toForm(saved)
  return base.policy !== form.policy || NUMERIC_FIELDS.some(field => base.values[field] !== form.values[field].trim())
}
```

Note: `Math.round(shown * 1e4) / 1e6` turns a percent like `37.5` into `0.375` without float noise (`37.5 * 1e4 = 375000`).

```ts
// apps/dashboard/src/tabs/upstreams/groups/calibrate-form.ts
import type { Calibration } from "../../../api/upstream-groups"

export interface CalibrateForm { used: string; entitlement: string; share: string; minutesAgo: string }
const num = (text: string): number => (text.trim() === "" ? Number.NaN : Number(text))

/** Used + entitlement, or a used share in percent; the time is entered as minutes ago (at most 24 h) so no time zone is involved. */
export function parseCalibration(form: CalibrateForm, nowMs: number): { ok: true; body: Calibration } | { ok: false } {
  const minutes = form.minutesAgo.trim() === "" ? 0 : num(form.minutesAgo)
  if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) return { ok: false }
  const at = minutes > 0 ? { at: nowMs - minutes * 60_000 } : {}
  const used = num(form.used)
  const entitlement = num(form.entitlement)
  if (form.used.trim() !== "" || form.entitlement.trim() !== "") {
    if (!Number.isFinite(used) || used < 0 || !Number.isFinite(entitlement) || entitlement <= 0) return { ok: false }
    return { ok: true, body: { used, entitlement, ...at } }
  }
  const share = num(form.share)
  if (!Number.isFinite(share) || share < 0) return { ok: false }
  return { ok: true, body: { usedShare: Math.round(share * 1e4) / 1e6, ...at } }
}
```
```ts
// apps/dashboard/src/tabs/upstreams/groups/group-actions.ts
import type { UpstreamRecord } from "../../../api/types"
import type { RefreshResult, UpstreamGroup } from "../../../api/upstream-groups"
import { timeAgo } from "../../../state/time-ago"
import type { Translate } from "../../../state/quota-format"

/** Upstreams that can be added to a group: its owner's ungrouped Copilot upstreams (an admin may also add global ones). */
export function memberCandidates(upstreams: readonly UpstreamRecord[], group: Pick<UpstreamGroup, "ownerId">, isAdmin: boolean): UpstreamRecord[] {
  return upstreams.filter(u => u.provider === "copilot" && !u.groupId && ((u.ownerId ?? "") === group.ownerId || (isAdmin && (u.ownerId ?? "") === "")))
}

export interface Notice { text: string; tone: "success" | "info" | "error" }
/** What the Refresh button reports: a fresh read, a recent read reused (the server's 10 minute floor), or a failure. */
export function refreshNotice(result: Pick<RefreshResult, "status" | "lastReadAt" | "blockedUntil">, t: Translate, nowMs: number): Notice {
  if (result.status === "read") return { text: t("dash.qbRefreshed"), tone: "success" }
  if (result.status === "reused") {
    const ago = result.lastReadAt ? timeAgo(new Date(result.lastReadAt).toISOString(), nowMs, "long") : ""
    return { text: t("dash.qbReused", { ago, minutes: Math.max(1, Math.ceil(((result.blockedUntil ?? nowMs) - nowMs) / 60_000)) }), tone: "info" }
  }
  return { text: t("dash.qbRefreshFailed"), tone: "error" }
}
```

- [ ] **Step 4: The components**

```tsx
// apps/dashboard/src/tabs/upstreams/groups/GroupSettingsForm.tsx
import { useState } from "react"
import { useT } from "../../../state/i18n"
import type { GroupSettings } from "../../../api/upstream-groups"
import { Button } from "../../../ui/button"
import { SegmentedControl } from "../../../ui/segmented-control"
import { Field } from "../form/Field"
import { NUMERIC_FIELDS, defaultText, displayRange, isDirty, parseForm, resetToDefaults, toForm, type FieldErrorKind, type FieldErrors, type GroupForm, type NumericField } from "./group-form"

interface FieldsProps {
  form: GroupForm
  errors: FieldErrors
  dirty: boolean
  saving: boolean
  disabled: boolean
  onPolicy: (policy: GroupForm["policy"]) => void
  onValue: (field: NumericField, value: string) => void
  onReset: () => void
  onSave: () => void
}

/** The presentational form: one input per setting with its default and range (shares in percent), the exhausted-policy switch, Save and Defaults. */
export function GroupFields({ form, errors, dirty, saving, disabled, onPolicy, onValue, onReset, onSave }: FieldsProps) {
  const t = useT()
  const errorText = (field: NumericField, kind: FieldErrorKind): string => {
    const [min, max] = displayRange(field)
    return kind === "number" ? t("dash.qbErrNumber") : kind === "integer" ? t("dash.qbErrInteger") : kind === "order" ? t("dash.qbErrOrder") : t("dash.qbErrRange", { min, max })
  }
  const blocked = disabled || saving || !dirty || Object.keys(errors).length > 0
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 text-xs font-medium text-fg-muted">{t("dash.qbSet.exhaustedPolicy")}</div>
        <SegmentedControl
          options={[{ value: "stop", label: t("dash.qbPolicyStop") }, { value: "overage", label: t("dash.qbPolicyOverage") }]}
          value={form.policy} onChange={onPolicy} ariaLabel={t("dash.qbSet.exhaustedPolicy")} size="sm" disabled={disabled || saving} />
        <p className="mt-1 text-xs text-fg-subtle">{t("dash.qbSetHelp.exhaustedPolicy")}</p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {NUMERIC_FIELDS.map(field => {
          const [min, max] = displayRange(field)
          const kind = errors[field]
          return (
            <Field key={field} label={t(`dash.qbSet.${field}`)} hint={<>{t(`dash.qbSetHelp.${field}`)} {t("dash.qbFieldRange", { value: defaultText(field), min, max })}</>} error={kind ? errorText(field, kind) : undefined}>
              {({ id, describedBy }) => (
                <input id={id} type="number" inputMode="decimal" step="any" value={form.values[field]} disabled={disabled || saving}
                  aria-describedby={describedBy} aria-invalid={kind ? true : undefined} onChange={event => onValue(field, event.target.value)} />
              )}
            </Field>
          )
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={blocked} onClick={onSave}>{t("dash.qbSave")}</Button>
        <Button variant="ghost" size="sm" disabled={disabled || saving} onClick={onReset}>{t("dash.qbSettingsDefaults")}</Button>
      </div>
    </div>
  )
}

interface Props { saved: GroupSettings; saving: boolean; disabled?: boolean; onSave: (settings: GroupSettings) => void }

export function GroupSettingsForm({ saved, saving, disabled = false, onSave }: Props) {
  const [form, setForm] = useState(() => toForm(saved))
  const parsed = parseForm(form)
  return (
    <GroupFields form={form} errors={parsed.ok ? {} : parsed.errors} dirty={isDirty(form, saved)} saving={saving} disabled={disabled}
      onPolicy={policy => setForm(current => ({ ...current, policy }))}
      onValue={(field, value) => setForm(current => ({ ...current, values: { ...current.values, [field]: value } }))}
      onReset={() => setForm(current => resetToDefaults(current))}
      onSave={() => { if (parsed.ok) onSave(parsed.settings) }} />
  )
}
```

```tsx
// apps/dashboard/src/tabs/upstreams/groups/CalibrateForm.tsx
import { useState } from "react"
import type { Calibration } from "../../../api/upstream-groups"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { Field } from "../form/Field"
import { parseCalibration, type CalibrateForm as Form } from "./calibrate-form"

/** The owner's manual reading for an account whose quota can not be read, or to correct an estimate: used and entitlement (or a used share), and how long ago it was taken. */
export function CalibrateForm({ busy, onSave, onCancel, error }: { busy: boolean; onSave: (body: Calibration) => void; onCancel: () => void; error?: string }) {
  const t = useT()
  const [form, setForm] = useState<Form>({ used: "", entitlement: "", share: "", minutesAgo: "" })
  const [invalid, setInvalid] = useState(false)
  const set = (key: keyof Form) => (event: { target: { value: string } }) => { setInvalid(false); setForm(current => ({ ...current, [key]: event.target.value })) }
  const submit = () => {
    const parsed = parseCalibration(form, Date.now())
    if (!parsed.ok) { setInvalid(true); return }
    onSave(parsed.body)
  }
  return (
    <div className="mt-2 space-y-2 rounded-md border border-border bg-background p-3">
      <div className="text-xs font-medium text-fg">{t("dash.qbCalTitle")}</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label={t("dash.qbCalUsed")}>{({ id }) => <input id={id} type="number" inputMode="decimal" step="any" value={form.used} onChange={set("used")} disabled={busy} />}</Field>
        <Field label={t("dash.qbCalEntitlement")}>{({ id }) => <input id={id} type="number" inputMode="decimal" step="any" value={form.entitlement} onChange={set("entitlement")} disabled={busy} />}</Field>
        <Field label={t("dash.qbCalShare")}>{({ id }) => <input id={id} type="number" inputMode="decimal" step="any" value={form.share} onChange={set("share")} disabled={busy} />}</Field>
        <Field label={t("dash.qbCalAt")}>{({ id }) => <input id={id} type="number" inputMode="numeric" step="1" value={form.minutesAgo} onChange={set("minutesAgo")} disabled={busy} />}</Field>
      </div>
      {invalid ? <p role="alert" className="text-xs text-danger-text">{t("dash.qbCalInvalid")}</p> : null}
      {error ? <p role="alert" className="text-xs text-danger-text">{error}</p> : null}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy} onClick={submit}>{t("dash.qbSave")}</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t("dash.qbCancel")}</Button>
      </div>
    </div>
  )
}
```

```tsx
// apps/dashboard/src/tabs/upstreams/groups/AddMemberControl.tsx
import { useState } from "react"
import type { UpstreamRecord } from "../../../api/types"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"
import { Select } from "../../../ui/select"

/** Moves one of the owner's ungrouped Copilot upstreams into the group. */
export function AddMemberControl({ candidates, busy, onAdd }: { candidates: readonly UpstreamRecord[]; busy: boolean; onAdd: (upstream: UpstreamRecord) => void }) {
  const t = useT()
  const [picked, setPicked] = useState("")
  if (candidates.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Select ariaLabel={t("dash.qbAddMember")} placeholder={t("dash.qbAddMemberPick")} value={picked} onChange={setPicked} disabled={busy} size="sm"
        options={candidates.map(u => ({ value: u.id, label: u.config?.user?.login ? `@${u.config.user.login}` : u.name }))} />
      <Button variant="secondary" size="sm" disabled={busy || picked === ""} onClick={() => { const row = candidates.find(u => u.id === picked); if (row) { onAdd(row); setPicked("") } }}>{t("dash.qbAddMember")}</Button>
    </div>
  )
}
```

```tsx
// apps/dashboard/src/tabs/upstreams/groups/NewGroupControl.tsx
import { useState } from "react"
import { useT } from "../../../state/i18n"
import { Button } from "../../../ui/button"

export function NewGroupControl({ busy, onCreate }: { busy: boolean; onCreate: (name: string) => Promise<boolean> }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  if (!open) return <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>{t("dash.qbNewGroup")}</Button>
  const submit = async () => { if (name.trim() !== "" && await onCreate(name.trim())) { setName(""); setOpen(false) } }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input aria-label={t("dash.qbGroupName")} value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter") void submit() }} maxLength={80} disabled={busy} autoFocus />
      <Button variant="primary" size="sm" disabled={busy || name.trim() === ""} onClick={() => void submit()}>{t("dash.qbCreate")}</Button>
      <Button variant="ghost" size="sm" onClick={() => { setName(""); setOpen(false) }}>{t("dash.qbCancel")}</Button>
    </div>
  )
}
```

- [ ] **Step 5: The actions hook and the tab wiring**

```tsx
// apps/dashboard/src/tabs/upstreams/groups/use-group-actions.tsx
import { useState, type ReactNode } from "react"
import type { UpstreamRecord } from "../../../api/types"
import * as groups from "../../../api/upstream-groups"
import type { GroupItem } from "../../../state/group-items"
import { useConfirm } from "../../../state/confirm"
import { useT } from "../../../state/i18n"
import { useToast } from "../../../state/toast"
import { AddMemberControl } from "./AddMemberControl"
import { CalibrateForm } from "./CalibrateForm"
import { GroupSettingsForm } from "./GroupSettingsForm"
import { memberCandidates, refreshNotice } from "./group-actions"

interface Args { upstreams: readonly UpstreamRecord[]; isAdmin: boolean; reload: () => Promise<void>; refreshStatuses: () => Promise<void> }

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** Everything the group cards do: create, rename, enable, delete, settings, add and remove members, Refresh and Calibrate. Every change reloads the lists. */
export function useGroupActions({ upstreams, isAdmin, reload, refreshStatuses }: Args) {
  const t = useT()
  const { push: toast } = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const [settingsOpenId, setSettingsOpenId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [calibratingId, setCalibratingId] = useState<string | null>(null)
  const [calError, setCalError] = useState<string | undefined>()

  const run = async (work: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true)
    try { await work(); if (done) toast(done, "success"); await reload(); await refreshStatuses(); return true }
    catch (error) { toast(errorText(error), "error"); return false }
    finally { setBusy(false) }
  }

  const refreshMember = async (upstreamId: string) => {
    setBusy(true)
    try {
      const result = await groups.refreshQuota(upstreamId)
      const notice = refreshNotice(result, t, Date.now())
      toast(notice.text, notice.tone === "info" ? "success" : notice.tone)
      await refreshStatuses()
    } catch (error) { toast(`${t("dash.qbRefreshFailed")}: ${errorText(error)}`, "error") } finally { setBusy(false) }
  }

  return {
    busy,
    settingsOpenId,
    createGroup: (name: string) => run(() => groups.createGroup({ name })),
    toggleEnabled: (group: groups.UpstreamGroup) => run(() => groups.patchGroup(group.id, { enabled: !group.enabled })),
    rename: (group: groups.UpstreamGroup) => setRenamingId(current => current === group.id ? null : group.id),
    remove: async (group: groups.UpstreamGroup) => {
      const sure = await confirm({ title: t("dash.qbConfirmDelete", { name: group.name }), description: t("dash.qbConfirmDeleteHint"), confirmLabel: t("dash.delete"), danger: true })
      if (sure) await run(() => groups.deleteGroup(group.id))
    },
    toggleSettings: (id: string) => setSettingsOpenId(current => current === id ? null : id),
    refreshMember,
    calibrate: (upstreamId: string) => { setCalError(undefined); setCalibratingId(current => current === upstreamId ? null : upstreamId) },
    removeMember: (upstream: UpstreamRecord) => run(() => groups.setUpstreamGroup(upstream.id, null)),
    /** The content below a group's members: rename, settings, calibration and the add-member control. */
    footer: (item: GroupItem): ReactNode => (
      <>
        {renamingId === item.group.id ? <RenameInline name={item.group.name} busy={busy} onSave={async name => { if (await run(() => groups.patchGroup(item.group.id, { name }))) setRenamingId(null) }} onCancel={() => setRenamingId(null)} /> : null}
        {calibratingId !== null && item.members.some(m => m.id === calibratingId) ? (
          <CalibrateForm busy={busy} error={calError} onCancel={() => setCalibratingId(null)}
            onSave={async body => {
              setBusy(true)
              try { await groups.calibrateQuota(calibratingId, body); toast(t("dash.qbCalSaved"), "success"); setCalibratingId(null); await refreshStatuses() }
              catch (error) { setCalError(error instanceof Error && /too_soon|10 minutes/.test(error.message) ? t("dash.qbCalTooSoon") : errorText(error)) }
              finally { setBusy(false) }
            }} />
        ) : null}
        {settingsOpenId === item.group.id ? (
          <div className="mt-3 rounded-md border border-border bg-background p-3">
            <div className="mb-2 text-xs font-medium text-fg">{t("dash.qbSettings")}</div>
            <GroupSettingsForm saved={item.group.settings} saving={busy} onSave={async settings => { await run(() => groups.patchGroup(item.group.id, { settings }), t("dash.qbSettingsSaved")) }} />
          </div>
        ) : null}
        <AddMemberControl candidates={memberCandidates(upstreams, item.group, isAdmin)} busy={busy}
          onAdd={async upstream => { if (await run(() => groups.setUpstreamGroup(upstream.id, item.group.id))) void groups.refreshQuota(upstream.id).then(refreshStatuses).catch(() => {}) }} />
      </>
    ),
  }
}

function RenameInline({ name, busy, onSave, onCancel }: { name: string; busy: boolean; onSave: (name: string) => void; onCancel: () => void }) {
  const t = useT()
  const [value, setValue] = useState(name)
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <input aria-label={t("dash.qbGroupName")} value={value} onChange={event => setValue(event.target.value)} maxLength={80} disabled={busy} autoFocus />
      <button type="button" className="text-xs text-brand-text" disabled={busy || value.trim() === ""} onClick={() => onSave(value.trim())}>{t("dash.qbSave")}</button>
      <button type="button" className="text-xs text-fg-muted" onClick={onCancel}>{t("dash.qbCancel")}</button>
    </div>
  )
}
```

In `UpstreamsTab.tsx` replace the Task 17 `groupActions` stub with:

```tsx
  const groupActions = useGroupActions({ upstreams: store.upstreams, isAdmin, reload: store.reload, refreshStatuses })
```
and in the page header actions (next to the existing "add" menu of the page header) render `<NewGroupControl busy={groupActions.busy} onCreate={groupActions.createGroup} />`. The `refreshMember`, `calibrate`, `removeMember`, `toggleEnabled`, `rename`, `remove`, `toggleSettings`, `settingsOpenId` and `footer` members of `groupActions` are exactly the names the Task 17 JSX already calls.

- [ ] **Step 6: Run the tests and the checks**

Run: `cd apps/dashboard && bun test src/tabs/upstreams src/state src/type-scale.test.ts` and `cd ../.. && bun test packages/gateway/tests/quota-defaults-parity.test.ts packages/gateway/tests/i18n-keys.test.ts`
Expected: PASS.

Run: `bun run --filter '@vibe-llm/dashboard' typecheck && bunx eslint apps/dashboard/src/tabs/upstreams/groups`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/tabs/upstreams packages/gateway/tests/quota-defaults-parity.test.ts packages/gateway/src/shared/edge/ui-pages/i18n.ts
git commit -m "feat(quota-balance): group management, settings, members, Refresh and Calibrate in the dashboard" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 19: Dashboard: the global banner shows quota cut-offs, skipped groups and overage

A cut-off member is a protection pause, so it already reaches the banner; only its wording needs the quota summary. A group that cannot take new sessions (`stopped`) or runs in `overage` comes from `GET /api/upstream-groups/alerts`, polled by the protection store every minute.

**Files:**
- Modify: `apps/dashboard/src/api/protection.ts` (`PauseReason`)
- Modify: `apps/dashboard/src/components/protection-banner-model.ts`
- Modify: `apps/dashboard/src/components/ProtectionBanner.tsx` (host)
- Modify: `apps/dashboard/src/state/protection-controller.ts`, `apps/dashboard/src/state/protection.tsx`
- Modify: `apps/dashboard/src/components/ProtectionBanner.test.tsx`, `apps/dashboard/src/state/protection-controller.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/dashboard/src/components/ProtectionBanner.test.tsx`:

```tsx
import { groupAlertItems } from "./protection-banner-model"

const quotaReason = (over: Partial<NonNullable<PauseReason["quota"]>> = {}): PauseReason =>
  reason({ trigger: "quota", requests: 0, risky: 0, failureRatio: 0, counts: { rate_limited: 0, rejected: 0, auth: 0, upstream: 0, network: 0, other: 0 },
    quota: { groupId: "ug_1", groupName: "Pool", share: 0.96, hardShare: 0.95, source: "real", provisional: false, ...over } })

test("a quota cut-off reads as the usage that crossed the hard line, a provisional one says the next read decides", () => {
  const ends = Date.UTC(2026, 11, 1)
  expect(text(pause({ reason: quotaReason(), endsAt: ends }))).toBe("Upstream Copilot A paused until 12-01 00:00 — usage reached 96% of the monthly allowance (hard line 95%).")
  expect(text(pause({ reason: quotaReason({ share: 0.97, source: "estimate", provisional: true }), endsAt: ends })))
    .toBe("Upstream Copilot A paused until 12-01 00:00 — estimated usage reached 97% of the monthly allowance (hard line 95%); the next read confirms it.")
})

test("the same quota cut-off in Chinese", () => {
  restore(); restore = installDictionary("zh")
  expect(text(pause({ reason: quotaReason(), endsAt: Date.UTC(2026, 11, 1) }))).toBe("上游 Copilot A 已暂停至 12-01 00:00 — 用量已达月度额度的 96%（硬限制 95%）。")
})

test("a group that cannot take new sessions is a danger item, an overage group a warning; neither can be resumed or opened", () => {
  const items = groupAlertItems([{ kind: "stopped", groupId: "ug_1", groupName: "Pool" }, { kind: "overage", groupId: "ug_2", groupName: "Spare" }], window.t!)
  expect(items.map(item => [item.tone, item.text, item.canResume, item.upstreamId])).toEqual([
    ["danger", "Group Pool: no member can take new sessions", false, ""],
    ["warn", "Group Spare is in overage: new sessions use members above the soft line", false, ""],
  ])
  const html = renderToStaticMarkup(<ProtectionBanner items={items} onResume={() => {}} onOpen={() => {}} canOpen={item => item.upstreamId !== ""} />)
  expect(html).toContain("Group Pool: no member can take new sessions")
  expect(html).not.toContain("Resume now")
})
```
(`reason`, `pause`, `text`, `NOW`, `restore` and `installDictionary` are the helpers already defined at the top of this test file; add `PauseReason` to its type import if it is not there.)

Append to `apps/dashboard/src/state/protection-controller.test.ts`:

```ts
test("group alerts are fetched with the pauses; a failing alerts call does not hide the pauses and the newest answer wins", async () => {
  const alerts: string[][] = []
  const releases: Array<() => void> = []
  let calls = 0
  const { controller, seen } = setup({
    fetchActive: async () => ({ pauses: [pause("p1")] }),
    fetchAlerts: () => { const mine = calls++; return new Promise(resolve => releases.push(() => resolve({ alerts: [{ kind: "stopped", groupId: `ug_${mine}`, groupName: "G" }] }))) },
    onAlerts: list => alerts.push(list.map(a => a.groupId)),
  })
  const slow = controller.refresh()
  const fast = controller.refresh()
  await settle()
  releases[1]!(); await fast
  releases[0]!(); await slow
  expect(alerts).toEqual([["ug_1"]])
  expect(seen.at(-1)).toEqual(["p1"])

  const failing = setup({ fetchAlerts: async () => { throw new Error("down") }, onAlerts: list => alerts.push(list.map(a => a.groupId)) })
  await failing.controller.refresh()
  expect(failing.seen.at(-1)).toEqual([])
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd apps/dashboard && bun test src/components/ProtectionBanner.test.tsx src/state/protection-controller.test.ts`
Expected: FAIL (`groupAlertItems` missing, `fetchAlerts` unknown, quota summary missing).

- [ ] **Step 3: Implement**

`apps/dashboard/src/api/protection.ts` (`PauseReason`):

```ts
  trigger: "ratio" | "authBurst" | "quota"
  keyShare: number | null
  upstreamName?: string
  targetName?: string
  /** Present when `trigger` is "quota": the member reached its group's hard line. */
  quota?: { groupId: string; groupName: string; share: number; hardShare: number; source: "real" | "estimate"; provisional: boolean }
```

`apps/dashboard/src/components/protection-banner-model.ts`:

```ts
import type { GroupAlert } from "../api/upstream-groups"
import { percentText } from "../state/quota-format"

/** "46 rate-limit errors in 5 min (92% of requests)", or for a quota cut-off the usage that crossed the hard line. */
export function summarizeReason(reason: PauseReason, t: Translate): string {
  if (reason.trigger === "quota" && reason.quota) {
    return t(reason.quota.provisional ? "dash.qbPauseSummaryProvisional" : "dash.qbPauseSummary", { percent: percentText(reason.quota.share), hard: percentText(reason.quota.hardShare) })
  }
  const kind = RISKY.reduce((best, cls) => (reason.counts[cls] > reason.counts[best] ? cls : best), RISKY[0])
  return t("dash.protSummary", { count: reason.counts[kind], kind: t(KIND_KEYS[kind]), minutes: reason.windowMinutes, percent: Math.round(reason.failureRatio * 100) })
}

/** Banner items for groups that cannot take new sessions (danger) or run in overage (warning). They cannot be resumed and have no upstream to open. */
export function groupAlertItems(alerts: readonly GroupAlert[], t: Translate): BannerItem[] {
  return alerts.map((alert): BannerItem => ({
    id: `qb:${alert.groupId}:${alert.kind}`,
    tone: alert.kind === "stopped" ? "danger" : "warn",
    text: t(alert.kind === "stopped" ? "dash.qbBannerStopped" : "dash.qbBannerOverage", { name: alert.groupName }),
    canResume: false, upstreamId: "", targetKind: "upstream",
  }))
}
```
(the previous `summarizeReason` body is replaced by the version above; `bannerItems` is unchanged.)

`apps/dashboard/src/state/protection-controller.ts`: extend the deps and `refresh`:

```ts
import type { GroupAlert } from "../api/upstream-groups"

export interface ProtectionControllerDeps {
  fetchActive: () => Promise<{ pauses: ProtectionPause[] }>
  /** Groups that cannot take new sessions or run in overage; optional. A failure leaves the previous alerts and never hides the pauses. */
  fetchAlerts?: () => Promise<{ alerts: GroupAlert[] }>
  onAlerts?: (alerts: GroupAlert[]) => void
  // ...the other deps unchanged
}
  const refresh = async (): Promise<void> => {
    const seq = ++latest
    const [pauses, alerts] = await Promise.allSettled([deps.fetchActive(), deps.fetchAlerts ? deps.fetchAlerts() : Promise.resolve(null)])
    // A slower, older answer must not undo a newer one (for example resurrect a pause that was just resumed).
    if (stopped || seq !== latest) return
    if (pauses.status === "fulfilled") deps.onPauses(pauses.value.pauses)
    if (alerts.status === "fulfilled" && alerts.value) deps.onAlerts?.(alerts.value.alerts)
  }
```
(In the test `seen.at(-1)` for a failing alerts call: pauses are delivered, alerts are not. The "failing" setup's default `fetchActive` returns no pauses, so `seen.at(-1)` is `[]`.)

`apps/dashboard/src/state/protection.tsx`: add `alerts: readonly GroupAlert[]` to `ProtectionStore` (default `[]` in `EMPTY`), a `useState<GroupAlert[]>([])`, pass `fetchAlerts: getGroupAlerts, onAlerts: setAlerts` to `createProtectionController`, and include `alerts` in the memoised value.

`apps/dashboard/src/components/ProtectionBanner.tsx` host:

```tsx
export function ProtectionBannerHost() {
  const t = useT()
  const store = useProtection()
  const items = [...bannerItems(store.pauses, t, Date.now()), ...groupAlertItems(store.alerts, t)]
  return <ProtectionBanner items={items} resuming={store.resuming} onResume={(id) => { void store.resume(id) }} onOpen={store.openUpstream} canOpen={(item) => item.upstreamId !== ""} />
}
```
(import `groupAlertItems` next to `bannerItems`.)

- [ ] **Step 4: Run the tests, all dashboard tests and the typecheck**

Run: `cd apps/dashboard && bun test src && cd ../.. && bun test packages/gateway/tests/i18n-keys.test.ts packages/gateway/tests/i18n-interpolation.test.ts`
Expected: PASS (the whole dashboard suite is small enough to run in one go).

Run: `bun run --filter '@vibe-llm/dashboard' typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/api/protection.ts apps/dashboard/src/components apps/dashboard/src/state/protection.tsx apps/dashboard/src/state/protection-controller.ts apps/dashboard/src/state/protection-controller.test.ts
git commit -m "feat(quota-balance): banner wording for quota cut-offs and skipped or overage groups" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 20: Reference documentation

**Files:**
- Create: `docs/upstream-quota-balancing-v1.md`

- [ ] **Step 1: Write the reference**

```markdown
# Upstream quota balancing (v1)

Reference for operators. Design: `docs/superpowers/specs/2026-11-22-upstream-quota-balancing-design.md`; plan: `docs/superpowers/plans/2026-11-22-upstream-quota-balancing.md`.

## What it does

Copilot accounts have a monthly allowance that resets at 00:00 UTC on the 1st. A group of Copilot upstreams spreads new sessions so that no account runs out while others still have allowance, keeps a session on one account (switching would discard the prompt cache) and reads GitHub's quota endpoint rarely.

Everything is compared as a percentage of each account's own allowance; accounts with different or changing entitlements never compare absolute amounts.

## Groups and routing

- Only Copilot upstreams can join, one group each, and only upstreams of the group's owner (an admin may add global upstreams). Grouping is device-local: it is not synced.
- A group sits in the routing order like one upstream (its own `sort_order`, in the same number space as its owner's upstreams) and is reordered as a unit in the dashboard. Its members have no order of their own.
- Within the group the member is chosen per request by the balancing rule below. If no member can serve (model missing, all at the soft line, cut off or paused) the group is skipped and matching continues with the next item. Only when nothing in the whole order can serve does the client get `503` with `Retry-After`: `group_quota_exhausted`, or `upstream_paused` when every candidate is a protection pause.
- Not balanced: pinned requests (`up_<id>/<model>`), requests whose owned opaque state (Claude thinking signatures, encrypted reasoning) binds them to an upstream, (a group with a single eligible candidate skips only the ranking; the soft and hard lines still apply). With a per-key upstream whitelist the group sits at the position of its first whitelisted member and only whitelisted members count.
- Embeddings, images, decisions and `count_tokens` are balanced per request without a session (least projected share inside the tolerance band, random tie-break); chat completions, messages, responses and Gemini are balanced by session.

## Sessions

The session key is a SHA-256 of the API key id and the first available of: `prompt_cache_key`, Claude Code's `x-claude-code-session-id` or the session part of `metadata.user_id`, Codex `session_id` / `conversation-id` headers, otherwise the system prompt plus the first user message. The key is derived before interceptors strip `prompt_cache_key`. Assignments live in `session_assignments` (per-isolate cache; `last_seen_at` written at most every `min(10, idleRebalanceMinutes / 5)` minutes) and are deleted after `sessionIdleHours`.

A new session goes to the member with the lowest projected month-end share; members within `toleranceShare` of that minimum are equal and the highest `hash(session, upstream)` wins. An existing session stays, except: after `idleRebalanceMinutes` idle (cache cold) it is chosen again for free (a heavy session, spending at least `heavySessionUsdPerHour`, without the band); and a member more than `migrateShare` above the lowest, not moved within `migrateMinHours`, may be moved once (one cache miss). The soft line alone never moves a session.

## Lines

| line | default | effect |
| --- | --- | --- |
| soft (`softShare`) | 90 % | the member takes no new sessions (`stop`); running sessions continue. With `exhaustedPolicy: overage` new sessions may use members up to the hard line and the dashboard warns. |
| hard (`hardShare`) | 95 % | the member is cut off until the monthly reset (a protection pause with reason `quota`, ends at the next 00:00 UTC on the 1st): its sessions move on their next request, sessions bound to it by opaque state get `503 upstream_paused` and must start a new session. A real read below the line, the reset, or the owner's Resume lifts it. An estimate may cut provisionally when a confirming read is not yet allowed; the next read confirms or lifts it. |

A member that has never been read (or calibrated) takes no new sessions.

## Estimates

Between reads: estimated used share = last read share + `k` x gateway cost since the read + `o` x hours since the read. `k` (share per gateway USD) is re-learned after every read as a low quantile (25 %, weighted towards the last days) of share / cost over intervals with at least $1, so outside usage can only raise the ratio; `o` (outside usage, share per hour) is the smoothed residual. Until 3 intervals exist `k` is at least a conservative fallback (the group's median, else a high constant). After the monthly reset the base is zero until the first read.

Projected month-end share = estimated share + `o` x hours left + `k` x recent burn (USD per hour, exponentially weighted over the last hour) x `burnHorizonHours`.

Entitlement changes (a plan change, GitHub changing the allotment): every read records its entitlement and shares use the latest. When it differs from the previous read's, the spanning interval is not used for learning, `k` and `o` are rescaled by old / new and re-learned with the conservative bias, the next read comes within the minimum interval (1 h), and the dashboard shows "entitlement changed from X to Y".

## Reads of the quota endpoint

Reads use the member's own GitHub credential and proxy chain, from the maintenance sweep (every minute; the gateway reads nothing unless a member is due):

- scheduled every `readIntervalHours` (6 h) with +-30 min jitter, shorter after prediction errors above 5 points (halves, floor 1 h), longer again after errors below 3 points (x1.5);
- once on joining a group, within the jitter window after the monthly reset, early when the estimate drifts by `driftShare`, reaches `confirmShare`, the soft line or the hard line;
- manual (Refresh) and when the Upstreams page is opened: at most every 10 minutes per member (a recent read is reused);
- never two reads of a member less than 1 hour apart (10 minutes for manual); a failed read counts and backs off 1 h, 2 h, 4 h up to the read interval.

Manual calibration (dashboard: Calibrate; `POST /api/upstreams/:id/quota/calibrate`) stores a `manual` read for accounts whose quota cannot be read.

## Dashboard

Upstreams page: a group is one card, dragged with the ungrouped upstreams. Each member shows used / entitlement and share, where the figure comes from and how old it is ("GitHub, live", "estimate · last read 2 h ago"), the projection, the lines, cut-off state, sessions, outside usage, last estimate error, read interval, `k` trend and the last entitlement change. The page reads quota live when opened and refreshes estimates every minute. The global banner shows cut-off members, groups that cannot take new sessions and groups in overage.

## Settings (per group)

| field | default | range |
| --- | --- | --- |
| `toleranceShare` | 0.05 | 0 to 0.5 |
| `softShare` | 0.9 | 0.5 to 1 (not above `hardShare`) |
| `hardShare` | 0.95 | 0.5 to 1 |
| `idleRebalanceMinutes` | 10 | 1 to 1440 |
| `migrateShare` | 0.1 | 0.01 to 1 |
| `burnHorizonHours` | 6 | 0 to 72 |
| `heavySessionUsdPerHour` | 5 | 0 to 10000 (0: off) |
| `migrateMinHours` | 12 | 0 to 720 |
| `exhaustedPolicy` | `stop` | `stop`, `overage` |
| `readIntervalHours` | 6 | 1 to 48 |
| `confirmShare` | 0.9 | 0.5 to 1 |
| `driftShare` | 0.1 | 0.01 to 1 |
| `sessionIdleHours` | 24 | 1 to 720 |

## API (session, owner only; admins see all)

`GET/POST /api/upstream-groups`, `PATCH/DELETE /api/upstream-groups/:id`, `GET /api/upstream-groups/:id/status`, `GET /api/upstream-groups/alerts`, `PUT /api/upstreams/:id/group`, `POST /api/upstreams/:id/quota/refresh`, `POST /api/upstreams/:id/quota/calibrate`.

## Storage and retention

Tables: `upstream_groups`, `upstreams.group_id`, `session_assignments`, `quota_reads`, `upstream_quota_state`, `upstream_cost_buckets` (migration 0028). Gateway cost is recorded for group members only, in the background, next to the usage record. Maintenance deletes idle assignments, reads older than 90 days, cost buckets older than 10 days and rows of deleted groups or upstreams.

## Known limits and risks

- Estimates between reads miss usage outside the gateway; confirming reads at the soft and hard lines limit the effect.
- An affinity-bound session that runs for days stays on its member until the hard line cuts it off.
- No failover to another member on a 429 or quota error before output (phase 2). Groups of non-Copilot upstreams are out of scope.
- Pooling accounts that belong to different people may conflict with GitHub's terms; Business/Enterprise accounts draw from an organisation's pool and should normally stay out of groups.
- Findings of the first implementation task (which snapshot reflects AI Credits, its unit, the reset field) are in the comment at the top of `packages/gateway/src/quota-balance/snapshot.ts`.
```

- [ ] **Step 2: Check the numbers against the code**

Run: `bun test packages/gateway/tests/quota-defaults-parity.test.ts`
Expected: PASS. Compare the settings table with `DEFAULT_GROUP_SETTINGS` and `GROUP_SETTINGS_LIMITS` in `packages/gateway/src/repo/quota-balance.ts` by eye; fix the document, not the code.

- [ ] **Step 3: Commit**

```bash
git add docs/upstream-quota-balancing-v1.md
git commit -m "docs(quota-balance): operator reference" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 21: End-to-end through the real app with two fake Copilot members and a fake quota endpoint

The real Hono app on SQLite, real API-key and session auth, two Copilot upstream rows whose GitHub and Copilot endpoints are a fake `fetch`, the real reader, selection, cut-off and protection, with injected clocks (no timers, no background executor).

**Files:**
- Create: `packages/gateway/tests/quota-balance-e2e.test.ts`

- [ ] **Step 1: Write the test**

```ts
/**
 * Upstream quota balancing end to end: the real app on SQLite, two Copilot members behind a fake GitHub / Copilot, real key and session auth,
 * the real reader, selection, cut-off and protection, injected clocks (no timers, no background executor).
 */
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { BunSqliteRepo } from "@vibe-llm/platform-bun/src/bun-sqlite-repo.ts"
import { __resetPlatformForTests, initBackground, initEnv, initRuntimeLocation } from "@vibe-core/platform"
import { app } from "../src/app"
import { initRepo } from "../src/repo/index"
import { listUpstreamModels } from "../src/data-plane/providers/registry"
import { ProtectionRuntime, setProtectionForTests } from "../src/protection/runtime"
import { QuotaBalance, setQuotaBalanceForTests, setQuotaFetcherFactory } from "../src/quota-balance/runtime"
import { sweepQuotaBalance } from "../src/quota-balance/sweep"
import type { ApiKeyId, SessionToken, UserId } from "../src/repo/branded-ids"

const OWNER = "user_e2e_qb" as UserId
const SESSION = "ses_e2e_qb"
const KEY = "key_e2e_qb"
const SECRET = "fake_e2e_qb_secret"
const ENV = { SERVER_SECRET: "e2e-qb" }
const TOKENS = { up_test_ma: "fake_github_token_a", up_test_mb: "fake_github_token_b" } as const
const MEMBER_OF = Object.fromEntries(Object.entries(TOKENS).map(([id, token]) => [`cptoken_${token}`, id])) as Record<string, string>
const originalFetch = globalThis.fetch

let db: Database
let repo: BunSqliteRepo
let qb: QuotaBalance
let clock: { now: number }
let pending: Array<Promise<unknown>>
let quota: Record<string, { entitlement: number; remaining: number }>
let served: string[]
let userCalls: number

const model = (id: string, type: string) => ({
  id, object: "model", name: id, vendor: "openai", version: id, model_picker_enabled: true, preview: false,
  capabilities: { family: "openai", limits: { max_context_window_tokens: 128000, max_output_tokens: 4096 }, object: "model_capabilities", supports: {}, tokenizer: "cl100k", type },
})

beforeEach(async () => {
  __resetPlatformForTests()
  initEnv(() => "")
  initRuntimeLocation("bun")
  initBackground({ waitUntil: () => {} })
  db = new Database(":memory:")
  repo = new BunSqliteRepo(db)
  initRepo(repo)
  const stamp = new Date().toISOString()
  await repo.users.create({ id: OWNER, name: "owner", email: "owner@example.invalid", disabled: false, createdAt: stamp })
  await repo.sessions.create({ token: SESSION as SessionToken, userId: OWNER, createdAt: stamp, authenticatedAt: Date.now(), expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
  await repo.apiKeys.save({ id: KEY as ApiKeyId, ownerId: OWNER, name: KEY, key: SECRET, createdAt: stamp, modelMappingsEnabled: false, modelMappings: [] })
  for (const [index, [id, token]] of Object.entries(TOKENS).entries()) {
    await repo.upstreams.save({ id, ownerId: OWNER, provider: "copilot", name: id, enabled: true, sortOrder: index,
      config: { githubToken: token, accountType: "individual", user: { id: index + 1, login: `acct${index}` } },
      flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], state: null, createdAt: stamp, updatedAt: stamp })
  }
  quota = { [TOKENS.up_test_ma]: { entitlement: 1000, remaining: 800 }, [TOKENS.up_test_mb]: { entitlement: 1000, remaining: 400 } }
  served = []
  userCalls = 0
  pending = []
  clock = { now: Date.UTC(2026, 10, 22, 12, 0, 0) }
  const protection = new ProtectionRuntime({ repo: () => repo, now: () => clock.now, schedule: work => { pending.push(work.catch(() => {})) }, cacheTtlMs: 0, evalIntervalMs: 0 })
  setProtectionForTests(protection)
  qb = new QuotaBalance({ repo: () => repo, now: () => clock.now, schedule: work => { pending.push(work.catch(() => {})) }, random: () => 0.5 }, { protection: () => protection })
  // Cost-triggered evaluation is covered by its unit tests; here the reads are driven explicitly (Refresh and the sweep) so the clock stays deterministic.
  qb.reader.evaluateSoon = async () => {}
  setQuotaBalanceForTests(qb)
  const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    const url = new URL(req.url)
    const auth = req.headers.get("authorization") ?? ""
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/copilot_internal/v2/token")) {
      return Response.json({ token: `cptoken_${auth.replace(/^token /, "")}`, expires_at: Math.floor(Date.now() / 1000) + 3600 })
    }
    if (url.hostname === "api.github.com" && url.pathname.endsWith("/copilot_internal/user")) {
      userCalls++
      const q = quota[auth.replace(/^token /, "")]!
      return Response.json({ quota_snapshots: { premium_interactions: { entitlement: q.entitlement, remaining: q.remaining, unlimited: false } } })
    }
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [model("gpt-4o-mini", "chat"), model("text-embedding-3-small", "embedding")] })
    if (url.pathname.endsWith("/chat/completions")) {
      served.push(MEMBER_OF[auth.replace(/^Bearer /, "")] ?? "unknown")
      return Response.json({ id: "c1", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    }
    if (url.pathname.endsWith("/embeddings")) {
      served.push(MEMBER_OF[auth.replace(/^Bearer /, "")] ?? "unknown")
      return Response.json({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.1, 0.2] }], model: "text-embedding-3-small", usage: { prompt_tokens: 3, total_tokens: 3 } })
    }
    return originalFetch(input as never, init)
  }) as typeof fetch
  globalThis.fetch = fake
  setQuotaFetcherFactory(async () => fake)
  await listUpstreamModels()
})
afterEach(() => { globalThis.fetch = originalFetch; setQuotaBalanceForTests(null); setProtectionForTests(null); setQuotaFetcherFactory(async () => fetch); db.close(); __resetPlatformForTests() })

const idle = async () => { while (pending.length) await Promise.all(pending.splice(0)) }
const session = (path: string, method = "GET", body?: unknown) => app.request(`http://localhost${path}`, {
  method, headers: { cookie: `session_token=${SESSION}`, origin: "http://localhost", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}, ENV)
const json = async (response: Response) => (await response.json()) as any
async function chat(sessionId: string, modelId = "gpt-4o-mini") {
  const before = served.length
  const response = await app.request("/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": SECRET },
    body: JSON.stringify({ model: modelId, prompt_cache_key: sessionId, messages: [{ role: "user", content: "hello" }] }),
  }, ENV)
  const body = await response.text()
  await idle()
  return { status: response.status, headers: response.headers, body, member: served.length > before ? served.at(-1)! : null }
}
/** Advances the injected clock (70 minutes by default, past every floor) and asks the API for a live read of the member. */
const refresh = async (id: string, advanceMs = 70 * 60_000) => { clock.now += advanceMs; return json(await session(`/api/upstreams/${id}/quota/refresh`, "POST")) }
const setQuota = (id: keyof typeof TOKENS, usedShare: number, entitlement = 1000) => { quota[TOKENS[id]] = { entitlement, remaining: Math.round(entitlement * (1 - usedShare)) } }
const status = async (groupId: string) => json(await session(`/api/upstream-groups/${groupId}/status`))
const alerts = async () => (await json(await session("/api/upstream-groups/alerts"))).alerts

test("balancing by session across two members: sticky sessions, outside usage, the soft line, exhaustion, overage, the hard line, recovery, entitlement change, monthly reset", async () => {
  // Setup through the API: a group whose idle time is long enough that sessions never count as idle between the clock jumps below.
  const { group } = await json(await session("/api/upstream-groups", "POST", { name: "Pool", settings: { idleRebalanceMinutes: 600 } }))
  for (const id of Object.keys(TOKENS)) expect((await session(`/api/upstreams/${id}/group`, "PUT", { groupId: group.id })).status).toBe(200)
  setQuota("up_test_ma", 0.2); setQuota("up_test_mb", 0.6)
  expect((await refresh("up_test_ma", 0)).status).toBe("read")
  expect((await refresh("up_test_mb", 0)).status).toBe("read")
  expect(userCalls).toBe(2)
  let s = await status(group.id)
  expect(s.state).toBe("normal")
  expect(s.members.map((m: any) => [m.upstreamId, m.usedShare, m.eligibility.eligible])).toEqual([["up_test_ma", 0.2, true], ["up_test_mb", 0.6, true]])

  // 1. A new session goes to the member with the lowest projected share and stays there; the assignment is stored.
  expect((await chat("conv-x")).member).toBe("up_test_ma")
  expect((await chat("conv-x")).member).toBe("up_test_ma")
  expect(db.query("SELECT upstream_id FROM session_assignments").all()).toEqual([{ upstream_id: "up_test_ma" }])
  expect((await status(group.id)).members[0].activeSessions).toBe(1)

  // 2. A jumps from 20 % to 62 % with no gateway traffic to explain it: outside usage. Its projection rises, new sessions go to B, the running session stays.
  setQuota("up_test_ma", 0.62); setQuota("up_test_mb", 0.6)
  await refresh("up_test_ma"); await refresh("up_test_mb", 0)
  expect((await chat("conv-y")).member).toBe("up_test_mb")
  expect((await chat("conv-y")).member).toBe("up_test_mb")
  expect((await chat("conv-x")).member).toBe("up_test_ma")
  s = await status(group.id)
  expect(s.members[0].outsideRate).toBeGreaterThan(0.05)

  // 3. A reaches the soft line: new sessions avoid it, the running session continues, pinned requests and embeddings behave.
  setQuota("up_test_ma", 0.93)
  await refresh("up_test_ma")
  for (const id of ["conv-z1", "conv-z2", "conv-z3"]) expect((await chat(id)).member).toBe("up_test_mb")
  expect((await chat("conv-x")).member).toBe("up_test_ma")
  expect((await chat("conv-pin", "up_test_ma/gpt-4o-mini")).member).toBe("up_test_ma")
  s = await status(group.id)
  expect(s.members[0].eligibility).toEqual({ eligible: false, reason: "soft_line" })
  const embeddings = await app.request("/v1/embeddings", { method: "POST", headers: { "content-type": "application/json", "x-api-key": SECRET }, body: JSON.stringify({ model: "text-embedding-3-small", input: "x" }) }, ENV)
  expect(embeddings.status).toBe(200)
  expect(served.at(-1)).toBe("up_test_mb")

  // 4. B reaches the soft line too: nobody can take a new session (503, nothing behind the group); running sessions continue.
  setQuota("up_test_mb", 0.93)
  await refresh("up_test_mb")
  const stopped = await chat("conv-new")
  expect(stopped.status).toBe(503)
  expect(Number(stopped.headers.get("retry-after"))).toBeGreaterThan(0)
  expect(JSON.parse(stopped.body)).toMatchObject({ error: { code: "group_quota_exhausted" } })
  expect((await chat("conv-x")).member).toBe("up_test_ma")
  expect((await chat("conv-y")).member).toBe("up_test_mb")
  s = await status(group.id)
  expect(s.state).toBe("stopped")
  expect(await alerts()).toEqual([{ kind: "stopped", groupId: group.id, groupName: "Pool" }])

  // 5. The overage policy lets new sessions use members above the soft line, and the dashboard warns.
  expect((await session(`/api/upstream-groups/${group.id}`, "PATCH", { settings: { exhaustedPolicy: "overage" } })).status).toBe(200)
  await qb.directory.get({ fresh: true })
  expect((await chat("conv-over")).status).toBe(200)
  expect(await alerts()).toEqual([{ kind: "overage", groupId: group.id, groupName: "Pool" }])
  await session(`/api/upstream-groups/${group.id}`, "PATCH", { settings: { exhaustedPolicy: "stop" } })
  await qb.directory.get({ fresh: true })

  // 6. A reaches the hard line: cut off until the monthly reset; its session is served by B (the only member left); the pause is listed for the banner.
  setQuota("up_test_ma", 0.97)
  expect((await refresh("up_test_ma")).status).toBe("read")
  const active = (await json(await session("/api/protection/active"))).pauses as any[]
  expect(active).toHaveLength(1)
  expect(active[0]).toMatchObject({ targetId: "up_test_ma", mode: "pause", endsAt: Date.UTC(2026, 11, 1), reason: { trigger: "quota", quota: { share: 0.97, provisional: false, groupName: "Pool" } } })
  expect((await chat("conv-x")).member).toBe("up_test_mb")
  expect((await chat("conv-w")).member).toBe("up_test_mb")

  // 7. The owner resumes the pause: it is lifted at once.
  expect((await session(`/api/protection/pauses/${active[0].id}/resume`, "POST")).status).toBe(200)
  expect((await json(await session("/api/protection/active"))).pauses).toEqual([])

  // 8. An entitlement change is recorded and shown; the next read is early.
  setQuota("up_test_mb", 0.4, 2000)
  await refresh("up_test_mb")
  s = await status(group.id)
  const b = s.members.find((m: any) => m.upstreamId === "up_test_mb")
  expect(b.entitlementChange).toMatchObject({ from: 1000, to: 2000 })
  expect(b.intervalHours).toBe(1)
  expect(s.attention.map((x: any) => x.kind)).toContain("entitlement_changed")

  // 9. The monthly reset: both members are read within the jitter window and take sessions again.
  clock.now = Date.UTC(2026, 11, 1, 0, 40)
  setQuota("up_test_ma", 0.02); setQuota("up_test_mb", 0.03, 2000)
  for (let i = 0; i < 3; i++) { await sweepQuotaBalance(clock.now, qb); clock.now += 60_000 }
  s = await status(group.id)
  expect(s.members.map((m: any) => m.eligibility.eligible)).toEqual([true, true])
  expect(s.state).toBe("normal")
  expect((await chat("conv-december")).member).not.toBeNull()
})

test("an upstream behind the group serves when no member can take a new session", async () => {
  const stamp = new Date().toISOString()
  await repo.upstreams.save({ id: "up_test_tail", ownerId: OWNER, provider: "custom", name: "Tail", enabled: true, sortOrder: 50,
    config: { name: "Tail", baseUrl: "https://tail.invalid", authStyle: "none", endpoints: ["chat_completions"], models: ["gpt-4o-mini"] },
    flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [{ id: "direct_fetch" }], state: null, createdAt: stamp, updatedAt: stamp })
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input as string, init)
    if (req.url.startsWith("https://tail.invalid")) {
      served.push("up_test_tail")
      return Response.json({ id: "t1", object: "chat.completion", created: 1, model: "gpt-4o-mini", choices: [{ index: 0, message: { role: "assistant", content: "tail" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })
    }
    return previous(input as never, init)
  }) as typeof fetch
  await listUpstreamModels()
  // The group goes before the tail (sort order 5 < 50).
  const { group } = await json(await session("/api/upstream-groups", "POST", { name: "Pool", sortOrder: 5 }))
  for (const id of Object.keys(TOKENS)) await session(`/api/upstreams/${id}/group`, "PUT", { groupId: group.id })
  setQuota("up_test_ma", 0.2); setQuota("up_test_mb", 0.6)
  await refresh("up_test_ma", 0); await refresh("up_test_mb", 0)
  expect((await chat("conv-before")).member).toBe("up_test_ma") // the group is first and serves
  setQuota("up_test_ma", 0.93); setQuota("up_test_mb", 0.94)
  await refresh("up_test_ma"); await refresh("up_test_mb", 0)
  const out = await chat("conv-tail")
  expect(out.status).toBe(200)
  expect(out.member).toBe("up_test_tail") // the group is skipped, matching continues with the next item
})
```

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/tests/quota-balance-e2e.test.ts`
Expected: PASS. If a step fails, the failing `expect` names the phase. Typical adjustments that are fixture issues, not logic bugs: the Copilot catalog needs another model field (copy `stubModel` from `chat.e2e.test.ts`); the `refresh` helper advances the injected clock by 70 minutes unless told otherwise, so the 10 minute floor never blocks a deliberate read; `served` is filled by the fake Copilot `/chat/completions` and `/embeddings` handlers from the bearer token.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/tests/quota-balance-e2e.test.ts
git commit -m "test(quota-balance): end to end through the real app with two fake Copilot members" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 22: Final verification

**Files:** none (fixes found here go into the task that owns the code).

- [ ] **Step 1: Typecheck and lint everything that changed**

```bash
bun run --filter '@vibe-llm/gateway' typecheck
bun run --filter '@vibe-llm/dashboard' typecheck
bunx eslint packages/gateway/src/quota-balance packages/gateway/src/control-plane/quota-balance packages/gateway/src/repo packages/gateway/src/data-plane apps/dashboard/src/tabs/upstreams apps/dashboard/src/state apps/dashboard/src/components scripts/quota-spike.ts scripts/quota-spike-redact.ts
```
Expected: no errors (the import-boundary rule must stay green: nothing under `data-plane/` imports `control-plane/`, nothing under `repo/` imports `quota-balance/`).

- [ ] **Step 2: Run the tests per package directory (the whole repository at once is killed for memory)**

```bash
(cd packages/gateway && bun test) 2>&1 | tail -n 60
(cd apps/dashboard && bun test) 2>&1 | tail -n 30
(cd apps/platform-bun && bun test) 2>&1 | tail -n 20
(cd packages/protocols-llm && bun test) 2>&1 | tail -n 10
(cd packages/provider-copilot && bun test) 2>&1 | tail -n 10
```
Expected: everything passes except the known baseline failures that are not ours: respond-json "JSON terminal/fallback preserves serialization errors" (2), "Custom caller disconnect closes the real upstream localhost socket", and the 8 `docs/superpowers/research` harness tests. Any other failure is ours: fix it in the owning task and rerun that file first, then the package.

- [ ] **Step 3: The balancing-specific files once more, together**

```bash
bun test packages/gateway/tests/quota-snapshot.test.ts packages/gateway/tests/quota-spike-redact.test.ts packages/gateway/tests/upstream-quota-balancing-migration.test.ts packages/gateway/tests/migrations.test.ts packages/gateway/tests/quota-balance-repo.sqlite.test.ts packages/gateway/tests/quota-balance-repo.d1.test.ts packages/gateway/tests/quota-time-settings.test.ts packages/gateway/tests/quota-session-key.test.ts packages/gateway/tests/quota-estimator.test.ts packages/gateway/tests/quota-read-schedule.test.ts packages/gateway/tests/quota-selection.test.ts packages/gateway/tests/quota-caches.test.ts packages/gateway/tests/quota-cutoff.test.ts packages/gateway/tests/quota-reader.test.ts packages/gateway/tests/quota-cost-tracker.test.ts packages/gateway/tests/quota-sweep.test.ts packages/gateway/tests/quota-retention.test.ts packages/gateway/tests/quota-ordering.test.ts packages/gateway/tests/quota-balance.test.ts packages/gateway/tests/quota-balance-session.test.ts packages/gateway/tests/quota-routing.sqlite.test.ts packages/gateway/tests/quota-api.test.ts packages/gateway/tests/quota-defaults-parity.test.ts packages/gateway/tests/quota-balance-e2e.test.ts packages/gateway/tests/i18n-keys.test.ts
```
Expected: PASS.

- [ ] **Step 4: Hygiene**

```bash
git status --short
git diff --stat main...HEAD | tail -n 5
grep -rnE "(ghp_|gho_|github_pat_)[A-Za-z0-9]{10,}" packages apps scripts docs --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' | grep -v node_modules | head
```
Expected: `git status` lists only files from this plan plus the untracked `docs/loki-safety-check-2026-11-14.md` (never staged); the grep prints nothing (fixtures contain only `fake_*` placeholders and `<redacted:N>`).

- [ ] **Step 5: Manual smoke on a local gateway (optional, needs the owner's accounts)**

With a local `bun` gateway and two real Copilot accounts: create a group in the dashboard, add both accounts, open the Upstreams page and check that each member shows used / entitlement and a source of "GitHub, live"; reload within ten minutes and check that no second GitHub read happens (the member says "read ... reused" on Refresh); send a few Claude Code or Codex sessions and check that each session sticks to one member (`session_assignments`) and that new sessions favour the less used account; lower `softShare` for a moment to see "No member can take new sessions" in the banner and the 503 from a client.

- [ ] **Step 6: Commit any verification fixes**

```bash
git status --short
git add <files fixed in this step>
git commit -m "fix(quota-balance): final verification fixes" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```
(Skip when nothing needed fixing.)

---

## Self-review against the spec

| Spec section | Task |
| --- | --- |
| Groups of Copilot upstreams, one group each, ordered as one item, dynamic members, skipped when unusable | 3 (membership, group sort order), 13 (ordering, balancer), 14 (chat flows, `resolveBinding`), 15 (owner rules, Copilot only) |
| Balance by session (prompt_cache_key before stripping, Claude Code, Codex, fallback hash) | 4, 14 (handlers, WebSocket turn) |
| Lowest projected share, tolerance band, rendezvous hash, heavy sessions, soft line, sticky, idle rebalance, forced move, affinity bypass, single member, pins, whitelist | 7, 13, 14 |
| Percentages only; entitlement changes (estimator, scheduler, UI) | 5 (shares, `learn` change handling), 6 (interval reset is exercised by the reader), 10 (reader test), 15 (status DTO), 16-17 (text and row), 21 (e2e) |
| Real quota read rarely: scheduler, jitter, floors, backoff, join/monthly/manual/page open, early triggers | 6, 10, 12, 16 (page-open controller), 17 |
| Adaptive estimator: k low quantile, o, error, conservative bias, reset, unlimited | 5, 8 (views), 10 |
| Hard line through a protection pause, provisional cut-off, recovery, owner resume | 9, 10, 21 |
| Exhaustion: `stop` 503 with Retry-After and group name for the owner, `overage` | 13, 14, 15 (alerts), 21 |
| Cost recording for group members, background, session spend | 3 (counters), 11 |
| Maintenance sweep and retention | 12 |
| API | 15 |
| Dashboard: group card, reorder as a unit, live quota, refresh, calibrate, settings, banner, EN and ZH, local time, text-xs | 16-19 |
| Testing list (repo contract on SQLite and D1, API owner-only, dashboard rendering, end to end) | 3, 15, 17-19, 21 |
| First task: capture a quota response, confirm the snapshot, unit and reset | 1 |
| Docs | 20 |
