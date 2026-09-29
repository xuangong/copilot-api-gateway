# C08 credential effects and atomic refresh

Status: implementation frozen for root review. Accepted prerequisite HEAD: `434f97e85c57cea16075cefd97c2bd3061f5d3f3`. This implements credential-effect groundwork from boundary-report steps 4–5, not the full C08 import/optional-refresh feature.

Product ownership is the explicit 13-path array (after review fix 1) in `task-C08-credential-effects-owned.json`. Frozen SHA-256 values are in `task-C08-credential-effects-frozen-sha256.json`.

## Result

- Codex state accepts an optional persisted `credentialRevision`. Missing legacy revisions consistently compare as `null`; reading a legacy row does not manufacture or persist a revision. Both existing import constructors mint a fresh opaque UUID on every invocation. Existing refresh-token requirements, account identity fields and expiry behavior remain for the later lifecycle/parser package.
- Credential reads capture stored row incarnation, owner, provider, account ID and revision. All asynchronous state effects additionally retain the exact bearer or refresh token used. The repository receives the captured expected row target even for an effect whose updater returns a no-op. Same-ID deletion/recreation and owner/provider changes cannot be crossed by delayed writes.
- OAuth minting is network-only and returns a refresh/access pair. One awaited CAS publishes both tokens together only if the active account still matches the captured revision and used refresh token. There is no separate rotation write or delayed access-token put. State timestamps are captured before replayable updater execution.
- After a commit or a losing credential CAS, token selection re-reads authoritative state. The returned lease contains only a usable current persisted bearer, never an uncommitted local mint. A deleted/replaced row fails with its typed repository error. A same-row winner with no usable access token fails with `CodexCredentialUnavailableError` rather than exposing the discarded mint.
- Refresh failures re-read authoritative state before terminal persistence. A different current revision/refresh token with a usable bearer returns that winner. `invalid_grant` retains at most one recovery mint using the latest refresh token if the winner has no usable bearer. Other terminal failures do not add a recovery mint; their stale terminal effect is a guarded no-op. Definitive current failures persist `refresh_failed` for the matching refresh attempt.
- Generic first-401 recovery reads authoritative state before invalidation. It reuses a newer usable bearer, or invalidates only the failed revision/bearer and re-reads before minting with the current refresh token. Responses, compact and alpha-search still retry at most once. The accepted native prepared body and request/session/thread/turn identity are reused unchanged.
- `token_invalidated` remains a terminal response for that request, but persists `session_terminated` only for the exact bearer/revision that failed. Successful and 429 quota observations carry the lease and cannot write quota onto a replacement credential or newer bearer. Gone/replaced targets are tolerated for best-effort invalidation, terminal and quota effects; storage errors and bounded contention still propagate.
- Preflight reads the authoritative account before health/quota gates, so stale cached health or quota does not reject an active replacement. Credential selection also uses authoritative reads. These reads intentionally favor credential correctness over the old cached-token fast path; quota-only writes still retain warm configuration/catalogs in the existing cache integration tests.
- Catalog OAuth refresh uses the same atomic and guarded lifecycle. Catalog HTTP fetching itself retains its existing no-retry/no-terminal-state-mutation behavior. Catalog generation invalidation on actual authorized reimport belongs to the queued lifecycle/import package.
- Process-local coalescing keys include incarnation, owner, revision and exact stored tokens plus force mode. It only coalesces the same credential; cross-instance correctness comes from the repository CAS.

## Provider-facing contracts

Exported from `@vibe-llm/provider-codex`:

```ts
interface CodexCredentialTarget extends UpstreamWriteTarget {
  upstreamId: string
  accountId: string
  provider: "codex"
  credentialRevision: string | null
}

interface CodexAccessTokenLease extends CodexAccessTokenEntry {
  credential: CodexCredentialTarget
}

interface CodexMintResult {
  accessToken: CodexAccessTokenEntry
  refreshToken: string
}

type CodexTokenMint = (refreshToken: string) => Promise<CodexMintResult>

readCodexCredential(id, accountId, expected?: UpstreamWriteTarget)
  // Promise<{ credential: CodexCredentialTarget, account: CodexAccountCredential }>
ensureCodexAccessToken(id, accountId, mint, force = false, expected?: UpstreamWriteTarget)
  // Promise<CodexAccessTokenLease>
mintCodexAccessToken(refreshToken, fetcher) // Promise<CodexMintResult>
refreshCodexAccessTokenForRetry(failedLease, mint) // Promise<CodexAccessTokenLease>
invalidateCodexAccessToken(lease) // Promise<void>
putCodexQuota(lease, snapshot) // Promise<void>
codexBearerEffect(lease) // { credential, tokenKind: "access", token }
persistCodexTerminalState(
  { credential, tokenKind: "access" | "refresh", token },
  "session_terminated" | "refresh_failed",
  message,
) // Promise<void>
```

The old unguarded `putCodexAccessToken` and long-lived `CodexCallEffects` rotation/terminal callbacks were removed. Existing helper callers/tests were adapted to the explicit lease and mint-pair contracts. New helper exports live in `credential-effects.ts`; no protocol-core or repository contract changes were needed.

## Verification

- TDD baseline: the first six new tests failed on the accepted prerequisite, demonstrating two visible refresh writes, stale mint overwrite, stale 401 refresh selection and absent revision handling. Evidence: `/tmp/c08-effects-red.out`. The expanded initial fence/preflight baseline had 1 pass and 17 failures: `/tmp/c08-effects-fences-red.out`.
- New `gateway/tests/codex-credential-effects.sqlite.test.ts`: **51 passing tests** using an isolated temporary database file, two real SQLite handles and two `BunSqliteRepo` instances per fixture. Controlled interleavings use real sibling writes; CAS replay/contention cases inject a synchronous second-handle write between real updater execution and conditional SQL. No database module mocks or fake-SQL success evidence.
- The real-repo matrix covers atomic refresh/access visibility, quota preservation on CAS replay, two mint winners/losers, bounded contention, same-token revision changes, exact-state/same-timestamp recreation, owner/provider and ownerless paths, stale success/401/429/terminal effects, all six terminal OAuth classifications for generation and catalog, new-revision coalescing isolation, stale cached preflight gates, no-usable-winner termination, and all three request entry points using the latest refresh token while preserving body/identity.
- Final focused command: `bun test packages/provider-codex/src packages/gateway/tests/codex-credential-effects.sqlite.test.ts packages/gateway/tests/integration/shared-provider-state.test.ts` from `vnext/` — **153 pass, 0 fail, 997 assertions across 12 files**. Evidence: `/tmp/c08-effects-focused-final.out`. This includes the existing native request preparation and warm configuration/catalog tests.
- Full workspace `bun run typecheck` — all packages pass. Evidence: `/tmp/c08-effects-typecheck-final.out`.
- `bun run lint` — **0 errors, 35 existing warnings**. Evidence: `/tmp/c08-effects-lint-final.out`. The pre-existing unused provider import was removed while simplifying imports; the existing import/JWT error-cause warnings remain.
- `bun run scripts/check-framework-purity.ts` and `git diff --check` pass.
- All 10 protected tracked-file SHA-256 values match `current-user-dirty-sha256.json`. Unrelated dirty/untracked files and root-owned evidence/docs were preserved.
- Root reported passing preliminary actual workerd/D1Repo probes for atomic token-pair audit, replacement/ABA/effect fences, authoritative refresh and all three HTTP retry paths. `/tmp/vnext-c08-effects-expanded-d1.out` is root-owned preliminary evidence; root must rerun its probe against these final frozen hashes.

## Remaining gates and boundaries

Root owns independent review, clean-tree CI, final frozen-tree D1/runtime validation and integration/docs. No commit, push, deploy, installation, live credentials, live database, external network requests or subagents were used. Parser envelope expansion, optional refresh/access-only lifecycle, new health UI, authorized import/reimport routes and actual catalog generation advancement remain queued work. No historical credentials were rewritten or wiped by a migration.


## Review fix 1 — preserve the authorized target before first capture

Addressed Important I1 in `task-C08-credential-effects-review.md`. The prior candidate guarded effects after capture but discarded the owner/incarnation of the provider binding before its first credential read. A provider constructed from owner A's stored row could therefore adopt owner B's same-ID replacement credentials.

- `CodexProvider` now requires a nonempty actual stored `rowIncarnation` at construction and copies that incarnation, owner and provider into its private expected write target. Missing/malformed incarnation fails immediately with a generic error; there is no later lookup to invent a target and no synthetic fallback value.
- Catalog's initial ensure and generation/compact/alpha-search's initial credential reads pass that retained target. In-place owner/provider changes and deletion/recreation fail with `UpstreamReplacedError` before an OAuth or backend dispatch.
- The existing production plugin already forwards the authorized stored record without projecting it. The constructor validates that exact plugin input; no protocol-core expansion or plugin reread was required. Regression tests exercise the real `createProviderFromUpstream` registry/plugin path, not only direct construction.
- The stored target deliberately excludes credential revision: same-owner, same-incarnation reimport still selects its latest credentials. A regression verifies that an older provider binding can use the same-row replacement bearer for catalog and generation.
- Existing fixture constructors now use real persisted incarnations in SQLite tests and explicit stored-row identities in the provider unit fixture. They no longer model a provider created from an unstored row.

TDD evidence: `/tmp/c08-effects-fix1-red.out` has **56 pass, 9 fail** before the product fix. Eight failures reproduce owner/recreation replacement across the four entry points; the ninth demonstrates acceptance of a missing-incarnation plugin record. Provider-kind replacement was already rejected. The final SQLite suite has **65 passing tests**, including the full 3 replacement modes × 4 entry points matrix with zero dispatch, missing-incarnation rejection, and same-row reimport recovery.

Final targeted validation after the fix:

- `bun test packages/provider-codex/src packages/gateway/tests/codex-credential-effects.sqlite.test.ts packages/gateway/tests/integration/shared-provider-state.test.ts packages/gateway/tests/providers-registry.test.ts` — **204 pass, 0 fail, 1123 assertions, 13 files**. Evidence: `/tmp/c08-effects-fix1-focused.out`.
- `bun run --filter '@vibe-llm/provider-codex' --filter '@vibe-llm/gateway' typecheck` — both pass. Evidence: `/tmp/c08-effects-fix1-typecheck.out`.
- ESLint on the three fix-round files — no code diagnostics; the existing multi-project configuration warning remains. Evidence: `/tmp/c08-effects-fix1-lint.out`. The earlier full-workspace 35-warning baseline was not relabeled warning-free, and full CI was not rerun by this worker.
- `git diff --check` passes. All 10 protected tracked hashes remain unchanged. Of the previous 12 frozen product paths, only `provider.ts` and `codex-credential-effects.sqlite.test.ts` changed; `provider.integration.test.ts` is the one added owned path. The current 13-path owned/frozen manifests replace the initial candidate manifests.

Root's initial clean CI and D1 results predate this fix. Root retains responsibility for independent rereview and final frozen-tree clean CI/workerd/D1 verification. Product implementation is frozen again pending that review; no other product changes were made in this round.
