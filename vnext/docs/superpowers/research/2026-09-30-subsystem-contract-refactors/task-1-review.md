# Task 1 independent review

Date: 2026-09-30. Reviewer: `subsystem_control_review`.

**Current verdict: approved after fix 2.** Both verified review findings are closed. Product code was not changed by the reviewer.

## Final scoped re-review

Reviewed `task-1-fix-2-report.md`, the updated ordering owner, the coordinator's missing/changed-target branch, and the four new real SQLite cases.

- Payload retention and ordering metadata have distinct owners. The latter remains capped at 512 bounded head/barrier entries and does not retain catalog, credential or request objects.
- `identitySinceSequence` is preserved for stable identities; it rejects only already-started observations of a different identity. Stable same-publication peers and same-target visibility rejection therefore preserve the original concurrency-progress correction.
- Missing/changed-target observations create a per-ID barrier beyond all currently issued tickets, regardless of the observing request's own start order. A later authority read is required; unrelated IDs remain eligible. Ordering eviction conservatively retires every already-issued ticket, including the maximum one.
- The original independent incarnation reproducer now reports `firstResult: null`, `delayedModels: null`, `resurrectedOldIncarnation: false`, `reads: 3`. The extra read is the required fresh authority check.
- Independent final focused run: **29 pass, 0 fail, 6246 assertions** across `catalog-retention.sqlite.test.ts`, `catalog-retention.test.ts`, and `catalog-retention-concurrency.sqlite.test.ts`. This covers the four new missing/recreated-row inversions with/without an existing head, retained size/clear/replacement accounting, publication inversion, per-ID isolation, bounded ordering metadata, and 64-reader stable progress. `git diff --check` passed.

No remaining Task 1 blocker was found. Prior full coordinator tests passed in the first scoped review; the implementation owner's final 47-test combined run is recorded separately. No production resource gain or complete-runtime memory bound is claimed. The following sections preserve the review history and are superseded by this approval.

## Second review: reversed SQL observation can resurrect an old incarnation

The new bounded `CatalogOrdering` correctly rejects smaller publication versions for the same full identity, and separates payload admission from ordering retention. However, different row incarnations remain ordered only by read-start ticket. Actual SQL observation order can reverse those tickets.

Independent real-SQLite reproducer: `task-1-incarnation-review.ts` in the worker evidence directory `.superpowers/sdd/2026-09-30-subsystem-contract-refactors/` relative to the isolated checkout. Both requests begin with the old row. Ticket 1 waits before performing SQL; ticket 2 captures the old row/catalog and waits before returning it. The database deletes/recreates the upstream. Ticket 1 then reads the new incarnation, records its ordering head through the ineligible branch, and returns null. Ticket 2 subsequently installs and returns the older incarnation because its ticket is greater, even though that row has already been authoritatively superseded within this coordinator.

Observed output:

```json
{"firstResult":null,"delayedModels":["old"],"resurrectedOldIncarnation":true,"reads":2}
```

This is an existing ordering-contract gap rather than a claim that ordinary production always reorders SQL this way. The fix should retain a bounded watermark for reads already started when an identity is accepted, and apply that check when a different identity arrives. It must not restore the original same-publication concurrency churn. The implementation owner proposed a per-head `startedThrough` scalar; the integrator owns approval.

Independent four-file validation of the first repair passed: **41 tests, 0 failures, 6801 assertions**. This includes the original 64-reader regression (now exactly 64 SQL reads / 64 fulfilled), the added rejected-first-reader variant, same-identity publication-order inversion, head size/field bounds, and the original incarnation-after-head-eviction fence. The new incarnation inversion above was not covered by those cases.

The remainder of this document records the first review and its original reproduction.

## Important: unretained stable publications repeatedly invalidate concurrent reads

Locations:

- `vnext/packages/gateway/src/data-plane/providers/catalog-retention.ts`, `set()`: every individually oversized entry returns `true`, even for another observation of the same stable accepted publication.
- `vnext/packages/gateway/src/data-plane/providers/catalog-coordinator.ts`, `install()`: that result unconditionally advances `installAfter` to `this.sequence`.
- `run()`: observations whose tickets fall below that fence are discarded and retried after `pollMs`.

When several readers overlap on one stable accepted publication, exceeding the retention budget turns valid authority observations into superseded observations. Every newly completed unretained read pushes the global fence forward again, so other concurrent readers repeat SQL and can exhaust their deadline despite no configuration, incarnation or publication change.

### Verified reproduction

New regression test:

`vnext/packages/gateway/tests/catalog-retention-concurrency.sqlite.test.ts`

Run from `F/vnext`:

```text
bun test packages/gateway/tests/catalog-retention-concurrency.sqlite.test.ts

Expected fulfilled results: 64
Received fulfilled results: 16
0 pass, 1 fail, 3 assertions
exit 1
```

The fixture uses a real temporary SQLite database, one stored accepted two-model publication, no discovery or writes during the compared reads, and 64 concurrent cache-only reads. A wrapper delays each completed real SQL observation by 5 ms to create overlapping I/O completion; it does not fabricate database results. The configured total deadline is 100 ms and polling interval is 5 ms.

The independent reproducer at `.superpowers/sdd/2026-09-30-subsystem-contract-refactors/task-1-concurrent-review.ts` recorded:

| Retained model limit | Authority reads | Fulfilled | Timed out |
| --- | ---: | ---: | ---: |
| 2 (publication fits) | 64 | 64 | 0 |
| 1 (publication stays request-local) | 504 | 16 | 48 |

Without the completion delay, the same fixture completed all requests but still increased reads from 64 to 126. These are focused concurrency-regression observations, not production latency/CPU/heap measurements; the short configured deadline does not prove the default 20-second deadline will fail at this concurrency. The additional read/retry loop is directly observed in both variants.

### Required correction

Distinguish retained-payload admission from publication/identity ordering. Keep a bounded lightweight watermark, or an equivalent bounded mechanism, that lets concurrent observations of the same accepted identity/publication complete without retaining the oversized payload. A newer oversized publication must still prevent a delayed smaller older publication or old incarnation from becoming reusable.

Do not simply remove the fence: the existing delayed-old-incarnation and new oversized-publication tests protect a real correctness boundary. The fix needs both progress and stale-publication protection, with finite retained ordering metadata.

## Other review observations

- The replacement/clear/eviction accounting paths release their stored reservations consistently.
- Oversized values remain available to the current request and persisted under existing authority rules.
- Warm request rows are now returned through a local result view instead of being assigned into retained authority.
- No request provider, fetcher, signal or visibility/background closure is intentionally added to memo ownership. The graph estimator rejects the covered executable/non-JSON object shapes without invoking getters.
- The estimated-byte limit is an ownership estimate under the documented read-only graph contract, not a guarantee of whole-runtime heap size. Current control-plane consumers map fields without expanding the retained catalog; routing projection freezes model graphs. No additional blocker was established in these areas.

## Independent passing validation before the new regression

```text
bun test packages/gateway/tests/catalog-coordinator.sqlite.test.ts packages/gateway/tests/catalog-retention.sqlite.test.ts packages/gateway/tests/catalog-retention.test.ts

37 pass
0 fail
1137 expect() calls
Ran 37 tests across 3 files. [5.24s]
exit 0
```

Reviewed the four Task 1 source/test files, the existing coordinator lifecycle, registry consumers and catalog repository contract. No full CI, dependency install, Git mutation, deployment or service operation was performed. Await implementation-owner correction, then rerun the focused concurrency regression with the existing ordering tests for scoped re-review.
