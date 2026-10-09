# API Key upstream access implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the scoped tasks and review their results. Track each checkbox.

**Goal:** Let each API Key inherit the existing upstream scope or select an ordered whitelist, including an explicit empty scope.

**Architecture:** Extend the existing Key routing policy and configuration snapshot. Enforce scope at provider enumeration before materialization, and reuse it for catalogs and helper routes. Persist settings atomically and expose a small Key editor.

**Tech Stack:** TypeScript, Bun, SQLite/D1, Hono, React.

**Spec:** `docs/superpowers/specs/2026-10-09-key-upstream-access.md`

## Global Constraints

- `null` inherits; `[]` denies all; lists are ordered whitelists with no implicit tail.
- Preserve owner visibility, explicit pin and affinity constraints; no new failover behavior.
- Malformed persisted lists fail closed. No new hot-path SQL or shared-cache mutation.
- Migration 0023 only; English source/docs and translated UI strings; strict types, no any.
- Preserve unrelated main-worktree edits and existing Docker/CFW/SSH runtimes.

### Task 1: Persistent policy and control plane

Files: shared/api-key-model-mappings.ts, new shared/api-key-upstreams.ts, shared/credential-auth.ts, repo/types.ts, repo/shared/repos.ts, repo/configuration-cache.ts, migrations/0023_api_key_upstreams.sql, control-plane/api-keys/routes.ts, control-plane/lib/api-keys.ts, focused repo/control-plane tests.

Produces: optional internal upstreamIds fields, API DTO/PATCH upstream_ids and safe GET /:id/upstreams choices described in the spec. Only this task owns the shared policy type and credential-auth projection. Export normalization helpers from shared/api-key-upstreams.ts if useful; consumers need only the field contract.

- [ ] Add failing SQLite tests and route tests. Core assertions: `expect(saved.upstreamIds).toEqual([])` and `expect(saved.upstreamIds).toEqual([b.id,a.id])`; old rows remain `null`, foreign IDs return 400, unauthorized callers return 403.
- [ ] Run focused tests, record RED failure in task report.
- [ ] Implement nullable JSON storage and field-local patch, strict parser, permission checks, safe choices, auth projection and revision invalidation. Verify invalid model mappings never clear an upstream whitelist.
- [ ] Run tests and relevant typechecks; record GREEN evidence and exact owned files. Do not commit while other workers edit the shared worktree; root coordinates commits.

### Task 2: Data-plane enforcement

Files: data-plane/providers/registry.ts, routing/candidates.ts and binding-resolver.ts, chat-flow/shared/select-binding.ts and necessary protocol adapters, models/routes.ts, embeddings/routes.ts, images/routes.ts, Gemini/DMR/Ollama catalogs, provider-backed helper dispatch, focused routing/integration tests. Avoid editing Task 1 shared files or dashboard files.

Consumes: ApiKeyRoutingPolicy.upstreamIds and auth projection from Task 1. Produces uniform optional upstreamIds options, ordered filtering before provider creation and catalog dedupe. Preserve legacy undefined semantics.

- [ ] Add failing tests with duplicate models and keys ordered `[B,A]` versus `[A,B]`; check scope `[]`, foreign/disabled/stale IDs, pin outside whitelist, alias resolution, inherited affinity, catalogs and non-chat paths.
- [ ] Run focused tests and record RED before implementation.
- [ ] Implement request-local filtering/order, policy propagation to all relevant ingress paths, safe catalogs and suppression of virtual token fallback for explicit scope. No whitelist escape via retries, translation, or auxiliary dispatch.
- [ ] Verify focused tests/typecheck. Record entrypoint coverage and exact files in report.

### Task 3: Key editor

Files: apps/dashboard/src/api/{types,keys}.ts, tabs/keys/KeyDetailPanel.tsx, new UpstreamAccessPanel and state helper/tests, locale strings and existing affected fixtures.

Consumes: DTO fields upstream_ids/upstream_ids_invalid/can_manage_upstreams, PATCH upstream_ids, GET /:id/upstreams safe choices. Key editing permissions match model mappings. The real existing key API prefix is discovered from api/keys.ts, not assumed.

- [ ] Add failing state tests: null inherits, empty custom remains empty, selection and order stable, cancel resets, removed references visible, restored default saves null.
- [ ] Implement editor using existing patterns; display inherit/custom, selected upstream order, enabled/unavailable states, and explanation that changes affect every caller of the Key. Only selected IDs are saved; never silently convert [] to null.
- [ ] Refresh Key-specific catalog after save, handle loading/errors without destroying drafts. Test API paths, state helper and dashboard typecheck/build.
- [ ] Record RED/GREEN evidence and changed files; root owns commits.

### Task 4: Integration and review

Files: this plan, spec if needed, release-independent validation notes, targeted integration tests for identified gaps.

- [ ] Review each task against its contract and code quality; resolve findings with the responsible worker.
- [ ] Run `bun run ci:local` in the isolated worktree. Investigate failures at the failing boundary, not by weakening checks.
- [ ] Review the complete diff independently, including permission boundaries, empty scope, implicit fallbacks, stale scope and cache invalidation.
- [ ] Validate the inherited dirty collaboration overlay separately if integration touches its files. Preserve all protected main-worktree edits.
- [ ] Commit meaningful changes and merge into local vNext under existing user authorization. Do not push or deploy.
- [ ] Mark completed tasks and report checks, contract, migration and deployment boundary.
