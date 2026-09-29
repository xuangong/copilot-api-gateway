# D02 activated route capture evidence

The route package explicitly carries the opted-in request dump through provider selection, protocol translation, reentrant execution and non-chat endpoints. Discovery, OAuth and other nonterminal provider HTTP calls keep ordinary egress. The frozen candidate passed the actual local workerd runtime gate. Independent spec and quality review passed with no blocking findings. Clean `bun run ci:local` passed with 4,364 tests passed, 1 skipped and 0 failed; purity, workspace types, lint, UI build and Workers dry-run all passed. Lint retains 36 inherited warnings. The focused suite passed 215 cases, including 36 new route regressions. `review.md` and `implementation-report.md` retain the scoped evidence.

## Actual local workerd gate

`runtime-probe.mjs.txt` bundles `worker-probe.ts.txt` against `VNEXT_PROBE_ROOT`, starts local workerd through Miniflare with fresh D1 and R2 bindings, applies the real migration corpus, and uses a real loopback HTTP origin. The full gateway app handles real API-key and session authorization. Two synthetic owners concurrently execute Responses SSE and JSON requests; a third key has retention disabled. The gate checks each retained sidecar contains only its own terminal attempt and request/response bytes, discovery creates no attempts, the disabled key creates no record, foreign detail access returns 403, and the owner detail exactly matches the gzip R2 envelope. Synthetic credentials in upstream URL/auth/response headers must be absent from sidecar/detail/export. Prepared and observed byte lengths are checked against decoded prefixes and EOF totals.

The frozen clean verify candidate passed this gate; `runtime-results.json` records the final output. A preactivation fixture smoke against the accepted adapter source (with unrelated preserved collaboration changes) also passed with null sidecars, establishing the harness and ordinary egress path. The source fixture and final result are retained here. All data and credentials are synthetic; no paid inference or deployed service is used.

The initial harness omitted ExecutionContext.waitUntil, so workerd ended background I/O after the request. Root stopped only those fixture processes and wired the fixture scheduler to the current execution context; this was a harness defect, not a product finding. The probe retains its bundle scratch and disposes Miniflare plus the loopback HTTP listener on normal completion.

## Reproduction and limits

Copy the text sources beside one another as `task-D02-route-runtime.mjs` and `task-D02-route-worker.ts`, adapt the harness Miniflare/Wrangler imports to installed dependencies, then set `VNEXT_PROBE_ROOT` to the clean candidate checkout and run Node. `EXPECT_CAPTURE=0` is only for the preactivation fixture baseline. This gate checks the actual Workers runtime and D1/R2/HTTP composition for Responses; the committed route regression matrix separately covers other endpoint families, retries/fallbacks and cancellation. It is not a production deployment, CPU/memory benchmark or socket-wire capture claim.

## Validation log interpretation

The retry/failure fixtures intentionally emit diagnostic logs. Copilot retry cases advance the synthetic clock to elapse refresh cooldown, so their approximately 62-second logged route durations are simulated clock values, not measured fixture runtime or gateway latency. Full CI retains the inherited multi-project advisory and 36 lint warnings; output is passing, not warning-free.
