# C01 owner compatibility — independent review

## Verdicts

- **Specification compliance: PASS for this owner-configuration slice**, under root's explicit authenticated-owner-domain ruling below. Overall C01 remains partial pending Chat/Gemini disposition.
- **Code quality: PASS.** No actionable P0/P1/P2/P3 finding identified in the frozen change.
- Root owns integration approval, complete CI and frozen runtime acceptance. This review is not an independent rerun of those checks.

## Scope and evidence integrity

Reviewed the owner-compatibility brief first, implementation report, original C01 brief, production-next interfaces and final integration report (including its two correction rounds); read root/vnext AGENTS.md. Read the complete 1,101-line `task-C01-owner-compatibility-review.patch` once. Verified all 11 candidate files in `reference-adoption-verify` against `task-C01-owner-compatibility-frozen-sha256.json`: all match. Declared base is `c81370dfbad43577e044d51e2db2e8a5df14a1a2`.

Unchanged-source inspection was limited to named risks: real auth precedence and import ordering, retained-provider construction, dashboard merge preservation, generation fencing, and authenticated owner/candidate scope. No tests were rerun; no remaining code doubt warranted a diagnostic after these traces. No product/Git mutation or subagent delegation performed.

All paths below are relative to `vnext/`.

## Specification findings

| Requirement | Evidence and disposition |
| --- | --- |
| Strict optional model-scoped declarations, no global fallback | `packages/provider-llm/src/opaque-affinity.ts:25-48` reuses the strict declaration parser, enforces 512-character identifiers, snapshots/freezes map and values, and requires own-property lookup. Empty maps are preserved. `packages/provider-azure/src/config.ts:4-15` additionally validates surface-qualified keys. PASS. |
| Create/PATCH/import/retained validation | Custom normalization at `packages/provider-custom/src/config.ts:334`; Azure normalization at `packages/provider-azure/src/config.ts:32-54`; route normalization at `packages/gateway/src/control-plane/upstreams/routes.ts:244-250,439,485`; constructors at Custom `provider.ts:76` and Azure `provider.ts:94`. Import validates each declaration at `packages/gateway/src/control-plane/lib/import-export.ts:195-196`, before replacement deletes in `control-plane/data-transfer/routes.ts:60-81`. Plugin construction passes stored config to these constructors (`provider-custom/src/plugin.ts:8-12`, `provider-azure/src/plugin.ts:8-12`). PASS. |
| Exact executed model/deployment declaration | Custom `provider.ts:183-208` derives from raw payload model and attaches on prepare/capture; Azure `provider.ts:153-194` resolves deployment versus Anthropic body model and qualifies only declaration lookup by surface. Catalog multi-surface disagreement returns no declaration (`164-169`). Existing exact identity remains unchanged per root ruling. PASS. |
| Trusted catalog reconstruction only | `packages/gateway/src/data-plane/providers/registry.ts:155-184` constructs the binding and invokes only the trusted provider hook; arbitrary raw declaration metadata is not read. The new retained-SQLite tests at `tests/affinity/owner-compatibility.sqlite.test.ts:124-150` reopen storage and verify configured declaration versus no declaration despite malicious raw fields. No catalog revision bump is needed for this producer because the accepted hook runs during reconstruction. PASS. |
| Mutation authorization | `control-plane/upstreams/routes.ts:415,459,499` denies API-key create/PATCH/delete before loading/mutating state. Existing owner/admin checks follow. Real `session-auth.ts:51-64,86-125` preserves explicit-key precedence, emits `apiKey` for inference keys, and retains existing session/legacy user-key authority. Reads are unchanged. New real-SQLite authentication fixture at test lines `202-231` covers owned/assigned keys, all cookie combinations, denied cross-owner session edits and permitted owner/admin edits. PASS. |
| Configuration invalidation before selected inference | Shared repo `repo/shared/repos.ts:588-593,605-627` persists config changes; existing migration `migrations/0018_catalog_coordination.sql:30-38` advances generation for config/owner/enabled changes. Authority at `data-plane/providers/affinity-authority.ts:13-32` checks captured owner, incarnation, generation and enabled state against authoritative reads. Registry supplies authoritative repo at `registry.ts:94-96`. Providers preserve the pre-I/O guard. Test lines `88-94` check removal and zero additional I/O. PASS. |
| Ordinary UI edit preservation and export | Dashboard `apps/dashboard/src/tabs/upstreams/UpstreamFormModal.tsx:458-484` sends partial config; backend merge at `routes.ts:276-286` retains omitted declarations before strict normalization. `***` cannot bypass map validation. Public DTO `public-dto.ts:116-120` includes validated nonsecret declarations. Redacted export/import at `lib/import-export.ts:73-80,248-255` restores literal declaration map content after generic secret handling, avoiding secret-like model-name stripping and sentinel substitution. PASS. |
| Routing rank/required state/operator semantics | New tests at lines `152-200` cover exact-first, stable declared groups, optional degradation, native required-state unwrapping into actual provider fetch, scope/key mismatch, cross-upstream credential-scope mismatch, wrong carrier owner/key, and source immutability. Operator documentation `docs/opaque-compatibility.md:3-37` documents assertion risk, exact key shape, removal, authorization, and no cross-vendor interoperability claim. PASS. |

## Explicit authenticated-owner boundary

Root confirmed during this review that `scope: "owner"` means the authenticated API-key owner domain; it does **not** require identical `upstream.ownerId` values. The checked source supports exactly that contract:

- `data-plane/shared/affinity-request.ts:14-24` checks the stored key owner and constructs the codec for that owner/key. `shared/affinity/carrier.ts:48,54-57,79` cryptographically binds owner ID, API-key ID and key ID as AAD.
- Actual Responses and Messages selectors (`chat-flow/responses/attempt.ts:149-162`, `messages/attempt.ts:141-154`) enumerate owner/pin-scoped candidates before ranking. `routing/candidates.ts:71-88` does not enable `allOwners`.
- `providers/registry.ts:254-264,307-312` includes the request owner's private upstreams **and authorized global upstreams**; it excludes other private owners. Thus an explicitly matching declared group can bridge an owned upstream and an authorized global upstream. The target type has no upstream-owner field, and `provider-llm/src/opaque-affinity.ts:61-69` deliberately relies on prior authorization rather than independently enforcing row-owner equality.
- This does not grant another private owner's upstream, switch the request's API-key identity, bypass a pin, or make arbitrary equal strings an authorization mechanism. Admin all-owner catalog visibility is an optional registry capability, not passed by these actual inference selectors. Session requests without stable API-key identity do not activate this carrier path.

The operator documentation's “authorized upstreams” and original owner/API-key wording is consistent. This global/owned compatibility boundary is statically verified, but a dedicated global-versus-private runtime probe was not performed by this reviewer. Root will record the explicit ruling in acceptance evidence.

## Quality assessment and acceptance limits

The change is cohesive: declaration validation lives beside shared affinity semantics, Azure normalization is relocated without unrelated behavior changes, provider-owned execution resolution remains authoritative, and tests use temporary real SQLite rather than module/database mocks. The new map never derives authority from remote metadata, raw credential equality, vendor names or public aliases. No unsafe `any`, ignore directives, new migration, secret logging or provider-to-provider dependency was introduced in the inspected diff.

Implementation report states 335 regression tests / 1,277 assertions passed, four package typechecks and owned-file lint passed. Root separately reported frozen Bun HTTP 8 groups, workerd/D1 5 groups and Azure HTTP 3 groups passed, and full CI 4,814 pass / 1 skip / 0 fail with 35 inherited warnings. These are attributed reports, not executions or log audits performed by this reviewer.

Cross-task requirements not independently revalidated here: complete Responses/Messages JSON/SSE/durable continuation acceptance, socket cancellation/native SDK behavior, all framework/runtime gates, and pending Chat/Gemini adapters. They remain root-owned acceptance evidence and do not become verified by this scoped code review. No real upstream interoperability is claimed.

## Mechanical EOF follow-up — APPROVED

Read `task-C01-owner-compatibility-whitespace-proof.md` and independently compared the retained integration candidate snapshot of `vnext/packages/provider-azure/src/config.ts` against the live verify-checkout file. Exact byte equality confirms `live == snapshot[:-1]`: 2,819 bytes became 2,818 bytes, removing exactly one final LF from a double-LF ending and preserving one final LF. Old SHA-256: `f9fa019a38e7bfee4cae970be5761acc45257e9195c7409ec68860c53c89a199`; new SHA-256: `e0db0675edc6d63793efb99cace6124e2cdfaa0427b1961947e3bd1a4b800c9c`. No executable content changed. The prior specification and quality PASS verdicts stand. This follow-up performed no semantic re-review, tests or Git writes. Root reports the other 10 product files unchanged.
