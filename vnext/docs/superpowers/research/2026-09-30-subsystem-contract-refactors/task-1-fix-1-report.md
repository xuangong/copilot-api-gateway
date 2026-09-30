# Task 1 fix 1: separate catalog ordering from payload admission

## Result

Fixed the verified concurrent-progress regression and an additional reversed-read publication regression. Accepted oversized catalogs still stay request-local. Authority ordering now has a small bounded owner independent of whether a model payload fits retention.

Files changed by this follow-up:

- `vnext/packages/gateway/src/data-plane/providers/catalog-retention.ts`
- `vnext/packages/gateway/src/data-plane/providers/catalog-coordinator.ts`
- `vnext/packages/gateway/tests/catalog-retention.test.ts`
- `vnext/packages/gateway/tests/catalog-retention.sqlite.test.ts`
- `vnext/packages/gateway/tests/catalog-retention-concurrency.sqlite.test.ts` (reviewer's new regression, extended with an ineligible caller)

No original overlay file, dependency, service, deployment, or Git index was changed. Root owns commits and integration.

## Root cause and discarded simplification

The original Task 1 implementation advanced the global installation fence to the current **started-read** sequence whenever a payload was not retained. That fence included reads which had not completed, so an ordinary stable observation could retire other valid concurrent observations. Repeated unretained installations caused SQL retries and timeouts.

A smaller change to fence only the discarded/observed ticket was considered but not shipped. A real SQLite counterexample demonstrated that start-ticket order does not determine observation freshness:

1. Ticket 1 starts but delays its SQL read.
2. Ticket 2 captures publication 1 and delays its return.
3. Another coordinator publishes oversized publication 2.
4. Ticket 1 reads and returns publication 2.
5. Ticket 2 returns its previously captured publication 1.

Before this follow-up, the reviewed implementation returned publication 1 at step 5 (`expected 2, received 1`). Its global fence was equal to ticket 2, which did not reject an equal ticket. Using only ticket 1 would also fail. Therefore publication ordering must survive independently of retained payloads, not just rely on a scalar read-start fence.

## Ownership and ordering contract

`CatalogOrdering` stores at most **512 heads**. Each head contains the five identity strings used by `sameCatalogIdentity` plus configuration generation, catalog revision, accepted-observation ticket, and raw publication version. It retains no upstream row/state, credentials, proxies, catalog models, signal, provider, fetcher, visibility callback, or background executor.

Each stored string is at most **66 UTF-16 code units**: ordinary fields of up to 64 units use an inline marker; unusually long fields use a SHA-256 marker and digest. Typical UUIDs, provider names and the existing 64-character configuration fingerprint require **no new hash operation**. UTF-16 hashing preserves the distinction between malformed surrogate strings; separate inline/hash markers prevent a raw string from being confused with a digest. This bounds the five string fields to 168,960 code units across 512 heads, plus fixed numeric/object/map overhead. It is a representation bound, not a measured heap-size claim.

The comparison retains all identity dimensions, generation/incarnation and ticket checks, and explicitly rejects a lower publication version for the same identity. The existing retained-memo comparison and eligibility checks remain intact. Delayed older credentials/ownership observations still encounter the existing later-ticket and identity/eligibility protection; no credential material is retained by the new owner.

Only loss of an ordering head through the fixed 512-entry cap, or explicit `clear()`, retires earlier outstanding reads through the conservative global fence. Payload size rejection or payload eviction no longer changes that fence. Thus a stable accepted publication can complete for every concurrent reader without retaining its model graph.

Ineligible observations remove the payload but still update the small authority head when an observation exists. Missing rows advance only the completed ticket floor. They no longer indiscriminately invalidate unrelated later-started reads. Explicit clear still retires all prior work and clears both owners.

## Red evidence

`task-1-fix-1-red.log`: the original concurrency regression remained reproducible: **16 of 64 fulfilled** when the two-model publication exceeded a one-model retention limit. The log also contains an intermediate helper-contract test for the discarded scalar-ticket approach; that helper test was replaced when the reversed-read counterexample established the need for publication heads.

`task-1-fix-1-inverted-red.log`: **0 pass / 1 fail**. The real SQLite reversed-read scenario above returned publication 1 instead of publication 2 before any product fix.

## Final focused verification

```sh
bun test packages/gateway/tests/catalog-coordinator.sqlite.test.ts packages/gateway/tests/catalog-retention.sqlite.test.ts packages/gateway/tests/catalog-retention.test.ts packages/gateway/tests/catalog-retention-concurrency.sqlite.test.ts
```

`task-1-fix-1-green.log`: **41 pass / 0 fail, 6,801 expectations**. This includes all prior coordinator/retention cases and the new concurrent, reversed-read, finite-head/field, clear, generation and identity regressions. The concurrency test also includes one ineligible caller alongside 63 successful readers and still performs exactly 64 authority reads.

The independent review reproducer was rerun unchanged against real SQLite:

| Retained model limit | Authority reads | Fulfilled | Rejected |
| --- | ---: | ---: | ---: |
| 2, publication retained | 64 | 64 | 0 |
| 1, publication request-local | 64 | 64 | 0 |

Log: `task-1-fix-1-concurrent.log`. No discovery or writes occur during the compared concurrent reads; each real observation's completion is delayed 5 ms, with the original 100 ms deadline.

Focused ESLint for the five changed files passed (`task-1-fix-1-lint.log`), with only the existing multi-project resolver advisory. Root retains final combined-tree typecheck/CI and Git integration ownership. The control worker is performing scoped re-review.

## Resource and performance limits

The fix removes the demonstrated redundant-read/timeout loop in this fixture. It does not claim a measured production latency, CPU or heap improvement. Ordering adds fixed bounded metadata and string comparisons; exceptional long identity fields incur hashing. Catalog model graphs are neither serialized nor hashed by this owner. As before, active request graphs, SQL materialization and other isolates are outside the payload-retention accounting limit.

The independent reviewer should specifically retain the existing delayed old-incarnation-after-eviction, newer oversized publication, credential/proxy renewal, explicit joined-terminal, and clear tests as integration gates.
