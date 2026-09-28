# B05a2 bounded replayable JSON serializer foundation

Date: 2026-09-29. Base: `9476a5c2` after B05a1 hash merge. Product ownership is exactly the eight paths in `task-B05-serializer-owned.json`. Hash implementation, dependency declarations, lockfile, provider calls, request transport, and unrelated collaboration files were not changed. The two explicit exports in `src/index.ts` follow the existing `incremental-sha256` export without changing it.

## Behavior and provenance

`createJsonBody(value: unknown)` invokes native `JSON.stringify` exactly once before returning, with no eligibility walk. It throws synchronously for no-representation roots and preserves native thrown errors. It owns one UTF-8 byte array and each pull-driven open copies <=65,536-byte slices. This mode is `native-buffered` and retains O(serialized bytes) memory.

`createJsonBodyFromText(text: string)` checks primitive string, runs native `JSON.parse`, synchronously copies its parsed structure into a private frozen snapshot, and measures exact emitted length by fully draining the same byte generator once. Its replay mode is `trusted-json-snapshot`; each open generates independently. Output is canonical native stringify of the parsed value, including `1e400` becoming `null` and `-0` becoming `0`. It does not remove existing ingress buffering or certify arbitrary provider objects. The copier also normalizes known generated data: object `undefined` fields are omitted, array holes/`undefined` become `null`, nonfinite numbers become `null`, and symbol keys are ignored. Source containers are never retained, including shared acyclic children; own `__proto__` data keys are safely defined. Unexpected prototypes, accessors, functions, symbols as values, BigInt, and callable `toJSON` violate this *internal* known-data contract and throw. Ordinary parsed JSON data key `"toJSON"` remains supported. The internal assertion is not a proxy detector or public trust gate. The snapshot is copied, not normalized in place, and therefore adds O(nodes) storage.

The structural iterator adapts `@discoveryjs/json-ext` v1.1.0 `src/stringify-chunked.js`, Git tag `v1.1.0` commit `bfc88518775c0a587bc1d119ea7daa6f97060858`, under MIT. The notice is a byte-identical copy from `/tmp/b05-json-ext-eval/upstream/LICENSE` (matching SHA-256 `f1f8656800605835965b43a777c1b459d2756d0429913f17c8c7a817729926c1`). See `src/vendor/json-ext-PROVENANCE.md` for the adaptation map. Git source was inspected; npm tarball integrity was not independently verified, and no npm package was installed. Traversal retains explicit stack/state, `Object.keys` enumeration, object/array progression and punctuation order. Replacer/space/JSONL/`replaceValue` and whole escaped-key caching were removed. Each string/key slice has at most 8,192 UTF-16 units plus one to preserve a surrogate pair. Native `JSON.stringify(slice)` produces bounded escaped interiors; the 65,536-byte accumulator flushes before overflow and transfers owned chunks. The worst escaped slice is 49,158 bytes. Total source/snapshot, key arrays, and traversal stack still scale with input width/depth; exact measurement and each replay traverse the snapshot again.

The returned owner is frozen. Opens use a pull-driven `ReadableStream` with high-water mark zero. An already aborted signal errors before iterator creation; midstream abort, cancellation, completion, and generator error return the iterator and remove the listener. Concurrent opens are independent, and consumer mutation of received chunks cannot change later opens.

## Verification

- `bun test packages/provider-llm/src/__tests__/json-body.test.ts packages/provider-llm/src/__tests__/json-ext-traversal.test.ts`: 17 pass, 0 fail. This includes 1,200 seeded trees, fixed byte/hex fixture, slice-seam surrogate cases, giant key/scalar, 5,000-level depth, internal normalization and source mutation, native getter/toJSON/Proxy traces, exotic fallback, synchronous errors, replay/chunk mutation, cancel and abort.
- `bun run --filter '@vibe-llm/provider-llm' typecheck`: pass.
- `bun run scripts/check-framework-purity.ts`: pass.
- Direct `./node_modules/.bin/eslint` over six owned TS paths: pass (only multiple-projects configuration warning).
- `git diff --check`: pass. Vendored notice SHA-256 equals upstream.
- Global `bun run lint -- ...` actually invokes `eslint .` and initially failed on my sparse-array fixture plus four `Bun` `no-undef` errors in the separately owned, already merged hash research script. I fixed my fixture and direct owned-path lint is clean. Root owns the hash evidence fix and clean aggregate CI; no claim for full `ci:local` in this dirty collaboration tree.

## Independent process measurements

`task-B05-serializer-benchmark.ts` and `task-B05-serializer-run-benchmark.py` are scratch only. `task-B05-serializer-benchmark-results.json` records 120 fresh Bun subprocesses: 1, 10, 50 MiB serialized-source cases across ASCII, control-heavy, CJK/emoji, lone surrogate and giant key; one separate oracle and parse-only run plus three native and three candidate runs per case. `/usr/bin/time -l` supplies OS maximum RSS. Oracle digest/length runs in a separate process; the drain never joins chunks. Every native and candidate digest, actual byte count and declared `contentLength` matched its oracle. All observed chunks were 1..65,536 bytes. The candidate's public text factory necessarily combines parse, snapshot copy, and length measurement; the separate parse-only process isolates parse cost, but factory timing cannot subtract parse precisely. Both modes keep their source text alive through drain; native parses an object before calling the factory, while candidate parses inside its factory. Total OS peak includes construction, parse, factory, and drain. `Bun.gc(true)` was called after drain and after release; the raw JSON records startup/phase RSS and heap samples and both post-GC points. RSS mostly remained allocated after release, so those numbers are process allocator footprints, not live retained object sizes. Bun's heapUsed samples often remained unchanged despite large RSS changes and are not a reliable stand-alone retained-heap estimate.

The table gives three-process median OS peak RSS with range (MiB), median factory and drain wall milliseconds, median total process CPU milliseconds (user + system), and maximum emitted chunk. Factory and drain timings do not include payload construction; CPU includes process startup and every phase. These synthetic numbers are neither production savings nor constant total-memory evidence.

| MiB | Case | Mode | OS peak RSS MiB median (range) | Factory ms | Drain ms | Total CPU ms | Max chunk bytes |
| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | ascii | native | 36.3 (36.3-36.4) | 0.3 | 1.3 | 20.0 | 65536 |
| 1 | ascii | candidate | 45.6 (45.6-45.6) | 1.4 | 1.8 | 23.6 | 65536 |
| 1 | control | native | 36.8 (36.8-36.9) | 0.8 | 1.5 | 23.0 | 65536 |
| 1 | control | candidate | 46.7 (46.7-46.7) | 3.8 | 2.4 | 26.8 | 65536 |
| 1 | cjk-emoji | native | 36.7 (36.6-36.7) | 0.9 | 1.4 | 21.2 | 65536 |
| 1 | cjk-emoji | candidate | 46.3 (46.3-46.3) | 2.0 | 2.6 | 24.7 | 57357 |
| 1 | lone-surrogate | native | 37.7 (37.3-37.7) | 0.7 | 1.5 | 21.4 | 65536 |
| 1 | lone-surrogate | candidate | 48.0 (48.0-48.1) | 2.5 | 2.4 | 24.7 | 65528 |
| 1 | giant-key | native | 35.3 (35.3-35.4) | 0.3 | 1.4 | 21.6 | 65536 |
| 1 | giant-key | candidate | 44.5 (44.5-44.5) | 2.3 | 2.0 | 25.3 | 65536 |
| 10 | ascii | native | 96.6 (96.5-96.6) | 2.8 | 6.5 | 35.9 | 65536 |
| 10 | ascii | candidate | 106.1 (105.6-106.2) | 7.9 | 8.5 | 43.3 | 65536 |
| 10 | control | native | 91.8 (91.7-91.9) | 6.3 | 6.6 | 61.3 | 65536 |
| 10 | control | candidate | 113.1 (113.0-113.3) | 28.7 | 13.2 | 72.9 | 65536 |
| 10 | cjk-emoji | native | 99.6 (99.5-99.7) | 8.9 | 6.1 | 44.8 | 65536 |
| 10 | cjk-emoji | candidate | 108.1 (107.6-108.8) | 12.5 | 13.9 | 57.3 | 57357 |
| 10 | lone-surrogate | native | 109.1 (108.8-109.2) | 7.2 | 6.2 | 51.3 | 65536 |
| 10 | lone-surrogate | candidate | 120.5 (119.9-120.9) | 18.3 | 12.6 | 61.0 | 65528 |
| 10 | giant-key | native | 86.6 (86.6-86.6) | 2.8 | 6.4 | 51.9 | 65536 |
| 10 | giant-key | candidate | 94.8 (94.6-94.9) | 15.1 | 9.1 | 59.4 | 65536 |
| 50 | ascii | native | 337.7 (337.7-337.8) | 12.1 | 26.1 | 84.0 | 65536 |
| 50 | ascii | candidate | 306.8 (306.8-307.0) | 29.2 | 33.4 | 113.1 | 65536 |
| 50 | control | native | 328.2 (319.2-328.3) | 30.7 | 26.0 | 209.7 | 65536 |
| 50 | control | candidate | 320.6 (312.6-321.2) | 135.4 | 52.2 | 255.6 | 65536 |
| 50 | cjk-emoji | native | 351.9 (351.6-351.9) | 42.2 | 26.7 | 128.2 | 65536 |
| 50 | cjk-emoji | candidate | 291.1 (290.9-293.8) | 52.0 | 60.9 | 179.1 | 57357 |
| 50 | lone-surrogate | native | 387.8 (387.6-420.4) | 33.8 | 25.4 | 154.3 | 65536 |
| 50 | lone-surrogate | candidate | 441.6 (441.4-441.7) | 82.7 | 53.3 | 202.2 | 49158 |
| 50 | giant-key | native | 287.3 (287.2-287.6) | 11.8 | 25.2 | 158.6 | 65536 |
| 50 | giant-key | candidate | 256.2 (256.2-256.3) | 64.8 | 34.9 | 187.8 | 65536 |

At 50 MiB, candidate median peak RSS was lower for ASCII (306.8 vs 337.7 MiB), CJK/emoji (291.1 vs 351.9 MiB), and giant key (256.2 vs 287.3 MiB), slightly lower for control-heavy (320.6 vs 328.2 MiB), but **higher** for lone surrogates (441.6 vs 387.8 MiB). At 1 and 10 MiB, candidate peak RSS was higher for every case. Candidate CPU was higher in every measured case. The real source/snapshot and parse costs dominate small inputs, and the lone-surrogate case shows why no uniform savings claim is justified.

This is helper foundation only. B05c still needs audited request lineage, exact final-root capability and revocation before unknown callbacks. B05b/c still needs replay-aware dial/HTTP ownership, framing/backpressure, platform adapters, and provider adoption. No route currently selects this snapshot mode.
