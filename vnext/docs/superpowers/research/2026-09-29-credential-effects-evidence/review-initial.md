# C08 credential effects review

## Spec compliance

- **Issues found — one Important blocker.** The effect fences work after a credential target has been captured, but the first capture does not retain the already-authorized provider record's owner/incarnation. `provider.ts:71`, `:88`, `:142`, and `:191` allow an existing provider to adopt a replacement row before that capture. This violates the task's owner/row identity boundary; it must be fixed in this package, not deferred to C02.
- The remaining reviewed credential-effect requirements match the diff: import revision construction, legacy absent revision, atomic token-pair publication, authoritative loser selection, guarded refresh failure/bearer invalidation/quota observations, and stable prepared requests across one HTTP retry. Optional-refresh parsing/import UI and catalog generation advancement are explicitly outside this package.
- **Cannot verify from this diff:** acceptance/integration of the prerequisite foundation, final clean CI, actual workerd/D1 behavior, preservation of the separate collaboration-shim/PRODUCT work, and later import-route authorization. Root must resolve the checks below before integration.

## Strengths

- `vnext/packages/provider-codex/src/access-token.ts:94` publishes access and rotated refresh tokens in one guarded state update, then rereads the authoritative usable winner. No discarded local mint escapes as the stored result.
- `vnext/packages/provider-codex/src/credential-effects.ts:66` centralizes revision plus exact-token checks and passes the captured row target even when the updater returns its input. `:85` captures timestamps outside the replayable updater and tolerates only gone/replaced targets.
- `vnext/packages/provider-codex/src/access-token.ts:106` rereads current credentials before invalidating a failed bearer; the refresh failure branch at `:61` preserves bounded invalid_grant recovery. Generation, compact, alpha-search, and catalog minting share this lifecycle.
- `vnext/packages/provider-codex/src/auth/import.ts:35` creates fresh revisions without rewriting legacy rows. `vnext/packages/provider-codex/src/quota.ts:146` binds observations to the actual bearer lease.
- `vnext/packages/gateway/tests/codex-credential-effects.sqlite.test.ts:69`, `:186`, `:201`, and `:359` use real SQLite storage and controlled replacement/interleaving to cover atomic visibility, same-token/new-revision effects, exact-state recreation, and all three HTTP entry points' prepared body/identity. These tests protect the post-capture boundary well.

## Issues

### Critical

- None found.

### Important — I1: First credential capture can cross an already-authorized owner/incarnation

- **Locations:** `vnext/packages/provider-codex/src/provider.ts:71` discards the incoming row's owner/incarnation; catalog at `:88`, generation at `:142`, and alpha-search at `:191` perform their first credential selection without an expected target. `vnext/packages/provider-codex/src/credential-effects.ts:32` consequently accepts the current row and creates a new target from it.
- **Failure:** construct the provider from a stored row authorized for owner A; before its first credential lookup, replace that row with owner B's same-account row, either by changing the owner in place or by delete/recreate with the same ID. The provider sends B's bearer and returns HTTP 200. Its later fences then protect B's row because B was silently adopted as the target. The existing tests replace rows only after the lease/effect target has been captured, so they do not detect this interval.
- **Impact:** credential selection and subsequent effects can escape the owner/incarnation associated with the provider binding, while retaining the old binding's config/model/fetcher context. This is an authorization and identity gap, not an atomic-CAS failure.
- **Fix:** retain the authorized stored row's owner/provider/incarnation at provider construction, and supply that expected target to the initial catalog and generation/alpha-search reads/ensures. Tighten the factory/record contract if needed; obtaining a fresh incarnation solely by ID at the first request is not an equivalent fence. Same-row reimport may advance credentialRevision, but owner or incarnation replacement must reject before dispatch. Add real-repo tests for replacement before the first capture, covering generation/compact/alpha-search/catalog.
- **Verified:** the isolated reproduction below used the real BunSqliteRepo and injected synthetic HTTP responses. Both in-place owner change and delete/recreate returned `status: 200` with `usedReplacementCredential: true`. No external request or real credential was used.

### Minor — M1: Validation output is not pristine

- `/tmp/c08-effects-lint-final.out` contains the ESLint multi-project warning and 35 warnings, including the unchanged catch at `vnext/packages/provider-codex/src/auth/import.ts:75` and `auth/jwt.ts:22`. The reviewed hunk does not introduce these warnings; this is baseline noise, not another blocker. Root should preserve the explicit baseline distinction rather than describe lint as warning-free.

## Assessment

- **Task quality: Needs fixes.** The atomic lifecycle and post-capture fences are cohesive and substantially tested. Approval is blocked by the reproduced initial-target authorization gap.

## Checks and evidence boundary

- Read the credential-effects brief, foundation brief, boundary report, binding C08 design, root/vnext AGENTS, implementer report, and full 1,978-line review patch. Reviewed against base `434f97e85c57cea16075cefd97c2bd3061f5d3f3` and the frozen uncommitted candidate.
- Independently hashed all 12 candidate files in `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`; every hash matched `task-C08-credential-effects-frozen-sha256.json`.
- Inspected the supplied focused-test log: 153 pass, 0 fail, 997 assertions across 12 files. Inspected typecheck success output and the complete lint log. Did not rerun those suites or git commands.
- Named outside-diff risk, **CAS target/no-op enforcement and cache forwarding**: checked `vnext/packages/upstream-repo/src/types.ts:6`, `vnext/packages/gateway/src/repo/shared/repos.ts:639`, and `vnext/packages/gateway/src/repo/configuration-cache.ts:275`. The existing repo verifies target identity even for no-ops, uses conditional RETURNING, bounds retries, and the cache wrapper forwards the expected target. No competing lock or repository change is needed for I1.
- Named outside-diff risk, **authorized binding record discarded before first credential capture**: checked `vnext/packages/gateway/src/data-plane/providers/registry.ts:79`, `:326`, and `vnext/packages/provider-codex/src/plugin.ts:13`. The gateway constructs bindings from the owner-filtered upstream records and passes each record to the provider; the plugin does not supply a separate target fence.
- No changed file was reread outside the patch; no cut-off-function exception was needed. No product/index/HEAD edits, subagents, network calls, commits, or deployment. Only this report was written in the checkout; the reproduction's temporary database was closed and removed.

## Root cross-task checks

- Fix I1 in this C08 package, then regenerate frozen hashes and review evidence. C02's planned authoritative discovery/provider work does not close the currently demonstrated generation boundary.
- Rerun clean CI and actual workerd/D1 validation against the final fixed hashes. Extend the runtime target-replacement probe to replacement before first capture, in addition to the already-covered delayed post-capture effects and atomic token-pair visibility. This review's Bun reproduction is not workerd/D1 evidence.
- Confirm the accepted foundation's owner-aware metadata mutation, public DTO, configuration-cache, and new row-incarnation migration remain integrated; the package diff does not establish their whole-branch acceptance. Preserve historical credentials/migrations and unrelated collaboration-shim/PRODUCT changes.
- Later C08 import/reimport must retain the authorized row identity, advance credentialRevision and catalog generation intentionally, preserve installation identity for the same account, and reject accidental account substitution. This package does not deliver those routes or access-only lifecycle behavior.
- Full-branch checks must retain cancellation, owner/key visibility, opt-in Responses retention, and unknown-versus-zero usage semantics. The patch preserves the HTTP signal/prepared-call path and does not change retention/usage code, but this task review does not independently exercise the complete routes for those cross-task guarantees.

## Exact isolated reproduction

Working directory: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify/vnext`. Executed with `bun run -` on Bun 1.3.0. The initial stdin invocation used workspace package aliases that are not resolvable from the vnext root and failed before execution; the successful invocation below uses explicit source imports. No source file was created.

```sh
bun run - <<'TS'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BunSqliteRepo } from './apps/platform-bun/src/bun-sqlite-repo.ts'
import { initUpstreamRepo } from './packages/upstream-repo/src/index.ts'
import { initBackground, __resetPlatformForTests } from './packages/platform/src/index.ts'
import { CodexProvider } from './packages/provider-codex/src/provider.ts'
import type { UpstreamRecord } from './packages/gateway/src/repo/types.ts'
const folder = mkdtempSync(join(tmpdir(), 'c08-review-target-'))
const db = new Database(join(folder, 'review.sqlite'))
const repo = new BunSqliteRepo(db)
const pending: Promise<unknown>[] = []
initUpstreamRepo(() => repo.upstreams)
initBackground({ waitUntil: promise => pending.push(promise) })
const row = (ownerId: string, token: string): UpstreamRecord<unknown> => ({
 id: 'synthetic-row', ownerId, provider: 'codex', name: 'Fixture', enabled: true, sortOrder: 0,
 config: { accounts: [{ chatgptAccountId: 'fixture-account', email: 'fixture@example.test', chatgptUserId: 'fixture-user', planType: 'plus' }] },
 state: { accounts: [{ chatgptAccountId: 'fixture-account', credentialRevision: token, refresh_token: 'fixture-refresh', state: 'active', state_updated_at: 'fixture-time', openaiDeviceId: 'fixture-device', accessToken: { token, expiresAt: Date.now()+3600000, refreshedAt: 'fixture-time' }, quotaSnapshot: null }] },
 flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [], createdAt: 'fixture-time', updatedAt: 'fixture-time',
})
try {
 for (const recreate of [false, true]) {
  await repo.upstreams.save(row('fixture-owner-a', 'fixture-access-a'))
  const authorized = await repo.upstreams.getById('synthetic-row')
  if (!authorized) throw new Error('missing fixture')
  let sentReplacement = false
  const provider = new CodexProvider(authorized, async (_url, init) => {
   sentReplacement = new Headers(init?.headers).get('authorization') === 'Bearer fixture-access-b'
   return Response.json({ output: [] })
  })
  provider.setModelCatalog({ object: 'list', data: [{ id: 'fixture-model', display_name: 'Fixture', owned_by: 'openai', kind: 'chat', limits: { max_context_window_tokens: 1000 }, endpoints: { responses: {} } }] })
  if (recreate) await repo.upstreams.delete('synthetic-row')
  await repo.upstreams.save(row('fixture-owner-b', 'fixture-access-b'))
  const response = await provider.fetch({ endpoint: 'responses', action: 'generate', sourceApi: 'openai', payload: { model: 'fixture-model', input: [] }, headers: new Headers() })
  await Promise.all(pending.splice(0))
  console.log(JSON.stringify({ case: recreate ? 'delete-recreate-before-first-capture' : 'owner-change-before-first-capture', status: response.status, usedReplacementCredential: sentReplacement }))
 }
} finally { __resetPlatformForTests(); db.close(); rmSync(folder, { recursive: true, force: true }) }
TS
```

Observed output:

```json
{"case":"owner-change-before-first-capture","status":200,"usedReplacementCredential":true}
{"case":"delete-recreate-before-first-capture","status":200,"usedReplacementCredential":true}
```
