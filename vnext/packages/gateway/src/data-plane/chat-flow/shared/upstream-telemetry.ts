/**
 * Pure terminal-frame classifier. Wraps an upstream protocol-frame stream
 * and exposes a `finalMetadata` promise that resolves to the terminal-state
 * snapshot (`failed`, accumulated `usage`) once the stream drains.
 *
 * No callbacks, no I/O. Replaces the Spec-2 recorder interface.
 */
import type { ProtocolFrame } from '@vnext/protocols/common'

export interface UpstreamTelemetryCtx {
  readonly abortSignal?: AbortSignal
  readonly protocol: 'chat_completions' | 'messages' | 'responses'
}

export interface UpstreamTerminalState {
  readonly failed: boolean
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
  if (protocol === 'messages') {
    if (ev.type === 'message_stop') return { terminal: true, failed: false }
    if (ev.type === 'error') return { terminal: true, failed: true }
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
  if (Array.isArray(ev.choices) && ev.choices.length === 0 && ev.usage) return ev.usage
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

  async function* run(): AsyncGenerator<ProtocolFrame<T>> {
    let firstByteLatencyMs: number | null = null
    let accumulatedUsage: unknown = null
    let resolved = false
    const settle = (failed: boolean): void => {
      if (resolved) return
      resolved = true
      resolveMeta({
        failed,
        usage: accumulatedUsage,
        firstByteLatencyMs,
        totalLatencyMs: performance.now() - startedAt,
      })
    }
    try {
      for await (const frame of stream) {
        if (firstByteLatencyMs === null) firstByteLatencyMs = performance.now() - startedAt
        const usage = extractUsage(frame)
        if (usage) accumulatedUsage = usage
        const { terminal, failed } = isTerminalFrame(frame, ctx.protocol)
        yield frame
        if (terminal) { settle(failed); return }
      }
      settle(true) // eof without terminal = failed
    } catch (err) {
      settle(true)
      throw err
    }
  }

  return { events: run(), finalMetadata }
}
