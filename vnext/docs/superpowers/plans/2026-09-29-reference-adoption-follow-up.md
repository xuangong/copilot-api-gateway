# Reference Adoption Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement an individually scoped work package task-by-task. This document is the tracking index. The user authorized the implementation pass on September 29; apply its global constraints and preserve the explicitly conditional decisions.

**Goal:** Preserve the useful June–September reference-project changes as an actionable vNext backlog, resolve the uncertain adoption decisions, and deliver each accepted change with evidence of its user-visible behavior.

**Architecture:** Adapt behavior and regression cases to the existing vNext protocol, provider, routing, storage, and platform boundaries. Keep pure protocol projection separate from provider compatibility policy. Split larger features into independent designs before implementation.

**Tech Stack:** TypeScript, Bun, Hono, SQLite/D1, Cloudflare Workers, Docker, React.

**Spec:** The user's September 28 source-comparison request and September 29 instruction to save a follow-up plan and investigate the qualified recommendations. The companion research report is [Qualified adoption decisions](../research/2026-09-29-qualified-adoption-decisions.md).

## Global constraints

- Scope is `vnext/`. Existing collaboration-shim changes and unrelated `PRODUCT.md` must remain intact.
- On 2026-09-29 the user authorized implementing this follow-up plan item by item. Preserve conditional/deferred decisions; do not deploy or push as part of this implementation pass.
- Preserve owner/key authorization, provider identity, request cancellation, opt-in Responses retention, and unknown-versus-zero usage semantics.
- Preserve stored data and credentials. Never put real prompts, responses, credentials, or account identities into research fixtures or logs.
- New database changes require new numbered migrations; never rewrite historical migrations.
- Keep framework dependency boundaries, strict TypeScript, and Bun-based workflows.
- A reference benchmark is not evidence of Bun/Workers production behavior. Keep source proof, isolated reproduction, and live validation separate.
- Recheck the source baseline before implementation. This is a follow-up index, not a blanket cherry-pick plan.

## Baseline and evidence

- Current repository: `/Volumes/Projects/copilot-api-gateway`, branch `vNext`, HEAD `e6780380002809a97981af994347485ebce52e29`, plus existing uncommitted collaboration changes.
- Reference: `/Volumes/Projects/copilot-gateway`, HEAD `1d7dcd923e260e425120cca0c7a240e93720af27`.
- Reference source links below use `https://github.com/Menci/copilot-gateway/commit/<revision>`; the September 28 audit checked the reference checkout against origin.
- Review window: 2026-06-28 through 2026-09-28. Follow-up created 2026-09-29 (Asia/Shanghai).
- Earlier deterministic probes reproduced lost tool restrictions/history, hosted namespace collisions, compressed-body decoding failure, missing SSE frames, refusal/status loss, reasoning-off loss, premature success, and model-editor metadata loss. Reproduce against the implementation baseline before fixing.

## Follow-through designs

- [Pinned WebSocket client acceptance](../research/2026-09-29-websocket-client-contract.md): first-party Codex wire/warmup/fallback evidence; actual gateway/client loopback validation remains required.
- [Provider foundations and capability delivery](../research/2026-09-29-provider-adoption-design.md): catalog fencing, safe credential lifecycle/import, per-call metadata, affinity, Lite, Fast and client WebSocket sequencing.
- [Diagnostics, request bodies and usage experiments](../research/2026-09-29-diagnostics-adoption-design.md): bounded capture/export, replayable bodies, measured SQL tradeoffs and setup transaction design.

## Work packages

Priority means execution order, not an assertion that every source-level risk has happened in production. `P1` addresses correctness or resource lifecycle; `P2` adds resilience/capability; `P3` improves convenience or needs measurement.

### A. Protocol correctness and durable continuation

| ID | Priority / state | Deliverable and acceptance condition | Reference revisions | Primary vNext surface |
|---|---|---|---|---|
| A01 | completed / 854 tests, SDK wire verification and independent review | Propagate mid-stream failure and nonterminal EOF as client-visible failure; never emit a successful translated terminal merely because the source iterator ended. Cover native and translated SSE plus real SDK interpretation. | `6b98c3563` | `packages/gateway/src/data-plane/chat-flow/shared/{upstream-telemetry,translate-stream}.ts`, protocol responders, `packages/translate/src/*/events.ts` |
| A02 | completed / a8b7cc24, SSE/JSON/snapshot output reducer | Build one final Responses output from closed items in output-index order; use it for SSE, JSON, and snapshots. Cover an upstream terminal that omits a previously closed item. | `eaa7058d8`, `54450e743`, `3491c215a` | `packages/gateway/src/data-plane/chat-flow/responses/events/reassemble.ts` |
| A03 | completed / awaited completion snapshot, 354 initial and 123 fix tests; reviewed | Commit enabled continuation storage before promising a reusable response. Slow/failing storage cannot race an immediate continuation or silently claim durable success. Keep retention-off behavior unchanged. | `978dca440`, `2e1790afa`, `d816824f1` | `packages/gateway/src/data-plane/chat-flow/responses/{serve,respond,completion-snapshot}.ts`, `data-plane/dispatch/responses-store-bridge.ts` |
| A04 | completed / e4b2d04f, subset and selector validation | Preserve `allowed_tools` subsets and mode; reject unrepresentable selectors, missing declarations, and ambiguous flat function/custom names. | `478c4efc5`, `1d7dcd923` | `packages/translate/src/responses-via-{chat-completions,messages}/request.ts` |
| A05 | completed / completed callable identity and historical aliases; reviewed | Dispatch hosted tools using completed callable identity, including namespace; keep client collisions, forced choices, historical calls, and injected aliases stable. | `544613969` | `packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts` |
| A06 | completed / structured results and flat custom JSON/SSE generation; reviewed | Preserve custom tool declarations/calls/results and structured function/custom outputs; preserve call IDs and contiguous results, map images to legal target carriers, reject unsupported projections. | `c54fa4d34`, `b077a6ef1` | `packages/translate/src/responses-via-{chat-completions,messages}/` |
| A07 | completed / provenance-safe agent delivery and target image fidelity; reviewed | Preserve readable agent-message delivery and author/recipient provenance without granting user authority; validate and escape projected metadata. | `f2123d771` | `packages/translate/src/responses-via-{chat-completions,messages}/request.ts` |
| A08 | completed / JSON, SSE, replay and failed-status preservation; reviewed | Preserve refusals across JSON, SSE, and replay; a refusal must not become an empty successful Responses result. | `5076ab63f` | `packages/protocols-llm/src/`, `packages/translate/src/` |
| A09 | completed / 8b30cd6b, 23 tests and review | Extend existing HTTP context-window rewriting to Responses SSE errors so Messages clients receive recognizable prompt-too-long failures. | `c42a81293` | `packages/translate/src/messages-via-responses/events.ts`, gateway Messages interceptors |
| A10 | completed / shared off-switch and canonical-first aliases; reviewed | Map reasoning `none` to native disabled thinking; preserve other effort values and canonical-first reasoning text aliases in request and response paths. | `fe554de49`, `9dbea2ff0` | `packages/translate/src/`, gateway reasoning dialect interceptors |
| A11 | completed / opt-in empty tools and strict namespace repair; reviewed | Normalize only explicit empty tools after tool injection; fill empty namespace descriptions only at strict provider boundaries, including nested containers. | `81bb39dba`, `4c00e1f50` | gateway protocol interceptors, Copilot/Azure provider boundaries |
| A12 | evaluated / OpenAI 6.33.0 completes without DONE; retain contract | Determine the supported Responses SSE terminal/sentinel contract; emit one normal `[DONE]` only when the chosen contract requires it, without marking failures successful. | `7e066787d` | `packages/gateway/src/data-plane/chat-flow/responses/events/to-sse.ts`, `respond.ts` |
| A13 | completed / a8b7cc24, cancellation and partial snapshot regressions | Align cancellation outcomes across metrics/dumps and define complete versus partial Responses snapshots. A created-only interrupted response must not silently become a complete continuation. | E03 local HTTP evidence | Responses responder, completion snapshot writer, shared telemetry |
| A14 | completed / own-envelope aliases and atomic compact window; reviewed | Recognize compact aliases, expand own envelopes independently of generation flags, preserve full compact output and atomically replace the continuation window. Keep foreign opaque state unchanged. | E02 source comparison | compact shim, Responses store bridge and HTTP route |
| A15 | P1 / newly confirmed follow-up | Preserve supported `text.format` constraints through Responses-to-Chat/Messages requests; reject unsupported or malformed formats instead of silently dropping them. | A06 source audit and reference request conversion | Responses request translators and shared format validation |

### B. Transport, memory, and storage lifecycle

| ID | Priority / state | Deliverable and acceptance condition | Reference revisions | Primary vNext surface |
|---|---|---|---|---|
| B01 | completed / streaming decode, 625 package tests and Bun/workerd probes | Decode socket gzip/deflate responses and remove stale headers; unsupported codings have explicit errors and release streams. | `0e7702544` | `packages/http/src/parser.ts` |
| B02 | completed / privately classified pre-dispatch fallback; reviewed | Recover the specific pre-request Cloudflare CONNECT rejection through fetch without replaying a request that may already have been sent or bypassing configured fallbacks. | `f708c5422` | `apps/platform-cloudflare/src/cfw-socket-dial.ts`, `packages/dial/src/fetcher.ts` |
| B03 | completed / focused tests and review passed | Parse valid SSE without mandatory colon spacing; cover multiline data, line endings, event reset, chunk boundaries, and pending-reader cancellation. | `8d13dd6ac` | `packages/result/src/parse-sse.ts` |
| B04 | completed / 57fd39bf | Bound raw opaque UTF-16 reconstruction while keeping the wire codec identical, including BOM and lone surrogates. Bun 1.3/1.4.2 and Node 22 isolated retained-heap measurements passed; Workers remains unmeasured. | `be4b17672` | `packages/protocols-llm/src/common/opaque-value.ts` |
| B05 | P2 / design and measurement | Introduce replayable streaming JSON with length, backpressure, cancellation and byte-identical retries; incremental session hashing must preserve digest and derived identity. | `c5be9dee8`, `95fd4dbdf`, `ce8f5b1b4` | HTTP/dial request contracts, Copilot `forward.ts`, Codex `fetch.ts` and `ids.ts` |
| B06 | conditional non-adoption / no reproduced Bun retention leak | Evaluate Blob-based gzip buffer retention on Bun/Workers; adopt lower-retention construction only with relevant evidence. Do not port absent double-clone machinery. | `f1a4fcb2e`, `8074e313f` | `packages/gateway/src/repo/dump-store.ts`, request/snapshot ownership |
| B07 | completed / 59 tests, independent review and local D1 | Connect dump and spilled-file expiration to production maintenance; cover active/disabled/deleted keys, staging grace, reference safety, backlog drain, and failures between row/file deletion. | `392b0c019`, `87ac6e0e9` | gateway dump/spilled-file repositories and both platform maintenance entrypoints |
| B08 | evaluated / 400 rows per tick, 10k SQLite backlog probe | Preserve existing Responses sweep; measure backlog versus per-tick capacity and assess cross-instance leases without reimplementing working single-instance cleanup. | `87ac6e0e9` | `packages/gateway/src/responses-maintenance.ts`, Bun/Cloudflare entrypoints |
| B09 | completed / 33 tests, 5 typechecks, socket regression | Forward caller abort through Custom/Azure/SDF and compose it with timeout/retry cancellation. Verify real socket release, tee cleanup and no retry after cancellation. | E03 source and local HTTP evidence | provider-custom/provider-azure/provider-sdf, http/fetch-retry |

### C. Routing, model catalogs, and provider capabilities

| ID | Priority / state | Deliverable and acceptance condition | Reference revisions | Primary vNext surface |
|---|---|---|---|---|
| C01 | P2 / design ready; implementation queued | Authenticated client-carried opaque origin and explicit compatibility identities; prefer compatible candidates and distinguish required state from optional degradation. Handle signed thinking as a complete block. | `200c82f1b`, `fb5a8da3d`, `a2349daca`, `5ba518abd`, `24003d3dd` | active chat-flow candidate selection, protocol opaque carriers, provider catalogs |
| C02 | P2 / open | Extend existing stale L1/L2 catalogs with cross-instance refresh coordination, configuration/version fences and persistent backoff. Decide cold-cache behavior explicitly. | `5b7f99ae0` | `packages/gateway/src/data-plane/providers/registry.ts` and repository/platform contracts |
| C03 | completed / versioned shared cache and browser acceptance; reviewed | Version code-derived catalog schema/capabilities and show cached models on editor open; explicit refresh reports failures without deleting known routes. | `dfbf066b1`, `3be39e378` | registry, upstream catalog routes, `UpstreamFormModal.tsx` |
| C04 | completed / actual-target capability ownership and collision regressions; reviewed | Preserve custom discovery chat metadata and derive original-image capability from the actual upstream through aliases and public/Codex catalogs. | `1b15195ad`, `04233190c` | provider-custom/Codex models, registry and `data-plane/codex/synthesize.ts` |
| C05 | P2 / design ready; per-call foundation first | Implement Copilot Fast tier as one catalog/raw-model/response/pricing contract; preserve display names and avoid inventing lanes on unsupported endpoints. | `6b7d4fb3e`, `0eb0f55ad` | Copilot variants/interceptors and Codex catalog synthesis |
| C06 | completed / progressive observed usage and late-counter reassembly; reviewed | Add progressive real usage while preserving existing final usage drain, missing counters, refusal and event ordering. Gate unsupported continuous-usage extensions appropriately. | `14f0b7725` | Messages-via-Chat request/events and stream-options interceptors |
| C07 | P2 / provider project | Add Responses Lite only when selected by upstream catalog; verify encoding, identity, streaming, compact, and authentication retry behavior. | `e7b3d6fc9` | `packages/provider-codex/src/{models,fetch}.ts` |
| C08 | P2 / provider project | Support additional credential import shapes with preview and correct optional-refresh/identity/expiry semantics; do not merely loosen validation. | `fadd9aabb` | provider-codex auth/config/fetch and import UI |
| C09 | P3 / open | Show last-observed quota with freshness metadata while preserving rate-limit gates. | `2953c9e01` | provider-codex quota and dashboard |
| C10 | completed / dated fallback prices, exact matches and verified public catalog; reviewed | Audit new catalog models and precise pricing matches against primary sources, preserve operator-supplied values, and separate richer tier billing from table updates. | `07dd802ac` | provider model/pricing sources and catalog revision |
| C11 | completed / capability/config and scoped 426; actual pinned-client fallback verified | Advertise only implemented ingress WS capability; explicit custom-provider supports_websockets=false while unsupported. Version-test precise upgrade fallback responses. | E01 gateway and Codex source/probes | Codex catalog synthesis, generated client config, routes |
| C12 | P2 / pinned client scripted fixtures passed; gateway implementation/acceptance queued | Client WS to shared execution with per-turn authorization, terminal-last durable ordering, cancellation/cleanup lifetime, failed-state eviction and bounded backpressure. Defer native upstream WS/multiplexing. | E01; 67b5db157, 81ad72ea5, e929bd339, 56dddc6dc | platform adapters, chat-flow kit, Responses storage |

### D. Diagnostics and operator experience

| ID | Priority / state | Deliverable and acceptance condition | Reference revisions | Primary vNext surface |
|---|---|---|---|---|
| D01 | completed / editor and backend normalization verified | Preserve complete valid custom model entries through editor load/save; pricing-only entries cannot turn into the literal ID `undefined`. | `48f200f66` (principle and tests) | `apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx`, provider-custom config |
| D02 | P2 / design ready; bounded capture implementation queued | Capture bounded per-attempt upstream HTTP exchanges before protocol parsing, including incomplete prefixes, binary bodies, and retry boundaries. | `911b25337` | dump schema/store, provider HTTP boundary, diagnostics |
| D03 | P2 / open | Expose existing authorized dump browsing and single-record export; redact credentials in every export format without mutating the stored original. | `911b25337`, `463dc4611` | dashboard requests UI, dump control-plane routes |
| D04 | completed / stale-result regressions, dashboard typecheck | Bind proxy test feedback to the tested draft; edits invalidate old results and stale in-flight responses cannot overwrite new draft feedback. | `aac6e2cd4` | `apps/dashboard/src/tabs/proxies/ProxiesTab.tsx` |
| D05 | completed / portable draft, real SQLite and browser acceptance; reviewed | Create a new-upstream draft from an existing configuration while preserving permission boundaries and resetting nonportable OAuth state. | `95051a965` | upstream dashboard and create contract |
| D06 | P3 / open | Add accessible drag reorder over existing order APIs, retaining owner groups, cancellation, and failed-save rollback. | `339d74ef1` | upstream/mapping lists and order state |
| D07 | P3 / open | Multi-select performance filters use OR within dimensions and AND across dimensions and retain removable stale options. | `605942a6c` | dashboard performance state and charts |
| D08 | P2 / local D1 benefit measured; bounded overview ready to implement | Push expensive overview aggregation into bounded SQL without losing ownership filters or decimal precision; include later D1 query-limit fixes. | `05609bfa2`, `6c231fc1f`, `7155c817a` | gateway usage/performance repositories |
| D09 | completed / independent Claude tiers, shell roundtrip and browser acceptance; reviewed | Extend existing CLI snippets with verified model-tier variables; test generated configurations without replacing a live user configuration. | `682289834` | key configuration panel and snippets |
| D10 | P3 / transactional design ready; implementation queued | One-command CLI setup must preserve unrelated settings and include scoped short-lived credentials, revision checks, backups, and rollback. | `b65db0b9e` | setup control-plane and generated shell/PowerShell clients |

## E. Qualified recommendations: research now

These questions must be resolved before turning them into implementation commitments.

- [x] **E01 — Responses WebSocket:** Trace current advertised capability, all ingress/upstream transports, and actual client selection/fallback. Determine whether capability correction is needed before implementing WS. Define authorization, per-turn isolation, cancellation, continuation eviction, backpressure, and CFW session lifetime acceptance. References: `67b5db157`, `81ad72ea5`, `e929bd339`, `56dddc6dc`.
- [x] **E02 — Native compaction plaintext recovery:** Trace the replay prompt, same-backend requirements, retained output, fallback/failure, usage and recovery limits. Compare official opaque-compaction semantics. Decide opt-in scope and prerequisites; do not describe model reproduction as cryptographic or guaranteed lossless decryption. References: `4700f08be`, `7a7b2c66a`.
- [x] **E03 — Client disconnect:** Inspect original retain/drain changes, rollback rationale, current cancel wiring and separate cleanup lifetime. Verify local abort/sidecar behavior without live paid inference. Distinguish cancel, transport uncertainty, and explicit background execution. References: `8602f8825`, `41bc40813`, `68e3b1c58`, `56dddc6dc`.
- [x] **E04 — Existing coverage and runtime applicability:** Recheck GHE, stale catalog refresh, final usage, Responses cleanup, compact output and filter persistence. Run focused existing tests where meaningful. Identify whether reference Node memory findings reproduce on the installed Bun/Workers tooling; preserve unverified production boundaries.
- [x] Save this tracking plan before the qualified-topic investigation.
- [x] Save evidence and decisions in the companion research report and update this index.

### Research resolutions

- **E01:** Correct capability/configuration now; ingress WS requires a separate design. Current Codex gates on provider supports_websockets, not model prefer_websockets alone.
- **E02:** Do not directly port/default-enable model replay as decryption. Keep it experimental; adopt deterministic compact envelope/window fixes as A14.
- **E03:** Preserve disconnect cancellation. Add B09 and A13; do not restore background drain. Cleanup lifetime remains a WS acceptance requirement.
- **E04:** Preserve existing GHE/stale catalog/final usage/Responses sweep/filter behavior. Adopt B04 based on Bun 1.4.2 measurements. B06 remains conditional: bounded Blob screening did not reproduce sustained Bun retained-memory growth; Workers is unmeasured.

## Execution and acceptance sequence

1. E01–E04 are researched. Prioritize B09, A13 and C11 with independently scoped acceptance; research completion does not imply implementation authorization.
2. Execute independently reviewable correctness packages A01–A10, D01, and resource-lifecycle B07. A02 precedes A03; callable identity/subsets precede expanded custom-tool support.
3. Land bounded compatibility packages B01–B04, A11 and D04; pair each with exact failing fixtures and successful cancellation/resource release cases.
4. Design C01 separately; C02/C03/C04 must agree on catalog version and capability ownership. C05/C07 depend on those facts rather than inferred model names.
5. D02/D03 depend on B07 storage lifecycle. B05/B06/D08 start with runtime/scale measurements and retain before/after evidence.
6. Convenience features D05–D10 remain independently deliverable after correctness fixes; their authorization and configuration recovery contracts are part of acceptance.

For each implementation package:

- [ ] Reproduce the listed behavior against current HEAD and inspect active call sites and applicable AGENTS instructions.
- [ ] Record the exact source/test files and cross-package interfaces in a short package-specific design or implementation plan.
- [ ] Add behavioral regressions appropriate to the change, implement the smallest coherent correction, and run focused tests.
- [ ] For storage changes, test real SQLite and platform SQL constraints; for protocol changes, verify both JSON/SSE and affected official SDK behavior.
- [ ] Run required `bun run ci:local` from `vnext/` before PR/release readiness claims.
- [ ] Report verified behavior, remaining runtime boundaries, migrations/flags, and rollout implications. Obtain only the release authorization actually missing at that time; this document itself does not request a release.

## Change log

- 2026-09-29: Recorded the September 28 adoption audit as scoped work packages. Qualified recommendations opened for source research and isolated verification.

- 2026-09-29: Closed E01–E04 research; recorded 222 passing focused tests, local disconnect reproduction and Bun/Node memory measurements. Added A13/A14/B09/C11/C12; retained experimental and runtime-specific boundaries.

- 2026-09-29 implementation: B04 and C11 capability/config completed, reviewed and merged to vNext; focused tests pass. Optional 426 fallback remains unimplemented pending client-version evidence. Full CI pending aggregate checkpoint.

- 2026-09-29 implementation: A02/A13/A09 merged locally, source/behavior reviewed. B08 measured at 400 rows per minute per scheduler; atomic idempotent deletion does not currently require a correctness lease. B06 remains conditional on relevant runtime evidence. See [remaining scope audit](../research/2026-09-29-remaining-adoption-scope.md) for actionable prerequisites and capacity evidence.

- 2026-09-29 implementation: B07 production dump/file maintenance completed with migration 0015, bounded key/file cursors, fenced claims, reference guards and late-write repair. 59 focused tests and three package typechecks pass; independent initial/scoped reviews approve. Retained-key inactive cleanup avoids full-history scans, including two-statement retention changes. [Local SQLite/D1 evidence](../research/2026-09-29-storage-maintenance-evidence/README.md). Remote cron/R2 and cross-store hard-crash atomicity remain explicit boundaries.

- 2026-09-29 D08: [Repeated real-SQLite experiment](../research/2026-09-29-usage-aggregation-evidence/README.md) confirms about 95.6% fewer materialized bytes and lower process peak RSS for a wide synthetic range, but safe SQL was about 1.5x slower and narrow-key memory benefit negligible. Keep the current production path; a bounded overview remains conditional on useful D1/end-to-end evidence. Existing empty-key helper widening is guarded by current production routes, not a demonstrated authorization exposure.

- 2026-09-29 B05 research: [Pinned serializer evaluation](../research/2026-09-29-json-streaming-evidence/README.md) found unbounded large-scalar chunks and native exotic-value differences in json-ext 1.1.0. Foundation implementation must adapt scalar/key chunking and gate plain JSON, or explicitly retain a buffered compatibility path; copying the reference wrapper alone does not establish bounded memory.

- 2026-09-29 implementation: B01/B02 completed and independently reviewed. 625 tests pass/1 existing skip, relevant types and Cloudflare dry-run pass. [Runtime evidence](../research/2026-09-29-transport-runtime-evidence/README.md) adds143 parser tests in isolated Bun1.4.2 and actual parser/workerd gzip/deflate integration. Implicit fetch requires every executed attempt to be positively classified pre-dispatch rejection and preserves configured order. Actual production CONNECT behavior remains unverified.

- 2026-09-29 D08 follow-up: repeated local D1/workerd query-plus-shape probes show87–109ms versus267–269ms for a10k synthetic all-key range and about90% fewer returned bytes, with roughly3x rows_read. The evidence justifies a separate bounded overview implementation; preserve detail and gate dashboard adoption on full authorization/history/bounds/endpoint tests. This updates the earlier SQLite-only deferral.

- 2026-09-29 B07 aggregate follow-up: fixed the historical pre-ledger test fixture to construct migration 0001–0014 before replaying the full current corpus. The 0015 schema remains unchanged; 12 migration tests and 58 related dump tests pass, gateway types pass, and independent review approves. Full aggregate CI will run after the current A08 review fixes.

- 2026-09-29 A08: preserved explicit empty/mixed refusals across Chat, Responses and Messages JSON/SSE/replay, added refusal lifecycle events and structured policy failure mapping, and prevented failed Responses JSON from becoming Chat/Messages success. Initial/scoped independent reviews passed after boundary fixes; clean staged-source ci:local passed 3951 tests with 1 existing skip plus types, lint, UI build and Workers dry-run. Synthetic fixtures establish behavior; no live model/deployment validation was performed.

- 2026-09-29 A08 SDK follow-up: [OpenAI 6.33.0 and Anthropic 0.80.0 synthetic-transport evidence](../research/2026-09-29-refusal-sdk-evidence/README.md) verifies empty/mixed refusal JSON/SSE, actual final-message accumulation, and translated failed-JSON errors. OpenAI high-level helpers independently lose an empty Chat refusal or retain an in-progress Responses snapshot after response.failed; native wire/low-level events remain correct. No live network/model validation or Gemini SDK evidence.

- 2026-09-29 A10: shared reasoning-effort translation maps none to disabled in both directions, preserves other effort values, and gives the explicit disabled switch precedence. Canonical-first reasoning text aliases now cover history, JSON/SSE and opt-in gateway normalization while native passthrough retains vendor fields. Independent review approved; clean staged-source ci:local passed 3968 tests/1 existing skip, all types, lint (0 errors; 36 inherited warnings), UI build and Workers dry-run. No live provider claim.

- 2026-09-29 C06: progressive real usage now preserves sparse/zero counters, role-only startup waits for observed usage/output, and Messages JSON reassembly retains late input/cache values. Initial and scoped reviews passed; clean-source ci:local passed 3980 tests with 1 existing skip, all types, lint (36 inherited warnings), UI build and Workers dry-run. [Official Anthropic SDK synthetic evidence](../research/2026-09-29-progressive-usage-evidence/README.md) verifies final accumulation. No unsupported continuous-usage request flag or live-provider claim.

- 2026-09-29 Dashboard verification: [isolated actual-browser D01/D04 checks](../research/2026-09-29-dashboard-browser-evidence/README.md) passed on clean bcac1e4d. Valid model metadata/pricing survives real save and reopen; stale proxy feedback is ignored/cleared. Temporary SQLite and synthetic loopback/browser-intercepted transports only.

- 2026-09-29 C03/C04: Added a separate code-derived catalog revision, cache-only editor opening, explicit refresh with preserved lists, and draft request gates. Custom/Codex metadata and original-image capability follow actual upstream candidates, including existing model ID aliases. Initial and fix1 reviews pass; clean final CI: 4006 pass, one skip, zero failures; types, purity, lint (36 inherited warnings), dashboard build and Workers dry-run pass. [Actual browser evidence](../research/2026-09-29-catalog-browser-evidence/README.md). C02 SQL publication fencing remains separate.

- 2026-09-29 C10: Corrected dated Copilot fallback prices and precise model-version matching, added published display tiers, and advanced code-derived catalog revision to 3. Current public price inventory matches the 33 audited official rows; historical/internal fallbacks remain available without a blanket current verification claim. Initial and fix1 reviews pass. Final clean CI: 4013 pass, one skip, zero failures, all types/purity/lint/build/Workers dry-run pass. [Dated evidence and scope](../research/2026-09-29-pricing-snippets-evidence.md). Long-context billing, operator prices and prior stored usage remain unchanged.

- 2026-09-29 C04 catalog follow-up: Real D09 browser acceptance exposed missing Custom manual/discovered endpoint metadata. Missing public fields now derive from configured callable bindings; explicit raw fields remain intact. Embedding/image/default-chat inference is bounded by configured endpoints. Revision 4 invalidates older derived snapshots. Initial and fix1 reviews pass; combined clean CI with D09: 4023 pass, one skip, zero failures; types, purity, lint, build and Workers dry-run pass.

- 2026-09-29 D09: Added optional independent Opus/Sonnet/Haiku defaults to shell/settings snippets and accessible selectors. Exact mapped aliases, primary-model headers/effort and small-fast behavior remain intact; shell metacharacters roundtrip safely. Key changes reset optional choices and unavailable catalog values are cleared. Independent review, seven focused tests, final combined clean CI (4023 pass, one skip), and [actual browser acceptance](../research/2026-09-29-cli-tier-browser-evidence/README.md) pass. No live Claude settings were changed; Fable remains outside the inspected client version.

- 2026-09-29 A14: Own legacy compact envelopes expand for both aliases even with generation disabled; successful current-turn triggered compaction atomically replaces the snapshot with the complete canonical output window. Historical triggers, failed/incomplete results, explicit compact and opt-out retention remain isolated. Foreign typed arrays pass through after narrowing recognition to the actual historical encoder shape; exact same-shape legacy ambiguity remains because old blobs have no authenticated marker. Initial and fix1 reviews pass; final clean CI: 4034 pass, one skip, zero failures, all types/purity/lint (36 inherited warnings)/UI build/Workers dry-run pass. Real SQLite JSON/SSE immediate continuation is covered; no model replay or decryption claim.

- 2026-09-29 C11/C12 runtime prerequisite: the pinned Codex 8ff74cc9 first-party 426 fallback and same-connection prewarm fixtures were compiled and actually executed against their scripted loopback servers. Both pass with a 16 MiB Rust test-thread stack; the initial default-stack SIGABRT is retained in the evidence. [Runtime results](../research/2026-09-29-websocket-client-fixture-results.md). Public dependency downloads and build artifacts were isolated; live CLI/configuration remained untouched. This closes the client-fixture readiness gap, while vNext gateway acceptance remains pending.

- 2026-09-29 A05: Hosted dispatch waits for completed function-call identity, including late names and namespace; client lifecycle frames replay exactly once. Flat historical function/custom inventories participate in alias collision validation, namespace children remain valid, and forced namespaced choices survive hosted turns. Client argument forwarding is delayed until identity completion while the hosted shim is active. Initial/fix1 reviews pass; final clean CI: 4048 pass, one skip, zero failures, all types/purity/lint (36 inherited warnings)/UI build/Workers dry-run pass. The clean baseline exposed and removed an accidental dependency on an unrelated uncommitted type extension; protected collaboration edits remain unchanged.

- 2026-09-29 C11 upgrade follow-through: authenticated Responses WebSocket upgrade attempts now receive shared HTTP 426 fallback on both ordinary and Codex-prefixed mounts. Ordinary/incomplete GETs, unrelated routes and POST/authentication behavior remain unchanged; no WebSocket support is advertised. Independent review approves; clean CI: 4056 pass, one skip, zero failures, all types/purity/lint (36 inherited warnings)/UI build/Workers dry-run pass. [Actual pinned Codex-to-Bun gateway acceptance](../research/2026-09-29-websocket-gateway-evidence/README.md) changed from two GET 404 to one GET 426, followed by exactly one successful POST and one counted synthetic upstream call. Dedicated services stopped; live Workers handshake and C12 supported frames remain unverified.

- 2026-09-29 A07: Cross-protocol agent deliveries retain their input position, escaped author/recipient provenance, readable typed content and supported native images without granting user authority. Unsupported opaque/file-only content and unrepresentable image detail fail with exact input paths. Chat preserves auto/low/high; Messages accepts absent/auto and rejects other detail hints. Ordinary-message behavior remains unchanged. Initial and fix1 reviews pass; final clean CI: 4064 pass, one skip, zero failures, all types/purity/lint (36 inherited warnings)/UI build/Workers dry-run pass. [Synthetic official SDK acceptance](../research/2026-09-29-agent-message-sdk-evidence/README.md): 32 cases, 18 counted upstream requests, 14 precise pre-dispatch rejections, and both streaming terminal events.

- 2026-09-29 A11: Added opt-in `empty-tools-tool-choice-none` (default off for all providers). Explicit empty tool lists normalize after tool injection and before forced-tool reasoning handling across all three protocols. Copilot/Azure request boundaries fill empty namespace descriptions with copy-on-write across top-level, historical inventories and namespace children; other transports and canonical payloads remain unchanged. Direct provider generate/compact/error tests and independent review pass; final clean CI: 4086 pass, one skip, zero failures, all types/purity/lint (36 inherited warnings)/UI build/Workers dry-run pass. This does not claim a new native compact endpoint. Original overlapping collaboration edits are preserved outside this commit.

- 2026-09-29 A06: Added flat free-form custom tool declarations/history and request-scoped reverse identity after allowed-tools selection for both JSON and SSE. Unsupported grammar/namespaces remain explicit errors; mixed custom Chat streams buffer tool arguments until complete identity, while ordinary-only streams stay incremental. Review found and fixed false Messages success on unclosed blocks; JSON/SSE terminal tool statuses now match completion. Initial and two scoped fix reviews approve. Final clean CI: 4107 pass, one skip, zero failures, all types/purity/lint (36 inherited warnings)/UI build/Workers dry-run pass. [Official SDK evidence](../research/2026-09-29-custom-generation-sdk-evidence/README.md): nine cases, including malformed stream failure, nine counted synthetic upstream requests. Independent text.format loss is tracked as A15, queued after D05.

- 2026-09-29 D05: own-owner Custom/Azure/SDF duplicate drafts preserve supported model metadata/pricing, flags, disabled selections and proxy order while clearing credentials and identity. Default-header omission is explicitly disclosed. Independent review and two fix rounds passed; clean CI4114pass/1skip/0fail and real SQLite/Chromium acceptance passed. [Evidence and copy limits](../research/2026-09-29-upstream-duplicate-evidence/README.md). No deployment.
