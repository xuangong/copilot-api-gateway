# Deployed A versus candidate B: reader, wrapper, oracle and build-input audit

Prepared 2026-10-02 by read-only source, Git identity, package-link and asset inspection. No product runtime, tests, installs, network access, deployment, process manipulation or source/index mutation was performed. Only this report was written. Source-derived expected behavior below still requires local qualification; it is not a measured result.

Subsequent qualification note: this preparation audit predates Formal 01 and the explicit matrix-observation amendment. The [binding specification](../../specs/2026-10-02-workerd-deployed-comparison.md) and [qualification history](qualification.md) define the final gates. In particular, every wire/capture A-pass/B-fail transition rejects qualification; A-fail/B-fail pairs remain unresolved with both details. References below to inherited behavior are source hypotheses, not automatic failure-equivalence classifications.

## Identities and experiment boundary

- A root: `/Volumes/Projects/copilot-api-gateway-cfw-validation-20260930-001627/baseline`; current HEAD verified as `e660fb4dfcf1734d10f89e52e2d739b2985c634b`. Tracked/untracked Git status was empty. Ignored assets and package links are outside that status.
- B root F: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`; current HEAD verified as `e90b8ee5a5feb6e99ef45cad8ca4463c245c25e7`. Protected collaboration changes remain in ten modified source/test files and four untracked shim/test files. Freeze working-tree bytes, including the untracked `with-responses-collaboration-shim.ts`; HEAD alone is not B.
- P: `F/.superpowers/sdd/2026-09-30-cfw-request-boundaries`. Its before bundle is the repair checkpoint, not deployed A. Its old checksum receipt and relative import roots must not identify the new experiment.
- Apply A's migrations 0001–0014 to fresh A D1 and B's migrations 0001–0021 to fresh B D1. Do not apply B schema to A for the primary comparison.
- Preserve the same logical seed: one fixture owner/key, three custom upstreams, seven scenarios, 65,536 payload characters, direct_fetch only, dump_retention_seconds=0, responses_retention_seconds=0. Numeric-zero dump retention enables writing but does not guarantee public history visibility. Both readers must bypass control-plane retention filters with physical D1/R2 reads.

## Reader adapters required

| Surface | Deployed A | Candidate B |
| --- | --- | --- |
| SQL projection | key_id, id, meta_json, request_body_descriptor, response_body_descriptor | Same plus upstream_exchanges_descriptor |
| Schema | 0001_baseline.sql:60–71 has no upstream column | 0016_dump_upstream_exchanges.sql adds the optional descriptor |
| Request object | gzip, descriptor type bytes; decoded bytes are the original ingress body | Same encoding and exact-byte contract |
| Response object | gzip bytes or gzip JSON array of timestamped ProtocolFrame records | Same descriptor types; ownership/budget handling changed |
| Ownership | dump-request / dump-response, owner_key=JSON.stringify([keyId,recordId]), state=owned | Same, plus dump-upstream for an actual sidecar |
| Native upstream object | Unsupported; no descriptor/object is expected | gzip version-1 fetch-body envelope, descriptor type upstreamExchanges/version=1 |
| Capture omission | No new capacity omission metadata | capture.state=omitted and reason are possible under a separately exercised limit |

P/harness/dump-readback.ts:72 cannot query A. Its sidecar requirement at 98–107 also cannot validate A. Make schema/representation an explicit manifest field (`deployed-legacy` / `current-v1`), then verify table_info against that declaration; do not silently feature-detect a failed query and waive requirements.

Shared reader rules:

1. Join unique wire X-Dump-Record-Id values to exactly one physical dump row. Reject duplicate/missing IDs and foreign key_id values.
2. Validate meta id, POST, path, original requestBytes, status evidence and descriptor shapes. Request digest must match the complete original host request bytes.
3. Read/decompress each referenced object, verify actual compressed size, validate descriptor key namespace and unique ownership, and reject unreferenced/staged/retired files in the normal fresh experiment.
4. For response type bytes, compare decoded SHA256 to that variant's own host wire response SHA256. Do not compare raw A response digest to B response digest: timestamps, IDs and authorized protocol mappings differ.
5. For response type events, validate an array of {ts,frame}, finite nonnegative timestamps, event/done frame types, protocol, terminal cardinality, output/tool/refusal/usage and fault outcome. It is a canonical frame log, not raw SSE bytes; timestamps and frame wrappers make direct wire digest comparison invalid.
6. Independently retain host request/response bytes, parsed wire events and fixture dispatch/body observations for both variants. P only saves full responses for mismatch cells; successful rows' hashes alone cannot reconstruct the byte-level evidence.
7. Always validate structural/storage integrity even if the wire semantic oracle fails. P only runs detailed canonical semantics when row.ok (line 133), which would conceal capture problems in historically failing A cells. Report canonical fidelity and wire semantic correctness separately.

Capture protocol is shared in the ordinary fixture: SSE dumps observe translated ingress/egress protocol; JSON dumps with a cross-protocol producer observe upstream producer frames before body translation. A responses/respond.ts:209–217 and 284–305 prove this placement. B responses/source-result.ts:20–29 and 44–49 retain it; B JSON translateBody's synthetic Responses terminal is not the frame log when a producer was observed. Chat/Messages JSON similarly observe producer frames. Therefore the expected canonical protocol is `stream ? ingress : upstream`, with a bytes fallback for upstream HTTP-error envelopes. Do not force every JSON dump to contain ingress-shaped frames.

For native Responses JSON, validate terminal response bodies rather than demanding delta events. P's terminal-envelope projection in canonicalDumpOracle:57–65 is appropriate. For captured faults, metadata error can document source failure before the HTTP renderer emits a wire error; it must never be injected into the independent wire oracle.

B sidecar validation must check version=1, representation=fetch-body, one attempt matching the independently observed dispatch, omittedAttempts=0 and bounded fields. Request prefix cap is 65,536 bytes, response prefix cap 262,144 bytes; attempt cap 8 and total captured body cap 1 MiB (`upstream-attempts.ts:7–14`). Compare prefix SHA, capturedBytes, observedBytes, totalBytes, truncation, HTTP status, protocol/operation and terminal. The request body includes JSON/markers beyond the 65,536-character payload; its prefix is deliberately truncated. Compare it to the fixture's prepared upstream request, not the original ingress request. Treat eof/cancelled/read_error/fetch_error/not_consumed as distinct observations; accepting any enum value and observedBytes <= fixture bytes, as P:147–151 does, is insufficient proof of complete capture. When an expected early terminal stops consumption, document the exact cell/source behavior instead of calling a cancelled prefix complete EOF. Independent fixture finish plus host EOF remains required.

B sidecar persistence is optional in product semantics: compression, stage or upload failures can fall back to a core request/response row (`dump-store.ts:186–192,320–338`). Under this normal fresh comparison, an omission is a coverage/measurement qualification failure, not automatically a client-response regression. A missing sidecar is normal. B capacity omission tests must have their own declared descriptor/count rules and remain outside ordinary timing.

## Refusal/status oracle differences

P's policy refusal exception describes the repair-era/new mapping, not deployed A. The deployed source lacks `translate/src/shared/messages-refusal.ts`.

| Ingress / upstream refusal | A source-derived mapping | B source-derived mapping / oracle requirement |
| --- | --- | --- |
| Responses / Messages JSON | HTTP 200, completed envelope with output_text BENCH_REFUSAL; no refusal part/error | HTTP 200 failed envelope, invalid_prompt, exact default policy explanation, original BENCH_REFUSAL output text |
| Responses / Messages SSE | HTTP 200, output_text delta BENCH_REFUSAL then response.completed | HTTP 200, output_text delta BENCH_REFUSAL then response.failed with exact policy error |
| Chat / Messages JSON | HTTP 200, content BENCH_REFUSAL, content_filter, no message.refusal | Adds message.refusal policy explanation while preserving content and content_filter |
| Chat / Messages SSE | HTTP 200, content BENCH_REFUSAL, finish stop, DONE, no refusal delta | Adds policy-explanation refusal delta; finish remains stop; content and DONE retained |
| Responses / Chat JSON/SSE | Legacy translators ignore message/delta.refusal, so refusal payload is lost | Responses refusal parts/deltas retained |
| Chat / Responses JSON/SSE | Legacy translators ignore Responses refusal content/deltas, so refusal payload is lost | Chat refusal field/delta retained |
| Messages / Chat JSON/SSE | content_filter maps to stop_reason refusal, but legacy translators ignore Chat refusal text | Refusal text retained and stop_reason refusal |
| Messages / Responses JSON | Refusal text becomes a text block, but stop_reason end_turn | Refusal text and stop_reason refusal |
| Messages / Responses SSE | Legacy event translator ignores refusal events, then end_turn | Refusal text and stop_reason refusal |
| Same-protocol refusal | Native fixture refusal representation | Native fixture refusal representation |

Evidence: A responses-via-messages/body.ts:108–143 and events.ts:381–390; A chat-completions-via-messages/body.ts:38–48,102–108 and events.ts:124–132,254–270; A messages-via-responses/body.ts:67–75,110–138 and events.ts:395–412,451–463; A messages-via-chat-completions/body.ts:56–65,71–102; corresponding A/B translator diffs confirm the missing/additional refusal handling.

Keep a strict cross-variant semantic oracle (including refusal payload, usage 7/3, exact terminal count, full transport EOF, correct fault status, and no false success). Separately record `baselineMappingMatched` using explicit narrow A shapes above. A's legacy text-as-completed or dropped-refusal representations are historical defects, not modern semantic passes. Do not add a broad `text===BENCH_REFUSAL` refusal waiver for every protocol or accept any failed envelope as a policy refusal. Preserve the new policy error's exact code/message/upstream/scenario scope. This lets the aggregate distinguish inherited A defects, improvements, and regressions.

The current P oracle:21,97–104 already recognizes B's specific Messages policy representation and Chat policy-explanation+original-text representation. Its content_filter text fallback also matches A Chat/Messages JSON. It will intentionally fail other legacy refusal-loss cells. Thus “every A matrix cell passes modern semantics” is not a valid prerequisite for running the comparison; every A cell must be complete and faithfully classified. Require all declared B semantics and reject new B failures in A-passing matched cells; list inherited failures explicitly.

Status readback must also be variant-scoped:

- A's legacy finalizer records response.status directly (`accumulator.ts:267–286`). No source evidence supports applying the 502-vs-200 policy exception to A; use equality and qualify any observed exception independently.
- B Responses/Messages refusal JSON has a known narrow source path: HTTP renderer keeps 200 for response.failed (respond.ts:20–26,44), but turn outcome becomes failed (turn.ts:478–479), dump finalizeTurn records 502 for nonstream failed outcome (turn.ts:387–389), metadata error kind failed is stamped. P's dumpStatusEvidence:35–41 can be retained only for B and only when exact expected refusal/complete transport/policy evidence matches. SSE remains status 200.
- Ordinary failed/truncated JSON fixture offers return upstream 502; http503 returns 503; partial SSE faults retain HTTP 200 plus independently observed partial output and failure/no-terminal evidence. Keep transport/parse failure separate from intended protocol failure. Do not infer complete wire semantics from dump metadata.

These are source expectations. The complete 126-cell A and B matrices must qualify actual routes, inherited truncation behavior and refusal statuses locally; this audit did not execute them.

## Physical accounting at count=40

Each variant has latency 24 warmups + 80 timed requests, matrix 24 warmups + 126 matrix requests, and diagnostic 24 warmups + 80 sampled requests: 358 offers. The combined experiment is 716 offers. All fixture ingress requests and responses are nonempty.

| Per-variant unit | Logical requests / dump rows | A normal owned R2/spilled files | B normal owned R2/spilled files |
| --- | ---: | ---: | ---: |
| Latency | 104 | 208 | 312 |
| Matrix | 150 | 300 | 450 |
| Diagnostic | 104 | 208 | 312 |
| Total per variant | 358 | 716 | 1,074 |

Expected experiment total: 716 dump rows and 1,790 owned objects, comprising A's 716 and B's 1,074, if all normal capture/readback gates pass. These are predicted counts, not measurements. A has two referenced objects/request; B has three when a complete sidecar is present. Do not demand the old repair-pair total of 2,148 objects or equal A/B physical work. Report request/response/sidecar compressed and decoded totals separately.

Retention zero should leave responses_snapshots and responses_items at zero in both. Request/usage/performance/D1/KV rows must be inventoried by variant and validated against declared semantics; do not require identical physical aggregate counts after schema/cache changes. Background waitUntil registration counts can also differ; each variant must settle every registered task without failure, not equal the other variant's count.

## Wrapper and runner constraints

- Reuse an equal observation-only wrapper for A/B: import the frozen worker bundle, forward original env/request/context, observe waitUntil registration/settlement/rejections, and expose the authenticated local settled barrier. P/entry.mjs.template:9–46 is a suitable observation shape.
- Do not use historical L/a/entry.ts as the new wrapper: it adds per-request benchmark auth, mutates IMAGES, has seed/reset control routes and fixed 18870 provenance. Its Wrangler manifest is historical schema/bootstrap evidence only.
- Keep the host fixture outside the gateway isolate with identical behavior, dynamic loopback ports, complete response finish/close receipts, exactly-one dispatch per offer, and strict loopback-only direct_fetch egress. Do not fabricate A's sidecar or instrument away its response tee; A's tee and B's changed persistence work belong to the product comparison.
- The wrapper's activeFetches counter only spans worker.fetch returning a Response, not streamed EOF. Require independent host EOF + fixture completion + settled waitUntil + physical readback before qualification.
- Dump writers can catch persistence failures internally, so an empty wrapper rejection list is insufficient; physical ownership/object/cardinality checks are mandatory.
- Move old harness roots, fixed repair checksum lookup, migration root, output restrictions and common runtime imports into immutable manifest inputs. Bound barrier/initialization/readback/disposal externally; preserve durable offer/terminal/stage journals and strict child/aggregate completeness.
- Sampled CPU window through settlement includes product background work and observation RPCs; report unequal A/B storage work and assets. Do not call these metrics billed CPU, peak/RSS or CFW production resource parity.

## Current build inputs and dependency readiness

Readiness.md:52–58 correctly identifies ignored input classes, but the old “baseline dependencies exist” assumption is stale. Current read-only evidence:

- A has no `vnext/node_modules`; app/package-level node_modules contain valid workspace symlinks to A but broken third-party symlinks into A/vnext/node_modules/.bun.
- A's platform dependency image-size and gateway dependencies hono, @hono/zod-validator, zod and jsonrepair are currently unresolved. This means the proposed plain A Bun build cannot be assumed ready.
- B has the usable package store. Resolved runtime packages: Miniflare 4.20260601.0, workerd 1.20260601.1, Wrangler 4.97.0; Wrangler's esbuild 0.27.3. workerd is found beside Miniflare's resolved package, not at B/vnext/node_modules/workerd.
- The checked third-party lock entries match A/B exactly: hono 4.12.23, @hono/zod-validator 0.9.0, image-size 2.0.2, jsonrepair 3.15.0, zod 4.4.3. Whole locks differ and must both be retained. This is not a complete dependency-closure proof.
- Both variants' workspace symlinks resolve to their own source roots. Preserve that isolation. A resolver fallback must never resolve @vibe-core/* or @vibe-llm/* to B source.

Build using the same Bun executable/options, target=node, external cloudflare:sockets, entry naming worker.mjs and external source map. Keep build output under the new experiment. If reusing B's existing third-party store for A, implement a declared import-only resolver overlay in the experiment directory: resolve A workspace exports from A manifests/source first; allow only third-party packages whose exact lock identity agrees; resolve their actual package exports from the recorded B store path; hash the resolver, consumed package files and lock entries. Do not install, repair symlinks inside A, add today's collaboration patch to A, or silently substitute B workspace packages. The later build should record resolved module inventory and reject paths escaping declared variant source/approved dependency roots.

Existing ignored asset hashes (SHA256) were computed from current local bytes:

| Relative path under vnext/packages/gateway/src | A bytes / SHA256 | B bytes / SHA256 |
| --- | --- | --- |
| shared/edge/assets/favicon.png.txt | 8,440 / 0b89908bb405cddfc8867287644ce0205f9f0ec3fd7ec511a0d9c7a3c9aced3f | Same |
| shared/edge/ui-pages/dashboard-app/dist/dashboard.css(.txt) | 52,017 / 8382beda349f6b5f92790a56c6883387bbe8a2ca73d98259083622916f9a1cb2 | 53,098 / f4c0556b8a352e7c07b46898e091ff153d559fbdcb067ae117cf822780c73a8c |
| shared/edge/ui-pages/dashboard-app/dist/dashboard.js(.txt) | 788,547 / 4d9429b412dffdc2049f74bd9d2e2cb106763ccf61946506be95bbf066eb13fb | 836,482 / 092235647b61feb79878f353d994ee6b7148b29170fa819e02d8d4ff5dbacec7 |
| control-plane/setup/dist/runner.mjs(.txt) | Absent; A does not import setup/static.ts | 23,577 / fdb31ae7c7cbebdb8e682e57eb7b53ec3c7381ff324d667e70d23ab8daad64e0 |
| control-plane/setup/dist/runner.sha256.txt | Absent | 65 / 7162f516caada4013571e8f8496f32711d4e27d091949eb4e5ed3600e552b11a |
| control-plane/setup/dist/setup.sh.txt | Absent | 2,143 / c54a8b465f3b5ae8d400f97f178af14d985a5090578fcbfb37e903abc5b248fd |
| control-plane/setup/dist/setup.ps1.txt | Absent | 2,797 / f4791089e0cc6ac547c39c2a2b05235c02eeda9c825ab88928a7b4d9531f9d9a |

The .txt asset imports are direct bundle inputs. Existing plain JS/CSS/runner files match corresponding .txt bytes. Preserve these historical/current bytes and hash them in each freeze; do not rebuild unrelated dashboards or add setup assets to A. Their different bundle payloads may affect startup/heap, so report provenance rather than silently making assets equal.

A bun.lock SHA256: `9bbf62deaaa08c03b58a9c521d8adafa515c2904a4c3482ef6f641a2854cdd97` (132,950 bytes).
B bun.lock SHA256: `07519569bb27f4263158599ef1f8450b2b8b86396bb838663bbfdccdcaa5e411` (133,518 bytes).
Both tsconfig.base.json SHA256: `be0c4cc394531bdfdafe32fb9f773c74dc2fa7ab875220a39de6de12e9999aca` (412 bytes).

## Required qualification outcome

A fair experiment needs explicit A/B migration and reader adapters, independently qualified refusal/status mappings, immutable source/asset/dependency provenance, identical observation/fixture machinery, per-variant physical counts, and complete durable request/upstream/settlement/readback evidence. The new runner should not claim ready from the previous harness --check alone. No local or cloud performance outcome was established by this audit.
