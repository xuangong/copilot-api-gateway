import type { MessagesInterceptor } from './types'
import { eventFrame, type ProtocolFrame } from '@vnext/protocols/common'
import type { MessagesStreamEvent } from '@vnext/protocols/messages'

/**
 * `thinking.display` controls whether Copilot/Claude emits token-level
 * `thinking_delta` SSE during extended thinking. Claude 4.7 defaults to
 * `omitted`, which has been observed to coincide with a ~60s HTTP idle gap
 * during long thinking turns — surfacing to clients as
 * `API Error: Network connection lost`, `Stream idle timeout`, or a short
 * no-tool-call response.
 *
 * Workaround: force `summarized` upstream so data keeps flowing during
 * thinking; if the original downstream display was `omitted`, strip thinking
 * text/deltas after the fact (preserving every `signature` byte — tampering
 * with signatures makes the next Messages request fail with 400).
 *
 * References:
 * - https://github.com/ericc-ch/copilot-api/issues/223
 * - https://github.com/anthropics/claude-code/issues/46987
 * - https://github.com/anthropics/claude-code/issues/50477
 */
type MessagesThinkingDisplay = 'omitted' | 'summarized' | 'full'

const CLAUDE_VARIANT_SUFFIX = /-(?:high|xhigh|1m(?:-internal)?)$/
const CLAUDE_DATE_SUFFIX = /-\d{8}$/
const CLAUDE_VERSION_PATTERN = /(?:^|-)(\d+)\.(\d+)(?=-|$)/

const isMessagesThinkingDisplay = (value: unknown): value is MessagesThinkingDisplay =>
  value === 'omitted' || value === 'summarized' || value === 'full'

const copilotRawModelId = (id: string): string => {
  if (!id.startsWith('claude-')) return id
  // Convert `claude-sonnet-4-7` → `claude-sonnet-4.7` so the version pattern
  // can match. Strip date / variant suffixes too, otherwise `claude-4-7-20251015`
  // wouldn't match.
  return id
    .replace(CLAUDE_DATE_SUFFIX, '')
    .replace(CLAUDE_VARIANT_SUFFIX, '')
    .replace(/(?<=-)(\d+)-(\d+)(?=-|$)/g, '$1.$2')
}

const isClaudeVersionAtLeast = (model: string, major: number, minor: number): boolean => {
  const normalized = copilotRawModelId(model)
  if (!normalized.startsWith('claude-')) return false

  const match = normalized.match(CLAUDE_VERSION_PATTERN)
  if (!match) return false

  const modelMajor = Number(match[1])
  const modelMinor = Number(match[2])

  return modelMajor > major || (modelMajor === major && modelMinor >= minor)
}

interface ThinkingPayload {
  thinking?: { type?: string; display?: unknown; [k: string]: unknown }
  model?: unknown
}

export const resolveMessagesDownstreamThinkingDisplay = (
  payload: ThinkingPayload,
): MessagesThinkingDisplay | undefined => {
  const display = payload.thinking?.display
  if (display !== undefined) {
    // Request JSON is not runtime-validated before this interceptor; leave
    // unknown values untouched so upstream owns rejecting future variants.
    return isMessagesThinkingDisplay(display) ? display : undefined
  }

  const model = typeof payload.model === 'string' ? payload.model : ''
  return isClaudeVersionAtLeast(model, 4, 7) ? 'omitted' : 'summarized'
}

const omitThinkingTextFromProtocolFrame = (
  frame: ProtocolFrame<MessagesStreamEvent>,
): ProtocolFrame<MessagesStreamEvent> | undefined => {
  if (frame.type === 'done') return frame

  const { event } = frame
  if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
    return eventFrame({
      ...event,
      content_block: {
        ...event.content_block,
        thinking: '',
      },
    } as MessagesStreamEvent)
  }

  if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
    return undefined
  }

  return frame
}

const omitThinkingTextFromProtocolFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  for await (const frame of frames) {
    const omitted = omitThinkingTextFromProtocolFrame(frame)
    if (omitted) yield omitted
  }
}

export const withThinkingDisplayPromoted: MessagesInterceptor = async (inv, _ctx, run) => {
  const payload = inv.payload as ThinkingPayload
  const downstreamDisplay = resolveMessagesDownstreamThinkingDisplay(payload)
  const thinking = payload.thinking
  const hasActiveThinking = !!thinking && thinking.type !== 'disabled'
  const shouldExposeOmitted = hasActiveThinking && downstreamDisplay === 'omitted'

  if (
    hasActiveThinking &&
    downstreamDisplay !== undefined &&
    downstreamDisplay !== 'full' &&
    thinking
  ) {
    // Mutate inv.payload so the terminal sees the upgraded display. The
    // terminal copies invocation.payload into the upstream request verbatim.
    payload.thinking = {
      ...thinking,
      display: 'summarized',
    }
  }

  const result = await run()

  if (!shouldExposeOmitted || result.type !== 'events') return result
  return {
    ...result,
    events: omitThinkingTextFromProtocolFrames(result.events),
  }
}
