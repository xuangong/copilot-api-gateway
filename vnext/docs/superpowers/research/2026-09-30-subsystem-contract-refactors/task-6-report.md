# Task 6 implementation report

Status: **narrow payload slice ready for independent review; Task 6 overall remains partial**. Source is frozen at `task-6-owned.sha256`.

## Implemented behavior

- Per-capture defaults: 4 MiB estimated payload reservation and 8,192 frames. The environment/isolate shares a 16 MiB reservation owner. The policy can only be lowered, and admission has no wait queue.
- Request admission occurs before eager `prepareRequestBody`. Reservation includes the full backing buffer rather than only a small view. Prepared request failures remain best effort.
- Canonical frames retain a private bounded JSON projection; strings are shared and containers copied. Estimation does not stringify each frame or materialize a complete keys list. Depth/node/array-length checks bound accepted traversal. Non-serialized hidden/symbol state cannot retain external capabilities or arbitrarily enlarge captured graphs.
- Plain JSON values/order are exact. Array numeric indices retain JSON semantics even when non-enumerable; named extras are ignored. Ordinary `toJSON` data fields remain exact. Callable/accessor serializers, accessors and unsupported prototypes produce explicit omission instead of being invoked. The pre-existing asynchronous rejection for cyclic/BigInt fallback serialization remains separate from supported-but-uninspectable payload omission.
- Fallback strings and terminal owned UTF-8 bytes reserve capacity before encoding. Legacy diagnostic chunk retention is bounded and owns copied views; forwarded byte counts stay independent of capture retention. Canonical forwarding still uses one reader and no extra tee/drain. Store compression remains serial.
- Any admission failure drops the entire request/response diagnostic body rather than publishing a partial event list. `meta.capture = { state: "omitted", reason }` distinguishes capture loss from inference success/failure. Client response bytes/status, counters and inference error metadata remain unchanged. UI list/detail, wire output and redacted export expose omission explicitly; `meta_json` requires no migration.
- One idempotent lifetime follows request preparation, terminal store put and broker publish until actual settlement. SQL lookup rejection and fallback serialization rejection cannot free accounting while request preparation still owns bytes. Cancellation retains its existing semantic-settlement bypass while still awaiting preparation/persistence ownership. Repeated terminal calls reuse one promise and release once.

The provider-kind hydration fix was implemented separately by the arch worker and committed by root as `00149a35`; none of its store/test files are part of this worker's owned diff.

## Scope and measurable tradeoffs

This is an **estimated retained-payload contract**, not a total isolate heap bound. Strings/keys charge UTF-16 length plus fixed overhead; arrays, containers and scalars have conservative fixed charges. Request preparation has a separate 3-times-backing-buffer allowance, while fallback encoding and legacy chunk ownership have their own allowances. These estimates are not measured allocator costs.

Projection adds a bounded traversal and object copy to the opt-in diagnostic frame path, with shared immutable strings. No CPU/speed/heap improvement is claimed before exact-artifact workerd measurements. A proposed 20-times worst-case serialization charge was discarded because it unnecessarily omitted an existing 300 KiB response/70 KiB request fixture; the approved UTF-16 accounting preserves that unchanged regression. Serialization/codec working memory remains outside this slice.

Remaining domains: publication/metadata concurrency slots, metadata/header/error graph size, broker queues, control-plane readback/export, ingress body/JSON allocation, provider/result retention, runtime overhead, JSON/codec scratch, legacy tee buffering on the other branch, and the separately bounded upstream sidecar collector. Borrowed sidecar collectors retain their own lifecycle. Metadata-only omitted records use existing best-effort writes: there is no newly introduced metadata queue, but this does **not** cap their concurrency. Explicit publication-admission-failure visibility remains the priority prerequisite for closing Task 6 fully.

## Evidence

- `task-6-owner-red.log`: four true pre-integration failures for oversized request preparation, frame overflow and reservation lifetime through SQL/serialization failures. An earlier fixture-only SQL constraint error was corrected before collecting this red evidence.
- `task-6-green.log`: **190 pass / 0 fail / 1,194 expectations across 11 affected dump suites**. Coverage includes real SQLite/files, storage handoff, preparation/upload failure, sidecar behavior, route dispatch, unchanged large-body prefix capture, export and terminal semantics.
- The final array/toJSON projection delta then passed `task-6-projection-green.log`: **17 pass / 0 fail / 95 expectations** across the budget and real SQLite owner suites. This adds the non-enumerable array-index / ordinary-toJSON boundary without repeating the broader unchanged suites.
- `task-6-gateway-typecheck.log`: gateway typecheck passed on frozen source.
- `task-6-dashboard-typecheck.log`: dashboard typecheck passed; its source did not change afterward.
- `task-6-lint.log`: scoped ESLint passed on frozen source (existing multi-project resolver advisory only).
- `git diff --check` passed.

Focused database tests cover exact normal projection, hidden-state independence, oversized request/frame/fallback/legacy capture, complete omission with unchanged response bytes/status, independent wire/export visibility, concurrent environment saturation, delayed preparation/upload/publication, cancellation with unresolved semantic completion, lookup and cyclic-fallback rejection, prepare/put/publish failure and repeated finalization.

No deployment, remote write, dependency installation, service change, Git mutation or original overlay edit was performed. Root owns the combined-tree CI, final branch review, commits and merge. No browser visual smoke was performed for the small list/detail notices; dashboard typecheck passed and root's final build remains required.

## Owned files

All paths below are relative to `vnext/`; exact SHA-256 values are in `task-6-owned.sha256`.

1. `packages/gateway/src/shared/dump/capture-budget.ts` (new)
2. `packages/gateway/src/shared/dump/accumulator.ts`
3. `packages/gateway/src/shared/dump/types.ts`
4. `packages/gateway/src/shared/dump/registry.ts`
5. `packages/gateway/src/shared/dump/export.ts`
6. `packages/gateway/src/shared/edge/ui-pages/i18n.ts`
7. `apps/dashboard/src/api/dumps.ts`
8. `apps/dashboard/src/tabs/requests/RequestsPanel.tsx`
9. `packages/gateway/tests/dump-capture-budget.test.ts` (new)
10. `packages/gateway/tests/dump-capture-budget.sqlite.test.ts` (new)
11. `docs/superpowers/research/2026-09-30-subsystem-contract-refactors/task-6-capture-resource-policy.md` (new)

Worker evidence outside the candidate: updated `task-6-design-notes.md`, this report, the SHA-256 manifest and the named logs. The implementation plan, research README and Git index are root-owned and were not edited by this worker.
