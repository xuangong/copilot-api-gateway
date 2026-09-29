# Finding verdicts

**OAuth internal invalid-grant / losing-CAS recovery bypasses the affinity fence — ADDRESSED.** `vnext/packages/provider-codex/src/access-token.ts:173` invokes the new typed `beforeMint` callback against the exact credential snapshot immediately before minting, outside OAuth error classification, and checks cancellation afterward. Both recovery recursions retain the callback (`access-token.ts:194`, `:219`); `refreshCodexAccessTokenForRetry` also forwards it into the subsequent ensure. `vnext/packages/provider-codex/src/fetch.ts:617` creates the provider-owned callback that validates the exact snapshot and then rereads authoritative credential metadata before allowing OAuth.

**Regression evidence matches the finding.** `vnext/packages/gateway/tests/affinity/codex-execution.sqlite.test.ts:149` adds a real-SQLite deferred OAuth barrier test covering both initial invalid-grant and successful-mint/losing-CAS branches. It replaces A through the repository while OAuth A is pending, installs B without a usable access token, and asserts target-change rejection, OAuth A=1, OAuth B=0, inference=0. This reaches the formerly unguarded remint branch instead of only testing early replacement or sibling-token adoption.

# New breakage in the fix diff

None found. The new callback is optional; no-hook operation retains the existing mint signature and ensure behavior. The production gated caller supplies a fresh callback identity, preventing it from coalescing with an ungated ensure. Signal-bearing execution retains owned cancellation and rechecks the signal before network minting. No token/secret is exposed to the callback.

# Out-of-scope observations

None. Active C01 routing and egress remain explicitly unactivated; this approval does not cover those future slices.

# Verdict

**Spec compliance: ✅ compliant for this scoped prerequisite fix.** The previously identified missing OAuth boundary is now fenced for both internal recovery paths.

**Task quality: Approved.** The correction belongs at the token-manager mint boundary, carries the precise selected snapshot through recursion, and has a targeted real-repository race regression.

**Fix round: All findings addressed, no new Critical/Important breakage.**

# Checks

Read the scoped fix patch once and the appended fix report. The report identifies the five-file regression command and its result of 181 passing tests / 1834 assertions, plus four successful package typechecks and diff-check. The added test's control flow and assertions match the reported coverage. Root separately supplied a passing nine-case real Bun/HTTP/SQLite runtime result, including the in-flight replacement probe. No tests, Git commands, product edits or additional agents were run during this re-review.

# Supplemental coalescing-scope check

**Minor API limitation; no current task-path breakage. Approval unchanged.** `access-token.ts:140` uses `scopeNumber(coalescingScope ?? beforeMint)`. In the signal-less branch, two calls sharing an explicit `coalescingScope` but supplying distinct `beforeMint` callbacks can join the same flight at line 142; the second callback is not executed. Thus the optional parameters are not safely composable as a general per-request-fence API, despite both being accepted by its signature. This is a concrete limitation of the new API, not evidence that the active Codex affinity path bypasses its fence.

Focused caller check: all existing production `ensureCodexAccessToken` call sites were enumerated. Affinity generation in `fetch.ts:210` and recovery in `access-token.ts:245` pass `undefined` explicit scope, so each provider-created fence determines isolation. Catalog discovery in `provider.ts:103` passes a fetcher scope with no `beforeMint`; explicit credential refresh in `codex-credentials-routes.ts:266` also passes a fetcher scope with no `beforeMint` (and a signal). No current production call combines both parameters.

Before a caller combines these options, key the coalescing identity by both `scopeNumber(coalescingScope)` and `scopeNumber(beforeMint)`, or explicitly reject/document the unsupported combination. This scoped prerequisite remains approved because its actual hook-bearing call paths are isolated. No test was run for this supplemental source-contract check.
