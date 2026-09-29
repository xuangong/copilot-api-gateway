# D10A implementation handoff

Status: product implementation and writer-focused verification complete; freeze revision 2 is final for root review, independent acceptance, and full CI. This is the server credential boundary only. D10B's local transaction, wrappers, and UI are not implemented by D10A, and one-command setup is not claimed complete.

## Baseline and ownership

- Worktree: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify`.
- Accepted clean starting HEAD: `4e7b07e18374edbd76e98f78c184490119ac1fd9` (C12).
- HEAD remains that SHA; no commit, push, merge, deployment, live database, real home configuration, CLI installation, or daemon was modified.
- Exact product paths: `task-D10A-owned-paths.txt` (16 files, including all new files).
- Frozen SHA-256 manifest: `task-D10A-frozen-sha256.json`. Root should verify the manifest before and after its final gates. No product writes will occur after this handoff without root reopening the slice.
- Binding contract: `task-D10A-contract-proposal.md`; downstream `task-D10B-execution-brief.md` now references the exact implemented fields and routes, without saved-preferences history.

## Delivered behavior

`setup/artifact.ts` validates a strict client/platform/settings selection with a 16 KiB request cap, 1,024-byte optional model cap, 8 KiB canonical settings cap, no unknown fields/arrays/NUL/empty optional strings/unpaired surrogates, and deterministic canonical JSON. Quotes, Unicode, and newlines survive verbatim. Claude model identities are opaque; effort/context are explicit nullable/boolean selections. Unset effort produces no effort field or reasoning header. Codex derives only the request-scoped installed-ingress WebSocket boolean, defaulting false when absent. The digest includes the actual gateway key and that effective boolean; the preview redacts the credential.

The server returns fixed logical configuration objects. Claude receives `kind: "claude-settings"` and `settings.env` plus optional `effortLevel`. Codex receives `kind: "codex-config"`, a native configuration subset, and `credential: { kind: "gateway-api-key", value }`; no local command/path is accepted or produced. D10B creates its fixed helper paths locally.

Routes:

- `POST /api/keys/:id/setup/preview`: redacted artifact, revision, digest, and touched keys.
- `POST /api/keys/:id/setup/leases`: rederive/recheck the preview, return a ten-minute lease once, and revoke an inserted lease if the post-insert authority/configuration check races.
- `DELETE /api/keys/:id/setup/leases/:leaseId`: real-session current owner/admin revoke by independent UUID, never by bearer.
- `POST /api/setup/exchange`: empty body, no query, only `X-Setup-Lease`; returns one credential-bearing artifact after the atomic winner check. Failed identified leases are revoked; consumed leases are not replayed.

Management routes independently read a real `ses_` session and enabled current user; middleware's legacy `authKind` never grants authority. Assigned-only/API-key/legacy-user-key access is rejected. Current admins can select another owner's or ownerless key; present key owners must be enabled. Cookie use requires same-origin Origin, and every present Origin must match. All route responses are `no-store`; exchange also sets `no-referrer`. Generic auth rejects setup bearer/header use on other surfaces, preserving the dedicated credential domain. Setup paths bypass upstream prewarming/dev auth, and app logs use the fixed `/api/setup` label for setup paths so even an invalid bearer-shaped revoke path does not leak into logs. Unexpected exceptions return a fixed generic 500 without input/exception interpolation.

## Database boundary

Added the next free migration `0021_setup_leases.sql`. It creates only `setup_leases` and expiry/key indexes. The row contains an independent UUID, SHA-256 of the decoded 32 random bearer bytes, canonical settings, authority/configuration snapshots, a key fingerprint, digest, and times/flags. It stores neither plaintext bearer nor raw gateway key. Lease writes do not advance global revision.

`SharedSetupLeaseRepo` is wired through both Bun SQLite and D1 repositories. `consume` uses one conditional UPDATE with `changes === 1`; it fences expected immutable row metadata, unconsumed/unrevoked/unexpired state, current global configuration revision, raw key equality, key identity, null-safe owner snapshot, enabled minter/owner, and current owner/admin permission. Admin permission is re-evaluated in SQL using current email and the actual allowlist, rather than trusting a pre-read boolean. No request-wide transaction assumption is made.

## Verification performed

Behavioral red phases were observed before corresponding fixes: initial 17 route cases failed with absent-route 404; lease replay against existing `/api/keys` exposed its 200 empty-list fallback and was changed to an explicit 401 for setup credentials; oversized canonical settings initially returned 500 and now return 400; an unexpected exchange repository error initially returned 410 and now returns a generic 500 while preventing replay. Root's final self-check also identified unexpected post-insert mint repository errors being converted to 409: a new test observed that failure, then verified generic 500 with the inserted lease revoked. Actual permission/configuration races remain 409.

Final command, run from `vnext/`:

```sh
bun test packages/gateway/tests/setup-artifact.test.ts packages/gateway/tests/repo/setup-leases.test.ts packages/gateway/tests/control-plane-setup.test.ts packages/gateway/tests/control-plane/capabilities.test.ts packages/gateway/tests/control-plane-auth.test.ts apps/platform-cloudflare/src/setup-leases.d1.test.ts
```

Result: **77 passed, 0 failed, 317 assertions** across six files on freeze revision 2. Transcript: `task-D10A-focused-tests.log`. This comprises 56 D10A tests and 21 existing auth/C12 regressions. All database fixtures use temporary SQLite files or actual local Miniflare/workerd D1; no database call is mocked into passing.

Covered: redacted preview; one-use and concurrent redemption; exact TTL; owner/admin/ownerless/wrong-owner/assigned-only/legacy-key/expired-session authority; cookie/explicit-Origin checks; unknown fields, MIME/size/UTF-8/storage bounds; trusted-origin mismatch; unset effort/opaque models; ingress mismatch; mint races; revoke/expiry/key rotation/deletion/owner and minter disable; unrelated revision changes; tampered digest; header-only bearer and inference rejection; secret-free errors/path logs; zero external egress. SQLite and D1 tests mutate live fixture rows after the lease pre-read and exercise key/owner/minter/admin/revision/revoke/expiry/delete fences. Route tests inject real DB mutations immediately before the real consume operation, including resetting fixture revision to independently exercise the correlated authority/raw-key SQL predicates.

Static checks all exited 0 on this source snapshot:

```sh
bun run --filter '@vibe-llm/gateway' typecheck
bun run --filter '@vibe-llm/platform-bun' typecheck
bun run --filter '@vibe-llm/platform-cloudflare' typecheck
# ESLint over all changed TypeScript product/test files
git diff --check
```

ESLint emitted its existing multiple-tsconfig performance advisory, with no lint errors or warnings in the checked files. The workerd suite's first harness attempt exposed this host Bun version's unsupported numeric `beforeAll` second argument; the fixture was corrected to the supported signature and the final actual D1 run passed. No product behavior was changed for that harness issue.

Root reported its mutable independent Bun Claude/Codex and workerd Claude/Codex probes passed. That is root-owned evidence and is not substituted for its pending frozen acceptance/full-CI gate. Writer did not run `bun run ci:local`; root explicitly owns and schedules that required final gate.

## Deliberate limits

- Any global revision change can invalidate a lease and require reminting; no saved preferences or new CAS API exists.
- Strict origin validation compares forwarded/public-origin derivation to the actual request URL origin. Reverse proxies must preserve the public request URL consistently. This slice adds no origin override environment variable or configuration system.
- D10B must independently validate the exact artifact/digest, fixed destination allowlist, helper, and local transaction. D10A does not touch any local client configuration or imply local installation success.
- Workerd was exercised locally with actual Miniflare D1; no Cloudflare production deployment occurred.

Root may now take exclusive runtime/full-CI ownership. The slice remains awaiting root acceptance/integration, not merged or deployed.

## Fix1 addendum — freeze revision 3

Root reopened only I1 (migration baseline) and M1 (normalized trusted origin). This addendum supersedes the revision-2 freeze/count above: `task-D10A-owned-paths.txt` now has 17 paths, and `task-D10A-frozen-sha256.json` is revision 3. The new path is `vnext/packages/gateway/tests/schema-baseline.txt`; exactly one table and two index rows were added by actual SQLite migration replay. All former owned hashes except `setup/routes.ts` and `control-plane-setup.test.ts` remain identical to revision 2.

Trusted-origin validation accepts default HTTPS port and domain-case variants after parsing, while rejecting non-HTTP(S), userinfo, path/query/fragment, malformed candidates, and different origins. The two same-origin regression tests failed with 400 before the fix and pass after it. Existing cross-origin tests remain intact. M2 output noise remains documented without a logging refactor.

Fresh fix1 commands and results:

```sh
UPDATE_SCHEMA_BASELINE=1 bun test packages/gateway/tests/migrations.test.ts
bun test packages/gateway/tests/migrations.test.ts packages/gateway/tests/control-plane-setup.test.ts
bun run --filter '@vibe-llm/gateway' typecheck
bunx eslint packages/gateway/src/control-plane/setup/routes.ts packages/gateway/tests/control-plane-setup.test.ts
git diff --check
```

All exited 0; focused tests: **37 pass, 0 fail, 218 assertions**. The unchanged D1 paths were not rerun under root's explicit scope. Full CI/independent runtime are root-owned. See `task-D10A-fix1-report.md` and its named logs for red/green evidence and scope. Product writes are frozen; D10B remains unstarted, with no commit/push/deploy or user-home change.
