### Spec Compliance

- ✅ **Spec compliant** for Task 3 at `0cab1afa66bc60d6ca86ebb28110b4a7f96811f8` against base `ea98379a53d9175a0bc3a3f9e2a6d1b707823616`. All five requested implementation files and the five focused test files have corresponding changes. No Task 4 preparation is counted.
- ✅ Full own-data estimation, conservative duplicate-reference charging, cycle rejection, depth/visit limits, key charges, and net replacement are implemented in `vnext/packages/gateway/src/data-plane/tools/web-search/capacity.ts:66-143`. Defaults match the binding policy at `capacity.ts:5-9`.
- ✅ Owned replay retains original payloads under the synchronous writer, while delegated stores remain externally owned and explicitly uncertified: `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/private-payload-store.ts:4-5,40-50,89-104`.
- ✅ Page cache admission precedes success publication and capacity errors bypass ordinary error snippets: `vnext/packages/gateway/src/data-plane/tools/web-search/operations.ts:643-658`. The scope connects capacity failure to its existing cancellation owner at `execution-scope.ts:45-49`; pending provider/usage work keeps its existing settlement tracking at `execution-scope.ts:73-90,112-120,148`.
- ✅ Chat admits original accumulated arguments, rendered tool strings, preserved JSON tool/function extensions, assistant text, and new citations before generated continuation retention/reentry. Initial and previously generated history are not rescanned: `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-chat-completions-web-search-shim.ts:293-304,367-400`.
- ✅ The existing Responses lifecycle fixture exercises the owned writer overflowing before a completed item, response completion, or further model run, while metadata settles: `vnext/packages/gateway/tests/data-plane/chat-flow/responses/interceptors/server-tool-private-lifecycle.test.ts:476-493`.
- ⚠️ Whole-service resource qualification and protected-overlay content are outside this task diff. The controller supplied unchanged-overlay verification; the recorded protection output reports 38 main and 14 isolated files. These accounting quantities are not physical heap bounds or production-safe measured defaults. Borrowed graphs must remain immutable after admission (`capacity.ts:63-64`).

### Strengths

- `capacity.ts:84-100` uses descriptors rather than property reads for own data, rejects accessors/symbols/exotic prototypes/functions/cycles, and removes ancestors after each branch so shared references remain accepted and conservatively charged.
- `capacity.ts:127-141` estimates before mutation, rechecks closure and current map state after potentially reentrant reflection, and updates net counters only after successful admission. Failed replacements preserve both the old value and unrelated entries.
- `execution-scope.ts:48,112-120` reuses the established fatal reason/cancellation gate; `operations.ts:651-658` cannot translate capacity failure into a successful page/error snippet. Existing pending work is not prematurely declared settled.
- The actual Chat and Responses caller tests verify observable protocol/continuation behavior, not only helper return values: Chat tests at `with-chat-completions-web-search-shim.test.ts:663-707` and Responses fixture at `server-tool-private-lifecycle.test.ts:476-493`.

### Issues

#### Critical (Must Fix)

- None found.

#### Important (Should Fix)

- None found.

#### Minor (Nice to Have)

- `vnext/packages/gateway/tests/data-plane/tools/web-search/retained-capacity.test.ts:15-18,52-57`: traversal tests cover excess depth/visits and retirement during reflection, but not exact accepted/rejected depth/visit boundaries or a nested insertion/replacement during reflection. The implementation has the necessary post-estimation map checks; focused boundary/reentry cases would better protect those checks against regression. This is a coverage improvement, not a demonstrated correctness failure.
- `.superpowers/sdd/2026-10-01-resource-capacity-policy/task-3-lint.log:1` and `task-3-lint-final-capacity.log:1`: lint output contains the multiple-TypeScript-project resolver advisory. It is documented as pre-existing and does not invalidate passing checks, but the logs are not pristine. Address the resolver configuration separately if practical.

### Checks and Scope

- Read the packaged diff once; did not regenerate a git diff or reread changed implementation wholesale. Inspected only missing surrounding sections needed to judge concrete risks: `operations.ts:580-697` for success publication and ordinary-error downgrade; `execution-scope.ts:64-151` for fatal cancellation versus real settlement; Chat shim `:310-410` for finalization/refusal branches versus continuation admission; private store `:15-60` for delegated ownership. These functions were cut off by packaged hunks. Checked the existing default constants by targeted search because the new owners import them.
- Responses writer ordering is substantiated by the changed actual-caller lifecycle fixture and its recorded passing result. Two guessed source paths for an optional direct owner check did not exist; no broader source crawl was performed and no claim of a separate direct owner-source inspection is made.
- Read existing final focused log: **243 pass, 0 fail, 771 expectations, 10 files**. Read typecheck (exit 0), purity (OK), scoped lint and final capacity lint logs, and protection evidence. No tests were rerun; no unresolved behavioral doubt justified another test.
- No source, index, HEAD, service, dependency, network, or deployment changes. Only this review report was written.

### Assessment

**Task quality:** Approved

**Reasoning:** The implementation places domain-specific admission at the intended retention/publication boundaries and preserves existing protocol, cancellation, persistence, and real-settlement owners. Atomic replacement, conservative noncloning accounting, and caller-level failure tests support approval; the remaining findings are nonblocking coverage and tooling-noise improvements.
