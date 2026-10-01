# Local workerd measurement readiness

Prepared 2026-10-01 by read-only inspection. No runtime, tests, measurements, installation, deployment, network/production access, process manipulation or index mutation was performed. Only this report was written. CFW deployment remains prohibited. Proposed commands below were not executed.

## Exact locations and identities

- F: `/Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix`, locally verified HEAD `648a521eaa6c20a4ce937525e01c87093f46c8f4`.
- W: `F/.superpowers/sdd/2026-10-01-resource-capacity-policy`.
- P: `F/.superpowers/sdd/2026-09-30-cfw-request-boundaries`.
- Existing runner/support: `P/harness/run.ts`, `entry.mjs.template`, `inspector.ts`, `dump-readback.ts`, `upstream-fixture.ts`, `oracle.ts`.
- Prior specification: `F/vnext/docs/superpowers/plans/2026-09-30-cfw-request-boundaries.md`; closeout: `P/task-4-measurement-report.md`; harness contract: `P/task-4-harness-report.md`.
- Exact deployed-source tag, verified locally: `vnext-deployed-20260928-233856^{commit}` = `e660fb4dfcf1734d10f89e52e2d739b2985c634b`.
- Reusable deployed-source checkout: `/Volumes/Projects/copilot-api-gateway-cfw-validation-20260930-001627/baseline`. HEAD matches the tag, and `git status --porcelain --untracked-files=normal` was empty. Ignored generated assets/dependencies exist and are not covered by that clean status.
- Existing deployed-source local wrappers/configuration: `F/.superpowers/sdd/2026-09-30-cfw-p0-resource-rollback-fixes/L/a/entry.ts`, `wrangler.json`, and `L/manifest.json`. Reuse these as schema/bootstrap provenance, not as a fresh result or as the corrected runner: they have fixed ports, fixture reset routes and different observation logic.
- Existing old/new request-boundary bundles: `P/before/bundle/worker.mjs` SHA256 `8f64f80c6f1aeca1678334b1074cd313644d3da42b09c39d17c3162e7396309c`; `P/after/bundle/worker.mjs` recorded SHA256 `a41ab4928a797ffd2e37e5f6c55c6aca58b8344ca11494779331176401ad1a6e`. These hashes were taken from historical freeze/disposition records, not recomputed here.

The request-boundary before bundle is a **repair checkpoint**, HEAD `54f1a4e43ea3bedebff16b362c3378a6cf841c80`, with collaboration overlay, per `P/before/freeze-success.json`. It is not deployed A. Its after bundle predates the new capacity-policy increment. Preserve both for reproducing that isolated increment; do not call either the current candidate or deployed baseline. A combined final measurement needs deployed A versus a newly frozen final candidate. Optionally retain the repair pair as a separately named experiment.

## Failure evidence and why repeating unchanged is insufficient

`P/final-measurement-04.log:545` reports `workerd/server/server.c++:6126 ... miniposix::write ... Broken pipe; fd = 3` during after/matrix initialization. `final-measurement-04-disposition.json` records 358 artifact-confirmed logical requests and `completed=false`.

`P/final-measurement-05.log:863-864` records the after/diagnostic phase followed by the same broken pipe. `final-measurement-05-disposition.json`, `final-measurement-05-deadline-evidence.json` and `task-4-measurement-report.md` establish an outer 120-second deadline, zero diagnostic requests and `completed=false`. Both subprocess exit codes are zero after interruption; exit zero is explicitly not success evidence. Historical cleanup receipts record only owned runners/children gone and fixture PID 90455 preserved; no live process observation was made here.

Final-05 independently confirms 508 requests: latency 104 per variant, matrix 150 per variant; 1,524 owned R2 objects, four dispatch readbacks and 22 settlement receipts. The intended 716 requests were 144 warmups + 160 latency + 252 matrix + 160 diagnostic. Missing diagnostic work is 208 requests. Evidence remains at `P/runs/final-04` and `P/runs/final-05`; do not reuse their state for a fresh measurement or pool them with a retry.

The failure is localized to initialization, not established as a product request failure or a proven workerd root cause. In `run.ts:139-181`, creation, `getD1Database`, migration/seed, and `mf.ready` are not individually bounded. `gateway` catch awaits `mf.dispose()` without a cleanup bound; the request timeouts therefore cannot protect initialization or disposal. All runtime phases share the same Bun process (`run.ts:362-366`). The latency pair deliberately coexists for ABBA; matrix/diagnostic instances are created later.

`request()` pushes success and failure rows only to `allRows` (`run.ts:273-278`). `requests.jsonl` and final summary are written only at `run.ts:376-377`, after all phases/cleanup. Thus completed timing samples disappeared with the stalled process. Existing readbacks are evidence of storage/dispatch work, not a reconstruction of EOF/first-semantic timings or the original wire oracle. The final aggregate also lacks a strict expected-count completion gate; add one rather than relying on exit code and an emitted summary alone.

Inspector commands have ten-second deadlines, but `mf.getInspectorURL()` and WebSocket open in `inspector.ts:10-20` are unbounded. Target lookup falls back to the first target; corrected qualification should require the exact gateway target. These are additional readiness defects, although final-05 stalled before attachment.

## Smallest reliable runner correction for the later batch

Preserve the original harness and all evidence. Put a separately reviewed revision in `W/measurement/harness`, with explicit roots/imports: copying the old files verbatim changes `PLAN`, relative dependency imports, before receipt lookup and bundle/output restrictions. Do not silently point a copied harness back at P or bypass its frozen hashes.

1. Make bundle paths and per-variant migration roots manifest inputs. Hash bundles, source inventories, migrations, wrapper, fixture/oracle/reader, dependencies and experiment specification before offering work. Refuse source drift or overwritten output directories. Retain exact current protected overlays in the candidate freeze.
2. Add stage events and independent watchdogs for construction/ready, D1 binding, each migration/seed stage, Inspector URL/HTTP discovery/WebSocket open, settlement/readback and disposal. Persist stage begin/end/failure timestamps. A parent supervisor must terminate only its owned child process group if initialization/disposal hangs; `Promise.race` alone leaves a live runtime behind. Use an external whole-child deadline as final containment, rather than another blanket 120 seconds for the whole batch.
3. Use fresh Bun children for five units: one latency-pair unit retaining both warmed variants and ABBA order; before matrix; after matrix; after diagnostic; before diagnostic. Each has new persistence and loopback fixture ports. This isolates repeated runtime creation while preserving timing design and the existing 716-offer shape. If even the pair cannot initialize, qualify that separately before changing timing design. Do not retry silently; failure gets its own output and identity.
4. Write a per-request `offered` record with globally unique experiment/unit/variant ID before fetch; capture terminal success/failure Row after EOF/oracle (including timeout/parse failures) and append **outside** the timed EOF interval before another request. Use an open append-only JSONL descriptor and fsync completion rows, plus durable phase/block checkpoints. Distinguish offered-but-unfinished from completed, semantic failure and transport failure. Never rewrite this journal at finalization. Preserve CPU profile and heap records immediately after each diagnostic mode.
5. Persist child `completed=false` as the initial disposition. Atomically set true only after exact counts, wire oracle, baseline-matched regressions, dispatch exactly-once, complete EOF/upstream bodies, settled background work, physical readback and successful bounded cleanup all pass. Supervisor exit success additionally requires every child receipt and a final aggregate. Incomplete journal lines can be detected/truncated only in an analysis copy; originals remain untouched. Recovery computes partial metrics only from durable rows and labels them partial; it must not turn a terminated experiment into a qualifying batch.
6. Journal filesystem work is outside individual latency intervals but contributes host scheduling and may enter a diagnostic sampling window while workerd is idle. Keep it equal across A/B, report it, and do not label the sampled non-idle total as exact request CPU. Keep profiles separate from ordinary timing instances, no forced GC or heap snapshots.

This is a runner-only proposal; no product optimization, removal of cancellation/persistence, retention change or runtime upgrade is necessary to implement the readiness correction. It reduces exposure to the observed stall and preserves data; it does not establish or claim to fix the underlying broken pipe.

## Baseline overlays, schema and reader compatibility

The deployed snapshot commit already includes the historical uncommitted collaboration/encrypted-block fixes, according to `/Volumes/Projects/copilot-api-gateway/vnext/docs/superpowers/plans/2026-09-30-cfw-measurement-and-rollback.md:15`. Do not add today's collaboration patch to deployed A: that changes the historical baseline.

Candidate freeze must include the protected modifications/untracked shim captured by `W/baseline.json`, plus the final authorized capacity-policy changes. Freeze actual working-tree bytes, not HEAD alone. Existing snapshot helper `P/snapshot-inputs.py` is a useful pattern but unions an old manifest and old task file list; extend the inventory to include all new capacity-policy and protected untracked inputs before reuse.

Ignored build inputs recorded in the historical source manifest include:

- `vnext/packages/gateway/src/control-plane/setup/dist/runner.mjs`, `runner.mjs.txt`, `runner.sha256.txt`, `setup.ps1.txt`, `setup.sh.txt`.
- `vnext/packages/gateway/src/shared/edge/assets/favicon.png.txt`.
- `vnext/packages/gateway/src/shared/edge/ui-pages/dashboard-app/dist/dashboard.css`, `.css.txt`, `dashboard.js`, `.js.txt`.

Reuse already present generated inputs, inventory/hash them, and record any unavoidable import-only overlay; do not rebuild an unrelated dashboard or install dependencies. The existing baseline platform `dist` also contains dashboard/favicons and worker artifacts; they are not automatically a matched Bun bundle. Build new matched bundles from each frozen source with the same options/runtime, keeping assets provenance explicit.

The current readback is not deployed-A compatible as written: `dump-readback.ts:72` selects `upstream_exchanges_descriptor`, absent from deployed `baseline/vnext/packages/gateway/migrations/0001_baseline.sql:60-71`. It also requires a version-1 upstream sidecar and three owned files per request. Use explicit reader adapters: deployed legacy request/response descriptor validation and owned-file checks for A; current request/response/upstream envelope validation for B. Do not manufacture A's missing sidecar or demand identical object counts. Match independently observed wire semantics, dispatch and original request/response bytes; record capture-format/storage-work differences. Qualify inherited refusal/status mappings independently for deployed A instead of copying the repair-pair exemption by assumption.

Primary local code comparison should seed A with baseline migrations and B with final candidate migrations and equal logical fixtures. Old A against migrated B schema is a separate rollback-compatibility experiment, not a shortcut for this comparison. Numeric `dump_retention_seconds=0` enables writer work; `responses_retention_seconds=0` disables retained response history in the previous request-boundary fixture. Preserve that explicit fixture unless a separately specified retained-history experiment is intended. Do not describe zero as disabled dump capture or guaranteed unlimited API visibility.

## Later commands and qualification sequence

Read-only identity commands available now (already executed in this investigation):

```sh
git -C /Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix rev-parse HEAD
git -C /Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix rev-parse 'vnext-deployed-20260928-233856^{commit}'
git -C /Volumes/Projects/copilot-api-gateway-cfw-validation-20260930-001627/baseline rev-parse HEAD
git -C /Volumes/Projects/copilot-api-gateway-cfw-validation-20260930-001627/baseline status --porcelain --untracked-files=normal
```

After final source review/required CI and authorization for local measurement, first freeze inventories and build the candidate from F into a fresh W artifact directory, using the proven Bun build option shape:

```sh
cd /Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix/vnext
bun build apps/platform-cloudflare/src/worker.ts --target=node --external=cloudflare:sockets --outdir=../.superpowers/sdd/2026-10-01-resource-capacity-policy/measurement/candidate/bundle --entry-naming=worker.mjs --sourcemap=external
```

Freeze and build deployed A from the existing baseline checkout using the same options, with a new absolute `--outdir` under `W/measurement/deployed-baseline/bundle`. Reverify all source/input hashes after builds. No checkout, worktree copy, package installation or index operation is required. The candidate hash is necessarily unknown until implementation is frozen.

Existing guarded command syntax, useful only for inspecting/reproducing the old repair-pair experiment:

```sh
cd /Volumes/Projects/copilot-api-gateway/.worktrees/cfw-resource-rollback-fix
bun .superpowers/sdd/2026-09-30-cfw-request-boundaries/harness/run.ts --check
```

Do not launch old `--run-ready` again unchanged. The new supervisor/unit CLI does not exist yet; its eventual reviewed invocation must identify the manifest, new output directory, count 40, selected unit and explicit runtime authorization. First qualify bounded start/stop and durable failure journaling in a minimal isolated local trial, then the five-unit comparison. Qualification adds its own separately counted offers; it must not be merged into the 716 comparison. The aggregate must accept only the declared manifest and unit receipts. Keeping separate units with shared immutable identity is one combined experiment, not pooling unrelated retries.

## What the next local batch can and cannot establish

| Observation | Valid local comparison | Limit |
| --- | --- | --- |
| Host client EOF, first-semantic output, ABBA block medians/p50/p95 | Same synthetic direct-fetch fixture, payload, runtime and paired design | Includes host scheduling, IPC, loopback upstream and local storage effects; not real-provider or cloud latency |
| V8 sampling profile, sampled non-idle time/request | Matched diagnostic isolates including registered background settlement | Not billed CPU, process CPU or exact per-request CPU; host client/upstream and service D1 work are outside gateway isolate profile |
| Settled `Runtime.getHeapUsage` before/after mode | Same observation points with equal warmup/history and no forced GC | Not peak memory, workerd RSS, shared-isolate cloud memory quantiles, leak proof or Cloudflare capacity limit |
| Semantic matrix, physical D1/KV/R2 readback, upstream exactly-once | Legacy/current format adapters with independent wire observation | Partial phase receipts alone do not prove full regression acceptance; local emulator is not cloud D1/R2 |
| Capacity admission/overflow policies | Separately declared edge cases can test intended rejection and cleanup behavior | The ordinary 716-request workload does not itself cross every hosted-search/reentry/diagnostic queue bound |

Keep prior cloud CPU/memory ledgers as historical context, with their timestamps and identities; do not append local samples to those distributions or use them to declare CFW resource parity. No cloud metric refresh or deployment is needed or authorized here. New WebSocket functionality and diagnostics lack an equivalent deployed ingress; test their native correctness/limits separately rather than presenting an A/B speedup.

Readiness verdict: reusable fixtures, observation wrapper, independent readbacks, source snapshots and deployed baseline exist. Execution is not ready until runner phase/process isolation, durable request journal, strict completion accounting, deployed-A schema/reader adapters and final candidate freeze are implemented and reviewed. This report supplies preparation evidence only.
