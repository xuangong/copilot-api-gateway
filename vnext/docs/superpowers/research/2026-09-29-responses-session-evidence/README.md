# Bounded Responses session foundation acceptance

F2 adds a transport-neutral, single-active-turn Responses session using the accepted F1 execution controller. It refreshes authority for every admitted turn, supplies bounded private same-connection continuation, and implements the pinned client's zero-inference warmup shape. Native Bun and Workers adapters and pinned-client gateway acceptance remain F3/F4 work; no WebSocket capability is published here.

Initial review identified an invalid data-plane-to-control-plane auth import. Fix1 moved credential parsing, resolution and validation into one shared implementation with the existing control-plane facade preserved. Two new test lint declarations were corrected. Independent scoped re-review approves both findings; no new Important issue was found.

Final solo `bun run ci:local` exited 0: **4,931 pass / 1 existing skip / 0 fail / 85,061 assertions**. All package types, purity, lint (35 inherited warnings), dashboard build and Workers dry-run passed. The writer's fix1 focused suite passed 538 tests. All **22 final frozen runtime processes passed**, including 20 HTTP/F1/affinity regressions and two new session probes. All 16 product hashes remained unchanged during acceptance. A subsequent precommit whitespace check removed exactly one trailing LF from the new shared-auth file (4,006 to 4,005 bytes); independent byte verification confirms no executable change. Tests were not repeated for that formatting-only correction.

The new session probe covers 11 groups through real temporary SQLite, a second external SQL connection, and an independent Node HTTP/SSE upstream: zero-inference warmup and full create-state recovery, same-connection store:false continuation, cross-connection isolation, durable warmup rejection, translated Chat trailing usage, overlap/malformed preservation, failure recovery, actual upstream socket abort, dropped-send no replay, authenticated opaque-carrier replay, key deletion and disabled-owner rejection. The pressure probe covers six groups, including actual 5-second timeout, high-water inference gating, already-enqueued frame no retransmission, binary-frame abort, cumulative control output (65,520 bytes), and invalid pressure fail-closed. Their session/native-send acceptance and pressure are synthetic; they do not claim native socket behavior.

Run the three sibling `.mjs` files with Bun and `VNEXT_PROBE_ROOT` set to the checkout root. The fixture is a helper imported by the two executable probes. All use synthetic credentials and temporary databases; prior runtime scripts remain in their existing evidence directories. Result JSON records process names and observed assertions.

## Explicit limits and boundaries

- Input/frame/high-water: 1 MiB each; total turn events: 16 MiB.
- Latest private continuation: one slot, 8 MiB, 300,000 ms logical TTL. Expiry is checked on lookup; no idle timer reclamation is claimed.
- Unobservable transport output: 16 MiB over the connection lifetime, including fast readers. Reconnect loses private history and may require full resubmission. No invented Workers pressure or peer acknowledgement.
- Control replies: 64 KiB cumulative; absolute drain deadline: 5,000 ms; cleanup: 25,000 ms.
- Explicit warmup store:true rejects. Zero inference excludes provider generation, not possible discovery/credential preparation network work.
- Successful native enqueue releases admission; one successor waits prior cleanup before fresh authorization. Local publication requires completed outcome and complete cleanup. Failed or ambiguous sends abort without inference replay.
- A noncancellable save may physically complete after cancellation; cleanup timeout does not claim rollback.
- WS requires supported header credentials and current enabled owner. Existing HTTP auth policy remains unchanged; its disabled-owner policy is a separate broad-review observation.

No migration, environment variable, platform adapter, deployment or capability change is part of F2.
