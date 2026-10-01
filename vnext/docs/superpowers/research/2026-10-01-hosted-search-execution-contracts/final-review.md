# Whole-increment review

Date: 2026-10-01. Base: `db9ce4f35abab6fbed34dc038d1efd2c979cf773`. Head: `d404c9f8`. Authoritative input: `review-db9ce4f3..d404c9f8.diff` (7 commits, 32 files). Paths below are relative to the existing isolated worktree; evidence filenames are relative to this report's directory.

## Spec compliance and plan assessment

**Spec compliance: FAIL — one verified final-delivery gap remains in Responses.** The shared execution scope, Chat migration including its accepted race repair, and diagnostic snapshot cancellation satisfy their inspected requirements. The Responses adoption and settlement integration is sound, but its existing outer wrapper can still publish a frame after synchronous closure. This violates the end-to-end delivery obligation even though the defective wrapper lines predate this increment. See I1.

**Plan design: sound.** Pure preparation, a tools-owned execution scope, narrow caller adapters, and request-owned diagnostic cancellation address concrete ownership gaps without relocating completion/persistence authority. Preserving concurrency while deferring numerical admission and notification shedding is justified: cancellation cannot supply a capacity policy or a durable reconciliation cursor. No plan-level blocker or additional policy ruling is required. The missing Responses final guard is an integration defect against the plan, not a reason to redesign the scope.

## Strengths

- `execution-scope.ts:43-59` registers and observes work before invoking factories, removes settled registrations, and retains a genuine pending-work receipt. `operations.ts:515` and `:610` track each complete provider-plus-usage leaf, so fail-fast aggregates cannot hide unfinished siblings. The unchanged `search.ts:13-24` and `fetch-page.ts:13-27` actually await usage in `finally`; inspection confirms the tracker encloses that work. Deferred real-SQLite tests cover sibling and page-usage settlement.
- Preparation/start remains explicit and single-use (`execution-scope.ts:98-115`). Current multi-query concurrency, single-operation/page scheduling, batching, cache reuse, argument slices and ordering are preserved. Cancellation unlinks the parent, aborts only the local controller, clears cache and revokes waiting deliveries; delayed resolution, post-usage mapping, fallback and retry boundaries inspect cancellation. The old `planWebSearchCalls` export is gone, both hosted callers use scopes, and shared tools import no concrete protocol lifetime.
- Responses adopts returned work before subsequent validation/preparation (`server-tool-shim.ts:1131-1134`), cancels all owners synchronously even if one callback throws, and separately observes settlement with the existing cleanup wait (`server-tool-lifetime.ts:53-65,138-154`). Early invalid results and exceptions retain their original outcome. Canonical replay metadata is constructed before eager start; private writes and reentry remain under the established host/materializer.
- Chat's local owner handles pre-pull and pending-read return/throw/discard, owns current and pending producers, disposes late results without consuming them, and distinguishes natural drain from forced disposal. `web-search-result-owner.ts:136` repairs the reviewed outer-await race. The same-tick discard/abort regressions and open control specifically exercise that repair; normal native JSON, citations, summed usage, client-tool handoff and turn budgets remain covered.
- Diagnostic cancellation is attached after authorization but before eager subscription/snapshot (`control-plane/dump/routes.ts:105-133`). The same idempotent cleanup handles failure, normal completion, raw abort and response-body cancellation. The real broker releases its subscription and queue on abort; installed Hono invokes `onAbort` for readable cancellation. Live subscribe-before-snapshot ordering and existing event/auth/storage behavior remain intact. Pending SQL is observed rather than falsely reported as cancelled.

## Issues

### Critical

None found.

### Important

**I1 — Responses still delivers a terminal frame after closure in the outer read continuation.**

- **Location:** `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-lifetime.ts:166-168`; actual hosted wiring: `server-tool-shim.ts:1267`.
- **Defect:** `wait()` checks `closed` when resolving its own promise, but `wrap().next()` resumes in a later microtask and returns the step without another open check. If discard or parent abort occurs between those two points, hosted work has already been cancelled and private state retired, yet the pending outer read resolves with the terminal frame. The check inside search result access/materialization cannot cover this later boundary.
- **Verified evidence:** one read-only `bun --eval` probe used the actual `ServerToolLifetime`, actual execution scope adopted with `ownWork`, and a real async generator. A reaction on the generator read queued close after wait settlement but before the outer continuation. Both closed variants delivered `response.completed`; the open control delivered normally. This establishes a helper-boundary race in the exact wrapper used by the hosted shim, not a claimed HTTP or production reproduction.

```json
{"mode":"discard","delivered":"response.completed","done":false,"closedAtDelivery":true,"parentAborted":false}
{"mode":"abort","delivered":"response.completed","done":false,"closedAtDelivery":true,"parentAborted":true}
{"mode":"open","delivered":"response.completed","done":false,"closedAtDelivery":false,"parentAborted":false}
```

- **Impact/severity:** Important, because the increment explicitly promises revoked protocol delivery on close. This is inherited implementation behavior exposed by the whole-contract check; it is not caused by the new `ownWork` loop. It remains a blocker to accepting this increment's end-to-end claim, just as the same race was a blocker in Chat.
- **Fix:** call `this.assertOpen()` immediately after the outer `await this.wait(generator.next(value))`, before handling `step.done` or returning the step. Add the equivalent same-tick discard/parent-abort regression and open control for Responses. Preserve the existing error, metadata and cleanup owners; a broader lifetime rewrite is unnecessary.

### Minor and deferred-item triage

- **Inherited `no-useless-assignment`, nonblocking:** `server-tool-shim.ts:825` initializes `parsed` to `undefined`, then both the parse-success and catch branches assign it before use. The initialization is redundant, not a missing error branch. `task-2-baseline-lint-shim.log:4` and `task-2-final-lint.log:4` reproduce it. Leave unrelated cleanup outside this fix.
- **Inherited `require-yield`, nonblocking:** `server-tools/web-search.ts:613` intentionally implements a terminal-only async-generator slot. It must return the slot terminal through the existing iterator protocol; absence of intermediate yields is valid. The baseline warning at former line 602 is recorded in `task-2-baseline-lint-web-search.log:4`, and the final warning in `task-2-final-lint.log:7`. Do not change the slot protocol merely to silence it.
- **Inherited resolver advisory, nonblocking:** the multiple-projects message appears in both Task 2 baseline logs and all task lint evidence. It concerns resolver configuration/performance, not the cancellation implementation. Record it as tooling debt; these runs are successful but their output is not warning-free. No suppression or resolver reconfiguration is needed in this increment.

## Cancellation return Ruling

**Accept `cancel(): undefined`.** TypeScript's void-return callback assignability permits a Promise-returning implementation; the explicit undefined result rejects that accidental async substitution. The source-included conditional assertions enforce this distinction for both public cancellation ports. The built-in scope closes admission/delivery synchronously and already satisfies the type.

The integration cost is deliberate and small: an existing function declared `() => void` needs an explicit synchronous facade that returns undefined, even if its runtime behavior is synchronous. A facade must actually revoke its local gate before returning; simply launching asynchronous cancellation would violate the behavioral contract. The return type cannot prove real settlement or provider cooperation, so `settled()` and runtime ownership tests remain necessary. The hosted capability is optional, and the Alpha direct session/operation API stays compatible.

## Checks and evidence

- Read the specification, plan, progress/Ruling ledger, all three task reports/reviews, Task 2 fix review, research README and contract matrix. Read the supplied package in sequential chunks; tool-truncated documentation spans were recovered from the same package. No independent Git diff/history derivation or Git command was used.
- Supporting reads were limited to named cross-task risks: complete usage-finalizer coverage; bounded cleanup and unsupported/late producer disposal; early Responses ownership and the final output wrapper; actual broker release and Hono body-cancel callback; and the semantics of the inherited assignment warning. The source symbol check confirmed planner removal and absence of concrete lifetime imports in tools. The existing shared text utility import is not a concrete lifetime dependency.
- Recorded validation was inspected, not rerun: Task 1 **136 pass / 0 fail** (`task-1-final-focused.log:206-209`); Task 2 **252 pass / 0 fail** (`task-2-final-focused.log:283-286`); its Chat fix suite **39 pass / 0 fail** (`task-2-fix-1-green.log:40-47`, behavioral RED at `task-2-fix-1-red.log:17-38`); Task 3 **41 pass / 0 fail** (`task-3-green.log:89-101`). These overlap and must not be summed. They do not test I1.
- Task typecheck/purity logs report success. Lint is triaged above. Protection logs record 38 main and 14 isolated protected files; those are retained task evidence, not a fresh preservation check by this reviewer.
- Exactly one new runtime probe was necessary, for I1. No suite/full CI, network, install, service operation, benchmark, source/index/HEAD mutation, push, deploy, cleanup or subagent dispatch occurred. The only written artifact is this report.

Reproducible I1 probe, run from `vnext/`:

```sh
bun --eval 'import { ServerToolLifetime } from "./packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-lifetime.ts";
import { createWebSearchExecutionScope } from "./packages/gateway/src/data-plane/tools/web-search/execution-scope.ts";
for (const mode of ["discard", "abort", "open"]) {
  const controller = new AbortController();
  const search = createWebSearchExecutionScope({ getProvider: async () => ({ type: "disabled" }), filters: {}, apiKeyId: "probe", includeSearchActionSources: false, signal: controller.signal });
  const owner = new ServerToolLifetime(() => undefined, controller.signal);
  owner.ownWork(search);
  const terminal = { type: "event", event: { type: "response.completed" } };
  const generator = (async function* () { yield terminal; })();
  const next = generator.next.bind(generator);
  let closing;
  generator.next = (...args) => {
    const step = next(...args);
    void step.then(() => queueMicrotask(() => {
      if (mode === "open") return;
      if (mode === "abort") controller.abort();
      closing = owner.close();
    }));
    return step;
  };
  const iterator = owner.wrap(generator);
  const result = await iterator.next().then(step => ({ delivered: step.value?.event.type, done: step.done, closedAtDelivery: owner.isClosed }), error => ({ rejected: String(error), closedAtDelivery: owner.isClosed }));
  await (closing ?? iterator.return());
  await search.settled();
  console.log(JSON.stringify({ mode, ...result, parentAborted: controller.signal.aborted }));
}'
```

## Recommendations and controller-owned requirements

1. Resolve I1 with a scoped fix and regression review before freezing source. The existing Chat fix is a concrete model; another broad architecture review is unnecessary for that narrow repair.
2. Then perform the planned single full `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` on a fresh frozen non-document source/config/test manifest including protected overlays. This review does not qualify full CI or the current overlaid artifact.
3. Before/after the authorized local fast-forward, independently verify manifests, original 38/14 protected inventories, fixture identity and integration state. Their current integrity and the local merge are unverified controller obligations here.
4. Retain the contract matrix's limits: no operation/body/replay/cache/active-queue bound, no forced stop of noncooperative or detached work, no measured workerd/CFW CPU/memory/latency benefit. Numerical policies, deployed-baseline comparison, catalog/affinity rollback and release backup/restore require separate future qualification. Local source approval is not production/release approval.

## Assessment

**Code quality: Needs fixes. Ready for local vNext merge: No.**

The selected architecture and almost all implemented ownership boundaries are coherent, and the documented evidence is appropriately scoped. One verified Responses final-delivery race prevents spec acceptance; fix that boundary, qualify the frozen artifact, and complete the controller-owned preservation checks before local integration.
