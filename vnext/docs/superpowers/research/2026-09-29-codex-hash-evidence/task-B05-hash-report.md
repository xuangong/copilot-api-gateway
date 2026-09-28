# B05a1 incremental Codex session hashing

## Result and scope

The actual Codex Responses and compact identity path now hashes `instructions`, literal U+0001, and one native `JSON.stringify(seed)`. `sha256Uuid` remains an async WebCrypto API with its previous formatting. The new `sha256UuidFromParts` uses that existing helper when its parts total at most 2 Mi UTF-16 units; above that inclusive threshold it uses a per-call incremental SHA-256 state, avoiding the combined string and its full UTF-8 buffer. The small-input exception caps the combined string at 2 Mi code units (at most 4 MiB of UTF-16 storage) and TextEncoder output at 6 MiB. Both paths retain the same UUID version/variant nibble rules. The seed still ends at the first user message, and existing session/header override precedence remains in `buildCodexRequestIdentity`.

`sha256Utf8Parts` handles UTF-16 pairs across both chunks and part boundaries, including a high surrogate followed by another high surrogate or an empty part. The encoder receives at most 16,385 UTF-16 units per call; worst-case UTF-8 allocation is **49,153 bytes** (16,383 three-byte BMP units plus one four-byte pair). The separate dynamic encoder probe measured maxima of 16,384 bytes for ASCII, 49,152 for BMP, and 32,768 for emoji. After approximately 1 MiB of encoded bytes, the async helper yields with `setTimeout(resolve, 0)` before continuing. Hash state is local to each call.

This is a partial allocation improvement. `JSON.stringify(seed)` still creates one full owned string and retains native getter/toJSON/ordering/escaping/error semantics. Request body serialization, auth retry, transport, replay ownership, and serializer provenance are unchanged. The pre-existing string-input Responses path still throws later at `.some`; a test records this behavior rather than broadening this package's scope.

## Verification

- Frozen `task-B05-baseline-harness.mjs verify`: pass; five legacy UUIDs independently match WebCrypto. Its upstream serializer chunk observations are baseline data, not a result of this change.
- Final `bun test packages/provider-codex/src/__tests__`: 88 pass, 0 fail. They cover all five frozen UUIDs, WebCrypto bytes, direct incremental digest bytes on the same frozen/random cases, empty/long Unicode, control characters, split and lone surrogates, consecutive high surrogates, 250 deterministic random Unicode partitions, exact 2 Mi-unit threshold selection on both sides, numeric `1e21` and key order, concurrent hash isolation, timer delivery before a large hash finishes, actual outgoing session/thread headers including a large seed, first-user/tail stability, client header override, stateful toJSON counts, and cycle/BigInt errors before Codex dispatch.
- Both provider-llm and provider-codex strict typechecks: pass. Framework purity: pass. `bun run lint`: exit 0 with 36 existing warnings and no B05 warnings. `git diff --check`: pass.
- Direct dependency `@noble/hashes: ^1.8.0` is added only to provider-llm; `vnext/bun.lock` adds exactly one workspace dependency line and retains its already resolved `1.8.0` package entry. `bun install --ignore-scripts --lockfile-only` generated that minimal lock diff (Bun reported `Resolved, downloaded and extracted [12]`; cache versus network use was not independently established). `bun install --ignore-scripts --frozen-lockfile` then reported 461 installs checked, no changes. No install retry or unrelated version change.

## Final synthetic measurements

`task-B05-hash-benchmark.mjs` runs one mode and size per process, under `/usr/bin/time -l`; `task-B05-hash-benchmark-results.json` records all 18 final hybrid runs, with three fresh processes for each 1/10/50 MiB and mode. Input is an equal-size instruction string and a JSON seed containing emoji content. Each measurement includes native stringify, digest, a recurring zero-delay timer, OS maximum RSS, and `process.memoryUsage()` after an explicit Bun GC. The table gives medians of three runs. The preceding all-incremental implementation is preserved in `task-B05-hash-benchmark-results-initial.json`.

| Input | Mode | OS peak RSS | Post-GC process RSS | Hash wall time | Longest timer gap |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 MiB | legacy WebCrypto | 52.4 MiB | 52.2 MiB | 2.5 ms | 2.0 ms |
| 1 MiB | hybrid (WebCrypto) | 51.7 MiB | 51.5 MiB | 2.6 ms | 1.9 ms |
| 10 MiB | legacy WebCrypto | 151.1 MiB | 150.8 MiB | 29.1 ms | 21.0 ms |
| 10 MiB | hybrid (incremental) | 99.6 MiB | 99.4 MiB | 156.1 ms | 17.8 ms |
| 50 MiB | legacy WebCrypto | 590.8 MiB | 491.0 MiB | 152.2 ms | 113.7 ms |
| 50 MiB | hybrid (incremental) | 276.9 MiB | 276.7 MiB | 722.0 ms | 43.2 ms |

All old/new UUIDs matched for each same-size run. In the final hybrid run, 1 MiB selects WebCrypto; 10/50 MiB select incremental hashing. The timer received callbacks before hash completion in every large incremental run (median 19 and 99 callbacks for 10/50 MiB). The 50 MiB maximum observed timer gap fell versus legacy, but total CPU/wall cost is much higher. The original all-incremental 1 MiB result was negative (53.1 MiB and 24.7 ms versus legacy 51.6 MiB and 2.5 ms); the bounded WebCrypto exception removes that regression in the final synthetic run. The longest gap still includes synchronous native stringify before hashing starts and is not bounded by the 1 MiB hash-yield threshold. Post-GC RSS is a process metric, not proof of live retained object size; Bun startup, allocator and GC behavior affect it. These are synthetic single-request process measurements, not production latency or multi-request concurrency claims. Total memory remains proportional to seed JSON size.

Small-input scratch timing used `task-B05-hash-small-benchmark.mjs`: three independent processes per mode/size, each with one first call and ten subsequent calls. Medians below are the median first call and median within-process warm call, then aggregated across the three processes. This is timing guidance for a possible later small-input decision, not a product-path latency SLA.

| Instruction and seed content size each | Mode | First call | Warm call |
| --- | --- | ---: | ---: |
| 1 KiB | legacy | 0.708 ms | 0.045 ms |
| 1 KiB | hybrid WebCrypto | 0.786 ms | 0.043 ms |
| 64 KiB | legacy | 0.800 ms | 0.173 ms |
| 64 KiB | hybrid WebCrypto | 0.820 ms | 0.190 ms |
| 256 KiB | legacy | 1.113 ms | 0.551 ms |
| 256 KiB | hybrid WebCrypto | 1.219 ms | 0.574 ms |

The final raw measurements are in `task-B05-hash-small-benchmark-results.json`; the earlier all-incremental run is preserved as `task-B05-hash-small-benchmark-results-initial.json`. These inputs all select WebCrypto. Small differences between old and hybrid are process noise plus the short part-length scan and join, not evidence of a production advantage. The all-incremental initial small-input data showed a real latency regression, which motivated the bounded exception.

No commit, push, deployment, live CLI call, or production-data operation was performed. Root owns clean aggregate CI, review, and merge.
