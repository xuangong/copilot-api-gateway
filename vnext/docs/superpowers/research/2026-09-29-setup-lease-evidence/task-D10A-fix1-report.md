# D10A fix1 handoff

Status: fix1 complete and frozen at revision 3 for root acceptance. D10B has not started. No commit, push, deploy, agent/runtime startup, real-home configuration change, or child agent was performed.

## Scope and result

- I1: regenerated `vnext/packages/gateway/tests/schema-baseline.txt` by the existing `UPDATE_SCHEMA_BASELINE=1` test workflow against actual in-memory SQLite migration replay. Verified the previous baseline is wholly retained and exactly three rows are added: table `setup_leases`, indexes `setup_leases_expiry` and `setup_leases_key`. No other schema drift or migration edit.
- M1: `trustedOrigin` now parses the forwarded/public origin and compares normalized `URL.origin` values. Explicit HTTPS default port and domain case variants are accepted and produce the exact same preview. Before parsing, reject extra path/query/fragment components (including empty delimiters), userinfo, backslashes, and whitespace; retain HTTP(S)-only and actual request-origin equality checks. Malformed candidates return the fixed invalid-request response.
- Tests add two equivalent-origin cases and one bounded invalid-components/schemes case; existing different-host/different-protocol rejection assertions remain unchanged.
- M2 remains the documented minor output-noise item; no logging refactor.

## Fresh verification

Commands below ran from the product tree's `vnext/` unless stated otherwise.

1. `bun test packages/gateway/tests/migrations.test.ts` before regeneration: 5 pass, 1 fail, 31 assertions. Failure is the expected baseline mismatch. Log: `task-D10A-fix1-migrations-red.log`.
2. `bun test packages/gateway/tests/control-plane-setup.test.ts` after adding regressions, before the route fix: 29 pass, 2 fail, 185 assertions. Both equivalent-origin cases returned 400 instead of 200. Log: `task-D10A-fix1-origin-red.log`.
3. `UPDATE_SCHEMA_BASELINE=1 bun test packages/gateway/tests/migrations.test.ts`: exit 0; real replay regenerated the baseline. Log: `task-D10A-fix1-baseline-update.log`.
4. `bun test packages/gateway/tests/migrations.test.ts packages/gateway/tests/control-plane-setup.test.ts`: **37 pass, 0 fail, 218 assertions**. Log: `task-D10A-fix1-focused.log`.
5. `bun run --filter '@vibe-llm/gateway' typecheck`: exit 0. Log: `task-D10A-fix1-typecheck.log`.
6. `bunx eslint packages/gateway/src/control-plane/setup/routes.ts packages/gateway/tests/control-plane-setup.test.ts`: exit 0; existing multiple-tsconfig performance advisory only. Log: `task-D10A-fix1-lint.log`.
7. `git diff --check` from the product root: exit 0.

D1 implementation, migrations, and D1 tests did not change, so the D1 suite was not rerun under root's explicit scope. Full CI and independent runtime acceptance remain root-owned and are not claimed by these focused results.

## Freeze

- Baseline HEAD remains `4e7b07e18374edbd76e98f78c184490119ac1fd9`.
- `task-D10A-owned-paths.txt` now contains 17 paths; the sole new owned path is the schema baseline.
- `task-D10A-frozen-sha256.json` is revision 3, covering all 17 paths.
- Compared each former owned path against revision 2 before freezing: only `setup/routes.ts` and `control-plane-setup.test.ts` changed. All other former owned hashes match revision 2.
- Product writes are stopped after this handoff until root explicitly reopens the slice.
