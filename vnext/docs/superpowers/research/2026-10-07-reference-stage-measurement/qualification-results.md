# Local observer qualification and remaining comparison gaps

Date: 2026-10-07. **A/B observer canary passed. The three-arm performance comparison is incomplete.**

This change adds measurement tools and documentation only. It does not change the product, deploy a Worker, access production, or establish a release recommendation. The executable currently supports `qualify-ab`; a formal A/B/R runner is still pending.

## Verified scope

The new [harness](harness/README.md) extends the immutable October 2 A/B tools. It validates compiled bytes against frozen identities, records source-to-probe transformations, identifies the owned workerd process and exact gateway Inspector target, and records bounded request-owned numeric observations. No request/config/event bodies enter the probe traces. Trace export and physical readback occur after the process CPU window.

Focused validation passed **79 tests / 633 assertions**, and the complete new harness passed strict TypeScript checking. Tests include real Darwin CPU/RSS calibration against an owned child's `getrusage`, source/lock drift rejection, preserved Promise/stream behavior, counter overflow, malformed Chat output, and reference seeding/readback using all **86 real reference migrations**. The reference schema tests use Bun SQLite, not a running R Worker.

Canary `qualification-ab-03` ran four fresh isolated instances, A/B with probes disabled/enabled. Each served one 65,536-byte native Chat SSE request and one JSON request. All eight requests passed client semantic/usage/terminal checks, completed one upstream dispatch each, and had their real D1/R2 captures read back. Same-arm control/probe requests had identical full upstream request hashes after replacing only equal-length benchmark IDs; source format and response bytes also matched.

The run verified:

- Exact Inspector target and owned process identity; monotonic OS CPU counters and instantaneous RSS.
- A local synchronous clock that advanced during the synthetic loop, and all four `Runtime.getHeapUsage` fields: `usedSize`, `totalSize`, `embedderHeapUsedSize`, `backingStorageSize`.
- One trace per instrumented request, no overflow/unowned hooks/observer failures, one entry/response-return/HTTP-dispatch marker, and the required auth/body/routing/provider/persistence boundaries.
- SSE input/frame counters against the fixture and file counts/compressed bytes against physical storage.
- Client EOF before the tracked `waitUntil` barrier, zero pending/failed tracked jobs, no rejected egress, and completed owned-process cleanup.

The A/B source/dependency freeze is the validated October 3 manifest `05f341af-02b0-4c30-8c5d-9958b29ac722`. A is `e660fb4d`; the B artifact is the frozen `cb5ca3b1` product inputs plus its recorded overlay/assets, revalidated against the current worktree. The worktree HEAD `dc3824d4` is not by itself the measured artifact identity. New source hooks and wrapper bundles have separate hashes. Both arms used Bun 1.3.0, Miniflare 4.20260601.0, workerd 1.20260601.1, compatibility date `2025-06-01`, and flags `nodejs_compat` plus `enable_ctx_exports`. The latter flag is an explicit difference from the older experiment, added to match R's entrypoint requirements.

## Work observations, not performance rankings

These counts were observed for each of the two instrumented requests per arm. They describe this one-provider, no-history, complete-diagnostics fixture only.

| Observation per request | A | B | Interpretation |
| --- | ---: | ---: | --- |
| Configuration copy calls | 5 | 5 | A shared cost lead; this canary does not explain a B-only regression through additional copy count |
| Routing candidates / HTTP dispatches | 1 / 1 | 1 / 1 | Matched routing/attempt population |
| Compression calls | 2 | 3 | B includes an additional upstream capture object |
| Physical dump objects written | 2 | 3 | B's sidecar is real additional diagnostic work, verified through readback |
| SSE parsed frames | 4 | 4 | Same fixture frames, including DONE; no parser calls on the native JSON source |

The B compression observer separately records byte input and string code units. Those unlike units must not be added or compared as a single byte total. Physical output sizes remain byte counts.

CPU/RSS/heap endpoint samples are retained in [the machine-readable summary](qualification-summary.json). **They must not be used to calculate a stable B/A slowdown or observer overhead.** There are only two cold requests per instance, no warmup, no balanced repetitions and no uncertainty estimate. The Inspector was attached. One A probe window happened to use less CPU than its control, illustrating why these observations cannot establish overhead from a single pair.

OS counters cover the entire workerd process, including Miniflare's internal storage Workers; they are neither gateway-isolate nor Cloudflare-billed CPU. RSS is not the Cloudflare isolate memory limit. Start/settled heap fields are not peaks, and field/temporal maxima must not be summed. Both control and probe keep the common context/settlement/outbound bridge harness, so its own overhead remains unqualified.

## Failed attempts retained and protocol corrected

| Attempt | Outcome | Correction or meaning |
| --- | --- | --- |
| `qualification-ab-01` | Inspector `Runtime.evaluate` could not find a default execution context | Run the clock check inside a synthetic Worker HTTP request before attaching; preserve the original failure |
| `qualification-ab-02` | A's non-stream Chat returned 502 when the fixture forced an SSE source: JSON parser rejected `data:` | Honor the actual upstream `stream` request; this was an invalid fixture assumption, not a measured product regression |
| `qualification-ab-03` | Eight requests and physical readbacks passed | Limited observer/correctness canary, not a formal benchmark |

All three supervision receipts record `cleanupComplete: true`; none timed out. They were separate output directories, with failed records preserved rather than overwritten or excluded from a formal result population.

The corrected comparison starts with **SSE-to-SSE** as the common source-format path. For JSON clients, A/B use JSON-to-JSON while the reference source forces SSE-to-JSON. That is a useful complete-behavior comparison, but it includes a real format/parsing/aggregation difference. It cannot be presented as equal work, even with diagnostics disabled.

## Reference blocker

R remains pinned to clean commit `1d7dcd923e260e425120cca0c7a240e93720af27`. A Git archive was created only in the new measurement directory. Its lock SHA-256 is `4905f188626ddf6f5dd4d0a9032a9f5f641bb56bf7f10f57fc1295256f6e8124`.

The reference preflight froze 111 inputs and identified 35 dependency edges involving 21 unique packages without an eligible isolated installation. Existing reference dependencies were missing or differed from the lock; the builder refused parent-directory/vNext dependency fallback. The required pnpm 10.24.0 was also not cached. One diagnostic attempt using the available pnpm 10.34.5, with package-manager switching disabled, `--offline --prod --ignore-scripts --frozen-lockfile`, confirmed an incomplete package cache: 46 planned packages, zero downloaded/added, `ERR_PNPM_NO_OFFLINE_TARBALL`. The package-manager mismatch was recorded and produced no accepted R artifact.

Bounded HTTPS probes to npm and a mirror connected over TCP but failed during TLS with `ENOTCONN`. No configured proxy was available. The original R checkout and installed vNext dependencies were untouched. Exact inputs and the recovery command are in the dependency recovery receipt indexed below. Recovery should prefer the declared pnpm version when network/cache access is restored; any package-manager deviation must remain explicit.

## Next priorities and gates

1. Restore access to R's exact dependencies, build its real Cloudflare entrypoint, bind its Durable Object exports, and qualify its native physical captures against independent wire/upstream evidence. The existing R reader reports schema and ownership; it is deliberately not a complete semantic success oracle.
2. Finish and freeze the three-arm runner/manifest/aggregation. Qualify warmed observer overhead with balanced order before accepting timing. Reassess the proposed six cells after the confirmed JSON format distinction; 5,400 timed requests remain a proposal, not an executed run.
3. Collect independent warm latency, whole-process CPU, source-mapped V8 profiles and sampled heap/backing timelines. First contrast diagnostics off/on and string/container shapes: these distinguish common preparation work from capture/compression and additional guarantees. Counts alone do not rank optimization value.
4. Only after locating repeatable deltas, measure the relevant byte/frame/catalog slope and retained ownership/backlog. Slow-reader, cancellation, open-loop load and bounded concurrency remain unqualified.

No new product optimization or deployment is justified by these canary timings. Catalog/affinity rollback compatibility and backup/restore remain independent release prerequisites.

Raw evidence remains under `.superpowers/sdd/2026-10-07-reference-stage-measurement/` in the repair worktree. [The evidence index](evidence-index.json) records absolute paths, sizes and hashes for the frozen inputs, failures, successful receipts, traces, physical readback and dependency blocker. Existing evidence and unrelated working-tree changes are preserved.
