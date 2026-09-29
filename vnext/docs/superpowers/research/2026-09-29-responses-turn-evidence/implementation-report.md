# C12-F1 implementation report (in progress)

## Interface and boundary approach — before implementation

- Extract a domain-neutral `prepareTemplate` from the existing kit pipeline. `serveTemplate` remains its HTTP wrapper for other endpoints. Responses preparation remains parse, authorized immutable context, previous-id expansion, routing/affinity analysis, quota and exactly one attempt.
- Export `startResponsesTurn(args)` and a lower-level `createResponsesTurn(result, options)`. A turn exposes canonical Responses events, an abort controller, and an eagerly allocated completion promise. HTTP JSON/SSE are consumers of that source, not its owners. Future WS uses this source directly; the isolated legacy bridged input adapter remains a compatibility path.
- Preserve request-scoped C01 affinity state: one egress instance performs source-domain stamping and the exact canonical terminal output is handed once to the existing snapshot writer. `ResponsesFinalOutput` remains the output reconstruction authority.
- Completion includes owned iterator cleanup, usage/performance persistence and dump finalization. Cancellation aborts inference immediately; an already-started durable write is awaited by completion but cannot produce client success after cancellation.
- Proposal sent to root: bounded internal tail observation (1,000 ms absolute deadline, 256 frames, 1 MiB encoded tail). Late explicit errors and exhausted bounds fail, never imply success. Responses/messages post-terminal output is suppressed. Chat finish_reason -> usage -> DONE remains observed and accounted for. Timeout abort is producer failure, distinct from caller cancellation. Root ruling pending.
- Tests first: terminal-last native/legacy/translated, late errors, late usage, stalled tail, save pending/failure/cancellation and completion cleanup. No full CI here; root owns it and actual Bun/SQLite frozen acceptance.

## Boundaries

F2 session state/reauthorization/local continuation, F3 Bun WS, F4 Workers WS and capability claims are excluded. No commit/push/deploy/configuration change. All product edits are in the assigned verify worktree and below vnext.

## Implemented interface and lifecycle

`startResponsesTurn(args)` in `responses/serve.ts` starts the existing authorized preparation/attempt once and returns immediately. `createResponsesTurn(result | prepareFactory, options)` in `responses/turn.ts` supplies the shared lower-level controller. Public turn members are `events`, `abortController`, `completion`, `ready`, `wantsStream`, `mergedInputItems`, and `recordSentPayloadBytes`. `completion` is registered with platform `waitUntil` at creation, before asynchronous preparation or iteration. It resolves with outcome, optional successful canonical response, and truthful `cleanupComplete`.

`prepareTemplate` retains parse/preprocess/key mapping/affinity/quota/attempt in the generic kit. `serveTemplate` remains the existing rendering/dump wrapper for all other endpoints. Responses HTTP now only renders the canonical turn. Existing already-rendered legacy input is normalized by an isolated adapter; no normal execution path consumes its own HTTP SSE response, and no WS implementation has been added.

The canonical Responses barrier reconstructs final output with `ResponsesFinalOutput`, uses one request-local `AffinityEgress`, awaits the existing snapshot writer, and yields one terminal last. JSON does not finalize/sign intermediate output items it never exposes: the terminal's authoritative output is signed once and that exact representation is saved. SSE retains C01's already-finalized opaque-item identity. Failed/incomplete/cancelled completion exposes no reusable `completion.response`.

The renderer stops keepalive before every terminal and closes immediately on caller cancellation. The controller continues to own the already-started storage promise and required cleanup. Source iteration is closed on cancellation before consumption, while paused on a yielded event, during a pending read, and on iterator return/throw. Legacy SSE and pending legacy JSON body readers are also cancelled and released. Usage/performance and the awaitable `DumpAccumulator.finalizeTurn` are in the controller's completion; the dump finalizer is still invoked if telemetry cleanup throws. HTTP headers and sent byte counts are retained without an HTTP tee that could keep inference alive after disconnect.

## Accepted terminal-tail policy

Root explicitly approved these constants before implementation:

- `STREAM_TAIL_TIMEOUT_MS = 1_000`: absolute deadline after terminal eligibility, never extended by incoming tail frames.
- `STREAM_TAIL_MAX_FRAMES = 256` and `STREAM_TAIL_MAX_BYTES = 1_048_576`: bound internal tail observation, including the translator's pending tail.
- Responses/Messages lifecycle terminal begins internal-only tail observation. Late ordinary output and duplicate terminals do not reach the client. An explicit late error invalidates withheld success. Explicit failure stops immediately.
- Chat begins the finish-based deadline only after all expected request `n` choices have finished; `[DONE]` remains the required whole-turn terminal. `finish_reason -> usage -> DONE`, including `choices:[{index:0}]` usage placeholders, preserves actually observed sparse counts. Unknown usage stays unknown and real zero stays zero. The existing all-zero usage-row omission policy is unchanged.
- Deadline/frame/byte exhaustion emits failure and aborts the request-owned producer, while leaving the caller abort controller un-aborted. It never guesses a successful terminal. Production source attempts forward a distinct `abortUpstream` callback through translated hub attempts.
- Iterator return and final metadata observation each have a separate 1,000 ms cleanup bound. A hostile unresolved `next`/`return` or unavailable final metadata sets `cleanupComplete:false`. Metadata fallback uses the already-known execution identity plus actually observed usage; it does not fabricate counts or change the outcome to caller cancellation. Final metadata observation is not inference permission.

## Tests-first evidence and intentional expectation revisions

Initial `turn-barrier.test.ts` run: 0 pass / 8 fail, `/tmp/c12-f1-red.log`, proving direct/telemetry-wrapped native ordering, late error/save suppression, failed/incomplete/error terminal-last, and no-retention legacy SSE behavior. Subsequent targeted RED logs cover unconsumed cleanup, stalled translator, cancellation before preparation, unavailable metadata, paused-consumer cancellation, iterator throw, JSON canonical affinity authority, unconsumed legacy readers, dump HTTP metadata, and dump cleanup after telemetry failure. Matching GREEN logs are in `/tmp/c12-f1-*`.

Root-approved dated revisions in the existing `responses/respond.test.ts`:

1. Cancellation usage coverage now emits a preterminal created event, waits until incomplete usage is internally observed, and then cancels. It no longer requires an incomplete terminal to escape ahead of a stalled tail.
2. Cancellation during a blocked save now expects the bounded source tail to have drained before the save started; cancellation still suppresses the successful terminal.
3. Legacy completed-with-never-EOF no longer expects snapshot save to start. It now asserts bounded explicit failure, zero saves, producer cancellation and released stream lock. Separate EOF-before-save tests preserve blocked-save cancellation coverage.

The placeholder failure found by root was reproduced on accepted C01 and localized to the existing Chat whitespace guard's unchecked `choice.delta.tool_calls` access, not the Responses translator. A focused RED test precedes the optional-delta fix; usage-only placeholder chunks remain intact.

## Verification commands

Run from the assigned worktree's `vnext/`:

```sh
bun test packages/gateway/tests/affinity packages/gateway/tests/data-plane/chat-flow/responses packages/gateway/tests/data-plane/chat-flow/shared packages/gateway/tests/data-plane/chat-flow/chat-completions packages/gateway/tests/data-plane/chat-flow/messages packages/chat-flow-kit packages/gateway/tests/dump-route-activation.test.ts packages/gateway/tests/dump-accumulator.test.ts
bun run --filter '@vibe-llm/gateway' --filter '@vibe-core/chat-flow-kit' --filter '@vibe-llm/protocols' typecheck
bun run scripts/check-framework-purity.ts
```

ESLint was run on all 16 owned TypeScript paths using explicit argv from the owned working-tree path inventory, then repeated on the final changed turn/renderer/test files. `git diff --check` is the final whitespace gate. Logs: `/tmp/c12-f1-focused-final.log`, `/tmp/c12-f1-typecheck-final.log`, `/tmp/c12-f1-lint-final.log`, `/tmp/c12-f1-lint-last.log`.

Full CI, independent review, frozen actual HTTP/Bun/SQLite/D1 probes, C01 all-protocol runtime regressions and manifest-based integration belong to root. Root's mutable probes were reported passing, but this report does not promote them into writer-owned frozen acceptance.

## Explicit limitations

- This is F1 only: no WS session machine, upgrade, warmup, multiplexing, connection-local history or platform capability publication.
- A storage write that was already started cannot be rolled back by the current store API. Caller output closes and no reusable turn completion is exposed; completion still awaits the actual write. The durable store may finish that previously-started write after cancellation. No timeout is falsely presented as storage cancellation.
- The generic turn does not impose a total generation deadline before a terminal. Existing request cancellation remains its stopping mechanism. A hostile JavaScript iterator that ignores abort cannot be forcibly interrupted; bounded cleanup explicitly reports incomplete ownership rather than continuing to pull or claiming it ended. Actual network cancellation is root's runtime acceptance boundary.
- Existing overall response/output accumulation bounds are unchanged; F2 owns whole-turn event and send-buffer limits. This change bounds only terminal-tail accumulation/observation.
- No environment variables, migrations, deployment, live configuration, commit or push. Unrelated worktrees were not modified.

## Final writer handoff — DONE / FROZEN

Final focused verification: **685 pass, 0 fail, 2,347 assertions across 76 files**. All three touched-package typechecks passed. Framework purity passed. Owned-path ESLint passed (only the tooling multiple-tsconfig advisory); final repeated lint passed. `git diff --check` passed. Final turn-specific suite contains 24 tests.

Product bytes are frozen by `task-C12-F1-owned.json` SHA-256 values; root owns review/CI/runtime acceptance and integration. No more product edits without a concrete review/acceptance finding.

Owned paths:

- `vnext/packages/chat-flow-kit/src/serve-template.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/chat-completions/interceptors/with-tool-argument-whitespace-aborted.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/messages/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/attempt.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/respond.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/stream-tail.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/translate-stream.ts`
- `vnext/packages/gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts`
- `vnext/packages/gateway/src/shared/dump/accumulator.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/chat-completions/interceptors/with-tool-argument-whitespace-aborted.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/respond.test.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/turn-barrier.test.ts`
- `vnext/packages/protocols-llm/src/common/invocation.ts`

## Review fix round 1 — DONE / FROZEN

Restart verification confirmed HEAD `c4ec998888028c0b73397a5d642de3c9fb1d5e0d` and all 16 initial product hashes matched the initial owned manifest before editing. The initial manifest is preserved as `task-C12-F1-initial-owned.json`. Only unified findings R1–R3 were changed; terminal tail 1,000 ms / 256 frames / 1 MiB, cleanup bounds, early completion registration and catalog timeout coverage remain unchanged.

- R1: the non-event turn finalizer now forwards an upstream error's explicit `targetApi` into performance persistence. Undefined targets retain the existing fallback. The existing traverse translation regressions remain intact.
- R2: the turn retains the canonical terminal/error body and supplies it to `DumpAccumulator.finalizeTurn`. The accumulator serializes it only when no frame log exists; existing frame-log precedence remains unchanged. HTTP JSON and the turn share the terminal-to-body mapping, including sanitized snapshot persistence errors. No HTTP tee, extra inference consumer or background stream reader was added.
- R3: the existing refusal/failed-JSON fixture explicitly initializes a collecting background executor and drains it before platform reset. Production mandatory `waitUntil` registration is unchanged.
- Added three regressions in the existing dump-accumulator fixture using real SQLite, FileDumpStore and the real turn/renderer. They inspect stored bytes, exact HTTP/body agreement, status, payload length and completed cleanup for legacy JSON success, snapshot failure and upstream failure. Only its existing in-memory file provider is reused; no database mocks were added.

Tests-first evidence: `/tmp/c12-f1-fix1-dump-red.log` contains **0 pass / 3 fail**, each finding stored `none` instead of `bytes`. `/tmp/c12-f1-fix1-existing-red.log` independently reproduces the uninitialized-background refusal fixture (**1 pass / 1 fail**). The initial command used a nonexistent tests-directory traverse path, so that RED log is only refusal evidence; the correct source-colocated traverse test was subsequently run and is included in final validation. Root owns the existing R1 actual HTTP/SQLite RED evidence.

Final commands from `reference-adoption-verify/vnext`:

```sh
bun test packages/gateway/tests/data-plane/chat-flow/responses packages/gateway/tests/dump-accumulator.test.ts packages/gateway/tests/data-plane/chat-flow/refusal-failed-json.test.ts packages/gateway/src/data-plane/chat-flow/shared/traverse-translation.test.ts
bun run --filter '@vibe-llm/gateway' --filter '@vibe-core/chat-flow-kit' --filter '@vibe-llm/protocols' typecheck
bun run scripts/check-framework-purity.ts
```

Results: **267 pass / 0 fail / 791 assertions / 23 files** (`/tmp/c12-f1-fix1-final-tests.log`); all three package typechecks exited 0 (`/tmp/c12-f1-fix1-final-typecheck.log`); purity passed (`/tmp/c12-f1-fix1-purity.log`). Earlier focused validation was 252 pass, with the separate correct traverse file 15 pass / 61 assertions; final combined validation supersedes those counts.

ESLint executed `bun x eslint` with explicit argv for all original 16 owned paths plus the two newly owned fixture paths, removing the `vnext/` prefix for the working directory. Exit 0 (`/tmp/c12-f1-fix1-lint.log`); inherited warning only: the existing unused `beforeEach` import at dump-accumulator.test.ts:8. The tooling also emits its multiple-tsconfig advisory. Neither inherited warning was changed. Scoped `git diff --check --` for the five fix1-changed paths ran from the worktree root and exited 0.

The updated `task-C12-F1-owned.json` object explicitly owns 18 paths and contains their final SHA-256 hashes. Fix1 modifies only five product/test files: responses/turn.ts, responses/respond.ts, shared/dump/accumulator.ts, dump-accumulator.test.ts and refusal-failed-json.test.ts. The latter two are the only ownership additions. Root's evidence documentation is retained and is outside writer ownership.

No full CI, root runtime probes, catalog edits, commit, push, deployment, live configuration or subagents. Root owns final independent review, full CI and the 22-group actual HTTP/SQLite/file acceptance. Product bytes are frozen pending that acceptance.
