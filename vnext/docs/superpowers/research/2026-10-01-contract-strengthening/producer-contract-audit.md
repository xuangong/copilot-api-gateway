# Producer and completion contract audit

Baseline: dbde0567, source-only controller inspection. No tests or runtime incident reproduction.

## Selected type/runtime mismatch

`vnext/packages/protocols-llm/src/common/result.ts` declares four `TranslatorProtocol` values, and currently uses that same union for `TranslatedLlmEventResult.producer.protocol`. Its `eventProducerProtocol` runtime guard accepts only chat_completions, messages and responses as translated producers. Gemini is still a valid source and native protocol.

`vnext/packages/gateway/src/data-plane/chat-flow/shared/hub-attempt-dispatch.ts` already independently declares exactly the same three supported hub protocols. `TraverseTranslationArgs.hubProtocol` in `shared/traverse-translation.ts` is broader and feeds the translated producer declaration. Align these three declared boundaries through one exported `TranslatedProducerProtocol`; retain runtime validation for untrusted/malformed fixtures and do not change telemetry attribution types.

All production traversal call sites in the four attempt files choose a `HubAttemptProtocol` and dispatch through `pickHubAttempt`. No attempt-body or protected overlay change is needed. The broader helper argument in `gateway/tests/data-plane/chat-flow/shared/producer-domain.test.ts` can narrow without removing unsupported-domain fault injection. Protocol tests under `tests/` are not included by the package tsconfig, so new negative type assertions belong under `src/common/__tests__/`.

## Retained prior contracts

Native and translated results are already separate union members. Native results exclude translation adapters; translated results require producer metadata and separate body/event adapters. `validateEventProducer`/`requireNativeEventResult` dispose unsupported producers without pulling an invalid frame, and `upstreamBodyDisposal` captures the actual body. Preserve those mechanisms and their existing runtime regression tests.

Responses `turn.ts` keeps execution facts separate from optional projection receipts. `resolveFacts` freezes the fact object and metadata; a reusable snapshot is attached only for an uncancelled completed outcome. Continuation publication occurs before successful terminal delivery, and receipt settlement does not redefine upstream execution. Broadening this batch into a new completion state engine is unnecessary. A later typed settlement projection can build on these owners; this audit does not claim every inner referent is immutable or that receipt fulfillment proves durable database writes.

## Scope and evidence boundary

The producer change rejects an unsafe internal construction earlier. It is not a demonstrated production routing incident, a new supported protocol pair, or a performance optimization. No new parser, raw-response converter, source alias, or cleanup owner should be introduced for this type alignment.
