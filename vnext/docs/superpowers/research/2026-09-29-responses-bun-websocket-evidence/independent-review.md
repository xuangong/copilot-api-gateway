# C12-F3 frozen task review

## Spec Compliance

- **✅ Spec compliant for the implementation visible in this frozen diff.** No Critical or Important source defect found. Reviewed base `970ac243230186982567517dd8784fd12e2473f2` plus the six-path frozen review package, including its three new files. This is a task-scoped code review, not frozen runtime acceptance or permission to publish capability.
- Exact four routes and complete GET/header matching are centralized in `vnext/packages/gateway/src/data-plane/chat-flow/responses/upgrade.ts:5-21`. Native authorization precedes `server.upgrade` in `vnext/apps/platform-bun/src/responses-websocket.ts:43-49`; known authentication/request failures, unavailable configuration, and unexpected errors map to bounded HTTP errors at `:25-32`. Unmatched requests retain `app.fetch` and the existing `/v1/` HTTP timeout handling at `:38-40`.
- Production uses the exported factory directly at `vnext/apps/platform-bun/src/server.ts:36`. Its package export is narrow (`vnext/packages/gateway/package.json:9`; `vnext/packages/gateway/src/data-plane/chat-flow/responses/public-session.ts:1-16`). All six changed paths are in vNext; the supplied complete package contains no Workers, capability, PRODUCT.md, collaboration-shim, migration, provider, or retention edits.
- Per-socket request/auth/session state is created at `vnext/apps/platform-bun/src/responses-websocket.ts:44-48,63-74`; positive/negative-one/zero send outcomes map correctly at `:75-77`, and drain only delegates at `:98`. Both native limits are explicitly 1 MiB via the imported constants, with `closeOnBackpressureLimit:false` and `idleTimeout:0` at `:58-62`.
- **⚠️ Frozen runtime gates remain with the controller.** The writer's mutable root-reported native/pressure/pinned-Codex results are not treated as frozen acceptance. Verify the frozen source against full CI, the independent Node upstream/native Bun matrix, actual slow-reader pressure and cancellation, and pinned Codex acceptance. The committed native test covers real SQLite, four handshakes, credential rejection, warmup/continuation and owner disable, but does not itself establish the complete required runtime matrix (`vnext/apps/platform-bun/src/__tests__/responses-websocket.test.ts:56-129`).
- **⚠️ Cross-cutting contracts:** owner/key/session authorization, provider identity, terminal durability, cancellation, opt-in retention, and unknown-versus-zero usage remain owned by the reused F2/F1 pipeline. The adapter does not add an alternate implementation. Full semantic acceptance, native max-frame behavior, abrupt-close abort, and a quiet generation exceeding 120 seconds cannot be established by the adapter diff alone (`vnext/apps/platform-bun/src/responses-websocket.ts:69-84,90-102`).

## Strengths

- The adapter is small and has one responsibility. It delegates protocol/state/cleanup to F2 instead of maintaining a second pending-message queue or continuation store (`vnext/apps/platform-bun/src/responses-websocket.ts:69-84,90-102`).
- Header authorization is performed before a native 101 and saved only in connection-local data. The concrete shared-auth check rejects query credential fields and resolves enabled-owner authorization in a fresh snapshot (`vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:46-57`); identity is rechecked for every admitted turn at `:183-188`.
- Native send exceptions are safely covered despite the adapter not catching `ws.send` locally: the shared boundary catches throws, maps them to failed delivery, and does not retry an accepted `-1` frame (`vnext/apps/platform-bun/src/responses-websocket.ts:75-77`; `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:124-135`). Pressure waits remain bounded at `session.ts:138-157`.
- Native close marks the socket closed before delegating, while F2 installs its close promise before invoking transport close. This avoids recursive close work and promptly aborts active/settling jobs (`vnext/apps/platform-bun/src/responses-websocket.ts:79-81,99-102`; `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:98-110`). The authoritative constants remain 5 seconds for drain and 25 seconds for cleanup (`session-limits.ts:5,11`).
- Each socket creates its own background executor; F2 registers the admitted job synchronously before entering awaited work under its scoped executor (`vnext/apps/platform-bun/src/responses-websocket.ts:66-72`; `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:288-294`; `vnext/packages/platform/src/background.ts:11-12,20-23`). There is no adapter-owned unbounded promise list.
- The new test uses a temporary file-backed SQLite database, real native WebSocket/TCP ingress and HTTP/SSE upstream, and wraps only the production open callback to observe the real session (`vnext/apps/platform-bun/src/__tests__/responses-websocket.test.ts:56-84`). No SQL or module mock is introduced.

## Issues

### Critical (Must Fix)

- None found.

### Important (Should Fix)

- None found in this task's frozen source.

### Minor (Nice to Have)

- **Retained regression breadth:** `vnext/apps/platform-bun/src/__tests__/responses-websocket.test.ts:56-129` puts the repository's native coverage in one happy-path/owner-revocation scenario. After the controller's frozen fixtures pass, retain representative abrupt-close, real pressure/no-retransmission, durable-terminal next-turn, and cross-socket isolation checks in the normal regression suite. The controller's separate acceptance gates satisfy the immediate verification division; this suggestion concerns future regression protection.
- **Reported validation noise:** `task-C12-F3-report.md:23` reports an inherited multiple-tsconfig ESLint advisory. It is not a demonstrated adapter defect and was not independently reproduced here, but the validation evidence is not completely noise-free. Preserve the advisory's provenance rather than describing the output as pristine; consolidate the ESLint project configuration separately if useful.

## Native API and stop-promise caveat

- Checked the actual verification checkout's `vnext/node_modules/.bun/bun-types@1.3.14/node_modules/bun-types/serve.d.ts:385-425,487`: the WebSocket handler declares message/open/drain/close/ping/pong and no separate WebSocket error callback. The `error` member at `:698` belongs to HTTP serve options. Therefore omission of an invented native WS error callback is not a missing adapter feature. Types describe API shape, not proof of Bun 1.3.0 runtime behavior.
- The source supports the report's narrow distinction: the test waits for native client `CLOSED` and explicitly asserts the observed session's `{ cleanupComplete: true }` before teardown (`vnext/apps/platform-bun/src/__tests__/responses-websocket.test.ts:125-129`). Only afterwards does it invoke, without awaiting, `server.stop(true)` and catch rejection at `:135`; it then closes SQLite and removes the fixture directory at `:137-139`. Production close behavior was not weakened by this test workaround.
- That sequence proves the assertions it makes about the final application session; it does **not** prove that Bun's server-stop promise settled or establish the root cause of the reported stop-promise hang. The installed type contract says `stop(true)` immediately terminates active connections and stops accepting, while returning a Promise (`serve.d.ts:835-844`). Treat the historical pending-promise observation as writer-reported runtime evidence, not a new reviewer reproduction or a proved Bun defect. Frozen native fixtures must continue checking upstream abort and bounded F2 cleanup independently of `server.stop` settlement.

## Focused checks and verification boundaries

- Read the execution brief, Bun design, writer report and entire frozen diff once. Read root/vNext AGENTS. No changed product file was separately reread, no Git command or mutation was performed, and no suite or runtime fixture was rerun.
- Named out-of-diff risks checked: (1) a native send throw escaping delivery accounting, (2) close recursion/abort/cleanup ownership, (3) per-socket background executor timing/scope and fresh header authentication, and (4) mismatch between Bun callback/stop contracts and the installed type API. Focused source checks were `session.ts`, `session-limits.ts`, `packages/platform/src/background.ts`, and the actual Bun 1.3.14 type declarations. An initial lookup found root Bun 1.3.11 declarations; conclusions above were checked again against the verification checkout's actual Bun 1.3.14 declarations.
- No broader provider, Workers, capability, deployment, or retention audit was performed. The independent frozen runtime/CI gates remain unresolved in this report, regardless of previously reported mutable results.

## Assessment

**Task quality: Approved (code review only; frozen acceptance gates pending).**

The factory preserves the accepted shared-session contracts and integrates through the exact production callbacks, with explicit native limits and no duplicate protocol state. No blocking source correction is required by this review; publication/integration still requires the controller's frozen CI, native runtime, pressure, and pinned-client evidence.
