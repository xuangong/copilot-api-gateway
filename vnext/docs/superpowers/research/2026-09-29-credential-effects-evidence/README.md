# Codex credential effects acceptance

This package fences asynchronous Codex credential effects by immutable upstream row incarnation, owner/provider, persisted credential revision, and the exact access or refresh token used. New import constructors generate revisions; legacy rows retain an absent revision until a legitimate update. Refresh rotation commits its refresh/access pair in one CAS update. Late success returns a usable authoritative credential, and stale failure, invalidation, quota and 401 handling cannot mutate a replacement credential.

This is the credential-effects foundation of C08. Optional-refresh parsing, authorized import/reimport routes and dashboard import remain separate work.

## Before and after

At baseline `434f97e85c57cea16075cefd97c2bd3061f5d3f3`, the actual local workerd/D1Repo probe replaced a credential while its old mint was pending. The old mint returned its stale token and overwrote the replacement access token while retaining the new refresh token. `baseline-result.json` records successful reproduction of that defect; its `passed` value means the reproduction assertions passed, not that the baseline was safe.

The final probe uses actual local workerd, migrated D1 storage, the production D1Repo and Codex provider call chains. HTTP responses are synthetic responses injected through the Fetcher interface. This does not establish real external HTTP, live OAuth, paid inference, deployed Worker behavior or cross-region D1 routing.

Frozen-source [runtime results](final-result.json) pass: an SQL audit observes the quota update and the atomic token-pair update with zero partial pairs; losing success and three terminal OAuth failures preserve the authoritative replacement; stale bearer, quota and 401 effects are rejected; 401 uses the latest refresh token; exact-state delete/recreate rejects the old mint and ignores late effects. Responses, compact and alpha-search each execute exactly two terminal attempts with identical prepared bodies and request identities; only compact needs one OAuth mint in its no-access replacement scenario.

The writer reports 204 passing focused tests (1,123 assertions), including 65 real-file/two-handle SQLite cases. Independent review found an earlier identity gap: the provider discarded its authorized record target before the first credential read. Both Bun/SQLite and workerd/D1 reproduced use of a replacement credential before the fix. The provider now copies the construction-time owner/provider/incarnation and requires it at every initial catalog or generation read. The final workerd probe covers all 12 combinations of owner/provider/recreation replacement and catalog/Responses/compact/alpha-search entry; every case rejects with `UpstreamReplacedError` and zero sends. Same-row same-owner reimport remains supported by the SQLite suite. [Initial review and reproduction](review-initial.md), [runtime failure summary](initial-target-red-result.json).

**Final independent spec/quality rereview: Approved.** [Scoped fix review](review-fix1.md) closes the initial-target gap with no new blockers. Final clean-tree `bun run ci:local`: **4,460 pass / 1 existing skip / 0 fail**; purity, all workspace typechecks, lint, dashboard build and Workers dry-run pass. Lint retains 35 inherited warnings and its multi-project configuration notice. These are not warning-free or live-production results. [Implementation report](implementation-report.md) retains the initial and fix-round test history. [Product hashes](product-sha256.json) identify the frozen implementation exercised by this runtime result.

## Reproduction

With dependencies installed in the checkout being tested:

```sh
VNEXT_PROBE_ROOT=/absolute/path/to/checkout node /absolute/path/to/evidence/final-runtime.mjs
```

For the defect reproduction, point `VNEXT_PROBE_ROOT` at the baseline revision and run `baseline-runtime.mjs`. The baseline and final probes use their respective helper interfaces and are intentionally revision-specific. They create disposable local Miniflare storage and use only synthetic credentials. Both dispose their Miniflare instance when finished; scratch artifacts are retained.

The runtime scripts resolve the installed Miniflare 4.20260601.0 and Wrangler 4.97.0 versions explicitly. A dependency upgrade requires updating these local acceptance scripts; it does not change product runtime resolution.
