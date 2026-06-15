# Spec 2 — Chat Completions Data-Plane Migration (Index)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the chat-completions data-plane off the legacy `dispatch.ts` orchestrator onto a Koa-style `serve → attempt → respond` chain that is interceptor-aware, proving the architecture by wiring one stream interceptor (`withUsageStreamOptionsIncluded`).

**Architecture:** Mirrors the reference implementation at `copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/`. Three orchestration files (`serve.ts`, `attempt.ts`, `respond.ts`) compose with a shared interceptor chain via `runInterceptors`. Observability shifts from leaf-wrap to stream-decorator (`withUpstreamTelemetry`) so future interceptors that replace the stream still get telemetry. Cross-protocol routing temporarily short-circuits to the legacy `dispatch()` (removed in Spec 6).

**Tech Stack:** Bun + TypeScript, Hono, pnpm workspaces, `bun test`, `bun x tsc --noEmit`. Reuses Spec 1 frame primitives (`ProtocolFrame`, `ExecuteResult`, `parseChatCompletionsStream`) and the existing `runInterceptors` runner from `@vnext/interceptor`.

---

## Spec Reference

- Spec: `vnext/docs/superpowers/specs/2026-06-15-spec2-chat-completions-data-plane-wiring.md`
- Reference impl: `/Users/zhangxian/projects/copilot-gateway/packages/gateway/src/data-plane/llm/chat-completions/`

## Parts (in execution order)

Each part is independently executable, testable, and committable. Complete and review one before starting the next.

### [Part 1 — Shared Primitives](./2026-06-15-spec2-part-1-shared-primitives.md)

Extract two reusable building blocks that the new chain depends on:
- `withUpstreamTelemetry` — stream-decorating telemetry that records latency + usage on the response stream (replaces `runConversationAttempt`'s leaf wrap).
- `selectBindingForChatCompletions` — pure routing helper that wraps `enumerateBindingCandidates` + `selectPair` with the chat-completions pickTarget chain.

**Deliverables:** 2 new files + tests. Independently committable. No behavior change yet — these are pure helpers.

### [Part 2 — Events + Interceptors](./2026-06-15-spec2-part-2-events-and-interceptors.md)

Build the chat-completions event utilities and the interceptor registry:
- `events/reassemble.ts` — collapse streamed chunks into a single non-stream completion.
- `events/to-result.ts` — convert an async iterable of frames into `ExecuteResult`.
- `events/to-sse.ts` — translate `ProtocolFrame<ChatCompletionsStreamEvent>` to client SSE (with `include_usage` gating).
- `interceptors/types.ts` + `interceptors/index.ts` — registry exporting one interceptor.
- `interceptors/include-usage-stream-options.ts` — the proof interceptor that injects `stream_options.include_usage`.

**Deliverables:** 6 new files + tests. The interceptor must be exercised by a unit test that runs the chain and verifies the payload mutation.

### [Part 3 — attempt.ts + respond.ts](./2026-06-15-spec2-part-3-attempt-and-respond.md)

Orchestration glue that ties Parts 1 & 2 together:
- `attempt.ts` — builds `Invocation`, invokes `runInterceptors` with the registry, leaf calls the provider and returns `ExecuteResult<ProtocolFrame<…>>`. Short-circuits to `dispatch()` when `targetEndpoint !== 'chat_completions'`.
- `respond.ts` — 3-state dispatcher (`events` → SSE stream, `upstream-error` → `upstreamErrorToResponse`, `internal-error` → JSON envelope). Observes terminal frames and usage.

**Deliverables:** 2 new files + tests covering all three result branches (streaming, upstream-error, internal-error).

### [Part 4 — serve.ts rewrite + integration](./2026-06-15-spec2-part-4-serve-rewrite-and-integration.md)

Wire everything into the public entry point and prove it end-to-end:
- Rewrite `chat-completions/serve.ts` to: parse → route (Part 1) → cross-protocol short-circuit OR `attempt.generate` → `respond`.
- Add an integration test that drives a real `/v1/chat/completions` request through the gateway and asserts `stream_options.include_usage: true` reached the upstream payload.
- Run the SDK regression suite (`bun run test:integration:openai`) against a local server to confirm no behavioral drift.

**Deliverables:** Rewritten `serve.ts` + integration test + green SDK suite. After this part, `chat_completions` no longer routes through `dispatch()` for the same-protocol path.

---

## Acceptance (all parts complete)

- [ ] `serveChatCompletions` no longer imports `dispatch` for the same-protocol path
- [ ] `withUsageStreamOptionsIncluded` runs on every chat-completions request and the upstream payload contains `stream_options.include_usage: true`
- [ ] Latency + usage telemetry still records on streaming and non-streaming successes (observability parity)
- [ ] All existing chat-completions tests pass (`bun test`)
- [ ] OpenAI SDK regression suite passes (`bun run test:integration:openai`)
- [ ] Cross-protocol routing (e.g. chat_completions → messages target) still works via the temporary `dispatch()` bridge
- [ ] `bun x tsc --noEmit` clean

## Out of Scope

- Wiring additional interceptors (`withUsageNormalized`, vendor normalizers) — those land in Spec 7
- Removing `dispatch.ts` — that is Spec 6
- Migrating messages/responses endpoints — Specs 3 & 4
