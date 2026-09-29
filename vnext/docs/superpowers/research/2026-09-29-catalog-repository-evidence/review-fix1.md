# C02 foundation fix1 scoped review

## Spec compliance

- ✅ Spec compliant. The only fix changes the quota-only fixture to read its persisted state before updating quota (`vnext/packages/gateway/tests/integration/shared-provider-state.test.ts:153`). It preserves both original assertions: unchanged configuration revision at line 158 and background visibility of the new quota at line 163. No production behavior or assertion was weakened.
- ✅ All 13 product files in the updated frozen map match the verification checkout. The newly owned test has SHA256 `0000201893e58326cdab38eeb9c9529095d575d572519b7cb0783ff220bdba13`, matching the fix report. The original foundation review is not reopened by this two-line patch.

## Strengths

- The correction removes the actual nondeterministic input. `codexState()` creates `accessToken.expiresAt` from `Date.now()` (`vnext/packages/gateway/tests/integration/shared-provider-state.test.ts:10`); calling it again can change credentials as well as quota. Reading persisted state ensures line 156 changes only the intended quota snapshot.
- Existing configuration invalidation semantics support the reported root cause: `vnext/packages/gateway/migrations/0010_configuration_revision.sql:32` excludes only the first OAuth account's quota snapshot, leaving access-token expiry significant. A revision increment for the old fixture's expiry change was correct behavior.
- The fixture still writes through raw SQL at `vnext/packages/gateway/tests/integration/shared-provider-state.test.ts:157`, preserving its sibling-instance simulation and bypass of local mutation invalidation. The additional authoritative read occurs before that write; it does not perform or pre-observe the quota update.
- The optional state/account lookup retains the explicit missing-fixture guard (`vnext/packages/gateway/tests/integration/shared-provider-state.test.ts:154`), without adding a cast or non-null assertion.

## Issues

### Critical

- None.

### Important

- None.

### Minor

- The focused log contains an existing Claude race recovery diagnostic with synthetic fixture values (`task-C02-foundation-fix1-focused-tests.log:35`). This is unrelated to the two-line fix and does not demonstrate real credential exposure, but the passing output remains noisy. Expected diagnostics can be captured/asserted when that test is next edited; no expansion of this fix is needed.

## Checks and remaining boundaries

- Read the fix patch once. Because its hunk cuts through the test, read that complete test plus the time-dependent helper. The only outside-diff contract check was the historical configuration trigger, specifically to determine whether the old fixture also changed a revision-significant credential field. No broad foundation review or test rerun was performed.
- Verified supplied focused evidence: the previously failing remote-quota test passes (`task-C02-foundation-fix1-focused-tests.log:41`); combined results are **36 pass / 0 fail / 156 assertions** (`task-C02-foundation-fix1-focused-tests.log:44`). Typecheck success is attributed to the implementer's report, not independently rerun here.
- Root's fresh full CI and workerd/D1 results remain separate required gates; this scoped review does not infer them from the focused test log. The previously documented activation and C08 importer boundaries remain unchanged.

## Assessment

**Task quality: Approved.** This is a minimal fixture correction that restores the test's quota-only premise while retaining its original behavior assertions. No additional product correction is warranted by this failure.
