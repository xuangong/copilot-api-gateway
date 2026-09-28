# B05a2 serializer independent review

Reviewed HEAD `bc8dadf2`, 2026-09-29. Scope: the serializer brief, report, generated review patch, local upstream traversal/license, benchmark harness and recorded results. No product edits, installs, commits, broad source crawl, or repeated reported suites. Root separately owns clean aggregate CI and workerd acceptance.

## Verdicts

- Spec: **PASS** for this helper foundation. No blocking defect found in the assigned scope. This is not approval of provider adoption or a production performance claim.
- Quality: **PASS**, with one nonblocking regression-coverage recommendation below.

## Findings

### P3 — Preserve lifecycle boundary checks in committed tests

Paths: `vnext/packages/provider-llm/src/__tests__/json-body.test.ts` (abort/cancel test), `vnext/packages/provider-llm/src/__tests__/json-ext-traversal.test.ts` (escape fixtures).

The committed suite checks already-aborted and after-one-chunk aborts, but does not assert listener removal, a genuinely queued pending read, absence of eager/prefetch generation, or cleanup after generator failure. The fixed/seeded fixtures do not explicitly exercise all 32 control characters. These are named acceptance boundaries. Small isolated reviewer checks passed for both modes' completion/cancel/abort listener removal, queued pending-read rejection, snapshot no-eager/no-prefetch behavior, injected emitter-failure cleanup, and all U+0000..U+001F in keys and values. Preserve equivalent tests for future regression protection; this is a coverage durability recommendation, not evidence of a current functional failure.

The first scratch pending-read assertion incorrectly expected an already synchronously fulfilled first read to reject after abort. That assertion failed because the chunk had already been delivered. A second queued read establishes the genuinely pending case and correctly rejects. No product defect is inferred from the initial invalid probe.

## Contract assessment

- Unknown input goes straight to one native `JSON.stringify` call; no pre-probe, cloning, or eligibility logic. Construction failures remain synchronous and native thrown objects propagate. Only owned UTF-8 bytes survive for replay, with per-open copies.
- The text entry point validates primitive string, parses without reviver, creates a private frozen structural copy, measures exact bytes using the same generator, and exposes no trust token/root or mutable backing buffer. Infinity from parsed `1e400` and negative zero normalize correctly. The internal copier is not a provenance gate or proxy detector.
- Iterative ancestor tracking admits shared acyclic sources, rejects cycles, copies containers, preserves enumeration, safely defines `__proto__`, and normalizes undefined/hole/nonfinite cases. Its strict rejection of accessors/exotics is internal-contract enforcement; unknown public values still use native semantics.
- The escape algorithm uses native stringify on <=8193-unit slices and preserves surrogate pairs. Each escaped fragment is bounded by 49,158 bytes. Flush-before-copy and independent output ownership enforce the hard 65,536-byte chunk cap without whole escaped scalar/key allocation. Stack and Object.keys memory are input-dependent and disclosed.
- High-water mark zero, one generator step per pull, isolated iterators, and synchronous cleanup satisfy replay and cancellation ownership. Reviewer lifecycle probes passed as described above.
- The MIT notice is byte-identical to the local upstream LICENSE (`cmp` passed). The adaptation retains explicit state/stack, object/array progression and punctuation order; options, replacement and whole-key caching are removed. Provenance accurately names Git tag/commit/files and disclaims npm integrity verification.

## Evidence and limitations

The recorded JSON contains exactly 120 subprocess results: 15 oracle, 15 parse-only, 45 native and 45 candidate. A reviewer check confirmed every recorded candidate/native digest, length, declared length and maximum chunk against its corresponding oracle. The harness drains incrementally, uses independent oracle processes, keeps source text through drain, collects OS peak RSS, and records post-GC samples. These are inspected historical measurements, not measurements rerun by this review.

The report correctly states CPU regresses in every measured input and memory is nonuniform: all 1/10 MiB candidate peaks are higher, and 50 MiB lone-surrogate peak is higher despite improvements in other 50 MiB cases. Native factory excludes its separately timed parse while candidate factory includes parse/copy/measurement; total process CPU and total RSS include construction and all phases. The report discloses this distinction. Do not promote factory timings to an apples-to-apples serializer speed claim, or infer live retained object sizes from allocator RSS/Bun heap samples. No uniform memory improvement or production benefit is established.

Cannot independently verify here: execution history of the reported full focused suites, Git-source inspection performed by the writer, npm artifact integrity, or clean aggregate CI/workerd results. Local upstream source and notice were directly inspected. Provider lineage/revocation, transport/framing/backpressure, HTTP retries and real route adoption remain explicitly deferred.
