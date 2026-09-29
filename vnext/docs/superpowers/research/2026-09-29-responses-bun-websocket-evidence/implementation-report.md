# C12-F3 Bun Responses WebSocket adapter — frozen writer report

Base: `970ac243230186982567517dd8784fd12e2473f2`. Product worktree: `reference-adoption-verify`. Sole product writer: `implement_c12_f3`. Product/test files are frozen at the hashes in `task-C12-F3-frozen-sha256.json`. No commit, push, deployment, live configuration, Workers adapter, capability publication, native upstream WebSocket, migration, or subagent work was performed by this writer.

## Delivered

- `createResponsesWebSocketHandlers({ app })` is a side-effect-free import from `apps/platform-bun/src/responses-websocket.ts`. It returns the exact production `{ fetch, websocket }` callbacks now passed by `server.ts` to `Bun.serve`. Root's actual-client fixture can import the same factory without a test gateway implementation.
- The gateway's `@vibe-llm/gateway/responses-session` export exposes only the F2 authorization/session API, error types, two native limits, and the exact route predicate. The four native paths are `/responses`, `/v1/responses`, `/azure-api.codex/responses`, `/azure-api.codex/v1/responses`; the predicate requires GET plus the complete existing WebSocket header shape. Hono reuses the same header predicate for its existing authenticated 426 fallback. Other methods/routes/incomplete upgrades still use `app.fetch`; the existing `/v1/` HTTP timeout override remains.
- Native fetch authorizes original supported headers through F2 before `server.upgrade`. Known invalid credentials/query credential transport return sanitized HTTP 401/400; configuration unavailability returns 503; unknown failures return sanitized 500. No rejected attempt returns 101. No cookie, query, dev, or DMR auth bypass was added.
- Each accepted socket keeps its own original request headers, private authorization fence, F2 session, and background executor. Native `open`, text/binary `message`, `drain`, and `close` delegate to F2. Bun's `WebSocketHandler` in the installed type/runtime exposes no separate `error` callback: synchronous open/message faults close the session/socket, and transport disconnection is handled by `close`. The F2 close promise bounds cleanup; the native-close guard avoids close recursion.
- `getBufferedAmount()` supplies observable pressure. Native `send` maps positive to accepted, `-1` to already-enqueued/backpressured, and zero/throw to failed; no `-1` retry is made. Native `maxPayloadLength` and `backpressureLimit` are each 1 MiB, with `closeOnBackpressureLimit:false`; F2 remains authoritative for its 5-second drain and 25-second cleanup limits. `idleTimeout:0` explicitly avoids Bun's default 120-second quiet WebSocket timeout. This exact option was accepted by Bun 1.3.0 in loopback tests; a quiet generation exceeding 120 seconds was not timed in writer tests.

## Writer validation

The initial native test failed red because the production callback module did not yet exist. After implementation, final focused command from `vnext/`:

```sh
bun test apps/platform-bun/src/__tests__/responses-websocket.test.ts packages/gateway/tests/data-plane/responses-upgrade-fallback.test.ts packages/gateway/tests/data-plane/chat-flow/responses/session-limits.test.ts
```

**17 pass / 0 fail / 65 assertions.** The new native Bun test uses a real temporary file-backed SQLite gateway and a same-process loopback Bun HTTP/SSE Custom upstream. It checks all four real 101 upgrade paths via raw TCP, missing/invalid auth 401 before upgrade, query credentials 400, compact route 404, warmup created/completed same ID with zero inference, same-socket `input:[]` continuation to the HTTP upstream, external owner disable causing 401 and no second inference, native client CLOSED state, and F2 `{cleanupComplete:true}`. It transparently wraps only the production `open` callback to observe the session cleanup result. It does not claim an independent Node upstream or actual slow-reader pressure.

`bun run --filter '@vibe-llm/platform-bun' typecheck` and `bun run --filter '@vibe-llm/gateway' typecheck`: **PASS**. Touched TypeScript ESLint: **PASS**, with only the inherited multiple-tsconfig advisory. `git diff --check`: **PASS**. All three newly untracked files were separately checked with `git diff --no-index --check /dev/null FILE`: no whitespace diagnostic. No full CI was run by this writer.

Root separately reported mutable production-callback acceptance: 11 native Bun/real SQLite/independent Node upstream groups passed, including failed-turn recovery, abrupt native terminate and provider socket close, max payload/binary, external revocation and HTTP POST preservation; pinned Codex `8ff74cc9` actual gateway two-filter acceptance passed with no fallback. Root and its scratch collaborator also measured native paused-TCP pressure: Bun 1.3.0 returned `-1` as already enqueued, one drain, no retransmission, around 5.0-second pressure timeout, and rapid upstream abort on abrupt close. These are root-reported mutable results, not this writer's frozen independent acceptance. Root owns frozen reruns, review, full CI, and manifest integration.

## Narrow runtime observation

After owner revocation, the new native test received its 401 event, observed client `readyState === CLOSED`, and awaited F2 `session.close()` to `{cleanupComplete:true}`. In two intermediate runs, awaiting Bun 1.3.0 `server.stop(true)` in teardown remained pending until the test's 20-second deadline, even though the socket and session had closed. The final test invokes `server.stop(true)` without awaiting its Promise and catches rejection, matching the independently used native fixture's teardown. This observation isolates the pending native server-stop Promise from F2 cleanup; it is not evidence of a production generation leak. No product close behavior was weakened to pass the test.

F3 changes Bun ingress only. Workers remains on authenticated 426 fallback, and shared capability/config publication remains unchanged pending F4's real Workers adapter and acceptance.
