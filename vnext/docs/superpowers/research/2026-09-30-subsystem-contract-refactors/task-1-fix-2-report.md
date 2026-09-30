# Task 1 fix 2: fence inverted target observations

## Result

Closed the reviewer's reversed-incarnation regression and the related missing-row regression. The real SQLite cases cover both an empty ordering owner and an existing head whose observation ticket is later than the request discovering the authority change.

No deployment, service change, dependency installation, Git mutation, original overlay change, or Task 6 file edit was performed. Root owns integration.

## Evidence and cause

The first fix ordered accepted publication versions, but still used read-start tickets when comparing different identities or a missing row. Those tickets do not order actual SQL observations. The existing-head case is especially important:

1. Ticket 1 starts; its SQL read waits.
2. Ticket 2 reads A and installs its ordering head.
3. Ticket 3 captures A; its return waits.
4. SQL deletes A, optionally recreating the upstream with incarnation B.
5. Ticket 1 reads the missing row or B and returns null because its expected target was A.
6. Ticket 3 returns its captured A.

Before the fix, ticket 1's authority fact could be ignored behind the higher stored ticket, and ticket 3 returned A. The same resurrection occurred without step 2. All four database regressions failed before the product edit (`task-1-fix-2-red.log`: 0 pass / 4 fail).

## Contract

`CatalogOrdering` keeps at most 512 small entries. An accepted identity head now also records `identitySinceSequence`: the started-read sequence when that identity was first accepted. Another identity from a read already in flight at that point must reread. Stable observations preserve the existing watermark so concurrent reads of the same publication do not invalidate each other.

When a read proves the expected target is missing or no longer matches its incarnation/owner/provider, the coordinator removes its retained payload and installs a small barrier for that upstream. The barrier requires an observation ticket strictly greater than the current started-read sequence, even if the authority-changing read itself had a lower ticket than an existing head. It does not claim that the returned candidate identity is the newest identity: a fresh SQL read resolves that uncertainty. Other upstream IDs are unaffected. A caller-specific visibility rejection of the same target continues through ordinary observation ordering and does not install this strong barrier.

A full identity entry contains at most five strings of 66 UTF-16 code units and five numeric scalars. A barrier contains only the bounded upstream key and one numeric floor. Both share the same 512-entry owner. Neither retains model payloads, upstream state, credentials, proxies, callbacks or request capabilities. Evicting an ordering entry advances the conservative global floor past every already-started ticket, including the largest ticket; explicit clear remains fenced by its incremented sequence.

## Validation

```sh
bun test packages/gateway/tests/catalog-coordinator.sqlite.test.ts packages/gateway/tests/catalog-retention.sqlite.test.ts packages/gateway/tests/catalog-retention.test.ts packages/gateway/tests/catalog-retention-concurrency.sqlite.test.ts
```

`task-1-fix-2-green.log`: **47 pass / 0 fail / 7,335 expectations**. This includes the four new real SQLite cases, identity-watermark and per-ID-isolation checks, the 64-reader stable-publication regression (including a visibility-rejected caller), delayed publications, bounded eviction, credential/proxy renewal and joined-terminal regressions.

The control worker's unchanged SQLite reproducer now reports `firstResult: null`, `delayedModels: null`, `resurrectedOldIncarnation: false`, `reads: 3` (`task-1-fix-2-incarnation.log`). Its third read is the required fresh authority check.

Focused ESLint passed for the five Task 1 files (`task-1-fix-2-lint.log`; existing multi-project resolver advisory only). `git diff --check` passed. Full combined-tree checks remain root-owned. This report supersedes the first report's four-scalar bound and completed-ticket-only missing-row behavior; it does not claim production latency or heap measurements.
