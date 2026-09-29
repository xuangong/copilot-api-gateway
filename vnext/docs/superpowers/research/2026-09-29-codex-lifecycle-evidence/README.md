# Codex parser and optional-refresh lifecycle acceptance

C08 now accepts bounded Codex credential documents in tokens, credentials, accounts, data.accounts, and explicit flat envelopes, with stable source selection and no network verification. Ambiguous documents and conflicting account identities are rejected. Explicit foreign provider/auth tags are filtered consistently. Expiry and optional display identity remain nullable; JWT decoding does not confer gateway authorization.

Access-only credentials use their actual expiry and never trigger OAuth or an automatic authentication replay. Unknown-expiry renewable credentials refresh before use. Structured invalidation is terminal; generic access-only rejection is fenced to the captured bearer/revision/row/owner. Catalog discovery retains its no-replay behavior. The public Codex status is an allowlist containing health, renewability, expiry and quota observation time, without private state or credentials.

The signaled OAuth operation owns cancellation through its initial read, mint, terminal recovery, repository updater and authoritative winner read. Unsignaled callers retain scoped coalescing. Different signaled callers can mint concurrently; SQL CAS remains the correctness boundary. Responses, compact and alpha-search retain prepared request identity and body across authentication retry.

## Verified evidence

- Writer focused tests: **213 pass / 0 fail**, including real-file, two-handle SQLite barriers and parser envelope/identity/expiry fixtures. [Implementation report](implementation-report.md).
- Independent initial review found two Important defects: cancellation during terminal recovery could still persist refresh_failed, and tokens/flat envelopes skipped explicit foreign tags. Both were fixed and independently re-reviewed with no new blockers. [Initial review](review-initial.md), [fix review](review-fix1.md).
- The cancellation gap was separately reproduced in actual local workerd/D1 before the fix. [Expected failure](initial-terminal-abort-red-result.json). The final frozen probe passes **25 cases**, including cancellation during mint on all three execution entrypoints and terminal-read, terminal-effect-preparation, and success-winner-read barriers. [Final runtime result](final-result.json).
- The accepted credential-effects runtime was rerun against these product hashes: atomic refresh/access publication with quota, stale-effect fences, unchanged retry bodies/identity, and all 12 initial authorized-target replacement cases pass. [Regression result](credential-effects-regression-result.json); the executable remains in [the credential-effects evidence](../2026-09-29-credential-effects-evidence/README.md).
- Final clean-tree `bun run ci:local`: **4,569 pass / 1 existing skip / 0 fail**; purity, workspace typechecks, lint, dashboard build and Workers dry-run pass. Lint retains **35 warnings** and its multi-project configuration notice. This is not a warning-free claim.

[Product SHA-256](product-sha256.json) identifies the final candidate; [initial hashes](initial-product-sha256.json) identify the reviewed pre-fix candidate. Existing owner/key authorization and unrelated retention/usage regressions pass in full CI; this provider package does not modify those routing policies.

Minor review items remain tracked for final branch review: safe-error lint warnings and invalid preview rows losing otherwise validated expiry/status metadata. Invalid rows remain nonimportable; the following UI package must not display those placeholders as confirmed credential facts.

## Boundaries and reproduction

This package completes C08 parser/lifecycle foundations only. Authorized preview/import/reimport/refresh routes and the dashboard flow are the next package. No migration or environment variable is added here. No push, deployment, live OAuth, paid inference or production account change was performed.

The runtime uses actual local workerd, all migrations through 0019 and the production D1Repo. HTTP responses are synthetic injected Fetcher responses; it does not establish external HTTP behavior, cross-region D1 behavior, or real-account renewal.

```sh
VNEXT_PROBE_ROOT=/absolute/path/to/checkout node /absolute/path/to/evidence/final-runtime.mjs
```

Dependencies must be installed in the target checkout. The probe explicitly resolves Miniflare 4.20260601.0 and Wrangler 4.97.0. It creates disposable local storage, disposes Miniflare after execution and retains scratch evidence. The pre-fix failure is historical evidence, not a green acceptance result.
