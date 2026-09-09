# Shared configuration snapshots implementation plan

**Goal:** Reuse key, owner, upstream and proxy configuration across requests; eliminate configuration reads from warm inference dispatch.

**Approved design:** Conversation approval on 2026-09-09. Retain successful configuration/model snapshots; replace on successful refresh; share owner/upstream records across keys; bound growing caches; propagate configuration changes across isolates.

**Architecture:** Keep control-plane reads authoritative. Expose a data-plane repo view backed by one immutable configuration snapshot and indexes. Database triggers advance a configuration revision in the same transaction as a mutation. Local mutations invalidate immediately; active isolates check the revision in the background every 30 seconds. Authorization has a 120-second confirmation lease: after it elapses a request must refresh successfully or return 503. Missing entries are not cached separately. Model discovery retains its last successful catalog independently of configuration authorization.

**Tech stack:** Bun, TypeScript, SQLite/D1, Hono, Workers background execution.

## Work

- [x] Configuration cache: add real-SQLite tests for warm reuse across keys, local changes, remote deletion, refresh failure, concurrent invalidation and bounded authorization staleness. Implement snapshot indexes, revision migration, mutation hooks and cached data-plane repo accessor.
- [x] Dispatch: use cached configuration for auth, dump, quota configuration, provider visibility and proxy configuration; avoid eager unrelated Copilot authentication. Preserve authoritative control-plane writes and reads.
- [x] Providers: materialize only providers actually needed by dispatch/discovery; seed provider model state from known catalogs; refresh stale catalogs and raw variants in the background; preserve selected bindings across translation.
- [x] Verification: use full application requests with real SQLite and simulated upstream responses to assert zero warm pre-inference SQL/auxiliary HTTP, plus configuration rotation and owner isolation. Run typecheck, relevant tests and repository CI.

## Boundaries

Cold configuration loads, expired credentials, historical content and image misses may wait. Quota usage remains authoritative; disabled quota performs no usage reads. No new global quota semantics. Do not commit/push/deploy until requested. Preserve PRODUCT.md.

## Implemented behavior

- API key/user/upstream/proxy configuration is indexed in one shared snapshot. Each inference request pins a view; keys under the same owner reuse the same underlying owner/upstream records. Unknown keys allocate no negative entries.
- Session authentication caches only successful lookups, with an LRU limit of 512. Session mutations advance the database configuration revision; local logout invalidates immediately. Control-plane authentication remains authoritative, including management model routes.
- Migration `0010_configuration_revision.sql` adds revision triggers. Last-used/login timestamps and OAuth response quota telemetry do not advance the configuration generation. OAuth credentials, account health and all other state still do.
- Provider state writes refresh only the affected row. Concurrent updates use per-row markers; an observed owner/config/proxy-reference change invalidates the complete snapshot. Quota-only writes cannot starve configuration loading or cause model rediscovery. Remote quota changes are polled in the background on active provider reads every 30 seconds, without extending the authorization lease. Failed advisory reads retain the cached row.
- OAuth refresh-race recovery and explicit refresh use authoritative reads and update the cached row. CAS writes remain authoritative. Ordinary fresh credential reads use memory.
- Model catalogs use a hash of actual configuration, excluding quota snapshots and update timestamps. Existing catalogs seed provider instances. Catalog/raw-model/token/proxy-health caches have entry limits; in-flight tasks are removed on completion.
- Cloudflare background execution is scoped to each request with AsyncLocalStorage. Interleaved context behavior is tested under Bun; the Worker bundle is checked by Wrangler dry-run. No claim of a live workerd concurrency test.

## Verification evidence

- Real SQLite plus full gateway requests and simulated upstream HTTP: warmed Copilot Responses and Messages-to-Responses requests using two owner-shared keys reach inference with zero preceding SQL or auxiliary HTTP. An unselected account needing token renewal does not block the selected account.
- Real SQLite provider tests: Codex/Claude quota writes retain configuration and a nonempty model catalog without subsequent SQL or auxiliary HTTP; OAuth sibling rotation, concurrent state writes and remote proxy-reference consistency are covered.
- Snapshot tests cover local key rotation, remote revocation, bounded authorization lease, failed refresh retention, immutable request views, session eviction/logout, control-plane auth and the explicit development auth path.
- Full `bun run --cwd vnext ci:local`: 3,554 passing tests, 1 skipped, no failures; typecheck, lint (36 warnings, zero errors), dashboard build and Cloudflare dry-run pass. `git diff --check` passes.
- Release requires applying migration 0010 before the new Worker code. Implementation validation was completed before release. Commit, push and deployment to all three targets were subsequently authorized on 2026-09-09.
