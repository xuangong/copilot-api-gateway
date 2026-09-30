# Final exceptional capture ownership re-review

Date: 2026-10-01. Scope: the single P2 in `whole-branch-review.md` and its frozen nine-file correction against `3a44ab100225a129ddb00c1014f516b6c3ba8f38`.

## Independent verdicts

- **Spec: approved for the implemented scope.** The correction closes the preparation/respond exceptional-exit ownership gap without manufacturing an HTTP status or diagnostic row, changing the original thrown value, or releasing in-flight preparation/persistence early.
- **Quality: approved.** No remaining material findings in the scoped delta. The prior whole-branch P2 is **resolved and superseded by this re-review**. The earlier whole-branch review found no other material source defects, and its accepted test-only CI migration remains unchanged.

This supersedes the earlier changes-required source verdict for the combined candidate plus this frozen correction. It is independent of the parent's still-running integrated CI and does not establish production performance or deployment readiness.

## Verified correction

`DumpAccumulator.abandon()` at `vnext/packages/gateway/src/shared/dump/accumulator.ts:301` synchronously seals frame/request/observation references, selects one terminal promise, and abandons only an internally owned upstream collector. Retirement still waits for the constructor's body-free preparation-settlement receipt. Cleanup rejection or scheduler registration failure cannot bypass the retirement finalizer. When a write was already selected, abandonment returns that exact promise and leaves its storage/publication lifetime intact. Later frame and finalize calls cannot reopen capture or produce a replacement record.

`withDumpExceptionCleanup()` at `vnext/packages/chat-flow-kit/src/serve-template.ts:56` preserves the original thrown value and starts diagnostic cleanup without waiting for it before propagating the request error. The optional hook preserves generic sink compatibility. With an absent/null/no-hook sink, the helper directly returns `work()`; an independent executable check confirmed original Promise identity and synchronous error identity for all three cases. This is a control-flow check, not a performance measurement. The enclosing callback remains an allocation, as disclosed in the implementation report.

The shared serve wrapper covers preparation, responding and finalization. Both count-token serves, embeddings, image generation/edit and Ollama Chat additionally guard their direct ownership scope. I reconstructed the prior direct-caller files from the supplied unified diff and compared whitespace-normalized contents: their changes consist only of the import and enclosing guard, with original bodies preserved. Responses async preparation remains with its existing turn owner; alpha search retains its existing catch/finalize path. No auth, provider, quota, transport completion or payload transformation policy is altered by this delta.

## Independent evidence

All nine current file SHA-256 values match `final-fix-owned.sha256`. Reviewed `final-fix-owned.diff`, `final-fix-report.md`, `final-fix-owned-paths.txt`, the new regression sources and the actual owner call paths. No product files or Git state were modified by this reviewer.

Ran only the following focused checks:

- Original unchanged leakage probe: `final-fix-review-probe.log` in the worker evidence directory. The cancelled production serve still rejects with `Model catalog aborted`; its retained reservation is now **0**, and remains 0 after the next capture and cleanup. The later `{ ok: true }` fallback produces `capture_limit` under the deliberately tiny 1000-byte per-capture policy, not the prior leaked `environment_limit`.
- Kit and new real-SQLite exceptional-ownership regressions: **41 passed, 0 failed, 160 assertions**, two files. `final-fix-review-tests.log` in the worker evidence directory. These independently prove exact next-request payload admission with no omission, all three cancelled generation serves, both count-token configuration failures, direct route failures, exact error preservation, no synthetic row, deferred preparation release, scheduler/collector failure handling and preservation of already-selected file persistence.
- No-hook fast path: `final-fix-review-fast-path.log` in the worker evidence directory. Original Promise/error identity preserved for undefined, null and legacy no-hook sinks.

The direct embeddings/image tests inject a diagnostic hook failure after confirming actual request preparation and reservation. They are correctly described as that failure category, not as network or binding failures. Persistence uses real SQLite and filesystem storage; no database mocks were added. The implementer's broader 169-test/typecheck/lint/purity results were read as supporting evidence and not relabelled as this reviewer's execution.

## Remaining qualification boundaries

**Task 6 remains partial overall.** Its retained-payload slice now covers the verified exceptional exit, but publication/metadata concurrency still needs explicit admission-failure semantics. Full ingress/materialization, legacy tee queues, optional upstream-prefix ownership, encoder/compression scratch and runtime overhead remain outside this estimate. Per-frame projection still adds traversal/container-copy work. The correction does not turn the budget into a whole-heap guarantee.

The parent owns final full CI, exact-artifact/source and overlay preservation checks, local integration and the final completion record. Production CPU/heap/latency comparisons, old/new data rollback compatibility, release/build qualification and any deployment remain separate gates. No broad tests, dependency installation, service restart, production/network operation, Git/index write or deployment was performed by this reviewer.
