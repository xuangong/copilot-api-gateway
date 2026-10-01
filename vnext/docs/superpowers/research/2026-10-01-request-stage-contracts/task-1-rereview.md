# Task 1 scoped re-review

Reviewed fix: `9b387b4c6c7e6944504dc6e282e3324663b46ed2..717cd86e3a64af063c3f59c1a721c3aa31cf5b35`.
Current HEAD was independently confirmed as `717cd86e3a64af063c3f59c1a721c3aa31cf5b35`.

## Verdict

**Approved. The sole Important / P2 finding is resolved; no remaining issues were found in the scoped fix.** This closes the blocking finding in `task-1-review.md`. Full CI and final integration remain the root controller's responsibility and are not claimed by this re-review.

## Why the correction resolves the finding

At `vnext/packages/chat-flow-kit/src/serve-template.ts:213-218`, module-level `linkInboundAbort` creates the listener in a separate lexical environment containing only its signal and controller parameters. Its listener cannot retain the calling capability's `args`, `context`, or pending runner through the former nested closure environment. At line 234 the capability passes the cancellation objects directly; it does not pass request state or create another capturing callback.

The single-consumption order is unchanged: lines 231-234 check and clear the original runner before linking cancellation. The moved cancellation branch preserves its behavior exactly: missing signals and matching controller signals are skipped, an already-aborted signal forwards the same reason, and a later abort forwards its reason through a once-listener. The link remains effective after the attempt returns, preserving cancellation during streaming response delivery. Preparation still adds no listener and no new early-abort policy was introduced.

The one-file diff adds the helper and replaces the old inline branch with its call. Quota, history, auth, transport, and diagnostic ownership code is unchanged by this correction.

## Independently verified evidence

From the worktree root:

```sh
bun .superpowers/sdd/2026-10-01-request-stage-contracts/task-1-retention-probe.ts
```

| Runtime | Historical base after serve | Fixed head after serve | Fixed head after abort | No-signal head after serve |
| --- | --- | --- | --- | --- |
| Node v26.0.0 / V8 | false | **false** | false | false |
| Bun 1.3.0 | true | **false** | false | false |

Values indicate whether the payload WeakRef still dereferenced after the probe's event-loop-separated GCs. The previous reviewed artifact retained the payload after serve in both runtimes; the fixed artifact releases it while the inbound signal remains live and not aborted. The historical Bun base retains its previously documented behavior. These results reproduce the fix on local V8 and Bun; they do not establish production/workerd retained-byte totals.

From `vnext/`, only the relevant cancellation group was rerun:

```sh
bun test packages/chat-flow-kit/src/serve-template.test.ts --test-name-pattern 'AbortController linking'
```

Result: **9 passed, 0 failed, 29 assertions; 27 unrelated tests filtered out**. This directly verifies between-stage cancellation, no preparation listener, supplied-controller reuse, already-aborted and later reason identity, post-attempt cancellation, and shared controller identity between attempt/respond.

The implementation report's fix appendix additionally records 79 passing kit/turn-barrier/SQLite ownership tests, typecheck, scoped lint, diff checks, and 14 unchanged protected overlay files. Those broader results are implementation-reported evidence, not rerun here. No broad test suite, source mutation, or Git mutation was performed by this re-review.
