# C09 task review

## Spec Compliance

- ✅ Spec compliant. Fixed receipt-anchored freshness, retained stale data, allowlisted read-boundary validation, and unknown-versus-zero semantics are implemented in `vnext/packages/provider-codex/src/quota.ts:137` and `:170`; the horizon is anchored at `:187` and expires at the exact boundary at `:190`.
- ✅ Session-only, owner/admin-authorized, provider/account-bound, no-store reads project the authorized row directly: `vnext/packages/gateway/src/control-plane/upstreams/codex-quota-routes.ts:11`. Exact GET/path prewarm exclusion is at `vnext/packages/gateway/src/control-plane/auth/session-auth.ts:139`; actual-app SQLite coverage includes denied requests and negative method/path controls at `vnext/packages/gateway/tests/control-plane-codex-quota.sqlite.test.ts:56`, `:70`, and `:95`.
- ✅ Complete dashboard integration is present at `vnext/apps/dashboard/src/tabs/upstreams/UpstreamRow.tsx:214`; timestamps, stale labels, unknown values, zero credit balance, errors and independent reload are rendered by `vnext/apps/dashboard/src/tabs/upstreams/CodexQuotaPanel.tsx:25`. Identity remount and cancellation protect against stale account responses at `:9` and `vnext/apps/dashboard/src/tabs/upstreams/codex-quota-read.ts:13`.
- ✅ Existing dispatch gating is not modified by this patch. Real SQLite tests exercise future rejection, expired rejection and utilization-only dispatch at `vnext/packages/gateway/tests/codex-credential-effects.sqlite.test.ts:593`.
- ⚠️ Cross-task/runtime boundaries: C08 CAS correctness and global retention/provider identity guarantees are not re-audited by this task-scoped diff. Root owns full CI, frozen actual-app/workerd/D1 and browser acceptance; source and supplied test logs are not independent runtime proof.

## Strengths

- Persisted buckets are independently sanitized; malformed neighbors cannot erase valid observations, and real zero/false values survive (`vnext/packages/provider-codex/src/quota.ts:148`, `:181`; `vnext/packages/provider-codex/src/__tests__/quota-observations.test.ts:24`).
- Read-only HTTP delivery uses the already authorized row rather than introducing a second credential read or refresh path (`vnext/packages/gateway/src/control-plane/upstreams/codex-quota-routes.ts:16`, `:25`).
- Cancellation correctness includes fetch implementations that ignore abort, with separate tests for late success, late rejection and retry (`vnext/apps/dashboard/src/tabs/upstreams/codex-quota-read.test.ts:12`, `:28`).

## Issues

### Critical

- None found in this task diff.

### Important

- None found in this task diff.

### Minor

- `/tmp/c09-lint.log:1`: ESLint emits the generic multiple-tsconfig performance warning. This is tooling noise rather than a product defect; a shared references configuration or the documented `noWarnOnMultipleProjects` option can make future lint evidence pristine. It does not block this task.

## Checks and scope

- Read the supplied frozen 13-path patch once; no product, index or HEAD mutations and no test reruns.
- Named risk: the inherited TTL helper might still depend on read-time or mishandle the reset horizons. The diff omitted its body, so inspected the unchanged prefix of `vnext/packages/provider-codex/src/quota.ts`, specifically `:112`; it computes a 24-hour floor and reset/rejection deltas against the supplied receipt-time Date. The implementation is fixed-horizon.
- Named risk: changing exported `getCodexQuota` from snapshot values to observation values might break existing consumers. A focused repository symbol search found no existing provider-helper callers beyond its definition; the dashboard has its own newly added API wrapper (`vnext/apps/dashboard/src/api/upstreams.ts:225`).
- Named risk: requiring exactly one persisted account might reject supported multi-account rows. Focused account-constraint inspection confirms the existing config tuple and validator already require exactly one account (`vnext/packages/provider-codex/src/config.ts:20`, `:41`; `vnext/packages/provider-codex/src/state.ts:219`).
- Inspected supplied `/tmp/c09-tests-final.log`: 93 pass, 0 fail, 339 assertions across the five reported files. Inspected `/tmp/c09-typecheck-final.log`: all reported workspace typechecks exit 0. No independent rerun was warranted by the diff.

## Assessment

**Task quality: Approved.**

The implementation meets the task-scoped quota delivery requirements without altering inference gating or introducing outbound reads. The remaining integration/runtime acceptance and C08 cross-task guarantees belong to root, not this approval.
