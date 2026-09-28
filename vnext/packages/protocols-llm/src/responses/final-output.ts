import { isResponsesTerminalEvent, type ResponsesOutputItem, type ResponsesResult, type ResponsesStreamEvent } from './events'

/** Closed items supply omissions; authoritative terminal items win by ID,
 * then by index when either side lacks an ID. Conflicting IDs are distinct
 * items, so terminal-only extras are appended rather than dropping content. */
export class ResponsesFinalOutput {
  private readonly closed = new Map<number, ResponsesOutputItem>()

  observe(event: ResponsesStreamEvent): ResponsesStreamEvent {
    if (event.type === 'response.output_item.done') {
      const index = Number.isInteger(event.output_index) && event.output_index >= 0 ? event.output_index : this.closed.size
      if (event.item.id) {
        for (const [previous, item] of this.closed) {
          if (item.id === event.item.id) this.closed.delete(previous)
        }
      }
      this.closed.set(index, event.item)
    }
    if (isResponsesTerminalEvent(event) && 'response' in event) {
      return { ...event, response: this.complete(event.response) }
    }
    return event
  }

  complete(response: ResponsesResult): ResponsesResult {
    const items = new Map(this.closed)
    const seen = new Set<string>()
    let extraIndex = Math.max(-1, ...items.keys()) + 1
    for (const [index, item] of (response.output ?? []).entries()) {
      if (item.id && seen.has(item.id)) continue
      if (item.id) seen.add(item.id)
      const match = item.id ? [...items].find(([, existing]) => existing.id === item.id) : undefined
      const atIndex = items.get(index)
      const target = match?.[0] ?? (atIndex && (!atIndex.id || !item.id) ? index : extraIndex++)
      items.set(target, item)
      extraIndex = Math.max(extraIndex, target + 1)
    }
    return { ...response, output: [...items].sort(([a], [b]) => a - b).map(([, item]) => item) }
  }
}
