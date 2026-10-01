# Task 4 implementation report

Status: DONE. Base: `90624cc2d66bc1dc370f0fb0fbb63376dbea4fb5`. Source commit is recorded below after exact staging. No push/deploy/install/service restart/full CI/worktree cleanup was performed. No agents were spawned.

## Implemented behavior

- Generic `ChannelBroker.subscribe()` behavior and eager decoding remain compatible. Added an explicit bounded broker capability with encoded waiting strings, lazy decoding, one shared iterator/reader, graceful FIFO drain, abort/return discard, finite latched overflow state, synchronous terminal inspection and cancel. Limits: 100 waiting frames / 256 KiB charged strings; each frame 16 KiB; charge `2 * encoded.length + 128`. Overflow detaches and clears immediately, rejects one pending/subsequent read, then stays done. Codec and awaited-read reentry gates prevent canceled/overflowed delivery. No EventTarget callback throws a capacity exception.
- Production streams use a mandatory bounded capability through the dump registry. Generic accumulator-only fakes remain injectable; an unsupported live broker fails closed rather than falling back to generic unlimited subscribe. Legacy URLs use exactly the same queue and permit limits.
- Route admission is synchronous, 4/key and 16/isolate/process, with no waiter queue. Auth precedes admission, and admission precedes subscribe/list. Saturation returns HTTP 429 plus Retry-After 5. Raw abort detaches the subscription immediately but does not retire the route owner while started SQL or writer work remains unsettled. The SSE callback awaits its started writes and `stream.close()` before retiring its permit; returning the Response is not retirement.
- latest-v1 selects newest-fitting rows with per-row limits and a conservative total snapshot charge that includes envelope, omission count and SQL-page cursor. The envelope adds view latest, limit 100, omittedRows, completeHistory false, optional before and hasMore. Root explicitly authorized the final two pagination fields to preserve older navigation when every visible row is omitted. Normal production IDs are ULIDs; arbitrary injected cursor length is charged. If envelope/cursor alone exceeds the total allowance, a safe queue_bytes reconciliation terminal is emitted instead of a broken snapshot. Canonical persisted metadata is never truncated or mutated.
- SQL-time overflow skips snapshot. Overflow during blocked snapshot/append waits for the already-started writer and sends one reconciliation_required control frame on latest-v1 if still writable. Legacy overflow closes without altering legacy event shapes. Delivery gates run after SQL/writes/iterator awaits and immediately before appends. Permanently blocked transport may never receive the terminal; its permit remains occupied until actual writer settlement.
- Dashboard opts into latest-v1 and uses the extracted `DumpLiveSession` lifecycle owner plus pure state reducer in the actual hook. Explicit overflow closes EventSource without automatic reconnect. Refresh latest cancels old page work, closes old source, resets records/cursor and starts a new generation; stale source/page callbacks cannot affect the new view. Ordinary EventSource reconnect remains available with persistent continuity-unknown status. Appends do not clear continuity or omission warnings. Manual older-page browsing remains available, including all-omitted latest snapshots. Persistent scope/status and Refresh latest have English/Chinese labels and a server-rendered affordance test.
- Corrected the bootstrap cross-isolate replay claim. Persistence authority, storage-before-notification, inference, detail and full export semantics remain unchanged. No polling or history-mode/window redesign was added.

## TDD evidence

- Broker RED: `bun test packages/gateway/tests/bounded-channel-broker.test.ts` → 0 pass / 6 fail because `subscribeBounded` did not exist; `task-4-broker-red.log`. GREEN after implementation plus generic regressions: 29 pass / 0 fail; `task-4-broker-green.log`. Additional production exact-boundary and cancellation cases: 9 pass / 0 fail; `task-4-broker-boundaries-green.log`.
- Policy RED: `bun test packages/gateway/tests/dump-live-policy.test.ts` → missing live-policy module; `task-4-policy-red.log`. GREEN is included in route/final focused logs.
- Route RED: `bun test packages/gateway/tests/control-plane-dump-lifetime.test.ts` → 2 pass / 11 fail, including absent 429 admission, overflow terminal absence and timeout at missing capacity owners; `task-4-route-red.log`. The observed fixture was updated to require the bounded route path, so original lifetime cases also failed against generic subscribe. GREEN after route implementation: 24 pass / 0 fail across lifetime/policy/basic route files; `task-4-route-green.log`.
- Dashboard lifecycle RED: missing helper module; `task-4-dashboard-red.log`. Render RED: missing RequestsLiveStatus export; `task-4-render-red.log`. Helper, reducer and render GREEN are included in the final focused suite. Added pagination/cursor edge cases were supplemental GREEN validation of the root-approved contract refinement, not claimed as preimplementation RED.
- The initial pending-reader test harness was corrected to attach a regular rejection observer before publication: Bun's asynchronous expect matcher blocked the triggering publication. No production failure was hidden by this test harness correction.

## Final validation

Executed from `vnext/`:

```sh
bun test packages/gateway/tests/bounded-channel-broker.test.ts packages/gateway/tests/event-target-channel-broker.test.ts packages/gateway/tests/dump-live-policy.test.ts packages/gateway/tests/control-plane-dump-lifetime.test.ts packages/gateway/tests/control-plane-dump.test.ts packages/gateway/tests/control-plane-dump-auth-sqlite.test.ts packages/gateway/tests/dump-accumulator.test.ts packages/gateway/tests/dump-export.test.ts packages/gateway/tests/i18n-keys.test.ts apps/dashboard/src/state/dumps.test.ts apps/dashboard/src/state/dump-live-session.test.ts apps/dashboard/src/tabs/requests/RequestsPanel.test.tsx
```

Result: **128 pass, 0 fail, 733 assertions, 12 files** (`task-4-focused-green.log`). Coverage includes real SQLite session/owner/admin auth and persisted list ordering/retention through latest-v1; real EventTarget and codec behavior; controllable snapshot settlement; blocked snapshot/append serialization; overflow between iterator resolution and route continuation; and **actual Hono TransformStream writer backpressure**, proving aborted route permits stay unavailable until the real write promise settles. Tests use `spyOn` to observe/gate writers and actual SQLite adapters; no mock.module or bun:sqlite mocking.

- `bun run --filter '@vibe-llm/gateway' typecheck` → exit 0 (`task-4-gateway-types.log`).
- `bun run --filter '@vibe-llm/dashboard' typecheck` → exit 0 (`task-4-dashboard-types.log`).
- `bun run scripts/check-framework-purity.ts` → `[framework-purity] OK` (`task-4-purity.log`).
- ESLint on exactly the 19 owned source/test paths in `task-4-files.txt` → exit 0 (`task-4-lint.log`); only the existing resolver multiple-project advisory appeared, no file warnings/errors.
- `git diff --check` → clean. Protection verifier → MAIN 38 / F 14 unchanged (`task-4-protection.log`). Fixture remains PID 90455, start Wed Sep 30 05:16:07 2026, command `bun upstream.ts` (`task-4-fixture.log`).
- Full CI is intentionally reserved for root's reviewed/frozen artifact; no build/deploy qualification or performance claim is made here.

## Owned files and self-review

The authoritative exact source/test inventory is `task-4-files.txt` (19 files). Commit staging must match this list exactly and exclude all root-owned documentation and the 38/14 protected overlays. All changes use existing dependencies; no any, type suppressions, new non-null assertions, migrations or environment variables were introduced.

Self-review found and resolved the all-omitted pagination issue with root's explicit contract ruling, and the oversized cursor must terminate safely rather than silently removing before while suggesting an actionable older page. Snapshot representation accounting now reserves the whole envelope and conservative per-row bookkeeping charges; actual JSON is within the configured total charge. Hono swallows underlying write errors, so stream.aborted and raw abort remain independent delivery gates, while actual promise settlement controls permit retirement.

## Remaining limitations

Browser accumulated older history is still unbounded by design. SQL materialization/JSON encoding transients, transport buffering, full detail/export/decompression and publication/capture concurrency remain outside this increment's charge policies. A saturated permit pool can remain unavailable under noncooperative SQL/writer work. Reconnect or Refresh latest cannot repair arbitrary historical/cross-isolate gaps. Queue_count/queue_bytes/frame_bytes are finite safe notification-capacity reasons; snapshot envelope/cursor exhaustion reuses queue_bytes. Numbers are policy limits, not measured CFW safe production ceilings. Server/client latest-v1 pagination changes must be released together.

## Commit

`d94ec4a831640ac678655b2a517c2d3b965f0857` — `feat(vnext/gateway): bound diagnostic live delivery`. Exactly 19 owned source/test files were staged, matching `task-4-files.txt`. Root documentation and protected overlays were excluded.
