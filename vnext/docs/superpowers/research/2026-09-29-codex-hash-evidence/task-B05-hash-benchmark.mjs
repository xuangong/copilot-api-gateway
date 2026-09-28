/* global Bun */
// Run one mode/size in a fresh Bun process under /usr/bin/time -l.
import { sha256Uuid, sha256UuidFromParts } from '../../../../packages/provider-codex/src/ids.ts'

const [mode, sizeText] = process.argv.slice(2)
const mib = Number(sizeText)
if (!['old', 'incremental'].includes(mode) || ![1, 10, 50].includes(mib)) {
  throw new Error('Usage: bun task-B05-hash-benchmark.mjs old|incremental 1|10|50')
}

if (typeof Bun.gc === 'function') Bun.gc(true)
const startup = process.memoryUsage()

async function measure() {
  const instructions = 'z'.repeat(mib * 1024 * 1024)
  const seed = [{ type: 'message', role: 'user', content: '\ud83d\ude00'.repeat(Math.ceil(mib * 1024 * 1024 / 4)) }]
  const before = process.memoryUsage()
  const timerStart = performance.now()
  let timerDelayMs = -1
  let lastTimerAt = timerStart
  let maxSchedulerGapMs = 0
  let timerCallbacksBeforeHashComplete = 0
  let hashComplete = false
  let firstTimerResolve
  const firstTimer = new Promise((resolve) => { firstTimerResolve = resolve })
  const tick = () => {
    const now = performance.now()
    maxSchedulerGapMs = Math.max(maxSchedulerGapMs, now - lastTimerAt)
    lastTimerAt = now
    if (timerDelayMs < 0) {
      timerDelayMs = now - timerStart
      firstTimerResolve()
    }
    if (!hashComplete) {
      timerCallbacksBeforeHashComplete++
      setTimeout(tick, 0)
    }
  }
  setTimeout(tick, 0)
  const hashStart = performance.now()
  const id = mode === 'old'
    ? await sha256Uuid(`${instructions}\u0001${JSON.stringify(seed)}`)
    : await sha256UuidFromParts([instructions, '\u0001', JSON.stringify(seed)])
  const hashDurationMs = performance.now() - hashStart
  hashComplete = true
  maxSchedulerGapMs = Math.max(maxSchedulerGapMs, performance.now() - lastTimerAt)
  await firstTimer
  return { id, before, hashDurationMs, timerDelayMs, maxSchedulerGapMs, timerCallbacksBeforeHashComplete }
}

const result = await measure()
if (typeof Bun.gc === 'function') Bun.gc(true)
const retained = process.memoryUsage()
console.log(JSON.stringify({ mode, mib, startup, ...result, retained }))
