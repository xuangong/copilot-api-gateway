import type { ProtocolFrame } from '@vnext/protocols/common'

export interface UpstreamTelemetryRecorder {
  recordFirstByteLatency: (ms: number) => void
  recordSuccess: (usage: unknown) => void
  recordFailure: (reason: string) => void
}

export interface UpstreamTelemetryStreamCtx {
  readonly abortSignal?: AbortSignal
}

export interface UpstreamTelemetryClassifierCtx {
  readonly protocol: 'chat_completions' | 'messages' | 'responses'
}

const isTerminalFrame = <T>(
  frame: ProtocolFrame<T>,
  protocol: UpstreamTelemetryClassifierCtx['protocol'],
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
  const ev = frame.event as { usage?: unknown; choices?: unknown[] }
  if (Array.isArray(ev.choices) && ev.choices.length === 0 && ev.usage) return ev.usage
  return null
}

export const withUpstreamTelemetry = async function* <T>(
  stream: AsyncIterable<ProtocolFrame<T>>,
  streamCtx: UpstreamTelemetryStreamCtx,
  recorder: UpstreamTelemetryRecorder,
  classifierCtx: UpstreamTelemetryClassifierCtx,
): AsyncGenerator<ProtocolFrame<T>> {
  const startedAt = performance.now()
  let firstByteRecorded = false
  let recorded = false
  let accumulatedUsage: unknown = null

  try {
    for await (const frame of stream) {
      if (!firstByteRecorded) {
        recorder.recordFirstByteLatency(performance.now() - startedAt)
        firstByteRecorded = true
      }
      const usage = extractUsage(frame)
      if (usage) accumulatedUsage = usage
      const { terminal, failed } = isTerminalFrame(frame, classifierCtx.protocol)
      yield frame
      if (terminal) {
        if (!recorded) {
          recorded = true
          if (failed) recorder.recordFailure('terminal-failure-frame')
          else recorder.recordSuccess(accumulatedUsage)
        }
        return
      }
    }
    if (!recorded) {
      recorded = true
      if (streamCtx.abortSignal?.aborted) recorder.recordFailure('client-aborted')
      else recorder.recordFailure('eof-without-terminal')
    }
  } catch (err) {
    if (!recorded) {
      recorded = true
      recorder.recordFailure(err instanceof Error ? err.message : String(err))
    }
    throw err
  }
}
