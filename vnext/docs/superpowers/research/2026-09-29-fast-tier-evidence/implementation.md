# C05 — Fast tier catalog, dispatch, output, and exact execution pricing

Status: frozen for independent root review, full CI, runtime rerun, and protected integration. No commit, push, deployment, live configuration, database migration, or subagent was performed by this writer.

Base: `791cc553a1860acc4ea2207ccf5051a5869764af`.
Writer checkout: `/Volumes/Projects/copilot-api-gateway/.worktrees/reference-adoption-verify` only. Main and reference-adoption product files were not edited. The three C05 report/manifests are written in the designated scratch directory.

## Behavior

- `copilotVariantIndex` is the shared catalog-family source for listing and dispatch. Fast requires a real raw base sibling or the reference's existing canonical Claude family exception; no extra exception or inferred pricing multiplier was added. `grok-code-fast` without `grok-code` remains its own ordinary model.
- `selectCopilotVariant` honors supported wire endpoints, explicit suffixed/date raw pins, effort capabilities, and context constraints. Only Messages/Responses/chat-completions can select a Fast lane. Count-tokens, embeddings, and image selectors do not acquire one.
- Provider dispatch resolves before stripping unsupported speed/service_tier wire fields; the existing Responses stripping interceptor remains. Each fetch creates its own variant interceptor closure and freezes `{modelKey, serviceTier}`. Native auth retry resends the already-prepared request and returns this call-local execution identity only after successful completion.
- A missing Fast lane is a Messages `invalid_request_error` (400), including Messages translated through Responses. Responses priority is best-effort and reports actual default on fallback. Responses provider requests now carry the already-derived original sourceProtocol, fixing a previously omitted provenance field.
- Gateway typed LLM identity carries `executedServiceTier` next to the existing locked `executedModelKey`. Parsed JSON/SSE frames receive actual selected tier; traversal retains the hint into the provider and projects actual selection onto the source protocol. No execution metadata means no fabricated output marker. The former request-based Messages speed interceptor now preserves the hint. Messages JSON reassembly retains speed/service_tier.
- Exact selected raw pricing keys use the previously accepted SourceStreamState/usage foundation. Existing Opus 4.8 base 5/25 and Fast 10/50 pricing rows are reused unchanged. No price row, multiplier, availability assumption, or long-context billing change was added.
- Codex service_tiers comes from the selected upstream native endpoint's known lane (Responses first, then Messages/chat translation). Bundled speed claims and additional_speed_tiers cannot establish account availability. Existing alias catalog test now expects no Fast where no upstream evidence exists.

## vNext listing adaptation

Unlike the reference's single collapsed public row, vNext's existing registry uses each listed raw row as its executable binding. Removing sibling rows would remove explicit raw pins and their distinct endpoint capabilities. Therefore listing retains these rows, original `name` and `display_name`, and adds `variant_family`, `variant_models` (including raw IDs and both labels), and endpoint-specific `service_tiers` from the same index used by dispatch. Pinned ordinary variants do not promise a switch to Fast. A canonical Fast-only Claude family additionally gets a public-family row; the provider is still seeded with the original authoritative raw catalog. Existing mergeClaudeVariants also groups through the shared index. Disabled-public-family filtering reads the same family identity.

## Verification

- Initial new API tests were written before implementation and failed on missing exports/modules. Subsequent behavioral red/green regressions were observed for Fast-only default selection, pinned catalog availability, Messages JSON speed preservation, Codex translated native endpoint availability, and original Messages provenance in Responses dispatch.
- Focused Bun suite: **217 pass, 0 fail, 709 expectations, 26 files**. Command: `bun test vnext/packages/provider-copilot vnext/packages/gateway/src/data-plane/chat-flow/shared vnext/packages/gateway/tests/data-plane/chat-flow/shared/provider-call-context.test.ts vnext/packages/gateway/tests/data-plane/codex`. Log: `/tmp/c05-final-tests.log`.
- Entire vNext workspace `bun run --cwd vnext typecheck`: pass. Log: `/tmp/c05-final-typecheck.log`.
- `bun run scripts/check-framework-purity.ts` from vnext: pass.
- ESLint on all owned TypeScript paths: exit 0, no errors. Existing unused SourceFrame warning at traverse-translation.ts:57 remains; no suppression was added.
- `git diff --check`: pass.
- Root independently reported all 15 mutable loopback runtime cases passing: native/cross-protocol JSON/SSE, missing-lane zero-dispatch errors, actual default fallback, raw pin, auth retry identical bytes, and real SQLite exact Fast model/prices. Root-owned evidence `/tmp/vnext-c05-mutable-runtime-3.out`; writer has not substituted this report for root's required frozen rerun.

## Boundaries and handoff

No live supported catalog or live external provider was queried, so this establishes implementation/fake-catalog correctness, not production availability or refreshed external pricing. Unknown token counters are not synthesized by the new tier helper; zero counters are preserved. C01 authenticated carriers, C07 Lite handling, C10 context-tier billing, and unrelated user changes remain outside scope. Full CI and final frozen runtime acceptance belong to root.

Owned product/test paths are the plain JSON array in `task-C05-owned.json`; exact frozen bytes are the plain SHA-256 map in `task-C05-frozen-sha256.json` (21 paths). Root must preserve protected dirty deltas during integration according to protected-integration-design.md.


## Fix round 1 — I1 / I2

Status: refrozen at the same base `791cc553a1860acc4ea2207ccf5051a5869764af`, now **23 owned paths**. Initial frozen evidence remains in root's task-C05-initial-* and task-C05-fix1-before snapshots. Only four paths changed in this round: provider-copilot variants.ts and fast-tier.test.ts, plus gateway tests messages.e2e.test.ts and gemini.e2e.test.ts.

I1: verified that the new selector's early endpoint exclusion had removed pre-existing ordinary count-tokens context/effort resolution. The count-tokens branch now excludes Fast candidates, preserves exact raw pins, and delegates ordinary selection to the existing resolver, with no execution tier. Three provider-level tests inspect actual outbound wire model and context-beta removal for (1) context header, (2) effort-only payload, and (3) a non-raw composite model ID. Each fixture includes a capable Fast sibling and requests speed fast, proving it does not select that lane or add execution metadata. The context test also proves the allowed context-management beta survives. All three tests failed before the fix (sent base instead of the expected ordinary variant), then passed.

I2: followed the explicit root ruling after checking the fixtures: all five mappings/raw requests identify existing exact MODEL_ID `claude-3-5-sonnet-20241022`. Changed only the five capturedUpstreamModel expectations to MODEL_ID and updated one explanatory comment. Captured outbound-model assertions, fixture catalog, auth, capabilities, and counter checks remain intact. No product rollback or weakened assertion.

Fix verification:

- `bun test vnext/packages/provider-copilot/src/__tests__/fast-tier.test.ts vnext/packages/gateway/tests/messages.e2e.test.ts vnext/packages/gateway/tests/gemini.e2e.test.ts`: **25 pass, 0 fail, 99 expectations**, 3 files. Log `/tmp/c05-fix1-focused.log`.
- Red evidence: `/tmp/c05-fix1-red.log`, **9 pass, 3 fail** on the three newly added wire-model assertions.
- Entire workspace `bun run --cwd vnext typecheck`: pass, `/tmp/c05-fix1-typecheck.log`.
- ESLint on the four round-1 paths: exit 0, no code warnings/errors; inherited multi-project resolver informational message only.
- Framework purity and `git diff --check`: pass.
- Root independently reported its extended 17-case actual HTTP/SQLite runtime passing, including count-tokens context/effort wire IDs and absent execution tier; `/tmp/vnext-c05-fix1-mutable-runtime.out`. Final frozen runtime/full CI remain root's gates.

The plain owned array and SHA-256 map were refreshed. All 19 initially owned paths outside the two modified provider files remained byte-identical to the prior frozen manifest. No protected product files, commit, push, deployment, live configuration, or subagents were touched.
