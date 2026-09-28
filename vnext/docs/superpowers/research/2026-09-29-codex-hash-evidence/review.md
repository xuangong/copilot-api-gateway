# B05a1 independent spec and quality review

- Reviewed base: `b58ad7ff89ee1917607ee0e441366983f65940c5`.
- Spec: **PASS**.
- Quality: **PASS**, with one non-blocking test coverage note below.
- Scope: the eight files in the prepared `task-B05-hash-review.patch`, read once, plus the brief, report, foundation context and benchmark scripts. Root and vNext AGENTS were read. Unchanged identity/seed selection code was inspected narrowly to check precedence and null fallback. No product edits, installs, commits, broad source crawl, or repeated suites.

## Findings

No blocking correctness or quality finding.

**Low — explicit getter-count regression fixture is absent.** `vnext/packages/provider-codex/src/__tests__/provider.integration.test.ts:272` tests stateful `toJSON` execution, but the new fixtures do not separately exercise a stateful getter as requested by the brief. The implementation retains exactly one direct native seed `JSON.stringify` call and introduces no traversal/probe, so this is a coverage gap rather than evidence of changed behavior. A small enumerable nested content getter fixture asserting one seed access plus the existing body-serialization access would close the gap. Do not change serialization to address this note.

## Spec assessment

The actual Codex identity caller now passes the instructions, literal U+0001 and one native seed serialization into the hybrid helper. The only production caller change is that hash invocation. Seed selection, instructions defaulting, metadata/header override order, fallback UUID and body serialization are untouched. The existing public string helper remains WebCrypto-based with identical UUID formatting.

The inclusive 2 Mi UTF-16-unit fast path implements the final ruling. Larger inputs avoid a combined text/UTF-8 buffer and use a declared, already locked noble dependency. The length scan stops once over the threshold without affecting branch correctness. The direct dependency and lock changes are limited to the provider-llm declaration; installation/frozen-lock outcomes are writer-reported evidence, not independently rerun here.

The encoder preserves pairs within chunks and across parts, carries a terminal high surrogate through empty parts, and correctly emits replacement bytes when a following unit is not low. Pending surrogate state, digest state and byte accounting belong to each invocation. The shared TextEncoder has no stream state. For production, the string parts array is created locally and its strings are immutable, so yielding does not expose mutable seed objects to incremental traversal. The maximum encoding input is 16,385 UTF-16 units and the stated worst-case 49,153 output bytes is consistent with the boundary-extension logic. Timer yields occur after roughly 1 MiB, with bounded chunk overshoot.

The tests are meaningful: independent WebCrypto bytes and frozen UUIDs, direct raw incremental coverage despite the small fast path, adversarial surrogate partitions, exact threshold path selection, concurrent isolation, timer delivery and an actual large outgoing session header. Error and tail/override fixtures exercise provider behavior rather than only helper output. The getter-specific omission above is non-blocking because native serialization is retained without probing.

## Performance and validation boundary

The reported 10/50 MiB runs show a substantial RSS reduction and approximately 5x total hash wall-time cost. This is an explicit accepted tradeoff under the timing and bounded-small-input rulings, not an unexplained performance regression. The synchronous native stringify remains unbounded and can delay the first timer; report caveats correctly distinguish RSS, live retained objects and production concurrency. Benchmark scripts include stringify, use the actual final helper, and measure timer delay/gaps; the small benchmarks select WebCrypto as intended.

I did not rerun the reported 88-test suite, lint, typechecks or benchmarks, and make no independent runtime-pass claim. Root still owns final clean aggregate CI, workerd runtime verification and final measurements. This review approves the frozen implementation on its task-scoped merits; it does not approve deployment or claim completion of later serializer/replay/provider streaming packages.
