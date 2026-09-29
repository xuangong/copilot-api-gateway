/**
 * Pure terminal-frame classifier. Wraps an upstream protocol-frame stream
 * and exposes a `finalMetadata` promise that resolves to the terminal-state
 * snapshot (`failed`, accumulated `usage`) once the stream drains.
 *
 * Owns bounded terminal observation. The optional failure callback cancels the
 * request-owned producer without reclassifying it as client cancellation.
 */
import { StreamTail, closeStream } from "./stream-tail"
import type { ProtocolFrame } from '@vibe-core/result'
import { isOpenAIUsageOnlyEventShape } from '@vibe-llm/protocols/common'

export interface UpstreamTelemetryCtx {
  readonly abortSignal?: AbortSignal
  readonly protocol: 'chat_completions' | 'messages' | 'responses'
  readonly expectedChoices?: number
  readonly onFailure?: () => void
}

export interface UpstreamTerminalState {
  readonly failed: boolean
  readonly cancelled: boolean
  readonly usage: unknown
  readonly firstByteLatencyMs: number | null
  readonly totalLatencyMs: number
}

export interface UpstreamTelemetryOutput<T> {
  readonly events: AsyncGenerator<ProtocolFrame<T>>
  readonly finalMetadata: Promise<UpstreamTerminalState>
}

const isTerminalFrame = <T>(
  frame: ProtocolFrame<T>,
  protocol: UpstreamTelemetryCtx['protocol'],
): { terminal: boolean; failed: boolean } => {
  if (frame.type === 'done') return { terminal: protocol === 'chat_completions', failed: false }
  const ev = frame.event as Record<string, unknown>
  if (ev.type === 'error' || (protocol === 'chat_completions' && ev.error != null)) return { terminal: true, failed: true }
  if (protocol === 'messages') {
    if (ev.type === 'message_stop') return { terminal: true, failed: false }
  }
  if (protocol === 'responses') {
    if (ev.type === 'response.completed' || ev.type === 'response.incomplete') return { terminal: true, failed: false }
    if (ev.type === 'response.failed') return { terminal: true, failed: true }
  }
  return { terminal: false, failed: false }
}

const extractUsage = <T>(frame: ProtocolFrame<T>): unknown => {
  if (frame.type !== 'event') return null
  const ev = frame.event as {
    type?: string
    usage?: unknown
    choices?: unknown[]
    response?: { usage?: unknown }
    message?: { usage?: unknown }
  }
  // chat_completions carries usage on a trailing content-free chunk. The
  // predicate accepts both the `choices: []` shape and the Zhipu/GLM vLLM
  // fork's `choices: [{ index: 0 }]` placeholder; the fork's shape used to
  // match no branch here at all, leaving `usage` empty for the whole stream.
  if (isOpenAIUsageOnlyEventShape(ev)) return ev.usage
  if (ev.response?.usage) return ev.response.usage
  if (ev.message?.usage) return ev.message.usage
  if (ev.usage && (ev.type === 'message_delta' || ev.type === 'message_start')) return ev.usage
  return null
}

export function withUpstreamTelemetry<T>(
  stream: AsyncIterable<ProtocolFrame<T>>,
  ctx: UpstreamTelemetryCtx,
): UpstreamTelemetryOutput<T> {
  let resolveMeta!: (s: UpstreamTerminalState) => void
  const finalMetadata = new Promise<UpstreamTerminalState>((res) => { resolveMeta = res })
  const startedAt = performance.now()
  let firstByteLatencyMs: number | null = null
  let accumulatedUsage: unknown = null
  let resolved = false
  const settle = (failed: boolean, cancelled = false): void => {
    if (resolved) return
    resolved = true
    ctx.abortSignal?.removeEventListener("abort", onAbort)
    resolveMeta({ failed, cancelled, usage: accumulatedUsage, firstByteLatencyMs, totalLatencyMs: performance.now() - startedAt })
  }
  const onAbort = (): void => settle(false, true)
  ctx.abortSignal?.addEventListener("abort", onAbort, { once: true })
  if (ctx.abortSignal?.aborted) onAbort()

  async function* run(): AsyncGenerator<ProtocolFrame<T>> {
    let successfulTerminal: ProtocolFrame<T> | undefined
    let failureEmitted = false
    const iterator = stream[Symbol.asyncIterator]()
    const tail = new StreamTail()
    const finishedChoices = new Set<number>()
    let chatFinished = false
    try {
      if (ctx.abortSignal?.aborted) return
      while (true) {
        const next = await tail.next(iterator, ctx.abortSignal)
        if (next.done) break
        const frame = next.value
        tail.observe(frame)
        if (ctx.abortSignal?.aborted) return
        if (firstByteLatencyMs === null) firstByteLatencyMs = performance.now() - startedAt
        const usage = extractUsage(frame)
        if (usage) accumulatedUsage = usage
        const { terminal, failed } = isTerminalFrame(frame, ctx.protocol)
        if (failed) {
          failureEmitted = true
          settle(true)
          yield frame
          return
        }
        // Delay success until the tail drains: a late error invalidates it.
        if (terminal) {
          successfulTerminal ??= frame
          tail.start()
        } else if (frame.type !== "done") {
          const isChatUsage = isOpenAIUsageOnlyEventShape(frame.event)
          if (!successfulTerminal && (!chatFinished || isChatUsage)) yield frame
          if (ctx.protocol === "chat_completions") {
            const choices = (frame.event as { choices?: Array<{ index?: number; finish_reason?: unknown }> }).choices
            for (const choice of choices ?? []) if (choice.finish_reason != null) finishedChoices.add(choice.index ?? 0)
            if (finishedChoices.size >= (ctx.expectedChoices ?? 1)) { chatFinished = true; tail.start() }
          }
        }
      }
      if (ctx.abortSignal?.aborted) return
      if (!successfulTerminal) throw new Error(`Upstream ${ctx.protocol} stream ended without a terminal event.`)
      settle(false)
      yield successfulTerminal
    } catch (err) {
      if (ctx.abortSignal?.aborted || failureEmitted) return
      settle(true)
      ctx.onFailure?.()
      throw err
    } finally {
      // Consumer return/break is cancellation even without an AbortSignal.
      settle(false, true)
      await closeStream(iterator)
    }
  }

  const events = run()
  const returnEvents = events.return.bind(events)
  events.return = async (value) => {
    settle(false, true)
    return returnEvents(value)
  }
  return { events, finalMetadata }
}
