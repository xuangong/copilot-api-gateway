# C12-F1 independent initial review

## Scope and evidence

Reviewed the frozen F1 candidate against accepted base `c4ec998888028c0b73397a5d642de3c9fb1d5e0d` in `reference-adoption-verify`. The 16 paths in `task-C12-F1-frozen-sha256.json` were independently hashed: all 16 match. This is the initial frozen candidate, before any review fixes.

The review covered the F1/global brief, execution supplement, writer report, repository instructions and the complete frozen diff. The diff was read once. No product, index or Git state was changed. No subagents or full test suites were started by the reviewer. F2 session behavior, F3 Bun WebSockets and F4 Workers WebSockets are outside this gate.

Root owns full CI and the frozen runtime probes. Root reported the original 20 runtime processes passing with unchanged hashes. I inspected the full-CI failure excerpts in `/tmp/vnext-c12-f1-ci.log`: 4,871 pass / 1 skip / 4 fail / 1 error. Three failed tests are addressed by findings R1 and R3 below. The separate catalog 512-row timeout and subsequent pending-test error are not attributed to this change: root reported the exact standalone case passing in 1,532 ms without concurrent workloads, and will rerun full CI alone. I also inspected root's additional real HTTP/SQLite RED evidence in `/tmp/vnext-c12-f1-http-error-red.log` for R1.

## Spec Compliance: CHANGES REQUIRED

The main F1 architecture and accepted terminal policy are implemented, but error-path telemetry and no-frame dump preservation regress. R1 and R2 must be fixed before the preservation requirements can be accepted. The existing CI setup regression in R3 must also be resolved without weakening mandatory turn-start completion ownership.

### Strengths

- `startResponsesTurn` and `createResponsesTurn` expose a canonical event iterator, cancellation and completion below HTTP rendering. The HTTP renderer consumes that source, and the generic kit remains independent of Responses and WebSockets.
- The barrier withholds completion until bounded tail observation and snapshot persistence finish. The approved absolute 1,000 ms / 256-frame / 1 MiB policy is explicit. Late failure and exhausted bounds do not create a successful reusable completion.
- Caller cancellation and producer failure use distinct controllers. Completion owns iterator closure, telemetry and dump cleanup, including the already-started noncancellable save. The report correctly acknowledges that such a durable write may still finish after cancellation.
- The source-domain affinity egress is request-local, with JSON terminal authority and the exact canonical terminal carrier passed to persistence. The changes avoid signing JSON intermediate output that is never exposed.
- The Chat upstream wrapper counts the actual requested choices before starting its finish-based deadline and keeps trailing usage, including sparse placeholder choices. The Responses-via-Chat translator inspected for this risk consumes its input before producing its final lifecycle event.
- Bounded final-metadata fallback retains known execution identity and actually observed usage. The existing identity resolver only adopts an observed model correction when it can resolve the corresponding identity; all-zero usage persistence retains the approved baseline omission policy.

## Quality: CHANGES REQUIRED

The focused writer validation and the original runtime groups exercise substantial lifecycle behavior, but they did not cover the existing low-level responder fixture, translated non-event error telemetry, or no-frame dump response bodies. The three findings below are concrete and task-scoped.

### R1 — P2: Preserve the explicit target protocol when persisting upstream errors

**Location:** `vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts:320`

The non-event error finalizer calls `recordPerformance(options.telemetryCtx, result.performance, true)` without the upstream-error result's `targetApi`. The helper therefore chooses a default from the source API instead of the actual translated hub. This misattributes failed requests and errors to the wrong protocol in persisted telemetry.

Evidence:

- Existing `shared/traverse-translation.test.ts:182` expects a Messages source translated through Responses to persist `targetApi: responses`, but the frozen candidate records `messages`.
- The same file at line 212 expects a Gemini source through Responses to persist `responses`, but records the default `chat-completions`.
- Root's additional actual HTTP probe sends a Responses request through a Chat hub that returns HTTP 400. The response status/body remain correct, but real SQLite `performance_summary.target_api` is `responses`, where it must be `chat-completions`. The assertion and observed values are in `/tmp/vnext-c12-f1-http-error-red.log` and `task-C12-F1-app-runtime.mjs:150`.

**Required correction:** Forward the explicit upstream-error target through non-event performance persistence, retaining fallback behavior only when no explicit target exists. Keep the two existing tests and root's actual HTTP/SQLite regression.

### R2 — P2: Retain response bodies in dumps when the turn has no frame log

**Location:** `vnext/packages/gateway/src/shared/dump/accumulator.ts:190-192`; call site `vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts:324-326`

`finalizeTurn` always passes an empty byte buffer to `write`. `write` prefers accumulated frames, but when there are no frames and no bytes it stores `{ type: "none" }`. Legacy JSON and upstream-error responses have meaningful client bodies without an accumulated frame log. Moving finalization away from the old HTTP capture therefore silently removes their response body from the dump, even while recording a positive response byte count and successful cleanup.

Independent scratch reproduction used the real `DumpAccumulator`, `createResponsesTurn` and HTTP renderer, with only the final dump-store sink and broker replaced by in-memory capture. It did not modify product files. Script: `/tmp/c12-f1-review/dump-no-frames.ts`; output: `/tmp/c12-f1-review/dump-no-frames.jsonl`.

Observed cases:

| Case | HTTP result | Recorded response bytes | Stored dump body |
| --- | --- | ---: | --- |
| Legacy JSON completed | 200, canonical completed JSON | 85 | `{ "type": "none" }` |
| Snapshot writer rejects | 502, sanitized persistence error | 89 | `{ "type": "none" }` |
| Upstream error | 429, `slow down` error body | 33 | `{ "type": "none" }` |

All three completion objects report `cleanupComplete: true`; the first also reports completed. This is loss of diagnostic content, not a failure to wait for the store sink. Status propagation was separately checked in the snapshot-error case and correctly remains 502, so no status-mismatch finding is raised.

Root subsequently reproduced the same loss through actual HTTP with SQLite and file-backed dump storage: enable dump retention for the error key, receive the upstream HTTP 400, await registered cleanup, then read the persistent record with `getDumpStore().get`. Its response body type is `none`, where the expected canonical JSON representation is `bytes`. I inspected this RED output in `/tmp/vnext-c12-f1-dump-red.log` (`task-C12-F1-app-runtime.mjs:153`). The runtime script now contains 22 groups; this new failing assertion is evidence for R2, not a claim that all 22 pass.

**Required correction:** Preserve the canonical response/error body for no-frame turns in turn-owned dump finalization without restoring a tee that could keep inference alive after disconnect. Add regression coverage that inspects the stored dump response body for successful legacy JSON and error responses.

### R3 — P2: Update the existing responder fixture for mandatory background ownership

**Location:** `vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts:448`; affected fixture `vnext/packages/gateway/tests/data-plane/chat-flow/refusal-failed-json.test.ts:28-30`

`respondResponses` now creates a turn, and turn creation unconditionally registers completion with platform `waitUntil`. The existing refusal/failed-JSON test calls the responder without initializing a background executor. The frozen full suite fails immediately with `Background not initialized; call bootstrap*Platform() first`, before asserting native failure-envelope behavior and the translated Chat/Messages outcomes.

The failing stack in `/tmp/vnext-c12-f1-ci.log` points from platform `background.ts:22` through `turn.ts:448` and `respond.ts:77` to the test at line 30. The unchanged fixture confirms that it does not bootstrap the platform. This is a deterministic test-contract regression; it does not establish that a correctly bootstrapped production request throws.

**Required correction:** Initialize and drain an appropriate background executor in this existing low-level fixture, consistent with the now-mandatory completion ownership contract, or provide an explicit equivalent executor contract. Do not fix the test by silently discarding completion registration in production. Rerun the fixture and final CI.

## Focused context inspected outside the diff

- `shared/respond-telemetry.ts`: checked the specific fallback-pricing risk and the target-protocol default responsible for R1.
- Existing `shared/traverse-translation.test.ts`, restricted to the two failing upstream-error cases: checked the CI contract and expected persisted target.
- Existing `refusal-failed-json.test.ts`: checked whether the R3 fixture initializes background execution and what assertions are skipped by the throw.
- `translate/src/responses-via-chat-completions/events.ts`: checked the specific concern that translation could terminate on an individual Chat choice before its input drains. No additional F1 finding was established from this inspection.
- Existing `dump-accumulator.test.ts` setup: constructed a scratch reproduction using the real accumulator API instead of inventing a dump contract.
- `DumpAccumulator.write` was read for necessary context omitted from the changed hunk: it establishes how no-frame/empty-byte responses become `body: none`.
- After context compaction, only the turn input/options types and creation signature were revisited to correct the scratch invocation (`kind: bridged-response`, `finalizeDump: true`). This focused exception was disclosed to root; the full diff was not reread. Initial incorrectly shaped scratch calls are not used as evidence.

## Acceptance boundary

This review does not accept F1 while R1-R3 remain open. After the sole writer fixes them, verify the new frozen hashes, targeted regression evidence and root's solo full CI plus runtime acceptance. Do not infer WS session/platform readiness from this F1 review. No additional initial-review scope is requested.
