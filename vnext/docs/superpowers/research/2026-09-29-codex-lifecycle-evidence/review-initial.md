## Spec compliance

**Needs fixes.** The F2/F3 package implements the main optional-refresh and parser paths, but I1 violates the explicit OAuth cancellation ownership ruling, and I2 omits required tag filtering for two accepted envelopes. F4 routes/UI are explicitly deferred and are not counted as missing scope.

Reviewed base `585d6f261b23c52927e90ebe08154d61d5fea883` against the frozen, uncommitted `task-C08-parser-lifecycle-review.patch` (2,007 lines). Paths and line numbers below refer to `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`.

## Strengths

- `vnext/packages/provider-codex/src/auth/credential.ts:36-58` centralizes credential normalization, rejects conflicting known account identities, preserves access bytes, and keeps absent display identity and expiry nullable. `auth/import.ts:115-123` rejects ambiguous envelopes rather than choosing one silently.
- `vnext/packages/provider-codex/src/access-token.ts:143-157` gives nonrenewable credentials the actual-expiry branch and a typed forced-refresh error. `access-token.ts:181-199` guards successful mint publication and rereads the authoritative winner instead of returning an uncommitted local token.
- `vnext/packages/gateway/tests/codex-credential-effects.sqlite.test.ts:357-429` adds useful sibling-cancellation and late catalog rejection/reimport/recreation barriers. `vnext/packages/provider-codex/src/provider.ts:115-125` explicitly classifies structured catalog rejection and keeps safe fixed outward errors.
- `vnext/packages/gateway/src/control-plane/upstreams/public-dto.ts:49-71` derives a small allowlisted status instead of exposing private state; `vnext/packages/gateway/tests/codex-public-dto.test.ts:18-46` checks token/private-field exclusion and quota observation projection.

## Important findings

### I1 — Canceling during terminal OAuth recovery still commits terminal state

**Location:** `vnext/packages/provider-codex/src/access-token.ts:163-177` (also the owned operation boundary at `access-token.ts:119-123`).

`waitForOwnedMint` races cancellation only while awaiting `mint`. When OAuth has rejected with `CodexOAuthSessionTerminatedError`, the catch branch awaits a second authoritative credential read and then calls `persistCodexTerminalState` without checking the signal. Canceling during that read therefore still marks the credential `refresh_failed` and returns the OAuth error. The terminal effect helper has no cancellation argument or updater guard (`vnext/packages/provider-codex/src/credential-effects.ts:86-94`). This directly violates the brief's requirement to check cancellation before terminal credential effects and permits canceled discovery/request work to disable an otherwise active stored credential.

**Verified with one focused reproduction, not a rerun of a suite:** used a fresh temporary SQLite file, two real `BunSqliteRepo`/database handles, and a wrapper that pauses only the second real authoritative `getById`. The fake mint rejects with synthetic `invalid_grant`; after entering the read barrier, abort the request and then release it. The second database handle reads the resulting state. Observed output:

```json
{"case":"abort-during-terminal-reread","beforeRelease":"still-pending","outcome":"CodexOAuthSessionTerminatedError","storedHealth":"refresh_failed"}
```

The pause does not fake any SQL result or state mutation. The temporary database was removed afterward. Expected: canceled operation settles as `AbortError`, and no terminal effect is published after cancellation.

**Fix:** carry cancellation across the complete owned credential operation, check it after terminal-recovery reads and before returning a winner, and guard the terminal updater against cancellation during its own asynchronous repository read/CAS preparation, as the success updater already does. Add a real-SQLite terminal-error/read barrier regression; the current cancellation test exercises only a late successful mint.

### I2 — `.tokens` and flat envelopes bypass explicit provider/auth-type filtering

**Location:** `vnext/packages/provider-codex/src/auth/import.ts:125-131`.

The `.credentials`/account paths use `makeSource` and its `platform`/`type` filter at lines 86-95. The `.tokens` and flat paths instead hard-code `supported: true`. Consequently a document explicitly marked `platform: "anthropic", type: "api_key"` is previewed as importable and accepted as Codex whenever it supplies an opaque access token plus exported account ID. This contradicts F2's explicit non-OpenAI/non-OAuth filtering requirement and can select another provider's credential for later OpenAI dispatch.

**Verified with one pure-parser reproduction:** called both `previewCodexJson` and `importCodexFromJson` with wholly synthetic token/account values and the above tags, once with `tokens: { ... }` and once flat. Observed:

```json
{"case":"tokens","filtered":false,"importable":true,"imported":true}
{"case":"flat","filtered":false,"importable":true,"imported":true}
```

**Fix:** apply one tag predicate consistently to every matched envelope and add negative preview/import fixtures for each supported envelope, preserving original source indexes for multi-account documents.

## Minor findings

- **M1 — New lint warnings remain:** `vnext/packages/provider-codex/src/provider.ts:121,125` produces the two `preserve-caught-error` warnings acknowledged in the implementation report. The secret-free error boundary is appropriate, but the warning should be resolved with an explicit narrowly documented safe-error pattern or local rule exception. Do not attach the unsanitized upstream error merely to silence lint.
- **M2 — Invalid previews discard known status:** `vnext/packages/provider-codex/src/auth/import.ts:145-150` substitutes `renewable: false` and `expiresAt: null` for every normalization issue. In particular, `auth/credential.ts:49-50` rejects an expired access-only credential after its actual expiry has been established, then preview reports that expiry as unknown. Prefer retaining validated metadata alongside row issues, so the following UI package can display the actual expired timestamp and avoid representing an unknown renewability result as false. This does not currently enable an invalid import.

## Verification boundary and focused extra reads

- Read the full scoped patch once in sequential chunks, rereading only the chunk whose tool output was truncated. Did not regenerate Git diffs, mutate product files, run reported suites, commit, push, deploy, call live providers, or spawn agents.
- Concrete risk checked outside the diff: whether terminal persistence performs any cancellation check. Inspected `credential-effects.ts:33-95` and `auth/oauth.ts:38-55,104-120`; neither protects the terminal effect against this canceled-read interleaving. The former's unchanged helper body is not present in the scoped interface-only hunk.
- Read `upstream-repo/src/accessor.ts`, its repository type, and `platform-bun/src/bun-sqlite-repo.ts`/`migrate.ts` only to wire the named I1 reproduction to real repository operations. No broad codebase crawl or database mocks.
- Ran two `bun -` focused probes from the verify checkout: the two-envelope parser reproduction and the single terminal-cancellation SQLite barrier described above. All fixtures were synthetic; no token/account values were printed. Saved the combined reusable probe as `task-C08-parser-lifecycle-review-repro.ts` alongside this report (same scenarios plus an exit-code assertion; not separately rerun by this reviewer). Exact reusable command:

  ```sh
  bun /Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption/.superpowers/sdd/2026-09-29-reference-adoption-follow-up/task-C08-parser-lifecycle-review-repro.ts
  ```

  The script imports the verify checkout explicitly, creates/deletes its own temporary database, prints only outcome booleans/error class/health, and exits 1 while either reproduced requirement remains violated.
- The implementation report claims 200 focused passing tests, package typechecks, and two lint warnings. These were not rerun by this review. Root separately reports actual local workerd/D1 lifecycle and credential-effects regressions passing, and final clean CI exit 0 with 4,556 pass / 1 skip / 0 fail and all gates complete (35 warnings). Those root-owned results do not cover the newly reproduced I1 interleaving and are not represented here as independently rerun evidence.
- Cannot verify from this diff alone: the final clean-CI outcome, actual workerd/D1 behavior for the new I1 cancellation barrier, unchanged control-plane owner/key authorization, and unrelated opt-in retention/unknown-versus-zero usage behavior. Root retains those integration checks. No claim is made about real-account renewal.

## Assessment

**Task quality: Needs fixes.** The state/identity fences and primary optional-refresh paths are coherent and the added real-repository barriers are useful. I1 and I2 are reproduced behavioral violations of explicit requirements and should be fixed before this package is accepted; the two minor points do not independently block it.
