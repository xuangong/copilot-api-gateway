# Spec compliance

**❌ Issues found.** The prerequisite implements read-only Codex target preparation and per-inference fencing, but does not guarantee the required fence before every OAuth operation when the existing token manager performs internal credential-replacement recovery. This is a task-scoped review of the frozen seven-path patch at base `a79fbb48ff763610f67917d18f1597c6befd8eaa`, not a verdict on overall C01 activation.

**⚠️ Outside this diff:** active affinity selection/stamping/storage and non-Codex providers remain intentionally absent. The report labels those limits accurately; they are not missing work for this prerequisite package. Full CI and the root's eight-case actual runtime validation remain controller-owned evidence; no tests were rerun in review.

# Strengths

- `vnext/packages/provider-codex/src/provider.ts:143`: preparation uses the already accepted catalog, authoritative account metadata, active-state and configuration-generation checks; it does not invoke discovery/OAuth. The selected catalog/configuration snapshots are cloned at provider boundaries.
- `vnext/packages/provider-codex/src/affinity-execution.ts:7`: the exact target combines incarnation, account subject, explicit imported credential revision plus configuration generation and actual model. No token hash, alias prefix or shared compatibility key is invented. The unchanged target parser freezes the returned object.
- `vnext/packages/provider-codex/src/fetch.ts:551`: each inference dispatch rereads authority, compares the used lease identity, runs the callback, and rechecks cancellation before issuing HTTP. The prepared response carries the actual target rather than a mutable provider-level field.
- `vnext/packages/gateway/tests/affinity/codex-execution.sqlite.test.ts:17`: real temporary SQLite and real repository lifecycle operations cover zero-network preparation, known replacement mismatches, 401 replacement, generation changes and cancellation; no database/module mocks are introduced.

# Issues

## Critical

None found.

## Important — OAuth recovery can cross credential affinity before the fence runs again

**Location:** `vnext/packages/provider-codex/src/fetch.ts:195`, `:213`, `:632-633`; unchanged recovery contract `vnext/packages/provider-codex/src/access-token.ts:168-184` and `:202-209`.

The new `preflightAffinity` executes before the outer `ensureCodexAccessToken` / `refreshCodexAccessTokenForRetry` call, but the mint callbacks still invoke `mintAccessToken` directly. The token manager can perform a second OAuth request inside `ensureInner` after rereading a replacement credential. That internal request does not revisit the outer preflight callback.

Concrete path, derived directly from the control flow:

1. Required state selected target A; A has an expired access token and a renewable credential. The new preflight checks A successfully.
2. While the first OAuth request is pending, an authoritative reimport/replacement installs target B with a new credential revision and no usable access token.
3. A's OAuth returns `invalid_grant`. The existing token manager rereads B, detects the changed revision, and at `access-token.ts:184` recursively calls `ensureInner(current, mint, false, false, signal)`.
4. That recursive call invokes `mint(B.refresh_token)` at line 168 without invoking `beforeInference(B)`. A later inference fence can reject B, but B's OAuth HTTP request has already happened.

The successful-mint/losing-CAS recovery at lines 202-209 has the same omission. This violates the explicit requirement that account/configuration replacement be fenced before credential refresh, not merely before inference. Existing tests cover replacement before the outer preflight and replacement after an inference 401, but not replacement while OAuth is in flight.

**Fix:** place a typed affinity check at the actual token-manager credential snapshot/mint boundary, including both internal recovery branches, and ensure the callback validates the exact credential snapshot whose refresh token is about to be sent. Preserve normal no-hook recovery, coalescing and cancellation behavior. Add a real-SQLite deferred OAuth test that installs B during A's pending request and proves there is only one OAuth request, zero inference calls, and a typed/matching affinity rejection; cover both invalid-grant recovery and successful-mint losing-CAS recovery.

## Minor

None beyond the blocking issue.

# Assessment

**Task quality: Needs fixes.** The target representation, preparation and inference fence are coherent and conservative, but the OAuth manager's nested recovery path is part of the contract this package must fence. Approve after that path is covered and the frozen package is regenerated.

# Review checks and scope

- Read the exact frozen patch once and compared all seven paths with the task-specific execution prerequisite contract. Did not rerun Git commands, tests, CI, or runtime probes; no product/index/branch changes.
- Named risk: the outer OAuth fence might not cover token-manager internal retries. Inspected unchanged `access-token.ts` ensure/recovery control flow. The changed fetch hunk cuts off the mint callback, so inspected only the missing callback/dispatch context at `fetch.ts:198-237` and line-numbered the relevant fence at `:615-641`.
- Named risk: returned execution identity might be only TypeScript-readonly and mutable at runtime. Inspected unchanged `parseAffinityExecutionTarget` in `provider-llm/src/opaque-affinity.ts`; it returns `Object.freeze`, so no finding.
