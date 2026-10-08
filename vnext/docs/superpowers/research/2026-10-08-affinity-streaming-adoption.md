# Conditional affinity and upstream streaming adoption

## Scope

Approved by the user after comparing functional benefits. Product base: `0825985529b7430673efaffc3c84aa4b64116f5e`. Reference: `1d7dcd923e260e425120cca0c7a240e93720af27` in `copilot-gateway`. Local delivery only; no deployment, production changes, dependency installation or inclusion of unrelated work.

## Contracts and decisions

**Affinity:** vNext already implements authenticated opaque-state origin, exact/compatible/degraded/unavailable selection, complete-block binding, and conditional signing. Preserve it instead of introducing metadata-only carriers for plain text. New tests verify ordinary/empty JSON and SSE across four protocols do not load the codec or create a secret. Real Bun/SQLite tests verify SSE-to-JSON signing stays single-layer and replay recovers the original opaque value. No affinity production code changes or reference wire-format interoperability are claimed.

**Upstream streaming:** the shared `provider-llm/streaming-generation.ts` policy requests SSE for Custom/Copilot Chat Completions, Messages and Responses generation. Native compact, count-tokens, embeddings, images and other calls retain their transport semantics. An existing compact shim that explicitly pivots to a generation action uses the generation policy while preserving the client's compact JSON response. Custom applies it before serialization; Copilot before provider normalization and prepared-call caching. Chat's gateway attempt resolves the same policy before its existing include-usage/vendor normalizers. The provider helper does not reintroduce usage options afterward.

Source payload and downstream JSON/SSE preference remain separate from the upstream wire preference. Upstreams that ignore SSE and return JSON still enter the existing synthetic-frame pipeline. Chat retains its JSON-client fallback for missing or nonstandard JSON content types; an explicit SSE content type takes priority. There is no automatic replay with `stream: false`. Incremental tool-argument guards now also stop degenerate generation before a JSON client would otherwise receive the full result; socket cancellation does not prove upstream billing stops.

**Measurement:** `upstreamTtftMs` adds one sample per provider invocation that produces a recognized native output event (text, reasoning or tool arguments). It starts before `provider.fetch` and ends at the first parsed output event, including provider preparation, credential refresh and internal retries. It is not a separate timer for every HTTP attempt. It excludes waits between provider invocations and applies independently of the downstream stream preference. Native JSON, control-only and output-free invocations have no sample. The metric counts provider invocations, so sample count may exceed request count. Existing downstream TTFT, first-text and gap semantics are unchanged.

Collection keeps one extra timestamp per call and stops output classification after the first match. Generic metric storage needs no migration; older readers ignore the new name and historical requests are not backfilled. The diagnostics table labels it separately. This is gateway-observed timing, not a model-internal token timestamp or client first-byte time.

## Execution checklist

- [x] Confirm existing affinity behavior and cover conditional egress/replay.
- [x] Implement provider generation policy with source ownership, retry and exclusion tests.
- [x] Preserve Chat usage before vendor normalization and cross-protocol JSON output.
- [x] Add separate upstream first-output measurement and diagnostics.
- [x] Verify early failure/cancellation and native JSON fallback with real gateway/SQLite/loopback fixtures.
- [x] Independent review, including MIME fallback and Ollama compatibility.
- [x] Full local CI on the delivery artifact.
- [ ] Merge into local `vNext`, preserving unrelated dirty files.

## Targeted validation

- Provider scope: 349 tests passed; three package typechecks passed. New request tests failed on old non-streaming wire behavior (14 failures) before the implementation passed.
- Affinity scope: 155 tests passed. Fixture corrections are not product bug reproductions; existing production code was retained.
- Integration: 30 tests passed, including nine JSON source/target pairs, native JSON fallback, actual/synthetic first-output timing, and six early cancellation cases. Before implementation, 18 failed on the old upstream stream preference. Review found an untyped Chat JSON fallback regression; six additional missing-content-type/text-plain cases failed with 502 before the fix and passed with 200 afterward.
- Performance recorder: 14 tests passed; two new real-output timing cases failed before implementation. Synthetic/control-only calls remain without samples.
- Ollama: nine tests passed. An older fixture returned different JSON and SSE text; the fixture now describes one reply, and assertions cover upstream SSE/usage plus complete downstream JSON/NDJSON output.
- Independent final review: 44 integration/observer tests passed; no remaining product blockers. The Ollama fixture adjustment also passed a separate source review.
- CI prerequisite repairs: generate Dashboard assets with `bun run build:ui` before running CI on a clean export. Two inherited measurement-harness lint errors were corrected without changing frozen measurement data: use an ESM crypto import, and throw a recorded cleanup error after `finally`. Eight observer tests passed, including original-error identity and absence of a successful receipt when cleanup also fails.

## Full local acceptance

Validated Git tree: `11f142a204af60037f4cda6b7939ed2ab0f669d7`. The isolated export contained the delivery files and copied installed workspace dependencies, excluding both worktrees' unrelated uncommitted work. Subsequent tracking-document edits do not change the validated implementation or tests.

After generating UI assets, `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` exited with code 0: framework purity, workspace typechecks, 6,187 passing tests across 578 files, one existing runtime-dependent skip, zero failures, lint with zero errors and 39 inherited warnings, setup/UI builds, and the Workers deployment dry-run. The dry-run did not deploy a Worker. Validation logs and the artifact manifest are retained in the worktree's ignored `.superpowers/sdd/2026-10-08-affinity-streaming-adoption/` directory.

## Remaining measurement and release boundaries

This adds functionality, not a proven speed or memory improvement. SSE parsing and JSON reassembly add work to previously native-JSON paths. Previous reference-comparison measurements describe their frozen artifacts; they do not measure this implementation. The next uninstrumented local workerd comparison should match upstream SSE work and cover JSON aggregation, opaque continuation and ordinary text, reporting CPU, latency and peak memory separately.

Upstreams that reject `stream: true` instead of honoring or ignoring it remain unqualified online. No automatic JSON retry is added because generation may already have started. CFW deployment and existing rollback/storage compatibility release gates remain outside this local delivery.
