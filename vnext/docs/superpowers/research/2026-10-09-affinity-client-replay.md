# Native Responses history replay: empty reasoning content

## Failure and evidence

Continuing an existing native client session against local Docker returned HTTP 400 with `Invalid authenticated opaque state`. The deployed source was based on `fd6dccd9`. Five local `/responses` failures completed in 8–44 ms.

Read-only validation of persisted client items reproduced two failures without invoking an upstream or editing the session:

- A v2 synthetic reasoning origin authenticated successfully with the current API Key. Ingress rejected its client-added `content: null` and `internal_chat_message_metadata_passthrough: { turn_id: ... }`. Removing internal metadata alone still failed; also removing null content passed.
- A v1 native reasoning item failed with its persisted companion shape, which omitted `content`. The original carrier authenticated against the exact legacy companion `{"content":[],"summary":[]}`. The client had omitted the empty array, so byte-oriented companion comparison rejected semantically equivalent history.

This was a gateway representation-compatibility defect. Key loss and upstream opaque decryption were not the cause of these reproduced failures. Diagnostics retain only field shapes, counts, and boolean validation results; no prompts, native ciphertext, API keys, or decoded execution identities were copied into evidence.

The reference project already covers a synthetic Responses reasoning item with `content: null` in `packages/gateway/__tests__/data-plane/chat/openai-responses/affinity/ingress_test.ts`. Its broad synthetic removal is not copied: vNext continues to verify that no real reasoning content would be removed.

## Contract adjustment

- Authenticated synthetic Responses origins permit absent, null, or empty-array `content`, plus absent, null, or object-valued native transport metadata. The summary must remain empty. Unknown fields, nonempty content, malformed transport metadata, invalid identity fields, and failed cryptographic authentication remain errors.
- Native v1 Responses reasoning issuance retains its exact companion binding so existing readers can still read newly issued carriers. Other companion fields and all nonempty content remain bound unchanged.
- Reading a v1 carrier tries its supplied representation first. Only after failure, for a reasoning item with semantically empty content, may it authenticate the other two empty spellings (absent, `[]`, or `null`). Alternatives are constructed lazily; ordinary requests and exact matches perform no fallback decryptions. A client-normalized native item may require up to two additional authentication attempts; preserving the existing wire contract takes precedence over changing the signing format.
- This changes no carrier version, secret, database schema, upstream policy, or stored history. Foreign opaque values remain foreign. Native values are unwrapped intact, and synthetic origin removal still requires authenticated `syntheticItem` provenance.

## Regression coverage

Tests reproduce client serialization at both the analysis boundary and real Bun HTTP/SQLite request handling. JSON and SSE replay retain the native reasoning item, remove only the synthetic prefix, and still reject another Key before upstream invocation. Negative cases reject nonempty content and malformed metadata.

The new origin/HTTP tests first failed against the deployed behavior (3 failures), and the legacy-native test also failed after the origin-only repair. A rollback-reader check guards exact v1 issuance. Read-only validation accepted both v1 and v2 persisted client items after the repair while preserving their respective native-state routing and origin-only semantics.

The previous Docker smoke replayed the returned output array directly. It verified the gateway's own serialization but missed client-added null/metadata fields and omitted empty arrays. The new regression explicitly covers that intermediate client transformation.

All 224 affinity tests pass. The full 607-file suite passes with 6,686 tests and 2 skips, followed by successful lint, UI build, and Workers dry-run; purity and all typechecks also pass. The qualified run uses a 15-second per-test timeout without changing test assertions or repository configuration. Two earlier default-timeout CI attempts are retained: one encountered the existing service-proof test's wall-clock second boundary, and the other timed out in the unrelated 1,001-key SQLite accounting test (9.27 seconds versus the default 5-second limit). The service-proof file passed separately, and both cases passed in the qualified full run.

A real `gpt-6-astra` probe against the old local image returned HTTP 200 initially and the exact opaque-state HTTP 400 on client-normalized replay (21 ms). A second probe explicitly requested encrypted reasoning, but that simple low-effort response emitted only v2 provenance; native-v1 coverage therefore comes from the actual saved carrier and the real HTTP/SQLite regression, rather than claiming an unobserved upstream output.

Full CI, local image identity, deployment backups, and real model replay results are recorded in `.superpowers/sdd/2026-10-09-affinity-client-replay/` at the repository root. This repair does not authorize or imply a Cloudflare Workers or SSH deployment.
