# C12 capability publication task review

## Spec Compliance

- **Issues found.** The product implementation follows the required request-scoped, default-false design, but the checked-in gateway tests violate the explicit real-SQLite/no-database-mock constraint (R1), and the required fetch-error test is not actually exercised (R2).
- **Cannot verify from the diff:** final frozen full CI, browser observation, and root native Bun/workerd acceptance remain root-owned gates. Earlier mutable root results and the writer's reported runs are not independently executed reviewer evidence.
- Candidate: base `4f8983af9d433d75b41558f8bf9931e571c30385`; all 21 current product/test paths match `task-C12-capability-frozen-sha256.json`.

## Strengths

- Request isolation is explicit: the shared `AsyncLocalStorage` getter defaults to null, while only each native factory's HTTP fallthrough enters the capability scope (`vnext/packages/gateway/src/shared/ingress-capability.ts:7`, `vnext/apps/platform-bun/src/responses-websocket.ts:41`, `vnext/apps/platform-cloudflare/src/responses-websocket.ts:36`). This avoids deriving capability from platform names or unrelated server initialization.
- Catalog transforms retain an explicit default-false boolean and override source metadata for both matched and unmatched entries (`vnext/packages/gateway/src/data-plane/codex/models.ts:60`, `vnext/packages/gateway/src/data-plane/codex/synthesize.ts:141`, `vnext/packages/gateway/tests/data-plane/codex/mapped-catalog.test.ts:33`). The request route supplies the current scope; ordinary model responses are unchanged (`vnext/packages/gateway/src/data-plane/models/routes.ts:199`).
- The authenticated capability response uses no-store, names the single-turn subset, rejects multiplex/fork/reconnect-history claims, and publishes the Workers lifetime byte bound (`vnext/packages/gateway/src/control-plane/capabilities/routes.ts:8`). Optional upstream prewarming is bypassed only for this GET route (`vnext/packages/gateway/src/control-plane/auth/session-auth.ts:73`).
- Dashboard validation fails closed on incomplete capability shapes, checks abort before and after asynchronous work, and combines request generation with render-time origin/session/key matching (`vnext/apps/dashboard/src/tabs/keys/codex-capability.ts:15`, `vnext/apps/dashboard/src/tabs/keys/codex-capability.ts:50`, `vnext/apps/dashboard/src/tabs/keys/ConfigurationPanel.tsx:146`). TOML escaping handles JSON/TOML control differences and invalid surrogate input without changing Claude/Gemini snippets (`vnext/apps/dashboard/src/tabs/keys/configSnippets.ts:98`).
- Real native fixture tests now assert HTTP capability alongside actual upgrade paths, including the Workers 16,777,216-byte limit (`vnext/apps/platform-bun/src/__tests__/responses-websocket.test.ts:91`, `vnext/apps/platform-cloudflare/src/responses-websocket.workerd.test.ts:247`).

## Issues

### Critical

- None found in this task scope.

### Important

- **R1 — Database substitutes violate the binding test contract.** `vnext/packages/gateway/tests/control-plane/capabilities.test.ts:11` returns an incomplete object cast through `unknown` to `Repo`; lines 49 and 52 replace API-key and upstream database operations, and line 65 substitutes credential lookup for the concurrency barrier. These tests bypass the real repository/schema/auth fixture behavior. The C12 brief explicitly requires real temporary SQLite, and `vnext/AGENTS.md` forbids mocked database calls. Replace the fake repo with a temporary migrated SQLite fixture and real owner/key/session rows. Keep concurrency control and network observation outside database-result fabrication. Root's separate real-runtime acceptance does not make the checked-in substitutes comply.
- **R2 — The required fetch-error regression test never reaches fetch.** `vnext/apps/dashboard/src/tabs/keys/codex-capability.test.ts:35` aborts the signal before invoking the reader at line 38. `codex-capability.ts:15` immediately returns false, so the injected throwing fetcher is never called; the test proves pre-abort behavior only. Add a distinct non-aborted fetch-rejection case and assert the fetcher was invoked, retaining the pre-abort case separately. The brief explicitly requires fetch-error/default-false coverage; the current report overstates that coverage.

### Minor

- **R3 — The platform-facing export exposes an unnecessary read API.** `vnext/packages/gateway/package.json:10` exports the implementation module, including `currentResponsesWebSocketIngress` at `vnext/packages/gateway/src/shared/ingress-capability.ts:16`, although platform callers only require `withResponsesWebSocketIngress`. The brief asks to export only the necessary wrapper. A tiny public re-export can keep the reader internal while preserving the existing platform import path. No behavioral defect was found from the extra export.
- **R4 — Reported lint output is not pristine.** `task-C12-capability-report.md:17` records the existing multi-project configuration advisory. This is a known tooling advisory, not a changed-file diagnostic or an additional product blocker; preserve that qualification when reporting validation.

## Focused Checks and Evidence Boundary

- Read the frozen diff once; its first tool response truncated the package/auth/catalog middle, so that missing range was recovered from the same diff. No changed product file was reread except the cut-off `session-auth` middleware boundaries needed to judge authentication and upstream work.
- Named risk: capability reads might still perform upstream work or writes through authentication. Checked the unchanged resolver (`vnext/packages/gateway/src/shared/credential-auth.ts:30`, `:44`) and middleware mounting (`vnext/packages/gateway/src/app.ts:83`, `:141`): credential resolution performs repository reads; the new prewarm exclusion covers the optional upstream path.
- Named risk: UI scope fields might not represent the existing session. Checked `vnext/apps/dashboard/src/state/auth.tsx:19`, `:41`, `vnext/apps/dashboard/src/api/types.ts:4`, and the normal session login response at `vnext/packages/gateway/src/control-plane/auth/routes.ts:76`: the standard session supplies its token, and logout navigates away. No new auth storage or cookie behavior was introduced.
- Named risk: an existing catalog call site could omit the new ingress input. Focused source call-site search found the production route passes it and the pure transform chain forwards it (`vnext/packages/gateway/src/data-plane/models/routes.ts:199`, `vnext/packages/gateway/src/data-plane/codex/models.ts:84`, `:95`).
- Ran only read-only source/manifest checks. All 21 SHA-256 hashes matched. Did not run tests, CI, browser/runtime probes, or Git commands; did not change product files, index, or branch state.

## Assessment

**Task quality: Needs fixes.** No direct product behavior defect was established in this scoped review. R1 and R2 must be corrected before this task's test contract and claimed coverage can be accepted; final frozen acceptance remains with root.
