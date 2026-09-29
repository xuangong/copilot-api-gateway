# C02 foundation review

## Spec compliance

- ✅ Spec compliant for the explicitly scoped **foundation**, based on the complete review patch against `a7c5adc039075871b3a86a7d94604f5639bc8a6b`. The new migration, discovery identity, authoritative repository, adapter wiring, import CAS seam and trigger-complete returned metadata are present. Evidence: `vnext/packages/gateway/migrations/0018_catalog_coordination.sql:1`, `vnext/packages/gateway/src/repo/catalogs.ts:57`, `vnext/packages/gateway/src/repo/shared/catalogs.ts:81`, `vnext/packages/gateway/src/repo/shared/repos.ts:620`, `vnext/packages/gateway/src/repo/shared/repos.ts:628`, `vnext/packages/gateway/src/repo/shared/repos.ts:1289`.
- ✅ Scope stays within the 12 frozen `vnext/` product paths. All 12 verification-worktree SHA256 values match `task-C02-foundation-frozen-sha256.json`; no historical migration, provider implementation, authorization route, Responses retention or usage accounting implementation appears in the patch. This is a task-scoped review, not independent verification of every unrelated protected dirty file.
- ⚠️ Actual workerd/D1 and full clean CI are root-owned gates. Adapter member wiring (`vnext/apps/platform-cloudflare/src/d1-repo.ts:193`, `vnext/apps/platform-cloudflare/src/d1-repo.ts:219`) and real SQLite coverage do not establish frozen workerd execution or deployed cross-isolate behavior. Do not substitute the report's attributed mutable-candidate probes for root's frozen results.

## Strengths

- Publication and failure share the exact current upstream incarnation/generation/owner/provider and unexpired random-token fence; each mutation releases the lease atomically with its result. `RETURNING` avoids trigger-inclusive affected-row ambiguity, and publication versions order equal-clock successes: `vnext/packages/gateway/src/repo/shared/catalogs.ts:14`, `vnext/packages/gateway/src/repo/shared/catalogs.ts:117`, `vnext/packages/gateway/src/repo/shared/catalogs.ts:146`, `vnext/packages/gateway/src/repo/shared/catalogs.ts:156`.
- Generation changes are narrowly separated from ordinary state and display writes; proxy transport dependencies advance affected upstreams, while explicit deletion cleanup avoids relying on foreign-key settings. The import statement advances generation exactly once and rejects concurrent credential-state changes: `vnext/packages/gateway/migrations/0018_catalog_coordination.sql:30`, `vnext/packages/gateway/migrations/0018_catalog_coordination.sql:49`, `vnext/packages/gateway/migrations/0018_catalog_coordination.sql:59`, `vnext/packages/gateway/src/repo/shared/repos.ts:628`.
- The read performs a bounded final generation/incarnation check after loading proxy dependencies. The hashed projection is deterministic, excludes mutable state, and explicitly documents its upstream-wide egress assumption. Maintenance requires the caller's full active-revision set and preserves live leases: `vnext/packages/gateway/src/repo/shared/catalogs.ts:81`, `vnext/packages/gateway/src/repo/catalogs.ts:76`, `vnext/packages/gateway/src/repo/shared/catalogs.ts:168`.
- Tests use separate SQLite handles and real migrations, with meaningful lease winner, takeover, same-timestamp recreation, database-clock, persisted failure, revision coexistence and state-CAS assertions. Examples: `vnext/packages/gateway/tests/catalog-repo.sqlite.test.ts:80`, `vnext/packages/gateway/tests/catalog-repo.sqlite.test.ts:151`, `vnext/packages/gateway/tests/catalog-repo.sqlite.test.ts:187`, `vnext/packages/gateway/tests/catalog-repo.sqlite.test.ts:218`, `vnext/packages/gateway/tests/catalog-repo.sqlite.test.ts:390`.

## Issues

### Critical

- None found in this package.

### Important

- None found in this package.

### Minor

- **Expected failure diagnostics remain noisy in the supplied passing logs.** `task-C02-foundation-focused-tests.log:88` and `task-C02-foundation-routing-tests.log:82` print expected configuration/catalog outage warnings; additional synthetic discovery failures appear at `task-C02-foundation-routing-tests.log:138`. These are identifiable existing failure-path tests, not evidence of a foundation defect or real credential leakage, but the evidence is not pristine. When those tests are next edited, capture/assert the expected diagnostics locally and restore the logger afterward, retaining unexpected diagnostics. This does not require broadening this foundation patch into unchanged test cleanup.

## Focused outside-diff checks

- **Risk: a pinned configuration view could memoize the new SQL authority.** Checked only `ConfigurationCache.createView` (`vnext/packages/gateway/src/repo/configuration-cache.ts:221`): unoverridden members pass through the raw repo; `catalogs` is not overlaid. The new test at `vnext/packages/gateway/tests/catalog-repo.sqlite.test.ts:234` verifies an old pinned upstream alongside the current SQL catalog observation.
- **Risk: new stored generation metadata could escape through the existing safe DTO.** Checked the upstream route's serializer reference and `vnext/packages/gateway/src/control-plane/upstreams/public-dto.ts:89`: serialization remains an explicit field whitelist, excluding state, incarnation and catalog generation.
- **Risk: adding a stored field could change the still-active registry cache identity before activation.** Checked `vnext/packages/gateway/src/repo/upstream-configuration.ts:14` and `vnext/packages/gateway/src/data-plane/providers/registry.ts:207`: the existing broad hash includes the new generation. Thus config edit/revert intentionally cannot resurrect the old catalog; the changed regression assertion at `vnext/packages/gateway/tests/control-plane-upstreams.test.ts:503` matches this behavior. SQL coordination itself remains unactivated.
- Read the complete supplied patch once, then mechanically mapped reference line numbers. Read the existing evidence logs instead of rerunning suites: focused results are **150 pass / 0 fail / 624 assertions** (`task-C02-foundation-focused-tests.log:184`); routing results are **104 pass / 0 fail / 293 assertions** (`task-C02-foundation-routing-tests.log:201`). No additional tests, network calls, Git operations or product edits were performed during review.

## Concrete cross-package verification boundaries

- **Root frozen adapter gate:** verify actual D1Repo RETURNING behavior with the migration triggers, ownerless identities, proxy-read contention, expiry/takeover, stale publish/failure and maintenance against the frozen hashes; retain clean `ci:local`/Wrangler dry-run evidence. The relevant SQL seams are `vnext/packages/gateway/src/repo/shared/catalogs.ts:117`, `vnext/packages/gateway/src/repo/shared/catalogs.ts:146`, `vnext/packages/gateway/src/repo/shared/catalogs.ts:168`. These checks belong to root's already-running gate, not another reviewer suite.
- **Registry/C03 activation:** `CatalogObservation` and acquisition outcomes provide the seam (`vnext/packages/gateway/src/repo/catalogs.ts:47`, `vnext/packages/gateway/src/repo/catalogs.ts:57`), but activation must still prove authoritative provider/egress reconstruction with owner/enabled visibility checks, one actual fetch across independent coordinators, bounded cold wait/cancellation, explicit-refresh joining and visible failure, stale SQL-outage handling, 512-entry L1 generation/publication ordering, code-revision bump and maintenance scheduling. They are expressly outside this foundation verdict.
- **C08 importer:** adopt `replaceCredentials` (`vnext/packages/gateway/src/repo/types.ts:192`) with current authorization/config expectations and provider credentialRevision checks after contention. The foundation deliberately does not replay imports; the generic legacy `save` API does not become a same-account reimport signal automatically.

## Assessment

**Task quality: Approved.** No foundation-scoped correctness or maintainability issue warrants blocking acceptance. Approval covers the reviewed source package; root's frozen runtime/CI gates and the separately queued activation acceptance remain distinct.
