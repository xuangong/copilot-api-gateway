# Isolated research evidence

These are research fixtures and observations for [the decision report](../2026-09-29-qualified-adoption-decisions.md), not application code or automated acceptance tests. All credentials/content in the disconnect fixture are synthetic. No external inference was used.

## Opaque strings

`opaque-current.ts.txt` and `opaque-reference.ts.txt` contain the exact extracted raw decoder from each baseline plus the same measurement harness. Results across three independent processes per mode/runtime are in `opaque-memory-results.json`. Sampling happens before equality assertions to avoid assertion-induced string flattening. All 65,536 UTF-16 code units are subsequently checked.

From this directory:

```sh
bun run - < opaque-current.ts.txt
bun run - < opaque-reference.ts.txt
docker run --rm -i --network none --memory 512m --cpus 1 --entrypoint bun copilot-gateway-vnext:e6780380-collaboration-20260928-233856 run - < opaque-current.ts.txt
docker run --rm -i --network none --memory 512m --cpus 1 --entrypoint bun copilot-gateway-vnext:e6780380-collaboration-20260928-233856 run - < opaque-reference.ts.txt
```

For Node 22, copy a fixture to a temporary `.ts` file and run `node --experimental-strip-types --expose-gc /tmp/fixture.ts`. These scripts use only built-in APIs; Bun takes its JSC measurement branch. Do not compare Bun/Node heap definitions as if they were identical. Original observations used Bun 1.3.0, image Bun 1.4.2, and Node 22.23.2.

## Blob compression

`blob-retention.mjs.txt` is an archived probe, kept outside the application lint scope. Copy it to `blob-retention.mjs` before running. It runs 10 warmups followed by 400 serial compressions of fresh 256 KiB random bytes, sampling after forced GC every 100 operations. Results are in `blob-retention-results.json`. One process per mode/runtime was sampled; this is a bounded screening workload, not proof of leak absence.

```sh
node --expose-gc blob-retention.mjs blob
node --expose-gc blob-retention.mjs stream
```

For Bun 1.4.2, feed the script to the same isolated image with `bun run -`; replace `process.argv[2] || 'blob'` with the desired literal mode before passing stdin. No service volume, credential, or network is needed. Local Bun 1.3.0 lacks CompressionStream and cannot run this branch.

## Cancellation and compaction

`disconnect-baseline.ts.txt` and `disconnect-control.ts.txt` use localhost HTTP servers and an in-memory SQLite test platform. The control injects the lost signal only in the script. Their corresponding output files show cancellation metrics, socket events, dump metadata, and the created-only snapshot. `active`/`upstreamCancelled` are server response callback counters and were not reliable socket-release indicators in this setup; compare `socketClosed` and request abort events. Both servers are closed in `finally`.

These fixtures contain absolute imports into the audited checkout. Check the baseline and adjust imports if the checkout moves. Run in a disposable process using `bun run - < disconnect-baseline.ts.txt` (likewise for control). They are not production probes.

`compaction-mock.ts.txt` contains extracted reference algorithm source as an embedded string, transpiled by Bun, with dependency/event helpers mocked. `bun run - < compaction-mock.ts.txt` reproduces the five replay outcomes in the report. It tests algorithm-level status/text acceptance, not real provider behavior or semantic equivalence.
