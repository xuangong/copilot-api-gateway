### Spec Compliance

- ❌ Issues found: the automatic cold/stale coordination path can fetch again after a concurrent coordinator already published a fresh result. This violates the requested one-fetch behavior and can make a cold caller fail despite a newly available accepted snapshot. See Important I1, `vnext/packages/gateway/src/data-plane/providers/catalog-coordinator.ts:200`.
- ✅ Reviewed the activation package against the terminal-outcome and maintenance rulings. The scope is the 24 frozen paths over accepted foundation `976ddac4786766cb04764673fbbdab86b39793b1`; all 24 SHA-256 values match `task-C02-activation-frozen-sha256.json`. Legacy KV catalogs are excluded by registry revision 5 (`registry.ts:180`).
- ⚠️ Frozen full-CI and actual workerd/D1/shared-D1 HTTP acceptance remain root gates. Root reported `/tmp/vnext-c02-activation-clean-ci.log` exit 1 with 4320 pass, 1 skip, and 190 fail while this review was finishing. Those failures are not diagnosed or attributed here. Mutable runtime claims in the implementation report are not treated as final acceptance.

### Strengths

- `vnext/packages/gateway/src/repo/shared/catalogs.ts:165` and `:177`: success/failure terminal tokens are updated in the same conditional SQL statement as publication/failure and lease release. The existing `OWNED` fence at `:16` remains intact. `catalog-coordinator.ts:173` requires the joined token and matching publication version; overwrite returns `superseded-unavailable`. Real independent-handle tests cover A-failure/B-success between polls (`tests/catalog-coordinator.sqlite.test.ts:101`).
- `vnext/packages/gateway/src/data-plane/providers/catalog-coordinator.ts:87`, `:135`, and `:211`: a single deadline covers observation, acquisition, discovery, publication waits, and polling; stale background work drops the served request signal. Discovery is raced against cancellation and checks the deadline before publication. SQL failure retention and abort-ignoring result rejection are represented by real SQLite tests.
- `vnext/packages/gateway/src/data-plane/providers/catalog-coordinator.ts:102` and `:110`: retained entries require target identity, current requested generation, and visibility; filters are taken from the authorized request row. Installation orders observation tickets/generation/publication versions and uses a bounded global eviction fence. The old-incarnation-after-512-evictions case is exercised at `tests/catalog-coordinator.sqlite.test.ts:145`; the detached background set is separately bounded at `:194`.
- `vnext/packages/gateway/src/data-plane/providers/registry.ts:189`, `:200`, `:307`, and `:318`: discovery and dispatch rebuild their fetchers from the accepted authoritative row/proxies, use separate providers, and seed the dispatch catalog. Request-token fallback is excluded from stored catalog publication (`:300`). The approved lifetime seam composes request and transport signals before retries (`vnext/packages/http/src/fetch-retry.ts:53`).
- `vnext/packages/gateway/src/control-plane/upstreams/routes.ts:614`: editor reads stay cache-only, explicit refresh uses the shared coordinator, disabled owned rows remain editable, and target changes return 404. Error categories are safe and existing snapshots survive failures.
- `vnext/packages/gateway/src/catalog-maintenance.ts:5` and `src/maintenance.ts:13`: destructive cleanup requires a valid explicit full revision inventory, is bounded to 128 rows/seven days, and retains every newer revision through `maximumRevision`. Missing/malformed policies are inert.

### Issues

#### Critical (Must Fix)

- None identified within this activation review.

#### Important (Should Fix)

- **I1 — A delayed automatic acquirer refetches a fresh catalog published after its observation.** `vnext/packages/gateway/src/data-plane/providers/catalog-coordinator.ts:200-202`, with SQL eligibility at `vnext/packages/gateway/src/repo/shared/catalogs.ts:143-157`. An automatic caller B reads an empty or stale observation and pauses before `tryAcquire`. Caller A acquires, discovers, and publishes, releasing its lease and resetting retry time. B then executes `tryAcquire`: generation/fingerprint still match and the lease is now absent, so it wins. The coordinator calls `discover` immediately without detecting the intervening publication. This causes a redundant upstream fetch and publication, and if that second discovery fails B throws `upstream_error` instead of returning A's already fresh accepted catalog. The same window applies to background stale refresh.
  - **Verified behavior:** one focused execution with two real Bun SQLite connections/repositories and an acquisition barrier produced `{"calls":2,"first":{"object":"list","data":[{"id":"fetch-1"}]},"second":{"object":"list","data":[{"id":"fetch-2"}]},"publicationVersion":2}`. The second-failure consequence follows directly from `discover`'s throw path at `catalog-coordinator.ts:218-224`; it was not a separate runtime test.
  - **Artifacts:** `task-C02-activation-acquire-race-repro.ts` preserves the reproduction; `task-C02-activation-acquire-race-repro.log` records the observed output. The focused command was run through Bun stdin; the saved equivalent script was not separately rerun.
  - **Correction:** couple automatic acquisition to the observed publication state, or implement a fenced post-acquisition fresh-result check/release before upstream discovery. Preserve explicit refresh's intentional bypass semantics. Add a real-repo regression with B blocked before acquisition and A completing publication before B resumes. The current held-winner test (`tests/catalog-coordinator.sqlite.test.ts:32`) does not cover this interleaving.

#### Minor (Nice to Have)

- `vnext/packages/http/src/fetch-retry.ts:103`: the implementation's focused lint log records the existing `preserve-caught-error` warning; root also identifies 35 inherited full-CI lint warnings. These are acknowledged baseline noise, not introduced activation defects and not a pristine-log claim. They do not change the verdict; the actual full-CI failures remain a separate unresolved gate.

### Focused Cross-Package Checks and Boundaries

- **Authoritative provider/transport risk:** read only the diff-cut-off `createProviderFromUpstream` and the fetcher initialization part of `listProviderBindings`; checked the unchanged Copilot/Custom/Codex/Claude plugin entry points and the relevant provider `getModels`/catalog hooks. They preserve the supplied fetcher and separate dispatch instance. The Copilot raw-model seeding path explains why splitting request-only discovery from dispatch does not immediately require a second fetch. No general provider/foundation audit was performed.
- **Retry lifetime risk:** the `fetchWithRetry` hunk ended inside the loop, so its remaining function was read to confirm composed cancellation covers both retry cleanup/backoff and the next HTTP attempt. No duplicate runtime cancellation suite was run.
- **SQL dependency coherence risk:** the shared repository `read` hunk omitted its middle, so that function's upstream/proxy/final-generation observation sequence was read. The activation adds terminal projection to the existing authoritative fence rather than replacing it. The accepted foundation's schema design was not reopened.
- **ALS/background and maintenance wiring risk:** checked unchanged `gateway/src/repo/index.ts:45-58`, `platform/src/background.ts:9-23`, and `platform/src/env.ts:6-12`; raw `getRepo` remains separate from pinned request views, and background execution is request scoped. Checked Bun `server.ts:13-25`, Cloudflare `worker.ts:7-14`, both bootstrap environment lookups, and Cloudflare `wrangler.jsonc:6`; the existing timer/scheduled handler reaches maintenance, optional environment policy is readable, and node compatibility is enabled. Runtime ALS/actual D1 evidence remains root-owned.
- **Verification performed:** read the supplied 2533-line context-10 patch once in sequential segments; checked all frozen hashes; executed only the new deterministic acquisition-race reproduction. No product/index/branch changes, commits, full suite, paid network calls, or subagents. Only this report and its scratch reproduction artifacts were written.

### Assessment

**Task quality: Needs fixes.**

**Reasoning:** SQL ownership, terminal attribution, cancellation boundaries, provider rebuilding, and opt-in maintenance are cohesive, but automatic acquisition does not account for a publication between observation and lease acquisition. Fix I1 and complete root's fresh CI/runtime gates before accepting the activation.
