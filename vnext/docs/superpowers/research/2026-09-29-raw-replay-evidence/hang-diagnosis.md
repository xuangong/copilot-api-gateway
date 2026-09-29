# B05 fix2 Bun socket write callback hang

Root's clean verification worktree ran the archived four-case loopback fixture from `vnext/docs/superpowers/research/2026-09-29-raw-replay-evidence/accept.ts`, using `B05_TLS_FIXTURE_DIR` for its self-signed certificate. The first TCP 200 case produced no result for more than one minute; process 2990 used about 99% CPU. Root terminated only that fixture after a one-second `sample` and FD inspection. The fixture's standard output was empty.

An isolated diagnostic copy imported the same verify-worktree product modules and used an external four-second subprocess watchdog. It only intercepted the client `net.Socket.prototype.write` callback to count issued and settled writes; it did not modify product files. A combined phase-and-count run reproduced on attempt 3:

```
PHASE SERVER_HEAD 200
PHASE CLIENT_HEAD 200
PHASE BODY_READ_START
PHASE SERVER_TAIL
CLOSE 175 174
CLOSED 175 174
TIMEOUT 4s
```

The first result row was still absent. A count-only run also reproduced `CLOSE 167 166` then `CLOSED 167 166` before the watchdog. The server had sent the full `early-tail` response and the concrete client socket close promise had settled, but one pending client write callback had not. `response.text()` waits for raw HTTP `finish()`, which waits for `uploadTask`; that task remains on the adapter's unresolved write promise. A fully logged run confirmed the head, tail, and close phases but changed scheduling and completed; this is an intermittent Bun callback race, not a deterministic parser timeout.

The pre-fix adapter at `vnext/apps/platform-bun/src/bun-socket-dial.ts` resolves or rejects a write promise only from the `socket.write` callback. A controlled regression should withhold that callback, close the socket, and require the write promise to reject. A late callback must not settle it twice. A real loopback early-response test should also complete body consumption and release the writer without a watchdog inside product logic.
