# Diagnostic resource ownership contracts

## Intent and scope

Continue the accepted architecture work at `f6797d50a797a2633d60128593861349038f0300`. Strengthen existing resource contracts before selecting new capacity policy. Reuse the current isolated worktree and preserve the collaboration overlay. The previous batch completed hosted-tool private-state lifetime, preparation and producer contracts.

Two demonstrated gaps fit this increment: dump budget callers can directly change environment accounting through public raw methods, and the in-process diagnostic broker retains channel entries created by publications without subscribers. The former is an unsafe API capability, not a verified production misuse. The latter also encodes notifications with no recipients on the ordinary dump path. Both Bun and CFW use this broker; each process/isolate still has independent live delivery.

The reference checkout `1d7dcd923e260e425120cca0c7a240e93720af27` remains useful for explicit phase ownership and narrow dependency contracts. Its private scratchpad and live delivery do not provide a numeric capacity policy suitable for this gateway. Do not copy its payload cloning or change accepted search fanout merely to obtain a limit.

## Capture accounting authority

`DumpCaptureBudget` retains its existing constructor, readonly limits and read-only retained/available counters. Its raw reserve/release operations are module-private capabilities, unavailable through the public budget object. A caller cannot construct a reservation with an arbitrary accounting owner.

`open()` returns an owner scope with two distinct capabilities:

```ts
interface DumpCapture {
  readonly reason: DumpCaptureOmission | undefined
  readonly invalidJson: boolean
  bytes(bytes: number): boolean
  graph(value: unknown): boolean
  project<T>(value: T): { value: T } | undefined
  frame<T>(value: T): { value: T } | undefined
}
interface DumpCaptureScope {
  readonly capture: DumpCapture
  retire(work: Promise<void>, preparation: Promise<void>): Promise<void>
}
```

The capture facade exposes admission and omission facts only. It has no raw counter adjustment, release or retirement operation. The scope owner can choose retirement, but cannot directly release an arbitrary count. The first retirement call binds the original terminal work and request preparation; subsequent calls return the same retirement Promise and never release twice. Callers still select terminal work before starting it; passing a Promise cannot undo work already started by a caller.

Retirement waits for both bound operations to settle, including when terminal work or preparation rejects. Accounting remains charged until both settle and is released exactly once afterward. Preserve the previous helper's error precedence: a preparation rejection takes precedence over a terminal rejection; otherwise return the terminal outcome. Attach rejection handling when retirement is selected. No second request completion owner is introduced.

Capture remains usable while retirement is pending, because the existing asynchronous response drain still performs admission. Once retirement completes, admission refuses further values and cannot reacquire accounting. Omission reasons remain monotonic. Keep current limits (4 MiB per capture, 16 MiB per environment, 8,192 frames), projection/serialization behavior and metadata-only omission unchanged. Do not add per-frame wrappers, a queue, payload copying or new policy values.

`DumpAccumulator` owns the scope and keeps the separate capture view for its existing admission sites. Migrate its retirement helper to the owner scope. Its preparation, drain, storage and broker order remains intact; storage/publication failure stays diagnostic-only. The legacy exported raw reservation class and free retirement helper are internal repository APIs with no callers outside the inventoried module/tests; remove those public capabilities instead of adding compatibility escape hatches.

## Subscription-owned live channels

Keep `ChannelBroker`'s public publish/subscribe/close shape and eager subscription registration. The broker's Map contains only channels with active subscriptions. Each subscription acquires one reference and releases it once on abort, iterator return/throw or channel close. The last release removes the matching channel entry; identity checks prevent an old subscription from deleting a newly created channel with the same ID.

`publish` first checks for an active channel. With no recipients, it resolves without creating a channel or calling the codec. This is a deliberate contract: encoding validates a notification for delivery, not every persisted diagnostic record. With recipients, encoding/decoding and fanout remain unchanged. Persistence precedes publication as before; reconnect/list reconciliation remains the source of history.

Distinguish termination intent:

- Channel close stops new delivery, releases listeners and channel ownership, and preserves already-buffered FIFO frames for the subscriber to drain before `done`.
- Abort, iterator return and iterator throw cancel consumption: clear buffered frames, detach listeners, resolve a pending read with `done`, and release ownership. `throw` then rejects with the supplied error. This also works before the first pull and with an already-aborted signal.
- Repeated termination is idempotent. Cancellation after graceful close can discard the remaining buffer. Resubscription after close gets a fresh channel that old cleanup cannot delete.

Document sequential single-consumer iteration. Do not introduce a new unbounded waiter queue or silently overwrite a pending read: reject a second concurrent pending `next()` explicitly while preserving the first. Repeated retrieval of the subscription's iterator must share its one consumer state. Pending reads, not only a later `next()`, must settle on cancellation.

This closes inactive-channel and signaled-subscription lifetimes. It does not bound an active slow subscriber's queue, guarantee cross-isolate delivery, introduce a replay log, or change live overflow/reconciliation policy. Those remain separate capacity decisions.

## Validation and integration

Use source-included type assertions to reject raw accounting mutations and capture release authority. Observe meaningful type/runtime RED before implementation, then run focused tests covering shared accounting, omission, phase settlement and actual accumulator/store behavior. Broker tests must discriminate no-recipient encoding, eager delivery, multiple subscribers, graceful draining, canceled buffer disposal, pending-read termination, pre-abort and channel recreation.

Independently review both tasks and their combined change. Freeze final non-doc source/config/tests plus the protected overlay, then run one complete `ci:local`. After success, fast-forward local `vNext`, compare both complete source manifests and all original protected files, and commit the qualification/plan updates. Preserve the existing fixture and evidence.

## Global constraints

- Work in `.worktrees/cfw-resource-rollback-fix` using existing dependencies. No push, deployment, service restart, dependency installation, production access or benchmark.
- Preserve the original 38 main and 14 isolated protected files byte-for-byte and never stage them. Keep the existing Bun fixture alive.
- Preserve wire payloads, capture constants and omission formats, diagnostic storage ordering, native JSON, tool-loop reentry and continuation/completion owners.
- No arbitrary numeric capacity default, deep clone/freeze policy, database migration, retry change or environment variable.
- Follow strict TypeScript: no `any`, suppression directives or new non-null assertions. Source/docs English; user communication Chinese.
- Focused validation during development; one final complete CI on frozen source. Report source mechanisms separately from measured CPU/memory/latency gains.

## Remaining capacity work

Search admission must run before expanding and starting a batched plan. A terminal private-store check alone cannot prevent already-started provider work. Do not evict replay data still required by an active loop. An endlessly repeatable refusal slot also does not bound a response; a request-level limit needs a defined terminal failure through the existing owner. Numeric operation/byte budgets need representative workload evidence.

Diagnostic publication count and active-subscriber byte/item budgets remain open. A payload byte budget does not bound metadata-only publication tasks, and `waitUntil` does not remove their CPU/memory cost. Any future queue or drop policy must expose omission/reconciliation rather than silently lose audit visibility. Local workerd resource comparison and catalog/affinity rollback compatibility remain release gates.
