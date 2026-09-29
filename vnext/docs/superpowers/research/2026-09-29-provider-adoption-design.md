# Provider adoption: implementable designs and prerequisites

Date: 2026-09-29. Scope: C01, C02, C05, C07, C08, C09, C12 only. Read-only source/design task; this file is the only deliverable. No implementation, tests, network requests, commits, or deployment were performed. Concurrent implementation is changing the checkout; HEAD at the last inspection was `ca3bb5f07a74d4ed47613e25a9d0b8d7fec2d143`. Recheck touched source and migration numbering before implementation.

Paths below are relative to `vnext/`; `reference:` means `/Volumes/Projects/copilot-gateway/`. Read the vNext agent guide, global plan constraints and assigned rows, remaining-scope audit, and qualified-decisions research. Source statements below were checked in the current worktree, rather than assumed from those older reports. The plan's preservation constraints apply throughout: owner/key authorization, provider identity, cancellation, opt-in retention, unknown usage, existing credentials, strict types and package purity. No item is deferred merely because it is large.

## Findings that change the prerequisite graph

1. **Credential state persistence does not implement its advertised concurrency contract.** `packages/upstream-repo/src/types.ts` and `provider-codex/src/state.ts` describe atomic updates/replayed mutators. Actual `gateway/src/repo/shared/repos.ts:557–573` reads `state_json`, invokes the updater and performs an unconditional UPDATE. Parallel quota, refresh, invalidation and terminal-state writes can overwrite each other. This must be fixed before optional-refresh import becomes user-visible.
2. **The generic upstream DTO currently exposes credential state.** `control-plane/upstreams/routes.ts:330–340` spreads the entire upstream and redacts only `config`; Codex tokens live in `state`. Every Codex import/read UI must use a safe DTO, and generic list/create/patch responses must also stop returning those secrets. A secure dedicated import endpoint alone would not close this path.
3. **Catalog coordination can use existing SQL primitives.** `SqlExecutor` supports `run().changes`, `first`, and `all`; Bun and D1 implementations both expose affected-row counts. An atomic conditional statement is enough for lease acquisition/publication; a general transaction API or Redis is unnecessary. Existing SQL already uses `DELETE ... RETURNING` in `shared/agent-remote-continuations.ts`, but the lease design can avoid RETURNING entirely.
4. **Catalog revision must not treat OAuth rotation as a configuration replacement.** Current `upstreamConfiguration()` removes quota only; access-token/refresh-token changes still change its hash. A discovery operation can refresh its own access token. A fence based on that full state would invalidate the operation's own successful result. Explicit discovery identity/generation is a prerequisite, not an afterthought.
5. **The byte-level provider boundary needs a small LLM-specific per-call extension.** Current `LlmModelProvider.fetch()` returns core `ProviderResponse`; response parsing lives in gateway attempts. C07 needs the request's Lite inverse map after parsing, C05 needs the selected raw pricing ID even when the server reports a base model, and C01 needs the identity actually selected. A shared mutable provider-instance field is unsafe across calls/retries. Keep the extension in `provider-llm`, not core `upstream`.
6. **A03 has already moved since the research report.** Current `responses/serve.ts` creates `completion-snapshot.ts` writers, and `respond.ts` awaits `onCompleted` before reusable success. The deleted snapshot-sidecar is not the right future seam. However `respond.ts:279–303` continues iterating after `response.completed` and keeps keepalive running until finally. Durable-before-terminal does not yet establish terminal-last.

## C02 — SQL catalog lease, publication fence and persistent retry

### Smallest coherent delivery

Deliver a SQL-owned catalog snapshot/coordinator shared by automatic discovery and explicit refresh. L1 remains a bounded local optimization. Do not place a lease in KV and leave the successful snapshot publication in a separate unconditional KV write: that cannot fence a delayed publisher atomically.

Add a numbered migration containing:

- `upstreams.catalog_generation INTEGER NOT NULL DEFAULT 0`.
- A catalog table keyed by `(upstream_id, catalog_revision)` with `configuration_generation`, `configuration_fingerprint`, `models_json`, `refreshed_at_ms`, `refresh_after_ms`, `lease_token`, `lease_until_ms`, `failure_count`, `retry_at_ms` and optional safe `last_error_code`. Use integer millisecond times. Foreign-key cascade or explicit delete cleanup must match current SQLite/D1 foreign-key configuration.
- A trigger that advances the per-upstream generation when discovery-relevant fields change. Reuse the style, not the full scope, of migration `0010_configuration_revision.sql`. Relevant fields: owner/provider/config/proxy route/enabled and row identity. Ignore name, ordering, disabled-model display filters, quotas, minted tokens, credential-health telemetry and updatedAt. Config contains the selected Codex account identity. A credential reimport explicitly advances the generation in its atomic replacement statement, even when the account identity is unchanged. Ordinary access/refresh rotation does not.

The catalog schema/code revision is owned by C03 and must be a separate integer/string constant. The fingerprint is a deterministic discovery projection, including sensitive config only through a hash. It is not the current all-purpose `upstreamConfiguration()` hash. Changing the catalog projection/adapter requires a code revision bump. Rows for two deployed code revisions can coexist during rolling upgrades; old code cannot overwrite new-code data. A bounded maintenance deletion removes inactive revisions after rollout, rather than accumulating rows per credential rotation.

Expose a gateway repository surface, for example `catalogs.read`, `tryAcquire`, `publish`, `recordFailure`. Keep it out of `cache`'s generic get/set/delete interface. Wire it through `buildSharedRepo`, `BunSqliteRepo`, `D1Repo`, and the configuration-cache wrapper without memoizing the coordinator. `getDataPlaneRepo()` is configuration-cached; the coordinator must use authoritative SQL writes/reads, not an immutable request snapshot.

### Atomic operation contract

1. Read authoritative upstream metadata and generation before acquisition. If the request's cached provider config no longer matches, reconstruct it from the authoritative row; do not fetch a new catalog using the old provider instance and label it with the new generation.
2. Create a blank row with `INSERT ... SELECT ... FROM upstreams WHERE id=? AND catalog_generation=? ON CONFLICT DO NOTHING`.
3. Acquire with one conditional UPDATE, setting an unpredictable `crypto.randomUUID()` lease token and expiry. Predicate: current upstream generation still equals expected; stored generation is no newer than expected; either the generation changed, or the lease is absent/expired and retry deadline has passed. On generation change clear old failure/backoff and prevent the previous model JSON being read as current. `changes===1` wins. An old-generation caller cannot reset a newer row.
4. Fetch with a composed request/deadline signal. Suggested initial limits: 30-second lease, 20-second fetch deadline, two-minute successful freshness and 30-second initial backoff, exponential capped at five minutes with jitter. Constants are implementation defaults, not measured provider guarantees. If an operation needs longer, renew conditionally under its token before expiry; a lease is never an unbounded promise.
5. Publish snapshot and release lease in **one** UPDATE, conditional on lease token, generation, code revision, unexpired lease, and `EXISTS` on the current upstream generation. Late A after lease takeover B changes zero rows. Late config A after edit B changes zero rows. A deleted/recreated upstream requires a distinct generation/incarnation; include row incarnation (`created_at` or an explicit UUID) in predicates so generation reset cannot create an ABA hole.
6. Failure uses the same token/generation predicates, sets persistent failure count/retry deadline, and releases the lease. It must not clear the last successful snapshot. A stale failure from A cannot place B into backoff. Never store an exception message, token, account identity, prompt or provider body in this row.

Use the database clock for lease comparisons where practical (integer seconds converted to ms is sufficient for these intervals). If binding `now`, document clock-skew assumptions and test them. A read after a failed acquisition may be stale on an eventually consistent path; correctness rests on the conditional write and publish fence, never on the read alone. Verify authoritative D1 session semantics with the actual local adapter before claiming cross-isolate acceptance.

### Reader/refresh behavior

- Fresh same-generation/same-code snapshot: return immediately.
- Stale successful same-generation catalog: return immediately; start one coordinated refresh through platform background lifetime. Old **code** revision snapshots may be reused only via C03's explicit validated compatibility reader; old **configuration/owner/account** catalogs are not reusable as the new identity.
- Cold cache, winner: await bounded discovery. Cold cache, loser: bounded abortable polling of the authoritative snapshot, with a maximum 20-second budget and lease takeover only if expired. On budget exhaustion return `catalog-unavailable`/503, not an empty model list or model-not-found.
- Explicit refresh bypasses backoff if no active lease; it joins an existing lease rather than launching a duplicate. Return refresh errors explicitly while retaining stale data. UI editor-open is a cached read owned by C03.
- SQL outage: an existing valid L1 snapshot may still serve stale routes. Cold failure must fail unavailable; do not silently fall back to uncoordinated discovery on every isolate.
- L1 installation also checks generation and the lease/publication result; a rejected late refresh must not overwrite a newer local memo. Retain the 512-entry bound.

### Acceptance and sequence

Implement discovery identity/generation and migration first, then repository coordinator, then registry/C03 control-plane integration. Real SQLite tests must create two independent repo instances against one temporary file and interleave barriers: one fetch across instances, expired lease takeover, A-publish-after-B, A-failure-after-B, config edit/deletion/recreation, OAuth rotation during getModels, quota-only writes, persistent restart backoff, cold loser timeout/abort, stale outage, schema revision coexistence and old generation L1 rejection. Extend `gateway/tests/integration/catalog-outage.test.ts`; add dedicated catalog repository/coordinator tests. Test SQLite statement syntax and affected-row handling through local D1/workerd, then Wrangler dry-run. No production D1 writes are necessary for implementation. No external contract blocks this work.

## C08 — credential import and complete optional-refresh lifecycle

### C08-F1: make state writes and public DTOs truthful

Implement `saveState` as real compare-and-swap: read raw `state_json` and row incarnation; compute the pure updater; `UPDATE ... WHERE id=? AND row_incarnation=? AND state_json IS ?`, including the expected owner/provider fence when supplied; on no returned row reread and retry at most eight times. `IS` handles SQL NULL. Verify the same row and raw state before returning for a byte-identical no-op. Throw typed contention, gone, or replaced errors. A new immutable random row incarnation prevents same-timestamp delete/recreate ABA; `created_at` does not. Use conditional `RETURNING` because configuration triggers contribute to update change counts. Do not mock SQLite in tests. The caller mutator is replayable and cannot perform network calls or log secrets.

CAS alone is insufficient if the mutator blindly writes stale credentials. Add a persisted opaque `credentialRevision` UUID minted at import/reimport. Credential effects and in-flight mint closures capture that revision; when it no longer matches they may not invalidate, terminate, rotate or write access tokens into the replacement credential. For refresh rotation also compare the exact refresh token used internally, and publish rotated refresh token plus new access token together in one state update. Existing `mintCodexAccessToken` persists rotation and cached access separately; collapse that success commit to prevent a crash/race window. A loser reads the winning token from the authoritative repo and returns it when usable. A stale 401 invalidates only the bearer/revision that actually failed.

Generic metadata PATCH currently resaves a full `existing` row, including stale state. Add a config/metadata update operation that leaves state untouched, or make it an optimistic expected-state write and retry/rebase metadata. Otherwise generic editing can undo the CAS fix. Credential import/replacement uses a dedicated operation with owner/config/credential revision checks. No destructive database reset or token wipe migration.

Replace `serializeUpstream` with an allowlisted public DTO. Exclude `state` entirely; expose separately derived credential health, renewable flag, expiry and quota observations. Redacting known token keys alone is weaker than omitting private state. Assert tokens are absent in list/create/patch/import/error bodies for every currently stored provider, not only Codex. Never echo submitted JSON in validator errors.

### C08-F2: one pure parser/normalizer plus preview

Reference `provider-codex/src/auth/{import,credential,jwt}.ts` has useful envelope/preview decomposition. Port concepts, not its permissive identity override policy wholesale.

- Supported shapes: existing `.tokens`; single `.credentials`; `.accounts[]`; `.data.accounts[]`. A flat token object can be separately accepted by an explicit matcher if the assigned implementation includes that shape. Require exactly one matched envelope; ambiguous documents fail instead of preferring one silently.
- Multi-account documents produce rows with stable source indexes, label, renewable, expiry-known/expiry timestamp and parse issues. Selecting one source creates one upstream, preserving the existing one-account tuple. No pool scheduler is required.
- Filter explicitly tagged non-OpenAI/non-OAuth entries. Row errors do not reject other valid entries. Preview performs no OAuth/network call and stores nothing.
- Decode token claims with explicit type guards and finite `exp` handling. Access-token JWT expiry wins over export metadata; fallback accepts documented epoch seconds/ISO strings. Zero/missing is **unknown**, not seven days from import. The current seven-day comment is incorrect: its freshness gate would treat that token as fresh for almost seven days.
- Account ID is mandatory because the current fetch sends `chatgpt-account-id`. Derive it from agreeing access/id claims; use explicit exported account ID only when token claims do not supply one. Reject conflicting known account IDs rather than allowing an arbitrary metadata override to change request/account attribution. Decoding an imported JWT is not signature verification and grants no gateway owner/admin authority.
- Email/user ID/plan are display metadata. If access-only data lacks them, represent unknown explicitly and adjust config validation/DTO rendering; do not fabricate an email, user or plan. Keep `chatgptAccountId` nonempty. Existing complete rows remain valid.
- Keep parsed access token bytes unchanged. `refresh_token` becomes nullable; `accessToken.expiresAt` becomes nullable. Require at least a usable access-token entry or a refresh token. Invalid numbers, whitespace-only tokens, arrays where records are expected and unsupported claim types fail predictably.

### C08-F3: lifecycle state machine

| Credential | Normal request | Generic first 401 | Expiry/terminal behavior |
| --- | --- | --- | --- |
| Refresh + access | Existing five-minute proactive skew, authoritative refresh when needed | One refresh/retry using latest revision/token, not captured `opts.account.refresh_token` | Existing definitive OAuth termination classification, guarded by revision |
| Access only, known expiry | Use until actual expiry (do not burn last five minutes pretending refresh is possible) | No OAuth call, no automatic replay; mark access rejected for that exact revision/bearer | Explicit `credential_expired` or `access_rejected`, reimport required |
| Access only, unknown expiry | Usable until upstream rejects it; UI says unknown expiry | Same as above | Never fabricate an expiry or promise renewability |
| No usable access, no refresh | Reject before dispatch | Not applicable | Invalid imported/state record |

`token_invalidated` remains a definitive session-terminated condition. Access-only failure must not be mislabeled refresh_failed. `force:true` refresh on nonrenewable credentials returns a typed nonrenewable error without clearing a valid bearer. Renewable imported credentials with unknown access expiry should refresh before their first call; access-only unknown expiry cannot do that and uses the bearer. Expired renewable imports can be accepted as needing refresh; expired access-only preview rows are not importable.

Touch all entry points: `access-token.ts`, `fetch.ts` prepare/401 retry, `provider.ts` catalog fetch/effects, config/state validators, OAuth callback normalization, quota writes and public status. A 401 retry must keep request/session/thread/turn identity and encoded body stable; prepare them once before dispatching the retry loop. The accepted B05 native-preparation package already preserves body and identity through authentication retries; retain that guarantee while changing credential selection.

### C08-F4: authorized UI delivery

Add scoped POST preview and POST import routes under the existing upstream control plane and a Codex option in `UpstreamFormModal`. Reuse session auth, owner selection rules and `loadOwned`; preserve missing/foreign 404 equivalence. Initial create is one selected preview row, generated upstream identity, original config/state split. Reimport requires an existing owned Codex row, preserves proxy/name/flags and stable installation ID for the same account, advances credential revision/catalog generation, and refuses accidental account substitution. Account replacement can create a new upstream rather than silently changing existing continuation identity.

Preview/import can reparse the document on each request with a stable source index; no server-held secret preview cache is required. Bound input bytes and row count. Keep raw JSON only in form memory, clear after import/cancel, never localStorage, logs or URLs. Add a status panel with health/renewability/expiry and an explicit refresh button only when renewable. All network verification uses the configured control-plane fetcher, never a direct-egress shortcut.

Acceptance: real SQLite CAS barriers for quota versus rotation, two rotations, terminal versus reimport, bearer invalidation versus refresh, generic metadata PATCH versus refresh, delete/recreate and contention exhaustion. Parser fixture matrix for all envelopes/ambiguity/identity conflict/expiry forms/partial rows. Fake-fetch matrix for standard/compact/alpha-search and catalog, access-only first 401, unknown expiry, exactly one renewable retry, unchanged IDs/body, deleted account and cancellation. Existing `provider-codex/src/__tests__/{access-token,fetch,provider.integration}.test.ts` are starting points; add import/JWT/state tests and route happy/auth/foreign-owner tests. No external contract prevents implementation. Real account renewal remains a separate live acceptance claim.

## Shared C01/C05/C07 foundation — per-call LLM response adaptation

Define an LLM-level response extension over core `ProviderResponse`, with immutable per-call metadata and optional parsed Responses adapters. Suggested shape: execution identity (selected raw model key, selected tier, stable opaque credential subject/revision as needed) and `responsesAdapter` functions for event frames and unary result. Return these functions closing over **that call's** immutable preparation data. Do not put callbacks into cached catalogs, global provider fields, or core packages.

`providerResponseToExecuteResult` and both direct/translated response branches in `responses/attempt.ts` apply the adapter immediately after parsing, before gateway translation/shims/observation/storage. Audit wrappers so response extras survive auth retry/transport/error wrapping. For C05, metadata is authoritative for executed raw pricing key; reported response `model` is a separate fact. Existing `SourceStreamState.rememberModelKey()` must not overwrite a known executed `*-fast` pricing identity merely because the response reports a base ID. Preserve existing fallback inference when execution metadata is absent. This is a narrow typed foundation, not a full provider transport redesign.

## C01 — authenticated opaque provenance and explicit compatibility

### Identity contract and safe first slice

Use three different identities:

- Requested/public identity: original alias and public model for client output/usage attribution.
- Execution target: provider kind, upstream ID, selected credential subject/revision and exact raw model/deployment. Model/credential selection must be finalized before egress affinity is stamped.
- Opaque compatibility identity: provider-owned explicit key plus scope. Conservative default is same upstream incarnation + credential subject + exact model/deployment; a versioned catalog/operator declaration may deliberately widen that scope. Never derive compatibility from model-name prefixes, vendor display names or a global `openai` constant. Reference Codex/Copilot's shared `key:'openai'` is a design precedent, not evidence that all our providers/accounts are interoperable.

Add typed compatibility declarations in `provider-llm` binding/catalog metadata with strict schema validation and a C03 code revision bump. Custom/Azure declarations are scoped configuration under owner control; do not let discovered arbitrary remote metadata grant cross-owner access. Wider compatibility is optional. Exact-target affinity plus conservative fallback is already useful and implementable without guessed capabilities.

### Carrier and cryptography

Add nullable per-API-key affinity secret in a new migration. Initialize with cryptographic random bytes using a conditional SQL update; concurrent readers use the winner. Never expose it in API-key DTOs, snippets, dumps or logs. Store a version/key-id for future rotation; existing key data is preserved. Derive an AEAD/HMAC key with a versioned domain. The reference `shared/affinity/carrier.ts` uses HKDF/AES-GCM and authenticates original opaque bytes plus field domain; this is a useful implementation template.

Envelope metadata authenticates owner/key binding, upstream incarnation, explicit compatibility identity, original byte encoding, field domain and execution target. Metadata can be encrypted to avoid revealing internal/account identity. Preserve the existing raw UTF-16/base64/base64url codec; never UTF-8-normalize arbitrary opaque strings. Cap trailer/payload sizes before decoding. Bind domains to protocol/item/field so a reasoning signature cannot be replayed as compaction state. Authenticating whole thinking block content (or its digest) also prevents swapping a valid signature carrier onto a different text block.

Foreign upstream opaque content with no recognizable gateway marker remains byte-for-byte foreign, gaining no affinity privileges. A recognizable gateway envelope with invalid authentication/version/scope must produce a typed invalid-state error or remove an explicitly optional whole block; do not reclassify a failed required-state envelope as an arbitrary foreign blob and thereby bypass its origin requirements. Requests without a stable API-key identity do not receive a global shared-key carrier; preserve their existing raw behavior until a separately scoped identity exists.

### Selection and protocol policy

Resolve owner/key routing policy, aliases, disabled models and explicit upstream pin first. Analyze carriers only to filter/reorder those already authorized candidates. Authenticated affinity never resurrects another owner's upstream or overrides a user/key pin. Prefer exact target without degradation, then explicitly compatible candidates, then candidates requiring optional-state removal. Preserve existing order within classes. Required incompatible state returns routing-unavailable before any provider call; multiple required incompatible identities also fail deterministically.

Analyze once, but materialize a fresh candidate-specific payload for each attempt/translation. Active selectors are `shared/select-binding.ts`, `responses/attempt.ts:defaultSelectBinding`, and `messages/attempt.ts:defaultSelectBinding`; patching an unused legacy dispatch router is insufficient. Pass the analysis through hub translation recursion too.

Required-state table: native compaction/compaction_summary, program/program_output opaque continuation, and other explicitly nonreconstructible context must remain compatible. Gateway's own plaintext compact envelope is handled by A14 before this table and does not acquire native encrypted-state semantics. Optional reasoning/signatures can degrade only as protocol-valid whole-item/block removal. Messages thinking removal deletes both text and signature, redacted_thinking as a whole, and any assistant message emptied by that removal; do not send visible thinking detached from its signature. Preserve tool calls, ordinary text and ordering. Review tool-result-adjacent thinking requirements against the existing translator fixtures; reject rather than emit an invalid message sequence when a safe whole-block projection cannot be built.

Stamp on actual egress output (SSE and JSON, including translated outputs), unwrap before provider input, and store a representation with enough authenticated provenance for next-turn expansion. Synthetic gateway items must be explicitly tagged so only owned synthetic items can be removed. C01 can ship Responses+Messages together first, with Chat/Gemini carrier adapters as separate tested slices; it is not complete for all protocols until those adapters are delivered.

Acceptance: wrong key/owner/domain, modified bytes/thinking, malformed/bounded carrier, all UTF-16 code units, config/account replacement, alias-overlay/direct equivalence, explicit pin contradiction, foreign opaque pass-through, mixed required conflicts, optional whole-block removal, immutable candidate retries, compaction aliases, JSON/SSE cross-protocol round trips and immediate durable continuation. Reference affinity tests in `gateway/__tests__/data-plane/chat/{shared,openai-responses,anthropic-messages,openai-chat-completions,gemini-generate-content}/affinity/` supply cases, not framework code to copy blindly. No blocker for conservative identity scope; widening interoperability needs explicit provider evidence.

## C05 — Fast tier as one catalog/dispatch/output/pricing decision

Create one catalog variant index used by listing and request selection. A `-fast` raw ID is a lane only when its base sibling exists in the authoritative raw catalog or the provider has a narrowly documented explicit family mapping; `grok-code-fast` without `grok-code` remains a distinct model. Do not add new guessed family exceptions. Keep both display names and exact raw IDs in the index. Only actual supported endpoints advertise the tier.

Resolve request hints at the provider boundary after gateway translation and before stripping unsupported wire fields. Responses `service_tier:'priority'` may select a known Fast raw ID; Messages `speed:'fast'` needs a supported known Messages Fast variant and a protocol-correct unsupported error otherwise. Count-tokens/embeddings/images do not gain a Fast lane because their names match. Preserve explicit raw model pins. Missing Responses Fast can fall back only according to the already documented source-protocol contract and report the actual default tier; never report priority because it was requested.

Extend `variants.ts`, `interceptors/shared/with-variant-and-beta-filtering.ts` and selected-tier output handling together. Retain `with-service-tier-stripped` after selection. Report `usage.speed`/`service_tier` only from the executed selection or real provider result as appropriate. Use the per-call identity foundation to freeze the exact raw model pricing key through `SourceStreamState` and usage persistence; the current reference explicitly warns that a Fast response may report the base model. Do not infer prices with a multiplier. Existing exact fast pricing rows can be used without claiming they establish live availability or current external prices. Multi-context tier billing remains C10; do not silently broaden it here.

Acceptance: base+Fast, Fast-only explicit mapping, unrelated name ending in fast, both display names, raw pin, missing lane, endpoint exclusions, effort/context combinations, JSON and SSE actual-tier echo, base-model response retaining Fast billing key, alias attribution and zero/unknown counters. Codex catalog synthesis advertises only the selected upstream's known facts. Depends on C03/C04 metadata and per-call identity, not on C01 cryptographic carriers. No external blocker for implementation/fake catalog tests; live supported catalog is required only for production availability assertions.

## C07 — catalog-selected Responses Lite

Source contract is explicit: reference `provider-codex/src/models.ts` validates `use_responses_lite` as boolean and carries `providerData.useResponsesLite`. `constants.ts:72` names `x-openai-internal-codex-responses-lite`; its companion client metadata key is `ws_request_header_x_openai_internal_codex_responses_lite`. This is still JSON to the existing Responses/compact path with SSE responses, not an invented endpoint or binary encoding. Caller-supplied headers/metadata cannot select Lite. Missing/false means Standard; wrong type fails catalog validation rather than truthy coercion.

Implement in three small packages:

1. Pure codec under `provider-codex/src/responses-lite.ts` plus strict raw/provider catalog fields. Reference codec folds callable declarations into `additional_tools`, namespaces flat functions under `functions`, inserts `model.base_instructions`, generates stable UUIDv5 IDs scoped by thread, preserves original history, removes image detail only on specified paths, keeps caller tool_choice, sets parallel_tool_calls false and reasoning.context all_turns. It creates a per-request inverse identity map. Port all of these as one coherent codec; merely moving tools would corrupt response identities.
2. Prepared call object containing original body, encoded body, session/thread/turn identity, callable map, generated-prefix provenance and request echoes. Prepare once outside the 401 retry loop. Adapt streaming output-item and argument/custom-input lifecycle events, terminal result echoes and unary compact output through the per-call LLM response adapter. Restore only demonstrably generated prefixes, retaining identical user-owned copies and modified lookalikes. Never relocate historical tool_search_output declarations; index their callable identities in place. Reject namespace/type collisions instead of guessing.
3. Wire the catalog boolean to HTTP dispatch, including standard/compact auth retry, signal, quotas, owner/account headers, stable device ID and content type behavior. Strip unauthorized incoming Lite markers and add the outbound marker only from selected catalog metadata. Ensure restoration precedes dumps/usage/continuation snapshots that operate on source protocol state.

Reference codec includes pinned first-party Codex source pointers (`3d2ee51...` client/tool/base-instruction implementation, `6b9826e...` tool-name namespace normalization) and a comprehensive local fixture suite. These were inspected as reference code and source pointers, not freshly fetched primary source. Porting the tested adapter requires no network or paid request; first-party refresh/live account probes are later acceptance evidence if desired.

Tests: strict false/true/absent/malformed catalog, all reference `responses-lite_test.ts` cases (duplicates, stable IDs, namespace collisions, search-loaded tools, compact prefix provenance, request echoes), UTF-8/malformed payload boundaries, 401 retry byte/identity equality, no marker on Standard, compact restoration, stream error/EOF/cancellation and concurrent call isolation. Use existing `provider-codex/src/__tests__/fetch.test.ts` with fake fetch and gateway integration tests proving standardized persisted history. Codec-only delivery is groundwork, not completed Lite support.

## C09 — last-observed quota with freshness

Current `quota.ts:getCodexQuota` hides stale observations; fetch gating reads `account.quotaSnapshot` independently and only actual future `ratelimited_until` blocks dispatch. Preserve that gate exactly. High utilization and stale metadata are not rate-limit rejection.

Add a public observation DTO per active-limit bucket: `data`, `observedAt` (the upstream observation), `fetchedAt` (local receipt), `freshUntil`, `freshness:'fresh'|'stale'`. Null means no observation, never zero usage. Compute a fixed freshness horizon from fetched time and known reset instants, e.g. `max(fetchedAt+24h, valid reset instants)`, not a new moving TTL recomputed against today's clock. This avoids making freshness depend on when the UI reads it. Validate persisted numbers/date strings at the read boundary.

After C08 public DTO/auth foundations, add `GET /api/upstreams/:id/codex/quota` using `loadOwned`, correct provider/account lookup, safe error envelopes, and no token renewal/inference on read. Display the latest value with timestamp and stale label in the Codex account status panel. A refresh button for credentials is separate from refreshing quota; do not manufacture a paid inference to refresh quota. No schema migration is needed for observation timestamps already in state. CAS from C08 prevents quota writes from overwriting credentials.

Tests: fresh/stale/missing/malformed buckets, unknown versus actual zero, old observation still shown, future rate-limit blocks despite stale display, utilization 100% without rejection still dispatches, expired rejection ceases gating, owner/admin/foreign/missing auth, and safe DTO. Provider helper alone is not complete dashboard delivery. No external blocker.

## C12 — client WebSocket through shared execution, in four implementable slices

### C12-F1: transport-neutral turn output and completion barrier

Do not wrap an HTTP SSE response in WebSocket frames. Extract a Responses execution controller below `serveResponses`/`respondResponses`: parsing, per-turn authorized context, prior-response expansion, key mapping, quota gate, attempt, canonical frames, completion snapshot, observed usage and dump lifecycle. Keep core `chat-flow-kit` generic; Responses-specific types remain in gateway/protocol packages. Return a turn object with an async event source, abort controller and `completion` promise that settles only after finally has registered/settled required cleanup.

Reuse `createResponseSnapshotWriter` and `ResponsesFinalOutput`. Add a terminal barrier shared by HTTP and WS: reconstruct final output; await enabled durable save; stop keepalive; emit exactly one terminal last; never expose subsequent provider frames as client frames. If tail consumption is required for already-arriving usage, it is bounded/abortable internal observation and must not keep generating after disconnect. Alternatively stop/cancel at terminal when no documented tail usage contract exists; test the existing final-usage behavior before choosing per protocol. A save failure emits failure and no success. Failed/cancelled/incomplete state is not inserted as reusable connection-local state.

C12-F1 is independently useful for HTTP correctness. Tests need a terminal followed by a frame, late error, late usage, stalled producer, blocked save, save failure and cancellation during save, with terminal ordering and usage unknown semantics asserted. A03's await alone is insufficient.

### C12-F2: bounded single-turn session machine

Define states `idle`, `running`, `closing`, `closed`; one active turn, no unbounded pending queue. Parse only supported JSON turn messages. Bound inbound frame bytes, accumulated event bytes and send-buffer high-water mark. Suggested initial limits must be explicit config constants with tests; no opaque unlimited array. Reject overlap with a protocol error while preserving the active turn, rather than accidentally treating a second request as continuation.

Every turn reauthorizes the original credential against a **fresh** configuration snapshot, including disabled/deleted user/key, mapping/pin/model policy and quota. Do not reuse the upgrade's frozen request context. Model changes and owner boundaries are checked again. Connection-local continuation state for `store:false` is bounded and private to this authenticated connection; durable cross-connection state still follows the existing retention/key policy. If offering local continuation, supply it as an explicit store resolver ahead of the durable resolver without setting retention on. Evict failed state; do not let an in-flight turn's partial output become next-turn input.

`generate:false` warmup authenticates/validates and can initialize supported connection state but makes zero inference calls. Implement its exact acknowledgement from the documented client contract before exposing it. Multiplex/fork/stream_id combinations are unsupported in this first slice and rejected explicitly; a single queue cannot advertise current full WS support. Compatibility metadata must distinguish the implemented subset from broad upstream WS capability.

Register the turn completion/cleanup promise when the turn starts, not only after finally runs. Disconnect/close/backpressure aborts the upstream and waits within bounded platform lifetime for usage/dump cleanup; no detached generation. A failed send is cancellation, not a successful delivered terminal. Do not retry the generation after ambiguous delivery.

### C12-F3: Bun adapter

`apps/platform-bun/src/server.ts` currently has only fetch. Add upgrade dispatch for the Responses route, authenticate before `server.upgrade`, and pass a private session object through Bun WS data. Native message/close/drain callbacks feed the session machine and enforce bufferedAmount/drain limits. Reuse request header auth; do not put API keys into query strings. HTTP POST behavior continues through the shared controller.

Run real loopback Bun tests with a local mock upstream: failed upgrade auth, disabled key between turns, immediate second turn after durable terminal, store:false same-connection continuation/no cross-connection leak, warmup zero calls, abrupt TCP close upstream abort, slow reader/backpressure, max frame, error then new turn, duplicate terminal and cleanup settlement. Native upstream remains HTTP/SSE.

### C12-F4: Workers adapter and capability publication

`apps/platform-cloudflare/src/worker.ts` currently wraps only fetch/scheduled. Implement WebSocketPair upgrade and event handlers delegating to the same session controller. Re-establish request/turn-scoped background/config context inside each message handler; the completed HTTP request's AsyncLocalStorage scope is not a session owner. Register completion with `ctx.waitUntil` early and respect the bounded post-disconnect lifetime described by qualified-decisions research. Storage save before terminal is awaited; telemetry does not justify continuing inference.

Run local workerd/WebSocketPair tests and Wrangler dry-run. Exercise cancellation and cleanup under actual Workers APIs; Bun acceptance is not proof for Workers. Only advertise client WS for the platform where the adapter and tests are ready. No native upstream WS, multiplexing, fork or reconnect persistence is included. Those are explicit separate features, not blockers for a tested single-turn bridge.

External boundary: the current official WS guide's multiplex/fork contract is broader than the reference queue. Source-local reference and saved research are enough to design the bridge and foundations. Before claiming compatibility with a particular current client, pin its wire version and verify warmup/error/close shapes against a local first-party client fixture or fetched primary source. That verification is a real acceptance requirement; it does not block C12-F1/F2 implementation.

## Recommended implementation order and completion labels

1. C08-F1 state CAS/revision-fenced effects + public DTOs (data-preserving prerequisite; independently useful).
2. C02 discovery identity/generation + SQL coordinator, coordinated with C03 catalog code revision. Test OAuth refresh during catalog discovery specifically.
3. C08-F2/F3 parser/lifecycle, then C08-F4 UI and C09 observation route/panel. C09's pure DTO can be implemented in parallel once state contracts settle.
4. Per-call LLM response adaptation/execution identity foundation. C07 pure codec can precede it; C07 integration and C05 need it.
5. C01 conservative compatibility declaration and authenticated carrier migration; protocol ingress/egress adapters and candidate selection. C05 does not require waiting for C01's entire carrier matrix.
6. C12-F1 terminal controller and C12-F2 session core, then Bun adapter and Workers adapter separately. Coordinate with current A03/A13/A14 changes rather than duplicating them.

Each slice can be implemented with synthetic fixtures, temporary databases and local runtimes. None requires production credentials, changing stored production data, deployment, push, or external approval. Report library groundwork separately from complete UI/protocol delivery; report live-account and Workers acceptance separately from fake-fetch/Bun evidence. Run focused tests for each slice and the repository-required `bun run ci:local` before any eventual PR. No tests were executed in this design-only task.
