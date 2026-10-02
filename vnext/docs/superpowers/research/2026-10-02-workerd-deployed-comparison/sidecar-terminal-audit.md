# B native sidecar terminal contract for the declared fixture

Prepared 2026-10-02 by focused read-only source inspection in F. No runtime, canary, tests, installs, network access or source/index changes were performed. Only this report was written. Exact runtime race outcomes remain unmeasured.

F = `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`; W = `F/.superpowers/sdd/2026-10-02-workerd-deployed-comparison`.
Paths below are relative to `F/vnext`, except the fixture reference to P.

## Conclusion

For the ordinary hot request (Responses ingress, Responses upstream, scenario ok), require full observed response bytes, full totalBytes and terminal=eof for JSON and SSE.

Do not impose terminal=eof/full totalBytes on every matrix cell. Two narrowly identifiable SSE groups can correctly finish with terminal=cancelled and totalBytes=null even after the sidecar observed the entire fixture response body:

1. Upstream Chat, scenarios ok/tool/refusal/slow, all three ingress protocols, stream=true: the protocol parser returns after [DONE].
2. Upstream Responses/Chat/Messages, scenario failed, all three ingress protocols, stream=true: explicit failure handling returns or throws before guaranteed byte EOF.

The existing performance wrapper can prefetch byte EOF before parser cancellation, so either eof or cancelled can occur in these groups. Source proves the cancellation path and the representation rule; it does not prove the exact winner for each workerd/loopback offer. Require canary evidence before finalizing per-cell terminal expectations. Keep full byte/digest checks in both representations; a blanket observedBytes <= fixture bytes remains inadequate.

## What terminal actually certifies

`packages/gateway/src/shared/dump/upstream-dial-adapter.ts:55–69` wraps the provider Response body with the collector's demand-driven observer. It neither tees nor independently drains the upstream body.

`packages/gateway/src/shared/dump/upstream-attempts.ts:308–358`:

- The observer has highWaterMark=0.
- Only an actual reader.read() result with done=true records responseTotal=observedBytes and terminal=eof (338–342).
- A cancel marks cancelled, then cancels the underlying reader (351–356).
- A pending read resolving done because of cancellation is explicitly excluded from EOF/total inference (335–337).
- First terminal wins; later cancel cannot replace eof (367–370).

Persistence validation is already stricter than the old harness reader: for response terminal=eof, totalBytes must equal observedBytes; for every non-eof terminal, totalBytes must be null (`upstream-attempts.ts:506–530`). A cancelled object with totalBytes=full fixture bytes is invalid even when observedBytes is full. A cancelled object's total=null means “EOF not observed,” not “observed body bytes are necessarily incomplete.”

The independent fixture's finish receipt proves host-side response completion. It does not prove that the gateway's byte consumer asked for the extra done=true read after its final protocol frame.

## Exact declared groups and expected representations

This table is keyed by the actual upstream protocol/response content type. The fixture's explicit JSON/SSE stream flag is preserved by all six request translators (`translate/src/*/request.ts` assigns stream=payload.stream ?? true).

| Cell group | Ingress | Upstream | Scenario | Host requested mode | Source-supported contract |
| --- | --- | --- | --- | --- | --- |
| Ordinary latency/diagnostic/warmup hot cell | Responses | Responses | ok | JSON or SSE | eof; observedBytes=totalBytes=full fixture response bytes |
| All matrix JSON | Any of the three | Any of the three | All seven | JSON | eof/full bytes, including upstream 502 and 503 envelopes |
| Matrix upstream HTTP error | Any | Any | http503 | SSE requested, upstream JSON 503 returned | eof/full bytes |
| Successful Responses/Message upstream SSE | Any | Responses or Messages | ok, tool, refusal, slow | SSE | eof/full bytes |
| Chat sentinel termination | Any | Chat | ok, tool, refusal, slow | SSE | eof/full bytes OR cancelled/full observed bytes/totalBytes=null; qualify exact winner by canary |
| Explicit failure termination | Any | Any | failed | SSE | eof/full bytes OR cancelled/full observed bytes/totalBytes=null; qualify exact winner by canary |
| Synthetically truncated stream with normal byte EOF | Any | Any | truncated | SSE | eof/full bytes; missing semantic terminal remains a wire failure, distinct from byte EOF |

“Full bytes” above means the actual independent fixture response body length, including SSE framing, not the host gateway wire response length. For the fixed fixture, the complete response is below the 262,144-byte sidecar cap; require capturedBytes=observedBytes=fixture responseBytes and matching complete response prefix digest. Keep request capture checks separately: its 65,536-byte prefix cap intentionally truncates prepared upstream JSON requests.

Unexpected read_error/fetch_error/not_consumed, partial observed bytes or missing sidecar do not qualify as ordinary complete capture. Do not accept them just because product client semantics can survive optional sidecar failures. If a canary exhibits another terminal/partial count, preserve its evidence and investigate that exact cell; do not auto-expand the allowed contract.

## Why each group differs

### JSON and upstream HTTP errors consume physical EOF

- Native Responses JSON: `gateway/src/data-plane/chat-flow/responses/attempt.ts:168–172,474–483` awaits new Response(body).text() before synthesizing protocol frames.
- Native Chat JSON: `chat-completions/attempt.ts:94–98,237–243` fully reads text before constructing frames.
- Native Messages JSON: `messages/attempt.ts:173–177,433–445` does the same.
- Any upstream non-2xx: `protocols-llm/src/common/result.ts:216–224` consumes response.arrayBuffer(); the attempt's error branch invokes that helper, including SSE-requested http503.
- Cross-protocol traversal uses the actual hub attempt, so these rules are about the upstream producer, independently of ingress rendering.

Thus a translated JSON policy refusal can trigger a later failed canonical outcome/abort while native sidecar EOF has already been observed. Its HTTP/dump status difference does not justify a cancelled native sidecar.

### Successful Responses/Messages SSE drains before terminal exposure

`gateway/src/data-plane/chat-flow/shared/upstream-telemetry.ts:33–47` classifies response.completed/incomplete and message_stop as successful terminals. The wrapper retains that successful frame, starts bounded tail observation, keeps consuming iterator.next(), and exposes the successful terminal only after the iterator ends (111–153).

The Responses fixture emits no [DONE] sentinel, and its parser continues through response.completed rather than returning there (`protocols-llm/src/responses/stream.ts:67–105`). The Messages parser likewise continues beyond message_stop unless it sees [DONE] (`protocols-llm/src/messages/stream.ts:15–24`). The fixture does not send [DONE] for Messages. Consequently, success reaches parseSSEStream's actual byte EOF before the semantic terminal is forwarded.

This includes Responses ingress/Message upstream refusal SSE: native Messages message_stop is first drained to EOF; only afterward does the translator produce policy response.failed. `responses/turn.ts:478–479` aborts a failed canonical outcome, but cannot overwrite an already-recorded native eof.

### Chat [DONE] ends its parser before guaranteed byte EOF

`packages/result/src/parse-events.ts:16–21` turns the sentinel into a done frame. `protocols-llm/src/chat/stream.ts:20–22` yields doneFrame then returns. Its nested parser closes, triggering `result/src/parse-sse.ts:91–98`, which calls reader.cancel() when the parser returns before physical EOF.

`upstream-telemetry.ts` does attempt to continue its iterator after the success terminal, but it is continuing the already-terminated Chat parser, not independently draining the byte body. `translate-stream.ts:43–60` also drains/cleans the protocol iterator, not the byte body directly. These mechanisms preserve trailing usage, but do not convert [DONE] into a certified byte EOF.

The sentinel is the final body frame for ok/tool/refusal/slow in `P/harness/upstream-fixture.ts:55–58,69–74`. Parsing its closing blank line requires observing its complete byte framing, so a cancelled sidecar can nevertheless contain the complete fixture body.

### Failed SSE returns before guaranteed byte EOF

For native Responses failed, `upstream-telemetry.ts:123–129` yields the failed frame and returns rather than draining the success tail. Native Messages error follows the same path. Native Chat error is thrown by `protocols-llm/src/chat/stream.ts:24–25`; telemetry calls onFailure/cleanup (`upstream-telemetry.ts:154–167`).

Cross-protocol translateStream also yields error/response.failed and returns immediately (`translate-stream.ts:32–34`), then closes the owned iterators (58–60). Responses turn aborts failed outcomes and closes raw/source iterators (`responses/turn.ts:343–346,478–479`). parseSSEStream cancellation propagates to the sidecar.

The fixture's failed scenario replaces finish frames with exactly one final explicit error/failure frame (`P/harness/upstream-fixture.ts:64`), then closes. Processing that complete final frame can provide all body bytes before cancellation. There are no remaining ordinary success frames whose omission should be waived.

### Truncated is semantic incompleteness with normal physical EOF

The fixture merely removes finish frames (`P/harness/upstream-fixture.ts:63`) and normally closes its byte stream after prefix delivery (69–74). The parser therefore reaches done=true before telemetry diagnoses the missing semantic terminal (`upstream-telemetry.ts:147–157`). The collector's sticky eof cannot be overwritten by the subsequent abort/cancel. No blanket cancelled exception is supported for the declared truncated fixture.

## Why source cannot fix the exact allowed winner without a canary

`gateway/src/data-plane/chat-flow/shared/performance-upstream.ts:22–32` inserts another ReadableStream wrapper without a highWaterMark override. That wrapper can prefetch another read from the sidecar while a parser processes its just-delivered final frame. Whether it observes EOF first depends on body chunking, network close scheduling and runtime streams.

Therefore code references justify narrowly allowing the cancelled representation in the two named groups, but not declaring every one must be cancelled or must be eof. The canary should include the ordinary Responses JSON/SSE hot cells plus Chat SSE success and failed SSE for each actual producer; record full fixture response digest/finish, complete host gateway EOF, sidecar terminal/observed/total/captured values and cleanup receipts. Keep qualification offers outside the 716 comparison. If evidence establishes a stable stricter cell contract, freeze that in the manifest before the full experiment; otherwise allow only the explicitly named representation pair while preserving full byte verification.
