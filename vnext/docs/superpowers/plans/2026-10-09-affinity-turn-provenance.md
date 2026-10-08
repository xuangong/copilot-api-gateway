# Authenticated Turn Provenance Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task. Mark each completed or blocked package with its evidence.

**Goal:** Carry authenticated execution provenance through ordinary client history and enforce Responses blobless continuation requirements.

**Architecture:** Keep origin metadata, native opaque state and required continuation constraints distinct. Read v2 before enabling issuance, preserving v1 and a usable rollback baseline.

**Tech Stack:** TypeScript, Bun, WebCrypto, SQLite, local workerd.

**Spec:** [Authenticated turn provenance](../specs/2026-10-09-affinity-turn-provenance.md).

## Global constraints

- Existing worktree only; preserve protected-start.json's 52 files.
- No push, deployment, production access, dependency installation or existing service restarts.
- No schema changes; retain stable affinity secret and snapshot contracts.
- Chinese progress, English source/docs. Do not replace frozen benchmark oracles.

## Task 1: reader and routing constraints

Files: `packages/gateway/src/shared/affinity/{carrier,analysis,origin-anchor}.ts`, `src/data-plane/shared/affinity-request.ts`, `tests/affinity/{origin-reader,origin-selection}.test.ts`.

Interfaces: `AffinityCodec.encodeOrigin(target, field, { syntheticItem }): Promise<string>`; decoded `{kind:"origin",target,syntheticItem}` distinct from unchanged owned-v1. `stampAffinityOrigin(protocol,item,target,codec): Promise<Record<string,unknown>>` validates shape and stamps the appropriate slot. Analysis adds `hasRouteConstraints` and `prepareSource()`; `cloneSource()` retains canonical markers.

- [x] Add failing tests for origin roundtrip, empty-native distinction, owner/key/domain/tamper/unknown version, authenticated synthetic shape and slot-only deletion.
- [x] Add failing tests for blobless inheritance, conflicting required targets, foreign-current-item behavior, no-sticky/no-prepare origin-only requests, and metadata-free preparation.
- [x] Implement v2 codec/shape helper; keep v1 codec bytes unchanged. In `selectAffinityCandidate`, gate expensive routing on `hasRouteConstraints` and call `prepareSource()` before translation.
- [x] Run the seven-file reader suite (86 pass / zero failures / 12,497 assertions), gateway typecheck, and independent review. Reader-only rollback baseline: `ba80b869`. Full affinity integration remains Task 4.

Example acceptance: `expect(plan.hasOwned).toBe(true); expect(plan.hasRouteConstraints).toBe(false); expect(plan.classify(other)).toBe("exact")` for an origin-only request. Prefix followed by `{type:"program_output",result:"ok"}` instead requires the authenticated compatible target; foreign fingerprint on the current item prevents inherited ownership.

## Task 2: canonical issuance

Files: `src/shared/affinity/{egress,origin-egress}.ts`, `src/data-plane/chat-flow/responses/turn.ts`; `tests/affinity/{origin-egress,conditional-egress,egress-index}.test.ts` and Responses turn tests.

- [x] Add failing tests for all four ordinary JSON/SSE outputs; no actual/key, usage-only/error, multiple choices/candidates, natural v1, empty outputs.
- [x] Add a bounded origin transducer using Task 1's helper. Responses emits one prefix shared by added/done/terminal/snapshot without double stamping; preserve native IDs and map client indices/sequence numbers. Chat emits origin only where natural v1 is absent.
- [x] Verify sparse/terminal-only/duplicate-ID outputs, late signatures, cancellation and snapshot-before-completed ordering. Update old zero-carrier tests to explicitly document the deliberate contract change.
- [x] Review and commit the writer separately from the reader (`b184053c`); native representation guard is `33701ce7`.

## Task 3: provider and representation gaps

- [x] Audit Claude Code actual identity and refresh/import fences in `packages/provider-claude-code`; implement provider-native capture with tests if it can be made trustworthy in this scope, otherwise record the precise blocking prerequisite without inventing identities.
- [x] Reproduce Messages loss of unrepresentable Responses-native state and add pre-translation rejection in the client representation boundary, preserving legitimately translatable reasoning/tool/text items. The shared guard now also rejects blobless program/compaction/compaction_summary for all three translated clients; 72 initially failing cases pass after the fix. Legacy blobless context_compaction remains outside this package.

## Task 4: integration and closeout

- [x] Exercise the nine registered cross-protocol pairs in JSON/SSE with generated fixture credentials: first output, realistic client history, second provider request without v2. Include Responses store/hydrate and private continuation.
- [x] Run isolated local workerd roundtrips, tamper/authorization and old-reader rejection/new-reader acceptance. Reuse existing local toolchain and synthetic upstreams; no real account data.
- [x] Run `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` with logs retained under this task's evidence directory: ci-local-02 exit 0, 6,506 pass / one existing skip / zero failures; lint zero errors / 41 warnings, build and Worker dry-run passed.
- [x] Independent specification and code review; fix verified findings and rerun affected checks.
- [x] Verify protected file hashes, integrate into local vNext, record commit IDs, tests, skipped scope, resource/rollback boundaries and next priorities in the follow-up index.

## Explicit prerequisites retained after implementation review

Claude Code issuance is deferred: a configuration-only authority would authenticate the wrong credential during a concurrent reimport. Current token success, terminal-error and 401-invalidation writes are not credential-scoped, and refresh coalescing is scoped by upstream ID and force/lazy mode, not credential generation. Before enabling provenance there, introduce a credential lease (row incarnation/owner/provider, authoritative generation, account UUID, token kind, stateUpdatedAt and used token), fence refresh/terminal writes against the old lease, clear only the access token that received 401, scope coalescing by credential generation, and distinguish same-credential rotation from reimport during invalid_grant recovery. Every inference/retry must return the actual lease and dated model. Routine token refresh must preserve affinity identity. This is a concrete prerequisite, not permission to infer a target from an alias.

The first full workerd probe retained three failures for Messages content supplied entirely in content_block_start: Responses/Chat/Gemini streaming translators lose the initial text. The second probe uses normal empty-start + text-delta delivery and validates all 24 paths. Retain the first bundle and fixtures separately; source comparison with the baseline confirms the affected translators are unchanged. This is a reproduced pre-existing gap, not covered by the normal-delta success.

Delivery evidence: [requirements, results, rollback and remaining gaps](../research/2026-10-09-affinity-turn-provenance/README.md). Final workerd-04 passed all 24 cells; SDK acceptance includes explicit legacy Chat collector limitations. All 52 protected files retain their initial SHA-256. No push or deployment occurred.
