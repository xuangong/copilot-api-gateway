# Task 3 Review

## Spec Compliance

- **PASS — Spec compliant.** Reviewed base `97325b7ef4b731dfd61e1674c5d4c6e4f7433f48` to head `50e62714ce11510c34a7c3dc1174647e7faaa6f4` using the supplied diff once. The required route and permitted focused sibling test are the only changed files (`review-97325b7e..50e62714.diff:6-9`; `task-3-brief.md:3-5`).
- Authorization remains before cancellation admission; an authorized already-aborted request starts neither subscription nor snapshot (`vnext/packages/gateway/src/control-plane/dump/routes.ts:105-109`; `vnext/packages/gateway/tests/control-plane-dump-lifetime.test.ts:158-172`). Already-aborted unauthorized/missing-key requests retain 403/404 (`control-plane-dump-lifetime.test.ts:258-271`).
- Raw abort ownership is installed before eager subscription and snapshot, with a post-registration abort check. Cleanup is idempotent and detaches the same raw listener before aborting the local subscription controller (`routes.ts:110-129`; `control-plane-dump-lifetime.test.ts:130-136`).
- The real subscription is cancelled while the snapshot is still pending. The test publishes before abort, checks signal/iterator/listener teardown and skipped post-abort encoding, and only then resolves the read (`control-plane-dump-lifetime.test.ts:138-155`). This verifies actual broker release rather than only checking a local Boolean.
- Already-started snapshot fulfillment and rejection stay observed; cancellation prevents starting SSE after either settles. A live read failure cleans up and rethrows its original error (`routes.ts:130-133,154-157`; `control-plane-dump-lifetime.test.ts:174-204`). There is no SQL cancellation claim or storage modification.
- Live subscribe-before-snapshot ordering and the existing `snapshot`, `appended`, and iterator `error` event behavior are retained (`routes.ts:126-148`). The live test asserts exact snapshot/queued FIFO output and graceful cleanup (`control-plane-dump-lifetime.test.ts:207-236`).
- Raw abort, synchronous subscription/read setup failure, snapshot rejection, normal stream completion, and response-body cancellation share cleanup (`routes.ts:112-119,136-157`). Tests cover pending live read abort, repeated cleanup, and body cancellation while the external raw signal stays live (`control-plane-dump-lifetime.test.ts:238-256,273-296`).
- No public signature, wire event, broker, auth, storage, capacity, migration, environment-variable or retry-policy change appears in this task diff. Strict TypeScript prohibitions are respected throughout both changed hunks.
- **Cannot verify from this task diff:** current protected-overlay hashes, fixture identity, unchanged authorization/storage implementation, full frozen-source CI, or whole-increment integration. Existing evidence records 38/14 protection counts (`task-3-postcommit-protect.log:1`), unchanged route/auth coverage (`task-3-green.log:3-12,39-86`), and the report expressly leaves final qualification with the controller (`task-3-report.md:104-108`). The controller should perform the already-planned final manifest/protection/fixture qualification; this task verdict does not replace it.

## Strengths

- Ownership is narrowly attached to the existing route controller, not spread into broker/storage policy. A single cleanup closure handles both early failures and streaming exits (`routes.ts:110-157`).
- Tests use real SQLite authorization and the real broker; only snapshot timing is deferred (`control-plane-dump-lifetime.test.ts:24-58,68-99`). Listener assertions compare actual callback identity and require one registration/removal (`control-plane-dump-lifetime.test.ts:130-136`).
- TDD claims match the visible raw evidence: the initial run has four behavioral failures and three characterization passes (`task-3-red.log:4-68`); the intermediate null Content-Type matcher failure is an assertion-type error rather than a new behavioral RED (`task-3-fixture-assertion-error.log:4-24`); the later body-cancel run demonstrates a separate real teardown failure (`task-3-body-cancel-red.log:11-29`). The final suite records 41 pass, 0 fail, 193 assertions (`task-3-green.log:88-101`).
- The reported limitation is accurate: an awaited noncooperative snapshot read can remain pending after subscription release. The code does not claim bounded queues, stopped SQL, or measured resource gains (`routes.ts:130-133`; `task-3-report.md:24,108`).

## Issues

### Critical (Must Fix)

- None found in the task diff.

### Important (Should Fix)

- None found in the task diff.

### Minor (Nice to Have)

- **Inherited tooling advisory:** `task-3-lint.log:1` contains the resolver's `Multiple projects found` warning, so lint output is not completely pristine. The same advisory exists at `task-2-final-lint.log:1`; this task adds no source lint diagnostic. Track resolver configuration/output cleanup as existing tooling debt rather than changing scope or suppressing it in this task. It does not block this task approval.

## Checks and Review Boundaries

- Read the supplied brief, global constraints, implementation report, diagnostic specification (`vnext/docs/superpowers/specs/2026-10-01-hosted-search-execution-contracts.md:54-58`), diff, and named raw validation logs. No suite, benchmark, full CI, network operation, installation, service action or Git command was run.
- **Named concrete risk: local abort may not actually release an eagerly registered/queued subscriber.** Inspected unchanged `vnext/packages/gateway/src/shared/runtime/event-target-channel-broker.ts:47-51,77-90,108-116`: abort terminates the subscription, releases channel ownership, clears buffered frames, removes listeners, and resolves a pending read. This supports the real-broker route assertions.
- **Named concrete risk: native response-body cancellation may not invoke the new cleanup hook.** Inspected installed Hono `vnext/packages/gateway/node_modules/hono/dist/utils/stream.js:24-33,65-76`: readable cancellation calls `abort()`, which invokes registered `onAbort` subscribers. `dist/helper/streaming/sse.js:28-43,46-62` shows callback execution and normal close ownership. The new hook is installed before the first awaited stream write (`routes.ts:136-139`), and the reported real `reader.cancel()` test passes (`task-3-green.log:96`).
- Gateway source typecheck and purity evidence report success (`task-3-typecheck.log:1`; `task-3-purity.log:1`). Test files are executed by Bun and checked by scoped ESLint; the report does not claim the source-only typecheck independently checks test types (`task-3-report.md:73-75`).
- No unresolved code doubt required a new focused probe. Changed files were not separately reread; only the two named unchanged-support risks were inspected. The sole write is this review report.

## Assessment

**Task quality: Approved.**

**Reasoning:** The implementation closes the concrete snapshot-window subscription leak while preserving live ordering, authorization and non-aborted failure ownership. Real-broker cancellation assertions and separately identified behavioral RED evidence support the change; the inherited resolver advisory and controller-owned final qualification remain explicitly bounded.
