# C01 foundation task review

## Spec compliance

- ✅ **Spec compliant for the explicitly frozen foundation package.** Reviewed the supplied 17-path patch once against `task-C01-brief.md` and its foundation execution supplement, at base `f5f5769946889e738607933f20f9995daf6939c6`. No production activation or overall C01 completion is asserted.
- ✅ New nullable migration preserves existing rows; initialization is owner-scoped, cryptographically random, conditional on all three private columns being NULL, and followed by an authoritative reread. Partial/invalid stored material fails instead of silently rotating: `vnext/packages/gateway/migrations/0020_api_key_affinity_secret.sql:2`, `vnext/packages/gateway/src/repo/affinity-secret.ts:11`.
- ✅ Carrier cryptographically authenticates original opaque bytes and owner/key/key-id/domain/companion content; encrypted metadata holds origin and strict execution target. Marker/version/authentication failures remain typed invalid state: `vnext/packages/gateway/src/shared/affinity/carrier.ts:40`, `:52`, `:72`.
- ✅ Compatibility requires explicit matching declarations; exact matching includes provider, upstream incarnation, credential subject/revision and executed model. Credential scope cannot cross replacement identities; owner scope intentionally requires caller authorization first: `vnext/packages/provider-llm/src/opaque-affinity.ts:30`, `:36`, `:45`.
- ✅ Registry obtains declarations only from the trusted provider hook, strictly reparses them, and bumps catalog revision to 7. Arbitrary discovered top-level/nested fields are not promoted: `vnext/packages/gateway/src/data-plane/providers/registry.ts:175`, `:183`; `vnext/packages/provider-llm/src/types.ts:111`.
- ✅ Analysis snapshots input, stably orders preauthorized candidates, rejects incompatible required state and returns independent materializations. Messages degradation removes entire thinking/redacted blocks and emptied assistants; tool adjacency is conservatively unavailable: `vnext/packages/gateway/src/shared/affinity/analysis.ts:70`, `:106`, `:122`, `:135`.

## Strengths

- `vnext/packages/gateway/src/shared/affinity/carrier.ts:72`: recognizable invalid state never takes the foreign fallback; only truly foreign values retain raw behavior. The outer size check bounds allocations before generic trailer decoding, and trailer/payload checks precede decryption.
- `vnext/packages/gateway/src/shared/affinity/analysis.ts:36`: thinking text is bound alongside signatures; Responses companion content is canonicalized, while compaction aliases share a deliberate domain. `:145` removes blocks in descending path order, avoiding index-shift corruption.
- `vnext/packages/gateway/tests/affinity/carrier.test.ts:10`, `vnext/packages/gateway/tests/affinity/analysis.test.ts:9`, `vnext/packages/gateway/tests/affinity/secret.sqlite.test.ts:21`: tests exercise all UTF-16 code units, key/owner/domain/content tampering, independent retry payloads, whole-block projection, and actual two-connection SQLite conditional initialization without database mocks.
- `vnext/packages/gateway/tests/affinity/catalog.sqlite.test.ts:22`: catalog tests explicitly distinguish trusted declarations from malicious raw declarations and verify the persisted-catalog projection boundary.

## Issues

- Critical: none found.
- Important: none found within the foundation scope.
- Minor: no actionable implementation finding. Additional boundary coverage is useful for the later integration package but is not a reason to block this foundation.

## Concrete checks and evidence boundary

- Read `task-C01-brief.md`, `task-C01-execution-brief.md`, `task-C01-foundation-report.md`, the reviewer prompt, and root/vnext AGENTS instructions. Read the supplied patch once in sequential halves. No Git commands, product edits, index/HEAD mutations, live credentials, or test suites were run by this reviewer.
- Named external risk: the reused generic opaque codec might disagree with carrier framing or normalize raw strings. Focused inspection of `vnext/packages/protocols-llm/src/common/opaque-value.ts:47`, `:65`, `:76`, `:130` confirms canonical base64/base64url handling, the two-byte trailer-length field, and raw UTF-16 code-unit preservation. The carrier 8192-byte trailer limit is below the generic 65535-byte limit. Its wire bound includes base64 expansion and framing.
- Named external risk: ordinary repository reads/saves might leak or reset added private fields. Focused inspection of unchanged API-key SQL regions in `vnext/packages/gateway/src/repo/shared/repos.ts:59`, `:377`, `:395` confirms explicit column allowlists and an upsert update list that omit affinity fields. This was an inspection of unchanged contract context, not a second pass over changed hunks.
- Implementer reports 13 affinity tests / 103 assertions, 103 related tests / 378 assertions, package typechecks and diff checks. These are reported results, not independently rerun results. The report describes an expected schema-baseline regeneration followed by passing verification; no unresolved warning or error is reported. Full CI and frozen Bun/workerd/D1 runtime acceptance remain controller-owned.

## Cross-task boundaries

- ⚠️ Active selection, authorization/pin ordering, execution-identity derivation, translated recursion, JSON/SSE egress, cancellation, retention/storage and durable continuation are not verifiable from this foundation diff. The helpers document their call-site preconditions; later integration must prove them before activating affinity in production: `vnext/packages/gateway/src/shared/affinity/analysis.ts:60`, `:99`, `:104`; `vnext/packages/provider-llm/src/opaque-affinity.ts:45`.
- ⚠️ Owner-scoped widening is safe only when both declarations come from deliberately trusted policy and candidates are already restricted to the authenticated owner/key. No provider currently supplies the hook according to the frozen report; validated Custom/Azure owner-configuration producers are deferred. Do not derive these declarations from `BindingModel.raw`: `vnext/packages/provider-llm/src/types.ts:111`, `vnext/packages/gateway/src/data-plane/providers/registry.ts:175`.
- ⚠️ Top-level Responses and Messages blocks are the supported analysis slice. Nested agent-message/program-output slots, Chat/Gemini adapters, cross-protocol transfer of authenticated companion content and tool-sequence translator acceptance require their own subsequent package evidence. Whole-block removal here is deliberately conservative: `vnext/packages/gateway/src/shared/affinity/analysis.ts:36`, `:70`.

## Assessment

**Task quality: Approved for the frozen foundation package.**

The change provides a bounded authenticated carrier, conservative explicit compatibility contract and private conditional secret initialization with clear separation from provider dispatch. No blocking correctness or maintainability defect was identified in this task scope; this verdict does not approve production activation or declare C01 complete.
