### Spec Compliance

- ✅ **F2 behavioral spec: compliant within the reviewed foundation scope.** The changes provide a shared-pipeline, bounded session owner rather than an HTTP SSE adapter. Fresh authority, one active admission, previous-completion gating, private continuation, zero-inference warmup, and explicit transport limits are present. This is not overall task approval: the mandatory repository gate fails as described below.
- ✅ Reviewed base `53c26f81d2bd5131dfb816efbda20700a0f54410` to the uncommitted frozen candidate using `task-C12-F2-review-package.diff`, in sequential chunks. All 14 manifest paths matched `task-C12-F2-frozen-sha256.json` before and after review. Diff SHA-256: `ee21ea9a5dfbc7869d1071e379d619bc14504d73ca57a5222c08b65e564f432b`.
- ⚠️ **Cannot verify from this diff:** native Bun upgrade/message/drain/close behavior; Workers WebSocketPair lifetime, actual pressure handling and request context; pinned Rust ModelClient acceptance; platform capability publication. Those are F3/F4 acceptance obligations. Neither the session fixtures nor the controller's additional runtime evidence establishes native socket/current-client compatibility.
- ⚠️ F1 terminal/tail, opaque affinity-carrier and complete HTTP preservation contracts span unchanged code. The changed integration preserves the F1 entry point and completion result (`vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts:235`, `session.ts:247`); the controller must retain its separate F1/HTTP/affinity gates. No broad compatibility or production-state conclusion is made here.

### Strengths

- **Authority is genuinely refreshed per admitted turn.** `vnext/packages/gateway/src/repo/configuration-cache.ts:164` waits the pre-existing refresh and invokes a new load; `configuration-cache.ts:250` bypasses cached and pending session lookups. `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:177` waits the predecessor before `session.ts:183` performs fresh auth, and `session.ts:187` fences user/key/auth-kind identity. Real second-connection SQL revocation tests are in `vnext/packages/gateway/tests/configuration-fresh.sqlite.test.ts:22`, `:51`, and `:66`.
- **HTTP auth policy remains separated from WS owner enforcement.** `vnext/packages/gateway/src/control-plane/auth/session-auth.ts:53` retains HTTP extraction precedence; the extra owner requirement is explicit at `session-auth.ts:108`, and WS requests opt into it at `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:54` and `:185`. Existing ordinary `pinnedView()` is unchanged; the new scope is separate at `vnext/packages/gateway/src/repo/index.ts:62`.
- **The lifecycle barrier is explicit and bounded.** `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:234` releases successful terminal admission while retaining one settling job; `session.ts:247` requires actual completed outcome and complete cleanup before publication. `session.ts:290` admits only one successor and registers its owner before the asynchronous run at `:293`. `session.ts:98` publishes the idempotent closing promise before calling native close.
- **Warmup and continuation reuse production preparation.** `vnext/packages/gateway/src/data-plane/chat-flow/responses/serve.ts:148` resolves private state before retention-gated durable lookup; `serve.ts:168` excludes warmup from durable save; `serve.ts:211` dispatches shared selection-only validation. `attempt.ts:245` emits the matching created/completed pair without entering generation. `session-protocol.ts:23` rejects explicit warmup `store:true`. `local-continuation.ts:20` and `vnext/packages/gateway/src/data-plane/dispatch/responses-store-bridge.ts:72` share the canonical compaction window.
- **The limits reflect observable platform capabilities.** `vnext/packages/gateway/src/data-plane/chat-flow/responses/session-limits.ts:1` defines the approved byte/time constants. `session.ts:120` enforces a lifetime total for unobservable transports; `:124` rechecks native-boundary capacity; `:138` uses an absolute drain deadline; `:198` rejects uncacheable warmup before acknowledgment. `local-continuation.ts:15` is a single private serialized slot, with logical expiry at `:31`. Failed sends are not replayed.

### Issues

#### Critical (Must Fix)

- None found in the scoped frozen diff.

#### Important (Should Fix)

1. **Move reusable auth below the control-plane boundary.** `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:2` imports runtime helpers and `FullAuthCtx` from `control-plane/auth/session-auth.ts`. This violates the existing one-way dependency rule in `vnext/eslint.config.mjs:25` and fails the real mandatory CI gate (`/tmp/vnext-c12-f2-ci.log:7155`, `import/no-restricted-paths`). The session now depends on an HTTP/control-plane middleware module, including its unrelated prewarm/DMR dependencies. Extract the common credential/header resolution and auth types into a permitted shared/repository-facing module, with any required lower-level validation moved alongside it; let both middleware and session import that module. Preserve the existing HTTP policy and WS enabled-owner option. Do not suppress or relax the boundary rule.

#### Minor (Nice to Have)

1. **Two new test declarations fail lint.** `vnext/packages/gateway/tests/data-plane/chat-flow/responses/session.sqlite.test.ts:388` and `:548` trigger `prefer-const` in the same CI run (`/tmp/vnext-c12-f2-ci.log:7179`). Use a const-safe closure arrangement or an explicit mutable holder for the callbacks. This is a mechanical issue, but both errors must be removed before the mandatory gate can pass.
2. **Full-gate output is not pristine.** `/tmp/vnext-c12-f2-ci.log:7126` reports the multiple-tsconfig warning, and `:7230` reports 35 lint warnings in addition to the three errors. The warning locations are outside the changed F2 paths; they are not evidence of an F2 behavior regression. Keep this existing noise explicit in the final gate report rather than describing the full output as warning-free; unrelated cleanup need not expand this task.

### Checks and Scope Discipline

- **Named risk: source input/defaults could be lost by private continuation capture.** Checked only `vnext/packages/gateway/src/data-plane/parsers.ts:84` and its canonicalizer `vnext/packages/protocols-llm/src/responses/canonicalize.ts:81`. The existing parser lifts string input into an item array and preserves passthrough create fields before the new capture, resolving the suspected string-input loss. The real native/translated warmup fixture also asserts recovered input, instructions and tools.
- **Named risk: the new owner could publish before F1 cleanup or lose cancellation ownership.** Checked only `vnext/packages/gateway/src/data-plane/chat-flow/responses/turn.ts:237`–`:340`. The existing turn propagates abort upstream, owns preparation/finalization, and settles completion with actual outcome and cleanup status. The session consumes that result and does not replace it with a fabricated success.
- **Named risk: extracted auth crosses a forbidden layer.** Checked only the matching zone declarations in `vnext/eslint.config.mjs:23`–`:35` and the controller's existing CI log. Confirmed Important issue 1; no broader dependency crawl was performed.
- **Observed writer evidence:** `/tmp/vnext-c12-f2-final-tests.log` contains 53 pass / 0 fail / 163 assertions and no warning/error noise; `/tmp/vnext-c12-f2-final-typecheck.log` exits 0. These are read logs, not reviewer reruns.
- **Observed controller evidence:** `/tmp/vnext-c12-f2-ci.log:7120` records 4,931 pass / 1 skip / 0 fail and 85,061 assertions, followed by lint failure. The skip is the named existing X25519 fixture. CI therefore did not establish later UI-build/Wrangler stages. `/tmp/vnext-c12-f2-frozen-runtime.log` ends with `ALL 22 PASS`; these controller-run probes are supplementary evidence, not a native F3/F4 adapter acceptance.
- **Read-only check:** no suites, runtime probes, Git commands, product edits, index/HEAD changes, service operations, or subagents were run by this reviewer. Only this requested scratch review report was written. The initial combined read was output-truncated; the affected diff portion was read again in bounded chunks to obtain the complete package, not to broaden the review.

### Assessment

**Task quality: Needs fixes.**

**Reasoning:** The reviewed F2 behavior and its real SQLite/loopback coverage support the foundation spec; no additional Important behavioral defect was found. The new forbidden dependency and two test lint errors prevent the required repository gate from passing, so acceptance must wait for a permitted shared-auth extraction and fresh gate evidence for the resulting candidate.
