# Final exceptional capture ownership correction

Date: 2026-10-01. Base HEAD: `3a44ab100225a129ddb00c1014f516b6c3ba8f38`.

## Scope and ownership

Addresses the single verified P2 in `whole-branch-review.md`: ordinary preparation or responder rejection could leave a permanent environment capture reservation, even after request preparation and the request itself had ended.

The nine owned files are listed in `final-fix-owned-paths.txt`, with exact frozen SHA-256 values in `final-fix-owned.sha256`. `final-fix-owned.diff` includes all eight tracked changes and the new real-SQLite regression file. No Git index, commits, push, deployment, services, dependencies, original overlays, aggregate plan, or research README were changed by this agent.

## Correction

- `DumpAccumulator.abandon()` seals frame/request/observation references and chooses one terminal retirement promise. It never invents an HTTP status or a failure row. Only internally owned collectors are abandoned; attached collectors retain their external owner.
- Already-started request preparation remains charged until it settles, including rejection. If persistence was already selected, abandonment returns that exact terminal promise, so neither storage nor publication can be bypassed by a later exception.
- Collector cleanup and background scheduler failures cannot stop accounting retirement. The construction-captured executor receives the work; promise rejection is observed even if executor registration throws.
- `KitDumpSink.abandon` is optional for domain-neutral sink compatibility. The production `DumpAccumulator` always implements it. Shared `serveTemplate` uses `withDumpExceptionCleanup` around preparation, responding, and finalization, preserves the exact thrown value, and does not delay that error while cleanup is pending.
- The helper is non-async and directly returns `work()` when no abandon hook is present. Dump-disabled and legacy generic-sink calls acquire no additional Promise/await layer from the guard. The wrapping callback is still an ordinary closure allocation; no performance claim or benchmark is made.
- The same guard covers confirmed direct terminal owners: both count-token serves, embeddings, image generation/edit routes, and the Ollama Chat adapter.

Abandonment differs from visible capture overflow: overflow continues to record terminal metadata with an explicit omission reason. An exception that previously escaped before any response/finalization continues to escape without manufacturing a new row. The change only supplies the missing resource owner exit.

## Direct caller audit

| Caller | Ownership decision |
| --- | --- |
| Chat Completions, Messages, Gemini generation | Shared `serveTemplate` now guards prepare/respond/finalize rejection. Real cancelled catalog preparation is reproduced for all three. |
| Messages/Gemini count tokens | Guard the whole public serve; key routing, translation and binding lookup previously preceded the provider-fetch try/catch. Real SQLite configuration failure exercises both. |
| Embeddings | Guard everything after `openRequestDump`, including mapping, binding/pricing, attempt rethrow, error forwarding and finalization. |
| Images generation/edit | Guard everything after opening the accumulator; edits also cover JSON normalization and multipart reconstruction. |
| Ollama Chat | Guard after opening the dump, covering malformed-body conversion before shared serve. Existing selected terminal persistence remains authoritative for errors after handoff. |
| Alpha search | Existing handler already selects `failed` plus numeric `finalize(500, [])` in its catch; it is not the missing exceptional ownership path. No behavior change. |
| Responses HTTP / turn / WebSocket | Async preparation failure is caught by `createResponsesTurn`, rendered by consuming turn events, and finalized by that turn's `finally`/`finalizeTurn`. WebSocket catch aborts an assigned turn and its finalizer waits completion. Do not wrap `prepareTemplate` or abandon a live turn from another owner. The structural HTTP/WS pre-handoff synchronous windows identified during the audit were not reproduced with legal request input; no speculative changes were made. |
| Ordinary HTTP adapter setup | Buffer/parser, `readObsCtx`, and `ClientDisconnect` handoff were inspected. The actual cancelled preparation escapes through shared serve and is covered. No independently reproduced setup-only failure was added to scope. |

## Evidence

### Before

`final-fix-probe-red.log` is the unchanged independent review probe, using production `serveChatCompletions`, real Bun SQLite, `FileDumpStore` and filesystem storage:

```text
serve rejection: Model catalog aborted
retained after cancelled serve: 856
later capture: { state: "omitted", reason: "environment_limit" }
retained after later finalized: 856
retained after explicit manual finalization: 0
```

The initial regression run in `final-fix-tests-red.log` independently fails the three production cancelled serves and the respond/cleanup paths on retained `856` versus expected `0`. That initial run also contains fixture-only count-token failures (uninitialized dial retry and an expected error-text mismatch); those entries are not additional product findings. The corrected fixture uses actual SQLite schema failure with no dial/network retries and is included in final green evidence.

### After

`final-fix-probe-green.log` reruns the reviewer probe without modification:

```text
serve rejection: Model catalog aborted
retained after cancelled serve: 0
later capture: { state: "omitted", reason: "capture_limit" }
retained after later finalized: 0
retained after explicit manual finalization: 0
```

The probe intentionally budgets only 1000 bytes. Its request reserves 856, then its later `{ ok: true }` canonical fallback exceeds the remaining per-capture allowance. This valid `capture_limit` is distinct from the removed permanent `environment_limit`. The regression's next capture finalizes without that unnecessary fallback and verifies the exact 200-byte request body is admitted, persisted and read back, with no omission flag.

`dump-exception-ownership.sqlite.test.ts` covers:

- Three real production cancelled serves and subsequent exact payload admission.
- Production kit respond rejection with exact original error identity, immediate propagation while preparation is held, and release only after preparation settles.
- Late frame/success/finalization cannot reopen capture or create a second terminal record after abandonment.
- Request preparation, captured scheduler and collector cleanup failures cannot replace the request error or leak admission.
- A write already waiting on real file storage remains charged and keeps its original status after a later exception.
- Both direct token-count binding failures with real SQLite configuration failure.
- Embedding/image handlers with a concrete sink hook failure after confirmed request preparation/admission; these are injected diagnostic-hook failures, not claimed binding-network reproductions.
- Ollama conversion of a malformed `messages` value before shared-serve handoff, with confirmed request preparation and subsequent release.

No database mocks are used. File storage is real; controllable subclasses delay or reject preparation and a real file provider is gated to test ownership. The kit tests separately cover absent, synchronously throwing and rejecting optional cleanup hooks.

### Verification on frozen source

- `final-fix-focused.log`: **169 passed, 0 failed**, 945 assertions across 10 affected test files (kit, new SQLite lifecycle, capture budget, accumulator/persistence/terminal/sidecar, embeddings/images, Ollama).
- `final-fix-tests-green.log`: initial focused **41 passed, 0 failed** across kit and new lifecycle regressions.
- `final-fix-typecheck-gateway.log` and `final-fix-typecheck-kit.log`: both scoped typechecks exit 0.
- `final-fix-eslint.log`: ESLint on all nine owned source/test files exits 0.
- `final-fix-purity.log`: framework purity OK.
- `git diff --check`: exit 0.

Full branch CI and independent scoped re-review belong to the parent. This correction does not close the separately deferred metadata/publication-concurrency budget gap or establish production performance/rollout readiness.
