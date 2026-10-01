import { expect, test } from "bun:test"
import { eventFrame } from "@vibe-core/result"
import {
  eventProducerProtocol,
  llmEventResult,
  type TelemetryModelIdentity,
  type TranslatedLlmEventResult,
  type TranslatedProducerProtocol,
  type TranslatorProtocol,
} from "../index"

type Assert<T extends true> = T
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Producer = TranslatedLlmEventResult["producer"]
type _SharedProducerProtocolExact = Assert<Equal<Producer["protocol"], TranslatedProducerProtocol>>
type _GeminiProducerRejected = Assert<"gemini" extends Producer["protocol"] ? false : true>
type _GeminiResultRejected = Assert<
  Omit<TranslatedLlmEventResult, "producer"> & {
    producer: { kind: "translated"; source: "responses"; protocol: "gemini" }
  } extends TranslatedLlmEventResult ? false : true
>
type _ChatProducerAccepted = Assert<"chat_completions" extends Producer["protocol"] ? true : false>
type _MessagesProducerAccepted = Assert<"messages" extends Producer["protocol"] ? true : false>
type _ResponsesProducerAccepted = Assert<"responses" extends Producer["protocol"] ? true : false>
type _GeminiSourceAccepted = Assert<
  { kind: "translated"; source: "gemini"; protocol: "responses" } extends Producer ? true : false
>
type _GeminiTranslatorProtocolAccepted = Assert<"gemini" extends TranslatorProtocol ? true : false>
type _GeminiNativeProtocolAccepted = Assert<"gemini" extends Parameters<typeof eventProducerProtocol>[1] ? true : false>
type _GeminiTelemetryHubAccepted = Assert<"gemini" extends NonNullable<TelemetryModelIdentity["translatorPair"]>["hub"] ? true : false>

const identity: TelemetryModelIdentity = {
  incomingModel: "m", model: "m", upstream: "up", modelKey: "m", cost: null,
}

test("native Gemini retains its native producer domain", () => {
  const native = llmEventResult((async function* () {
    yield eventFrame({ candidates: [] })
  })(), identity)

  expect(eventProducerProtocol(native, "gemini")).toBe("gemini")
  expect(native.producer).toBeUndefined()
})

test("translated Gemini sources accept each supported producer domain", () => {
  for (const protocol of ["chat_completions", "messages", "responses"] as const) {
    const result: TranslatedLlmEventResult = {
      type: "events",
      producer: { kind: "translated", source: "gemini", protocol },
      events: (async function* () {})(),
      modelIdentity: identity,
      translateBody: body => body,
      translateEvents: events => events,
    }

    expect(eventProducerProtocol(result, "gemini")).toBe(protocol)
  }
})

test("foreign translated Gemini producers still fail runtime validation", () => {
  // Deliberately bypass the trusted type contract to exercise the foreign-input guard.
  const foreign = {
    type: "events",
    producer: { kind: "translated", source: "responses", protocol: "gemini" },
    events: (async function* () {})(),
    modelIdentity: identity,
    translateBody: (body: unknown) => body,
    translateEvents: (events: AsyncIterable<unknown>) => events,
  } as unknown as TranslatedLlmEventResult

  expect(() => eventProducerProtocol(foreign, "responses")).toThrow("Invalid translated event producer domain")
})
