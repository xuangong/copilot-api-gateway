# Bounded JSON body foundation evidence

Date: 2026-09-29. Clean verification base `bc8dadf2` plus the eight serializer files identified by `verified-source-sha256.json`. This is helper groundwork; no provider route selects it yet and no deployment was performed.

## Contract

Unknown input calls native JSON.stringify exactly once and owns buffered bytes. JSON text is privately parsed, copied into a frozen structural snapshot and measured before exposing any stream. Both owners replay identical bytes with pull-driven opens, independent cancellation and mutation-safe returned chunks. The snapshot path emits at most 65,536 bytes per chunk and bounds scalar/key escaping by slicing before native stringify. MIT source adaptation and the verbatim notice are in provider-llm/src/vendor.

Total memory remains proportional to source/snapshot size. The trusted path adds a structural copy plus a length traversal and repeats traversal for every open. It is not a public arbitrary-object trust detector, an HTTP transport, or proof that existing provider input has safe provenance. Native exceptions from unknown input happen during preparation; text output canonicalizes native parsed values, including overflow numbers to null.

## Evidence and adoption boundary

Focused tests: 17 passed, covering 1,200 seeded trees, fixed byte fixtures, giant keys/scalars, 5,000-level iterative traversal, internal normalization/alias mutation, unknown getters/toJSON/Proxy traces, abort/cancel/replay and chunk mutation. Independent spec/quality review PASS. Required clean `bun run ci:local` passed: **4221 pass, 1 existing skip, 0 fail**, all typechecks/purity/dashboard build/Workers dry-run. The first aggregate lint pass also identified seven intentional reference-clearing assignments in the archived memory harness; their GC-measurement purpose is now documented with a scoped lint annotation and final lint was rerun. Product source has no new lint warnings. Reviewer lifecycle/control-character probes also passed; preserving those probes as durable tests remains a nonblocking final-review item.

Root actual local workerd: both modes produced the same 1,778,049 bytes as native output; max chunks were 65,536 and 53,605 bytes respectively. Cancelling/mutating an earlier open did not affect replay, midstream abort rejected, and 1e400 normalized to null. `root-workerd-results.json` is runtime evidence, not deployed CFW verification.

The implementer ran **120 fresh Bun processes**, including separate oracle/parse-only runs and three repeats per mode/case/size. Every digest, declared length and observed length matched. See the full table and raw samples in `task-B05-serializer-report.md` and `task-B05-serializer-benchmark-results.json`. At 50 MiB serialized source, candidate median process RSS decreased for ASCII (337.7 to 306.8 MiB), CJK/emoji (351.9 to 291.1 MiB) and giant keys (287.3 to 256.2 MiB), but increased for lone surrogates (387.8 to 441.6 MiB). At 1 and 10 MiB every candidate case used higher peak RSS; every candidate case used more CPU. Process RSS after GC is not live retained-object size. These results justify no universal memory or speed claim.

Provider adoption must separately prove request lineage/revocation, replay ownership through auth/HTTP/dial retries and an end-to-end useful selection policy. Native-buffered remains the compatibility boundary for arbitrary inputs. Runtime direct fetch buffering and raw transport streaming are distinct future paths; bounded serializer chunks alone do not prove bounded whole-request memory.

## Reproduction

From repository root with the existing frozen vNext install:

```sh
bun vnext/docs/superpowers/research/2026-09-29-json-body-evidence/task-B05-serializer-benchmark.ts candidate giant-key 10
python3 vnext/docs/superpowers/research/2026-09-29-json-body-evidence/task-B05-serializer-run-benchmark.py
node vnext/docs/superpowers/research/2026-09-29-json-body-evidence/task-B05-serializer-workerd.mjs
```

The runner writes `new-benchmark-results.json` without replacing archived evidence. Paths and runtime lint annotations were adjusted for archival; measurement behavior is unchanged. The workerd harness concatenates a moderate fixture for byte comparison; memory measurements use incremental digest/drain without joining output. No live services or credentials are used.
