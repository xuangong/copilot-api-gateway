# Contract strengthening: whole-branch independent review

Date: 2026-10-01.

## Verdict

**CLEAN at source HEAD `da6cc3693ff1a64ecb5d9670905f0f713d90d099`. No unresolved Critical, Important, or Minor product finding remains in the reviewed batch. The source is approved for the controller's frozen-candidate qualification and this batch's final CI.**

This is a source-review verdict, not a final CI or release verdict. Local integration remains conditional on the controller's single final full CI run for this batch and verification that the integrated artifact matches the qualified candidate. No production readiness or deployment result is claimed.

## Scope and artifact boundary

- Workspace: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`.
- Baseline: `dbde0567b505267098258fa3293b38ca29d3b27a`.
- Task 1: `a3eb50537f37928d6729f4ca6e560f9858a948fc`.
- Task 2: `57a8ec926c29303421e7259e981f69093f55741d`.
- Task 3: `1650ffc41df0f4c49c127d27cfebc896e03b65f8`.
- Sparse foreign-array correction: `291b078215abce54d4e50b6ee397f62833ada279`.
- Closure-callback correction and reviewed source HEAD: `da6cc3693ff1a64ecb5d9670905f0f713d90d099`.

The current working copies of the contract-strengthening specification, plan, and research contract matrix are authoritative for the accepted contract. They include the final synchronous `undefined` writer/disposal boundary, monotonic cleanup failure, sparse-array validation, and closure-callback release requirements. They were not yet committed at review time. Controller-owned checklist and report-link updates do not change this source verdict.

Reviewed the complete batch production/test diff, both correction deltas, task implementation reports and independent reviews, the current specification/plan/matrix, and adjacent ownership, replay-rendering, preparation, and Responses turn-finalization paths. The review considered the three tasks together rather than treating their individual passing checks as integration proof.

The qualification workspace also contains the pre-existing protected collaboration overlay. It is not a pristine checkout of the source HEAD. Independent byte verification found that all **30 source files changed by this batch's committed diff match the final source commit**, and all **14 isolated-workspace and 38 main-workspace protected file hashes match their recorded baselines**. The protected overlay remains part of the controller's explicit final candidate. These checks do not imply verification of every candidate file or the future integration artifact.

During report completion, the controller reported freezing 1,555 non-documentation source/config/test files at the same source HEAD, including the 14 overlay files, with manifest SHA-256 `a0d21a57d47b630870e8bf88c76bb04a72c44efe3070f46620562172b425189e`, and starting `ci:local` with output in this batch's `ci-local.log`. This is controller-reported qualification progress; the reviewer did not independently rehash the complete manifest or inspect a completed CI result. Final CI interpretation and qualification remain with the controller.

## Contract assessment

### Preparation, exact state, and synchronous observation

`chat-flow-kit/src/serve-template.ts` now requires preprocessing, with the successful continue branch carrying the exact `TExtra` into execution. Early-response handling may still have no extra state. Parsing, history loading, preprocessing, telemetry, quota, and ready execution retain their established order.

The module-private execution capability and the ready runner's once-only behavior are preserved: the pending runner is cleared synchronously before invoking the original runner. The new typing does not copy capability identity or introduce another execution owner.

The Responses observer remains at the prepared-state observation point after history/compaction and before routing, affinity, quota, and inference. Its `undefined` result rejects async and broad-void implementations. Readonly applies to the intended top-level observation surface; the change does not promise deep immutability, clone inputs, or move preparation work into the observer.

### Translated producer domain

`protocols-llm/src/common/result.ts` restricts translated producer output to Chat Completions, Messages, and Responses, matching the existing runtime producer guard. Native/source Gemini support remains available. The change does not broaden traversal, combine independent event/JSON adapters, or alter producer disposal ownership.

The existing normalizer registry placement, the 21 normalizers from the previous batch, and the Responses turn/session/completion owners remain outside this batch's behavioral changes. Previous-batch CI statistics are not used as this batch's qualification evidence.

### Private state and lazy hosted-tool lifetime

The default private-state source creates its Map only for an active hosted invocation, once for the complete lazy response lifetime across hosted turns. Default inactive and replay-only paths create no owned Map, listener, or result wrapper. The owner clears/revokes its state synchronously on closure rather than relying on a TTL.

The plugin receives a real reader facade; materialization receives a typed writer and narrower slot capability; disposal remains with the outer owner. Owned writes and disposal require synchronous `undefined` results. The legacy borrowed store retains its compatibility interface and external ownership: closure revokes this invocation's access without clearing the caller's stored data. The borrowed decoder validates foreign values before typed replay, while valid owned values preserve reference identity without repeated deep decoding.

The lifetime accounts for the raw/source/current producers, pending provider acquisition, active slot iterator, and outer iterable. Closing revokes private access before bounded asynchronous cleanup. Pending reads stop, late provider results are discarded, and late work cannot publish private state or start another turn. The pending-provider handoff registers ownership in the promise-resolution callback before subsequent continuation can race with closure.

Incomplete cleanup is monotonic and reaches the existing Responses turn close/discard path and `rawCleanupComplete` fact. Final metadata settles once through the shared settlement path, preserving the existing model-identity rule and fallback when the optional resolver fails. Cleanup failure does not replace an original wire failure or fabricate a successful outcome.

The final callback correction clears the lifetime's stored callback before invocation. The cleanup Promise is published before synchronous user callbacks can reenter closure, preserving Promise identity and once-only disposal/settlement. Queuing that Promise does not delay synchronous state revocation: resource cleanup runs after the immediate close statements. Callback failures retain incomplete-cleanup behavior, and a callback registered after closure executes directly without being retained.

## Findings resolved during review

### Important / P2: sparse foreign arrays accepted by the decoder

Discovered by the independent Task 3 reviewer and independently rechecked in this whole-branch review. At the original Task 3 head, `Array.every` skipped holes in `results`, `queries`, and `sources`. In particular, an `open_page` payload with `results: new Array(1)` passed the decoder and could throw when the renderer accessed the absent first result, violating malformed-history-as-miss behavior.

**Resolved by `291b078215abce54d4e50b6ee397f62833ada279`.** Current locations are `vnext/packages/gateway/src/data-plane/orchestrator/server-tools/private-payload.ts:53`, `:57`, and `:77`. The two-file correction uses non-copying iteration that visits holes as `undefined` and rejects them through the existing predicates. Three regression fixtures cover decoder rejection, the actual borrowed reader miss, unchanged fallback output, and preservation of the external stored reference. No new clone, freeze, format, or capacity policy was added.

### Minor: closed lifetime retained its metadata callback

Discovered in this whole-branch review. A retained result's events/discard closure retained the lifetime, whose `onClosed` field still reached the metadata-settlement closure and accumulated merge output after closure. This was a specific source retention edge, not a measured heap leak.

**Resolved by `da6cc3693ff1a64ecb5d9670905f0f713d90d099`.** Current locations are `vnext/packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-lifetime.ts:28` and `:122`. The two-file correction invokes post-close registrations directly and takes/clears the stored callback before invocation. It also publishes the one cleanup Promise before synchronous reentry can occur. The three focused tests cover reentrant Promise identity and once-only counters, direct post-close invocation/error propagation, and throwing initial callbacks with continued resource cleanup and stable rejected-Promise identity. The identified direct retention edge is removed; no quantitative memory or GC claim follows from this review.

## Verification evidence inspected

These are existing implementation logs inspected by the reviewer. They overlap in coverage and must not be added together or represented as full CI. No tests were rerun for this whole-branch review.

| Evidence | Observed result |
|---|---|
| Task 1 focused run | 191 pass / 0 fail / 880 assertions across 10 files |
| Task 2 focused run | 89 pass / 0 fail / 247 assertions across 6 files |
| Task 3 focused run | 272 pass / 0 fail / 852 assertions across 20 files |
| Sparse-array regression RED | 5 pass / 3 expected fail |
| Sparse-array correction GREEN | 38 pass / 0 fail / 179 assertions across 2 files |
| Callback correction RED | 2 pass / 1 expected fail |
| Callback correction GREEN | 62 pass / 0 fail / 219 assertions across 3 files |
| Relevant package typechecks | Passing recorded checks for chat-flow-kit, gateway, protocols-llm, and provider-copilot as applicable |
| Purity and scoped lint | Passing recorded checks; no new rule errors |
| Independent source-byte verification | All 30 committed changed source files match final source HEAD |
| Independent protected-file verification | All 14 isolated and 38 main hashes match |

The recorded lint output includes the existing multiple-tsconfig advisory and four inherited Task 3 warnings. They are not new merge blockers and do not justify expanding this batch. Some final type-only/runtime-equivalent Task 3 refinements followed its aggregate focused run; this is another reason to retain the controller's final frozen-candidate CI gate.

## Limits and remaining gates

- Complete-candidate verification, this batch's final full CI result, and the future local integration hash comparison remain controller-owned gates. The controller has reported the freeze and CI start; this review does not claim their final qualification result.
- No active-memory bound or production resource improvement was measured. An owned invocation scope may retain values longer than the former TTL on a long-lived response. There is no numeric entry/byte admission policy, deep snapshot, or freeze guarantee.
- An abandoned iterable without an explicit close or abort signal cannot be assumed to release promptly. The borrowed legacy `void` signature cannot prove that an external implementation is synchronously behaved; the new owned authority has the stronger contract.
- No production behavior, deployment, benchmark, or incident resolution was verified. No schema, environment variable, feature flag, retry policy, or outcome-owner change was introduced by this batch.

Only this review report was written by this whole-branch reviewer. Source, protected files, Git HEAD/index, services, credentials, and deployment state were not changed. No test, full CI, install, push, deployment, restart, or benchmark was executed by this reviewer.
