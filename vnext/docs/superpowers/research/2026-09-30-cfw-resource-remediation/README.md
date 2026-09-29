# CFW resource remediation — in progress

Production has not been deployed. Memory/performance acceptance remains open; catalog and affinity rollback compatibility work is queued behind the user's explicit resource priority. The latest reviewed resource code is `12a7a762`, with frozen full CI passing (5,240 tests, 2 skipped). Its predeclared 4,000-request ordinary CFW comparison completed with all requests semantically successful and dispatched exactly once, but resource qualification did not pass: CPU p50 crossed its threshold in 2/5 pairs, memory p99 in 4/5, and client p95 in 3/10 cells. CPU p95 improved in all five pairs; this does not cancel the adverse gates. Upload concurrency remains provisional. Sections below retain earlier measurements; older checkpoints are not current performance estimates.

## Frozen code changes

Base: `42b20f311173b1981e03a33b7f1b6460a8601d1b`, plus the preserved 13-file collaboration overlay used by the initial assessment.

- `c8a77edf`: retain one canonical affinity input snapshot instead of two.
- `140800e4`: release HTTP delivery after the verified canonical terminal; keep usage, metrics, upstream cleanup and dump finalization owned by `turn.completion` and `waitUntil`. Snapshot persistence and terminal-tail validation still precede delivery.
- `90ebb5ac`: hoist the bounded UTF-8 writer out of its character loop, removing repeated function-name property definitions in the Worker bundle.
- `93161c65`: copy mutable JSON containers without serializing immutable strings. Each candidate/attempt still receives an independent mutable graph. Runtime-only values/accessors fall back to native structured cloning.

The original deployed baseline remains `e660fb4dfcf1734d10f89e52e2d739b2985c634b`, including its original deployed overlay. The baseline lab's active version was checked unchanged from the initial primary measurement.

## Evidence so far

| Experiment | Control | Repair | Interpretation |
| --- | --- | --- | --- |
| Single-snapshot ablation, ascending 64 KiB / 1 MiB / 8 MiB / 32 MiB, JSON then SSE, five AB/BA blocks | Unfixed candidate 35/40 | Single-snapshot 35/40 | Removing one clone is insufficient; both fail every 32 MiB JSON trial. |
| Container-copy repair, identical ascending workload | Unfixed candidate 35/40 | Repaired 40/40 | Repaired requests each dispatch exactly once; five control failures do not reach upstream. All five repaired platform windows report success only; each control window reports exceededMemory. |
| Original-baseline ordinary pilot, 64 KiB, 5 arrivals/sec, concurrency cap 16, three blocks | 300/300 | 300/300 | JSON median 95.21 vs 151.33 ms; SSE median 124.89 vs 188.49 ms. Common-path non-regression is not yet satisfied. |

The single-snapshot run isolates that change. The container-copy remote run combines all three commits and does not independently attribute client latency to the HTTP delivery change. Local gate tests separately prove telemetry writes no longer block delivery. Local isolated-process measurements separately prove that container copying removes the affinity-stage large-string RSS amplification; they are not a Worker heap measurement.

New runs record runner/oracle hashes and frozen deployed source/artifact metadata at launch. Original-baseline upload provenance remains subject to the explicit limitation in the initial assessment: its source inventory is captured now and active version identity is verified; the original upload did not record a run-local source hash.

## Early container-copy checkpoint

- Task-scoped independent code review: approved, no blocking code findings.
- Frozen `93161c65` full `ci:local`: 5176 passed, 2 skipped, 0 failed; typecheck, framework checks, lint, UI build and Worker dry-run succeeded. Lint reports 35 warnings on unchanged paths. Same-lock dependency reuse remains the pre-existing clean-install qualification gap.
- Cloudflare GraphQL metrics collection reached its API budget on the first collection pass. Failed responses were retained and subsequent collection completed after cooldown. Missing metrics were not treated as successful outcomes.
- D1 read-only probes locate baseline and both repair-lab databases in APAC/KIX. This removes a simple cross-region database explanation for the measured difference; it does not control every placement/network variable.
- Original-baseline ascending large workload: 80/80 successes; all platform windows report success only. Altered-history 32 MiB SSE-before-JSON workload: 20/20 successes; all platform windows report success only. Both have exactly one dispatch per logical request and zero client drops.
- This early ordinary pilot had Worker CPU p50 of 57.48–59.02 ms versus baseline 8.71–9.29 ms, blocking acceptance of that checkpoint. Later repairs substantially reduced this cost; the latest paired results are reported below.
- Health/model route probe: 360/360 client successes, CPU p50 approximately 0.5–1.7 ms for both builds where adaptive samples exist. One baseline model window has no samples. This narrows investigation to inference-specific work without claiming every entrypoint cost is identical.
- Actual local workerd V8 profiling found a request-diagnostic UTF-8 loop creating a function for every captured character. esbuild keep-names adds repeated name-property definitions. The subsequent scoped repair and remote measurements are reported below.
- Still required: qualify the next repair remotely, final paired primary measurement, protocol matrix and soak as appropriate.
- No global memory-leak, OOM-immunity, lower-memory or faster-throughput claim follows from the current experiments.

Sanitized intermediate platform windows with raw-file SHA-256: [container-copy-platform-metrics.json](./container-copy-platform-metrics.json). This intermediate build still fails ordinary CPU qualification.

Private raw evidence: `/Users/zhangxian/.local/share/copilot-gateway-backups/cfw-p0-20260930`. Frozen experiment sources and harness: `/Volumes/Projects/copilot-api-gateway-cfw-validation-20260930-001627/p0-repair`. These contain synthetic workload data; no real-provider inference is used.

## UTF-8 capture hotspot follow-up

The real Wrangler/workerd bundle exposed a new dump-observation loop that allocated a writer closure per character. Keep-names adds a function-name property definition at each allocation. Moving the closure outside the loop preserves identical byte-prefix/count semantics and bounded memory. Independent scoped review approved the two-file change; 49 tests, workspace typecheck, and changed-file lint passed.

The unchanged remote workload includes diagnostic dumps (`dump_retention_seconds=0` means enabled/unlimited retention). The new frozen pilot passed 600/600 with exactly one dispatch each and no drops. Its three paired Worker CPU medians were baseline 13.54 / 8.27 / 8.25 ms versus repair 13.98 / 13.22 / 13.53 ms. This is a substantial reduction from the preceding repair's 57–59 ms, but the warm baseline gap remains. Shared-isolate memory p99 was 43.43 / 41.19 / 49.41 MiB versus 55.23 / 65.30 / 51.91 MiB. The acceptance gate remains open while remaining measured base64/persistence work is investigated.

See [utf8-pilot.json](./utf8-pilot.json) for all per-cell client results and paired platform windows. Raw local before/after V8 profiles, bundles, and SHA-256 manifest are privately archived under `cfw-p0-20260930/workerd-utf8/`. These sample weights explain the hotspot; they are not billed Worker CPU counters.

## Native base64 and diagnostic split

`cb3147f4` replaces the measured per-page byte spread/binary-string conversion with native bounded Buffer encoding. Request/response/aggregate capture limits and strict persistence validation remain intact. Independent review approved it. Full frozen-candidate `ci:local` completed: 5179 pass, 2 skip, 0 fail; typecheck, purity, lint, UI and Worker dry-run succeeded. Existing lint warnings and same-lock dependency reuse remain disclosed above.

The capture-enabled [base64 pilot](./base64-pilot.json) passed 600/600 with exactly one dispatch and no drops. CPU p50 remains baseline 9.72 / 8.29 / 8.18 ms versus repair 13.43 / 12.04 / 13.17 ms. Memory p99 remains baseline 42.35 / 44.55 / 48.48 MiB versus repair 55.09 / 65.69 / 53.87 MiB. Encoding alone is insufficient; resource qualification stays open.

A separate [no-dump diagnostic](./nodump-diagnostic.json) used additional synthetic API keys in the two allowlisted lab databases, with `dump_retention_seconds=null` and unchanged response retention. Original capture-enabled keys were preserved. CPU p50 was baseline 6.30 / 5.04 / 6.24 ms versus repair 7.08 / 6.80 / 7.08 ms; memory p99 was baseline 42.63 / 43.84 / 46.01 MiB versus repair 46.72 / 50.84 / 46.80 MiB. All 600 client requests passed. The runner exited 1 only after the workload when its count GET encountered ECONNRESET; a separately timestamped read recovered all 600 exactly-once dispatches. The original failure and later recovery are both retained. Initial metrics collection encountered expired OAuth credentials; Wrangler refreshed the existing credentials and successful responses were collected without overwriting the failed evidence.

The no-dump diagnostic narrows the remaining core and capture-specific costs. It is neither a replacement acceptance workload nor a precise cross-run subtraction of CPU. Current work compares actual heap retainers and core call paths, and tests native bounded UTF-8 encoding rather than weakening capture or validation semantics. The user's reaffirmed goal is to optimize CPU, latency, and memory against the deployed baseline; improvement from the severely regressed candidate is not sufficient for completion.

## Further allocation diagnosis

`a84609f8` reuses the terminal JSON string for HTTP delivery. Previously the JSON renderer serialized and encoded the body for diagnostic byte counting, even with dumps disabled, and `Response.json` serialized it again. The focused regression reproduces two `toJSON` calls before the change and one afterward. Cancellation replacement, status/headers, Unicode counts and native handling of values without JSON representation remain covered. Independent scoped review approved it; 53 focused tests, workspace typecheck and scoped lint passed. The subsequent native-UTF8 pilot includes this change; its independent remote effect is not isolated.

An actual local workerd heap experiment compared the unchanged deployed-baseline A with `cb3147f4` G, using the same dump-enabled key and 92 successful 64 KiB JSON requests per variant. G minus A `Runtime.getHeapUsage.usedSize` was +1.77 MB cold and +10.03 MB after the workload and a two-second settle. After taking snapshots, the gap was +1.91 MB; the backing-storage gap fell from +5.26 MB to +51 KB. Values in this paragraph are decimal MB. This supports transient allocation pressure in this sequence; it does not prove a persistent leak or establish production peak memory. Explicit Inspector garbage collection did not respond, so measurements are labeled before/after snapshot rather than forced-GC results.

The post-snapshot difference includes larger retained bundle-source strings and warmed code. Inspector source retention may differ from production. No growing collection of live request collectors was established. Newly loaded zlib module source strings account for only about 48 KiB, so eager fallback imports are not treated as the main multi-MB cause. Capture finalization and persistence retain or allocate raw prefix pages, base64, validation decoding, JSON, UTF-8 bytes and compression inputs; each redundant representation is being evaluated without changing the dump format or validation policy.

## Native encoding and ownership follow-up

`82160a0b` counts UTF-8 bytes natively and encodes only the retained bounded prefix. A module-level capability probe preserves the manual bounded fallback on Bun 1.3, where actual tests exposed lone-surrogate byte counting and short-buffer surrogate-pair encoding defects. Workerd differential tests covered 16,224 Unicode/truncation cases without mismatch. For a pre-materialized 32 MiB input, observed immediate backing-storage increases were 65,536–65,542 bytes, supporting bounded encoding without claiming an exact transient peak.

The [native-UTF8 pilot](./native-utf8-pilot.json) completed with command exit 0, 600/600 client successes and 600 exactly-once dispatches. All six refreshed platform windows report success only. CPU p50 was baseline 10.785 / 8.776 / 8.334 ms versus candidate 11.637 / 10.466 / 11.020 ms. Shared-isolate memory p99 was baseline 41.50 / 42.84 / 44.40 MiB versus candidate 57.43 / 60.96 / 49.76 MiB. CPU improved compared with the earlier capture-enabled pilots, but resource acceptance remains open. Original incomplete metrics are retained separately; the linked ledger uses the refreshed six windows.

`3bb89348` releases raw capture pages only after immutable snapshot conversion succeeds and removes validation-only Base64 decoding. A 55,575-case comparison against the previous real implementation found no acceptance mismatch. `04cad3ff` transfers internally created text prefixes directly to the collector while continuing to copy caller-owned byte views. It uses a view for single-chunk Base64 and keeps the bounded concatenation path for multiple chunks. In real workerd, 54 full-snapshot cases matched; observed constructed backing for a 64 KiB prefix fell from 196,608 to 65,536 bytes, excluding view-only lengths by ArrayBuffer identity. These are mechanism checks, not whole-isolate peak memory results. Both changes passed focused checks and independent review; the cloud result below remains short of resource acceptance.

## Architecture assessment

The [architecture review](./architecture-review.md) recommends retaining the existing protocol/provider/platform boundaries and canonical turn, while tightening data ownership and background lifetimes. It records why extra caching, weakened validation, a separate HTTP execution engine, and removed diagnostic content are not justified by current evidence.

An isolated [R2 timing diagnostic](./resource-timing.json) found three strictly serial writes occupying a mean 733.5 ms of mean full completion 1026.8 ms (71.4%). All 12 diagnostic requests succeeded and were dispatched once. The ten non-warmup observations ranged from 926–1132 ms total completion. Bounded overlap of prepared uploads was implemented in `208e7ed3`, with sequential compression and an all-started-writes settlement barrier before publication or retirement. Code review approved the lifecycle semantics, but performance acceptance is withheld because the ordinary pilot shows a CPU regression (see below). The diagnostic wrapper is excluded from formal client-latency qualification; baseline upload spans and actual placement have not been matched, so the result does not attribute the entire A/B gap to one extra file.


## Upload scheduling: speed improved, resource acceptance withheld

The [owned-prefix pilot](./owned-prefix-pilot.json), frozen at `04cad3ff`, passed 600/600 semantic requests with exactly one dispatch each and all six platform windows reporting success only. Candidate CPU p50 was 10.959 / 9.648 / 10.525 ms versus baseline 8.254 / 7.781 / 8.417 ms. Candidate memory p99 was 53.29 / 50.92 / 51.32 MiB versus baseline 44.06 / 44.63 / 33.71 MiB. Candidate platform wall p50 remained 1120 / 1037 / 1031 ms. This establishes useful allocation changes without closing the resource gate.

`208e7ed3` permits at most three prepared uploads to overlap. It passed independent code review and frozen full CI: 5207 passed, 2 skipped, 0 failed, 147372 assertions; typecheck, purity, lint, UI build and Worker dry-run passed. Dependencies were reused from the same lockfile, not freshly installed. The two skips are native Codex installed-parser acceptance and the X25519 invalid-point case.

The [prepared-upload pilot](./prepared-uploads-pilot.json) passed 600/600 semantic requests with exactly one dispatch each and success-only platform windows. However, CPU regressed:

| Paired block | Baseline CPU p50 / p95 ms | Candidate CPU p50 / p95 ms | Baseline / candidate memory p99 MiB | Baseline / candidate platform wall p50 ms |
| --- | --- | --- | --- | --- |
| 0 | 8.451 / 12.674 | 18.062 / 79.237 | 41.98 / 49.08 | 397.678 / 624.130 |
| 1 | 8.226 / 11.254 | 15.880 / 24.440 | 43.46 / 56.41 | 380.412 / 634.320 |
| 2 | 8.444 / 20.496 | 15.064 / 21.487 | 48.98 / 50.21 | 410.010 / 613.220 |

The shorter background lifetime does not justify accepting higher CPU. The effect is present beyond the first window, so cold start alone is not established as its cause. The ordinary wrapper hashes were reproduced exactly for both frozen sources; neither formal pilot accidentally included the resource-timing wrapper. Prepared-source counts and byte-copy inspection have not established a new serialization or compression pass. Native buffering, callback scheduling and GC are hypotheses, not proven causes.

A separate [prepared-upload timing diagnostic](./prepared-uploads-timing.json) observed 12/12 successful exactly-once requests and fulfilled registered background work. All ten non-warmup observations overlapped the puts; mean completion was 645.7 ms and mean R2 envelope 389.8 ms. These sequential diagnostic cohorts differ in source ownership changes and network timing. They support an upload-wait reduction, not a precise production speedup or a CPU/memory benefit.

A repeat of the serial `04cad3ff` pilot exited 2: the baseline A had 28 client concurrency-cap drops in its final SSE cell, while all 300 candidate requests and the 272 attempted baseline requests passed. The 572 observed dispatches were exactly once. This failed run is retained and is not treated as a completed paired acceptance run. The [repeat metrics](./owned-prefix-repeat.json) are complete and success-only, but this does not undo the unsent client drops. The two fully completed paired blocks show serial-candidate CPU p50 of 15.797 / 16.337 ms versus baseline 8.759 / 9.421 ms. This weakens a simple claim that upload parallelism alone caused the earlier CPU increase. The delayed baseline SSE requests had approximately 2 ms scheduling lateness; their 19.5–22.1 second wait has not been assigned to a layer. The subsequent same-deployment native-put diagnostic is reported below; the final policy remains subject to ordinary resource acceptance.


The frozen `208e7ed3` ascending large workload also completed with runner exit 0: 80/80 semantic successes, 80 exactly-once dispatches, no dropped offers, and ten success-only platform windows. It covers 64 KiB, 1 MiB, 8 MiB and 32 MiB with JSON before SSE. This result does not replace the still-pending changed-history repeat on the final candidate or ordinary resource acceptance.


## Same-deployment upload diagnostic

The [scheduling diagnostic](./upload-scheduling-diagnostic.json) used one frozen `208e7ed3` deployment with identical bindings. Each request selects serial or parallel native puts through the same ALS/proxy wrapper; serial mode adds a Promise chain. An 8-request canary and 600-request three-block workload both exited 0 with all semantic checks and exactly-once dispatches passing. All 600 request observations confirm three starts, maximum active puts of one or three as selected, zero active puts at completion and zero rejected background work.

| Block | Serial / parallel CPU p50 ms | Serial / parallel memory p99 MiB | Serial / parallel platform wall p50 ms |
| --- | --- | --- | --- |
| 0 | 17.512 / 12.890 | 43.22 / 44.65 | 1082.412 / 576.380 |
| 1 | 15.729 / 13.029 | 42.01 / 46.11 | 1077.689 / 589.550 |
| 2 | 17.012 / 17.290 | 35.54 / 38.21 | 1081.401 / 604.788 |

Metrics were refreshed after completion; all six raw hashes remained identical, with success-only sampled outcomes. The final parallel window's adaptive request count is 69 while the client has 100 exact successes; sampling aggregates are not reconciled as exact request counters.

This does not support attributing the earlier CPU rise solely to parallel puts. It also does not establish a general CPU reduction: the third pair is similar, and parallel memory p99 is higher in every pair. The provisional choice is to retain bounded overlap for the next ordinary candidate qualification, preserving all-started-write settlement. The ordinary baseline CPU/memory gates remain open.

Diagnostic boundary: each request drains its small fixture response and dynamically settles its own registered `waitUntil` tasks before returning. Thus latency includes full completion and is not production streaming TTFE. Window closure requires every request to succeed with a completion observation; a timeout or dropped offer would invalidate that premise. The global idle endpoint only sees one isolate and is auxiliary. The original launch-provenance note mistakenly attributes isolation to this endpoint; the hashed deployed wrapper and request observations implement the stronger request-level barrier described here. Exact isolate placement and GC history remain uncontrolled, and shared-isolate memory is not a request bound.

## Incremental affinity stream budgets

`b99b6d6d` replaces repeated serialization/encoding of accumulated reasoning prefixes with exact incremental JSON UTF-8 byte accounting. Guard state no longer retains full thinking or summary strings solely for size checks. The egress layer still retains content needed for emitted output and ownership signatures. Messages signature classification scans only each new fragment; final canonical decoding and all original limits remain enforced.

The helper preserves split surrogate pairs, lone surrogates, empty fragments and immediately enforced non-monotonic byte budgets. Against the real previous implementation, 187 guard/egress sequences included 37 rejections with zero differences in emitted-frame digest, consumed count, iterator closure or exact rejection event. Focused validation reported 77 passes and 80,313 assertions; typecheck passed. Independent review approved all three files. Focused GREEN/lint/purity tool outputs were not separately archived; the final frozen full CI will provide a raw log. The differential has no codec and is not represented as signed round-trip acceptance; existing affinity/adapter/SQLite serve tests cover that path.

Operation counters with 32-character fragments show incremental JSON input proportional to newly received text: 8,192 to 16,384 units when fragment count doubles from 256 to 512, or twice those totals where guard and egress both account. Earlier full-prefix encoding grew about fourfold. This is an asymptotic mechanism observation, not a measured cloud CPU percentage and not an explanation of the ordinary text-only pilot regression. The `evidence-after.json` diagnostic template retains a stale no-product-change boundary sentence; its pending-diff productState, file hashes and subsequent commit identify the implemented source.


Frozen `b99b6d6d` full `ci:local` exited 0: 5216 passed, 2 skipped, 0 failed and 227389 assertions in the full suite. Typecheck, framework purity, lint, UI build and Worker dry-run all passed; lint reports the same 35 existing warnings. The earlier focused-test archival gap is supplemented by this complete raw CI log and SHA-256 metadata. The pre-existing same-lock dependency reuse/clean-install gap remains. No production code was deployed by the dry-run.


## Incremental-budget checkpoint: resource gate remained open

The [incremental-budget ordinary pilot](./incremental-budget-pilot.json), using the uninstrumented wrapper and unchanged enabled capture, exited 0 in 121.37 seconds. All 600 requests passed the semantic oracle, all dispatched exactly once, and there were no drops or timeouts. All six platform windows report success only. Source-map and archived artifact checks confirm that neither upload-mode nor resource-timing diagnostic code was present. A read-only deployment check after the run confirmed that the baseline still had the expected version set.

| Paired block | Baseline / candidate CPU p50 ms | Baseline / candidate memory p99 MiB |
| --- | --- | --- |
| 0 | 8.195 / 10.963 | 43.65 / 48.55 |
| 1 | 8.171 / 10.382 | 45.68 / 52.82 |
| 2 | 7.724 / 10.501 | 51.27 / 47.14 |

CPU p50 and p95 exceed the original 10% relative investigation threshold in all three pairs. Memory p99 exceeds the original maximum of 10% or 2 MiB in two pairs. Four of six client terminal-latency p95 cells exceed both 10% and 20 ms. Accordingly, this is not resource acceptance, and the 600-request pilot is not the predeclared 4000-request qualification. The changed oracle is recorded at launch and is not represented as identical to the older historical gate-file hash. Lower CPU than another intermediate cohort is not attributed to incremental reasoning budgets because this ordinary fixture does not isolate that path.


The final `b99b6d6d` [protocol matrix](./incremental-budget-matrix.json) preserves the prior fixture result: candidate108/108 versus baseline90/108, with all216 logical requests dispatched once. The runner exits2 because of the18 baseline failures; this is not described as a globally successful command. This is one request per cell and verifies fixture semantics, including intentional refusal/failure cases, rather than a production failure rate.

The additional [no-dump diagnostic](./incremental-budget-nodump.json) also completed with 600/600 semantic successes, exactly-once dispatch and no drops or timeouts. All six platform windows report success only. CPU p50 was 6.161 / 5.561 / 5.931 ms for baseline and 6.822 / 6.878 / 6.322 ms for candidate; candidate CPU p95 remained 13.59% / 13.00% / 21.74% higher. Baseline/candidate memory p99 was 41.63/44.63, 27.96/48.17 and 34.01/36.49 MiB. The middle pair's 20.22 MiB increase is retained as adverse evidence, not identified as a leak. Three of six client p95 cells exceed both original investigation thresholds. This uses a separate synthetic key with null dump retention; the capture-enabled key retains its original zero/unlimited setting. The sequential enabled/disabled cohorts cannot be subtracted precisely to price the capture feature, and disabled capture cannot replace release qualification. A residual exists outside the enabled-dump cohort, so capture alone has not explained the regression.


A subsequent exact-source local workerd [CPU profile](./prepared-cpu-profile.json) compared the deployed baseline with the frozen `208e7ed3` source plus its recorded original overlay. Both source manifests matched every deployed-source hash before copying. Four profiles used 12 warmups followed by 80 sequential 64 KiB requests, with capture enabled. The candidate's storage-boundary Base64 slice/alphabet scan appeared at the same emitted line in JSON and SSE (38 / 35 position ticks); sidecar serialization/compression also appeared. These are sampled local stack observations, not billed cloud CPU or a measurement of the entire residual.

Readback found185 dump records in each local database; the candidate had185 sidecars and555 staged/owned file rows versus the baseline370 file rows. This verifies an additional stored representation per request. Sidecar and canonical dump semantics remain different; the finding does not authorize dropping capture. Raw evidence is privately archived with a 30-file verified SHA-256 manifest; the sanitized summary records the archive hash. The next narrow experiment can eliminate repeated alphabet scanning only for private, internally generated, frozen body identities, while retaining the complete external validation and all count/relationship checks.

## Internal prefix provenance

`3e54a222` implements that narrow optimization with a private WeakSet of body objects created and frozen by the collector itself. Persistence skips only the repeated Base64 alphabet scan and its slice for those exact identities. Safe-field projection and all length, padding, count, source, side, metadata and cross-field checks remain. Cloned, deserialized, inherited, proxy and frozen-lookalike bodies receive full validation; safe-projection output is not registered. The weak set does not retain its members strongly, and the implementation does not trust a whole snapshot merely because its body came from the collector.

Formal review passed. Focused validation reports 85 passes and 49,425 assertions; typecheck, scoped lint and framework purity passed. Actual previous/current modules produced identical results or rejections across 55,884 cases, including inconsistent snapshots produced through collector APIs. A 64 KiB request plus 5,001-byte response fixture changed repeated alphabet scanning from two calls over 94,050 string units to zero; external clones and safe-projection output retained the original two scans. These are operation counts, not a measured cloud CPU improvement.

The frozen [prefix-provenance ordinary pilot](./prefix-provenance-pilot.json) exited 0 in 122.71 seconds, with 600/600 semantic and transport successes, exactly-once dispatch and no drops/timeouts. All six refreshed platform windows report success only. Initial collection was early: the final baseline/candidate adaptive counts changed from 84/15 to 101/98; both initial files are retained and sampled counts are not exact client counters.

| Block | Baseline / candidate CPU p50 ms | Baseline / candidate memory p99 MiB |
| --- | --- | --- |
| 0 | 10.131 / 12.233 | 41.24 / 46.41 |
| 1 | 10.591 / 10.194 | 40.55 / 52.63 |
| 2 | 8.925 / 10.412 | 49.99 / 57.36 |

Two of three CPU-p50 and CPU-p95 pairs exceed the original 10% investigation threshold; all three memory-p99 pairs exceed max(10%, 2 MiB), and four of six client-p95 cells exceed both latency thresholds. Resource acceptance remains OPEN. Different preceding cohorts cannot establish an isolated WeakSet speedup; the removed scan is verified, while aggregate baseline parity is not. This pilot does not substitute for the predeclared 4000-request qualification.

## Compression representation experiment

The [local workerd compression microdiagnostic](./prepared-cpu-compression-micro.json) compared explicit UTF-8 bytes followed by Blob/CompressionStream against a Blob created directly from the JSON string. Seven ASCII, Chinese/emoji and escaped-surrogate cases cover approximately 64 KiB and 1 MiB, with repetitive and nonrepeating data. Every compressed output decoded to the original bytes. Batched ABBA medians were equal for both paths in all seven cases; no stable speedup was detected.

The direct-string path avoids one explicit input Uint8Array. Blob's internal conversion and buffers were not measured, so this is an allocation hypothesis, not a peak-memory result. Local `node:zlib.gzipSync` was also supported and decoded correctly, but its synchronous behavior and inconclusive whole-request benefit do not justify changing the Cloudflare default. The local timer control advanced during CPU-only work; deployed Workers have different timer semantics. The unchanged compression format, failure handling and enabled capture remain requirements for any subsequent product experiment.


## JSON-origin compression and primary qualification

`12a7a762` passes the two JSON-origin dump inputs directly to Blob compression, eliminating their explicit caller-side UTF-8 arrays. Binary inputs, Bun byte fallback, single stringification, optional-sidecar behavior, storage ordering and persisted gzip bytes remain unchanged. Formal independent review approved the change; actual old/new workerd cases and an independent Python decoder found zero differences in 23 gzip pairs. See the [compression evidence](./json-origin-compression.json). Equal local A/B microbenchmark medians remain disclosed: fewer explicit arrays do not prove lower total allocation, CPU or peak memory.

The exact frozen candidate, including the original collaboration overlay, passed `ci:local`: 5,240 pass, 2 skip, 0 fail, 227,526 assertions; typecheck, purity, lint, UI build and Worker dry-run passed. The existing 35 lint warnings and same-lock dependency reuse remain. Source manifests, exact inventory membership, baseline artifact archive, all candidate artifacts, the ordinary wrapper source map, actual zero/zero retention settings and active A/B versions were checked before the primary run.

The first semantic canary failed because the baseline's first JSON request took 1.233 seconds and a cap-1 client dropped its second offer; the seven attempted requests passed and dispatched once. That failed evidence is retained. A separate cap-2 semantic canary passed 8/8 with exactly-once dispatch. The 4,000-request primary keeps the original 5 paired blocks, 200 requests per JSON/SSE cell, 64 KiB payload, 5 arrivals/second, concurrency cap 16 and 120-second timeout. Its gates are unchanged.

The [completed primary](./json-compression-primary.json) exited 0 in 803.562 seconds: 4,000/4,000 HTTP and semantic successes, 4,000 exactly-once dispatches, no drops or timeouts. All ten platform windows report success only, and their raw metric hashes remained identical across the initial collection and two delayed refreshes. Source/artifact inventories, actual retention and active versions matched before and after the run. Dump retention zero means enabled/unlimited; Responses retention zero disables the durable continuation writer.

| Block | Baseline / candidate CPU p50 ms | CPU p95 ms | Memory p99 MiB | Platform wall p50 ms |
| --- | --- | --- | --- | --- |
| 0 | 8.029 / 10.107 | 16.134 / 15.385 | 49.746 / 64.171 | 399.437 / 560.108 |
| 1 | 11.392 / 9.383 | 15.635 / 13.176 | 48.201 / 88.862 | 392.770 / 547.364 |
| 2 | 10.827 / 9.619 | 15.501 / 13.934 | 59.096 / 64.357 | 399.082 / 527.825 |
| 3 | 11.130 / 9.817 | 16.089 / 14.135 | 54.474 / 60.754 | 395.728 / 521.996 |
| 4 | 8.013 / 9.827 | 15.590 / 14.142 | 47.914 / 66.527 | 382.888 / 520.805 |

CPU p95 improves by 4.64–15.73%, but CPU p50 exceeds +10% in blocks 0 and 4. Memory p99 exceeds max(10%, 2 MiB) in blocks 0, 1, 3 and 4; the largest paired difference is +40.661 MiB. Client terminal p95 exceeds both +10% and +20 ms in block 0 JSON, block 2 SSE and block 3 JSON. SSE median first-event and terminal latency improves in all five pairs, while the ordinary resource gate remains open. Platform memory is a shared-isolate quantile, not a per-request peak or evidence of a leak. This whole-stack comparison does not isolate the effect of JSON-origin compression.

The next diagnostics separate upstream capture plus sidecar persistence from canonical dumps, and logical SSE event count from physical read count. They retain exact source/feature identities and fail-closed semantic checks. Reduced capture is solely an experimental control; it cannot qualify a release. Both client delivery and full background completion remain relevant because earlier HTTP delivery does not eliminate CPU or retained buffers.

The latest [large-body and changed-history checks](./json-compression-large-history.json) also completed: ascending 64 KiB, 1 MiB, 8 MiB and 32 MiB with JSON before SSE passed 80/80; 32 MiB with SSE before JSON passed 20/20. Both internal commands exited 0, with exactly one dispatch per request and zero drops/timeouts. All twenty platform windows report success only; initial and delayed-refresh raw files are byte-identical. These single-request cells establish successful execution for the tested histories, not stable latency quantiles, a per-request memory bound or OOM immunity. They do not close the failed ordinary resource gate.
