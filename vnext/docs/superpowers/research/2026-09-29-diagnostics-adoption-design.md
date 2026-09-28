# Diagnostics, usage overview, and request-body design packages

Date: 2026-09-29. Scope: B05, D02, D03, D08, D10. Read-only investigation plus this design artifact; no application edits, installation, commits, live data/configuration access, or deployment. Worktree HEAD observed during investigation: `ca3bb5f07a74d4ed47613e25a9d0b8d7fec2d143` (other workers are active). Reference checkout: `/Volumes/Projects/copilot-gateway`.

## Constraints and delivery order

Follow `vnext/AGENTS.md` and the global constraints in `vnext/docs/superpowers/plans/2026-09-29-reference-adoption-follow-up.md`. Preserve opt-in capture, owner/key authorization, cancellation, provider identity, historical accounting, and existing collaboration changes. Database changes are new numbered migrations only. Source paths below are relative to `vnext/` unless marked reference.

Deliver B05a (pure serialization/hash), D03 (browse/export after B07), D08 (bounded usage overview), D02a (bounded collector + storage), D02b (attempt instrumentation), B05b/c (transport/provider adoption). D10 has a genuinely separate credential/local-transaction prerequisite, but that prerequisite is implementable now with fixtures. None of these packages requires WebSocket support or affinity work.

## B05a: deterministic serialization and incremental identity

Current facts:

- `packages/provider-copilot/src/forward.ts` creates a full JSON string before retries.
- `packages/provider-codex/src/fetch.ts:deriveSessionIdFromInput` hashes `instructions + U+0001 + JSON.stringify(seedThroughFirstUser)`; `ids.ts:sha256Uuid` additionally allocates full UTF-8 bytes.
- Reference `packages/provider/src/json-request.ts` uses `@discoveryjs/json-ext`, counts emitted bytes (not stringifyInfo estimates), clones input for replay, and opens a pull-driven stream. Its `json-hash.ts` uses incremental `@noble/hashes/sha2.js`.

Smallest useful contract:

1. Add `packages/provider-llm/src/json-bytes.ts` with `jsonByteChunks(value)` and an immutable JSON request snapshot factory. It is provider-shared, never provider-to-provider imported. Keep generic incremental SHA-256 in a framework-safe utility/platform package or provider-llm until a second generic consumer needs it.
2. The iterator must emit exactly `TextEncoder.encode(JSON.stringify(value))`, in native property enumeration order; **deterministic does not mean sorted keys**. Specify the supported no-replacer/no-indent contract. Top-level undefined/function/symbol has no JSON representation; hash callers reject it rather than silently hashing the word `undefined`. Cycles and BigInt preserve native failure before any network dispatch. Include finite/exponential number formatting, -0, nonfinite numbers, sparse arrays, boxed primitives, `toJSON(key)`, and object undefined omission.
3. Snapshot factory fast path accepts plain JSON data with ordinary enumerable data properties. Clone structural containers once, retaining immutable string values. Do not call accessors or stateful `toJSON` once for length and again for each retry. For objects outside that safe domain, the compatibility path performs native `JSON.stringify` **once**, then owns those buffered bytes. This keeps existing behavior while limiting streaming optimization to stable inputs. Parsed provider request bodies qualify for the fast path. Avoid blindly treating reference `klona/json` as proof of arbitrary `toJSON` equivalence.
4. Use a vetted chunked serializer (reference library is a candidate), with actual chunk-byte tests; do not implement a new JSON grammar casually. Pin it directly in the adopting package and Bun lockfile during implementation. Long scalar strings must also be emitted in bounded pieces; applying native stringify to one huge string would retain a large escaped copy and weaken the memory claim.
5. Chunk target: 64 KiB encoded bytes, with a documented small maximum escape/code-point overrun if the library needs it. Never independently encode two halves of a UTF-16 surrogate pair. Lone surrogates in JSON strings must remain native escaped sequences. Raw string prefixes use a stateful UTF-8 encoder across chunks; the explicit U+0001 boundary in the Codex prefix prevents cross-component pairing, but a generic chunk API should not assume that.
6. `sha256JsonDigest(value, prefixParts)` updates one incremental hash over raw UTF-8 prefix parts followed by JSON bytes. `sha256JsonUuid(seed, [instructions, '\u0001'])` retains the existing first-16-byte/version-4/variant bit formatting exactly. Keep the old public helper where other callers still need it. No seed selection, header override precedence, installation ID, or random ID changes.

B05a acceptance: differential native JSON byte oracle over a deterministic corpus plus randomized JSON-only trees; exact digest equality to Web Crypto; old/new Codex UUID golden cases (empty instructions, lone and paired surrogates, long strings, first-user prefix, later-tail additions, missing first user). A JSON iterator failure must not leave a reusable half-hash or partially opened request. Measure 1/10/50 MiB synthetic bodies and large instruction strings with independent-process heap/RSS sampling before claiming a memory improvement. No transport adoption is needed to deliver the hash optimization.

## B05b/c: replay ownership before provider streaming

Current facts: `packages/http/src/types.ts` only permits `Uint8Array`; `packages/dial/src/replayable-request.ts` materializes input and rejects streams; `dial/src/fetcher.ts` rejects streams whenever a materialized transport is possible. `http/src/fetch-retry.ts` reuses RequestInit across HTTP retries. Updating only provider call sites would break both dial fallback and HTTP retry replay.

Contract:

```ts
interface ReplayableBody {
  readonly contentLength: number
  open(signal?: AbortSignal): ReadableStream<Uint8Array>
}
```

- Length is a nonnegative safe integer measured from the exact snapshot byte iterator. It is not object-size estimation. Every open starts at byte zero and yields identical bytes; mutable original objects cannot affect it.
- Extend the framework `Fetcher`/request-init contract with this discriminated body shape, without leaking a custom object into runtime fetch. Preserve existing BodyInit fast paths. Extend HTTP transport to accept bytes or a known-length body stream factory.
- Dial's owner retains the snapshot factory, not an already consumed stream. Each proxy/direct-connect/direct-fetch attempt receives a fresh open. `fetchWithRetry` also opens a fresh body for each 429/5xx/exception attempt; it must not reuse the runtime stream generated for attempt one.
- HTTP serializer strips conflicting caller framing headers and writes exact Content-Length. Pump one chunk at a time with awaited writer backpressure. Too few or too many emitted bytes abort the exchange and close/release both transport halves; never send a successful truncated body or append excess bytes into the next message.
- Direct Bun fetch adapter owns runtime options (including any necessary duplex option); Workers adapter uses its supported known-length streaming mechanism rather than assuming a Content-Length header makes an arbitrary stream fixed-length. A buffered compatibility fallback may be explicit for an unsupported runtime, but report that fallback in benchmarks. Avoid Node-only imports in Workers.
- On abort/read/write failure, cancel the currently open body, return the generator, remove listeners, and release locks. No eager tee. Retry ownership never transfers the source snapshot to a single attempt.
- Adopt Copilot then Codex only after fake transports prove retries and fallbacks. Preserve token refresh, account/session metadata, compressed-response behavior, and cancellation.

Files: `packages/upstream/src/` Fetcher contract; `packages/http/src/{types,fetch-on-stream,fetch-retry}.ts`; `packages/dial/src/{replayable-request,fetcher}.ts`; both platform fetch adapters/bootstrap; provider-llm JSON helper; Copilot `forward.ts`; Codex `fetch.ts`. Exact filenames for platform adapters should follow current bootstrap conventions.

Tests: direct-only, proxy-only, direct-fetch then proxy, proxy then direct-fetch, two-pass backoff, HTTP 429 then success, Codex auth retry, zero body, abort before open/mid-write/backpressure, upstream early response, generator throw, wrong length, source mutation after snapshot, concurrent separate opens, string surrogate boundary, number `1e21`, unsupported arbitrary BodyInit fallback. Run HTTP/dial/provider unit suites, purity, typecheck, both platform builds/dry-run, then full `ci:local` for integration.

## D02: bounded application HTTP attempts, not translated frames

Current `shared/dump/accumulator.ts` records incoming request and canonical outgoing `ProtocolFrame`s, and its response tee can retain an entire response. `data-plane/providers/registry.ts:listProviderBindings` builds per-request providers using `data-plane/dial/per-request.ts:createPerRequestFetcher`, but also discovers models on those providers. The outer fetcher boundary is before protocol parsing; dial fallback attempts occur inside that fetcher.

### D02a collector/storage

Introduce `shared/dump/upstream-attempts.ts`, pure and request-scoped, with these initial constants: maximum 8 recorded attempts; 64 KiB request and 256 KiB response prefix per attempt; 1 MiB total captured body bytes per dump; 16 KiB combined headers per attempt; an independent 64 KiB total metadata/header budget. These are conservative implementation defaults, not measured production tuning. After limits, continue forwarding all bytes, increment counters, and set truncation metadata; never fail the user request due to capture exhaustion.

Each attempt records stable request-local ID/parent call ID, upstream ID, attempt order, offset timestamps, method, sanitized URL, request/response headers, nullable status, representation (`fetch-body`), observed/captured byte counts, prefix bytes, explicit `truncated`, and terminal state (`eof`, `cancelled`, `read_error`, `fetch_error`, `not_consumed`). Unknown total byte count is null when upstream was cancelled before EOF; it is not the prefix size. Store safe error categories, not arbitrary error strings that might contain credentials. Capture completion and HTTP/protocol success remain independent.

A fetch-body prefix is the bytes provided by the fetch/HTTP adapter to the parser. Runtime fetch may decompress; it is **not** proof of compressed socket wire bytes. Capture the adapter's representation metadata rather than mislabeling content-encoding. HTTP/2 framing, TLS, and raw compressed wire capture are outside this package.

Use an inline pull-through stream wrapper: copy only prefix bytes when the consumer pulls; do not tee to an independently draining branch. Forward cancel to the source and release locks. Buffered request data is snapshotted up to the cap and labeled `prepared`, not falsely `sent`; instrument transport writes later if sent-byte evidence is required. Do not consume opaque single-use request streams to inspect them. With B05b, wrap each `open` to observe actual consumption without taking ownership away from retries.

Persist an optional versioned `upstreamExchanges` envelope in one additional gzip spilled file per dump, referenced by a **new nullable descriptor column** from a new numbered migration. One sidecar avoids per-chunk rows/files and large inline JSON rows. Extend write/read/wire types; old records with null descriptor decode to no captured exchanges, not an empty proof of zero attempts. Update B07 staging/reference/expiration logic to cover the descriptor and `dump-upstream` owner kind, including pre-row failure and row-first/file-failure recovery. Publish broker metadata only after all required dump references are committed. Keep canonical client frames unchanged.

Security prerequisite: a downstream key owner may use a shared upstream without owning its credentials. Therefore upstream Authorization, cookies, proxy credentials, token-bearing query values, and account credential headers must be removed **before capture persistence**, even though current inbound dump headers are stored verbatim. Do not expose upstream credentials through the existing owner-scoped detail API. OAuth/token-discovery calls are not generation attempts and should never be captured into a user's dump. Start capture only in an explicit execution scope, not around `getCachedModels`/discovery.

### D02b attempt instrumentation

Pass an optional request-scoped observer via binding resolution/dispatch into the per-request fetcher; never use a global current-dump slot. The initial outer fetch call ID captures each provider-level retry (including a rejected HTTP attempt whose body is cancelled). Add an optional dependency-injected observer to `dial/src/fetcher.ts` so each actual proxy/direct transport attempt has its own ID under that call. Framework observer carries generic byte/status metadata only; it does not import gateway dump types. Without this inner hook an outer fetch wrapper must not claim all transport attempts were captured.

Collector finalization happens when the logical request completes/cancels. Snapshot only bounded retained prefixes; explicitly close any still-open observer as incomplete. A retry helper cancels rejected bodies today, so a rejected 429 may legitimately have an empty `cancelled` prefix; do not drain it merely to improve diagnostics. Retention-off must allocate neither collector nor wrappers. Capture/store failures cannot transform an otherwise successful inference into failure.

D02 matrix: cap at exact boundary and one byte over; one giant source chunk; many tiny chunks; binary invalid UTF-8; complete/malformed SSE bytes before parser; 401 refresh and 429 retries; proxy fallback; no-body response; thrown fetch; failure after prefix; consumer never reads; cancellation and lock cleanup; two overlapping owners; discovery excluded; retention off; old-store record compatibility; sidecar staging crash/expiry; upstream credential non-disclosure. Source/tests: dump `types.ts`, `wire.ts`, `accumulator.ts`, `repo/dump-store.ts`, `tests/{dump-store,dump-accumulator}.test.ts`, new collector tests, dial attempt tests, registry/dispatch integration tests.

## D03: useful browse/detail and one safe export format

D03 can ship after B07 without D02. Reuse `control-plane/dump/routes.ts` owner/admin + retention gate and the existing `records`, `records/:recordId`, and `stream` APIs. Place a Requests action on an authorized key and a key-scoped dashboard reader; do not expose it for shared observability viewers or mere key assignees unless backend authorization explicitly permits them.

First UI: newest-first bounded pagination, live appended deduplication by ID, request metadata, explicit raw-client versus canonical-output labels, detail expansion, and Download redacted JSON. Cancel detail requests/EventSource and reset state when key changes. Stable compound cursor remains server-owned. Render bodies as escaped text, never HTML; binary bodies show encoding/length, with local view action. Display capture/expiry/missing-body errors rather than silently dropping entries.

Add `GET /api/keys/:keyId/records/:recordId/export` so policy is shared and tested centrally. Same ownedDumpKey gate and key-scoped store lookup; `Cache-Control: no-store`, JSON attachment filename derived only from validated record ID, no caller-provided path/name. This is one single-record JSON format, not an additional HAR/curl family.

`shared/dump/export.ts` builds a new export shape from a deep clone. Header sanitation is case-insensitive and covers inbound/outbound and every D02 attempt: Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-API-Key, API-Key, access/refresh/session-token headers plus provider credential headers. Remove URL userinfo and token/key/signature/code query fields from all path/url metadata. Prefer a safe diagnostic header allowlist over trying to enumerate all custom credential header names; preserve content-type/length, request IDs, status/timing only where safe. Never rewrite stored originals or the ordinary authorized detail response.

To make “redacted export” defensible for arbitrary binary/request bodies, v1 defaults to **metadata plus body descriptors with `omitted: sensitive_or_opaque_content`**, including stream event payloads and arbitrary error text. This preserves byte counts, encodings, event names/counts, completion/truncation and request/response status without silently exporting base64 credentials. Raw-body download is not a backdoor alternate format. A later explicit content-bearing export may decode structured UTF-8 JSON, recursively remove sensitive fields and known credential values (including encoded forms), and omit unparseable/opaque envelopes; it must have its own policy/fixture coverage. Arbitrary prompt text cannot be certified secret-free by a header denylist.

Acceptance: owner happy path, admin, unauthenticated, wrong owner/key/record, disabled retention, expired/missing sidecar; mixed-case credential headers, query duplicates/percent escapes/userinfo, JSON and base64 secret fixtures, response Set-Cookie, D02 nested envelopes; original bytes/headers deep-equal before/after export. UI tests cover key switch race, reconnect duplicate, page/live overlap, abort cleanup, empty/expired records and keyboard detail/download controls. API and pure state logic should be unit tested, UI verified in browser. Files: dump routes/helper/tests; dashboard new `api/dumps.ts`, `state/dumps.ts`, `tabs/requests/`, and authorized key-row action/navigation. No global dump listing endpoint is required.

## D08: measure, then add a bounded usage overview

### Measured evidence

Ran three throwaway Bun scripts in `/tmp` against the **actual** `BunSqliteRepo` migration schema in `:memory:`. Runtime Bun 1.3.0, no real data. Fixture: 50,000 storage buckets, 95,000 dimension rows + 50,000 request rows, 5,000 display groups, decimal prices, missing output dimensions, and null prices. Separate processes per query variant.

| Path | DB result rows | Display rows | One observed wall time |
| --- | ---: | ---: | ---: |
| Current repo.query + aggregateUsageForDisplay | 145,000 | 5,000 | 135.48 ms |
| Naive grouped dimension/request queries | 15,000 | 5,000 | 95.99 ms |
| Full-bucket window price fallback then grouped queries | 15,000 | 5,000 | 482.50 ms |
| Indexed correlated fallback then grouped queries | 15,000 | 5,000 | 144.32 ms |

Current-path end-minus-start heapUsed was 41,324,755 bytes; SQL variants reported zero delta. This is a coarse Bun heap counter, **not a reliable peak or retained-memory proof**. No Workers/D1 benchmark was run. The safe correlated query proves row-transfer reduction, not latency improvement; the faster naive result is not an acceptable final implementation.

Current and naive fixture results matched all 5,000 non-cost rows exactly and cost within 1.74e-18 absolute error. Total requests were 50,000 and total cost about 11.935829906670012. A second targeted historical fixture demonstrated the semantic defect: input 100 @ 0.125 plus cache-read 100 @ null and output-image 5 @ null gives current cost **0.000025**, naive SUM cost **0.0000125**, and resolved SQL cost **0.000025**.

Why: `assembleUsageRecords` reconstructs a ModelPricing map, then `recordCostUsd` invokes `unitPriceForDimension`, including fallback to same-full-bucket input/output price. Normal writes generally resolve this already, but legacy/imported rows can retain null dimension prices. New SQL must preserve this read-time behavior.

### Implementable package

Leave `performance-metrics.ts` alone: it already groups in SQL and uses json_each for key sets. Add a separate `UsageRepo.queryOverview`/repo query helper and `/token-usage/overview`, while retaining detail query. Start with the dashboard's required series/totals/breakdowns rather than copying the reference six-axis compound SELECT. Bind fixed axis names from a closed enum; user input never becomes SQL identifiers.

1. Resolve authorized key scope in the route exactly as current token-usage: admin optional key; API key strictly itself even with session; user owned + assigned; shared view owned-only then existing HMAC redaction. `keyIds: []` must return empty explicitly. Current generic range helper would drop the empty filter, so do not reuse it unchanged. Use one json_each(?) parameter for key sets, and intersect keyId if also present. Preserve `[start,end)` hour semantics.
2. Query request counts separately from dimension rows so joining six token dimensions cannot multiply requests. Both tables can independently create a bucket; merge their union. Preserve incomingModel, model, client, key and selected time grouping; collapse upstream/modelKey only after pricing.
3. For each dimension row, resolve price as `COALESCE(row.unit_price, same-storage-bucket input/output price)` using a CASE-gated correlated lookup through the existing full-identity unique index. Full bucket is `(key_id,incoming_model,model,COALESCE(upstream,''),model_key,client,hour)`. Only cache/read/write/input-image fall back to input; output-image falls back to output. Unknown dimension rows do not suddenly become billable. Preserve null when no price exists; only cost contribution becomes zero.
4. Avoid integer casts, price rounding, or conversion to cents. Existing schema is REAL and wire cost is JS number; this is **not** an arbitrary-precision DecimalString ledger like the reference. Preserve current fractional-price behavior with numeric tolerance, document changed floating addition order, and do not promise bit-identical floating sums. A true decimal ledger requires a separate versioned accounting migration. For an overview that exposes price completeness, return explicit unpriced/observed counters; never label null-price quantities as known-free or absent token counters as observed zero. Existing display tokens intentionally omit nonpositive dimensions, so retain that wire projection without rewriting stored unknowns.
5. Bound response work with validated date range and bucket count (initial maximum 366 daily buckets, or 744 hourly buckets). Each requested axis is one small aggregate query or a VALUES-based axis catalog; do not generate UNION terms proportional to selected keys/hours. Page large categorical breakdowns with limit + explicit continuation/hasMore; totals query must cover full scope and must not sum only the returned page. Keep query count fixed and below platform budgets. The old detail endpoint remains available for detail consumers.
6. Dashboard overview consumer switches only when response covers its filters and participants mapping. Do not replace its existing hourly details with a silently truncated array. Add immutable query shapes to `apps/dashboard/src/api/usage.ts` and state selectors; use current JS aggregation over identical fixtures as the oracle.

Tests: real SQLite, no database mocks; every six billing dimensions; 0/absent/null price; request-only/token-only; price fallback and explicit zero price; fractional tiny prices; several upstream/modelKey prices per display group; legacy incoming model; NUL in tuple fields; nullable/empty upstream identity; soft-deleted keys; scope authorization and API-key/session precedence; empty/large key sets; exact end exclusion; pagination totals; invalid bucket/range; ordering. Compare integer/token/request fields exactly and fractional costs with defined relative/absolute tolerance. Run existing repo-usage/control-plane-token-usage tests, new overview tests, dashboard pure selectors, local workerd query execution for bind/compound-select limits, and ci:local. Add repeated distribution/heap/RSS benchmark harness before calling the change faster. Practical ruling: row-transfer reduction is confirmed, but latency and heap benefit are not. Keep the current endpoint as the production path until repeated data-transfer/peak-heap measurements establish a useful benefit and the historical fractional-price/unknown semantics matrix passes. The bounded SQL overview is the concrete next experiment, not an unconditional replacement. No further query tuning was attempted in this task. Reproducible synthetic sources are saved under `2026-09-29-diagnostics-probes/d08-{baseline,correlated,fallback}.ts.txt` next to this document; they use only an in-memory database and synthetic fixtures.

## D10: separate scoped setup and local transaction prerequisite

Current key panel generates snippets; there is no setup lease/revision/rollback API. Reference `packages/agent-setup` is useful source for schema/render/installers, but its URL token placement is not a reason to expose gateway/session credentials in downloads or logs. No live CLI configuration changes are authorized by this design task.

Smallest coherent server delivery:

- Add a new setup lease table/migration: hashed 256-bit random bearer token, owner/key identity, exact configuration revision + artifact digest, client/platform scope, expiresAt (initial 10 minutes), consumedAt/revokedAt. Store token hash, never plaintext lease in logs. Owner/admin mint endpoint uses session authorization and CSRF/origin rules consistent with existing mutations. Assigned-key use does not imply permission to mint the owner's setup lease.
- Preview endpoint returns a redacted structured merge artifact and digest under existing auth. The minted token authorizes only one exact artifact exchange, not inference, key listing, arbitrary file access or credential rotation. Token exchange rechecks owner/key active state and configuration revision and atomically consumes via a conditional update; concurrent redeemers have at most one winner. Failed/consumed download requires minting a new lease rather than silent replay.
- Public installer code contains no credentials; exchange token is sent in an authorization header/body and never a query URL. Artifact exchange responses are no-store. Do not embed an upstream OAuth credential; the eventual client receives only the selected authorized gateway API credential. Download itself never modifies local settings.

Pure local planner first (`apps/dashboard` snippet utilities or a new focused setup package): accept parsed current JSON/TOML, managed fields and expected file digest; return preview/diff/new content plus touched-key manifest. Preserve unrelated keys/comments where the format parser supports them; reject malformed files/duplicate or ambiguous TOML paths rather than rebuilding everything. Scope first delivery to verified Claude env/settings and one Codex provider configuration; no CLI install/update, daemon restart, unrelated opt-out settings, or auto-running agents.

Executor package tested only against temporary fixture homes: read file revisions, refuse symlinks/unexpected targets, acquire local transaction lock, create private sibling temp/backup files, recheck digest before rename, fsync where supported, atomically rename each file, journal multi-file progress. On partial failure roll back only files still matching this transaction's written digest; if another process edited them, preserve the edit and give a manual recovery path. Keep backup/journal until explicit cleanup/retention policy; redact secret values in previews and terminal output. Shell/PowerShell wrappers quote literal opaque model names and pass structured values to the planner; no eval-generated commands or download-and-overwrite shortcuts.

D10 matrix: owner/admin/wrong owner/unauthenticated, expiry/revocation/key deletion, revision change, two concurrent exchanges, bearer unusable against inference, no token in URL/log/error; JSON/TOML unrelated keys preserved, Unicode/quotes/newlines model strings, malformed config, NUL rejection, dry-run, absent/existing files, permissions/symlink, concurrent edit at every stage, disk-full/write/rename failure, process-interrupted journal recovery, rollback conflict, Windows and POSIX paths. Server + planner with temp-home executor is an independently reviewable prerequisite package. One-command UX is complete only after both platform wrappers pass these tests; production local configuration remains untouched until a user invokes the feature.

## Status and limits

All five requested items now have executable scope, source seams, explicit contracts and acceptance matrices. B05a and D03/D08 can be scheduled independently; D02 storage extends B07's lifecycle; D10's prerequisite is a real credential/transaction design, not a size deferral. Measurements are isolated Bun SQLite evidence only. No application implementation or full CI was performed in this read-only design task.

Probe files use a `.ts.txt` suffix to stay outside application lint/typecheck. Copy to a temporary `.ts` path before running with Bun; inspect and update the absolute worktree import path if necessary.
