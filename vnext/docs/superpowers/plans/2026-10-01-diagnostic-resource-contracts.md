# Diagnostic Resource Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Mark each task complete only after independent specification/quality review and recorded evidence.

**Goal:** Make dump accounting mutation private and bind live-channel resources to actual subscriptions.

**Architecture:** Capture admission and asynchronous retirement have separate capabilities. Broker channel entries exist only while subscriptions are active, with explicit graceful-close and cancellation behavior. Existing diagnostic policy and request outcome owners remain authoritative.

**Tech Stack:** Strict TypeScript, Bun, existing SQLite/file fixtures and Workers dry-run.

**Spec:** [Diagnostic resource contracts](../specs/2026-10-01-diagnostic-resource-contracts.md).

## Global Constraints

- Work in `.worktrees/cfw-resource-rollback-fix` using existing dependencies. No push, deployment, service restart, dependency installation, production access or benchmark.
- Preserve the original 38 main and 14 isolated protected files byte-for-byte and never stage them. Keep the existing Bun fixture alive.
- Preserve wire payloads, capture constants and omission formats, diagnostic storage ordering, native JSON, tool-loop reentry and continuation/completion owners.
- No arbitrary numeric capacity default, deep clone/freeze policy, database migration, retry change or environment variable.
- Follow strict TypeScript: no `any`, suppression directives or new non-null assertions. Source/docs English; user communication Chinese.
- Focused validation during development; one final complete CI on frozen source. Report source mechanisms separately from measured CPU/memory/latency gains.

## Task 1: Encapsulate capture accounting and retirement

**Files:**
- Modify `vnext/packages/gateway/src/shared/dump/capture-budget.ts` and `accumulator.ts`.
- Add source-included type assertions at `vnext/packages/gateway/src/shared/dump/__tests__/capture-contract.test.ts`.
- Update `vnext/packages/gateway/tests/dump-capture-budget.test.ts`; extend `dump-capture-budget.sqlite.test.ts` only when existing phase/owner assertions are insufficient.

**Interfaces:** `DumpCapture` and `DumpCaptureScope` exactly as specified. `DumpCaptureBudget.open(): DumpCaptureScope`. Budget's constructor, limits, retained/available getters remain. Raw `reserve/release`, exported constructible reservation and free `retireDumpCapture` are removed from the external API. Accumulator retains `scope.capture` and invokes `scope.retire(work, preparation)` from its current retirement point.

- [ ] **Observe contract RED.** Put `Assert<T extends true>` type assertions under the normal gateway tsconfig. Check that `reserve`/`release` are not keys of the public budget and `release`/`retire` are not keys of the capture view. Use the old `ReturnType<DumpCaptureBudget['open']>` in initial assertions so failure is assignability, not a missing new export. Add runtime tests proving the public budget/capture lack those operations without private-field access. Run gateway types and the narrow budget test before implementation, preserving expected failures.

```ts
type Assert<T extends true> = T
type NoRawRelease = Assert<"release" extends keyof DumpCaptureBudget ? false : true>
type NoRawReserve = Assert<"reserve" extends keyof DumpCaptureBudget ? false : true>
```

- [ ] **Implement the private owner and separate facade.** Keep projection/accounting arithmetic unchanged. Hide counter mutation at runtime as well as in public types, using module-local capabilities or ECMAScript private state. The facade has only admission methods and facts; no early-release capability. Avoid per-frame closure allocation or redundant projections.

```ts
const scope = budget.open()
const capture = scope.capture
capture.bytes(900)
const retiring = scope.retire(work, preparation)
// Accounting is retained until both bound promises settle.
```

- [ ] **Bind retirement exactly once.** Memoize the first retirement Promise before callbacks can reenter. Observe both operations immediately; retain accounting until both settle, including rejection. Release once; preparation rejection retains precedence over work rejection. Allow admission while pending for the real drain path; reject it after retirement. Repeated retirement returns identical Promise and ignores replacement inputs for ownership purposes.
- [ ] **Migrate accumulator and tests.** Replace the old private field type and free-helper call with separate capture/owner fields, leaving work creation, scheduler registration and phase order intact. Tests use retirement instead of directly releasing counts. Add deferred-work/preparation cases in both settlement orders; rejection cases; repeated retirement; post-retirement admission; live shared-budget recovery. Real accumulator tests must retain pending-preparation/storage charge, exact omission metadata and successful storage/broker ordering.
- [ ] **Run focused verification and self-review.** Run budget unit and SQLite suites, dump exception ownership, terminal handoff and accumulator suites; gateway typecheck, framework purity and scoped lint. Check all14+38 protected hashes, diff checks and exact changed files. No full CI. Commit `refactor(vnext): encapsulate dump capture retirement`; write report with RED/GREEN commands and results.

## Task 2: Own diagnostic channels by subscriptions

**Files:**
- Modify `vnext/packages/gateway/src/shared/runtime/event-target-channel-broker.ts` and document semantics in `channel-broker-contract.ts`.
- Extend `vnext/packages/gateway/tests/event-target-channel-broker.test.ts`.
- Extend `dump-terminal-handoff.test.ts` only if needed to prove storage precedes the now-optional notification encode.

**Interfaces:** Preserve `ChannelBroker<T>` signatures. Use private `ChannelEntry` containing target and active-subscription count (or equivalent explicit ownership). No exported channel registry or production test-only counters. Each eager subscription acquires once, owns one iterator state, and releases once through a common close path.

- [ ] **Observe runtime RED.** Add discriminating cases: publish with no subscribers does not call a counting/throwing codec; already-aborted subscription remains done; buffered cancel returns done with no replay; return resolves an existing pending `next`; repeated cancellation is inert. Use deferred resolutions/short existing timeout guards so failures cannot hang the suite. Run only the broker suite before product changes and retain failures.

```ts
let encoded = 0
const broker = new EventTargetChannelBroker<string>({
  encode(value) { encoded++; return value },
  decode(value) { return value },
})
await broker.publish("unused", "frame")
expect(encoded).toBe(0)
```

- [ ] **Make channel allocation follow subscription ownership.** Publish looks up an active entry and returns before codec invocation when absent. Subscribe creates/acquires eagerly unless already aborted. Every termination releases its entry exactly once; last release deletes only if the map still contains that same entry. Remove the old entry before graceful close notification so reentrant/new subscription cannot be deleted by old cleanup.
- [ ] **Implement explicit subscription termination.** Graceful `closeChannel` detaches and releases while preserving FIFO buffer; cancel by abort/return/throw clears buffered data and resolves a pending read. Return works before first pull, after close, and repeatedly. Throw cancels then rejects with the provided error. Check pre-abort and remove listeners. Return one subscription iterator state; reject a second pending `next` instead of losing the first Promise. Keep normal eager fanout and codec behavior for active recipients.
- [ ] **Cover ownership interactions.** Multiple subscribers: ending one keeps another live; ending the last skips subsequent encoding. Graceful close drains prior frames and then ends; later subscribe receives new frames. Cancellation after graceful close drops its residual queue. Old cleanup cannot affect recreated channel. Confirm listener detachment via observable AbortSignal listener/codec behavior rather than exposing internal size APIs. Keep missing-channel close idempotent.
- [ ] **Run focused verification and self-review.** Broker, control-plane dump, dump terminal handoff and accumulator suites; gateway typecheck, purity and scoped lint. No full CI. Check protected hashes and diff. Commit `fix(vnext): release inactive diagnostic channels`; report precise new no-recipient behavior and remaining live-queue/publication limits.

## Qualification and integration

- [ ] Independently review each task against its interfaces, behavior and preserved ownership.
- [ ] Archive the two source audits, record adopted reference strengths and unselected capacity policies.
- [ ] Complete whole-branch review and resolve findings; freeze non-doc source/config/tests plus protected overlay.
- [ ] Run one final `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` and verify post-CI hashes.
- [ ] Fast-forward local `vNext`; compare both complete manifests, original38/14 files and existing fixture; commit scoped closeout documentation and integrate it locally.
- [ ] Report exact local results and remaining search/publication/live-queue capacity, workerd measurement and rollback gates. No deployment/performance claim.
