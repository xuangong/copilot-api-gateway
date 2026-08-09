import { describe, expect, test } from 'bun:test'
import { COMMENT_KEEPALIVE_FRAME, startSseKeepalive } from './sse-keepalive.ts'

const DEC = new TextDecoder()

function collector() {
  const chunks: string[] = []
  return {
    chunks,
    controller: {
      enqueue(bytes: Uint8Array) {
        chunks.push(DEC.decode(bytes))
      },
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('startSseKeepalive', () => {
  test('emits keepalive frames while the stream is idle', async () => {
    const { chunks, controller } = collector()
    const keepalive = startSseKeepalive(controller, COMMENT_KEEPALIVE_FRAME, 20)
    await sleep(110)
    keepalive.stop()
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks.every((c) => c === COMMENT_KEEPALIVE_FRAME)).toBe(true)
  })

  test('touch() suppresses keepalives on an active stream', async () => {
    const { chunks, controller } = collector()
    const keepalive = startSseKeepalive(controller, COMMENT_KEEPALIVE_FRAME, 50)
    for (let i = 0; i < 10; i++) {
      await sleep(10)
      keepalive.touch()
    }
    keepalive.stop()
    expect(chunks).toEqual([])
  })

  test('stop() prevents any further enqueue', async () => {
    const { chunks, controller } = collector()
    const keepalive = startSseKeepalive(controller, COMMENT_KEEPALIVE_FRAME, 20)
    keepalive.stop()
    await sleep(80)
    expect(chunks).toEqual([])
  })

  test('a throwing controller (closed stream) stops the timer instead of looping', async () => {
    let calls = 0
    const controller = {
      enqueue() {
        calls++
        throw new Error('stream closed')
      },
    }
    const keepalive = startSseKeepalive(controller, COMMENT_KEEPALIVE_FRAME, 20)
    await sleep(100)
    keepalive.stop()
    expect(calls).toBe(1)
  })
})
