# B05 serializer dependency evaluation (2026-09-29)

## Decision

`@discoveryjs/json-ext@1.1.0` is a useful structural JSON serializer, but `stringifyChunked()` is **not adequate as-is** for B05a's bounded-byte output or full native `JSON.stringify` compatibility. Do not claim bounded request memory merely by setting `highWaterMark` or splitting its yielded strings afterward. A localized upstream/fork adaptation for scalar and key emission, plus a compatibility gate/fallback, is required before using it for the replayable request factory. Incremental hashing of already-owned JSON remains independently deliverable while this is unresolved.

## Provenance and reproducibility

- Reference dependency: `/Volumes/Projects/copilot-gateway/packages/provider/package.json` pins `@discoveryjs/json-ext` to `1.1.0`; its `pnpm-lock.yaml` records npm integrity `sha512-Xc3VhU02wqZ1HvHRJUwL09HkZSTvidqY5Ya0NXBSYOxAp+Ln9dcJr9fySI+CkONzP3PekQo9WdzCv0PGER/mOA==`.
- Primary source: upstream [v1.1.0 Git tag](https://github.com/discoveryjs/json-ext/tree/v1.1.0), commit `bfc88518775c0a587bc1d119ea7daa6f97060858`; [package manifest](https://github.com/discoveryjs/json-ext/blob/v1.1.0/package.json) and [MIT license](https://github.com/discoveryjs/json-ext/blob/v1.1.0/LICENSE). An isolated shallow Git checkout is at `/tmp/b05-json-ext-eval/upstream`. Its `src` ESM files were tested directly, not copied into the product.
- The npm registry metadata/tarball endpoint failed with `curl: (35) Recv failure: Socket is not connected`, so the npm artifact itself and its lock integrity were **not independently verified**. No dependency installation or lockfile edit was attempted.
- Reproduce with `node /tmp/b05-json-ext-eval/probe.mjs` and `bun /tmp/b05-json-ext-eval/probe-bun.mjs` (Bun 1.3.0). Scratch probes and upstream checkout are outside the repository and may be temporary.

## Source findings and observed behavior

The [upstream serializer](https://github.com/discoveryjs/json-ext/blob/v1.1.0/src/stringify-chunked.js) turns each string into one complete escaped string with `JSON.stringify(value)` when escaping is needed (lines 3–9), then appends that entire scalar to `buffer` (lines 137–141). The generator checks `buffer.length >= highWaterMark` **after** each traversal step (lines 41–48); this is UTF-16 code units, not encoded bytes. Keys are also escaped and cached in whole strings (lines 17 and 100–107). Thus a long field value or key is unbounded relative to the configured watermark, and escaped copies exist before yielding.

With `highWaterMark: 64 * 1024`, the isolated probe observed:

| Input | Largest yielded string | Largest individually encoded chunk | Native JSON bytes equal? |
| --- | ---: | ---: | --- |
| `{s: "x".repeat(1 MiB)}` | 1,048,583 UTF-16 units | 1,048,583 bytes | Yes |
| `{s: "\\n".repeat(1 MiB)}` (source string contains newlines) | 2,097,159 units | 2,097,159 bytes | Yes |
| `{s: "😀".repeat(512 Ki)}` | 1,048,583 units | 2,097,159 bytes | Yes |

The Bun probe compared `TextEncoder` bytes from each emitted chunk against `TextEncoder.encode(JSON.stringify(value))` for 1,000 deterministic random JSON-only trees (numbers including `1e21`, key-order variations, nested arrays/objects, paired and lone surrogates). It found zero mismatches. Focused cases also matched native output for `-0`, nonfinite numbers, sparse arrays, boxed primitives, escaped controls, and array function/symbol/undefined substitution. This supports use on constrained plain JSON data, but does not prove universal equivalence.

The [value replacement logic](https://github.com/discoveryjs/json-ext/blob/v1.1.0/src/utils.js#L12-L37) calls `toJSON()` without the native `key` argument. Observed differences: `{inner: {toJSON(key) {return key}}}` serializes natively as `{"inner":"inner"}` but this library emits `{}`; a root `toJSON(key)` returning `key` serializes natively as `""` but the library emits `null`. Top-level `undefined`, functions, and symbols have no native JSON string but the library emits `null`. Native circular/BigInt failure behavior needs explicit error-path verification at the application boundary; the small probe did not establish identical error messages or side-effect ordering. For application bodies, reject top-level no-representation values and use the design's one-time native stringify compatibility path for accessors, custom `toJSON`, proxies, or other non-plain data.

Each current emitted chunk is complete at a value boundary, so its `TextEncoder.encode(chunk)` does not split an original surrogate pair across chunks. A future bounded scalar adaptation must retain that property. Directly encoding the two UTF-16 halves of `😀` yields two replacement sequences (`EF BF BD` twice), while encoding the pair yields `F0 9F 98 80` in Bun. Lone surrogates must continue to be emitted using native JSON's `\\udxxx` escape. The watermark must be enforced on actual UTF-8 bytes; `buffer.length` is insufficient even for bounded scalar segments.

## Narrow adoption path

1. Keep the library's object/array traversal rather than writing a new JSON grammar. Adapt scalar **and key** emission so `JSON.stringify` is applied to bounded UTF-16 slices (preserving pairs at slice boundaries), and flush before the encoded output exceeds the 64 KiB target apart from a documented small escape/code-point allowance. Do not first build a complete escaped scalar or key. Remove/limit its whole escaped-key cache for large keys. Verify actual chunk-byte maxima for long ASCII, control-heavy, multibyte and lone-surrogate inputs.
2. Use this path only after making an immutable snapshot of ordinary JSON data with own enumerable data properties. For exotic values, call native `JSON.stringify` once, retain its bytes for retries, and label that path buffered. Never evaluate stateful getters/`toJSON` separately for length and replay. Reject top-level no-representation values before hashing or dispatch.
3. Measure content length from the exact emitted byte iterator, then differential-test bytes, stable replay, failure timing, 1/10/50 MiB bodies, and independent-process peak/RSS. A wrapper that merely cuts already emitted giant chunks improves transport chunk size but **does not** solve the library's peak allocation.
4. If adopted, declare the dependency directly in the package and update `vnext/bun.lock` under normal implementation work; the reference project's pin and lock entry are not a vNext declaration.

This evaluation made no application, dependency, lock, live-data, or deployment change.

## Follow-up: provenance is the fast-path gate

`Object.getPrototypeOf()`, `Object.getOwnPropertyDescriptors()`, `Array.isArray()`, and property reads cannot certify that an arbitrary JavaScript value is free of `Proxy` traps. A proxy around a plain object can present ordinary descriptors/prototypes; the checks themselves may execute traps. Therefore the optimized snapshot contract must be **provenance-based**, not advertised as a portable `isPlainJson(value)` detector. Unknown programmatic `ProviderRequest.payload` values default to native `JSON.stringify` once at the final serialization boundary, retaining that one result for all retries. The fallback must not first walk properties to decide eligibility, or invoke getters/`toJSON` again while measuring length or opening a replay stream.

The concrete inbound seam is `packages/gateway/src/data-plane/chat-flow/responses/http.ts` (likewise messages/chat/gemini `http.ts`): `openRequestDump` yields bytes and `parseJsonBody` in `packages/http/src/body.ts` calls `JSON.parse`, producing a JSON data tree. `packages/gateway/src/data-plane/parsers.ts` largely preserves request fields without schema rewriting; Responses canonicalization and `responses/serve.ts` pre-processing may rewrite/expand input. The provider boundary is broader: `packages/provider-copilot/src/provider.ts:fetch` accepts `ProviderRequest.payload`, runs an interceptor chain that mutates it, and `forward.ts:callCopilotAPI` currently stringifies the final payload; `packages/provider-codex/src/fetch.ts` builds a final body with spreads and new metadata before stringifying. A final value is eligible for optimized snapshot only when its route-origin JSON provenance and **every** intervening transformation are explicitly audited as producing JSON data from JSON data. Use an internal, opt-in provenance token/typed entry point carried through that controlled pipeline; invalidate it when an unknown extension or external provider caller supplies/replaces values. TypeScript `Record<string, unknown>` and post-hoc descriptor checks are not that proof. If an interceptor's behavior is uncertain, take the single native-buffered fallback. This bounds the claim to trusted gateway-generated payloads, while preserving native behavior for arbitrary provider API inputs.
