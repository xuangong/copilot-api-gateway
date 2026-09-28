# Responses and stream-failure SDK evidence

Captured 2026-09-29. Synthetic fetch adapters, no network or credentials.

## Official SDK synthetic transport evidence / A12

SDKs: official `openai` **6.33.0** and `@anthropic-ai/sdk` **0.80.0**, resolved from the preexisting `/tmp/vnext-reference-sdk-probe/node_modules`. No dependency/cache changes. The probe passes an isolated `fetch` adapter returning gateway-produced SSE; it makes no network requests and uses no real credentials or paid inference.

Run:

```sh
cp .superpowers/sdd/2026-09-29-reference-adoption-follow-up/evidence/a01-sdk-probe.ts.txt /tmp/vnext-reference-sdk-probe/a01-probe.ts
bun /tmp/vnext-reference-sdk-probe/a01-probe.ts
```

The saved source has absolute workspace imports for this checkout. Output is saved next to the source.

Observed SDK contracts:

| Case | Low-level SDK iteration | High-level Responses `finalResponse()` |
| --- | --- | --- |
| Native `response.created`, `response.completed`, EOF; no `[DONE]` | Receives both events, completes | Returns `status: completed` |
| Control: raw `response.created`, EOF | Completes without detecting truncation | Returns `status: in_progress` |
| Gateway premature EOF | Receives one `error` event | Rejects |
| Gateway completed then late error | Receives one `error`, no completed | Rejects |
| Gateway Chat-to-Responses truncation | Receives one `error` | Rejects |
| Native `response.failed` | Receives exactly `response.failed`, no completed | Returns old `in_progress` snapshot; SDK limitation |
| Native Anthropic error / Responses failure translated to Anthropic | Official Anthropic iterator throws | N/A |
| Responses failure translated to Chat | Official OpenAI Chat iterator throws | N/A |

A12 decision: **retain the existing Responses no-sentinel SSE contract**. Both official OpenAI iteration and high-level successful finalization work without `[DONE]`; adding it is unnecessary. Merely observing iterable EOF was not treated as proof of semantic completion.

The native `response.failed` high-level limitation is in this SDK's `lib/responses/ResponseStream`: its accumulator updates the snapshot only on `response.completed`, while failure remains a separate event. We preserve the native failure event once rather than appending an additional artificial error. Clients using that SDK helper must observe `response.failed`; this work does not claim the SDK's `finalResponse()` correctly changes failed/incomplete status. Top-level Responses `error` is surfaced as an event by low-level iteration and makes the high-level helper reject (its error message string currently displays `[object Object]`).

## Boundaries

- No full `ci:local`, UI build, Wrangler dry-run, live upstream calls, deployment or root legacy SDK integration against a server was run; the requested backend-focused and official-SDK synthetic checks are complete.
- Gemini currently has no native identity attempt: its attempt routes through Chat/Messages/Responses hubs and its responder shares `translateStream`. Existing Gemini chat-flow/translators were exercised in the 854-test run. No unrelated Gemini projection was broadened.
- Terminal validation waits for upstream tail EOF; an upstream that never closes relies on existing request timeout/abort policy. Holding native success is required to avoid announcing success before a late failure.
- A13 uses the supplied AbortSignal to interrupt actual provider reads. An arbitrary custom iterator that ignores abort can remain pending, but metadata now settles immediately on abort and no failure is emitted once that iterator unwinds.

Probe source and output are adjacent. Copy the `.ts.txt` to a temporary `.ts` file; inspect absolute import paths before running.
