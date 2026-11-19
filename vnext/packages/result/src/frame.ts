// packages/protocols/src/common/sse.ts
export interface SseFrame {
  type: 'sse'
  event?: string
  data: string
}

export interface SseCommentFrame {
  type: 'sse-comment'
  comment: string
}

export interface EventFrame<TEvent> {
  type: 'event'
  event: TEvent
}

export interface DoneFrame {
  type: 'done'
}

// A payload the upstream wrote without SSE framing (e.g. a bare JSON error
// body ending a stream). Kept distinct so it is never mistaken for a clean EOF.
export interface SseRawFrame {
  type: 'sse-raw'
  data: string
}

// What the SSE reader yields: framed events plus any unframed payload.
export type SseReadableFrame = SseFrame | SseRawFrame

export type SseWritableFrame = SseFrame | SseCommentFrame

export type ProtocolFrame<TEvent> = EventFrame<TEvent> | DoneFrame

export const sseFrame = (data: string, event?: string): SseFrame => (
  event === undefined ? { type: 'sse', data } : { type: 'sse', event, data }
)

export const sseCommentFrame = (comment: string): SseCommentFrame => ({
  type: 'sse-comment',
  comment,
})

export const eventFrame = <TEvent>(event: TEvent): EventFrame<TEvent> => ({
  type: 'event',
  event,
})

export const doneFrame = (): DoneFrame => ({ type: 'done' })
