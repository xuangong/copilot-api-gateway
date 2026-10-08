# Diagnostic cost and ownership audit

Date: 2026-10-08. This is source evidence, not measured allocation, CPU attribution, or a peak-memory claim. Product inputs are the frozen B manifest used by the accompanying observer experiment. A is `e660fb4d`; R is `1d7dcd92`.

## What B already does

References are relative to `vnext/packages/gateway/src/`.

| Stage | Existing behavior | Contract that must survive optimization |
| --- | --- | --- |
| Ingress | `shared/dump/request-body.ts` reads bytes once; accumulator begins request gzip early | Shared ingress, borrowed-input mutation snapshot, preparation lifetime |
| Upstream observation | `shared/dump/upstream-attempts.ts` bounds prefixes and forwards original chunks through a zero-high-water-mark pull wrapper | No second consumer; exact EOF versus cancel/error/not-consumed; bounded redacted metadata |
| Canonical capture | `shared/dump/capture-budget.ts` projects descriptor-safe owned JSON containers, sharing immutable strings | Getter/toJSON must not run; reject cycles/unsupported graphs; later caller mutation cannot rewrite history |
| Terminal transfer | `shared/dump/accumulator.ts` clears raw/events/collector owner slots; canonical transport has no tee | Wait for transport and semantic terminals; release capacity after both preparation and work settle |
| Sidecar publication | Owned collector Base64-encodes once, freezes/validates a known-field envelope and releases pages | WeakSet-validated internal fast path; external objects still need schema/privacy validation |
| Preparation | `repo/dump-store.ts` serializes once; reuses prepared request gzip; compresses serially; transferred bytes avoid borrowed snapshot | Exact decoded content and borrowed/transferred ownership remain distinct |
| Upload | Each sibling takes/clears its compressed slot; all siblings settle | Core failure cannot publish a row; optional sidecar may degrade; slow sibling cannot retain completed sibling through packet slots |
| Ownership/commit | One staging SQL call, three normal uploads, one row insertion; database triggers validate/adopt | Staged ownership, files-before-row, late-put tombstones, token-fenced GC, no retirement of adopted files |
| Publication | Broker notification follows successful persistence | Failure isolation and live upstream name/provider semantics |

These remove several tempting but incorrect optimization proposals: B does not stringify/parse every canonical frame, tee canonical transport, revalidate/copy the native sidecar graph twice, repeatedly publish Base64, decode/re-encode Base64 on write, or gzip the prepared request twice. Three registered files do not imply three JavaScript staging round trips. Retry/retirement SQL belongs to failure paths.

## A and reference-project differences

A stores only request and canonical response bodies. Its event gzip path explicitly allocates a TextEncoder buffer before Blob, uploads serially, and retains the raw record through awaits. B already removes those retention/copy shapes while adding bounded upstream exchange diagnostics and stronger ownership contracts. A's lower full-diagnostic CPU is therefore not an equal-feature comparison.

R captures raw upstream chunks, downstream wire, canonical events, and sometimes pre-translation events. Those views are semantically different. R's raw response getter assembles chunks and encodes the snapshot on access; source alone does not prove repeated accesses during ordinary persistence. Its downstream finalization tees and fully drains wire. Its codec validates, stringifies, encodes, and compresses events/sidecars; the raw record remains in the persistence function across awaits. Absence of explicit reference clearing is not proof of actual GC liveness or exact RSS cost.

R's direct enqueue gzip input is useful inspiration. Its different diagnostic schema and always-on affinity behavior prevent treating its full path as equal work or copying its codec wholesale.

## Concrete candidates and proof obligations

1. **Compression input for private owned strings.** Compare Blob string input against UTF-8 encode plus direct enqueue. This may avoid Blob machinery but adds a contiguous encoded buffer. Preserve exact decoded JSON bytes, Unicode/lone-surrogate behavior, error propagation, serial compression, and synchronous snapshots for public borrowed bytes. It is not yet a demonstrated improvement.
2. **Multi-page Base64 scratch.** `upstream-attempts.ts` currently concatenates multiple captured pages before one Base64 conversion. A page-aware encoder with 0–2 byte carry can avoid that contiguous binary scratch. Encoding each 4096-byte page independently and joining is incorrect. Validate arbitrary chunk/page boundaries, every byte value, truncation, short first pages, snapshot failure, and release. The existing 1 MiB combined prefix cap already bounds the opportunity.
3. **Live metadata-only upstream lookup.** Terminal resolution hydrates the full live upstream record for id/name/provider, then persistence strips it to its ID. A metadata-only repository read could reduce config decoding and row bytes while retaining live rename/delete and publication behavior. It removes no round trip by itself; request-pinned stale metadata is not an equivalent replacement.
4. **Incremental canonical JSON compression.** A bounded serializer could avoid whole event-array string materialization. This needs exact JSON/Unicode/escaping/null/usage-only equivalence, compression-failure and budget-lifetime tests. CPU may worsen; treat it as a separate memory experiment.
5. **Fixed-arity staging bindings.** Known 0–3 keys could use one atomic bound VALUES statement instead of JSON.stringify plus json_each. Preserve every ownership trigger and optional/core failure branch. Lower priority than body-dependent work.

Trusted-producer projection specialization needs a new immutable ownership proof; current APIs admit external/mutable graphs. Removing defensive projection based on simple benchmark fixtures is not justified.

## Measurement boundaries

The observer experiment distinguishes whole-workerd CPU from V8 sample-interval weights and from client EOF. It does not measure true peak/isolate memory, compression scratch, or per-operation retained ownership. Idle/GC/native/harness/unmapped leaves stay separate. Diagnostic on-minus-off includes all policy-dependent compression, capture, SQL, R2 and recorder work; it cannot assign that difference to an individual function.

Follow-up memory work needs an independently qualified heap/backing/RSS series, larger body/frame slopes, slow consumer and cancellation workloads. No source-only finding closes the memory-limit or release gate.
