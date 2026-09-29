### Spec Compliance

- ✅ **Spec verdict: Approved for the scoped fix1 delta.** The five-path change addresses the requested dependency extraction and test lint corrections without changing F2 session behavior, HTTP auth policy, or the limits approved in the first review.
- ✅ Reviewed `task-C12-F2-fix1-review-package.diff` once against the initial frozen candidate retained in `task-C12-F2-fix1-base`. All 16 current ownership hashes matched `task-C12-F2-fix1-frozen-sha256.json` before and after review. Diff SHA-256: `c223b9cbb0c4a2c062b57dbdd202da9804863b298adb50a8fcda8e5136f0fc37`.
- ⚠️ This is a targeted re-review, not a repeated full F2 review or integration gate. Fresh full CI/runtime results remain controller-owned. Native Bun/Workers adapters, platform disconnect/backpressure behavior, and pinned ModelClient compatibility remain F3/F4 obligations; the unchanged initial review boundaries still apply.

### Prior Findings

- **Important 1 — ADDRESSED.** `vnext/packages/gateway/src/data-plane/chat-flow/responses/session.ts:2` now imports the shared credential module rather than control-plane middleware. `vnext/packages/gateway/src/shared/credential-auth.ts:2`–`:5` depends only on repo and shared modules. Both HTTP middleware and WS reuse that implementation; no dependency rule or suppression is added in this five-path delta.
- **Minor 1 — ADDRESSED.** `vnext/packages/gateway/tests/data-plane/chat-flow/responses/session.sqlite.test.ts:388` and `:548` use explicit const mutable holders. The native-close reentrancy and synchronous-terminal-disconnect assertions remain intact; the fixture assigns each holder before invoking the relevant callback path.
- **Minor 2 — ACKNOWLEDGED, not removed.** Existing full-gate warning noise was outside the fix scope. The fix1 touched-path lint log still has only the multiple-tsconfig advisory (`/tmp/vnext-c12-f2-fix1-lint.log:1`), and the writer report explicitly distinguishes it from lint errors. This is not a new blocking defect or a claim of pristine output.

### Strengths

- **One shared validator with preserved compatibility.** `vnext/packages/gateway/src/shared/credential-auth.ts:30` contains the moved validator. Its repo selection at `:7`, invalid-mapping fallback, copied mappings at `:38`, owner identity and retention defaults match the removed implementation. `vnext/packages/gateway/src/control-plane/lib/api-keys.ts:15` re-exports `validateApiKey` and `ValidatedApiKey`, preserving the existing control-plane import surface while keeping CRUD there.
- **Auth policy did not widen.** `vnext/packages/gateway/src/shared/credential-auth.ts:44` preserves session expiry, disabled-user checks, legacy-key handling and the optional enabled-owner check at `:87`. Header precedence remains at `:95`. HTTP query/cookie/DMR extraction and Copilot prewarm remain in middleware, which retains its `FullAuthCtx` type export at `vnext/packages/gateway/src/control-plane/auth/session-auth.ts:24`.
- **The correction is narrow.** The session change is a single import target; the two tests alter callback storage rather than their lifecycle assertions. The delta adds no session state transition, protocol field, retry behavior, retention change, or platform capability claim.

### Issues

#### Critical (Must Fix)

- None found in the scoped fix1 delta.

#### Important (Should Fix)

- None found in the scoped fix1 delta. The previous Important finding is addressed.

#### Minor (Nice to Have)

- No new issue. The inherited advisory remains explicitly documented above.

### Checks and Evidence

- Read the appended fix1 report and the actual writer logs. `/tmp/vnext-c12-f2-fix1-tests.log` records **538 pass / 0 fail / 2,015 assertions across 42 files**; a warning/error-output search found none. `/tmp/vnext-c12-f2-fix1-typecheck.log:1` records exit 0. `/tmp/vnext-c12-f2-fix1-lint.log:1` contains only the existing resolver advisory; the writer reports exit 0 for all 16 owned paths.
- The named repair risks—validator semantics drifting during extraction, a shared module retaining a forbidden direct dependency, and callback-holder changes weakening reentrancy coverage—were resolved from the supplied fix1 delta. No unchanged-code inspection or broader source search was needed.
- No tests, runtime probes, Git commands, product/index/HEAD edits, services, or subagents were run. Only this scratch review report was written. The controller's three new research evidence scripts were not included in this scoped product review, as instructed.

### Assessment

**Task quality: Approved for fix1.**

**Reasoning:** Both actionable findings from the initial review are corrected through a permitted shared implementation and behavior-preserving fixture changes. No new Important breakage was found; full integration acceptance still depends on the controller's fresh gates for this frozen candidate.

### Mechanical EOF Follow-up

- ✅ **Mechanical change approved; Spec and Quality verdicts remain Approved.** Independently read the original integration candidate at `task-C12-F2-accepted-integration-integrate-snapshot/candidate/vnext/packages/gateway/src/shared/credential-auth.ts` and the current verify-worktree file. The original is 4,006 bytes, the current file is 4,005 bytes, and `original[:-1] == current` is true. The sole removed byte is `0a`; two trailing LF bytes become one. No TypeScript token or executable behavior changed.
- ✅ Original SHA-256 independently matches `c648e4761422af376ef4f97ed2174b1348cb121fba786237c61c837a6d97426b`; current SHA-256 matches `416748ba42f4dce3f01a1eb8b50510e53b56e694af68245282c76882e26f68c3`. The preserved `.before-eof-fix.ts` file independently agrees with the original bytes and old manifest.
- ✅ All other 15 owned files are byte-identical to the same retained integration candidate, not merely consistent with a rewritten manifest. All 16 current file hashes match the updated fix1 manifest. The fix1 review package is byte-identical to its `.before-eof-fix` backup.
- ✅ Read `task-C12-F2-fix1-eof-whitespace-check.json`: the old file reports a blank line at EOF; the current-file check has no whitespace diagnostics. Its no-index exit status of 1 indicates differing content versus `/dev/null`, not an outstanding whitespace error.
- ⚠️ The controller reports that full CI (4,931 passing tests and all gates) and 22 runtime groups passed immediately before this single-LF deletion. This follow-up ran only byte/hash comparisons, not tests or runtime probes; the verified non-semantic delta does not call for rerunning those gates. No product, index, HEAD, or service was modified by this reviewer.
