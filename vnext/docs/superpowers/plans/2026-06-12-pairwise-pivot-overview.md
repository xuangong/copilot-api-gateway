# Pairwise Translation Pivot — Overview

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement each phase plan task-by-task.

**Spec:** `vnext/docs/superpowers/specs/2026-06-12-pairwise-translation-pivot.md`

**Goal:** Replace the unified IR architecture with pairwise translation, using Anthropic Messages as the internal hub for conversation endpoints. Provider plugins become independently extensible via a formal `ModelProvider` interface.

**Branch:** `vNext` (long-lived, one-shot switch — no parallel pipelines).

---

## Phase Map

| Phase | File | Stages | Mode |
|---|---|---|---|
| A | `2026-06-12-pairwise-pivot-phaseA-additive.md` | X-1 hub protocol, X-2 ModelProvider iface, X-3 pairwise translators, X-4 attempt modules | **Additive** — new code only, no behavior change |
| B | `2026-06-12-pairwise-pivot-phaseB-switch.md` | X-5 dispatch rewrite, X-6 IR + old-adapter deletion | **Switch + delete** — single hot moment |
| C | `2026-06-12-pairwise-pivot-phaseC-cleanup.md` | X-7 server-tools rewire, X-8 delete IR tests, X-9 add per-pair / attempt / e2e tests | **Cleanup** — restore observability + close test gaps |

Phase A's four stages are mutually independent; the implementation prompt notes which can be done by parallel subagents. B is one ordered sub-flow. C runs after B is green.

## Acceptance per Phase

- **A done:** new code compiles workspace-wide; all 42 existing tests still green; new translator unit tests + attempt-module unit tests green; gateway dispatch still uses old IR path.
- **B done:** `@vnext/protocols/ir` deleted; `apps/gateway/src/data-plane/adapters/` deleted; `routes.ts dispatch()` rewritten; the 4 IR-dependent tests fail (expected — removed in C); the other 38 tests green; new pair-based dispatch e2e tests green.
- **C done:** server-tools handlers run through attempt modules (no "observability bypass" warnings); 4 IR tests deleted; per-pair (×6) + per-attempt (×3) + per-route (×6) e2e tests added and green; cancellation test passes for each pair.

## Cross-Cutting Rules

- **No `mock.module`** (Bun 1.3 cross-file leak — see auto-memory). Use `globalThis.fetch` overrides + real `SqliteRepo`.
- **AsyncIterable everywhere internally**. `ReadableStream<Uint8Array>` only at the HTTP entry/exit.
- **Signal threading**: every translator and provider method takes `{ signal }`. Test cancellation per pair.
- **Inline SSE fixtures** for tests (no `.txt` replay files).
- **TDD per task**: failing test → minimal impl → passing test → commit. Frequent commits.

## Out of Scope (Across All Phases)

- Multi-version hub negotiation.
- New providers beyond `provider-copilot` (architecture admits them, no second provider added).
- Tool-use semantics or feature changes (parity with current behavior).
- Performance work.
