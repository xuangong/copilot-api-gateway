# C12-F2 implementation report — frozen for root review

Base: `53c26f81d2bd5131dfb816efbda20700a0f54410`. Worktree: `reference-adoption-verify`. Sole product writer: implement_c12_f2. Product work is now frozen pending root review/gates. No commit, push, deployment, platform adapter, capability publication, live settings changes, migrations, or subagents.

## Delivered behavior

The gateway now has a bounded Responses session owner using the actual shared Responses execution pipeline. Native transport callbacks remain F3/F4 work. The session consumes canonical `ResponsesTurn.events` directly; it does not adapt HTTP SSE output. Existing F1 turn, terminal-tail, save, telemetry/cleanup and affinity-egress implementation is unchanged.

- One active admitted turn; malformed/unsupported/overlap messages never create a queue. Successful native terminal acceptance releases admission synchronously, but a successor waits the one previous completion before fresh auth/resolution/inference. Published local state requires completed outcome and complete cleanup. Failed/incomplete/cancelled state is evicted.
- Fresh message authorization starts its own authoritative revision read after any older pending refresh, retains existing revision/epoch consistency checks, and bypasses both session token caches. WS validates the owner and original credential identity again. HTTP retains its existing warm configuration lease and auth policy. Header extraction and credential resolution are shared with middleware without introducing control-plane prewarm into WS.
- Warmup reuses Responses parsing, expansion, model mapping, quota, affinity and actual binding selection, then stops before interceptors/tools/provider inference. It emits the created/completed pair with matching ID and retains full source create configuration for same-connection input:[] continuation. Explicit warmup store:true rejects; omitted/false store is local-only. No fabricated usage, billing or generation-performance rows are recorded. The prepared gateway context is not proof that model discovery/credential preparation makes zero network calls; only inference is excluded.
- Local continuation precedes the current retention-gated durable resolver. Latest-only state retains source create defaults and canonical input/output window, including the shared compaction replacement rule. State is private, size-bounded, logically expires after five minutes, and is cleared on close. Current model mapping/pin/owner/affinity is revalidated each turn. Durable retention remains opt-in and unchanged.
- Supported messages are flat response.create, including pinned stream:true; WS-only fields never reach upstream. Unsupported binary/event/multiplex/fork/stream/background modes reject explicitly. Gateway-specific overlap/error/close values are not claimed as OpenAI norms. Existing F1 bare internal error events are rendered into a recognized WS status envelope or response.failed after a known created response.
- Native send acceptance is not a peer ACK. Dropped/thrown/ambiguous sends cancel without replay. Bun-style backpressure acceptance is never resent. Unsupported buffer introspection remains explicit. All accepted Workers-style output counts against a conservative lifetime budget that never resets per turn.

## Public source API and construction

Module: `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts`.

```ts
const request = new Request("http://fixture/v1/responses", {
  headers: { authorization: "Bearer sk_c12_local_fixture" },
})
const authorization = await authorizeResponsesSession(request)
const session = createResponsesSession({
  authorization,
  request: { url: request.url, headers: request.headers },
  background: { waitUntil: promise => owner.waitUntil(promise) },
  transport: {
    pressure: { kind: "unobservable" },
    sendText: text => { socket.send(text); return "accepted" },
    close: (code, reason) => socket.close(code, reason),
  },
})
session.receiveText(text)
session.receiveBinary()
session.drain()
const result = await session.close() // { cleanupComplete: boolean }
```

The fixture must bootstrap the ordinary gateway platform/repo/cache/Responses store and seed a real owner/key/upstream. `authorization` contains the privately retained original credential plus an identity fence, not a reusable turn auth context. WS supports x-api-key, x-goog-api-key and Bearer headers in existing relative precedence, including ses_/legacy header credentials; query/cookie/dev/DMR-only credentials are not WS auth. `authorizeResponsesSession` rejects before upgrade; native adapters own HTTP rendering of that error.

`ResponsesSessionTransport.pressure` also accepts `{kind:"observable",bufferedBytes:()=>number}`. `sendText` returns accepted/backpressured/failed: Bun -1 maps to backpressured, zero to failed; Workers void success maps to accepted with unobservable pressure. Native adapters must not report unsupported pressure as zero. The optional `ResponsesSessionClock` supplies `now()` and `schedule(callback,milliseconds):cancel`, used for deterministic timer validation; execution/auth/DB/turn behavior is not injectable.

Each message establishes `withBackground` and `withRequestSignal`, then `withFreshConfigurationSnapshot`. The message cleanup owner is registered before its first await; F1 independently registers its turn completion at creation. F4 must supply a valid platform background owner and retain production compatibility date 2025-06-01/nodejs_compat; no adapter behavior or compatibility-date change is included here.

## Bounds and costs

Constants live in session-limits.ts: inbound 1 MiB; outbound frame 1 MiB; observable send high-water 1 MiB; turn events 16 MiB; local state 8 MiB/latest one slot; logical local TTL 300,000 ms; unobservable connection output 16 MiB; cumulative control replies 64 KiB; absolute drain deadline 5,000 ms; cleanup deadline 25,000 ms. Equality is allowed and UTF-8 bytes are measured.

The unobservable lifetime cap closes even a fast-reader connection after its budget is exhausted; reconnect loses private store:false history. TTL is checked on lookup, not advertised as idle timer reclamation. Oversized ordinary completion can be delivered without reusable local state if its wire frames fit; oversized warmup fails before acknowledgement. Canonical event caps do not claim to bound every pre-serialization object allocation inside a provider. Close timeout reports incomplete cleanup; an already-issued noncancellable save may finish under the previously registered F1 owner, without resumed inference or a claimed rollback.

## Verification performed by writer

Final new-feature tests, after all behavioral fixes:

```sh
cd vnext
bun test packages/gateway/tests/data-plane/chat-flow/responses/session.sqlite.test.ts \
  packages/gateway/tests/data-plane/chat-flow/responses/session-limits.test.ts \
  packages/gateway/tests/configuration-fresh.sqlite.test.ts
```

**53 pass / 0 fail / 163 assertions**, 4.08 seconds. Log `/tmp/vnext-c12-f2-final-tests.log`. Includes 42 real SQLite/loopback session cases, 8 parser/local-state boundary cases, and 3 file-backed SQLite/second-connection cache races. No mock.module or mocked SQL result acceptance.

Focused preservation suite, before the final session-only send/close race fixes:

```sh
bun test packages/gateway/tests/data-plane/chat-flow/responses \
  packages/gateway/tests/configuration-fresh.sqlite.test.ts \
  packages/gateway/tests/configuration-snapshot.test.ts \
  packages/gateway/tests/session-auth-prewarm.test.ts \
  packages/gateway/tests/responses-previous-id.e2e.test.ts \
  packages/gateway/tests/responses-retention-settings.test.ts \
  packages/gateway/tests/responses-snapshot-id-roundtrip.test.ts \
  packages/gateway/tests/affinity
```

**474 pass / 0 fail / 1,816 assertions**, 40 files, 12.79 seconds. Log `/tmp/vnext-c12-f2-focused.log`. Covers HTTP Responses, F1 barriers, retention/previous IDs, affinity, auth prewarm and ordinary warm zero-SQL configuration. Final behavioral edits affected session.ts only and are covered by the final 53-test run; a subsequent attempt.ts edit was indentation only.

`bun run --filter '@vibe-llm/gateway' typecheck` **PASS**, final log `/tmp/vnext-c12-f2-final-typecheck.log`. `git diff --check` **PASS**. Full CI and root runtime gates were deliberately not run by the writer.

### Specific evidence and red/green corrections

- The old pending configuration revision read is held after it reads SQL, then a second connection deletes the key; fresh authorization performs a later read and rejects. A cached session and a separate pre-revocation pending session lookup both fail to authorize after external deletion.
- Native Responses and translated Chat execute through the real gateway to a loopback Bun HTTP/SSE producer. Warmup performs zero inference; actual next inference recovers instructions/tools/input and omits type/generate/local previous ID. Separate connection lookup fails. SQL usage, usage_requests, performance_summary and performance_metrics stay empty after warmup.
- External owner disable, key delete/rotate/identity/owner mutation, session expiry and legacy key rotation reject before inference. External model mapping/upstream disable and real quota denial are checked again.
- Real SQLite durable save gating/failure and held performance persistence exercise terminal ordering and immediate-next admission. Failed state is unavailable and a fresh full request can recover. Close during a fresh read does not start inference.
- Inbound, outbound frame, local state, observable high-water, turn total, unobservable lifetime and cumulative control bytes each have limit-1/limit/limit+1 cases. Multibyte UTF-8 prevents character-count shortcuts. Many small turns/frames prove totals are not reset. Timer boundaries exercise drain timeout and incomplete cleanup close.
- A native close callback reentering close initially invoked it 16,451 times; publishing the closing promise before native close makes the regression exactly one call.
- A microtask changing native buffer pressure after async capacity approval initially caused one overshoot; a synchronous native-boundary recheck makes it zero.
- A synchronous disconnect during accepted terminal initially reopened admission and made two inference calls; post-send abort checking and conditional running-to-idle now keep it at one call.
- The first exact-frame test underestimated canonical bytes because the existing parser adds sequence_number, and a fast-path completion legitimately synthesizes response.in_progress. The fixture now supplies the sequence for byte boundaries and expects existing normalized lifecycle events; the parser was not changed to satisfy a test.

Root separately reported 11 mutable independent runtime groups passing against a separate Node producer, including opaque local carrier replay and dropped-send abort. These are root-reported mutable observations, not the writer's frozen acceptance or F3/F4 native socket proof. Root will own final frozen reruns and review.

## Ownership and freeze

`task-C12-F2-owned-paths.txt` contains exactly 14 owned product/test paths. `task-C12-F2-frozen-sha256.json` maps each to its frozen SHA-256. No other worktree product files were changed. The owned set comprises:

- Shared credential extraction/resolution; fresh configuration scope/cache.
- Responses serve integration and shared selection-only warmup validation.
- Shared continuation-item window and a plain metadata dump factory below the unchanged HTTP wrapper.
- New session, protocol, limits and private local-state modules.
- Three new test files.

F1 turn.ts/respond.ts, generic chat-flow-kit, platform entrypoints, capability/catalog publication, PRODUCT.md, upstream transport, schema and deployment files remain outside this change. No current-client compatibility claim is made; actual pinned ModelClient + native Bun/workerd adapters and platform slow-reader/disconnect behavior remain F3/F4 acceptance.

## F2 fix1 — review findings corrected (2026-09-29)

The reusable auth implementation now lives in `src/shared/credential-auth.ts`, whose dependencies are repo and shared configuration/model-mapping modules only. It owns `FullAuthCtx`, `ValidatedApiKey`, the single `validateApiKey` implementation, header extraction, and credential resolution. HTTP middleware and the Responses session import the same implementation. The control-plane API-key helper re-exports the validator/type for compatibility; its CRUD operations stay in the control plane. The middleware retains its existing `FullAuthCtx` type export.

This is a code move with the same credential precedence, expiry/disabled checks, optional WS enabled-owner enforcement, scoped/raw repo choice, and copied model-mapping policy. HTTP query/cookie/DMR extraction and optional Copilot prewarm remain in middleware. No boundary suppression, eslint configuration change, duplicated validator, or platform adapter was introduced. Two session regression tests use explicit const mutable holders for reentrant callbacks, removing both `prefer-const` errors.

### Fix1 validation

Executed from `reference-adoption-verify/vnext`:

```sh
bun test packages/gateway/tests/data-plane/chat-flow/responses \
  packages/gateway/tests/configuration-fresh.sqlite.test.ts \
  packages/gateway/tests/configuration-snapshot.test.ts \
  packages/gateway/tests/session-auth-prewarm.test.ts \
  packages/gateway/tests/api-keys.test.ts \
  packages/gateway/tests/control-plane-api-keys.test.ts \
  packages/gateway/tests/responses-previous-id.e2e.test.ts \
  packages/gateway/tests/responses-retention-settings.test.ts \
  packages/gateway/tests/responses-snapshot-id-roundtrip.test.ts \
  packages/gateway/tests/affinity
bun run --filter '@vibe-llm/gateway' typecheck
```

- Focused auth/configuration/session/HTTP/affinity suite: **538 pass / 0 fail / 2,015 assertions**, 42 files, 12.41 seconds; `/tmp/vnext-c12-f2-fix1-tests.log`.
- Gateway typecheck: **PASS**, exit 0; `/tmp/vnext-c12-f2-fix1-typecheck.log`.
- `bun ./node_modules/eslint/bin/eslint.js` with all 16 full-ownership paths (each stripped of the leading `vnext/`): **PASS**, exit 0; `/tmp/vnext-c12-f2-fix1-lint.log`. Output contains only the existing multiple-tsconfig resolver advisory. No rule was suppressed or relaxed.
- `git diff --check`: **PASS**.

The controller's initial full CI recorded 4,931 pass / 1 existing X25519 skip / 0 fail and 85,061 assertions, but failed lint on the three findings corrected here; its 35 inherited lint warnings were outside F2 paths and remain outside this fix scope. Its initial frozen runtime probes recorded 22 passing groups. Those are inherited controller evidence for the initial freeze, not fresh fix1 full CI/runtime results. Full CI and frozen runtime reruns remain controller-owned; the writer did not run them. Native Bun/workerd and pinned ModelClient acceptance remain F3/F4 obligations.

### Fix1 ownership and freeze

The full ownership set is now **16 paths**, recorded in both `task-C12-F2-owned-paths.txt` and `task-C12-F2-fix1-owned-paths.txt`. The initial 14-path manifest is preserved in `task-C12-F2-frozen-sha256.json` and the controller's `task-C12-F2-fix1-base/`.

The fix1 delta changes only these five paths:

- `vnext/packages/gateway/src/control-plane/auth/session-auth.ts`
- `vnext/packages/gateway/src/control-plane/lib/api-keys.ts` (new ownership)
- `vnext/packages/gateway/src/shared/credential-auth.ts` (new file)
- `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts`
- `vnext/packages/gateway/tests/data-plane/chat-flow/responses/session.sqlite.test.ts`

The other 11 initial owned files still match the initial frozen hashes. `task-C12-F2-fix1-frozen-sha256.json` contains the full 16-path SHA-256 map. `task-C12-F2-fix1-review-package.diff` contains the scoped delta from the initial freeze (the previously unowned control-plane API-key helper is compared to HEAD). Product/test files are frozen after this verification. No commit, push, deployment, live settings change or capability publication was performed.

### Mechanical EOF correction after integration precommit check

The controller's staged whitespace check found the extra final blank line in the previously untracked `src/shared/credential-auth.ts`, which the earlier tracked-only `git diff --check` did not inspect. Removed exactly one final byte `0a`: 4,006 bytes became 4,005 bytes; two trailing LF bytes became one. Byte equality confirms the new file is exactly the old file excluding its last byte. No other owned product/test file changed, and all 16 current owned hashes match the updated manifest.

- Old file SHA-256: `c648e4761422af376ef4f97ed2174b1348cb121fba786237c61c837a6d97426b`.
- New file SHA-256: `416748ba42f4dce3f01a1eb8b50510e53b56e694af68245282c76882e26f68c3`.
- Updated full fix1 manifest SHA-256: `6c8e9d4c955b2d369bc75ecc4b176cdaa4c939a42115a2c42c4dc1f13b08ddc2`.
- `git diff --no-index --check /dev/null <path>` reproduces `new blank line at EOF` for the preserved old bytes; the corrected untracked file produces no stdout/stderr. Its exit code is 1 because `--no-index` implies diff exit status and the file differs from `/dev/null`; no whitespace diagnostic remains. Exact results are retained in `task-C12-F2-fix1-eof-whitespace-check.json`.
- Byte proof is in `task-C12-F2-fix1-eof-byte-proof.json`; original file bytes are in `task-C12-F2-fix1-credential-auth.before-eof-fix.ts`.

Before this mechanical edit, the controller reported complete CI with 4,931 passes and all 22 runtime groups passing for the preceding 16-path freeze. Tests were not rerun for this one-byte-only change, as explicitly directed. The prior fix1 manifest, review package and report were preserved with `.before-eof-fix` suffixes before changing anything. The original `task-C12-F2-fix1-review-package.diff` remains unchanged and represents the previously tested bytes; the byte-proof artifact records this sole subsequent mechanical delta. Root-owned evidence/documentation files were neither edited nor added to this writer's ownership.
