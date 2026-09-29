# C08 credential effects fix1 scoped re-review

## Finding verdicts

- **I1 — First credential capture can cross an already-authorized owner/incarnation: ADDRESSED.** `vnext/packages/provider-codex/src/provider.ts:73` rejects missing/non-string/empty stored incarnations at construction, and `:82` copies the incoming authorized row's incarnation, owner, and provider into a private target. Catalog's first ensure at `:101`, generation/compact's first read at `:154`, and alpha-search's first read at `:203` all pass that target. The provider therefore cannot acquire the replacement row as its initial credential target.
- **Same-row reimport remains supported.** The target at `provider.ts:82` deliberately does not freeze credentialRevision, allowing the existing authoritative credential-selection logic to select newly imported credentials within the same owner/incarnation. `vnext/packages/gateway/tests/codex-credential-effects.sqlite.test.ts:427` verifies both catalog and generation use the replacement bearer from an older provider binding.
- **Regression coverage addresses the reported interval.** `vnext/packages/gateway/tests/codex-credential-effects.sqlite.test.ts:398` constructs through the production registry/plugin before changing the stored row, then checks owner/recreation/provider replacements across catalog, generation, compact, and alpha-search reject with `UpstreamReplacedError` and no dispatched request. `:422` verifies an unstored record cannot defer incarnation capture until later.
- **M1 — Existing validation warnings: remains ledgered, non-blocking.** The fix report preserves the existing full-workspace 35-warning baseline. The three-file fix lint output has no code diagnostics and retains the existing multi-project configuration warning; this round does not claim warning-free full-workspace lint.

## New breakage in the fix diff

- None found. The product delta is confined to retaining and supplying the authorized target; fixture changes model a stored row consistently.
- Checked the concrete new constructor-contract risk: production construction sites found through `createProviderFromUpstream` are the data-plane registry and the control-plane test/models routes. `vnext/packages/gateway/src/control-plane/upstreams/routes.ts:560` and `:615` obtain their records through owned repository reads before passing them at `:583` and `:637`; the existing registry/plugin path passes its stored record through unchanged. No additional production unstored-row construction site appeared in the focused call-site search.

## Evidence checked

- Read the appended fix1 report and the complete 428-line incremental `task-C08-credential-effects-fix1.patch` once. Did not repeat the original whole-task review or reread changed files outside the diff.
- All 13 current candidate file hashes in the clean verify worktree match `task-C08-credential-effects-frozen-sha256.json`.
- Confirmed `/tmp/c08-effects-fix1-focused.out` contains passing output for the 12 replacement/entry-point cases, missing-incarnation rejection, and same-row reimport; summary is **204 pass, 0 fail, 1123 assertions across 13 files**. The report names the covering command including provider tests, credential-effects SQLite tests, shared-provider-state integration tests, and providers-registry tests.
- Confirmed `/tmp/c08-effects-fix1-typecheck.out` reports provider-codex and gateway exit code 0; inspected `/tmp/c08-effects-fix1-lint.out` for the diagnostic distinction above. Did not rerun suites, invoke git, dispatch agents, access the network, or modify product files.

## Out-of-scope observations

- No new observations. Root's final clean CI and actual workerd/D1 reruns remain independent integration gates; the prior round's cross-task ledger remains in force.

## Verdict

- **Fix round: All blocking findings addressed, no new Critical/Important breakage.** I1 is closed; M1 remains a non-blocking baseline item.
- **Spec compliance: Approved for this scoped fix and the previously reviewed credential-effects package.** This is not full C08 import-feature acceptance.
- **Task quality: Approved**, subject to root's final frozen-tree clean CI/runtime and whole-branch integration gates.
