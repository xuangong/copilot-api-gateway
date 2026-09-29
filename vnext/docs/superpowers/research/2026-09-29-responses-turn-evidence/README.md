# Transport-neutral Responses turn acceptance

Accepted F1 candidate based on c4ec9988. The Responses execution turn now lives below HTTP rendering, preserving canonical source signing and durable completion ordering while suppressing post-terminal output and owning cancellation, usage and dump cleanup. WebSocket session and platform adapters remain separate tasks.

Independent initial review found error-target telemetry, no-frame dump-body and fixture-background regressions. All three are closed by scoped fix1 review. Final solo `bun run ci:local` exited 0: **4,878 pass / 1 existing skip / 0 fail / 84,898 assertions**; all types, purity, lint (35 inherited warnings), dashboard build and Workers dry-run passed. The earlier catalog timeout passed unchanged both in isolation and final full CI; concurrent load was removed, without changing the test.

All **20 final frozen runtime processes passed**: four new F1 probes and sixteen accepted C01 regressions. Final details are in `task-C12-F1-fix1-frozen-runtime-results.json`; the earlier result file is retained as initial evidence. The actual authenticated Bun/independent Node/SQLite/files probe covers 22 groups, including HTTP-error target identity and stored dump body. Actual workerd/WebCrypto/D1 covers eight groups, direct-turn tests cover lifecycle ownership, and a hostile final-metadata probe verifies bounded incomplete cleanup. Root verified all 18 product hashes unchanged after the final run. No paid upstream or production deployment was used.

Run the four standalone scripts with `VNEXT_PROBE_ROOT` set to a checkout root; use Node for the D1 script and Bun for the others. The D1 script loads the sibling worker template. All fixtures use synthetic credentials and temporary storage. Prior C01 scripts live in their existing evidence directories.

Terminal observation is bounded by an absolute 1,000 ms deadline, 256 frames and 1 MiB. Chat waits for all actual-request `n` choices before finish-based tail observation and preserves trailing usage. Tail failure aborts the producer without misclassifying caller cancellation. Iterator return and final metadata each have 1,000 ms cleanup bounds; incomplete cleanup is explicit. An already-started noncancellable durable save remains owned after cancellation, may finish physically, and cannot release success to the cancelled client. Existing all-zero usage-row omission remains unchanged; wire unknown and observed zero remain distinct.

No new migration, environment variable, upstream WebSocket or client WebSocket capability is added by F1.
