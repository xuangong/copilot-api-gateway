# Codex session hashing adoption evidence

Date: 2026-09-29. Verified on clean base `b58ad7ff` plus the eight-file hash patch identified by `verified-source-sha256.json`; the enclosing commit is the integrated result. No push or deployment.

## Adopted behavior

Codex Responses and compact identity derivation preserve the exact instructions + U+0001 + native seed JSON bytes and existing UUID/header precedence. The seed still ends at the first user message. Up to 2,097,152 total UTF-16 units uses the original WebCrypto helper; its concatenation is explicitly bounded (at most 4 MiB UTF-16 text / 6 MiB UTF-8 output). Larger inputs use incremental noble SHA-256, bounded encoding chunks and a portable timer yield after approximately 1 MiB of bytes. Native seed stringify still creates one full string.

The initial unconditional incremental implementation made small requests slower and did not reduce their peak RSS. Its measurements are archived with the `-initial` suffix. The final hybrid preserves small-input WebCrypto and adopts the memory tradeoff only above the bound. This is partial B05 adoption, not streaming JSON, replay transport or provider body serialization completion.

## Verification

- Independent spec and quality review: PASS; one nonblocking suggestion for a separate getter-count fixture is tracked in the plan ledger. Stateful toJSON, direct incremental frozen/random Unicode bytes, threshold selection, concurrent calls, large outgoing session headers and pre-dispatch native errors are covered.
- Clean `bun install --ignore-scripts --frozen-lockfile`: unchanged resolution. Required `bun run ci:local`: exit 0; **4204 pass, 1 existing skip, 0 fail**; all typechecks, framework purity, dashboard build and Workers dry-run pass; 36 inherited lint warnings, zero errors.
- Root actual local workerd 1.20260601.1: 1 and 10 MiB cases match legacy UUIDs, including split/consecutive high surrogates; a timer runs before the large incremental case finishes. This is runtime behavior, not deployed CFW evidence. `root-workerd-results.json` records the results.
- Root repeated measurements use three fresh Bun 1.3.0 processes per mode/size, with `/usr/bin/time -l` OS peak RSS. Every old/new digest matches. `root-benchmark-results.json` includes raw runs, ranges, startup/retained process memory and timing. The machine is not an exclusive performance lab; process startup, JIT, scheduler and allocator noise remain.

| Synthetic instruction size | Mode | Median OS peak RSS | Median hash wall time | Median longest timer gap |
| --- | --- | ---: | ---: | ---: |
| 1 MiB | legacy | 51.7 MiB | 2.9 ms | 2.3 ms |
| 1 MiB | hybrid | 52.8 MiB | 3.4 ms | 2.9 ms |
| 10 MiB | legacy | 151.3 MiB | 31.2 ms | 23.5 ms |
| 10 MiB | hybrid | 101.5 MiB | 239.4 ms | 38.3 ms |
| 50 MiB | legacy | 590.7 MiB | 207.0 ms | 148.8 ms |
| 50 MiB | hybrid | 273.1 MiB | 1205.7 ms | 73.1 ms |

Each case also has a seed containing an equal UTF-8 quantity of emoji, so the size column is not total request bytes. These results establish lower large-input synthetic peak RSS and higher CPU/wall cost, not an across-the-board speedup. The 10 MiB scheduling gap was worse in the root run; native stringify and system scheduling can still delay the event loop. The initial implementer run is separately retained in `task-B05-hash-benchmark-results.json`; differences must not be hidden by selecting only favorable timings. No production throughput, full-request memory bound, GC reclamation guarantee or reduced Worker CPU billing is claimed.

## Reproduction

From the repository root, install the existing frozen vNext lock first, then:

```sh
bun vnext/docs/superpowers/research/2026-09-29-codex-hash-evidence/task-B05-hash-benchmark.mjs incremental 10
python3 vnext/docs/superpowers/research/2026-09-29-codex-hash-evidence/task-B05-hash-root-benchmark.py "$PWD"
node vnext/docs/superpowers/research/2026-09-29-codex-hash-evidence/task-B05-hash-workerd.mjs
```

Archived scripts differ from the scratch originals only in relative paths/output location. The root runner writes a new `task-B05-hash-root-benchmark-results.json`; it does not replace the archived `root-benchmark-results.json`. Initial-only numbers describe the historical all-incremental candidate; executing its harness against the final source exercises the final hybrid. Workerd uses a temporary local bundle and disposes its runtime. No credentials or live upstreams are used.
