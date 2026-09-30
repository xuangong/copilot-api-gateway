# vNext architecture through quality attributes

Date: 2026-09-30. Status: source-based architectural assessment and proposed improvement direction. No product behavior, storage format or deployment is changed by this document.

Baseline: local vNext `d2ad25bb9e866d71bb4e7f911ce907d8c0603a28` plus the preserved collaboration overlay. Reference: the clean local Floway checkout at `/Volumes/Projects/copilot-gateway`, also reachable at `/Users/zhangxian/projects/copilot-gateway`, commit `1d7dcd923e260e425120cca0c7a240e93720af27` dated 2026-09-27. No reference fetch, build or benchmark was performed.

The [subsystem design](2026-09-30-vnext-subsystem-architecture-design.md) describes responsibilities, collaboration, authority and state ownership. This document asks whether those choices meet maintainability, stability, extensibility and performance needs. These are overlapping views of the same system, not four more subsystems or a request to create twelve packages/services. The [source review](../research/2026-09-30-subsystem-architecture/README.md) supplies detailed evidence for R1–R10; the tables below explain consequences and trade-offs rather than repeating that issue inventory.

## 1. Architectural position

Retain the modular monolith, portable host adapters, provider plugins, explicit protocol translation and shared Responses turn. Refactor the internal authority, producer-result, completion and resource-ownership seams early. Directory separation is already stronger than several runtime contracts, so another package split would not by itself resolve the observed problems.

Both projects are multi-provider modular monoliths with a Cloudflare host and a server host (Bun here, Node in Floway). Neither package count nor a shorter reference request path establishes lower CPU or memory use. The important comparison is the work and guarantees on an equivalent request.

| Quality view | Existing justification | Material limit | Architectural verdict |
| --- | --- | --- | --- |
| Maintainability | Pure protocol libraries, provider packages, host composition and dependency rules keep many changes local | Writable cached views, parallel registries, implicit producer shape and several completion forms spread some changes across unrelated concerns | Boundaries are useful; strengthen contracts and change locality before introducing layers |
| Stability | Shared turn, terminal validation, required history commit, CAS/fencing and explicit WS ownership encode real failure cases | Revocation notification, partial settlement, resource contention and mixed-version recovery are not fully covered by those mechanisms | Preserve correctness machinery; improve failure classification, recovery and resource isolation |
| Extensibility | Provider and platform extension points exist; source protocol and upstream provider are separate dimensions | New protocols/policies touch several dispatch/entry/translation surfaces; adding isolates does not isolate SQL or make local state global | Favor explicit capabilities and declarations; separate functional extension from capacity scaling |
| Performance | Pinned metadata, bounded routing projection, deferred materialization and demand-driven delivery avoid repeated work | Catalog aggregate retention, full body/history/capture representations, broad queries and settlement work remain | Optimize representation count, lifetime and workload admission; overall improvement remains unmeasured |

The design must satisfy three constraints together: maintain semantic/authority guarantees, fit the CFW resource envelope, and keep future changes understandable. Correctness does not excuse unbounded resource use; resource optimization does not authorize weakening continuation, affinity or diagnostic behavior.

## 2. Maintainability view: limit the scope of a change

Maintainability means a developer can identify the owner of a policy, change it in a small set of appropriate places, and determine which contracts require verification. It is not a goal to minimize files, erase protocol differences or put every operation behind a generic service.

### Why the existing structure is reasonable

- Host adapters own runtime-specific composition while portable packages avoid host imports. The [ESLint dependency rules](../../../eslint.config.mjs#L23) and [framework-purity gate source](../../../scripts/check-framework-purity.ts#L1) encode some of that direction. Their existence is source evidence, not a fresh claim that every check passed this round.
- Protocol schemas/converters can change independently of storage and host scheduling. Provider-specific credential/request semantics have an owning package rather than accumulating in every HTTP route.
- The Responses turn is a shared unit of execution for HTTP and WS. Fixing terminal validity in that owner can protect both transports while their delivery rules remain separate.
- Static composition is inspectable and checked at build time. Dynamic plugin loading, a universal DI container or an event bus would add lifecycle and compatibility machinery without resolving a demonstrated need here.

### Where change locality is still weak

| Change scenario | Useful current boundary | Avoidable propagation | Early improvement |
| --- | --- | --- | --- |
| Add or modify a session mutation | Session repository plus configuration revision | A separate method-name observer must remember invalidation; logout demonstrates an omission | Make mutation and local invalidation one typed command/decorator obligation |
| Add a provider capability | Provider plugin and model metadata | The current plugin Map does not require every known kind; configuration/default/redaction decisions also span several sites | Make bundled registration exhaustive first; consolidate cohesive declarations incrementally and keep authority decisions gateway-owned |
| Add an inference endpoint/alias | Data-plane router and host mounting | The configuration-snapshot path classifier is maintained separately in [app.ts](../../../packages/gateway/src/app.ts#L71) | Co-locate entry policy with route/capability declarations, preserving middleware order and alias behavior |
| Change a cross-protocol result | Converter and source adapter | Actual frame shape is reconstructed from telemetry metadata | Tag the actual producer domain at the attempt-result/source-adapter seam |
| Add a metric or persistence projection | Observation helpers | Several renderers/completion handles can acquire new awaits or interpretations of success | Produce stable execution facts once; sinks return separate receipts under compatible completion policy |

The broad cached `Repo` is a particularly costly abstraction: its type hides which calls read pinned metadata, read current authority or mutate durable state. Narrowing reads and exposing explicit commands reduces that ambiguity without requiring more SQL. The goal is to remove accidental capability, not to create a wrapper for every function.

An early, smaller example is [provider registration](../../../packages/gateway/src/data-plane/providers/registry.ts#L79): `satisfies ReadonlyMap<UpstreamKind, LlmProviderPlugin>` checks entry types but not completeness of the known-kind set. An exhaustive static declaration can expose omitted registration at compile time. This concerns bundled known kinds; preserve the runtime handling of unknown persisted kinds. Shared endpoint preference also appears in [pair selection](../../../packages/gateway/src/data-plane/dispatch/pair-selector.ts#L24) and [binding selection](../../../packages/gateway/src/data-plane/chat-flow/shared/select-binding.ts#L59). Consolidate the intended policy only after checking that the callers' ordering semantics really match.

Do not turn all requests into one universal mutable context. Floway demonstrates the value of an explicit scheduler and request preparation, but only the required fields should cross each vNext seam. Stable adapters, request policy, attempt state and completed storage inputs have different lifetimes. An object that holds all four can keep large bodies alive and make tests depend on irrelevant services.

**Acceptance scenario:** adding a provider that implements an existing protocol should not require editing turn cleanup, usage writer internals or both HTTP/WS execution engines. A new session mutation must not compile or pass its contract checks while silently omitting required invalidation. A protocol-specific policy may legitimately need several protocol adapters; it must not duplicate the underlying authority decision.

## 3. Stability view: preserve meaning through failure

Stability includes correct output, bounded cleanup, safe recovery and limited failure propagation. A successful HTTP status, a terminal protocol event, a reusable continuation and a persisted usage record are different facts. Treating them as one boolean makes fault handling simpler to read but less reliable.

| Failure scenario | Existing architectural protection | Necessary cost | Gap or improvement |
| --- | --- | --- | --- |
| Upstream emits partial output, ends early or has an invalid terminal tail | Raw upstream and source-protocol validation protect different representations; turn owns consumption and cleanup | Parsing, terminal observation and bounded cleanup work | Share ownership mechanisms without deleting either semantic check; keep failures distinct from successful EOF |
| Required continuation storage fails | History commit precedes reusable success | Persistence latency is part of that success contract | Make failed versus unresolved commit explicit; no automatic inference replay after an uncertain write |
| WS accepts a terminal but cleanup/settlement later fails | Connection-local publication and next-turn admission retain the existing compatibility completion prerequisite | Sequential handoff can include usage/performance/dump settlement latency | Separate facts/receipts internally, preserve this gate initially, and decide any weaker gate separately |
| Credentials/configuration change during execution | Revision views, current authoritative recovery, credential CAS and affinity fences | Selected authoritative reads, hashing/verification and conflict recovery | Make admission views distinct from renewable credentials/current observations; complete local invalidation |
| A usage or diagnostic write partially fails | Request-local once guards and dump publication fences cover different concerns | SQL/object writes and cleanup | Request-local guards are not durable idempotency; choose accounting acceptance before enabling retries |
| Large capture or management read overlaps ordinary inference | Some queues/caches/sweep batches have bounds | Isolation requires capacity accounting and overload behavior | Logical modules still share process/SQL resources; add retained-byte/work/concurrency contracts at the actual owners |
| Roll back code after the new version writes data | Catalog/affinity identities and version checks provide mechanisms | Compatibility readers and retained keys/records may be needed | Old/new readers, writers and collectors still need a qualified matrix; a Git tag alone is insufficient |

The shared turn is more valuable than superficially shorter independent HTTP and WS flows. Floway shares preparation helpers but has distinct output/settlement paths for those transports. vNext should borrow explicit phases while preserving its single execution owner.

Observation failures must not cause a second provider invocation. Required history, accounting acceptance and optional diagnostics need separate failure policies. The target dependency is execution/required-commit/delivery/cleanup facts, then projection inputs, then sink receipts, then the existing compatibility completion handle. Constructing projection inputs by awaiting `turn.completion` or `KitCanonicalCompletion.settled` would create a cycle when those handles already await the sinks.

Preparation and retry are also distinct. Both projects already prepare Codex requests outside the bounded authentication retry. A candidate fallback, credential retry and recovery from a partial output do not have the same safety conditions. A retry contract must retain exact authority, whether dispatch/output/side effects began, the remaining budget and attempt accounting. Unknown acceptance is not proof of replay safety. Likewise, Floway's permissive provider item-ID decoder must not replace vNext's fail-closed handling of recognized authenticated affinity carriers; a decode error does not authorize switching provider or dropping ownership.

Failure isolation is currently mostly logical. D1/SQLite authority, snapshots, usage, performance and dump metadata share physical storage; body files are already separate. Splitting databases or services now would add cross-store ordering and recovery requirements. First define per-domain budgets and recoverable receipts. Reconsider physical isolation if bounded background/query work still compromises inference or requires an independently managed capacity/failure domain.

**Acceptance scenario:** cancellation, failed terminal, credential rotation and storage faults each leave a defined output/continuation/cleanup result; none invent success, replay inference or silently lose an accepted durable obligation. Slow optional work is observable separately. Initial contract extraction retains the existing HTTP/WS timing and error precedence.

## 4. Extensibility view: distinguish new behavior from more load

### Functional extension

| Extension | Fit of current architecture | What should remain explicit |
| --- | --- | --- |
| Another provider for an existing protocol | Good: provider package and factory contracts already isolate vendor execution | Credentials, egress, model metadata and native capabilities; no provider-to-provider dependency |
| Another host/runtime | Good foundation: portable gateway with injected host adapters | Native pressure, cancellation, background lifetime, file/SQL behavior; matching TypeScript signatures do not prove equivalent runtime semantics |
| Another transport for existing Responses semantics | Good: the turn supplies shared execution and the transport owns delivery | Admission, peer/native acceptance, disconnect and continuation scope; do not add a second execution state machine |
| A new client protocol or materially different provider protocol | Deliberately bounded, not automatically open-ended | Schemas, translation pairs, terminal classifiers and error mappings require explicit support; unsupported combinations must fail clearly |
| A cross-cutting policy such as admission or diagnostic selection | Weaker today: decisions can be repeated in protocol pipelines/middleware | Centralize the decision and lifecycle obligation; keep payload rewriting protocol-specific |
| A new analytics sink | Possible but currently settlement-coupled | Consume stable facts with its own receipt and failure policy; do not extend the critical path by incidental await placement |

A universal canonical protocol would simplify dispatch only if it represented every required semantic without loss. That is not demonstrated here. Preserve explicit translation pairs and provider-declared capabilities; improve their result contract instead of erasing protocol distinctions. A new policy should be defined once, but its body/event transformations may remain separate.

Floway's typed `ProviderModule` registry offers a useful example of keeping construction and flag defaults on one exhaustive declaration. Adopt that cohesion where vNext currently repeats the same per-kind decision. Do not copy its streaming-only generation contract, upstream whitelist semantics or broader context object merely for symmetry.

### Capacity expansion

More isolates/instances can spread request work, but each can retain its own caches and renewals while the authority store remains shared. Local coalescing is not distributed coordination; distributed leases/CAS are therefore useful even when an individual gateway runs as one process. A WS connection's private state is intentionally connection-local, not a cross-instance session store.

| Growth dimension | What grows | Architectural response |
| --- | --- | --- |
| More upstreams/models/users/keys | Configuration generations, catalog data, routing indexes and refresh work | Aggregate catalog retention, generation eviction and scoped metadata; do not confuse entry count with bytes |
| More concurrent requests or slower clients | Active body/history/capture representations and pending delivery/settlement | Preserve demand; bound the work/retention owned by each phase and any waiting queue; avoid a new unbounded scheduler |
| Longer conversations | Repeated snapshot payloads plus provider input reconstruction | Item-reference storage deserves a separate design; it does not remove full history required by upstreams |
| More usage history/dimensions | Quota/detail reconstruction, group cardinality and analytical SQL | Scoped aggregate quota reads and bounded summary/detail queries, with preserved counting/time semantics |
| Larger expiry backlog | Scans, file deletions and shared storage load | Work-aware maintenance progress and convergence visibility, not just a fixed candidate count |

**Acceptance scenario:** adding one kind of extension changes its declared capability and appropriate adapters, without reimplementing unrelated state semantics. Capacity planning identifies which shared resource is saturated before adding workers. Cross-instance correctness and independently scalable capacity are separate qualifications.

## 5. Performance view: balance delivery time, CPU and retained memory

The architectural target is a small ordinary-request path with explicit extra work for enabled features. The three preceding repairs already separated lazy Responses preparation, routing projection/materialization and request-owned scheduling. They should be extended, not reimplemented. Their [complete local CPU/heap comparison remains unfinished](../research/2026-09-30-cfw-resource-remediation/request-boundaries-results.md).

### Cost by phase

| Phase/workload | Reasonable current choice | Residual cost to address |
| --- | --- | --- |
| Warm admission and routing | Pin coherent metadata; reuse bounded projection; materialize the first usable ordinary candidate | A writable view obscures hidden authority access; catalog memo retains graphs outside the projection budget; some cold metadata projection still needs provider construction |
| Cold or changed catalog | Coordinate discovery and preserve explicit/cache-only/stale semantics | Cold discovery is a latency choice; refresh concurrency and all retained representations need budgets |
| Streaming execution | Lazy adapters, one turn owner and demand-driven output | A small encoded queue does not cap the pending frame, reconstructed output, capture or concurrent turns |
| Native/cross-protocol JSON | Preserve full-body JSON semantics | Decode, translate and reconstructed bodies can overlap; do not replace JSON with forced SSE as a hidden optimization |
| Owned affinity/history | Verify authority and prepare complete eligible ranking; persist required continuation | Hashing, parsing, candidate work and storage are feature costs; eliminate duplicate preparation, not the guarantees |
| Capture/publication | Bounded upstream prefixes, owned preparation and fenced publication | Canonical event retention, whole-body codec/readback and legacy tee remain separate costs; earlier response delivery does not release all background memory |
| Quota/dashboard/maintenance | Existing aggregate overview and bounded sweep candidates are useful | Configured quota/main Usage still reconstruct detail; performance groups and some live queues lack cardinality bounds; scan work and backlog remain distinct |

Use three separate reasoning models rather than one latency number:

- **Delivery path:** admission/preparation, upstream wait, adaptation/encoding and any required continuation commit. Streaming phases overlap, so this is a dependency model, not an additive stopwatch formula.
- **CPU work:** parse/validate, project/route, translate, affinity crypto, serialize/compress and project/write metadata. Moving a promise into background work does not remove these operations.
- **Retained memory:** live shared generations, active request/attempt representations, connection state, pending publication/settlement and runtime/native buffers. Count shared object graphs once and account for overlap; a cache or chunk cap is not a whole-isolate bound.

### Trade-offs that architecture must make explicit

| Choice | Benefit | Cost / condition |
| --- | --- | --- |
| Cache immutable metadata | Avoid repeated reads/projection | Retained memory and freshness/invalidation obligations; byte budgets and identity fencing are mandatory |
| Defer execution construction | Avoid unused providers/fetchers | Must preserve whole-registry preflight and error order; authority checks cannot disappear |
| Compress or deduplicate state | Reduce stored/transferred bytes | CPU, temporary buffers, lookup/hashing and GC complexity; shorter stored rows do not prove a cheaper request |
| Parallelize publication | Potentially reduce waiting time | More simultaneously retained bodies/encoders/I/O; bounded concurrency must be justified under CFW memory constraints |
| Settle optional work after HTTP delivery | Reduce client waiting | The work still consumes the same environment; receipts and release points are needed |
| Aggregate queries | Reduce returned rows and browser work | Matching SQL scans, grouping and repeated queries can dominate; assess total page cost, not response bytes alone |
| Tighten caps or diagnostics | Reduce worst-case retention | Rejection, truncation or changed diagnostic content is a behavior change and needs an explicit overflow policy |

A useful optimization removes an unnecessary representation, repeated computation or unintended wait while preserving feature settings. Disabling dumps/history, weakening affinity, changing JSON semantics or relaxing continuation durability does not establish a like-for-like improvement.

Cache freshness, residency limits, invalidation and authority leases are separate policies. A refresh interval is not an eviction TTL; TTL alone does not bound distinct arrivals or value sizes. Byte-aware eviction can itself cause reconstruction under churn. Specify all four policies and preserve useful warm reuse instead of indiscriminately shrinking or extending caches.

Floway's affinity analysis suggests another targeted opportunity: evaluate the complete candidate set, then materialize only the selected payload with sparse copies. vNext already shares immutable strings when copying JSON containers, and its candidate preparation establishes actual execution authority. Further sparse/lazy materialization is appropriate only after proving unchanged subtrees are read-only and the same authority can be established without skipped preparation. A static model-ID match is not an equivalent proof.

**Acceptance scenario:** after the selected structural batch, compare the exact candidate with the intended baseline under identical catalog size, concurrency, protocols, feature settings and storage. Record client delivery and complete settlement separately, along with CPU and heap/backing-buffer evidence. Include ordinary warm requests, cold/change paths, large catalogs, slow consumers and enabled history/capture. Report offered load, completion/error rates and backlog so rejecting work cannot masquerade as faster service. Local workerd is useful for mechanisms and controlled comparisons; it is not by itself production billed CPU or a production capacity guarantee. This document starts no measurement run and assigns no invented improvement percentages.

## 6. Reference-project ideas and adoption decisions

Reference paths below are relative to the pinned Floway checkout identified above. These observations are mechanisms, not a performance ranking. The earlier [architecture comparison](../research/2026-09-30-cfw-resource-remediation/reference-architecture-comparison.md) describes its own older vNext checkpoint; current adoption status below supersedes suggestions already implemented there.

| Reference mechanism and source | What it demonstrates | vNext disposition |
| --- | --- | --- |
| `packages/gateway/src/data-plane/chat/openai-responses/serve-prep.ts:64` | A typed ready/failure preparation result shared by generate/compact, with history/affinity preparation in an explicit phase | Borrow phase/result clarity inside the existing shared turn/serve pipeline; do not duplicate preparation or create another execution owner |
| `packages/gateway/src/data-plane/chat/shared/translate-traverse.ts:50` | Translation traversal returns source-shaped events | Adopt an honest tagged producer result and lazy source normalization; preserve separate JSON body semantics and byte-level provider contract |
| `packages/gateway/src/data-plane/shared/gateway-ctx.ts:26` | Scheduler and request ownership are passed explicitly | Request-owned catalog/dump scheduling is already migrated; narrow remaining seams selectively rather than copy the complete context |
| `packages/provider/src/provider.ts:163` and gateway `data-plane/providers/registry.ts:12` | Exhaustive provider module declarations centralize construction/default dispatch | Make bundled vNext registration exhaustive early, then group cohesive facts where repeated switches cause change propagation; no dynamic plugin loader |
| `packages/gateway/src/data-plane/shared/telemetry/settle.ts:24` | Central usage/performance scheduling entry | Borrow one settlement input; do not infer SQL atomicity from its comment or copy background/error/counting policy into current WS behavior |
| `packages/gateway/src/data-plane/providers/models-cache.ts:15` | Read a coherent publication before scheduling its refresh | Preserve this separation; vNext already has warm memo and distributed publication fencing. Do not copy its empty cold-catalog behavior implicitly |
| `packages/gateway/src/data-plane/chat/shared/affinity/selection.ts:105` and `chat/openai-responses/affinity/ingress.ts:135` | Full candidate ranking with memoized evaluation and on-demand sparse payload materialization | Investigate targeted copying after proving read-only sharing and equivalent execution authority; retain all eligible candidates and current mutable-attempt isolation |
| `packages/gateway/src/data-plane/chat/openai-responses/items/store.ts` and `repo/openai-responses-snapshot-codec.ts` | Item-referenced snapshots and separate item materialization | Worth a separate long-history design with mixed-version readers/writers/GC, hashing, fan-out and full-provider-input costs |
| `packages/gateway/src/dump/http-capture.ts:12` | Full request read and retained response chunks for exact diagnostics | Do not copy that retention shape into the CFW hot path; retain bounded upstream capture and design aggregate canonical capture budgets |
| `packages/provider/src/streaming.ts:21` | Some generation paths require upstream SSE | A deliberate reference protocol contract, not a general simplification compatible with vNext native JSON |
| `packages/provider-codex/src/fetch.ts:394` and `packages/gateway/src/data-plane/shared/iterate-candidates.ts:39` | Prepare a logical request once and keep credential retry/candidate fallback bounded | Codex preparation is already present in vNext; clarify retry eligibility where needed, without replay after uncertain execution or transferring fallback authority |

Neither project is a complete template for the other. The transferable lesson is explicit ownership and stage contracts. vNext's shared turn, authority fences and bounded WS transport are strengths to keep; Floway's item storage and compact declaration/preparation seams are useful prompts for targeted changes.

## 7. Refactor early, with bounded scope

Do not wait for a broad rewrite to close structural gaps already supported by source. Conversely, a quality view alone does not justify speculative services, new durable queues or a storage migration. The following work should be tracked against the existing subsystem work packages rather than create a parallel feature backlog.

| Decision | Scope and reason to act | Guardrail / exit condition |
| --- | --- | --- |
| **Early correction and authority seam** | Close logout invalidation, then narrow pinned reads and bind mutation/invalidation. Further auth/config features would otherwise repeat the same hidden contract | Local later-admission invalidation plus preserved cross-instance lease semantics; name HTTP/WS owner policy before intentionally changing it |
| **Early resource ownership refactor** | Put aggregate catalog retention under its owner; define canonical capture/publication budgets and release points. These affect CFW headroom regardless of package layout | Preserve discovery modes, full affinity ranking, egress error order and diagnostic defaults; no unbounded extra queue or more parallel compression by default |
| **Early producer/settlement contract refactor** | Tag result domain and separate execution facts from projection receipts before adding more protocols or sinks | Keep byte-level provider interface, lazy body/event adapters, raw/source checks and current HTTP/WS completion behavior; no circular waits |
| **Early targeted workload reduction** | Aggregate configured-quota reads and define bounded preview/query work; repeated broad reads are a concrete architectural cost | Preserve soft fail-open policy, pricing/counting, authorization scope, local-time behavior and accounting acceptance; qualify total operation cost later |
| **Early small declaration refactor** | Make provider registration exhaustive, name native preparation results, and co-locate route-entry capabilities/duplicate selection policy in bounded slices | Remove actual parallel decisions; keep provider-specific rewrites, unknown-kind behavior and error precedence. No generic metadata framework or large all-at-once route rewrite |
| **Separate state/storage project** | Design item-reference history and durable accounting retry if those guarantees are required | Explicit write/read/publication/idempotency/GC and rollback model before emitting new data formats |
| **Conditional physical isolation** | Consider separate storage/compute only if bounded diagnostics, query work or maintenance still contend with inference, or independent availability is required | Evidence of the affected resource/failure domain plus a cross-store recovery design; no service split merely to match the subsystem diagram |

The first changes should therefore improve the contract at the demonstrated weak point, rather than add another layer around it. Small correctness omissions can be closed alongside the prioritized memory/performance work. Larger completion and storage changes must remain reviewable slices with explicit compatibility prerequisites.

Revisit the monolith decision if an actual workload needs independently scalable diagnostics/analytics, separately deployable ownership, or a provider workflow whose runtime requirements cannot share the host safely. Revisit a shared abstraction when two consumers repeatedly need incompatible lifecycle/authority rules. Do not infer either condition merely from more files or more features.

This assessment recommends early structural work, not an immediate deployment. Product changes, functional validation and the final resource/rollback qualification remain distinct steps; none is completed by documenting the views.
