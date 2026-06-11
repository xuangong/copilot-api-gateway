import { z } from 'zod'

/**
 * Anthropic Messages SSE event vocabulary. Pairwise translators consume and
 * emit these as AsyncIterable<MessagesEvent>; HTTP boundary code converts
 * to/from `event: ...\ndata: ...\n\n` text frames.
 */

export const MessageStartEventSchema = z.object({
  type: z.literal('message_start'),
  message: z.object({
    id: z.string(),
    type: z.literal('message'),
    role: z.literal('assistant'),
    model: z.string(),
    content: z.array(z.unknown()),
    stop_reason: z.string().nullable(),
    stop_sequence: z.string().nullable(),
    usage: z.object({
      input_tokens: z.number(),
      output_tokens: z.number(),
    }).loose(),
  }).loose(),
}).loose()

export const ContentBlockStartEventSchema = z.object({
  type: z.literal('content_block_start'),
  index: z.number(),
  content_block: z.unknown(),
}).loose()

export const ContentBlockDeltaEventSchema = z.object({
  type: z.literal('content_block_delta'),
  index: z.number(),
  delta: z.unknown(),
}).loose()

export const ContentBlockStopEventSchema = z.object({
  type: z.literal('content_block_stop'),
  index: z.number(),
}).loose()

export const MessageDeltaEventSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({
    stop_reason: z.string().nullable().optional(),
    stop_sequence: z.string().nullable().optional(),
  }).loose(),
  usage: z.object({}).loose().optional(),
}).loose()

export const MessageStopEventSchema = z.object({ type: z.literal('message_stop') }).loose()
export const PingEventSchema = z.object({ type: z.literal('ping') }).loose()
export const ErrorEventSchema = z.object({
  type: z.literal('error'),
  error: z.object({ type: z.string(), message: z.string() }).loose(),
}).loose()

export const MessagesEventSchema = z.union([
  MessageStartEventSchema,
  ContentBlockStartEventSchema,
  ContentBlockDeltaEventSchema,
  ContentBlockStopEventSchema,
  MessageDeltaEventSchema,
  MessageStopEventSchema,
  PingEventSchema,
  ErrorEventSchema,
])

export type MessagesEvent = z.infer<typeof MessagesEventSchema>
