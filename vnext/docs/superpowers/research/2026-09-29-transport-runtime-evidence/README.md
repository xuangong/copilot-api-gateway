# Transport runtime evidence

Captured 2026-09-29 after B01 implementation. Local evidence only; no deployment or inference.

The existing deployment image `copilot-gateway-vnext:e6780380-collaboration-20260928-233856` (c10820393ad3) ran the actual parser suite with network disabled and the implementation tree mounted read-only. Bun1.4.2 passed143 tests/202 assertions. Command: `docker run --rm --network none --entrypoint bun --mount type=bind,src=<implementation-tree>,dst=/workspace,readonly -w /workspace <image> test vnext/packages/http/src/__tests__/parser_test.ts`. This leaves the running gateway and data untouched.

The Worker probe bundles actual `parseHttpResponse` and `toWebResponse`, including their framing helpers, with `bun build <entry.ts> --target browser --external 'node:*' --outfile /tmp/vnext-b01-worker-bundle.mjs`. Installed Miniflare4.20260601.0/workerd1.20260601.1, compatibilityDate2025-06-01/nodejs_compat, loads that bundle. gzip/deflate each reconstruct78,000 UTF-8 bytes exactly with stale encoding/length headers absent. This is parser integration, beyond a standalone DecompressionStream capability check.

Copy .txt probe files to their original extensions and update absolute source/dependency paths before rerunning. Initially scriptPath under /tmp hit a local workerd filesystem path error; reading the bundle as script text fixed probe initialization without changing application code. Worker cancellation/failure matrices are deterministic tests, not claims from this two-vector local runtime probe. Actual production CONNECT rejection and deployment behavior remain unverified.
