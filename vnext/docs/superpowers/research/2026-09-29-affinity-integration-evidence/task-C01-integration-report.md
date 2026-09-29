# C01 production integration package — Responses and Messages

Status: implementation frozen for root acceptance. Product base: `b09541c5988ab1c916b753d70c850964637ebaf3`. Sole-writer checkout: `.worktrees/reference-adoption-verify`. No commit, push, deployment, live credentials, or child delegation. The owned manifest is a plain array in `task-C01-integration-owned.json`.

## Delivered production path

- Responses and Messages source serve initialize an owner/API-key-bound codec once using authoritative key ownership and the existing persistent secret API. Responses expands durable history and A14 plaintext summaries before analysis. No stable identity preserves existing raw behavior.
- Authorized catalog candidates remain bounded by existing owner, key mapping, alias, disabled-model and pin policies before affinity ranking. Read-only provider preparation supplies the actual execution target. Exact, explicitly compatible and whole-block degraded candidates rank stably; required state without a representable target returns sanitized 503 before inference. Invalid authenticated state returns 400.
- Gateway request helpers live in `data-plane/shared/affinity-request.ts`, with the dependency-neutral `RequestAffinity` type in `shared/affinity/context.ts`. This differs from the preliminary `shared/affinity/request.ts` location because ESLint forbids shared -> data-plane dependencies. Preparation includes the actual abort signal, source protocol, target API spelling, translated stream flag, selected tier projection, allowlisted inbound headers and authoritative inherited header overrides. Cross Messages traversal now carries the same filtered headers into the actual hub.
- One authenticated source analysis and one request state object flow through translation/hub recursion. Each outer attempt materializes a fresh body; inner attempts are explicitly marked already-materialized. The execution guard fences selected vs actual targets, and only a successful response with the matching actual target authorizes egress signing.
- Custom uses the actual request model. Azure OpenAI uses the URL deployment resolver; Azure Anthropic uses the body model because its path does not carry deployment. Copilot uses its accepted instance-local catalog, existing raw/Fast/context/effort selection, no discovery during preparation, and configuration checks before session preparation, forced refresh and each inference. Existing Codex execution/account guards remain in force. The shared configuration authority validates current enabled state, owner/provider, row incarnation and configuration generation using the authoritative repo, with no secret-derived identity.
- Responses nested `agent_message.content[].encrypted_content` is required, binds agent routing and visible companion content, and does not bind outer array position. Unknown/unprovable targets remove only optional reconstructible whole blocks; required/tool-adjacent unsafe state rejects. Foreign opaque input retains its raw representation.
- Both Responses<->Messages request, JSON-body and SSE translators preserve encrypted/signature/redacted values and complete thinking whitespace. Late Responses signatures keep their original Messages thinking block open until completion rather than reopening a stopped block.
- Source responders asynchronously stamp after reverse translation. Messages buffers thinking/signature fragments, enforces carrier companion/payload limits while accumulating, emits the complete authenticated signature before the sole block stop, and rejects orphan signature deltas. Redacted blocks sign at their complete start. Incomplete raw signatures never escape at ordinary block termination.
- A14-generated plaintext compactions register exact request-local `(id, encrypted_content)` provenance from the compact interceptor. Only those registered generated items avoid native signing. Structural foreign lookalikes cannot acquire that egress exemption. Existing inbound A14 expansion remains unchanged.
- Responses JSON, SSE, bridged JSON/SSE and completion persistence share the source egress adapter. Item-added/created/in-progress frames do not expose incomplete opaque slots. Native opaque items receive one request-local stamped representation reused by terminal output and snapshots.

## Finalized Responses authority and limits

The accepted generic `ResponsesFinalOutput` uses terminal-wins semantics. For an activated affinity request, changing an already emitted opaque item's companion would invalidate its carrier or produce two client representations. The new egress cache therefore freezes the complete first finalized opaque item after its done event. It does not change generic terminal authority for ordinary nonopaque items.

- Cache identity prefers nonempty item ID. A repeated ID reuses the first complete stamped item, including its companion, even when a later done or terminal item conflicts. Distinct IDs keep independent carriers.
- ID-less items use output index. A small closed-index map mirrors duplicate-ID removal and sorted closed-index compaction performed by `ResponsesFinalOutput`; terminal matching uses ID first and the canonical closed position when either side lacks an ID. Tests cover multiple items, duplicate IDs, positional/no-ID and sparse closed indices.
- Terminal-only items are signed at terminal time. JSON reassembly has no prior emitted item, so its canonical final item is signed there. The cache is request-local, retained only for that response, and applies existing per-value carrier bounds. There is no new global output-count or whole-response memory quota.
- Companion and opaque fields are finalized atomically; later conflicting terminal data does not remint an already emitted opaque carrier. The resulting terminal representation is what the existing awaited completion writer persists.

## Focused verification

Final focused command:

```sh
bun test vnext/packages/gateway/tests/affinity \
  vnext/packages/gateway/tests/data-plane/chat-flow/responses \
  vnext/packages/gateway/tests/data-plane/chat-flow/messages \
  vnext/packages/translate/tests \
  vnext/packages/provider-copilot/src/__tests__ vnext/packages/provider-copilot/__tests__ \
  vnext/packages/provider-azure/src/__tests__ vnext/packages/provider-azure/__tests__ \
  vnext/packages/provider-custom/src/__tests__ vnext/packages/provider-custom/__tests__
```

Result: **1,090 pass, 0 fail, 2,898 assertions, 110 files**. Log: `/tmp/c01-integration-focused-final.log`.

Six touched package typechecks passed: gateway, provider-llm, provider-custom, provider-azure, provider-copilot, translate. Gateway typecheck repeated after the final egress adjustment and passed. `git diff --check` passed. ESLint on all touched TypeScript files passed with zero errors and one existing no-useless-assignment warning in `messages-via-responses/request.ts` (the unchanged function-call argument fallback). The final moved helper/egress files also passed targeted lint.

New repository tests exercise actual incoming HTTP + loopback upstream HTTP + real SQLite for all four source/upstream protocol combinations in JSON and SSE. Each checks authenticated output, exact raw replay/whitespace, and wrong-key rejection with zero additional inference. Additional tests cover configuration replacement and 401 refresh fencing, Azure deployment vs body-model identity, Copilot Fast/context/effort preparation, abort/header/flag propagation, unknown-target Claude-shaped candidates, nested agent binding, bounded signature assembly, A14 generated provenance, canonical output identity, and cross-translator late signature assembly.

An expanded regression run initially caught a changed Copilot execution-fetcher factory invocation count during 401 recovery. The factory is now resolved inside each fenced actual transport call, restoring the existing per-attempt observation behavior; its existing test and the complete focused run pass.

Root's mutable app/provider/D1/official-SDK diagnostics were reported passing during implementation. Those are root-owned diagnostics, not frozen acceptance evidence. Root owns independent review, full `ci:local`, fresh frozen app/D1/SDK acceptance and accepted commits.

## Explicit remaining C01 scope

- Owner-configured compatibility producer for Custom/Azure is deferred. Exact execution identity is active; no remote metadata or vendor-name inference grants compatibility. The existing trusted declaration foundation remains available, but this package adds no create/update/import configuration schema for declarations.
- Claude Code does not gain a claimed account/refresh authority in this package. Its unknown target fails safely: required state rejects; optional state projects only when whole-block removal is safe; foreign state retains old behavior. This is a deliberate safety boundary, not full Claude affinity support.
- Chat/Gemini client carrier adapters remain unimplemented. Chat can carry shared request guards as a hub for a source without owned state, but owned Responses/Messages state conservatively excludes the lossy Chat route. No claim of complete four-protocol C01 coverage.
- Required native Responses state cannot cross a lossy Messages/Chat translator. Sdf remains image-only under existing capability filtering.
- No new environment variables, migrations, retention surfaces or plaintext dumps were introduced.


## Integration fix round 1/5 — frozen

Product base remains `b09541c5988ab1c916b753d70c850964637ebaf3`. The full owned manifest remains 36 unique package paths. Root evidence/docs are excluded. Product writes are frozen after this section; no commits, push, deployments or live credentials used.

### Corrections

1. Added `guardAffinityFrames` at the gateway hub-frame entrance, before either source protocol's SSE translator or JSON reassembler. A stable request context activates it even when the codec has not loaded. It bounds Messages signature/companion accumulation and Responses reasoning-summary accumulation, checks finalized opaque byte size, and throws a sanitized invalid-state error on overflow. Async iterator unwinding closes upstream rather than draining for usage. Signature fragments are not decoded individually because base64 validity can change between fragments; the character bound is enforced per fragment, definitely raw UTF-16 values are checked early, and complete values receive exact decoded-byte checks. Companion sizes use UTF-8 JSON bytes. No-context frames pass through unchanged. This is a gateway activation boundary, not a new generic-translator global size policy.
2. Responses-to-Messages reasoning finalization compares the complete summary against already emitted thinking. A safe suffix is appended before signature emission; a conflicting summary throws before any signature, including terminal-only finalization. Tests first reproduced both cases red, then passed.
3. Multi-slot nested agent messages now bind a sorted multiset of SHA-256 digests of original opaque bytes in the canonical companion, under `responses/agent_message/encrypted_content/group-v2`. Replay extracts public original bytes only to build untrusted AAD, then authenticates every owned slot against the whole group. Fresh carrier ciphertext and array indexes do not enter the commitment. A,B -> A,A rejects; exchanging opaque slots remains valid. Legacy single-slot domain/AAD is unchanged and tested. Legacy multi-slot carriers from the prior unaccepted candidate deliberately reject; they are not silently upgraded or accepted as group-bound.
4. Ordinary no-owned requests no longer prepare or translate all candidate bodies, read key secrets, or perform configuration-authority reads. The accepted provider instance supplies a pure immutable `ProviderAffinityAuthority.capture(model)` using the configuration associated with its actual held credentials. Copilot uses the actual accepted variant model; Azure retains URL deployment versus Anthropic body-model semantics. Owned requests still use authoritative preparation and every pre-I/O/refresh fence. Actual response provenance populates the request's actual target, and any selected/previous target must match exactly.
5. Codec/key-owner validation is memoized and lazy until the first signable opaque output; owned markers still load/authenticate before routing. A previously activated identity whose owner lookup or secret initialization fails throws invalid-state rather than falling back to raw. Text-only output requires no key lookup. There is no incomplete-mock bypass: the production lazy behavior naturally restores all six unchanged telemetry tests, so their repository stubs did not need edits.

### Warm-path measurement

The original failing warm fixture with N=2 candidates produced 9 added SELECTs: key ownership (1), affinity secret (1), candidate preparation (2), selected preparation/fences (5). Secret initialization also attempted one conditional UPDATE, outside that fixture's first/all SELECT spy. General observed structure was N+7 SELECTs plus the secret UPDATE and N full request clone/translations. Diagnostic: `/tmp/c01-warm-sql-baseline.log`. After the approved lazy/capture correction, the original unchanged warm test again observes zero pre-inference configuration SQL. Owned replay authority is intentionally not optimized away.

### Verification

- Initial new nested/companion RED: `/tmp/c01-fix1-red.log` (9 pass, 4 fail).
- Full affected regression command from the earlier report, plus unchanged `gateway/tests/integration/warm-dispatch.test.ts` and `messages-telemetry.test.ts`: **1105 pass, 0 fail, 2946 assertions, 112 files**, `/tmp/c01-fix1-final.log`.
- Guard tests cover a 40 x 128 KiB upstream signature sequence stopping before completion and executing source `finally`, including lazy-codec context; raw UTF-16 and UTF-8 companion limits; no-context pass-through. After the final fragment-decoding refinement, egress tests repeated: **9 pass, 25 assertions**, `/tmp/c01-fix1-last-bound.log`.
- Six touched package types passed: gateway, provider-llm, provider-custom, provider-azure, provider-copilot, translate (`/tmp/c01-fix1-types.log`). Gateway types repeated after final changes (`/tmp/c01-fix1-final-types.log`).
- All 36 owned TS files linted: 0 errors, 1 pre-existing no-useless-assignment warning in messages-via-responses/request.ts (`/tmp/c01-fix1-lint.log`). Final changed guard/analysis/test files also linted clean. `git diff --check` passed.

Root owns frozen actual HTTP nested/companion/bounds/lazy-capture reruns, socket cancellation acceptance, independent scoped re-review and full CI. Unit iterator cancellation is verified here; actual socket cancellation is not claimed until root's runtime acceptance. Original deferred scope remains unchanged.


## Integration fix round 2/5 — frozen

Product base remains `b09541c5988ab1c916b753d70c850964637ebaf3`. Full manifest now contains **38 unique package paths**. Added paths are `gateway/tests/affinity/upstream-cancellation.test.ts` and `gateway/src/data-plane/chat-flow/messages/events/reassemble.ts` (both under vnext/packages). No commits, push, deployment, live credentials, or delegation. Product writes stop at this freeze.

### Transport ownership

`fetchAffinityUpstream` wraps the actual provider fetch at Responses, Messages, and Chat hub dispatch. An activated request context gets a dedicated upstream AbortController with a one-way caller link. Only provider.fetch receives this child signal; caller/parser/respond/telemetry retain the original signal. Internal provider refresh/retry stays within that one fetch and therefore receives the same child signal through the existing provider request. Existing provider retry logic retains ownership of discarded retry bodies.

The returned body owns its reader until EOF/error/cancel. Body cancel explicitly aborts the child before cancelling the reader, which reaches the real fetch transport even on Bun runtimes where reader.cancel alone leaves HTTP open. EOF, body error, fetch rejection, empty body, and cancellation detach the caller listener idempotently; pending pull resolution after cancellation does not use a released reader or enqueue into the closed stream. Caller disconnect still aborts the child, while internal rejection never aborts the caller or suppresses the sanitized client error. No-context requests use the exact previous fetch request/signal.

Six focused lifecycle tests cover transport abort before underlying cancel, original caller non-abortion, active caller disconnect, unchanged no-context signal identity, and listener cleanup on all completion/failure paths. Root's mutable actual Bun/independent-Node upstream probes reported socket close at chunk 9/40 in source SSE and JSON; those remain root-owned diagnostics until frozen reruns.

### Protocol field boundaries and explicit SSE response handling

- Guard checks now visit only recognized native Messages blocks and Responses output items at named protocol event/envelope positions. Only native thinking/redacted, reasoning/compaction/program, and direct nested agent opaque slots receive size checks. Arbitrary tool input/result/metadata is never recursively reclassified by property names or embedded type strings.
- The related Responses egress `stripOpaque`/`hasOpaque` helpers now use those same native positions. Business fields are neither deleted nor mistaken for signable state, so ordinary tool output does not initialize affinity secrets.
- Explicit upstream `text/event-stream` selects SSE parsing regardless of source stream preference, followed by the existing source JSON reassembler when needed. Absent an explicit SSE content type, the prior JSON/stream fallback remains. No upstream request stream parameter changes.
- The newly supported SSE-to-JSON path preserves a complete initial tool input when no input deltas arrive. Actual deltas retain precedence. The Messages-to-Responses SSE translator similarly retains initial arguments and emits them before done when no deltas arrive. Messages JSON reassembly now accumulates native thinking/signature deltas onto their initial block fields; the entrance guard still owns bounds and source egress still exclusively owns signing.

### Verification

- Original ordinary-tool guard regression reproduced red: `/tmp/c01-fix2-red.log` (9 pass, 1 fail).
- Expanded affected regression: **1232 pass, 0 fail, 3263 assertions, 131 files**, `/tmp/c01-fix2-final.log`. Command is the prior focused package list plus gateway Chat flow tests and unchanged warm-dispatch/Messages-telemetry integration fixtures.
- Final actual HTTP/SQLite route suite: **22 pass, 146 assertions**, `/tmp/c01-fix2-last-routes.log`. It includes native/cross-protocol SSE and upstream-SSE-to-source-JSON overflow; persisted metrics must be `error`, not `cancelled`; no completed Responses event or carrier escapes. Ordinary initial-only and delta tool data preserve large business `signature`/`encrypted_content`/`fingerprint` values with `affinity_secret` still NULL. JSON thinking tests combine initial and delta text/signature, verify complete companion, and replay the carrier back to the exact raw native signature without a marker upstream.
- Six touched package typechecks passed (`/tmp/c01-fix2-types.log`); gateway and translate repeated after final product changes (`/tmp/c01-fix2-final-types.log`).
- Full 38-file manifest lint: **0 errors, 1 existing no-useless-assignment warning**, `/tmp/c01-fix2-final-lint.log`. `git diff --check` passed.

Root owns final frozen socket/HTTP/SQLite/D1/Codex/SDK acceptance, full CI, and scoped re-review. The fix1 scope deferrals and group-v2 compatibility decision remain unchanged.
