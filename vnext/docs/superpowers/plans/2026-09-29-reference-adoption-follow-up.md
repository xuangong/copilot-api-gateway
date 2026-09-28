# Reference Adoption Follow-up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement an individually scoped work package task-by-task. This document is the tracking index; unchecked implementation items are not authorization to execute them.

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

## Work packages

Priority means execution order, not an assertion that every source-level risk has happened in production. `P1` addresses correctness or resource lifecycle; `P2` adds resilience/capability; `P3` improves convenience or needs measurement.

### A. Protocol correctness and durable continuation

| ID | Priority / state | Deliverable and acceptance condition | Reference revisions | Primary vNext surface |
|---|---|---|---|---|
| A01 | P1 / open | Propagate mid-stream failure and nonterminal EOF as client-visible failure; never emit a successful translated terminal merely because the source iterator ended. Cover native and translated SSE plus real SDK interpretation. | `6b98c3563` | `packages/gateway/src/data-plane/chat-flow/shared/{upstream-telemetry,translate-stream}.ts`, protocol responders, `packages/translate/src/*/events.ts` |
| A02 | completed / a8b7cc24, SSE/JSON/snapshot output reducer | Build one final Responses output from closed items in output-index order; use it for SSE, JSON, and snapshots. Cover an upstream terminal that omits a previously closed item. | `eaa7058d8`, `54450e743`, `3491c215a` | `packages/gateway/src/data-plane/chat-flow/responses/events/reassemble.ts`, `snapshot-sidecar.ts` |
| A03 | P1 / design required | Commit enabled continuation storage before promising a reusable response. Slow/failing storage cannot race an immediate continuation or silently claim durable success. Keep retention-off behavior unchanged. | `978dca440`, `2e1790afa`, `d816824f1` | `packages/gateway/src/data-plane/chat-flow/responses/{http,snapshot-sidecar}.ts`, `data-plane/dispatch/responses-store-bridge.ts` |
| A04 | P1 / open | Preserve `allowed_tools` subsets and mode; reject unrepresentable selectors, missing declarations, and ambiguous flat function/custom names. | `478c4efc5`, `1d7dcd923` | `packages/translate/src/responses-via-{chat-completions,messages}/request.ts` |
| A05 | P1 / open | Dispatch hosted tools using completed callable identity, including namespace; keep client collisions, forced choices, historical calls, and injected aliases stable. | `544613969` | `packages/gateway/src/data-plane/chat-flow/responses/interceptors/server-tool-shim.ts` |
| A06 | P1 / open | Preserve custom tool declarations/calls/results and structured function/custom outputs; preserve call IDs and contiguous results, map images to legal target carriers, reject unsupported projections. | `c54fa4d34`, `b077a6ef1` | `packages/translate/src/responses-via-{chat-completions,messages}/` |
| A07 | P1 / open | Preserve readable agent-message delivery and author/recipient provenance without granting user authority; validate and escape projected metadata. | `f2123d771` | `packages/translate/src/responses-via-{chat-completions,messages}/request.ts` |
| A08 | P1 / open | Preserve refusals across JSON, SSE, and replay; a refusal must not become an empty successful Responses result. | `5076ab63f` | `packages/protocols-llm/src/`, `packages/translate/src/` |
| A09 | completed / 8b30cd6b, 23 tests and review | Extend existing HTTP context-window rewriting to Responses SSE errors so Messages clients receive recognizable prompt-too-long failures. | `c42a81293` | `packages/translate/src/messages-via-responses/events.ts`, gateway Messages interceptors |
| A10 | P1 / open | Map reasoning `none` to native disabled thinking; preserve other effort values and canonical-first reasoning text aliases in request and response paths. | `fe554de49`, `9dbea2ff0` | `packages/translate/src/`, gateway reasoning dialect interceptors |
| A11 | P2 / open | Normalize only explicit empty tools after tool injection; fill empty namespace descriptions only at strict provider boundaries, including nested containers. | `81bb39dba`, `4c00e1f50` | gateway protocol interceptors, Copilot/Azure provider boundaries |
| A12 | P2 / compatibility verification | Determine the supported Responses SSE terminal/sentinel contract; emit one normal `[DONE]` only when the chosen contract requires it, without marking failures successful. | `7e066787d` | `packages/gateway/src/data-plane/chat-flow/responses/events/to-sse.ts`, `respond.ts` |
| A13 | completed / a8b7cc24, cancellation and partial snapshot regressions | Align cancellation outcomes across metrics/dumps and define complete versus partial Responses snapshots. A created-only interrupted response must not silently become a complete continuation. | E03 local HTTP evidence | Responses responder, snapshot sidecar, shared telemetry |
| A14 | P2 / adopt deterministic fixes | Recognize compact aliases, expand own envelopes independently of generation flags, preserve full compact output and atomically replace the continuation window. Keep foreign opaque state unchanged. | E02 source comparison | compact shim, Responses store bridge and HTTP route |

### B. Transport, memory, and storage lifecycle

| ID | Priority / state | Deliverable and acceptance condition | Reference revisions | Primary vNext surface |
|---|---|---|---|---|
| B01 | P1 / open | Decode socket gzip/deflate responses and remove stale headers; unsupported codings have explicit errors and release streams. | `0e7702544` | `packages/http/src/parser.ts` |
| B02 | P1 / open | Recover the specific pre-request Cloudflare CONNECT rejection through fetch without replaying a request that may already have been sent or bypassing configured fallbacks. | `f708c5422` | `apps/platform-cloudflare/src/cfw-socket-dial.ts`, `packages/dial/src/fetcher.ts` |
| B03 | completed / focused tests and review passed | Parse valid SSE without mandatory colon spacing; cover multiline data, line endings, event reset, chunk boundaries, and pending-reader cancellation. | `8d13dd6ac` | `packages/result/src/parse-sse.ts` |
| B04 | completed / 57fd39bf | Bound raw opaque UTF-16 reconstruction while keeping the wire codec identical, including BOM and lone surrogates. Bun 1.3/1.4.2 and Node 22 isolated retained-heap measurements passed; Workers remains unmeasured. | `be4b17672` | `packages/protocols-llm/src/common/opaque-value.ts` |
| B05 | P2 / design and measurement | Introduce replayable streaming JSON with length, backpressure, cancellation and byte-identical retries; incremental session hashing must preserve digest and derived identity. | `c5be9dee8`, `95fd4dbdf`, `ce8f5b1b4` | HTTP/dial request contracts, Copilot `forward.ts`, Codex `fetch.ts` and `ids.ts` |
| B06 | P3 / runtime investigation | Evaluate Blob-based gzip buffer retention on Bun/Workers; adopt lower-retention construction only with relevant evidence. Do not port absent double-clone machinery. | `f1a4fcb2e`, `8074e313f` | `packages/gateway/src/repo/dump-store.ts`, request/snapshot ownership |
| B07 | P1 / open | Connect dump and spilled-file expiration to production maintenance; cover active/disabled/deleted keys, staging grace, reference safety, backlog drain, and failures between row/file deletion. | `392b0c019`, `87ac6e0e9` | gateway dump/spilled-file repositories and both platform maintenance entrypoints |
| B08 | P2 / capacity verification | Preserve existing Responses sweep; measure backlog versus per-tick capacity and assess cross-instance leases without reimplementing working single-instance cleanup. | `87ac6e0e9` | `packages/gateway/src/responses-maintenance.ts`, Bun/Cloudflare entrypoints |
| B09 | completed / 33 tests, 5 typechecks, socket regression | Forward caller abort through Custom/Azure/SDF and compose it with timeout/retry cancellation. Verify real socket release, tee cleanup and no retry after cancellation. | E03 source and local HTTP evidence | provider-custom/provider-azure/provider-sdf, http/fetch-retry |

### C. Routing, model catalogs, and provider capabilities

| ID | Priority / state | Deliverable and acceptance condition | Reference revisions | Primary vNext surface |
|---|---|---|---|---|
| C01 | P2 / design required | Authenticated client-carried opaque origin and explicit compatibility identities; prefer compatible candidates and distinguish required state from optional degradation. Handle signed thinking as a complete block. | `200c82f1b`, `fb5a8da3d`, `a2349daca`, `5ba518abd`, `24003d3dd` | active chat-flow candidate selection, protocol opaque carriers, provider catalogs |
| C02 | P2 / open | Extend existing stale L1/L2 catalogs with cross-instance refresh coordination, configuration/version fences and persistent backoff. Decide cold-cache behavior explicitly. | `5b7f99ae0` | `packages/gateway/src/data-plane/providers/registry.ts` and repository/platform contracts |
| C03 | P2 / open | Version code-derived catalog schema/capabilities and show cached models on editor open; explicit refresh reports failures without deleting known routes. | `dfbf066b1`, `3be39e378` | registry, upstream catalog routes, `UpstreamFormModal.tsx` |
| C04 | P2 / open | Preserve custom discovery chat metadata and derive original-image capability from the actual upstream through aliases and public/Codex catalogs. | `1b15195ad`, `04233190c` | provider-custom/Codex models, registry and `data-plane/codex/synthesize.ts` |
| C05 | P2 / design required | Implement Copilot Fast tier as one catalog/raw-model/response/pricing contract; preserve display names and avoid inventing lanes on unsupported endpoints. | `6b7d4fb3e`, `0eb0f55ad` | Copilot variants/interceptors and Codex catalog synthesis |
| C06 | P2 / open | Add progressive real usage while preserving existing final usage drain, missing counters, refusal and event ordering. Gate unsupported continuous-usage extensions appropriately. | `14f0b7725` | Messages-via-Chat request/events and stream-options interceptors |
| C07 | P2 / provider project | Add Responses Lite only when selected by upstream catalog; verify encoding, identity, streaming, compact, and authentication retry behavior. | `e7b3d6fc9` | `packages/provider-codex/src/{models,fetch}.ts` |
| C08 | P2 / provider project | Support additional credential import shapes with preview and correct optional-refresh/identity/expiry semantics; do not merely loosen validation. | `fadd9aabb` | provider-codex auth/config/fetch and import UI |
| C09 | P3 / open | Show last-observed quota with freshness metadata while preserving rate-limit gates. | `2953c9e01` | provider-codex quota and dashboard |
| C10 | P2 / verification workflow | Audit new catalog models and precise pricing matches against primary sources, preserve operator-supplied values, and separate richer tier billing from table updates. | `07dd802ac` | provider model/pricing sources and catalog revision |
| C11 | completed capability/config / 46725acb | Advertise only implemented ingress WS capability; explicit custom-provider supports_websockets=false while unsupported. Version-test precise upgrade fallback responses. | E01 gateway and Codex source/probes | Codex catalog synthesis, generated client config, routes |
| C12 | P2 / separate design | Client WS to shared execution with per-turn authorization, terminal-last durable ordering, cancellation/cleanup lifetime, failed-state eviction and bounded backpressure. Defer native upstream WS/multiplexing. | E01; 67b5db157, 81ad72ea5, e929bd339, 56dddc6dc | platform adapters, chat-flow kit, Responses storage |

### D. Diagnostics and operator experience

| ID | Priority / state | Deliverable and acceptance condition | Reference revisions | Primary vNext surface |
|---|---|---|---|---|
| D01 | completed / editor and backend normalization verified | Preserve complete valid custom model entries through editor load/save; pricing-only entries cannot turn into the literal ID `undefined`. | `48f200f66` (principle and tests) | `apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx`, provider-custom config |
| D02 | P2 / design required | Capture bounded per-attempt upstream HTTP exchanges before protocol parsing, including incomplete prefixes, binary bodies, and retry boundaries. | `911b25337` | dump schema/store, provider HTTP boundary, diagnostics |
| D03 | P2 / open | Expose existing authorized dump browsing and single-record export; redact credentials in every export format without mutating the stored original. | `911b25337`, `463dc4611` | dashboard requests UI, dump control-plane routes |
| D04 | completed / stale-result regressions, dashboard typecheck | Bind proxy test feedback to the tested draft; edits invalidate old results and stale in-flight responses cannot overwrite new draft feedback. | `aac6e2cd4` | `apps/dashboard/src/tabs/proxies/ProxiesTab.tsx` |
| D05 | P3 / open | Create a new-upstream draft from an existing configuration while preserving permission boundaries and resetting nonportable OAuth state. | `95051a965` | upstream dashboard and create contract |
| D06 | P3 / open | Add accessible drag reorder over existing order APIs, retaining owner groups, cancellation, and failed-save rollback. | `339d74ef1` | upstream/mapping lists and order state |
| D07 | P3 / open | Multi-select performance filters use OR within dimensions and AND across dimensions and retain removable stale options. | `605942a6c` | dashboard performance state and charts |
| D08 | P2 / measurement | Push expensive overview aggregation into bounded SQL without losing ownership filters or decimal precision; include later D1 query-limit fixes. | `05609bfa2`, `6c231fc1f`, `7155c817a` | gateway usage/performance repositories |
| D09 | P3 / open | Extend existing CLI snippets with verified model-tier variables; test generated configurations without replacing a live user configuration. | `682289834` | key configuration panel and snippets |
| D10 | P3 / separate feature | One-command CLI setup must preserve unrelated settings and include scoped short-lived credentials, revision checks, backups, and rollback. | `b65db0b9e` | setup control-plane and generated shell/PowerShell clients |

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
