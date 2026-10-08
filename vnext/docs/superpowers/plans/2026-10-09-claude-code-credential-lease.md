# Claude Code Credential Lease Implementation Plan

**Goal:** Make Claude Code state effects credential-scoped and issue trustworthy execution provenance.

**Design:** [Credential lease and execution identity](../specs/2026-10-09-claude-code-credential-lease.md).

**Constraints:** Existing `cfw-resource-rollback-fix` worktree only; preserve prior dirty files; no push, deployment, production access, dependency installation or existing-service restart. English code/docs, Chinese progress. Integrate verified delivery into local `vNext` under existing authorization.

## 1. Persistent credential epoch

- [x] Add a new migration and stored-record field; no Claude state-format change.
- [x] Add real SQLite failing regressions for same-byte replacement, late write/no-op/CAS replay, ownerless/owned rows and deletion/recreation.
- [x] Fence `saveState` with optional credential generation; increment only on replacement, preserving metadata and ordinary token updates.
- [x] Cover full-save/bundle replacement and catalog generation invalidation.

## 2. Provider credential lifecycle

- [x] Add immutable snapshot/lease/effect helpers and authoritative recovery.
- [x] Scope refresh coalescing to the credential and caller execution scope.
- [x] Fence refresh publication, terminal errors and 401 invalidation; return only an authoritative committed token.
- [x] Reproduce invalid-grant-before-winner-publication and ensure it does not permanently disable the winner.
- [x] Cover cancellation, OAuth/setup-token replacement, repeated refresh and stale-cache recovery.

## 3. Execution capture

- [x] Bind provider construction to its authorized row target.
- [x] Add read-only preparation and required-history guards before refresh and every inference.
- [x] Capture actual lease plus dated wire model on ordinary and retried calls.
- [x] Scope quota writes and close discarded 401 bodies.
- [x] Cover shaped/mimicked traffic and missing-generation behavior without guessing identity.

## 4. Review and local acceptance

- [x] Run independent review and resolve verified findings, including cold direct-fetch cancellation before catalog loading.
- [x] Exercise the production provider and migration under actual local workerd/D1 with synthetic credentials.
- [x] Validate ordinary origin roundtrip and native-signature continuation; verify reimport rejection and raw upstream model identity. Final workerd-06 passes all 13 cases.
- [x] Confirm cached ordinary path query count: one cache read and zero SQL; do not infer CPU/RSS benefits from it.
- [x] Run `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local`: final ci-local-02 exit 0; 6,582 pass, one existing skip, zero failures; lint zero errors / 41 warnings; typechecks, purity, UI/setup builds and Workers dry-run passed.
- [x] Record [evidence, rollback requirements and remaining gaps](../research/2026-10-09-claude-code-credential-lease/README.md). All 52 protected files matched their original hashes before product commit.
- [x] Commit scoped delivery as `d55a7aec8df53d102dc246f3fe0df231ce4b4bae` and fast-forward local `vNext`; no push or deployment.

The final checks ran in the preserved dirty checkout. This is local correctness acceptance, not qualification of an isolated clean release or measured CPU/RSS improvement. CI's first attempt correctly rejected a stale schema snapshot after migration 0022; the schema snapshot was regenerated, focused migration tests passed, and the complete CI rerun above passed.

## Known boundaries

There is no current gateway caller for the Claude-specific import constructors or usage probe. This work does not create those routes. Credential leases are effect ownership, not a cross-isolate OAuth refresh mutex. Real Anthropic token behavior and CFW production resource usage require later authorized testing.
