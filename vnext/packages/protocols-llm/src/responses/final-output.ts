import { isResponsesTerminalEvent, type ResponsesOutputItem, type ResponsesResult, type ResponsesStreamEvent } from './events'

/** Closed items supply omissions; authoritative terminal items win by ID,
 * then by index when either side lacks an ID. Conflicting IDs are distinct
 * items, so terminal-only extras are appended rather than dropping content. */
export class ResponsesFinalOutput {
  private readonly closed = new Map<number, ResponsesOutputItem>()
  private readonly closedIds = new Map<string, number>()

  observe(event: ResponsesStreamEvent): ResponsesStreamEvent {
    if (event.type === 'response.output_item.done') {
      const index = Number.isInteger(event.output_index) && event.output_index >= 0 ? event.output_index : this.closed.size
      const id = event.item.id
      const previous = id ? this.closedIds.get(id) : undefined
      if (previous !== undefined) this.closed.delete(previous)
      const displaced = this.closed.get(index)
      if (displaced?.id) this.closedIds.delete(displaced.id)
      this.closed.set(index, event.item)
      if (id) this.closedIds.set(id, index)
    }
    if (isResponsesTerminalEvent(event) && 'response' in event) {
      return { ...event, response: this.complete(event.response) }
    }
    return event
  }

  complete(response: ResponsesResult): ResponsesResult {
    const items = new Map(this.closed)
    const ids = new Map(this.closedIds)
    const seen = new Set<string>()
    let extraIndex = 0
    for (const index of items.keys()) extraIndex = Math.max(extraIndex, index + 1)
    for (const [index, item] of (response.output ?? []).entries()) {
      if (item.id && seen.has(item.id)) continue
      if (item.id) seen.add(item.id)
      const match = item.id ? ids.get(item.id) : undefined
      const atIndex = items.get(index)
      const target = match ?? (atIndex && (!atIndex.id || !item.id) ? index : extraIndex++)
      const displaced = items.get(target)
      if (displaced?.id) ids.delete(displaced.id)
      items.set(target, item)
      if (item.id) ids.set(item.id, target)
      extraIndex = Math.max(extraIndex, target + 1)
    }
    return { ...response, output: [...items].sort(([a], [b]) => a - b).map(([, item]) => item) }
  }
}
