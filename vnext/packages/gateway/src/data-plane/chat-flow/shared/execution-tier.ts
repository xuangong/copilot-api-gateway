import type { ProtocolFrame } from "@vibe-core/result"

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

/** Only an executed selection can override the provider's own tier output. */
export function selectedTierBody<T>(protocol: string, body: T, tier?: string): T {
  if (!record(body) || (tier !== "priority" && tier !== "default")) return body
  if (protocol === "responses" || protocol === "chat_completions") return { ...body, service_tier: tier }
  if (protocol === "messages") return {
    ...body, usage: { ...(record(body.usage) ? body.usage : {}), speed: tier === "priority" ? "fast" : "standard" },
  }
  return body
}

export function selectedTierEvent<T>(protocol: string, event: T, tier?: string): T {
  if (!record(event) || (tier !== "priority" && tier !== "default")) return event
  if (protocol === "responses" && record(event.response)) return { ...event, response: selectedTierBody(protocol, event.response, tier) }
  if (protocol === "messages") {
    if (event.type === "message_start" && record(event.message)) return { ...event, message: selectedTierBody(protocol, event.message, tier) }
    if (event.type === "message_delta" && record(event.usage)) return selectedTierBody(protocol, event, tier)
  }
  if (protocol === "chat_completions" && Array.isArray(event.choices)) return selectedTierBody(protocol, event, tier)
  return event
}

export async function* selectedTierFrames<T>(
  protocol: string, frames: AsyncIterable<ProtocolFrame<T>>, tier?: string,
): AsyncIterable<ProtocolFrame<T>> {
  for await (const frame of frames) yield frame.type === "event"
    ? { ...frame, event: selectedTierEvent(protocol, frame.event, tier) } : frame
}

/** Translation preserves the hint; sourceProtocol separately retains strict Messages semantics. */
export function selectedTierRequest(
  source: string, target: string, payload: Record<string, unknown>, translated: Record<string, unknown>,
): Record<string, unknown> {
  const tier = source === "messages"
    ? payload.speed === "fast" ? "priority" : payload.speed === "standard" ? "default" : undefined
    : payload.service_tier
  if (tier !== "priority" && tier !== "default") return translated
  if (target === "messages") return { ...translated, speed: tier === "priority" ? "fast" : "standard" }
  if (target === "responses" || target === "chat_completions") return { ...translated, service_tier: tier }
  return translated
}
