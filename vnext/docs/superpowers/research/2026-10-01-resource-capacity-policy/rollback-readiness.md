# Catalog and affinity rollback readiness

Prepared 2026-10-01 by read-only source inspection. This is preparation for Tasks 2/3, not implementation completion or compatibility proof. No tests, benchmarks, network, production, private backups, services, Git mutations or source edits were performed. The only written file is this report. Existing protected files are outside this report's scope.

## Snapshot and evidence boundary

- Repair checkout observed HEAD: `90624cc2d66bc1dc370f0fb0fbb63376dbea4fb5`. Working files, including the inherited overlay, were inspected; this is not a frozen execution manifest.
- Local annotated tag `vnext-deployed-20260928-233856` peels to `e660fb4dfcf1734d10f89e52e2d739b2985c634b`. The tag object itself is `77b1fdf0ae322fb4c3a611e763f4acde0bb71f91`; it must not be confused with the deployed commit.
- Scope comes from MAIN `vnext/docs/superpowers/plans/2026-09-30-cfw-p0-resource-rollback-fixes.md`, Tasks 2/3 and Acceptance. Status checkboxes were not used as current implementation evidence.
- Architecture contract: repair checkout `vnext/docs/superpowers/specs/2026-09-30-vnext-subsystem-architecture-design.md`, section 6, requires mixed catalog writers, publication fencing, retained affinity keys and old/new carrier readers. `vnext/docs/superpowers/research/2026-09-30-cfw-resource-remediation/reference-architecture-comparison.md` requires closing these gates before rollout.
- MAIN's sanitized `rollback-compatibility-components.json` is historical component evidence only: legacy state/import writes left generation unchanged and old helpers forwarded the new outer marker. It explicitly excludes remote D1 and full HTTP ingress. It is not a fresh result from this audit.

## Direct source observations and remaining work

### Catalogs

Existing protections already address part of the original problem:

1. `vnext/packages/gateway/src/repo/shared/repos.ts:637` implements `replaceCredentials` with row/owner/provider checks, configuration/state CAS and an explicit catalog-generation increment. Its final read observes trigger effects. Current `saveState` at line 676 is also CAS-based and checks incarnation/owner/provider, unlike deployed `saveState`, which performs a last-write-wins state UPDATE by ID. These repairs improve current-writer races; they do not repair immutable legacy SQL.
2. `vnext/packages/gateway/src/repo/shared/catalogs.ts:14` defines CURRENT/OWNED fences including upstream incarnation, generation, owner/provider and lease identity. Reads compare generation/fingerprint and publication is fenced. This prevents stale publication when the upstream generation changes.
3. `vnext/packages/gateway/migrations/0018_catalog_coordination.sql` increments generation for config/owner/provider/incarnation/enabled/proxy changes and propagates generation to configuration revision. It deliberately leaves `state_json` out of its identity-change predicate. Migration inventory inspected ends at `0021_setup_leases.sql`; no later legacy-state identity migration was present.
4. `vnext/packages/gateway/src/repo/catalogs.ts:86` excludes mutable credentials from the fingerprint. Current `saveState` updates only state/timestamp, and current `save` still replaces `state_json` in its upsert. Deployed `repos.ts` saveState lines 557–574 updates only state/timestamp by ID; deployed save also upserts state. Therefore a state-only A-to-B replacement has no visible generation/fingerprint invalidation mechanism in the inspected code. Whether any specific legacy import changes config too must be captured per fixture rather than generalized.

Remaining implementation: define a provider-aware credential-identity contract, then add a new numbered migration enforcing its change boundary for legacy state UPDATE/upsert paths as well as current writers. Identity must distinguish account replacement/credential kind where relevant, while excluding rotating access/refresh tokens, expiry, quota and health telemetry. Codex state exposes `chatgptAccountId` and `credentialRevision`; Claude state exposes `accountUuid` and `tokenKind` (`provider-codex/src/state.ts`, `provider-claude-code/src/state.ts`). Those fields are inputs for design, not a sufficient unreviewed SQL algorithm. Specify null/empty/malformed/unknown state behavior before implementing; malformed JSON must neither leak previous catalogs nor turn routine refresh into perpetual invalidation. Coordinate explicit replaceCredentials with the new trigger so it does not accidentally double-increment.

Runtime-unverified conclusion: the inspected mechanism still permits the original state-only identity gap; this audit did not reproduce it on the current checkout or execute migrated SQLite/D1.

### Affinity

Current candidate source already includes authenticated ownership and execution protections:

- `shared/affinity/carrier.ts` recognizes `vnext-affinity:`, derives AES-GCM keys from persisted per-key secrets, binds owner/API-key/key-ID plus domain/companion content, preserves original opaque origin, and rejects corrupt/unknown owned carriers with `invalid_affinity_state` (400).
- `data-plane/shared/affinity-request.ts:14` authenticates recognized markers eagerly for owner-bound keys; candidate selection uses authorized inputs and provider target preparation, blocks lossy translations, and installs a before-inference exact-target fence. `provider-codex/src/affinity-execution.ts` includes generation plus credential revision in its target.
- `shared/affinity/analysis.ts` enumerates Responses reasoning/compaction aliases/program fields and nested agent encrypted content, Messages thinking/redacted data, Chat reasoning_opaque, and Gemini thoughtSignature. It protects tool-associated/required blocks from unsafe removal. Candidate degradation is an existing current-version behavior; it should not be imported into rollback without an explicit safety contract.
- `repo/affinity-secret.ts` stores and validates key material and preserves ownerless raw behavior. Current createRequestAffinity returns undefined without owner/API-key identity. A rollback gate must explicitly cover every authentication class accepted by ingress; copying this early return alone does not establish fail-closed owned-marker behavior there.
- Local Git tree inspection finds no `gateway/src/shared/affinity` directory at deployed `e660fb4d`. Existing candidate support cannot make that immutable baseline understand later-issued carriers. No separately identified baseline compatibility rollback artifact was established by this audit.

Remaining implementation: create a separately named build based on exact `e660fb4d`, preserving the original tag. The smallest safe default is protocol-aware owned-marker rejection before provider dispatch, with a stable restart-required error and actionable fresh-session guidance. Do not strip/decode state or replay tools. Seamless continuation is optional and requires complete owner/key/target authentication plus execution fencing; shared codec support alone is insufficient. Preserve migrated affinity keys/schema and ordinary/foreign input. Establish whether the exact deployed native HTTP/direct/WS ingress already accepts each path; do not assume all current routes existed at baseline. Current native adapters are `apps/platform-cloudflare/src/responses-websocket.ts` and `apps/platform-bun/src/responses-websocket.ts`; HTTP serve entrypoints are under `gateway/src/data-plane/chat-flow/{responses,messages,chat-completions,gemini}/serve.ts`.

Runtime-unverified conclusion: current candidate contains stronger protection than the old component probe, but immutable baseline forwarding/rejection across full native ingress remains unqualified. No restart-required compatibility implementation was found in inspected candidate affinity sources.

## Exact bounded next local verification gate

Execute only after the implementations and rollback error contract are reviewed. This report authorizes no execution. Use synthetic credentials/state, a private temporary SQLite/local D1 database and local provider dispatch counters; no real accounts or cloud traffic. Freeze exact candidate plus overlay/migrations and compatibility artifact before running. No resource measurements are needed for this gate.

### Catalog matrix: 18 fixtures per database adapter

Run each fixture once on real SQLite and once on local workerd/D1 (36 total), using exported legacy repository components from exact deployed commit rather than a hand-written approximation:

| Fixtures | Cases | Required assertions |
| --- | --- | --- |
| 1–4 | Codex/Claude × deployed saveState/deployed save-upsert A→B | Publish A, retain A lease, write B without incidental config change; new read hides A immediately; old lease publish and failure write are rejected; revision/generation change is recorded. |
| 5–8 | Codex/Claude × access/refresh rotation and quota/health update | Same logical identity keeps generation/catalog readable; no refresh storm; stale-state contention follows documented writer semantics. |
| 9–12 | null, empty accounts, malformed JSON, malformed account shape | Explicit reviewed failure/invalidation behavior, no previous-account catalog exposure; capture whether legacy SQL rejects or succeeds. |
| 13–14 | Current replaceCredentials for Codex/Claude | One intended generation transition, old lease rejection, CAS loser preserved. |
| 15–16 | Owner transfer and delete/recreate same ID | Prior owner and incarnation cannot read/publish; admin visibility uses existing policy. |
| 17 | Current-writer vs retained legacy-writer race | Document winner, no stale catalog installed in local cache after identity transition. |
| 18 | New→compatibility rollback→new switch on same migrated DB | Legacy write safety persists, current read/publication works afterward, active/rollback catalog revisions survive collector configuration. |

Pair fixtures 1–4 with reads through owner/admin catalog endpoints, not just raw rows. Record trigger configuration (`recursive_triggers`, foreign keys) for SQLite and local D1 rather than assuming equivalence. Test fixture 9–12 expectations only after the invalid-state contract is explicit.

### Affinity matrix: protocol cases plus ingress boundaries

First run 14 logical cases at the codec/gateway boundary: (1) ordinary request; (2) raw foreign opaque value; (3) valid Responses reasoning; (4) all three compaction names in one fixture; (5) program/program_output encrypted_content + fingerprint; (6) nested agent-message multi-slot group; (7) Messages thinking + redacted; (8) Chat reasoning_opaque; (9) Gemini thoughtSignature; (10) corrupt/unknown-version/truncated owned marker variants; (11) wrong owner/key or missing/deleted persisted key variants; (12) cross-protocol/domain/companion substitution variants; (13) tool-result-associated history and required continuation input; (14) unavailable target, disabled/pinned route, account/model revision change variants. For a rejection-only rollback artifact, all owned cases reject with the specified restart-required contract, preserve caller input and have zero provider dispatch; ordinary/foreign cases retain baseline behavior. If continuing owned state is selected, valid cases additionally prove authenticated exact target and returned original bytes/origin; every unprovable case still rejects without dispatch.

Then run six full ingress boundary fixtures: current HTTP carrier issuance→rollback HTTP replay, direct HTTP route, native workerd WS first create, native workerd WS continuation create, native Bun WS first create, native Bun WS continuation create. Use nested/tool-associated carrier variants in these fixtures; record explicit path/authentication scope. If a path did not exist at immutable baseline, prove its compatibility-artifact behavior and classify this as an added boundary, not a baseline compatibility success. On each supported ingress run ordinary, raw foreign, valid owned and corrupt owned variants (24 boundary executions). Reject/error framing must precede upstream dispatch; a rejected WS turn must not silently consume/replay continuation or corrupt the next fresh turn.

## Required reviewable artifacts

Produce `rollback-local-acceptance/manifest.json` containing deployed commit/tag, exact candidate/overlay/migration hashes, compatibility source base + patch/build hashes, runtime versions, test harness hashes, synthetic fixture IDs, DB trigger options and supported ingress map. Produce `catalog-results.json` with per-fixture before/after generation/revision/catalog readability, retained-lease results and code-switch receipts; `affinity-results.json` with carrier/auth/route classification, expected/actual error contract, payload preservation hash and dispatch counts. Attach sanitized local HTTP/WS transcripts and database readbacks, plus an independent review explaining any failed/skipped cases. No secrets belong in these artifacts.

Publish a recovery runbook naming the separately identified supported rollback artifact, preserved schema/key/catalog revisions, rejection/fresh-session behavior and code-switch sequence. Explicitly state that immutable `e660fb4d` alone is not the supported carrier-compatible rollback target. Local acceptance is a prerequisite; it cannot substitute for the plan's later isolated remote D1/code-switch acceptance, combined CI/resource qualification or production recovery proof. Resource gate results remain unchanged by this preparation.
