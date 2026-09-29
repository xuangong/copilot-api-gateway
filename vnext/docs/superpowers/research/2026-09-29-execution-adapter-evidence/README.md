# D02 execution observation adapter evidence

This package supplies a request-local gateway adapter plus an optional terminal application fetcher seam across six providers. Registry/routing activation is a separate following package; this foundation alone does not turn production capture on. The ordinary fetcher continues to own model discovery and credential/session/passport requests. Endpoint and action select fixed operation labels explicitly, never by matching secret-bearing URL components.

## Runtime acceptance

The independent fixture runs the actual adapter in Bun and local workerd against one temporary loopback HTTP origin. Each runtime fetches a 302 redirect followed by a binary 201 response. It checks original URL/redirect/type/status metadata, clone and clone-of-clone bytes, capture counted once, request text containing CJK/emoji/lone surrogate with a 64 KiB prefix ending mid-codepoint, shared parent IDs across endpoint-specific observers, unchanged status-0 Response identity, pending-read cancellation and finish-before-cancel lock release. Synthetic secret header and URL sentinels must be absent from the persisted envelope. No paid provider, production database or remote deployment is involved.

The frozen candidate passed in Bun and actual local workerd; `runtime-results.json` records both results (four origin requests total). Independent spec and quality review passed with no blocking findings. Clean `bun run ci:local` passed: 4,328 tests passed, 1 skipped, 0 failed; purity, workspace typecheck, lint, UI build and Workers dry-run all passed. Lint retains 36 inherited warnings, with no errors. `review.md` and `implementation-report.md` retain the scoped review and focused verification. Route activation and end-to-end owner/retention/storage acceptance remain the next package. The HTTP origin is stopped and Miniflare disposed by the harness; bundle scratch is retained for inspection.

## Reproduction

`runtime-probe.mjs.txt` and `worker-probe.ts.txt` retain executed fixture sources. Copy them to a local scratch directory as `task-D02-adapter-runtime.mjs` and `task-D02-adapter-worker.ts`, adjust the harness Miniflare import to the installed dependency, then run the harness with Node and `VNEXT_PROBE_ROOT` pointing at the candidate checkout. It builds the worker with Bun, runs the same assertions in a Bun child and workerd, and prints both results. The default adapter path is `vnext/packages/gateway/src/shared/dump/upstream-dial-adapter.ts`; `VNEXT_ADAPTER_MODULE` can override it. Bun and Node must be on PATH.

## Limits

Captured bodies are prepared request bytes and fetch-body response bytes, not socket-wire proof. The wrapper is lazy; explicitly requested consumer clones have ordinary Response cloning behavior. Status-0 bodies remain unobserved. This is isolated runtime evidence, not a measurement of memory/CPU improvements, live credentials or full route capture. A factory construction failure may fall back only to the already configured ordinary fetcher; actual network errors remain transport errors.
