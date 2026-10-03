# Owned preparation: validate once, preserve independent consumers

## Goal and authority

Continue the accepted affinity-copy and dump-preparation investigation after local vNext `bb20461dbeee8086abbcca1258387a5a7a784a03`. Reduce repeated work within an existing owner, while retaining every independent mutable consumer and persistence contract. The user's continuation authorizes implementation, grouped verification and local vNext integration. It does not authorize deployment.

The previous ordinary workerd comparison still showed higher latency and sampled non-idle time than deployed source. Its profile anchors are leads, not causal cost estimates. This increment must not claim a speedup from source changes alone.

## Binding constraints

- Work in the existing `fix/cfw-resource-rollback` worktree. Preserve the original 38 MAIN and 14 isolated protected files, empty protected index entries, fixture PID 90455 and its original start identity. Do not stage/reset/stash unrelated changes.
- No push, deployment, dependency installation, existing-service restart or worktree/evidence cleanup. Preserve all 7,973 files / 863,347,799 bytes in the new prior-evidence baseline.
- Keep wire/schema/migration/configuration formats, routing/credential policy, opaque authentication, complete sidecars, immutable capture, budgets, demand, terminal distinctions and background settlement.
- No new cross-request mutable cache, persistent per-property copy blueprint, borrowed mutable capture graph, disabled diagnostics or new dependencies. Follow `vnext/AGENTS.md` and use real SQLite for persistence boundaries.
- Group focused correctness checks by deliverable, then run full `ci:local` and one fresh local workerd comparison. Preserve failed logs and attempts; rerun only after a demonstrated correction, never for favorable numbers.

## Affinity capture and construction

The canonical captured graph and each candidate/attempt graph are different owners. Both allocations remain necessary. Ordinary requests without owned markers still require source mutation isolation; the first materialization cannot consume the canonical graph, and unchanged subtrees cannot be borrowed.

Keep `cloneAffinityInput(source)` as the checked copier for arbitrary callers. Factor its existing implementation to report whether the entire capture completed through its plain-container route. Accessors, runtime prototypes/objects, functions and symbols retain the existing native structured-clone fallback or failure. Partial checked output never becomes a trusted snapshot.

Add an internal snapshot factory in `input-copy.ts`. It returns a read-only snapshot view and a zero-argument `clone()` closure bound to that captured graph. Only `analyzeAffinityRequest` holds the factory result; it reads the snapshot for block inspection and never exposes it through the analysis facade, execution state, provider, translator or diagnostic hook. The graph remains private by ownership, not by shallow `Readonly` alone. No exported trusted boolean, registration function or caller-replaceable clone source is allowed.

For completed plain-container captures, `clone()` uses a module-private iterative copier without repeating prototype or property-descriptor discovery. It still creates every container, keeps a per-copy identity Map, enumerates own string keys, preserves array length/holes/extra properties, shares immutable primitive values and defines output fields with the existing enumerable/configurable/writable descriptors. `Object.defineProperty` remains necessary for `__proto__` and inherited-setter safety. Avoid recursive cloning and native serialization of ordinary large strings.

If initial capture uses native fallback, `clone()` delegates to existing checked `cloneAffinityInput(snapshot)`. Do not infer trust from the returned root shape or recertify the graph with another eager pass. Preserve `{ ...body }` at the analysis boundary: root getter evaluation, root normalization and the existing root self-reference topology are intentional compatibility constraints for this change.

`cloneSource()` and successful `materialize()` call the bound copier. Required-unavailable checks still run before cloning. Authentication, target classification, descending removal, foreign state, synthetic state, model stamping, candidate error handling and retry behavior stay unchanged. There is no change to `materializeAffinity`'s no-analysis fallback.

The reference checkout (`1d7dcd923e260e425120cca0c7a240e93720af27`) separates projection planning from construction, which is useful. Its Responses shallow projection and per-candidate materialization reuse have weaker mutation isolation and are not compatible with this repository's contract.

## Dump preparation and compression handoff

The existing dump pipeline already reuses prepared request gzip, validates owned sidecar provenance once, serializes each event document once, and avoids Blob snapshots for transferred bytes. Keep these mechanisms. Keep JSON strings entering Blob without a new explicit full UTF-8 array, and keep borrowed bytes synchronously snapshotted before asynchronous compression.

Refactor gzip input preparation into a synchronous promise-returning boundary. After preparing the source and initiating compression, return the output-reading promise through a helper/reaction that owns only compressed output. Avoid an async frame retaining `input`, `part` and the source while awaiting output. Preserve all synchronous preparation failures as rejected promises and preserve Bun's byte encoding/native compression fallback. Keep compression serial and JSON serialization lazy; do not make sibling compression concurrent.

This is an explicit lifetime boundary, not proof that a particular V8 version retained those locals or that peak memory decreases. Functional checks cannot establish GC liveness. Do not use forced-GC timing assertions or treat a transparent CompressionStream fixture as real workerd compression.

The legacy `finalize(Response)` null-body branch already owns frozen header pairs. Pass that snapshot directly into the private write path instead of recopying it through the public numeric overload. Public numeric/fallback callers still receive defensive header snapshots. Retain final-response private dump headers, status, idempotence and waitUntil registration.

## Verification and evidence

Affinity coverage must retain deep trees, aliases/cycles, sparse arrays, dangerous keys, runtime fallback, nested/root getters, unsupported values and source/candidate/attempt isolation. Add targeted provenance checks around copying, including a late fallback, root spread topology and inherited setters. A delegating spy may establish that trusted copies no longer inspect descriptors/prototypes; it is a mechanism assertion, not a performance result. No test should merely repeat private implementation logic.

Dump coverage must retain Unicode/control/lone-surrogate serialization, one-time JSON encoding, borrowed/transferred input isolation, prepared gzip reuse, failure before staging, optional sidecar independence, file settlement and null-body header behavior. Add a focused synchronous CompressionStream-construction failure case if existing tests do not cover the promise/error boundary.

After both deliverables pass independent review, run `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` from `vnext`. Commit reviewed product changes before freezing post-CI generated assets. Reuse the unchanged 2026-10-02 harness with fresh freeze/canary/formal directories. Preserve exact deployed A `e660fb4d` and candidate B HEAD/overlay identity; require both B wire and capture failures to be zero, in addition to complete 716-request collection and no-regression gates.

Report latency, weighted V8 samples, settled heap and storage with their original boundaries. Across-run old/new B values are descriptive, not causal per-feature results. Large/concurrent/slow-consumer peak qualification, hosted-search/queue pressure and catalog/affinity rollback plus backup/restore remain release gaps.
