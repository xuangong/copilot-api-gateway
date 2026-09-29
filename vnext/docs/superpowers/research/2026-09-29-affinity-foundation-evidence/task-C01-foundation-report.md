# C01 foundation package

Base: `f5f5769946889e738607933f20f9995daf6939c6` in isolated `reference-adoption-verify`.
Status: foundation implemented and frozen for independent review. Overall C01 is NOT complete. No commit, push, deployment, live credential/configuration access, or subagents were used by this implementer.

## Delivered contract

- `provider-llm/opaque-affinity.ts`: strict versioned `OpaqueCompatibilityDeclaration` (`version: 1`, nonempty bounded `key`, `scope: credential | owner`) and `AffinityExecutionTarget` (`provider`, `upstreamId`, `upstreamIncarnation`, `credentialSubject`, `credentialRevision`, exact executed `model`, optional compatibility). Parsers reject unexpected keys and invalid/missing identifiers. No alias/model-name/vendor-name inference. Exact target compares every execution-identity component. Credential-scoped widening preserves provider/upstream incarnation/credential subject/revision; owner-scoped widening requires matching explicit declarations on both sides and caller authorization first.
- Trusted catalog boundary: optional pure `LlmModelProvider.getOpaqueCompatibilityForModel(Readonly<BindingModel>)` supplies an explicit provider declaration. Registry validates it when rebuilding each binding, including bindings reconstructed from retained SQL catalogs. No provider currently implements the hook, so no interoperability is widened. Remote raw top-level or `providerData` declarations remain inert raw data. Hook producers must use trusted provider policy/validated owner configuration, never caller input or remote assertions. Owner-config producer wiring is deferred. `MODEL_CATALOG_REVISION` advances from 6 to 7. The declaration is reconstructed from the current trusted provider rather than serialized as authority in remote discovery JSON.
- Migration `0020_api_key_affinity_secret.sql`: nullable secret, key-id and version fields; existing API key values are preserved. Updated only the matching checked-in schema-baseline row through the repository's migration baseline regeneration workflow.
- `Repo.apiKeys.getOrCreateAffinitySecret(id, ownerId)` returns private `{ version: 1, keyId, secret: Uint8Array(32) } | null`. Conditional SQL update initializes all three columns only when all are NULL; an authoritative owner-scoped reread returns the concurrent winner. Ownerless/missing/foreign-owner keys return null. Invalid persisted state fails with a generic error, never silently resets. API key DTOs and existing column allowlists remain unchanged. Ordinary key metadata save/raw key rotation retains affinity material. No automatic secret rotation or global fallback identity is introduced.
- `gateway/shared/affinity/carrier.ts`: `AffinityCodec({ownerId, apiKeyId, version:1, keyId, secret})`, async `encode(value,target,{domain,block?},{synthetic?})`, async `decode(value,{domain,block?})`. Decoding returns exact foreign bytes or owned value/target/synthetic state. Prefix `vnext-affinity:` identifies gateway-owned framing, including unknown versions. Recognizable invalid state throws `InvalidAffinityStateError` (`invalid_affinity_state`), never becomes foreign. HKDF-SHA256/AES-GCM uses versioned domains; owner/key/key-id, protocol/item/field, companion content, and original opaque bytes are authenticated. Execution metadata and origin encoding are encrypted. Existing `common/opaque-value.ts` codec is reused unchanged, preserving all UTF-16 code units and canonical base64/base64url origins. Limits: 1 MiB original opaque bytes, 8192-byte trailer, bounded wire chars before generic codec decoding, bounded field/companion content; trailer is bounded before decryption.
- `gateway/shared/affinity/analysis.ts`: `analyzeAffinityRequest(protocol, body, codec?)` snapshots once and returns `classify(target)`, stable `rankAuthorizedCandidates(candidates,targetOf)` and fresh-clone `materialize(target)`. Only preauthorized candidates may be passed. No key codec preserves raw behavior. Incompatible required state yields `unavailable`/`AffinityRoutingUnavailableError` before invocation. Whole optional items/blocks can degrade; emptied assistant Messages are removed. Adjacent tool-use/tool-result thinking cannot safely degrade and rejects that candidate. Invalid markers always fail typed (including optional blocks). Only authenticated synthetic markers permit synthetic-item removal.
- `stampAffinityItem(protocol,item,target,codec)` is an isolated egress helper. It must receive finalized provider-call execution identity, never requested/public aliases. It is not invoked by production paths in this package.

## Implemented protocol analysis scope

Responses top-level `input`: reasoning `encrypted_content` optional; compaction, compaction_summary, context_compaction `encrypted_content` required with canonical compaction domain; program/program_output `encrypted_content` and `fingerprint` required when present. Visible companion fields are authenticated, excluding mutable item IDs and type aliases. Messages: thinking `signature` plus complete thinking text; redacted_thinking `data`; protocol-valid whole-block removal with conservative tool adjacency rejection. Domains do not bind unstable array indexes.

## Explicit remaining work / production nonactivation

No active selector, attempt recursion, provider invocation, JSON/SSE responder, storage bridge, or continuation expansion calls these helpers yet. Existing routes therefore do not stamp, analyze or remove production opaque state. This package provides no full API end-to-end continuation guarantee. API-key secrets are lazy and no production caller initializes them yet. Current provider metadata hooks are all absent.

The next integration package must derive incarnation and credential identity from actual selected/executed provider calls, resolve policy/pins first, carry analysis through recursive translation, create a fresh payload per attempt, unwrap immediately before provider input, stamp actual JSON/SSE output after execution selection, and persist authenticated representations before durable continuation. It must audit nested `agent_message` opaque fields and any unrepresented program-output continuation slots, preserve A14 plaintext compact expansion ordering, and test alias/direct equivalence, pins, cross-protocol SSE/JSON roundtrips, tool sequences and immediate durable history. Chat/Gemini carrier adapters remain a separate package. Custom/Azure owner configuration declarations remain unimplemented, and no global OpenAI compatibility exists.

## Verification performed by implementer

- Red-first tests observed missing carrier/module/method/projection exports before implementation.
- `bun test ./vnext/packages/gateway/tests/affinity ./vnext/packages/provider-llm/src/__tests__/opaque-affinity.test.ts`: **13 passed**, 103 assertions. Full UTF-16 code-unit roundtrip, base64/base64url/raw, foreign preservation, wrong owner/key/secret/domain/block/tampered marker, bounds/version failures, strict metadata, replacement rejection, required conflicts, aliases, whole-block removal, synthetic ownership, immutable attempts, trusted catalog projection, real two-connection temporary SQLite concurrent initialization and retained catalogs.
- Related migrations, API-key route/helpers, catalog repository/maintenance and shared-provider-state suite: **103 passed**, 378 assertions (six files). Migration baseline initially reported expected schema drift after new migration; regenerated and reran successfully.
- Gateway and provider-llm package typechecks: **passed**.
- `git diff --check`: **passed**.
- No new `any`, mock.module, type suppression or unexplained non-null assertion.
- Root owns independent review, full CI, Bun/workerd/D1 acceptance and evidence. Root reported mutable runtime/analysis acceptance success, but these are not represented as implementer-run or frozen acceptance here. Root evidence-only docs are excluded from this package's product manifests.

## Owned product files

- `vnext/packages/gateway/migrations/0020_api_key_affinity_secret.sql`
- `vnext/packages/gateway/src/data-plane/providers/registry.ts`
- `vnext/packages/gateway/src/repo/affinity-secret.ts`
- `vnext/packages/gateway/src/repo/shared/repos.ts`
- `vnext/packages/gateway/src/repo/types.ts`
- `vnext/packages/gateway/src/shared/affinity/analysis.ts`
- `vnext/packages/gateway/src/shared/affinity/carrier.ts`
- `vnext/packages/gateway/tests/affinity/analysis.test.ts`
- `vnext/packages/gateway/tests/affinity/carrier.test.ts`
- `vnext/packages/gateway/tests/affinity/catalog.sqlite.test.ts`
- `vnext/packages/gateway/tests/affinity/secret.sqlite.test.ts`
- `vnext/packages/gateway/tests/schema-baseline.txt`
- `vnext/packages/provider-llm/src/__tests__/opaque-affinity.test.ts`
- `vnext/packages/provider-llm/src/binding.ts`
- `vnext/packages/provider-llm/src/index.ts`
- `vnext/packages/provider-llm/src/opaque-affinity.ts`
- `vnext/packages/provider-llm/src/types.ts`
