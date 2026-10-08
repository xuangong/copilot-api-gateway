# Claude Code credential leases and execution provenance

Date: 2026-10-09. vNext baseline: `a613afcfe2248708d93c1b139c2667990232d1cd`. Local reference baseline: `1d7dcd923e260e425120cca0c7a240e93720af27`.

Product commit: `d55a7aec8df53d102dc246f3fe0df231ce4b4bae`, fast-forwarded into local `vNext`. It was not pushed or deployed.

This delivery lets Claude Code ordinary replies carry authenticated origin metadata derived from the credential and raw model that actually executed the request. The prerequisite is a trustworthy credential lifecycle: a late refresh, 401, terminal error or quota observation must not modify a replacement account. The [design](../../specs/2026-10-09-claude-code-credential-lease.md) defines the contracts; [validation.json](./validation.json) records verification status and artifact references.

No deployment, production-data access or live Anthropic account validation was performed. There are no new application environment variables. The environment variables in the reproduction commands below configure disposable test harnesses only.

## Reference value and remaining gaps

The reference establishes the useful protocol behavior: ordinary output carries authenticated upstream/model origin so the client's next history submission can retain its provenance even when the turn has no native opaque signature. A successful import alone is insufficient to prove which credential produced a particular reply.

The reference Claude Code implementation at the recorded commit still coalesces by upstream ID/force, writes refreshed or terminal state by upstream ID and invalidates the currently stored bearer. It does not fence these effects against a credential epoch. Its bounded `invalid_grant` recovery and OAuth/setup-token distinction remain useful; its effect ownership must be strengthened before authenticated origin is treated as trustworthy execution evidence. Relevant reference files are `packages/provider-claude-code/src/access-token.ts`, `fetch.ts` and `provider.ts`.

vNext uses its existing Codex snapshot/lease/effect pattern as the architectural precedent, with provider-local implementations and no Claude-to-Codex package dependency. It preserves Claude request shaping, setup-token behavior and the established protocol affinity carriers. It adds neither sticky routing nor authorization privilege. When history contains state that requires its source, provenance helps select an authorized compatible route; an ordinary origin alone does not pin routing or grant upstream access.

## Contract boundaries

| Boundary | Authority and behavior |
| --- | --- |
| Persistent identity | Physical row incarnation, owner and provider identify the installed slot. Independent credential and catalog generations identify credential replacement and configuration changes. |
| Credential observation | A private immutable target captures the slot, both generations, account UUID, token kind and health/import timestamp. An immutable lease adds the exact bearer used by a dispatch. Tokens remain private and are not placed in affinity or logs. |
| Refresh publication | Read authoritative state before minting, run the request guard, publish access and refresh tokens atomically under an exact effect, then reread the authoritative winner. A discarded local mint is never used for inference. |
| Effects | SQL checks row/owner/provider/credential generation at the initial read, write, no-op validation and every CAS replay. Provider predicates also check active state, account, token kind and the used AT/RT. Refresh publication checks the prior AT too, protecting same-RT concurrent refreshes. |
| 401 and quota | Only the failed bearer can be invalidated. A same-epoch sibling bearer can be reused. The discarded response is closed before retry, and quota writes retain the response's original lease. |
| Execution | Preparation reads an accepted catalog and authoritative identity without discovery, refresh or inference. Required history is guarded before mint and dispatch. The returned execution target comes from the actual dispatch lease and `providerData.upstreamModelId`, not an alias or upstream echo. |
| History | Existing v1 carriers continue to protect native opaque signatures; v2 carries ordinary origin. Normal refresh preserves origin identity. Reimport changes it, including an identical-byte reimport. Missing authoritative generations produce no guessed affinity. |
| Cancellation | Cancellation stops further request-owned mint, catalog work, retry and inference, prevents late local publication and promptly releases the local in-flight entry. Fetchers/guards/signals from different execution scopes do not share an unrelated refresh. |

`accountUuid` is an internal matching field. A setup-token import may derive it locally after profile access is denied, so it is not presented as a server-authenticated Anthropic account identity. `metadata.user_id`, email and public aliases are also not credential authorities.

Catalog/configuration and credential generations deliberately differ. A proxy or configuration edit can make an old execution plan incompatible, but must not discard a valid rotated refresh token. The token can commit under the unchanged credential epoch; the provider then rejects dispatch under the old configuration authority.

A lone `invalid_grant` is ambiguous while another isolate may still be publishing a successful rotation. With no visible winner, the request fails temporarily without permanently terminalizing the account. A published sibling can be recovered once, with another guard before any new mint. Explicit session termination remains a fenced terminal effect. A late mint cannot resurrect a credential already explicitly marked terminal.

## Migration and rollback

[Migration 0022](../../../../packages/gateway/migrations/0022_upstream_credential_generation.sql) adds `upstreams.credential_generation` as a nonnegative integer with default zero, plus a trigger prohibiting decreases. Creation starts at zero. `replaceCredentials` and full-row conflict replacement advance credential and catalog generations, even for identical bytes. Metadata and routine token/quota updates preserve the credential generation. The checked-in schema baseline must match the complete migration corpus.

Claude credential JSON does not change. Local SQLite and actual workerd/D1 checks verify existing JSON bytes survive the migration and legacy explicit-column INSERTs receive the zero default. This demonstrates storage readability, not safe mixed-version credential mutation or transparent history rollback.

A Claude rollback baseline must include this credential lease/reader and execution-provenance contract. An older binary without these protections is not an acceptable Claude continuation rollback target merely because it can read the additive schema. Preserve migration 0022; do not drop its column or trigger on a binary rollback. Do not mix old and new credential writers: old writers do not enforce the new epoch.

For a future authorized rollout, retain the current database/token state, response snapshots and affinity secrets together, along with the verified compatible rollback binary. Do not restore a stale database snapshot as routine binary rollback: it may contain an already-rotated refresh token and make a healthy account unusable. A backup is recovery evidence, not permission to replay old credentials. No production backup or rollback was executed in this delivery.

## Verification and interpretation

The machine-readable [validation record](./validation.json) distinguishes historical failures, focused checks and final CI. Test counts overlap and must not be added together.

- Lifecycle coverage uses two real SQLite connections sharing one disposable file: 29 tests, including reimport/recreation, same-RT races, explicit terminal state, ambiguous `invalid_grant`, stale-cache retry, cancellation and immutable leases.
- The earlier provider/lifecycle/shared-state run passed 126 tests. The joint credential-generation/lifecycle/execution run passed 72 tests before the final cold-cancellation cases were added. The provider suite including those cases passed 39 tests and 150 assertions.
- The copied independent provider probe passed six cases and 33 assertions after reconstruction from its `__ROOT__` template. It independently checks configuration edits during mint, identical-byte replacement, an invalid-grant loser versus a pending winner, actual dispatch identity and cold direct cancellation.
- [D1 results](./d1-results.json) exercise the production `D1Repo` under actual local workerd, including initial/read-write/no-op/retry epoch fences, owned/ownerless rows, migration preservation and monotonicity. The loader uses package resolution rather than versioned Bun cache paths and was rerun successfully.
- [Full gateway workerd results](./workerd-results.json) passed 13 cases: all four protocols in JSON and SSE modes, native signature continuation, cached-401 refresh/retry, and identical-byte reimport behavior. Tool-dependent native state is refused with the existing `503` no-compatible-route contract. Optional incompatible thinking is dropped before dispatch. Harness setup/oracle corrections during early runs were separated from product defects; failures caused by missing synthetic OAuth scope or an incorrect expected status are not claimed as product regressions.
- Initial full CI passed 6,577 tests, skipped one and failed the schema-corpus comparison because the checked-in schema baseline omitted migration 0022. The baseline was corrected and the focused migration check passed. Final full CI passed 6,582 tests, skipped the one existing runtime-X25519 case and failed none, with 241,327 assertions across 601 files. Framework purity, all typechecks, UI build and the Worker deploy dry run passed. ESLint reported zero errors and 41 warnings.

These runs used a dirty checkout containing the scoped implementation and previously protected work. They are not evidence of a clean release artifact. Before the product commit, all 52 protected files still matched their recorded hashes and all 17 product files matched the final tested source manifest. The commit was then fast-forwarded into local `vNext`; both checkouts retained all 52 protected files and matched all 17 tested product files after integration. These checks associate the product source with the verified changes, but do not substitute for clean-checkout release CI. Protected-file checks are tracked separately in `validation.json`.

The ordinary fresh-token provider path used one cache read and zero SQL queries. Its supplied-snapshot token helper added zero repository reads or writes. D1 `saveState` still used two statements for the measured write and no-op paths. These are database-I/O observations; CPU, peak memory/RSS, steady-state memory and latency were not benchmarked here. No performance superiority over the reference, deployed CFW or a previous release is claimed.

## Reproduction

Use the existing installed dependencies and an isolated local output directory. The runners instantiate local Miniflare/workerd with synthetic credentials and intercepted outbound services; they do not deploy or contact Anthropic. Run from the repository checkout under test:

```sh
export VNEXT_PROBE_ROOT="$(git rev-parse --show-toplevel)"
export CLAUDE_LEASE_EVIDENCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/claude-lease-evidence.XXXXXX")"

node "$VNEXT_PROBE_ROOT/vnext/docs/superpowers/research/2026-10-09-claude-code-credential-lease/d1-runtime.mjs"

node "$VNEXT_PROBE_ROOT/vnext/docs/superpowers/research/2026-10-09-claude-code-credential-lease/workerd-roundtrip.mjs"
```

The D1 runner creates its own temporary directory and prints its path with the result. The full gateway runner writes `worker.ts`, `worker.mjs` and `result.json` under `CLAUDE_LEASE_EVIDENCE_DIR`. The recorded verification used Bun 1.3.0 and Node v26.0.0; package resolution uses the checkout's installed Miniflare and Wrangler versions.

Materialize the independent probe by replacing the root placeholder, then run its absolute path so Bun treats it as an explicit test file:

```sh
bun -e 'const root = process.env.VNEXT_PROBE_ROOT; const out = process.env.CLAUDE_LEASE_EVIDENCE_DIR; if (!root || !out) throw new Error("Set the harness paths first"); const source = await Bun.file(`${root}/vnext/docs/superpowers/research/2026-10-09-claude-code-credential-lease/independent-provider-review.test.ts.txt`).text(); await Bun.write(`${out}/independent-provider-review.test.ts`, source.replaceAll("__ROOT__", root));'

bun test "$CLAUDE_LEASE_EVIDENCE_DIR/independent-provider-review.test.ts"
```

The tracked lifecycle, SQL generation and provider execution tests can be run directly:

```sh
bun test \
  "$VNEXT_PROBE_ROOT/vnext/packages/gateway/tests/claude-code-credential-effects.sqlite.test.ts" \
  "$VNEXT_PROBE_ROOT/vnext/packages/gateway/tests/upstream-credential-generation.sqlite.test.ts" \
  "$VNEXT_PROBE_ROOT/vnext/packages/gateway/tests/affinity/claude-code-execution.sqlite.test.ts"
```

For the repository's complete local gate, run `SETUP_TEST_CODEX=/path/to/installed/codex bun run ci:local` from `vnext/`; the recorded local Codex path was `/Users/zhangxian/.local/bin/codex`. Its Worker build step is a dry run. This gate must complete successfully before describing the checked-out implementation as locally validated.

## Remaining boundaries

There is no distributed OAuth refresh mutex, no immediate cross-isolate revocation guarantee beyond existing cache visibility, and no automatic recovery of a rotated token lost outside this storage protocol. Request cancellation cannot undo rotation already performed by the upstream. Legacy repository adapters without epochs cannot distinguish every same-byte credential reimport and cannot issue guessed Claude affinity.

This change does not add a Claude dashboard authorization/import workflow or a usage-probe route; those existing constructors have no newly introduced gateway caller. Live Anthropic behavior, mixed-version operational migration and production CFW resource limits remain separate, explicitly authorized acceptance work. A clean release artifact and measured CPU/memory/latency comparison remain prerequisites for a production release decision.
