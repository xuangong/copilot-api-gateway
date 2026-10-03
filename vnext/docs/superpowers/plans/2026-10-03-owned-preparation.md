# Owned Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Avoid repeated affinity structural discovery and make dump compression ownership handoff explicit without weakening independent consumers.

**Architecture:** Checked ingress capture establishes a private normalized graph; a bound copier constructs each mutable consumer. Dump input preparation hands off synchronously to compressed-output completion while retaining existing snapshot and persistence contracts.

**Tech Stack:** TypeScript, Bun, SQLite, Cloudflare workerd/Miniflare; existing installed dependencies.

**Spec:** `../specs/2026-10-03-owned-preparation.md`.

## Global Constraints

The specification's Binding constraints apply to every task. Work only in the existing repair worktree; preserve protected 38/14, fixture identity and all prior evidence. No push/deploy/install/restart/cleanup. Root owns the index, commits, runtime qualification and local integration. Use the new `.superpowers/sdd/2026-10-03-owned-preparation/` (W) for this plan's logs/reports. Never overwrite failed logs or earlier experiment outputs.

## Task 1: Private affinity snapshot copier

**Files:** Modify `packages/gateway/src/shared/affinity/input-copy.ts`, `analysis.ts`; tests `packages/gateway/tests/affinity/input-copy.test.ts`, `request-snapshot.sqlite.test.ts`.

**Interfaces:** Keep `cloneAffinityInput(source: Readonly<Record<string, unknown>>): Record<string, unknown>`. Add internal-module `captureAffinityInput(source)` returning `{ snapshot: Readonly<Record<string, unknown>>; clone(): Record<string, unknown> }`. Only analysis consumes its snapshot. Trusted copy helper is unexported and never accepts arbitrary public provenance flags.

- [ ] Add targeted contract tests before implementation: root spread self-cycle/getter behavior; inherited setter bypass; late accessor/runtime fallback and subsequent independent clones; cloneSource mutation followed by exact/degraded/exact materializations. Retain all existing deep/alias/sparse/runtime/large-string coverage. Run the focused file and preserve its output; new behavior-preservation cases may already pass before the refactor.
- [ ] Refactor checked capture to return completed plain-route provenance. Preserve existing fallback expressions and exceptions. Build the bound clone closure; private normalized traversal retains identity Map, iterative work, own enumeration and safe property definition, without prototype/descriptor checks. Keep fallback copies checked.
- [ ] Replace only analysis snapshot construction and its two clone call sites:

```ts
const input = captureAffinityInput({ ...body })
const snapshot = input.snapshot
// Returned facade exposes copies, never input.snapshot.
cloneSource: () => input.clone()
// In materialize, after the existing unavailable guard:
const copy = input.clone()
```

- [ ] Run grouped affinity tests and gateway typecheck. Use a narrow delegating primitive spy to verify repeated discovery was removed for the private plain graph; do not label it a time/heap measurement. Save exact commands, exit codes and logs in W/task-1-report.md.
- [ ] Independent specification/code-quality review; fix substantive findings; root commits only reviewed Task 1 files and marks completion.

## Task 2: Dump compression ownership and private headers

**Files:** Modify `packages/gateway/src/repo/dump-store.ts`, `shared/dump/accumulator.ts`; tests `packages/gateway/tests/dump-json-compression.test.ts`, `dump-accumulator.test.ts` if additional behavior coverage is needed.

**Interfaces:** Preserve all public DumpStore/accumulator signatures. Private gzip still returns `Promise<Uint8Array>` for string or borrowed/transferred byte inputs. No new header ownership registry or public trusted snapshot type.

- [ ] Retain existing byte/JSON/sidecar/terminal tests. Add a constructor-throw compression case covering failed request preparation and failed mandatory response preparation before file staging, while optional sidecar failure remains degradable. Keep original rejected error identity and restore patched globals in finally.
- [ ] Make gzip a synchronous promise-returning input boundary, with all preparation errors returned as rejected promises. Keep string/borrowed Blob and transferred stream branches. Return a compressed-output promise through a top-level byte-view reaction rather than an async frame containing raw input:

```ts
const ownedCompressedBytes = (buffer: ArrayBuffer): Uint8Array => new Uint8Array(buffer)
// In the existing CompressionStream branch:
return new Response(source.pipeThrough(new CompressionStream("gzip")))
  .arrayBuffer().then(ownedCompressedBytes)
// Bun fallback stays within the preparation try/catch:
return Promise.resolve(Bun.gzipSync(bytes))
```

- [ ] In `finalize(Response)` with null body, register `this.write` directly using the freshly owned response header snapshot and the same scalar/event fields as the numeric overload. Leave defensive copying at public numeric/fallback entrypoints and final private Response headers unchanged.
- [ ] Run grouped dump compression/accumulator/store/sidecar/terminal/capture suites and gateway typecheck. Record functional and structural evidence in W/task-2-report.md, explicitly leaving GC/peak improvement unproven.
- [ ] Independent specification/code-quality review; fix substantive findings; root commits only reviewed Task 2 files and marks completion.

## Task 3: Combined qualification and results

**Files:** New raw evidence in W; tracked `docs/superpowers/research/2026-10-03-owned-preparation/results.md` and `results.json`. Existing harness and old evidence are read-only.

- [ ] Verify scope/protected hashes; run full `SETUP_TEST_CODEX=/Users/zhangxian/.local/bin/codex bun run ci:local` once after both reviewed changes. Preserve and fix any real failure before freezing.
- [ ] Freeze exact deployed A and current B with the unchanged harness after generated assets settle. Run a separate four-request canary; inspect dispatch/settlement/Inspector/cleanup before formal collection.
- [ ] Run one five-unit, 716-request comparison. Preserve every attempt and require zero candidate wire/capture failures plus physical collection and original no-regression gates.
- [ ] Independently recompute results and inspect physical evidence without modifying original databases; verify prior evidence remains unchanged.
- [ ] Record actual costs/benefits, reference applicability and remaining resource/rollback gaps. Keep sparse CPU, settled heap and cross-run boundaries explicit.

## Task 4: Local delivery

- [ ] Independent whole-increment review of code, contracts and evidence; resolve substantive findings.
- [ ] Commit only owned documents, fast-forward local vNext under existing authorization, verify both heads/indexes, protected bytes, product inventory and fixture identity; save local-integration-receipt.json.
- [ ] Mark each completed task and report the next priorities. No push, deployment or cleanup.
