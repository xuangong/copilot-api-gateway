// Per-channel publish/subscribe. The codec is supplied at construction so
// the channel transport stays unaware of the payload shape.

export interface Codec<T> {
  encode(value: T): string
  decode(payload: string): T
}

export interface ChannelBroker<T> {
  // With no active subscriptions, resolves without encoding or allocating a
  // channel. Encoding validates live delivery, not persisted diagnostic data.
  publish(channelId: string, payload: T): Promise<void>
  // Registers eagerly and returns one shared, sequential consumer iterator.
  // A second concurrent pending next() rejects without displacing the first.
  // Abort/return/throw discard buffered frames and settle a pending read; throw
  // then rejects with the supplied error. An already-aborted signal stays done.
  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<T>
  // Releases channel ownership and delivery listeners immediately. Buffered
  // frames drain FIFO before done; abort observation remains until those frames
  // drain or are canceled. Later subscriptions acquire a fresh channel.
  closeChannel(channelId: string, reason: string): Promise<void>
}

export interface ChannelQueuePolicy {
  readonly maxFrames: number
  readonly maxQueueBytes: number
  readonly maxFrameBytes: number
}

export type BoundedChannelState =
  | { readonly status: "active" | "closed" | "canceled" }
  | { readonly status: "reconciliation_required"; readonly reason: ChannelCapacityReason }

export type ChannelCapacityReason = "queue_count" | "queue_bytes" | "frame_bytes"

export class ChannelCapacityError extends Error {
  constructor(readonly reason: ChannelCapacityReason) {
    super(`Live notification capacity exceeded: ${reason}`)
    this.name = "ChannelCapacityError"
  }
}

export interface BoundedChannelSubscription<T> {
  readonly iterable: AsyncIterable<T>
  readonly state: BoundedChannelState
  cancel(): void
}

export interface BoundedChannelBroker<T> extends ChannelBroker<T> {
  // Encoded strings are admitted eagerly, but decoding is lazy on pull.
  // Overflow discards/detaches, rejects one read, then remains done.
  subscribeBounded(channelId: string, signal: AbortSignal, policy: ChannelQueuePolicy): BoundedChannelSubscription<T>
}

export const encodedFrameCharge = (encoded: string): number => 2 * encoded.length + 128
