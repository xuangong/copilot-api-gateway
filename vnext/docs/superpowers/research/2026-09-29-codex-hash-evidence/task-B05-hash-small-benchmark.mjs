import { sha256Uuid, sha256UuidFromParts } from '../../../../packages/provider-codex/src/ids.ts'

const [mode, sizeText] = process.argv.slice(2)
const kib = Number(sizeText)
if (!['old', 'incremental'].includes(mode) || ![1, 64, 256].includes(kib)) {
  throw new Error('Usage: bun task-B05-hash-small-benchmark.mjs old|incremental 1|64|256')
}
const instructions = 'z'.repeat(kib * 1024)
const seed = [{ type: 'message', role: 'user', content: '\ud83d\ude00'.repeat(Math.ceil(kib * 1024 / 4)) }]
const durations = []
let id = ''
for (let run = 0; run < 11; run++) {
  const started = performance.now()
  id = mode === 'old'
    ? await sha256Uuid(`${instructions}\u0001${JSON.stringify(seed)}`)
    : await sha256UuidFromParts([instructions, '\u0001', JSON.stringify(seed)])
  durations.push(performance.now() - started)
}
console.log(JSON.stringify({ mode, kib, coldMs: durations[0], warmMs: durations.slice(1), id }))
