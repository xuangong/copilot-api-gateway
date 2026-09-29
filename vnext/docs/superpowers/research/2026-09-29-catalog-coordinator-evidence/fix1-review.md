### Finding Verdicts

- **I1 — Delayed automatic acquisition refetches an intervening fresh publication — ADDRESSED.** `vnext/packages/gateway/src/data-plane/providers/catalog-coordinator.ts:200-204` supplies the observed raw publication counter for automatic and background acquisition. `vnext/packages/gateway/src/repo/shared/catalogs.ts:135` validates it, and `:157` compares it inside the conditional SQL UPDATE, alongside the existing identity/lease/backoff fences. Once A publishes, B's old counter cannot acquire; the existing null-acquisition path rereads SQL. Explicit refresh omits the optional predicate and retains intentional refresh behavior.
  - `vnext/packages/gateway/src/repo/shared/catalogs.ts:121` exposes the raw counter even when the snapshot is obsolete or invalid, so the CAS does not confuse a null accepted snapshot with an absent SQL row. `tests/catalog-repo.sqlite.test.ts:413-416` exercises invalid snapshot/version 1, rejects expected version 0, and repairs to version 2.
  - `vnext/packages/gateway/tests/catalog-coordinator.sqlite.test.ts:227-265` uses independent real repositories and an acquisition barrier for cold, cold with a failing redundant discovery, stale background, and explicit refresh. Assertions check one automatic discovery/publication, accepted winner data, and released lease; the explicit case deliberately checks two discoveries.

- **Root CI legacy fixture incompatibility — ADDRESSED within the supplied fix scope.** The 34 route/e2e files explicitly adopt the new SQL-backed test helper; the fix does not introduce a production fallback or fabricate catalog success. `vnext/packages/gateway/tests/helpers/catalog-test-repo.ts:24-44` mirrors changed source rows into migrated SQLite and removes missing rows; unchanged source rows do not overwrite SQL credential rotation. `:47-55` forwards the original list arguments and preserves source mutation methods/spies. `:61-75` delegates catalog operations to the actual SQL repository. Noncatalog services remain the original fixture members through the proxy at `:77-83`.
  - The four new `ownerId: OWNER` fields align rows with their preexisting source owner filters, verified at `tests/data-plane/codex/prefix-mount.test.ts:61`, `tests/data-plane/dmr/auth-binding.test.ts:63`, `tests/data-plane/dmr/prefix-mount.test.ts:57`, and `tests/data-plane/ollama/chat.test.ts:63`. They do not relax ownership filtering.
  - `tests/helpers/catalog-test-repo.ts:87-90` supplies an explicit synthetic stored-account token exchange only on the token endpoint. Inference capture handlers and the existing assertions are retained. The two Responses files add the required `object: 'list'` to their network catalog fixtures; their history, retention, authorization, response-shape, and forwarding assertions are unchanged in the fix diff.

### New Breakage in the Fix Diff

- **Critical / Important: None identified.** The publication CAS is additive and optional for explicit callers; it preserves generation, incarnation, terminal attribution, and retry predicates. The fixture adapter exercises real catalog SQL without changing production behavior or weakening existing assertions.
- **Minor: No new defect identified.** Read `task-C02-activation-fix1-lint.log`: zero errors and four acknowledged inherited warnings (`dispatch.test.ts:73`, `:206`, `responses-snapshot-id-roundtrip.test.ts:43`, and `http/src/fetch-retry.ts:103`). The fix does not change those warning-producing lines; the prior non-pristine baseline observation remains nonblocking.

### Out-of-Scope Observations

- None. Unchanged activation/foundation/provider behavior was not re-reviewed. Root owns integration and release acceptance; no merge/deployment conclusion is made here.

### Checks and Evidence Boundaries

- Read the 1839-line fix patch once in four sequential segments, the fix1 report, updated overall report, and the scoped re-review instructions. The review covers the 40 changed/added paths relative to the original freeze; it does not repeat the initial activation review.
- All **59 current product SHA-256 values match** `task-C02-activation-frozen-sha256.json` in `reference-adoption-verify`.
- Read preserved execution output rather than rerunning tests: `task-C02-activation-fix1-race-final.log` shows **45 pass / 0 fail / 1223 assertions**; `task-C02-activation-fix1-full-tests.log` shows **4560 pass / 1 skip / 0 fail**; final gateway/Bun/Cloudflare/http typechecks each exit 0. The writer correctly distinguishes the local suite containing protected user work from clean verification and records the final subsequent narrow changes.
- Root separately reported frozen clean `ci:local` exit 0 with **4514 pass / 1 skip / 0 fail**, purity/types/lint/build/dry-run passing and 35 inherited lint warnings. Root also reported actual workerd/D1 delayed acquisition with the second-failure scenario now returning one discovery and the same publication, default timeout at 20002 ms, and shared-D1/two-isolate real HTTP acceptance passing. Those are attributed root results, not reruns by this reviewer.
- No test or runtime probe was rerun during this fix review. No product, index, branch, or commit mutation and no subagents; only this scratch report was written.

### Verdict

**Fix round: All findings addressed, no new Critical/Important breakage.**

**Spec compliance: Approved for the scoped fix.** I1's automatic/background race is closed atomically, explicit semantics remain intact, and the legacy route fixtures use real SQL catalog identities while preserving their assertions and filters.

**Code quality: Approved.** The fix uses the existing monotonic publication sequence and a small optional repository predicate; tests reproduce the original interleaving and its failure consequence without replacing database behavior with success mocks.
