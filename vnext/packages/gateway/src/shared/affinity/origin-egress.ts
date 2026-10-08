import type { AffinityProtocol } from "./analysis.ts"
import type { AffinityExecutionState } from "./context.ts"
import { stampAffinityOrigin } from "./origin-anchor.ts"

type JsonObject = Record<string, unknown>
const object = (value: unknown): value is JsonObject => !!value && typeof value === "object" && !Array.isArray(value)

/** Runs after natural-state egress so origin tokens never enter the v1 writer. */
export class OriginEgress {
  private responsesPrefix?: Promise<JsonObject | undefined>
  private messagesPrefix?: Promise<JsonObject | undefined>
  private responsePrefixEmitted = false
  private messagePrefixEmitted = false
  private responseSequence = 0
  constructor(private readonly affinity: AffinityExecutionState | undefined) {}

  async item(protocol: AffinityProtocol, item: JsonObject): Promise<JsonObject> {
    const state = this.affinity
    if (!state?.actual) return item
    const codec = state.codec ?? await state.loadCodec?.()
    return codec ? stampAffinityOrigin(protocol, item, state.actual, codec) : item
  }

  private responsePrefix(): Promise<JsonObject | undefined> {
    return this.responsesPrefix ??= (async () => {
      const item = await this.item("responses", { type: "reasoning", id: `rs_${crypto.randomUUID()}`, summary: [] })
      return typeof item.encrypted_content === "string" ? item : undefined
    })()
  }

  private messagePrefix(): Promise<JsonObject | undefined> {
    return this.messagesPrefix ??= (async () => {
      const item = await this.item("messages", { type: "redacted_thinking" })
      return typeof item.data === "string" ? item : undefined
    })()
  }

  async messagesBody<T>(body: T): Promise<T> {
    if (!object(body) || !Array.isArray(body.content) || body.error) return body
    const prefix = await this.messagePrefix()
    return prefix ? { ...body, content: [prefix, ...body.content] } as T : body
  }

  async messagesEvent<T>(event: T): Promise<T[]> {
    if (!object(event)) return [event]
    // A complete message boundary establishes a real assistant turn. Standalone
    // block fixtures and error-only streams must not manufacture a turn.
    if (event.type === "message_start" && object(event.message) && !this.messagePrefixEmitted) {
      const prefix = await this.messagePrefix()
      if (!prefix) return [event]
      this.messagePrefixEmitted = true
      return [event,
        { type: "content_block_start", index: 0, content_block: prefix },
        { type: "content_block_stop", index: 0 },
      ] as T[]
    }
    return [this.messagePrefixEmitted && typeof event.index === "number" ? { ...event, index: event.index + 1 } as T : event]
  }

  async responsesEvent<T>(event: T): Promise<T[]> {
    if (!object(event)) return [event]
    const type = String(event.type)
    const startsResponse = ["response.created", "response.in_progress", "response.completed", "response.incomplete"].includes(type)
      && object(event.response) && typeof event.response.id === "string" && Array.isArray(event.response.output)
    const outputEvent = type.startsWith("response.") && typeof event.output_index === "number"
    if (!this.responsesPrefix && !startsResponse && !outputEvent) return [event]
    const prefix = await this.responsePrefix()
    if (!prefix) return [event]
    const projected: JsonObject = { ...event }
    if (typeof event.output_index === "number") projected.output_index = event.output_index + 1
    // SDK accumulators initialize from created.output and append added items.
    // Later lifecycle envelopes replace that snapshot, so they must retain the
    // prefix once its added/done events have introduced it into live state.
    const initialLifecycle = ["response.created", "response.in_progress"].includes(type) && !this.responsePrefixEmitted
    if (!initialLifecycle && object(event.response) && Array.isArray(event.response.output)) {
      projected.response = { ...event.response, output: [prefix, ...event.response.output] }
    }
    const events: JsonObject[] = []
    if (!this.responsePrefixEmitted) {
      this.responsePrefixEmitted = true
      if (type === "response.created" || type === "response.in_progress") events.push(projected)
      events.push({ type: "response.output_item.added", output_index: 0, item: prefix }, { type: "response.output_item.done", output_index: 0, item: prefix })
      if (events[0] !== projected) events.push(projected)
    } else events.push(projected)
    return events.map(value => ({ ...value, sequence_number: this.responseSequence++ })) as T[]
  }
}
