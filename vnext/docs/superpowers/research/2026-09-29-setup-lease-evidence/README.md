# Setup lease server evidence (D10A)

Server credential boundary accepted on the frozen candidate based on `4e7b07e18374edbd76e98f78c184490119ac1fd9`. D10B local transactions, wrappers and UI remain separate; this package alone is not one-command setup.

## Final verification

- Exclusive `bun run ci:local`: exit 0; 5,015 passed, 1 existing skip, 0 failed, 85,438 assertions. Purity, workspace types, lint, dashboard build and Workers dry-run passed. Lint retains 35 inherited warnings and the multiple-tsconfig advisory; successful fixture request logs are present.
- Four fresh independent processes: actual Bun app/temporary SQLite and production Worker/local workerd D1, each with Claude and Codex selections. All passed; all 17 product SHA-256 values remained unchanged.
- Real sessions/owner/admin/assigned-only/legacy credentials, Origin, strict schema/body bounds/MIME, redaction, no egress, no credential in logs/storage, one-use/concurrent winner, expiry/revoke/revision/key rotation/deletion/disabled users/digest and ingress mismatch were exercised. Seven additional direct repository pre-read mutation cases verify the real atomic SQL fence. They are repository sequencing probes, not suspended HTTP-handler claims.
- Initial review found the migration corpus baseline omission; fixed by real replay, adding only one table and two indexes. Equivalent default-port/case origin handling also gained failing-then-passing regressions. Independent scoped review approved the fix.

## Reproduce

From a checkout with Bun dependencies installed, set `VNEXT_PROBE_ROOT` to its absolute root. Run `bun bun.mjs` and `bun workerd.mjs` from this directory for each selection below, in separate processes. Set `D10A_REVOKE_PATH_TEMPLATE=/api/keys/{keyId}/setup/leases/{leaseId}`.

- Claude: `D10A_SELECTION_JSON={"client":"claude","platform":"posix","settings":{}}`, `D10A_EXPECT_UNSET_EFFORT=1`.
- Codex: `D10A_SELECTION_JSON={"client":"codex","platform":"posix","settings":{"model":"mapped-模型-\"quoted\"\nline"}}`. Set `D10A_EXPECT_OPAQUE_MODEL` to that exact decoded model string.

The scripts create isolated temporary databases and block external egress. The workerd script uses the dependency versions recorded in the checkout. The Miniflare dispatch origin is its actual `ready.origin`; a virtual-domain Origin with a rewritten loopback request is a fixture mismatch and was corrected before final acceptance. Runtime scratch directories are retained outside the checkout.

## Boundaries

Migration `0021_setup_leases.sql` must be applied at a later authorized release. No production database, client home, push or deployment was touched. Strict trusted-origin checks require reverse proxies to provide a consistent public request URL; equivalent URL case/default ports are normalized. Global configuration changes may invalidate an otherwise unexpired ten-minute lease and require reminting. Local workerd results are not Cloudflare production measurements. D10B must independently validate the artifact and implement safe local application.
