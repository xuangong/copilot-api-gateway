# C08 parser and credential lifecycle handoff

Base HEAD: `585d6f261b23c52927e90ebe08154d61d5fea883`. Product edits are uncommitted. C08-F4 route/UI delivery is outside this package.

## Delivered behavior

- `previewCodexJson(raw)` returns stable source indexes, safe identity/display fields, renewability, actual or unknown expiry, importability, and sanitized issues. `importCodexFromJson(raw, sourceIndex)` imports one selected source. The existing auth-JSON and OAuth callback entry points remain available. Supported envelopes: root `tokens`, root `credentials`, root `accounts`, nested `data.accounts`, and an explicit flat token document. Input is limited to 1 MiB UTF-8 and 100 account rows. JWT access-token expiry takes precedence over metadata; unknown remains unknown. Refresh-only rows and access-only unknown-expiry rows are valid when account identity is available. Expired access-only rows are rejected.
- Access-only bearers remain usable until actual expiry, never enter OAuth refresh, and on generic 401 mark only the exact bearer/revision as `access_rejected`. Renewable unknown-expiry bearers refresh before use. `token_invalidated` marks `session_terminated`; renewable generic catalog 401 leaves health unchanged. Catalog 401 does not replay or expose upstream text. Generate, compact, and alpha-search preserve their prepared request identity and body across a single renewable retry.
- Caller cancellation owns the OAuth mint signal, ends promptly even when a fetcher ignores abort, and prevents late mint persistence. A losing mint rereads authoritative credentials and makes at most one recovery mint for a new revision/refresh token. Catalog OAuth coalescing is scoped per fetcher; catalog HTTP receives its discovery signal and an ignored-abort late 401 cannot change health.
- The Codex public upstream DTO adds `credentialStatus: { health, renewable, expiresAt, expiryKnown, quotaObservedAt }`. Health can be `active`, `access_rejected`, `session_terminated`, `refresh_failed`, or `credential_expired`. This is derived from private state and contains no token, revision, device ID, quota payload, or state message. Other providers' DTOs are unchanged.

## Verification

- `bun test packages/provider-codex/src/__tests__ packages/gateway/tests/codex-public-dto.test.ts packages/gateway/tests/codex-credential-effects.sqlite.test.ts`: **200 pass, 0 fail**, including two-handle SQLite CAS/reimport/row-recreation and cancellation barriers.
- Provider and gateway package `typecheck`: pass.
- Targeted ESLint: 0 errors, 2 `preserve-caught-error` warnings in `provider.ts` at the fixed catalog errors. The caught upstream error is intentionally not attached as `cause` to avoid exposing upstream text through error serialization.
- `git diff --check`: pass.
- Root reports an actual workerd/D1 mint-cancellation run with 22/22 passing cases. This report does not claim an independent rerun of that probe or full `ci:local`.

## Scope and integration notes

- Product files are listed in `task-C08-parser-lifecycle-owned.json` with SHA-256 checksums in `task-C08-parser-lifecycle-frozen-sha256.json`. Do not apply a patch containing unrelated dirty Responses/protocol files.
- The ten protected Responses/protocol files were not edited by C08. Their SHA-256 hashes match the authoritative `.superpowers/sdd/2026-09-29-reference-adoption-follow-up/current-user-dirty-sha256.json` baseline (10/10, verified here and independently by root); their content is excluded from C08 hashes.
- No schema migration, environment variable, commit, push, or deploy was made. Real-account renewal is not established by these fixture tests.

## Fix1 — review I1/I2 (2026-09-29)

- **I1:** The signaled credential operation now races cancellation across its initial authoritative read, OAuth mint, terminal-recovery read/effect, successful CAS, and final authoritative winner read. Post-read and pre-return checks make a canceled operation settle as `AbortError`. `persistCodexTerminalState` accepts the operation signal and checks it before submission, inside the real repository updater, and after completion, preventing an abort-ignoring late terminal write.
- **I2:** One explicit provider/auth tag predicate applies to root and nested source records for `tokens`, `credentials`, `accounts`, `data.accounts`, and flat envelopes. Explicit foreign or malformed tags are filtered before preview/import; supported multi-account entries retain their original source indexes.
- Before the fix, three two-handle SQLite cancellation barriers failed and seven parser tag cases failed. After the fix, `bun test packages/provider-codex/src/__tests__ packages/gateway/tests/codex-public-dto.test.ts packages/gateway/tests/codex-credential-effects.sqlite.test.ts` passed **213/213**. The SQLite tests pause the second real authoritative read and the actual `saveState` updater preparation, abort, release ignored-cancel work, and check active persisted health after the late continuation. A success-winner reread cancellation is also covered.
- Provider and gateway package `typecheck` passed. Targeted ESLint for fix1 files passed with zero errors/warnings; the two original `provider.ts` warning items are minor M1 and are deferred. `git diff --check` passed. The ten protected file hashes still match `current-user-dirty-sha256.json` (10/10).
- Root's clean CI 4,556 pass / 1 skip and earlier 22-case workerd/D1 run preceded fix1. Root owns the new actual workerd/D1 rerun and full final CI; this local result does not claim either. No commit, push, deploy, migration, or live-provider call occurred. M1/M2 remain deferred to final review as instructed.
