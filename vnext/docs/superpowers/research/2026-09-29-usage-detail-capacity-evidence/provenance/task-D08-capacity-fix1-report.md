# D08 capacity repair revision 2 — test lifecycle fix

Status: writer frozen revision 2; runtime released. Only `vnext/apps/platform-cloudflare/src/usage-detail-capacity.d1.test.ts` changed relative to revision 1. All four product SHA-256 values and the three other test files remain byte-identical. Full owned list and current hashes remain in `task-D08-capacity-manifest.json`; scoped revision-1-to-2 diff is `task-D08-capacity-fix1.diff`. Root owns full CI and baseline acceptance.

## Failure and scope

Root's plain full CI exposed a 5001 ms beforeAll hook timeout in this fixture. Revision 1's focused `--timeout 60000` command had masked that default hook budget, so its full-CI compatibility claim was incomplete. The first fix moved setup/assertions/disposal into a single test-owned timeout; a plain single-file run passed (1 test, 2030 expectations). However the exact preceding Miniflare sequence (`responses-websocket`, `setup-leases`, this fixture) still produced a Broken pipe at the third instance's startup and stalled for 60 seconds. See `task-D08-capacity-fix1-neighbor.log`. This observation does not establish a Bun/Miniflare FD root cause.

The final fix runs this same test in an isolated Bun child process, with no additional helper file and no global timeout change. The child executes real workerd migrations, auth HTTP and all assertions, then disposes workerd and removes its fixture directory before emitting `D08_CAPACITY_ASSERTIONS_AND_DISPOSAL_COMPLETE`. The parent checks nonzero exit propagation, captures the assertion output, and requires the completion/disposal marker. Budgets: child test 40 seconds, parent process-group watchdog 50 seconds, parent test 60 seconds. The parent owns a temporary root and kills the dedicated child process group plus removes that root on completion/failure/timeout. Other fixture files and product code are untouched.

The same revision strengthens assertions: every admin detail row now equals the entire normal detail row plus exact ownerId/ownerName; both admin and assigned-only participants now compare complete JSON arrays (all fields, complete rosters, ordering), using the original key-list and assignment iteration SQL to derive the legacy ordering oracle.

## Current validation

All commands from `reference-adoption-verify/vnext` use plain defaults, no `--timeout` override:

- `bun test apps/platform-cloudflare/src/responses-websocket.workerd.test.ts apps/platform-cloudflare/src/setup-leases.d1.test.ts apps/platform-cloudflare/src/usage-detail-capacity.d1.test.ts` — final **20 pass, 0 fail** across 3 outer files; isolated child **1 pass, 0 fail, 2030 expectations**, completion/disposal marker present. Exit 0. Log: `task-D08-capacity-fix1-final-neighbor.log`.
- `bunx tsc --noEmit -p apps/platform-cloudflare/tsconfig.json` — exit 0.
- `bunx eslint apps/platform-cloudflare/src/usage-detail-capacity.d1.test.ts` — exit 0; existing multiple-tsconfig advisory only.
- `git diff --check` — exit 0.
- Final process scan found no workerd/bun-test processes; owned `usage-capacity-process-*` temporary roots were absent.

Fault injection, restored before final verification:

1. Temporarily changed the child's expected complete row count from 1001 to 1002. Child failed its assertion with exit 1; parent failed the exit-code check with exit 1. No completion marker. Log: `task-D08-capacity-fix1-failure-propagation.log`.
2. Temporarily hung immediately after real fixture startup and shortened only the parent's own watchdog from 50 seconds to 5 seconds. Parent failed on timedOut=true after about 5 seconds, terminated the dedicated process group, and removed the temporary root. Follow-up scan found no workerd/test processes and no owned root. Log: `task-D08-capacity-fix1-timeout-propagation.log`.
3. Restored the exact intended source and reran the 3-file sequence, typecheck and lint successfully.

Revision 1's 42-test focused result is historical product regression evidence; it must not be presented as a current whole-suite pass for revision 2. Product hashes are unchanged. This revision's new current result is the affected plain three-file sequence above. Root full CI, independent same-fixture baseline, and final integration remain pending. The previously documented legacy as_user wiring limitation and composed-harness boundary are unchanged.
